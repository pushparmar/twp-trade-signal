/**
 * Background Scanner
 *
 * Automatically runs all registered Ichimoku patterns against every NFO
 * front-month future at each candle close boundary — no manual button click
 * required.  Sends Telegram alerts + SSE events for every new match.
 *
 * Why this exists:
 *   • patternAlertWatcher covers 7 hardcoded macro/index instruments via
 *     KiteTicker candle-close events.
 *   • liveScanner covers only the user's market-watch list (~3 indices).
 *   • The ~200 NFO futures that appear in the manual screener tab have no
 *     background watcher — this service fills that gap.
 *
 * How it works:
 *   At startup, a timer is set for the next candle-close boundary on each
 *   interval (15m / 1h / 4h / 1d).  When the timer fires:
 *     1. Fetch candle data for every NFO future via historicalCache
 *        (rate-limited; same as the manual /api/scan endpoint).
 *     2. Run every registered pattern on that candle data.
 *     3. For each new (first-of-day) match:
 *        a. Broadcast a `scan_alert` SSE → Scanner UI tab updates instantly.
 *        b. Send a Telegram message (if chatId is configured).
 *     4. Reschedule for the NEXT boundary.
 *
 * Dedup:
 *   Each (token, interval, patternId, signal) fires at most once per IST
 *   trading day.  Keyed with a "bg:" namespace so it stays isolated from the
 *   liveScanner/patternAlertWatcher dedup maps.  Resets automatically the
 *   next day.
 *
 * Skips:
 *   • Macro/index instruments — already covered by patternAlertWatcher.
 *   • Off-market hours — no point scanning when candle data is frozen.
 *   • Scans that take longer than the interval (degenerate case — logged).
 */

