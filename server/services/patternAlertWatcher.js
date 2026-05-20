/**
 * Pattern Alert Watcher
 *
 * Runs every registered pattern on each 15m / 1h / 4h / 1d candle close
 * for index and macro instruments. Fires a Telegram message on first match.
 *
 * Note: liveScanner.js does the same for user watchlist stocks — both watchers
 * now share patternAlertMessage.build() so the Telegram wording stays in sync.
 *
 * Deduplication:
 *   Each (token, interval, patternId, signal) is allowed to fire at most ONCE
 *   per trading day. It resets at midnight IST, so the same setup can alert
 *   again on the next session.
 *
 * 4h handling:
 *   Kite has no native 4h interval. When a '60minute' candle closes we
 *   synthesise 4h candles from the 1h buffer and run patterns on those too.
 */

const candleStore      = require('./candleStore');
const patternRegistry  = require('./patternRegistry');
const telegramNotifier = require('./telegramNotifier');
const store            = require('../store');
const { broadcast }    = require('../sseHub');
const { to4H }         = require('./ichimoku');
const patternAlertMessage = require('./patternAlertMessage');
const { isNseOpen, isMcxOpen, IST_OFFSET_MS } = require('../utils/marketHours');

// Lazy-required to keep the same circular-dep pattern used in macroWatcher.
const { VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');

// ── Constants ────────────────────────────────────────────────────────────────

// Native intervals we care about — '60minute' also triggers the synthetic 4h check.
const WATCHED_INTERVALS = new Set(['15minute', '60minute', 'day']);

// Human-readable TF labels for Telegram messages
const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// ── State ────────────────────────────────────────────────────────────────────

// token (number) → display label, e.g. 256265 → 'NIFTY 50'
const _tokenLabel = new Map();

// token (number) → actual tradingsymbol, e.g. 12345 → 'CRUDEOIL25MAYFUT'
const _tokenTradingsymbol = new Map();

// token (number) → exchange string — used to pick the right market-hours gate
// 'NSE' / 'BSE' → isNseOpen()   |   'MCX' → isMcxOpen()
const _exchangeMap = new Map();

// Dedup: "token:interval:patternId:signal" → { fired: bool, date: string (IST) }
const _dedup = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Returns true if this combination has NOT yet fired today and marks it as fired.
 * Returns false if it already fired today (suppress duplicate alert).
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

// Session-aware 4h synthesis — imported from ichimoku.js.
const _to4H = to4H;

// ── Alert builder ────────────────────────────────────────────────────────────

async function _runAndAlert(token, interval, candles) {
  const chatId = store.getTelegramChatId();
  if (!chatId) return; // Telegram not configured — nothing to do

  const label   = _tokenLabel.get(Number(token)) || `Token ${token}`;
  const tfLabel = TF_LABEL[interval] || interval;

  for (const { id: patternId, label: patternLabel } of patternRegistry.list()) {
    const pattern = patternRegistry.get(patternId);

    let result;
    try {
      result = pattern.run(candles, pattern.defaultOpts);
    } catch {
      continue; // bad candle data — skip silently
    }

    if (!result?.matched || !result.signal) {
      // Pattern not active — skip silently.
      // Do NOT call _resetFire here: resetting when the pattern briefly
      // goes false (e.g. price dips inside the cloud for one bar) causes
      // the alert to re-fire on the next candle, producing a Telegram
      // message every 15 min. The dedup resets at midnight IST so a
      // genuine new setup on the next trading day always fires correctly.
      continue;
    }

    const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
    if (!_claimFire(dedupKey)) continue; // already sent today

    // Use the shared message builder so the wording stays in sync with liveScanner.
    // 'index' for NIFTY/BANKNIFTY, 'macro' for VIX/Crude/Gold/Silver/USDINR.
    const kind = (Number(token) === 256265 || Number(token) === 260105) ? 'index' : 'macro';
    const text = patternAlertMessage.build({ label, tfLabel, patternLabel, result, kind });

    // Gate Telegram on the instrument's own exchange hours:
    //   MCX (Crude/Gold/Silver) → isMcxOpen()  [09:00–23:30 IST]
    //   NSE / VIX / CDS         → isNseOpen()  [09:00–15:30 IST]
    // SSE broadcast below always fires so the Scanner UI stays live.
    const exchange  = _exchangeMap.get(Number(token)) ?? 'NSE';
    const mktOpen   = exchange === 'MCX' ? isMcxOpen() : isNseOpen();
    if (mktOpen) {
      try {
        await telegramNotifier.sendMessage(chatId, text);
        console.log(`[PatternAlert] ✅ ${patternId} ${result.signal} — ${label} (${tfLabel})`);
      } catch (err) {
        console.warn(`[PatternAlert] Telegram send failed for ${label}:`, err.message);
      }
    } else {
      console.log(`[PatternAlert] ⏸ ${patternId} ${result.signal} — ${label} (${tfLabel}) — Telegram skipped (${exchange} closed)`);
    }

    // Broadcast to SSE clients so the Scanner tab updates in real time,
    // regardless of whether Telegram succeeded.
    broadcast('scan_alert', {
      token:         Number(token),
      label,
      tradingsymbol: _tokenTradingsymbol.get(Number(token)) ?? null,
      interval,
      tfLabel,
      patternId,
      patternLabel,
      signal:        result.signal,
      score:         result.score         ?? null,
      close:         result.close         ?? null,
      strength:         result.strength         ?? null,
      cloudPosition:    result.cloudPosition    ?? null,
      barsAgo:          result.barsAgo          ?? null,
      consecutiveBars:  result.consecutiveBars  ?? null,
      cloudThickness:   result.cloudThickness   ?? null,
      ts:            Date.now(),
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by kiteTicker on every candle close.
 * Returns immediately for intervals / tokens we don't watch.
 */
async function onCandleClose(token, interval) {
  if (!WATCHED_INTERVALS.has(interval)) return;
  if (!_tokenLabel.has(Number(token)))   return;

  try {
    // ── Native interval (15m / 1h / 1d) ───────────────────────────────────
    const candles = candleStore.getCandlesSync(token, interval);
    if (candles && candles.length >= 52) {
      await _runAndAlert(token, interval, candles);
    }

    // ── Synthetic 4h: run whenever a 1h candle closes ─────────────────────
    if (interval === '60minute') {
      const c1h = candleStore.getCandlesSync(token, '60minute');
      if (c1h && c1h.length >= 8) {
        const c4h = _to4H(c1h);
        if (c4h.length >= 52) {
          await _runAndAlert(token, '4h', c4h);
        }
      }
    }
  } catch (err) {
    console.warn(`[PatternAlert] Unhandled error on ${token}:${interval} —`, err.message);
  }
}

/**
 * Register index and macro tokens to watch, then pre-seed their candle buffers.
 * Must be called AFTER instrumentCache has loaded so getFrontMonthFutures works.
 */
function start() {
  // ── Index instruments (NSE) ───────────────────────────────────────────
  _tokenLabel.set(256265, 'NIFTY 50');   _exchangeMap.set(256265, 'NSE');
  _tokenLabel.set(260105, 'NIFTY BANK'); _exchangeMap.set(260105, 'NSE');

  // ── Macro instruments ─────────────────────────────────────────────────
  _tokenLabel.set(VIX_TOKEN, 'India VIX'); _exchangeMap.set(VIX_TOKEN, 'NSE');

  const crudeInst      = getFrontMonthFutures('CRUDEOIL',   'MCX');
  const goldInst       = getFrontMonthFutures('GOLD',       'MCX');
  const silverInst     = getFrontMonthFutures('SILVER',     'MCX');
  const naturalgasInst = getFrontMonthFutures('NATURALGAS', 'MCX');
  const usdinrInst     = getFrontMonthFutures('USDINR',     'CDS');

  if (crudeInst) {
    _tokenLabel.set(crudeInst.instrumentToken, `Crude Oil`);
    _tokenTradingsymbol.set(crudeInst.instrumentToken, crudeInst.tradingsymbol);
    _exchangeMap.set(crudeInst.instrumentToken, 'MCX');
  }
  if (goldInst) {
    _tokenLabel.set(goldInst.instrumentToken, `Gold`);
    _tokenTradingsymbol.set(goldInst.instrumentToken, goldInst.tradingsymbol);
    _exchangeMap.set(goldInst.instrumentToken, 'MCX');
  }
  if (silverInst) {
    _tokenLabel.set(silverInst.instrumentToken, `Silver`);
    _tokenTradingsymbol.set(silverInst.instrumentToken, silverInst.tradingsymbol);
    _exchangeMap.set(silverInst.instrumentToken, 'MCX');
  }
  if (naturalgasInst) {
    _tokenLabel.set(naturalgasInst.instrumentToken, `Natural Gas`);
    _tokenTradingsymbol.set(naturalgasInst.instrumentToken, naturalgasInst.tradingsymbol);
    _exchangeMap.set(naturalgasInst.instrumentToken, 'MCX');
  }
  if (usdinrInst) {
    _tokenLabel.set(usdinrInst.instrumentToken, `USD/INR`);
    _tokenTradingsymbol.set(usdinrInst.instrumentToken, usdinrInst.tradingsymbol);
    _exchangeMap.set(usdinrInst.instrumentToken, 'NSE');
  }

  // ── Pre-seed candle buffers for every watched token × interval ─────────
  // Without this, getCandlesSync() always returns null for macro tokens and
  // pattern alerts for those instruments never fire.
  // Index tokens (NIFTY/BANKNIFTY) are already seeded by indexSignalWatcher,
  // but seeding them here is safe — getCandles() deduplicates concurrent requests.
  const seedIntervals = ['15minute', '60minute', 'day'];
  for (const [token] of _tokenLabel) {
    for (const interval of seedIntervals) {
      candleStore.getCandles(token, interval).catch((err) => {
        console.warn(`[PatternAlert] Seed failed ${token}:${interval} —`, err.message);
      });
    }
  }

  const patterns = patternRegistry.list().map((p) => p.label).join(', ');
  console.log(`[PatternAlert] Ready — watching ${_tokenLabel.size} instruments on 15m / 1h / 4h / 1d`);
  console.log(`[PatternAlert] Patterns: ${patterns}`);
}

function clearDedup() {
  const count = _dedup.size;
  _dedup.clear();
  console.log(`[PatternAlert] clearDedup — cleared ${count} entries`);
  return count;
}

module.exports = { start, onCandleClose, clearDedup };
