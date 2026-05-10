const express = require('express');
const candleStore = require('../services/candleStore');

const router = express.Router();
const VIX_TOKEN = 264969; // NSE:INDIA VIX

// Aggregate 60minute candles into 4-hour bars
function _to4H(candles1h) {
  const out = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const slice = candles1h.slice(i, i + 4);
    out.push({
      date:   slice[0].date,
      open:   slice[0].open,
      high:   Math.max(...slice.map((c) => c.high)),
      low:    Math.min(...slice.map((c) => c.low)),
      close:  slice[slice.length - 1].close,
    });
  }
  return out;
}

function _sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function _analyze(candles, label) {
  if (!candles || candles.length < 5) return null;

  const closes  = candles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];
  const ma10    = _sma(closes, Math.min(10, closes.length));
  const change  = Math.round((current - prev) * 100) / 100;

  const trend = ma10 == null ? 'flat'
    : current > ma10 * 1.005 ? 'rising'
    : current < ma10 * 0.995 ? 'falling'
    : 'flat';

  const zone = current < 13 ? 'complacency'
    : current < 16 ? 'calm'
    : current < 20 ? 'normal'
    : current < 25 ? 'elevated'
    : current < 30 ? 'fear'
    : 'extreme';

  // VIX falling = market calm = bullish; rising = fear = bearish
  const signal = trend === 'falling' ? 'bullish'
    : trend === 'rising' ? 'bearish'
    : 'neutral';

  return {
    label,
    current: Math.round(current * 100) / 100,
    change,
    trend,
    zone,
    signal,
    ma10: ma10 != null ? Math.round(ma10 * 100) / 100 : null,
  };
}

// GET /api/vix/analysis
router.get('/analysis', async (req, res) => {
  try {
    const timeframes = [];

    // 15m
    const c15m = await candleStore.getCandles(VIX_TOKEN, '15minute');
    const a15m = _analyze(c15m, '15m');
    if (a15m) timeframes.push({ key: '15m', ...a15m });

    // 1h
    const c1h = await candleStore.getCandles(VIX_TOKEN, '60minute');
    const a1h = _analyze(c1h, '1h');
    if (a1h) timeframes.push({ key: '1h', ...a1h });

    // 4h — aggregate from 1h
    if (c1h && c1h.length >= 8) {
      const c4h = _to4H(c1h);
      const a4h = _analyze(c4h, '4h');
      if (a4h) timeframes.push({ key: '4h', ...a4h });
    }

    // 1d
    const c1d = await candleStore.getCandles(VIX_TOKEN, 'day');
    const a1d = _analyze(c1d, '1d');
    if (a1d) timeframes.push({ key: '1d', ...a1d });

    // Overall direction — majority vote across timeframes
    const bullCount = timeframes.filter((t) => t.signal === 'bullish').length;
    const bearCount = timeframes.filter((t) => t.signal === 'bearish').length;
    const direction = bullCount > bearCount ? 'bullish'
      : bearCount > bullCount ? 'bearish'
      : 'neutral';
    const confidence = timeframes.length > 0
      ? Math.round((Math.max(bullCount, bearCount) / timeframes.length) * 100)
      : 0;

    // Current VIX from daily or best available
    const currentVix = (a1d || a1h || a15m)?.current ?? null;

    res.json({ direction, confidence, currentVix, timeframes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
