const { fetchLastNCandles } = require('./historicalCache');

// Re-export so callers that use priority seeding can pass the flag through
// getCandles without needing to import historicalCache separately.

// ── Per-interval ring buffer capacity (1.5× chart display needs) ──────────────
//
// 60minute is large because it serves TWO purposes:
//   1. 1h chart display  (needs ~200 candles)
//   2. 4h synthesis      (200 4h bars × 4 × 1.5 safety = 1 200 1h candles)
//
// 'day' is 450 so 1d chart can display 300 bars comfortably.
// Short intraday intervals (1m / 5m / 15m) keep 300 which is ~5 h / 25 h / 75 h.
const MAX_CANDLES_MAP = {
  'minute':    300,
  '3minute':   300,
  '5minute':   300,
  '10minute':  300,
  '15minute':  300,
  '30minute':  300,
  '60minute':  1200,
  'day':       450,
};
const DEFAULT_MAX_CANDLES = 300;

function _maxFor(interval) {
  return MAX_CANDLES_MAP[interval] ?? DEFAULT_MAX_CANDLES;
}

// Milliseconds per interval
const INTERVAL_MS = {
  minute:     60_000,
  '3minute':  3   * 60_000,
  '5minute':  5   * 60_000,
  '10minute': 10  * 60_000,
  '15minute': 15  * 60_000,
  '30minute': 30  * 60_000,
  '60minute': 60  * 60_000,
  day:        375 * 60_000,
};

// Map<"token:interval", { candles: candle[], currentSlot: number|null, currentCandle: candle|null }>
const _store = new Map();
// Map<instrumentToken (number), Set<interval>> — fast reverse index for onTick
const _tokenIndex = new Map();
// Map<"token:interval", Promise> — deduplicates concurrent seed requests
const _seeding = new Map();
// Map<"token:interval", number> — how many candles this key was seeded with
const _seededWith = new Map();
// Map<"token:interval", number> — timestamp of last empty-result from Kite.
// When a fetch returns 0 candles (expired contract, invalid token, holiday gap)
// we avoid hammering Kite by waiting EMPTY_RETRY_COOLDOWN_MS before trying again.
const _emptyResultAt = new Map();
const EMPTY_RETRY_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between retries for dead tokens

// Map<token, number> — last seen cumulative volume_traded for this token.
// Kite ticks carry the day's running total, so per-candle volume is the delta
// between consecutive ticks.  Reset to undefined on subscribe so the very first
// tick after a (re)connect doesn't get treated as a giant volume burst.
const _lastVolume = new Map();

function _slotStart(tsMs, intervalMs) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

/**
 * Update all seeded buffers for this token with the latest tick.
 * Called on every incoming KiteTicker tick — must stay fast.
 *
 * onCandleClose(token, interval) is called whenever a candle period boundary is
 * crossed so callers can broadcast or react to the new closed candle.
 *
 * @param {number}   instrumentToken
 * @param {number}   lastPrice
 * @param {number}   tradeTimeMs       Tick timestamp (ms) — falls back to now()
 * @param {function} onCandleClose     Optional callback(token, interval)
 * @param {number}   [volumeTraded]    Kite's cumulative day volume from the tick.
 *                                     Per-candle volume = delta from prior tick.
 */
function onTick(instrumentToken, lastPrice, tradeTimeMs, onCandleClose, volumeTraded) {
  const intervals = _tokenIndex.get(instrumentToken);
  if (!intervals || intervals.size === 0) return;

  const now = tradeTimeMs || Date.now();

  // Per-tick volume delta — Kite ticks carry the day's cumulative total.
  // The first tick after (re)subscribe stores the baseline and contributes 0
  // so we never inject a fake bulk volume on the very first update.
  let volumeDelta = 0;
  if (typeof volumeTraded === 'number') {
    const prev = _lastVolume.get(instrumentToken);
    if (prev != null && volumeTraded >= prev) {
      volumeDelta = volumeTraded - prev;
    }
    _lastVolume.set(instrumentToken, volumeTraded);
  }

  for (const interval of intervals) {
    const iMs = INTERVAL_MS[interval];
    if (!iMs) continue;

    const key   = `${instrumentToken}:${interval}`;
    const entry = _store.get(key);
    if (!entry) continue;

    const slot   = _slotStart(now, iMs);
    const maxCap = _maxFor(interval);

    if (entry.currentSlot !== slot) {
      // Candle boundary — commit current candle into history ring, start new one
      if (entry.currentCandle) {
        entry.candles.push({ ...entry.currentCandle });
        if (entry.candles.length > maxCap) entry.candles.shift();
        if (onCandleClose) onCandleClose(instrumentToken, interval);
      }
      entry.currentSlot   = slot;
      entry.currentCandle = {
        date:   new Date(slot).toISOString(),
        open:   lastPrice,
        high:   lastPrice,
        low:    lastPrice,
        close:  lastPrice,
        // First tick of a new candle: seed with this tick's delta so we capture
        // any trades that happened right at the boundary (better than discarding).
        volume: Math.max(0, volumeDelta),
      };
    } else {
      // Same candle — update OHLC + accumulate volume
      const c = entry.currentCandle;
      if (lastPrice > c.high) c.high = lastPrice;
      if (lastPrice < c.low)  c.low  = lastPrice;
      c.close   = lastPrice;
      c.volume += volumeDelta;
    }
  }
}

