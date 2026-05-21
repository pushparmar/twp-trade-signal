const express = require('express');
const candleStore = require('../services/candleStore');
const { getSignals, calculate, to4H, getRSI } = require('../services/ichimoku');
const atmResolver = require('../services/atmResolver');
const instrumentCache = require('../services/instrumentCache');

const router = express.Router();

// ── Interval duration in seconds (for projecting future bar timestamps) ──────
const INTERVAL_SECS = {
  'minute':    60,
  '5minute':   5   * 60,
  '15minute':  15  * 60,
  '30minute':  30  * 60,
  '60minute':  60  * 60,
  '4h':        4   * 60 * 60,
  'day':       6.5 * 60 * 60,  // ~375 min trading day; close enough for display
};

// ── 52-period high/low helpers used for senkouB projection ───────────────────
function _h52(candles, idx) {
  let h = -Infinity;
  for (let j = idx - 51; j <= idx; j++) {
    if (j >= 0 && candles[j] && candles[j].high > h) h = candles[j].high;
  }
  return h === -Infinity ? null : h;
}
function _l52(candles, idx) {
  let l = Infinity;
  for (let j = idx - 51; j <= idx; j++) {
    if (j >= 0 && candles[j] && candles[j].low < l) l = candles[j].low;
  }
  return l === Infinity ? null : l;
}

// ── Market-hours-aware time advance (Indian session) ────────────────────────
//
// NSE/BSE session: 09:15-15:30 IST (Mon-Fri).
// MCX:             09:00-23:30 IST (Mon-Fri).
//
// Cloud projection bars extend 26 bars beyond the last real candle. With a
// naive `lastTime + k * iSecs` formula, those timestamps spill into overnight
// hours and weekends — producing phantom cloud bars on Saturday and Sunday for
// the day chart, and overnight bars (e.g. 20:00 IST) for intraday charts. The
// chart then renders those phantom timestamps as wide empty gaps.
//
// The helper below increments a Unix-seconds timestamp by `intervalSecs` while
// skipping non-trading periods, so the projection lands on the *next* valid
// session bar timestamp.
//
// Default trading window for indices/equities. MCX would use 09:00-23:30 but
// the projection visual is approximate anyway — using NSE bounds is acceptable
// for the chart x-axis and is conservatively narrower (fewer phantom bars).
const IST_OFFSET_MIN = 5 * 60 + 30;
const SESSION_START_MIN = 9 * 60 + 15; // 09:15 IST in minutes from midnight
const SESSION_END_MIN   = 15 * 60 + 30; // 15:30 IST

function _istParts(unixSec) {
  const istMs = unixSec * 1000 + IST_OFFSET_MIN * 60 * 1000;
  const d     = new Date(istMs);
  return {
    weekday: d.getUTCDay(),                       // 0=Sun, 6=Sat (in IST)
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    ymd:     [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()],
  };
}

function _nextTradingTimestamp(prevTs, intervalSecs) {
  // For day bars: advance one calendar day, skip Sat/Sun.
  if (intervalSecs >= 6 * 60 * 60) {
    let next = prevTs + 24 * 60 * 60;
    let p = _istParts(next);
    while (p.weekday === 0 || p.weekday === 6) {
      next += 24 * 60 * 60;
      p = _istParts(next);
    }
    return next;
  }

  // Intraday: advance by intervalSecs; if we cross out of the session window
  // or land on a weekend, jump to the next session's 09:15.
  let next = prevTs + intervalSecs;
  let p    = _istParts(next);

  // If outside session minutes OR on weekend, jump to next trading day 09:15.
  let safety = 0;
  while (p.weekday === 0 || p.weekday === 6 || p.minutes < SESSION_START_MIN || p.minutes >= SESSION_END_MIN) {
    // Jump to start of next day at 09:15 IST and re-check weekend
    const istMs = next * 1000 + IST_OFFSET_MIN * 60 * 1000;
    const d     = new Date(istMs);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCMinutes(SESSION_START_MIN);
    next = Math.floor((d.getTime() - IST_OFFSET_MIN * 60 * 1000) / 1000);
    p = _istParts(next);
    if (++safety > 10) break; // guard against weird intervals (e.g. intervalSecs > 1 day handled above)
  }
  return next;
}

