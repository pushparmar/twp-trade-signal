/**
 * Kumo Breakout dedicated scanner route.
 *
 * GET  /api/kumo-breakout/scan/:interval — Run kumo-breakout for a single timeframe
 * GET  /api/kumo-breakout/results        — Load cached results from DB (all intervals)
 * GET  /api/kumo-breakout/status         — Scheduler status (next scan times)
 * POST /api/kumo-breakout/start          — Start the scheduled scanner
 * POST /api/kumo-breakout/stop           — Stop the scheduled scanner
 * POST /api/kumo-breakout/run-all        — Trigger full scan (all intervals in parallel)
 * GET  /api/kumo-breakout/universe       — Instrument counts
 *
 * This is a simplified, purpose-built endpoint that returns all kumo breakout
 * signals in one call, grouped by timeframe for easy UI rendering.
 */

const express          = require('express');
const candleStore      = require('../services/candleStore');
const patternRegistry  = require('../services/patternRegistry');
const instrumentCache  = require('../services/instrumentCache');
const foStockRegistry  = require('../services/foStockRegistry');
const { to4H, getFutureCloudColor } = require('../services/ichimoku');
const { VIX_TOKEN, getFrontMonthFutures } = require('../services/macroAnalysis');
const store            = require('../store');
const kumoBreakoutService = require('../services/kumoBreakoutService');

const router = express.Router();

const INTERVALS = ['15minute', '60minute', '4h', 'day'];
const TF_LABEL  = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };
const SCAN_BARS = { '15minute': 100, '60minute': 450, 'day': 150 };

/**
 * Build the full scan universe: indices + MCX macros + all F&O stocks
 */
function _buildUniverse() {
  const universe = [];
  const seen = new Set();

  // Indices
  const indices = [
    { instrumentToken: 256265,   tradingsymbol: 'NIFTY 50',   exchange: 'NSE', name: 'NIFTY 50',   category: 'index' },
    { instrumentToken: 260105,   tradingsymbol: 'NIFTY BANK', exchange: 'NSE', name: 'NIFTY BANK', category: 'index' },
    { instrumentToken: VIX_TOKEN, tradingsymbol: 'INDIA VIX', exchange: 'NSE', name: 'India VIX',  category: 'index' },
  ];
  for (const i of indices) {
    universe.push(i);
    seen.add(i.instrumentToken);
  }

  // MCX macros
  const mcxMacros = [
    ['CRUDEOIL',   'Crude Oil'],
    ['GOLD',       'Gold'],
    ['SILVER',     'Silver'],
    ['NATURALGAS', 'Natural Gas'],
  ];
  for (const [symbol, label] of mcxMacros) {
    try {
      const inst = getFrontMonthFutures(symbol, 'MCX');
      if (inst && !seen.has(inst.instrumentToken)) {
        universe.push({
          instrumentToken: inst.instrumentToken,
          tradingsymbol:   inst.tradingsymbol,
          exchange:        'MCX',
          name:            label,
          category:        'commodity',
        });
        seen.add(inst.instrumentToken);
      }
    } catch { /* instrumentCache not ready */ }
  }

  // F&O stocks from registry
  const foStocks = foStockRegistry.getAll();
  for (const s of foStocks) {
    if (!seen.has(s.instrumentToken)) {
      universe.push({ ...s, category: 'stock' });
      seen.add(s.instrumentToken);
    }
  }

  return universe;
}

/**
 * Fetch candles for a token+interval, synthesising 4h from 1h when needed.
 */
async function _getCandles(token, interval) {
  if (interval === '4h') {
    const c1h = await candleStore.getCandles(token, '60minute', SCAN_BARS['60minute']);
    return c1h && c1h.length >= 8 ? to4H(c1h).filter(c => !c.partial) : null;
  }
  return candleStore.getCandles(token, interval, SCAN_BARS[interval] ?? 100);
}

/**
 * Compute Kijun-based directional bias for MTF alignment.
 */
function _computeBias(candles) {
  if (!candles || candles.length < 26) return 'neutral';
  const n = candles.length;
  const close = candles[n - 1].close;
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 26; i < n; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low  < lo) lo = candles[i].low;
  }
  const kijun = (hi + lo) / 2;
  if (close > kijun) return 'bullish';
  if (close < kijun) return 'bearish';
  return 'neutral';
}

