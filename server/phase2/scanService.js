/**
 * phase2/scanService.js
 *
 * Standalone auto-scanner for the Phase-2 app.
 *
 * Scans the index-option strike universe (NIFTY / BANKNIFTY / SENSEX,
 * ATM ±5 ITM / 2 OTM, current + next-week + monthly expiries) for:
 *   • Kumo Breakout   (phase2/ichimokuCore.detectKumoBreakout)
 *   • TK Reversion    (phase2/ichimokuCore.detectTKReversion)
 *
 * Schedule:
 *   • every 15 minutes — 15minute candles
 *   • every 1 hour     — 60minute candles
 *
 * Candles come from historicalCache.fetchLastNCandles (read-only, rate-
 * limited Kite fetcher) — no shared candleStore state is touched.
 *
 * Results are kept in memory per (interval), broadcast over SSE as
 * 'phase2_scan_complete', and bullish matches with R:R ≥ 2 are sent to
 * Telegram (deduped per token+pattern+interval per IST day).
 */

const { fetchLastNCandles } = require('../services/historicalCache');
const telegramNotifier = require('../services/telegramNotifier');
const mainStore = require('../store');
const { broadcast } = require('../sseHub');
const { isNseOpen } = require('../utils/marketHours');
const strikeUniverse = require('./strikeUniverse');
const candleCacheRepo = require('./candleCacheRepo');
const { detectKumoBreakout, detectTKReversion, MIN_BARS } = require('./ichimokuCore');

// ── Config ───────────────────────────────────────────────────────────────────

const INTERVALS = ['5minute', '15minute', '60minute'];
const TF_LABEL = { '5minute': '5m', '15minute': '15m', '60minute': '1h' };
const SCAN_BARS = { '5minute': 120, '15minute': 120, '60minute': 120 };

// Incremental fetch: once the DB FIFO cache holds a full history that was
// updated TODAY, each scan only pulls the last few bars and merges — instead
// of re-downloading the whole 120-bar window every cycle.
const INCREMENTAL_BARS = 10;

const SCHEDULE_MS = {
  '5minute': 5 * 60 * 1000,
  '15minute': 15 * 60 * 1000,
  '60minute': 60 * 60 * 1000,
};

const BATCH_SIZE = 10;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MIN_TELEGRAM_RR = 2; // 1:2 minimum reward:risk for alerts

// ── State ────────────────────────────────────────────────────────────────────

let _running = false;
const _timers = new Map();
const _lastScanAt = new Map();  // interval → ts
const _nextScanAt = new Map();  // interval → ts
const _scanInProgress = new Map();
const _results = new Map();     // interval → { matches, scannedCount, totalInstruments, ts }
const _telegramDedup = new Map(); // "token:pattern:interval" → IST date
const _lastError = new Map();   // interval → last scan error message

function _istDate() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Telegram ─────────────────────────────────────────────────────────────────
//
// Adjacent strikes of the same index/option-type fire together (they track
// the same underlying move), so alerts are CONSOLIDATED: one message per
// (index + optionType + pattern + interval) per day, showing the best strike
// in full plus a compact list of the other qualifying strikes.