/**
 * Append 26 future cloud projection bars to the data array.
 *
 * In the standard Ichimoku calculation, senkouA/B for future bar at offset k
 * are sourced from the candle at index (n - 27 + k):
 *   senkouA_proj[k] = ( tenkan[n-27+k]  + kijun[n-27+k] )  / 2
 *   senkouB_proj[k] = ( 52H[n-27+k]    + 52L[n-27+k]   )  / 2
 *
 * These bars have no OHLC — only the cloud values are set.
 *
 * Timestamps are market-hours-aware via _nextTradingTimestamp so the chart's
 * x-axis stays inside trading sessions — no phantom Saturday/overnight bars.
 */
function _appendProjection(data, candles, results, interval) {
  const n       = candles.length;
  const iSecs   = INTERVAL_SECS[interval] || 900;
  const round2  = (v) => Math.round(v * 100) / 100;
  let lastTime  = data.length > 0 ? data[data.length - 1].time : 0;

  for (let k = 1; k <= 26; k++) {
    const srcIdx = n - 27 + k;
    if (srcIdx < 0 || srcIdx >= n) continue;

    const src = results[srcIdx];

    const projA = (src.tenkan != null && src.kijun != null)
      ? round2((src.tenkan + src.kijun) / 2)
      : null;

    let projB = null;
    if (srcIdx >= 51) {
      const h = _h52(candles, srcIdx);
      const l = _l52(candles, srcIdx);
      if (h != null && l != null) projB = round2((h + l) / 2);
    }

    // Advance to next valid trading-session timestamp (skips overnight/weekends)
    lastTime = _nextTradingTimestamp(lastTime, iSecs);

    data.push({
      time:    lastTime,
      open:    null,
      high:    null,
      low:     null,
      close:   null,
      tenkan:  null,
      kijun:   null,
      senkouA: projA,
      senkouB: projB,
      chikou:  null,
    });
  }
}

// 4h synthesis: use the session-aware to4H exported from ichimoku.js.
// The old local _to4H grouped from buffer index 0, producing cross-session candles.
const _to4H = to4H;

// Map instrument token → index name for ATM resolution
const TOKEN_TO_INDEX = {
  256265:  'NIFTY',
  260105:  'BANKNIFTY',
  BSE_SENSEX: 'SENSEX',
};

