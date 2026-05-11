const express = require('express');
const { fetchCandles, fetchLastNCandles } = require('../services/historicalCache');

const router = express.Router();

// H4 — strict allowlist for interval values
const VALID_INTERVALS = new Set([
  'minute', '3minute', '5minute', '10minute', '15minute',
  '30minute', '60minute', 'day',
]);

// H5 — date must match YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

// M7 — cap bars to prevent large Kite API requests
const MAX_BARS = 500;

// GET /api/historical/:token?interval=15minute&from=2024-01-01&to=2024-01-31
// GET /api/historical/:token?interval=15minute&bars=100
router.get('/:token', async (req, res) => {
  const token = Number(req.params.token);
  if (!token || !Number.isInteger(token)) {
    return res.status(400).json({ error: 'instrument token must be a valid integer' });
  }

  const { interval = '15minute', from, to, bars } = req.query;

  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ error: `invalid interval — allowed: ${[...VALID_INTERVALS].join(', ')}` });
  }

  try {
    let candles;
    if (bars !== undefined) {
      const n = Math.min(Math.max(1, Number(bars) || 0), MAX_BARS);
      candles = await fetchLastNCandles(token, interval, n);
    } else {
      if (!from || !to) {
        return res.status(400).json({ error: 'from and to dates are required when bars is not specified' });
      }
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return res.status(400).json({ error: 'from and to must be in YYYY-MM-DD or YYYY-MM-DD HH:MM:SS format' });
      }
      candles = await fetchCandles(token, interval, from, to);
    }
    res.json({ token, interval, count: candles.length, candles });
  } catch (err) {
    const status = err.message.includes('not authenticated') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
