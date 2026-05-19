/**
 * Backtest routes.
 *
 * POST /api/backtest/run     — execute a backtest synchronously and return the full report
 * GET  /api/backtest/scopes  — list available instrument scopes (watchlist + foStockRegistry size)
 */

const express      = require('express');
const backtester   = require('../services/backtester');
const patternRegistry = require('../services/patternRegistry');
const store        = require('../store');
const foStockRegistry = require('../services/foStockRegistry');
const { VIX_TOKEN, getFrontMonthFutures } = require('../services/macroAnalysis');

const router = express.Router();

const VALID_INTERVALS = ['15minute', '60minute', '4h', 'day'];

// Build the macro+indices universe (same as scan route) — used when scope='macros'
function _macroAndIndexInstruments() {
  const list = [
    { instrumentToken: 256265, tradingsymbol: 'NIFTY 50',   exchange: 'NSE', name: 'NIFTY 50'   },
    { instrumentToken: 260105, tradingsymbol: 'NIFTY BANK', exchange: 'NSE', name: 'NIFTY BANK' },
    { instrumentToken: VIX_TOKEN, tradingsymbol: 'INDIA VIX', exchange: 'NSE', name: 'India VIX' },
  ];
  const macros = [
    ['CRUDEOIL', 'MCX', 'Crude Oil'],
    ['GOLD',     'MCX', 'Gold'],
    ['SILVER',   'MCX', 'Silver'],
    ['USDINR',   'CDS', 'USD/INR'],
  ];
  for (const [symbol, exchange, label] of macros) {
    try {
      const inst = getFrontMonthFutures(symbol, exchange);
      if (inst) {
        list.push({
          instrumentToken: inst.instrumentToken,
          tradingsymbol:   inst.tradingsymbol,
          exchange:        inst.exchange,
          name:            label,
        });
      }
    } catch { /* instrument cache not ready */ }
  }
  return list;
}

/**
 * GET /api/backtest/scopes
 * Returns the available instrument universes and their sizes so the client
 * can show counts in the scope dropdown.
 */
router.get('/scopes', (req, res) => {
  const watchlist = store.getWatchlist();
  const macros    = _macroAndIndexInstruments();
  const futures   = foStockRegistry.getAll();
  res.json({
    scopes: [
      { id: 'watchlist', label: `Watchlist (${watchlist.length})`, count: watchlist.length },
      { id: 'macros',    label: `Macros + Indices (${macros.length})`, count: macros.length },
      { id: 'all',       label: `All F&O Stocks (${futures.length})`,  count: futures.length },
    ],
    patterns:  patternRegistry.list(),
    intervals: VALID_INTERVALS,
  });
});

/**
 * POST /api/backtest/run
 * Body: {
 *   patternIds: string[] | 'all',
 *   interval:   string,
 *   fromDate:   'YYYY-MM-DD',
 *   toDate:     'YYYY-MM-DD',
 *   scope:      'watchlist' | 'macros' | 'all' | 'custom',
 *   tokens?:    number[]   (required when scope='custom')
 *   minRR?:     number     (default 2.0)
 * }
 *
 * Returns the full report (see backtester._buildReport for shape).
 * Runs synchronously — disable timeouts because large backtests can take 30-60s.
 */
router.post('/run', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const {
    patternIds = 'all',
    interval   = 'day',
    fromDate,
    toDate,
    scope      = 'watchlist',
    tokens,
    minRR      = 2.0,
    scanMode   = 'closed',
  } = req.body;

  // Input validation
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate (YYYY-MM-DD) are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ error: 'fromDate / toDate must be YYYY-MM-DD' });
  }
  if (!VALID_INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${VALID_INTERVALS.join(', ')}` });
  }
  if (!['closed', 'spot'].includes(scanMode)) {
    return res.status(400).json({ error: 'scanMode must be "closed" or "spot"' });
  }

  // Build instrument universe
  let instruments;
  if (scope === 'watchlist') {
    instruments = store.getWatchlist().map((w) => ({
      instrumentToken: w.instrumentToken,
      tradingsymbol:   w.tradingsymbol,
      name:            w.name || w.tradingsymbol,
    }));
  } else if (scope === 'macros') {
    instruments = _macroAndIndexInstruments();
  } else if (scope === 'all') {
    instruments = foStockRegistry.getAll();
  } else if (scope === 'custom') {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: 'scope=custom requires tokens: number[]' });
    }
    // Resolve tokens from foStockRegistry + watchlist + macros for display names
    const reg     = new Map(foStockRegistry.getAll().map((i) => [Number(i.instrumentToken), i]));
    const watch   = new Map(store.getWatchlist().map((i) => [Number(i.instrumentToken), i]));
    const macros  = new Map(_macroAndIndexInstruments().map((i) => [Number(i.instrumentToken), i]));
    instruments = tokens.map((t) => {
      const n = Number(t);
      return reg.get(n) || watch.get(n) || macros.get(n)
        || { instrumentToken: n, tradingsymbol: String(n), name: String(n) };
    });
  } else {
    return res.status(400).json({ error: `Unknown scope: ${scope}` });
  }

  if (!instruments.length) {
    return res.status(400).json({ error: `No instruments resolved for scope=${scope}` });
  }

  try {
    const report = await backtester.runBacktest({
      instruments,
      patternIds,
      interval,
      fromDate,
      toDate,
      minRR: Number(minRR),
      scanMode,
    });
    res.json(report);
  } catch (err) {
    console.error('[Backtest] route error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
