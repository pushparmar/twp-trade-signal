const express = require('express');
const { fetchCandles, fetchLastNCandles } = require('../services/historicalCache');

const router = express.Router();

// GET /api/historical/:token?interval=15minute&from=2024-01-01&to=2024-01-31
router.get('/:token', async (req, res) => {
  const { token } = req.params;
  const { interval = '15minute', from, to, bars } = req.query;

  if (!token) return res.status(400).json({ error: 'instrument token is required' });

  try {
    let candles;
    if (bars) {
      candles = await fetchLastNCandles(Number(token), interval, Number(bars));
    } else {
      if (!from || !to) return res.status(400).json({ error: 'from and to dates are required when bars is not specified' });
      candles = await fetchCandles(Number(token), interval, from, to);
    }
    res.json({ token, interval, count: candles.length, candles });
  } catch (err) {
    const status = err.message.includes('not authenticated') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