/**
 * Return candles synchronously if already seeded — null otherwise.
 * Used for in-process callers that must not block (e.g. tick handler).
 */
function getCandlesSync(instrumentToken, interval) {
  const entry = _store.get(`${Number(instrumentToken)}:${interval}`);
  if (!entry) return null;
  const all = [...entry.candles];
  if (entry.currentCandle) all.push({ ...entry.currentCandle });
  return all;
}

/**
 * Return candles for a token+interval, seeding from historical API on first call.
 * Re-seeds if the buffer currently holds fewer candles than requested (e.g. a
 * previous seed used a smaller count). Concurrent calls share a single seed promise.
 *
 * @param {number} instrumentToken
 * @param {string} interval   - Kite interval string e.g. '15minute', 'day'
 * @param {number}  [bars]     - Desired bar count (capped at MAX_CANDLES_MAP[interval])
 * @param {boolean} [priority] - true = user-initiated chart request; bypasses
 *                               background seeding queue so the chart loads
 *                               immediately even during bulk boot-time seeding.
 *
 * Returns: historical candles (ring) + current open candle appended.
 */
async function getCandles(instrumentToken, interval, bars, priority = false) {
  const token  = Number(instrumentToken);
  const key    = `${token}:${interval}`;
  const maxCap = _maxFor(interval);

  // How many candles to seed — capped at this interval's ring-buffer size
  const nCandles = bars && bars > 0 ? Math.min(bars, maxCap) : maxCap;

  // Re-seed if:
  //   a) buffer doesn't exist yet, OR
  //   b) buffer exists but was seeded with fewer candles than now requested, OR
  //   c) the last fetch returned empty (expired token / holiday) and the cooldown has passed.
  //      Without this check the empty buffer is treated as "seeded" permanently and
  //      the caller always sees "got 0" until the server restarts.
  const prevSeed     = _seededWith.get(key) ?? 0;
  const lastEmptyAt  = _emptyResultAt.get(key) ?? 0;
  const emptyExpired = lastEmptyAt > 0 && (Date.now() - lastEmptyAt) > EMPTY_RETRY_COOLDOWN_MS;
  const needsReseed  = nCandles > prevSeed || emptyExpired;

  if (!_store.has(key) || (needsReseed && !_seeding.has(key))) {
    if (!_seeding.has(key)) {
      // ── Pre-register BEFORE the async fetch so ticks are never dropped ──────
      //
      // Bug: _tokenIndex and _store were only written inside `.then()`, so any
      // tick arriving during the ~1 s Kite API call was silently skipped by
      // onTick's early-exit guard. This prevented the first candle-close from
      // ever firing and broke 15-minute macro triggers on boot.
      //
      // Fix: register both _tokenIndex and a placeholder _store entry RIGHT NOW,
      // before the network call. onTick will start accepting ticks immediately;
      // currentSlot/currentCandle are built from the first tick as normal. When
      // the fetch resolves we overwrite _store.candles with historical data while
      // keeping whatever currentSlot/currentCandle ticks have already built.
      if (!_tokenIndex.has(token)) _tokenIndex.set(token, new Set());
      _tokenIndex.get(token).add(interval);

      if (!_store.has(key)) {
        // Placeholder so onTick's `const entry = _store.get(key)` returns an
        // object rather than undefined. candles is empty until fetch completes.
        _store.set(key, { candles: [], currentSlot: null, currentCandle: null });
      }

      const p = fetchLastNCandles(token, interval, nCandles, priority)
        .then((candles) => {
          // Read current live-candle state that ticks may have built during the
          // fetch — preserve it so we don't discard any partial candle data.
          const live = _store.get(key);
          _store.set(key, {
            candles:       [...candles],
            currentSlot:   live?.currentSlot   ?? null,
            currentCandle: live?.currentCandle ?? null,
          });

          if (candles.length > 0) {
            // Successful seed — record count and clear any previous empty-result marker.
            _seededWith.set(key, nCandles);
            _emptyResultAt.delete(key);
          } else {
            // Kite returned no candles (expired contract, invalid token, holiday gap).
            // Do NOT mark as seeded — leave _seededWith at its previous value so
            // needsReseed stays true. Record the timestamp so the cooldown can throttle
            // retries and avoid hammering Kite every single request.
            _emptyResultAt.set(key, Date.now());
            console.warn(`[candleStore] 0 candles from Kite for ${key} — will retry after ${EMPTY_RETRY_COOLDOWN_MS / 1000}s cooldown`);
          }
        })
        .finally(() => _seeding.delete(key));
      _seeding.set(key, p);
    }
    await _seeding.get(key);
  }

  const entry = _store.get(key);
  if (!entry) return [];

  // Return a shallow copy: historical + live open candle
  const all = [...entry.candles];
  if (entry.currentCandle) all.push({ ...entry.currentCandle });
  return all;
}

