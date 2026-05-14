const express = require('express');
const candleStore = require('../services/candleStore');
const { getSignals } = require('../services/ichimoku');
const atmResolver = require('../services/atmResolver');
const instrumentCache = require('../services/instrumentCache');

const router = express.Router();

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
    // Need 4× the bars in 1h to produce the requested number of 4h candles.
    let candles;
    if (interval === '4h') {
      // Need ≥208 1h candles to synthesise ≥52 4h candles (Ichimoku minimum)
      const need1h = bars ? bars * 4 : 240;
      const candles1h = await candleStore.getCandles(token, '60minute', need1h);
      candles = candles1h && candles1h.length >= 208 ? _to4H(candles1h) : [];
    } else {
      candles = await candleStore.getCandles(token, interval, bars);
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
