const express = require('express');
const candleStore = require('../services/candleStore');
const { getSignals } = require('../services/ichimoku');
const atmResolver = require('../services/atmResolver');
const instrumentCache = require('../services/instrumentCache');

const router = express.Router();

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

  try {
    const candles = await candleStore.getCandles(token, interval);
    if (!candles || candles.length < 52) {
      return res.status(422).json({
        error: `Need at least 52 candles, got ${candles?.length ?? 0}. Try increasing bars or a longer interval.`,
      });
    }

    const signals = getSignals(candles, interval);

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
