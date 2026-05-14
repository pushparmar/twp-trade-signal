const axios = require('axios');
const { getConfig } = require('../store');

// Cache: key = `${token}_${interval}_${from}_${to}` → { candles, fetchedAt }
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Rate-limit queue ──────────────────────────────────────────────────────────
// Kite historical API allows ~3 req/s sustained. We cap at MAX_CONCURRENT
// in-flight requests and add MIN_GAP_MS between successive dispatches.
//
// Throughput math: 3 concurrent × 1 dispatch per 300 ms ≈ 10 req/s theoretical,
// but each Kite call takes 300–600 ms, so effective throughput ≈ 5–8 req/s —
// safely below the Kite limit while being 2–3× faster than the old 2×350 ms setting.
//
// TWO queues — same rate-limit pool but different insertion points:
//   _queueBackground  — bulk boot-time seeding / scan fetches; appended to tail
//   _queuePriority    — user-initiated chart fetches;          inserted at head
//
// Both queues drain through the same _inFlight / _lastSent counters so the
// global rate limit is respected, but a user opening a chart never waits
// behind background seeds.
const MAX_CONCURRENT = 3;   // was 2 — more parallelism, still within Kite limits
const MIN_GAP_MS     = 300; // ms between dispatches (was 350)

let _inFlight   = 0;
let _lastSent   = 0;
const _queueBackground = []; // { run, resolve, reject } — background seeding
const _queuePriority   = []; // { run, resolve, reject } — user chart requests

function _drain() {
  // Priority queue drains first; background fills remaining slots
  const combined = [..._queuePriority, ..._queueBackground];
  if (combined.length === 0 || _inFlight >= MAX_CONCURRENT) return;

  const gap = MIN_GAP_MS - (Date.now() - _lastSent);
  if (gap > 0) {
    setTimeout(_drain, gap);
    return;
  }

  // Take from priority queue first, then background
  let item;
  if (_queuePriority.length > 0) {
    item = _queuePriority.shift();
  } else {
    item = _queueBackground.shift();
  }

  const { run, resolve, reject } = item;
  _inFlight++;
  _lastSent = Date.now();

  run()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      _inFlight--;
      _drain();
    });

  // Immediately try to dispatch a second slot if capacity allows
  if (_inFlight < MAX_CONCURRENT) _drain();
}

/**
 * Enqueue a background (low-priority) fetch — appended to tail.
 * Used by watchers that bulk-seed on boot.
 */
function _enqueue(run) {
  return new Promise((resolve, reject) => {
    _queueBackground.push({ run, resolve, reject });
    _drain();
  });
}

/**
 * Enqueue a priority (high-priority) fetch — inserted at head.
 * Used by user-initiated chart API calls so they bypass background seeding.
 */
function _enqueuePriority(run) {
  return new Promise((resolve, reject) => {
    _queuePriority.push({ run, resolve, reject });
    _drain();
  });
}

// ── Raw Kite API fetch ────────────────────────────────────────────────────────

async function _fetchFromKite(instrumentToken, interval, from, to, continuous) {
  const { kite } = getConfig();
  if (!kite.apiKey || !kite.accessToken) {
    throw new Error('Kite not authenticated');
  }

  const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}`;
  const response = await axios.get(url, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
    },
    params: { from, to, continuous: continuous ? 1 : 0 },
    timeout: 15_000,
  });

  const raw = response.data?.data?.candles || [];
  return raw.map(([date, open, high, low, close, volume]) => ({
    date,
    open:   Number(open),
    high:   Number(high),
    low:    Number(low),
    close:  Number(close),
    volume: Number(volume),
  }));
}

/**
 * Fetch OHLCV candles from Kite historical API.
 * Returns array of { date, open, high, low, close, volume }
 *
 * @param {number}  instrumentToken
 * @param {string}  interval    - minute|3minute|5minute|10minute|15minute|30minute|60minute|day
 * @param {string}  from        - "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
 * @param {string}  to          - "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
 * @param {boolean} continuous  - for futures continuous data
 * @param {boolean} [priority]  - true = user chart request (jumps the queue)
 */
async function fetchCandles(instrumentToken, interval, from, to, continuous = false, priority = false) {
  const cacheKey = `${instrumentToken}_${interval}_${from}_${to}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.candles;
  }

  const enqueue = priority ? _enqueuePriority : _enqueue;

  return enqueue(async () => {
    const candles = await _fetchFromKite(instrumentToken, interval, from, to, continuous);
    _cache.set(cacheKey, { candles, fetchedAt: Date.now() });
    return candles;
  });
}