async function _notifyTelegramGrouped(matches) {
  const chatId = mainStore.getTelegramChatId();
  if (!chatId) return;

  // Option-buyer rule: bullish premium setups with R:R ≥ 1:2 only
  const qualifying = (matches || []).filter(
    (m) => m.signal === 'bullish' && m.rr != null && m.rr >= MIN_TELEGRAM_RR,
  );
  if (!qualifying.length) return;

  // Group by index + optionType + pattern (interval is constant per scan)
  const groups = new Map();
  for (const m of qualifying) {
    const gkey = `${m.index}:${m.optionType}:${m.pattern}:${m.interval}`;
    const list = groups.get(gkey) ?? [];
    list.push(m);
    groups.set(gkey, list);
  }

  for (const [gkey, list] of groups) {
    if (_telegramDedup.get(gkey) === _istDate()) continue;
    _telegramDedup.set(gkey, _istDate());

    // Best strike first: highest score, then highest R:R
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.rr ?? 0) - (a.rr ?? 0));
    const best = list[0];
    const others = list.slice(1);

    const patternName = best.pattern === 'kumo-breakout' ? 'Kumo Breakout' : 'TK Reversion';

    const lines = [
      `🟢 <b>${patternName}</b> — ${best.index} ${best.optionType} BULLISH (Phase-2)`,
      ``,
      `⭐ <b>${best.tradingsymbol}</b> · ${best.expiryBucket}`,
      `Entry: ₹${best.entry?.toFixed(2)} · SL: ₹${best.sl?.toFixed(2)} · Target: ₹${best.target?.toFixed(2)}`,
      `R:R: 1:${best.rr?.toFixed(1)} · Score: ${best.score ?? '—'}/5 · TF: ${best.tfLabel}`,
    ];

    if (others.length) {
      lines.push(``, `Also matched (${others.length}):`);
      for (const o of others.slice(0, 6)) {
        lines.push(`· ${o.strike} ${o.optionType} ${o.expiryBucket} — R:R 1:${o.rr?.toFixed(1)}, score ${o.score ?? '—'}`);
      }
      if (others.length > 6) lines.push(`· …and ${others.length - 6} more`);
    }

    try {
      await telegramNotifier.sendMessage(chatId, lines.join('\n'));
      console.log(`[Phase2Scan] 📱 Grouped alert sent: ${gkey} (${list.length} strikes)`);
    } catch (err) {
      console.warn('[Phase2Scan] Telegram failed:', err.message);
    }
  }
}

// ── Scan one interval ────────────────────────────────────────────────────────