// GET /api/ichimoku/:token/chart?interval=15minute&bars=200
// Returns full Ichimoku calculation array for chart rendering.
// Seeds the candle buffer with 1.5× the requested bars so there is always
// enough headroom for Ichimoku's 52-period look-back plus chart display.
// time is Unix seconds; all indicator values included per candle.
router.get('/:token/chart', async (req, res) => {
  const token = Number(req.params.token);
  if (!token) return res.status(400).json({ error: 'Invalid token' });

  const interval  = req.query.interval || '15minute';
  const bars      = req.query.bars ? Number(req.query.bars) : 200;

  // 1.5× safety factor so the buffer always has more than chart + Ichimoku needs
  const seedBars  = Math.ceil(bars * 1.5);

  try {
    let candles;
    // priority=true so this user-triggered chart request jumps ahead of any
    // background boot-time seeding still draining in the rate-limit queue.
    if (interval === '4h') {
      // Each 4h bar = 4 × 1h candles. Request 1.5× at the 1h level.
      const need1h    = Math.ceil(bars * 4 * 1.5);   // e.g. 200 bars → 1 200 1h candles
      const minNeeded = bars * 4;                     // minimum 1h candles for requested bars
      const candles1h = await candleStore.getCandles(token, '60minute', need1h, true);
      candles = candles1h && candles1h.length >= minNeeded ? _to4H(candles1h) : [];
    } else {
      candles = await candleStore.getCandles(token, interval, seedBars, true);
    }

    if (!candles || candles.length < 52) {
      return res.status(422).json({
        error: `Need at least 52 candles, got ${candles?.length ?? 0}.`,
      });
    }

    const results = calculate(candles);

    // Return only the last `bars` results — the extra seed headroom is discarded
    const slice = results.slice(-bars);

    const data = slice.map((r) => ({
      // Unix seconds — works for both intraday and daily in lightweight-charts
      time:    Math.floor(new Date(r.date).getTime() / 1000),
      open:    r.open,
      high:    r.high,
      low:     r.low,
      close:   r.close,
      tenkan:  r.tenkan  ?? null,
      kijun:   r.kijun   ?? null,
      senkouA: r.senkouA ?? null,
      senkouB: r.senkouB ?? null,
      chikou:  r.chikou  ?? null,
    }));

    // Append 26 future projection bars so the cloud extends ahead of the last candle
    _appendProjection(data, candles, results, interval);

    res.json({ token, interval, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ichimoku/:token/multi-rsi
// Returns Wilder's RSI(14) for all four standard timeframes (15m / 1h / 4h / 1d)
// in a single response.  Reads from the candleStore cache first — if the token
// has been subscribed or recently scanned the values come back with zero Kite API
// calls.  Falls back to a Kite fetch only when the cache is cold.
//
// Response: { '15m': number|null, '1h': number|null, '4h': number|null, '1d': number|null, fetchedAt: ms }
router.get('/:token/multi-rsi', async (req, res) => {
  const token = Number(req.params.token);
  if (!token) return res.status(400).json({ error: 'Invalid token' });

  // Minimum candles required to seed Wilder's RSI (period + 1 warm-up bar).
  const RSI_PERIOD   = 14;
  const RSI_MIN_BARS = RSI_PERIOD + 1;

  // (label → native Kite interval) mapping.
  // 4h is synthesised from 60m candles, matching the chart's own approach.
  const TF_MAP = [
    { label: '15m', interval: '15minute', seed: 60  },
    { label: '1h',  interval: '60minute', seed: 60  },
    { label: '4h',  interval: '4h',       seed: 120 }, // flag for synthesis
    { label: '1d',  interval: 'day',      seed: 60  },
  ];

  const result = { fetchedAt: Date.now() };

  for (const { label, interval, seed } of TF_MAP) {
    try {
      let candles;
      if (interval === '4h') {
        // 4h bars = synthesised from 1h candles (same logic as the chart endpoint)
        const need1h    = seed * 4;
        const candles1h = await candleStore.getCandles(token, '60minute', need1h, true);
        candles = candles1h && candles1h.length >= RSI_MIN_BARS * 4
          ? _to4H(candles1h)
          : [];
      } else {
        candles = await candleStore.getCandles(token, interval, seed, true);
      }

      result[label] = candles && candles.length >= RSI_MIN_BARS
        ? getRSI(candles, RSI_PERIOD)
        : null;
    } catch {
      result[label] = null;
    }
  }

  res.json(result);
});

// GET /api/ichimoku/:token?interval=15minute
// Returns Ichimoku signals. If putBuySignal or callBuySignal fires,
// also resolves and attaches the ATM CE/PE instrument for that index.
router.get('/:token', async (req, res) => {
  const token = Number(req.params.token);
  if (!token) return res.status(400).json({ error: 'Invalid token' });

  const interval = req.query.interval || '15minute';
  const bars     = req.query.bars ? Number(req.query.bars) : undefined;

  try {
    // 4h is not a native Kite interval — synthesise from 1h candles.
    // All paths use 1.5× seed so the buffer always covers Ichimoku's look-back.
    const reqBars  = bars ?? 100;
    const seedBars = Math.ceil(reqBars * 1.5);
    let candles;
    // priority=true — user-triggered signal fetch; jumps ahead of background seeding
    if (interval === '4h') {
      const need1h    = Math.ceil(reqBars * 4 * 1.5);
      const minNeeded = reqBars * 4;
      const candles1h = await candleStore.getCandles(token, '60minute', need1h, true);
      candles = candles1h && candles1h.length >= minNeeded ? _to4H(candles1h) : [];
    } else {
      candles = await candleStore.getCandles(token, interval, seedBars, true);
    }

    // getSignals() requires at minimum 52 candles (Senkou Span B needs 52 periods)
    if (!candles || candles.length < 52) {
      const { kite } = require('../store').getConfig();
      const notAuth = !kite.accessToken;
      return res.status(422).json({
        error: notAuth
          ? 'Kite session expired — please re-login via Settings to refresh the access token.'
          : `Need at least 52 candles, got ${candles?.length ?? 0}. The futures contract may have expired — try re-running the screener.`,
      });
    }

    const signals = getSignals(candles, interval);

    if (!signals) {
      return res.status(422).json({ error: 'Ichimoku signals could not be computed — insufficient candle data.' });
    }

    // Resolve ATM option when a signal fires
    let atmOption = null;
    const indexName = TOKEN_TO_INDEX[token]
      || instrumentCache.getByToken(token)?.name?.toUpperCase();

    if ((signals.putBuySignal || signals.callBuySignal) && indexName) {
      const optionType = signals.putBuySignal ? 'PE' : 'CE';
      try {
        atmOption = await atmResolver.resolve(indexName, optionType);
      } catch (e) {
        console.warn(`[Ichimoku] ATM resolve failed for ${indexName} ${optionType}:`, e.message);
        atmOption = { error: e.message };
      }
    }

    res.json({ token, interval, ...signals, atmOption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
