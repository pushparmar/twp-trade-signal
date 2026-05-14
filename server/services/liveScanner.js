/**
 * LiveScanner — real-time Ichimoku pattern scanner for user watchlist stocks.
 *
 * Unlike patternAlertWatcher (which sends Telegram for index/macro instruments),
 * liveScanner covers the user's manually-added watchlist stocks and broadcasts
 * `scan_alert` SSE events when a pattern fires — no Telegram messages.
 *
 * Public API:
 *   addWatch(token, label)       — call when a stock is subscribed
 *   removeWatch(token)           — call when a stock is unsubscribed
 *   onCandleClose(token, interval) — called by kiteTicker on every close
 *   seedFromWatchlist()          — called once at boot to pick up persisted watchlist
 */

const candleStore     = require('./candleStore');
const patternRegistry = require('./patternRegistry');
const { broadcast }   = require('../sseHub');
const store           = require('../store');

// ── Constants ────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Only react to these native intervals; 4h is synthesised from 60minute.
const WATCHED_INTERVALS = new Set(['15minute', '60minute', 'day']);

// Human-readable TF labels (kept in sync with patternAlertWatcher)
const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// ── State ────────────────────────────────────────────────────────────────────

// Map<token (number), displayLabel (string)> — e.g. 12345 → "RELIANCE25JUNFUT"
const _watchMap = new Map();

// Dedup: "token:interval:patternId:signal" → { fired: bool, date: string (IST) }
const _dedup = new Map();

// ── Helpers (mirrors patternAlertWatcher.js) ─────────────────────────────────

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Mark (token, interval, patternId, signal) as fired for today.
 * Returns true on first claim, false if already fired today.
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

/**
 * Reset the dedup flag when the signal clears so the next setup can fire again.
 */
function _resetFire(key) {
  const today = _istDateStr();
  _dedup.set(key, { fired: false, date: today });
}

/** Synthesise 4h candles from consecutive 1h candles (same as macroAnalysis / patternAlertWatcher). */
function _to4H(candles1h) {
  const out = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const slice = candles1h.slice(i, i + 4);
    out.push({
      date:  slice[0].date,
      open:  slice[0].open,
      high:  Math.max(...slice.map((c) => c.high)),
      low:   Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

// ── Core scanner ─────────────────────────────────────────────────────────────

/**
 * Run every registered pattern against candles for (token, interval) and
 * broadcast a `scan_alert` SSE event for each new match.
 */
function _runAndBroadcast(token, interval, candles) {
  const label    = _watchMap.get(Number(token));
  const tfLabel  = TF_LABEL[interval] || interval;
  if (!label) return;

  for (const { id: patternId, label: patternLabel } of patternRegistry.list()) {
    const pattern = patternRegistry.get(patternId);

    let result;
    try {
      result = pattern.run(candles, pattern.defaultOpts);
    } catch {
      continue; // bad candle data — skip silently
    }

    if (!result?.matched || !result.signal) {
      // Pattern cleared — reset dedup so the next crossing can fire again
      _resetFire(`${token}:${interval}:${patternId}:bullish`);
      _resetFire(`${token}:${interval}:${patternId}:bearish`);
      continue;
    }

    const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
    if (!_claimFire(dedupKey)) continue; // already broadcast today

    broadcast('scan_alert', {
      token:        Number(token),
      label,
      interval,
      tfLabel,
      patternId,
      patternLabel,
      signal:       result.signal,
      score:        result.score  ?? null,
      close:        result.close  ?? null,
      ts:           Date.now(),
    });

    console.log(`[LiveScanner] ${result.signal === 'bullish' ? '🟢' : '🔴'} ${patternId} ${result.signal} — ${label} (${tfLabel})`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by kiteTicker on every candle close.
 * Returns immediately for intervals / tokens we don't watch.
 */
function onCandleClose(token, interval) {
  if (!WATCHED_INTERVALS.has(interval)) return;
  if (!_watchMap.has(Number(token)))    return;

  try {
    // ── Native interval (15m / 1h / 1d) ───────────────────────────────────
    const candles = candleStore.getCandlesSync(token, interval);
    if (candles && candles.length >= 52) {
      _runAndBroadcast(token, interval, candles);
    }

    // ── Synthetic 4h: triggered on every 1h close ─────────────────────────
    if (interval === '60minute') {
      const c1h = candleStore.getCandlesSync(token, '60minute');
      if (c1h && c1h.length >= 8) {
        const c4h = _to4H(c1h);
        if (c4h.length >= 52) {
          _runAndBroadcast(token, '4h', c4h);
        }
      }
    }
  } catch (err) {
    console.warn(`[LiveScanner] Error on ${token}:${interval} —`, err.message);
  }
}

/**
 * Register a token for live scanning.
 * Candle buffers are seeded by the subscribe flow (candleStore.getCandles is
 * called there already) — we do NOT trigger a redundant re-seed here.
 *
 * @param {number} token
 * @param {string} label  - Display label, e.g. tradingsymbol or full name
 */
function addWatch(token, label) {
  _watchMap.set(Number(token), label);
}

/**
 * Deregister a token — no more scan alerts for it.
 */
function removeWatch(token) {
  _watchMap.delete(Number(token));
}

/**
 * Seed the watch map from the persisted watchlist on server boot.
 * This ensures the Scanner tab shows alerts after a server restart even if
 * the client has not yet triggered any /subscribe calls.
 */
function seedFromWatchlist() {
  const watchlist = store.getWatchlist();
  for (const item of watchlist) {
    _watchMap.set(Number(item.instrumentToken), item.tradingsymbol || item.name || `Token ${item.instrumentToken}`);
  }
  if (watchlist.length) {
    console.log(`[LiveScanner] Seeded ${watchlist.length} instruments from persisted watchlist`);
  }
}

/** Diagnostic: how many instruments are being watched. */
function watchCount() {
  return _watchMap.size;
}

module.exports = { onCandleClose, addWatch, removeWatch, seedFromWatchlist, watchCount };