const candleStore         = require('./candleStore');
const patternRegistry     = require('./patternRegistry');
const telegramNotifier    = require('./telegramNotifier');
const { broadcast }       = require('../sseHub');
const store               = require('../store');
const { to4H }            = require('./ichimoku');
const patternAlertMessage = require('./patternAlertMessage');
const instrumentCache     = require('./instrumentCache');
const { VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');

// ── Constants ────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Intervals driven by this scanner; 4h is synthesised from 60minute.
const INTERVALS = ['15minute', '60minute', '4h', 'day'];

// Delay after the candle boundary — lets Kite finish writing the final tick.
const CLOSE_DELAY_MS = 45 * 1000;  // 45 seconds

// Minimum candle count needed for reliable Ichimoku calculation.
const MIN_BARS = 52;

// Bar counts to request per interval (matches the /api/scan endpoint).
const SCAN_BARS = {
  '15minute': 100,
  '60minute': 208,  // 4h synthesis needs 52×4 = 208 1h bars minimum
  'day':      100,
};

const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// ── Dedup ────────────────────────────────────────────────────────────────────

const _dedup = new Map();

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Mark a (token, interval, patternId, signal) combo as fired for today.
 * Returns true on the first claim; false if it already fired today (suppress).
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

// ── Market-hours guard ───────────────────────────────────────────────────────

function _isMarketHours(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // NSE 9:15–15:30 | MCX 9:00–23:30  →  combined window 9:00–23:30
  return mins >= 540 && mins <= 1410;
}

// ── Next-candle-close calculator ──────────────────────────────────────────────

/**
 * Returns the UTC-ms timestamp of the next candle-close boundary for the
 * given interval, plus CLOSE_DELAY_MS so Kite has time to finalise.
 *
 * '15minute' → next :00/:15/:30/:45 minute mark
 * '60minute' → next :15 past the hour (NSE sessions start at 9:15)
 * '4h'       → synthesised from 60minute — fires on the same 1h boundary
 * 'day'      → 15:30 IST (NSE EOD); wraps to the next trading day
 */
function _nextCloseMs(interval, now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const totalMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const totalSec = totalMin * 60 + ist.getUTCSeconds();

  let targetMs;

  if (interval === 'day') {
    // Daily close = 15:30 IST = minute 930
    const EOD_MIN = 930;
    const todayEod = new Date(ist);
    todayEod.setUTCHours(15, 30, 0, 0);

    if (totalMin < EOD_MIN) {
      targetMs = todayEod.getTime();
    } else {
      // Already past today's close — schedule for tomorrow (skip weekend)
      const next = new Date(todayEod);
      do {
        next.setUTCDate(next.getUTCDate() + 1);
      } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
      targetMs = next.getTime();
    }
  } else {
    // Periodic intervals: align to next multiple of `periodMin`
    // 4h is driven by 60minute (synthesised), so uses the same 1h boundary.
    const periodMin = interval === '15minute' ? 15
                    : /* 60minute | 4h */       60;

    const nextPeriodMin = (Math.floor(totalMin / periodMin) + 1) * periodMin;

    const target = new Date(ist);
    if (nextPeriodMin >= 24 * 60) {
      // Roll into the next calendar day
      const overflow = nextPeriodMin - 24 * 60;
      target.setUTCDate(target.getUTCDate() + 1);
      target.setUTCHours(Math.floor(overflow / 60), overflow % 60, 0, 0);
    } else {
      target.setUTCHours(Math.floor(nextPeriodMin / 60), nextPeriodMin % 60, 0, 0);
    }
    targetMs = target.getTime();
  }

  // Convert IST target → UTC, then add the post-close delay
  return (targetMs - IST_OFFSET_MS) + CLOSE_DELAY_MS;
}

// ── Universe builder ──────────────────────────────────────────────────────────

// Tokens managed by patternAlertWatcher — skip them here to avoid duplicate alerts.
const MACRO_TOKENS = new Set();

function _buildUniverse() {
  // Populate the macro-token exclusion set on first call once instrumentCache is ready
  if (MACRO_TOKENS.size === 0 && instrumentCache.isLoaded()) {
    MACRO_TOKENS.add(Number(VIX_TOKEN));
    MACRO_TOKENS.add(256265); // NIFTY 50
    MACRO_TOKENS.add(260105); // NIFTY BANK
    for (const [sym, exch] of [
      ['CRUDEOIL', 'MCX'], ['GOLD', 'MCX'], ['SILVER', 'MCX'], ['USDINR', 'CDS'],
    ]) {
      try {
        const inst = getFrontMonthFutures(sym, exch);
        if (inst) MACRO_TOKENS.add(Number(inst.instrumentToken));
      } catch { /* not yet loaded — will be populated on next scan */ }
    }
  }

  if (!instrumentCache.isLoaded()) return [];

  const universe = [];
  for (const name of instrumentCache.getFutureNames()) {
    const inst = instrumentCache.getFrontMonthFuture(name, 'NFO');
    if (!inst) continue;
    if (MACRO_TOKENS.has(Number(inst.instrumentToken))) continue; // handled by patternAlertWatcher
    universe.push({
      instrumentToken: inst.instrumentToken,
      tradingsymbol:   inst.tradingsymbol,
      exchange:        inst.exchange,
      name:            inst.name || inst.tradingsymbol,
    });
  }
  return universe;
}

// ── Core scan ────────────────────────────────────────────────────────────────

/**
 * Run all patterns against all NFO futures for the given interval.
 * Sends Telegram + SSE for every new match.
 */
async function _runScanForInterval(interval) {
  if (!_isMarketHours()) {
    console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — skipped (market closed)`);
    return;
  }

  const instruments = _buildUniverse();
  if (!instruments.length) {
    console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — skipped (instrument cache not ready)`);
    return;
  }

  const patterns = patternRegistry.list();
  const chatId   = store.getTelegramChatId();
  const tfLabel  = TF_LABEL[interval] || interval;

  const t0 = Date.now();
  console.log(`[BgScanner] ${tfLabel} candle close — scanning ${instruments.length} stocks × ${patterns.length} patterns`);

  // Notify that the scan has started
  if (chatId) {
    const now = new Date(Date.now() + IST_OFFSET_MS);
    const timeStr = now.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
    try {
      await telegramNotifier.sendMessage(
        chatId,
        `🔍 <b>Auto-scan started</b> — ${tfLabel} candle close\n` +
        `📊 Scanning ${instruments.length} F&O stocks × ${patterns.length} patterns\n` +
        `🕐 ${timeStr}`,
      );
    } catch (err) {
      console.warn('[BgScanner] Start notification failed:', err.message);
    }
  }

  let scannedCount = 0;
  let matchCount   = 0;

  for (const inst of instruments) {
    // Fetch candles; 4h synthesised from 1h buffer
    let candles;
    try {
      if (interval === '4h') {
        const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute', SCAN_BARS['60minute']);
        candles   = (c1h && c1h.length >= 8) ? to4H(c1h) : null;
      } else {
        candles = await candleStore.getCandles(inst.instrumentToken, interval, SCAN_BARS[interval] ?? 100);
      }
    } catch (err) {
      console.warn(`[BgScanner] Candle fetch failed ${inst.tradingsymbol}:${interval} —`, err.message);
      continue;
    }

    if (!candles || candles.length < MIN_BARS) continue;
    scannedCount++;

    const label = inst.name || inst.tradingsymbol;

    for (const { id: patternId, label: patternLabel } of patterns) {
      const patternDef = patternRegistry.get(patternId);

      let result;
      try {
        result = patternDef.run(candles, patternDef.defaultOpts);
      } catch {
        continue; // bad candle data — skip silently
      }

      if (!result?.matched || !result.signal) continue;

      // Dedup: at most one alert per (stock, interval, pattern, direction) per IST day
      const dedupKey = `bg:${inst.instrumentToken}:${interval}:${patternId}:${result.signal}`;
      if (!_claimFire(dedupKey)) continue;

      matchCount++;

      // ── SSE → Scanner UI tab ──────────────────────────────────────────────
      broadcast('scan_alert', {
        token:            Number(inst.instrumentToken),
        label,
        interval,
        tfLabel,
        patternId,
        patternLabel,
        signal:           result.signal,
        score:            result.score            ?? null,
        close:            result.close            ?? null,
        strength:         result.strength         ?? null,
        cloudPosition:    result.cloudPosition    ?? null,
        barsAgo:          result.barsAgo          ?? null,
        consecutiveBars:  result.consecutiveBars  ?? null,
        cloudThickness:   result.cloudThickness   ?? null,
        ts:               Date.now(),
      });

      console.log(`[BgScanner] ${result.signal === 'bullish' ? '🟢' : '🔴'} ${patternId} — ${label} (${tfLabel})`);

      // ── Telegram ──────────────────────────────────────────────────────────
      if (chatId) {
        const text = patternAlertMessage.build({
          label, tfLabel, patternLabel, result, kind: 'stock',
        });
        try {
          await telegramNotifier.sendMessage(chatId, text);
        } catch (err) {
          console.warn(`[BgScanner] Telegram failed for ${label}:`, err.message);
        }
      }
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[BgScanner] ${tfLabel} done — ${scannedCount}/${instruments.length} scanned, ` +
    `${matchCount} alert${matchCount !== 1 ? 's' : ''} sent (${elapsed}s)`,
  );

  // Send completion summary
  if (chatId) {
    const summary = matchCount > 0
      ? `✅ <b>Scan done</b> — ${tfLabel} · ${matchCount} match${matchCount !== 1 ? 'es' : ''} found\n` +
        `📊 ${scannedCount} stocks scanned in ${elapsed}s`
      : `✅ <b>Scan done</b> — ${tfLabel} · no new matches\n` +
        `📊 ${scannedCount} stocks scanned in ${elapsed}s`;
    try {
      await telegramNotifier.sendMessage(chatId, summary);
    } catch (err) {
      console.warn('[BgScanner] Done notification failed:', err.message);
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timers  = {};
let _running = false;

function _scheduleNext(interval) {
  if (!_running) return;

  const now    = Date.now();
  const fireAt = _nextCloseMs(interval, now);
  const delay  = fireAt - now;

  const fireIST = new Date(fireAt + IST_OFFSET_MS)
    .toISOString().replace('T', ' ').slice(0, 16);

  console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — next scan at ${fireIST} IST (in ${Math.round(delay / 60000)} min)`);

  _timers[interval] = setTimeout(async () => {
    if (!_running) return;
    try {
      await _runScanForInterval(interval);
    } catch (err) {
      console.error(`[BgScanner] Unhandled error on ${interval}:`, err.message);
    }
    // Always reschedule — even if the scan failed or market was closed
    _scheduleNext(interval);
  }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the background scanner.
 * Schedules a timer for each candle interval that fires at the next close
 * boundary and then re-schedules itself indefinitely.
 *
 * Should be called once after instrumentCache.load() succeeds.
 */
function start() {
  if (_running) {
    console.log('[BgScanner] Already running — ignoring duplicate start()');
    return;
  }
  _running = true;

  // Schedule all four intervals independently so they fire at their own boundaries.
  // '4h' shares the 60minute timer logic but runs its own synthesis + dedup.
  for (const interval of INTERVALS) {
    _scheduleNext(interval);
  }

  console.log('[BgScanner] Started — auto-scanning all NFO futures at each candle close');
}

/**
 * Stop the background scanner and cancel all pending timers.
 */
function stop() {
  _running = false;
  for (const t of Object.values(_timers)) clearTimeout(t);
  _timers = {};
  console.log('[BgScanner] Stopped');
}

/**
 * Diagnostic: returns the next fire time for each interval (UTC ms).
 */
function getSchedule() {
  const now = Date.now();
  return Object.fromEntries(
    INTERVALS.map((iv) => {
      const fireAt  = _nextCloseMs(iv, now);
      const fireIST = new Date(fireAt + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
      return [iv, { fireAt, fireIST, inMin: Math.round((fireAt - now) / 60000) }];
    }),
  );
}

module.exports = { start, stop, getSchedule };