/**
 * Directly seed a token+interval buffer from a pre-fetched candle array,
 * bypassing the Kite historical API entirely.
 *
 * Used by equityScanService to restore candles from MongoDB without hitting
 * the Kite rate-limited endpoint. The behaviour mirrors what `getCandles()`
 * does after the API call resolves — live tick state is preserved if present.
 *
 * @param {number}   instrumentToken
 * @param {string}   interval   e.g. '60minute', 'day'
 * @param {object[]} candles    OHLCV array (same format as historicalCache returns)
 */
function seed(instrumentToken, interval, candles) {
  if (!candles || candles.length === 0) return;
  const token = Number(instrumentToken);
  const key   = `${token}:${interval}`;

  // Register in token index so onTick can find this entry
  if (!_tokenIndex.has(token)) _tokenIndex.set(token, new Set());
  _tokenIndex.get(token).add(interval);

  // Preserve any in-flight live candle state built from ticks during the load
  const live = _store.get(key);
  _store.set(key, {
    candles:       [...candles],
    currentSlot:   live?.currentSlot   ?? null,
    currentCandle: live?.currentCandle ?? null,
  });

  // Mark as seeded so getCandles() won't trigger a redundant Kite re-fetch
  _seededWith.set(key, candles.length);
  _emptyResultAt.delete(key);
}

/**
 * Drop all buffers for a token (call when unsubscribing).
 */
function remove(instrumentToken) {
  const token     = Number(instrumentToken);
  const intervals = _tokenIndex.get(token);
  if (intervals) {
    for (const interval of intervals) {
      const key = `${token}:${interval}`;
      _store.delete(key);
      _seededWith.delete(key);
      _emptyResultAt.delete(key);
    }
    _tokenIndex.delete(token);
  }
  _lastVolume.delete(token);
}

function stats() {
  let totalCandles = 0;
  for (const entry of _store.values()) {
    totalCandles += entry.candles.length + (entry.currentCandle ? 1 : 0);
  }
  return { keys: _store.size, totalCandles };
}

/**
 * Wipe every ring buffer and the token index so the next getCandles() call
 * re-seeds from the Kite API, producing a genuine fresh-start state.
 *
 * Note: any in-flight seed promises (_seeding) are left to resolve naturally —
 * they will simply re-populate the freshly cleared store without harm.
 * Live tick subscriptions will restart accumulating from the next tick.
 *
 * Returns the number of key–interval pairs that were cleared.
 */
function clearAll() {
  const cleared = _store.size;
  _store.clear();
  _tokenIndex.clear();
  _seededWith.clear();
  _emptyResultAt.clear();
  _lastVolume.clear();
  // Leave _seeding alone — in-flight promises will finish and repopulate safely.
  return cleared;
}

module.exports = { onTick, getCandles, getCandlesSync, seed, remove, stats, clearAll };
