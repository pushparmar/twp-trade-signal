const { fetchLastNCandles } = require('./historicalCache');

const MAX_CANDLES = 120;

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

function _slotStart(tsMs, intervalMs) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

/**
 * Update all seeded buffers for this token with the latest tick.
 * Called on every incoming KiteTicker tick — must stay fast.
 *
 * onCandleClose(token, interval) is called whenever a candle period boundary is
 * crossed so callers can broadcast or react to the new closed candle.
 */
function onTick(instrumentToken, lastPrice, tradeTimeMs, onCandleClose) {
  const intervals = _tokenIndex.get(instrumentToken);
  if (!intervals || intervals.size === 0) return;

  const now = tradeTimeMs || Date.now();

  for (const interval of intervals) {
    const iMs = INTERVAL_MS[interval];
    if (!iMs) continue;

    const key   = `${instrumentToken}:${interval}`;
    const entry = _store.get(key);
    if (!entry) continue;

    const slot = _slotStart(now, iMs);

    if (entry.currentSlot !== slot) {
      // Candle boundary — commit current candle into history ring, start new one
      if (entry.currentCandle) {
        entry.candles.push({ ...entry.currentCandle });
        if (entry.candles.length > MAX_CANDLES) entry.candles.shift();
        if (onCandleClose) onCandleClose(instrumentToken, interval);
      }
      entry.currentSlot   = slot;
      entry.currentCandle = {
        date:   new Date(slot).toISOString(),
        open:   lastPrice,
        high:   lastPrice,
        low:    lastPrice,
        close:  lastPrice,
        volume: 0,
      };
    } else {
      // Same candle — update OHLC in-place
      const c = entry.currentCandle;
      if (lastPrice > c.high) c.high = lastPrice;
      if (lastPrice < c.low)  c.low  = lastPrice;
      c.close = lastPrice;
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
 * Concurrent calls for the same key share a single seed promise.
 *
 * @param {number} instrumentToken
 * @param {string} interval - Kite interval string e.g. '15minute', 'day'
 * @param {number} [bars]   - Override seed count (defaults to MAX_CANDLES)
 *
 * Returns: historical candles (ring) + current open candle appended.
 */
async function getCandles(instrumentToken, interval, bars) {
  const token   = Number(instrumentToken);
  const key     = `${token}:${interval}`;
  const nCandles = bars && bars > 0 ? Math.min(bars, MAX_CANDLES * 2) : MAX_CANDLES;

  if (!_store.has(key)) {
    if (!_seeding.has(key)) {
      const p = fetchLastNCandles(token, interval, nCandles)
        .then((candles) => {
          _store.set(key, { candles: [...candles], currentSlot: null, currentCandle: null });
          if (!_tokenIndex.has(token)) _tokenIndex.set(token, new Set());
          _tokenIndex.get(token).add(interval);
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
 * Drop all buffers for a token (call when unsubscribing).
 */
function remove(instrumentToken) {
  const token     = Number(instrumentToken);
  const intervals = _tokenIndex.get(token);
  if (intervals) {
    for (const interval of intervals) {
      _store.delete(`${token}:${interval}`);
    }
    _tokenIndex.delete(token);
  }
}

function stats() {
  let totalCandles = 0;
  for (const entry of _store.values()) {
    totalCandles += entry.candles.length + (entry.currentCandle ? 1 : 0);
  }
  return { keys: _store.size, totalCandles };
}

module.exports = { onTick, getCandles, getCandlesSync, remove, stats };
