/**
 * LiveScanner — real-time Ichimoku pattern scanner for user watchlist stocks.
 *
 * For each candle close on a subscribed instrument, runs every registered
 * pattern. On a first-of-day match:
 *   1. Broadcasts a `scan_alert` SSE so the Scanner UI tab updates instantly.
 *   2. Sends a Telegram message via telegramNotifier (uses the same per-day
 *      dedup, so we never duplicate the SSE entry with the Telegram alert).
 *
 * Public API:
 *   addWatch(token, label)       — call when a stock is subscribed
 *   removeWatch(token)           — call when a stock is unsubscribed
 *   onCandleClose(token, interval) — called by kiteTicker on every close
 *   seedFromWatchlist()          — called once at boot to pick up persisted watchlist
 */

const candleStore      = require('./candleStore');
const patternRegistry  = require('./patternRegistry');
const { broadcast }    = require('../sseHub');
const store            = require('../store');
const { to4H }         = require('./ichimoku');
const telegramNotifier = require('./telegramNotifier');
const patternAlertMessage = require('./patternAlertMessage');
const { isNseOpen, IST_OFFSET_MS } = require('../utils/marketHours');
const db               = require('../db');

// ── Constants ────────────────────────────────────────────────────────────────

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

// Session-aware 4h synthesis — imported from ichimoku.js.
function _to4H(candles1h) {
  return to4H(candles1h);
}

// ── Core scanner ─────────────────────────────────────────────────────────────

/**
 * Run every registered pattern against candles for (token, interval), then
 * for each new (first-of-day) match:
 *   - Broadcast a `scan_alert` SSE for the Scanner UI tab.
 *   - Send a Telegram message via telegramNotifier.
 *
 * Both side-effects share the same `_claimFire` dedup, so SSE and Telegram
 * always fire together (or not at all). A failing Telegram send does NOT
 * block or roll back the SSE broadcast.
 */
async function _runAndBroadcast(token, interval, candles) {
  const label    = _watchMap.get(Number(token));
  const tfLabel  = TF_LABEL[interval] || interval;
  if (!label) return;

  // Look up Telegram chat once per invocation. If not configured, skip
  // Telegram side entirely but keep SSE broadcasts working.
  const chatId = store.getTelegramChatId();

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
      // Do NOT reset the dedup: brief oscillations (pattern goes false for
      // one bar then true again) would otherwise fire a new alert on every
      // candle. The dedup resets at midnight IST so a genuine new setup on
      // the next trading day will fire correctly.
      continue;
    }

    const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
    if (!_claimFire(dedupKey)) continue; // already broadcast today

    // ── SSE: always fires (Scanner UI tab) ─────────────────────────────────
    const alertPayload = {
      token:            Number(token),
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
      // SL / Target (liveScanner passes these through from the pattern result)
      sl:               result.sl               ?? null,
      target:           result.target           ?? null,
      // Volume
      volumeRatio:      result.volumeRatio      ?? null,
      volumeConfirmed:  result.volumeConfirmed  ?? null,
      ts:               Date.now(),
    };
    broadcast('scan_alert', alertPayload);

    // ── MongoDB — fire-and-forget (never blocks the scan loop) ────────────
    db.alertRepo.insertAlert(alertPayload, 'live');

    console.log(`[LiveScanner] ${result.signal === 'bullish' ? '🟢' : '🔴'} ${patternId} ${result.signal} — ${label} (${tfLabel})`);

    // ── Telegram: gated on market hours — chatId may be unset ────────────────
    if (chatId && isNseOpen()) {
      const text = patternAlertMessage.build({ label, tfLabel, patternLabel, result, kind: 'stock' });
      try {
        await telegramNotifier.sendMessage(chatId, text);
      } catch (err) {
        console.warn(`[LiveScanner] Telegram send failed for ${label} (${tfLabel}):`, err.message);
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by kiteTicker on every candle close.
 * Returns immediately for intervals / tokens we don't watch.
 *
 * Async because Telegram send is awaited inside _runAndBroadcast. kiteTicker
 * fires this without awaiting (fire-and-forget) — errors are caught here so
 * a Telegram outage never bubbles up into the tick handler.
 */
async function onCandleClose(token, interval) {
  if (!WATCHED_INTERVALS.has(interval)) return;
  if (!_watchMap.has(Number(token)))    return;

  try {
    // ── Native interval (15m / 1h / 1d) ───────────────────────────────────
    const candles = candleStore.getCandlesSync(token, interval);
    if (candles && candles.length >= 52) {
      await _runAndBroadcast(token, interval, candles);
    }

    // ── Synthetic 4h: triggered on every 1h close ─────────────────────────
    if (interval === '60minute') {
      const c1h = candleStore.getCandlesSync(token, '60minute');
      if (c1h && c1h.length >= 8) {
        const c4h = _to4H(c1h);
        if (c4h.length >= 52) {
          await _runAndBroadcast(token, '4h', c4h);
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

/**
 * Clear the per-instrument pattern-fire dedup guard so every instrument can
 * re-trigger today's alerts on the next candle close. Called during a full
 * system reset so live scanner alerts are not suppressed by stale dedup state.
 * Returns the number of entries cleared.
 */
function clearDedup() {
  const count = _dedup.size;
  _dedup.clear();
  return count;
}

module.exports = { onCandleClose, addWatch, removeWatch, seedFromWatchlist, watchCount, clearDedup };
