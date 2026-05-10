const express = require('express');
const candleStore = require('../services/candleStore');
const { getSignals } = require('../services/ichimoku');

const router = express.Router();

// GET /api/ichimoku/:token?interval=15minute&bars=100
// Returns Ichimoku signals at the latest candle.
// Candles come from the ring buffer (seeded once from Kite history, kept live by ticks).
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
    res.json({ token, interval, ...signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