// ── GET /api/kumo-breakout/scan/:interval ─────────────────────────────────────
// Scan a single timeframe — called in parallel by the frontend.
// interval: '15minute' | '60minute' | '4h' | 'day'
router.get('/scan/:interval', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const interval = req.params.interval;
  if (!INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `Invalid interval: ${interval}. Use: ${INTERVALS.join(', ')}` });
  }

  const pattern = patternRegistry.get('kumo-breakout');
  if (!pattern) {
    return res.status(500).json({ error: 'kumo-breakout pattern not found in registry' });
  }

  const universe = _buildUniverse();
  const tfLabel = TF_LABEL[interval];
  console.log(`[KumoBreakout] Scanning ${tfLabel} — ${universe.length} instruments`);

  const matches = [];
  let scannedCount = 0;

  // Process in batches to avoid overwhelming Kite API
  const BATCH_SIZE = 10;
  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (inst) => {
      let candles;
      try {
        candles = await _getCandles(inst.instrumentToken, interval);
      } catch {
        return null;
      }

      if (!candles || candles.length < 52) return null;
      scannedCount++;

      let result;
      try {
        result = pattern.run(candles, { ...pattern.defaultOpts, interval });
      } catch {
        return null;
      }

      if (!result?.matched || !result.signal) return null;

      let futureCloudColor = null;
      try {
        futureCloudColor = getFutureCloudColor(candles);
      } catch {}

      return {
        token:        inst.instrumentToken,
        symbol:       inst.tradingsymbol,
        name:         inst.name || inst.tradingsymbol,
        exchange:     inst.exchange,
        category:     inst.category || 'stock',
        interval,
        tfLabel,
        signal:       result.signal,
        score:        result.score ?? null,
        close:        result.close,
        sl:           result.sl,
        target:       result.target,
        rrRatio:      result.sl && result.target && result.close
                        ? Math.abs(result.target - result.close) / Math.abs(result.close - result.sl)
                        : null,
        cloudTop:     result.cloudTop,
        cloudBottom:  result.cloudBottom,
        cloudWidth:   result.cloudWidth,
        tenkan:       result.tenkan,
        kijun:        result.kijun,
        chikou:       result.chikou,
        atr:          result.atr,
        futureCloudColor,
        ts:           Date.now(),
      };
    });

    const batchResults = await Promise.all(batchPromises);
    matches.push(...batchResults.filter(Boolean));
  }

  // Sort by score descending
  matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  console.log(`[KumoBreakout] ${tfLabel} complete — ${matches.length} matches (${scannedCount} scanned)`);

  res.json({
    interval,
    tfLabel,
    scannedCount,
    totalInstruments: universe.length,
    matches,
    ts: Date.now(),
  });
});

// ── GET /api/kumo-breakout/universe ───────────────────────────────────────────
router.get('/universe', (req, res) => {
  const universe = _buildUniverse();
  const byCategory = {
    index:     universe.filter(u => u.category === 'index').length,
    commodity: universe.filter(u => u.category === 'commodity').length,
    stock:     universe.filter(u => u.category === 'stock').length,
  };
  res.json({ total: universe.length, ...byCategory });
});

// ── GET /api/kumo-breakout/results ────────────────────────────────────────────
// Load today's cached scan results from DB for all intervals.
router.get('/results', async (req, res) => {
  try {
    const cached = await kumoBreakoutService.getCachedResults();
    res.json(cached);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/kumo-breakout/status ─────────────────────────────────────────────
// Scheduler status: running, next scan times, last scan times.
router.get('/status', (req, res) => {
  res.json(kumoBreakoutService.getStatus());
});

// ── POST /api/kumo-breakout/start ─────────────────────────────────────────────
// Start the scheduled scanner.
router.post('/start', async (req, res) => {
  try {
    await kumoBreakoutService.start();
    res.json({ success: true, status: kumoBreakoutService.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/kumo-breakout/stop ──────────────────────────────────────────────
// Stop the scheduled scanner.
router.post('/stop', (req, res) => {
  kumoBreakoutService.stop();
  res.json({ success: true, status: kumoBreakoutService.getStatus() });
});

// ── POST /api/kumo-breakout/run-all ───────────────────────────────────────────
// Trigger a full scan of all intervals in parallel.
router.post('/run-all', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const results = await kumoBreakoutService.runAllScans();
    const summary = {};
    for (const r of results) {
      summary[r.tfLabel] = { matchCount: r.matches.length, scannedCount: r.scannedCount };
    }
    res.json({ success: true, summary, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/kumo-breakout/run/:interval ─────────────────────────────────────
// Trigger a single interval scan.
router.post('/run/:interval', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  const { interval } = req.params;
  try {
    const result = await kumoBreakoutService.runSingleScan(interval);
    if (!result) {
      return res.status(404).json({ error: 'Scan returned no results or interval invalid' });
    }
    res.json({
      success: true,
      interval: result.interval,
      tfLabel: result.tfLabel,
      matchCount: result.matches.length,
      scannedCount: result.scannedCount,
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