/**
 * Round a Date down to the start of the current candle period for this interval.
 *
 * Purpose: makes the cache key stable within any single candle window.
 * Without this, every call to fetchLastNCandles generates a different `to`
 * timestamp (seconds drift), so the cache always misses on the next scan run
 * even though the underlying data is identical.
 *
 * For a scan that runs every few minutes, rounding `to` to the current candle
 * boundary means all calls within that candle share one cache entry (TTL 5 min).
 */
function _roundToCandle(date, interval) {
  const ms  = date.getTime();
  const map = {
    minute:    60_000,
    '3minute': 3  * 60_000,
    '5minute': 5  * 60_000,
    '10minute':10 * 60_000,
    '15minute':15 * 60_000,
    '30minute':30 * 60_000,
    '60minute':60 * 60_000,
    day:       24 * 60 * 60_000,
  };
  const bucket = map[interval] || 15 * 60_000;
  return new Date(Math.floor(ms / bucket) * bucket);
}

/**
 * Fetch the last N candles ending now.
 * Automatically calculates the `from` date based on interval and count.
 *
 * @param {boolean} [priority] - true = user chart request (bypasses background queue)
 */
async function fetchLastNCandles(instrumentToken, interval, count, priority = false) {
  // Round `now` to the current candle boundary so repeat calls within the
  // same candle period share a single cache entry instead of missing every time.
  const now = _roundToCandle(new Date(), interval);
  const to  = formatDate(now);

  // Indian market trades only 6.25h/day on 5 of 7 days, so calendar lookback must be
  // much wider than raw (count × minutesPerCandle) to guarantee enough candles.
  //
  //   – day: each trading day = 1 candle but 1440 calendar minutes (non-trading time is large).
  //     To collect `count` trading-day candles safely, look back count×2 calendar days
  //     (≈ count × 7/5 rounded up with a margin). For count=100 that is 200 calendar days
  //     → ~143 trading days, so slice(-100) always yields a full 100-candle set ≥ 52 needed
  //     by Ichimoku.
  //   – 60minute: 45-day floor gives ~281 1h candles; _to4H(208) produces 52 4h candles
  //     needed by Ichimoku.  We also scale with count so large bar requests don't starve.
  //   – all others: 14-day floor (sufficient for 15m / 5m / 1m signals)
  const minutesPerCandle = intervalToMinutes(interval);
  const minDays =
    interval === 'day'      ? Math.ceil(count * 2) :
    interval === '60minute' ? Math.max(45, Math.ceil(count / 6.25 * 1.6)) :
    14;
  const minutesNeeded = Math.max(count * minutesPerCandle * 2.5, minDays * 24 * 60);
  const from = formatDate(new Date(now.getTime() - minutesNeeded * 60 * 1000));

  const candles = await fetchCandles(instrumentToken, interval, from, to, false, priority);
  // Return the last `count` candles
  return candles.slice(-count);
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function intervalToMinutes(interval) {
  const map = {
    minute: 1, '3minute': 3, '5minute': 5, '10minute': 10,
    '15minute': 15, '30minute': 30, '60minute': 60, day: 375,
  };
  return map[interval] || 15;
}

function clearCache() {
  _cache.clear();
}

module.exports = { fetchCandles, fetchLastNCandles, formatDate };
