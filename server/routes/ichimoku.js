const express = require('express');
const candleStore = require('../services/candleStore');
const { getSignals, calculate } = require('../services/ichimoku');
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

/**
 * Append 26 future cloud projection bars to the data array.
 *
 * In the standard Ichimoku calculation, senkouA/B for future bar at offset k
 * are sourced from the candle at index (n - 27 + k):
 *   senkouA_proj[k] = ( tenkan[n-27+k]  + kijun[n-27+k] )  / 2
 *   senkouB_proj[k] = ( 52H[n-27+k]    + 52L[n-27+k]   )  / 2
 *
 * These bars have no OHLC — only the cloud values are set.
 */
function _appendProjection(data, candles, results, interval) {
  const n       = candles.length;
  const iSecs   = INTERVAL_SECS[interval] || 900;
  const lastTime = data.length > 0 ? data[data.length - 1].time : 0;
  const round2   = (v) => Math.round(v * 100) / 100;

  for (let k = 1; k <= 26; k++) {
    const srcIdx = n - 27 + k;   // n-26 when k=1, n-1 when k=26
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

    data.push({
      time:    lastTime + k * iSecs,
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

// Synthesize 4h candles by merging four consecutive 1h candles
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
      return res.status(422).json({
        error: `Need at least 52 candles, got ${candles?.length ?? 0}. Try increasing bars or a longer interval.`,
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
