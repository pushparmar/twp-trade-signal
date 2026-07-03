/**
 * Kumo Breakout dedicated scanner route.
 *
 * GET  /api/kumo-breakout/scan   — Run kumo-breakout on stocks, indices, and F&O
 *                                  across 15m, 1h, 4h, and daily timeframes.
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

// ── GET /api/kumo-breakout/scan ───────────────────────────────────────────────
router.get('/scan', async (req, res) => {
  // Disable timeout for long scans
  req.setTimeout(0);
  res.setTimeout(0);

  const pattern = patternRegistry.get('kumo-breakout');
  if (!pattern) {
    return res.status(500).json({ error: 'kumo-breakout pattern not found in registry' });
  }

  const universe = _buildUniverse();
  console.log(`[KumoBreakout] Scanning ${universe.length} instruments × ${INTERVALS.length} intervals`);

  const results = {
    '15m': [],
    '1h':  [],
    '4h':  [],
    '1d':  [],
  };
  const biasMap = new Map(); // token → { interval → bias }

  let scannedCount = 0;

  for (const inst of universe) {
    const tokenBias = {};

    for (const interval of INTERVALS) {
      const tfLabel = TF_LABEL[interval];
      let candles;
      try {
        candles = await _getCandles(inst.instrumentToken, interval);
      } catch (err) {
        continue;
      }

      if (!candles || candles.length < 52) continue;
      scannedCount++;

      // Store bias for MTF alignment
      const bias = _computeBias(candles);
      tokenBias[interval] = bias;

      // Run kumo-breakout pattern
      let result;
      try {
        result = pattern.run(candles, { ...pattern.defaultOpts, interval });
      } catch {
        continue;
      }

      if (!result?.matched || !result.signal) continue;

      // Compute MTF alignment
      const alignedTfs = [];
      for (const [iv, b] of Object.entries(tokenBias)) {
        if (iv !== interval && b === result.signal) {
          alignedTfs.push(TF_LABEL[iv]);
        }
      }

      // Get future cloud color
      let futureCloudColor = null;
      try {
        futureCloudColor = getFutureCloudColor(candles);
      } catch {}

      const match = {
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
        mtfAligned:   alignedTfs.length > 0,
        alignedTfs,
        ts:           Date.now(),
      };

      results[tfLabel].push(match);
    }

    biasMap.set(inst.instrumentToken, tokenBias);
  }

  // Sort each TF by score descending
  for (const tf of Object.keys(results)) {
    results[tf].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  console.log(
    `[KumoBreakout] Scan complete — ` +
    `15m:${results['15m'].length} 1h:${results['1h'].length} ` +
    `4h:${results['4h'].length} 1d:${results['1d'].length} ` +
    `(${scannedCount} pairs scanned)`,
  );

  res.json({
    scannedCount,
    totalInstruments: universe.length,
    results,
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

module.exports = router;