async function scanInterval(interval) {
  if (_scanInProgress.get(interval)) {
    console.log(`[Phase2Scan] ${TF_LABEL[interval]} scan already running — skipped`);
    return _results.get(interval) ?? null;
  }
  _scanInProgress.set(interval, true);

  const tfLabel = TF_LABEL[interval];

  try {
    const { instruments } = await strikeUniverse.getUniverse();
    if (!instruments.length) {
      console.warn('[Phase2Scan] Empty strike universe — is Kite authenticated?');
      _lastError.set(interval, 'Strike universe empty — Kite not authenticated or instrument cache not loaded');
      return null;
    }

    console.log(`[Phase2Scan] Scanning ${tfLabel} — ${instruments.length} option instruments`);

    // DB FIFO cache — fallback source when the Kite fetch fails (rate limit,
    // outage), and durable store for everything we do fetch.
    const dbCache = await candleCacheRepo.loadCandles(interval);
    const candlesToPersist = [];

    const matches = [];
    let scannedCount = 0;
    let fetchFailCount = 0;
    let shortHistoryCount = 0;

    const todayIst = _istDate();

    for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
      const batch = instruments.slice(i, i + BATCH_SIZE);
      const settled = await Promise.all(batch.map(async (inst) => {
        const cached = dbCache.get(inst.token);

        // Incremental mode: cache already holds full history AND its last
        // candle is from today — only the newest bars are missing.
        const lastCachedDate = cached?.length
          ? String(cached[cached.length - 1].date).slice(0, 10)
          : null;
        const canIncrement = cached && cached.length >= MIN_BARS && lastCachedDate === todayIst;

        let candles = null;
        let fetchFailed = false;
        try {
          const fetchCount = canIncrement ? INCREMENTAL_BARS : SCAN_BARS[interval];
          const fresh = await fetchLastNCandles(inst.token, interval, fetchCount, false);
          if (fresh?.length) {
            candles = canIncrement
              ? candleCacheRepo.mergeFifo(cached, fresh, interval)
              : fresh;
            candlesToPersist.push({ token: inst.token, interval, candles: fresh });
          }
        } catch {
          fetchFailed = true;
        }

        // Kite failed — use the FIFO-cached history as-is if sufficient
        if ((!candles || candles.length < MIN_BARS) && cached && cached.length >= MIN_BARS) {
          candles = cached;
        }

        if (!candles || candles.length < MIN_BARS) {
          if (fetchFailed) fetchFailCount++;
          else shortHistoryCount++; // contract too new — not enough bars for Ichimoku
          return null;
        }
        scannedCount++;

        const found = [];
        for (const detect of [detectKumoBreakout, detectTKReversion]) {
          let result;
          try {
            result = detect(candles);
          } catch {
            continue;
          }
          if (!result) continue;
          // Option-buyer rule: only BULLISH premium setups (CE or PE premium rising)
          if (result.signal !== 'bullish') continue;

          found.push({
            ...result,
            token: inst.token,
            tradingsymbol: inst.tradingsymbol,
            index: inst.index,
            strike: inst.strike,
            optionType: inst.optionType,
            expiry: inst.expiry,
            expiryBucket: inst.expiryBucket,
            exchange: inst.exchange,
            lotSize: inst.lotSize,
            interval,
            tfLabel,
            ts: Date.now(),
          });
        }
        return found.length ? found : null;
      }));

      for (const r of settled) if (r) matches.push(...r);
    }

    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Persist fetched candles to the FIFO DB cache (fire-and-forget)
    if (candlesToPersist.length) {
      candleCacheRepo.upsertCandles(candlesToPersist).catch(() => {});
    }

    const summary = {
      interval,
      tfLabel,
      matches,
      scannedCount,
      fetchFailCount,
      shortHistoryCount,
      totalInstruments: instruments.length,
      ts: Date.now(),
    };
    _results.set(interval, summary);
    _lastScanAt.set(interval, Date.now());
    _lastError.delete(interval);

    console.log(
      `[Phase2Scan] ${tfLabel} complete — ${matches.length} matches ` +
      `(${scannedCount} scanned, ${fetchFailCount} fetch-failed, ${shortHistoryCount} short-history)`,
    );

    broadcast('phase2_scan_complete', {
      interval,
      tfLabel,
      matchCount: matches.length,
      scannedCount,
      ts: Date.now(),
    });

    // Hand levels to the live tick watcher so entry/SL/target hits alert
    // instantly instead of waiting for the next scheduled scan.
    // Lazy require avoids a circular dependency at module load.
    try {
      require('./tickWatcher').updateLevels(interval, matches);
    } catch { /* watcher not started */ }

    // Telegram — grouped per index+optionType+pattern (fire-and-forget)
    _notifyTelegramGrouped(matches).catch(() => {});

    return summary;
  } catch (err) {
    console.error(`[Phase2Scan] ${tfLabel} scan error:`, err.message);
    _lastError.set(interval, err.message);
    return null;
  } finally {
    _scanInProgress.set(interval, false);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function _schedule(interval) {
  const ms = SCHEDULE_MS[interval];
  const timer = setInterval(() => {
    _nextScanAt.set(interval, Date.now() + ms);
    if (!isNseOpen()) return;
    scanInterval(interval).catch(() => {});
  }, ms);
  _timers.set(interval, timer);
  _nextScanAt.set(interval, Date.now() + ms);
}

function start() {
  if (_running) return;
  _running = true;
  for (const interval of INTERVALS) _schedule(interval);
  console.log('[Phase2Scan] Scheduler started — 15m + 1h index-option strike scans');

  if (isNseOpen()) {
    runAll().catch(() => {});
  }
}

function stop() {
  _running = false;
  for (const t of _timers.values()) clearInterval(t);
  _timers.clear();
  _nextScanAt.clear();
  console.log('[Phase2Scan] Scheduler stopped');
}

async function runAll() {
  const results = await Promise.all(INTERVALS.map((iv) => scanInterval(iv)));
  return results.filter(Boolean);
}

function getStatus() {
  const intervals = {};
  for (const iv of INTERVALS) {
    intervals[iv] = {
      tfLabel: TF_LABEL[iv],
      lastScanAt: _lastScanAt.get(iv) ?? null,
      nextScanAt: _nextScanAt.get(iv) ?? null,
      scanning: _scanInProgress.get(iv) ?? false,
      lastError: _lastError.get(iv) ?? null,
    };
  }
  return { running: _running, intervals };
}

function getResults() {
  const out = {};
  for (const iv of INTERVALS) out[iv] = _results.get(iv) ?? null;
  return out;
}

module.exports = { start, stop, runAll, scanInterval, getStatus, getResults, INTERVALS, TF_LABEL };
