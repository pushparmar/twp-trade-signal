const axios = require('axios');
const { getConfig } = require('../store');

// Cache: key = `${token}_${interval}_${from}_${to}` → { candles, fetchedAt }
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch OHLCV candles from Kite historical API.
 * Returns array of { date, open, high, low, close, volume }
 *
 * @param {number} instrumentToken
 * @param {string} interval  - minute|3minute|5minute|10minute|15minute|30minute|60minute|day
 * @param {string} from      - "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
 * @param {string} to        - "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
 * @param {boolean} continuous - for futures continuous data
 */
async function fetchCandles(instrumentToken, interval, from, to, continuous = false) {
  const cacheKey = `${instrumentToken}_${interval}_${from}_${to}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.candles;
  }

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
  const candles = raw.map(([date, open, high, low, close, volume]) => ({
    date,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));

  _cache.set(cacheKey, { candles, fetchedAt: Date.now() });
  return candles;
}

/**
 * Fetch the last N candles ending now.
 * Automatically calculates the `from` date based on interval and count.
 */
async function fetchLastNCandles(instrumentToken, interval, count) {
  const now = new Date();
  const to = formatDate(now);

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

  const candles = await fetchCandles(instrumentToken, interval, from, to);
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
