/**
 * routes/equityScan.js
 *
 * Equity scan API:
 *
 * GET /api/equity-scan/results
 *   Returns cached scan results for today (or ?date=YYYY-MM-DD).
 *   This is the main endpoint — UI just reads cached results.
 *
 * GET /api/equity-scan/status
 *   Returns: { scanDate, hasResults, resultCount, running, phase }
 *
 * POST /api/equity-scan/run
 *   Run patterns on EXISTING cached candles (no Kite API call).
 *   Returns cached status if already scanned today.
 *
 * POST /api/equity-scan/rerun
 *   Force re-run patterns (bypass today's cache check, no Kite API).
 *
 * POST /api/equity-scan/update-candles
 *   Fetch fresh candles from Kite API + run patterns.
 *   This is the FULL refresh — calls Kite API.
 *   Normally done by scheduler at 11:55 PM IST.
 *
 * GET /api/equity-scan/universe
 *   Returns stock counts (NSE, BSE, F&O, non-F&O).
 *
 * GET /api/equity-scan/patterns
 *   Returns list of available patterns for filter dropdown.
 *
 * POST /api/equity-scan/clear-candle-cache
 *   Delete candle history — next update-candles re-fetches everything.
 *
 * POST /api/equity-scan/clear-scan-results
 *   Delete scan results — next scan regenerates patterns.
 */

const express               = require('express');
const equityScan            = require('../services/equityScanService');
const equityCandleCacheRepo = require('../db/repositories/equityCandleCacheRepo');
const equityScanRepo        = require('../db/repositories/equityScanRepo');

const router = express.Router();

// ── Main endpoint: Get cached results ─────────────────────────────────────────

router.get('/results', async (req, res) => {
  try {
    const { date } = req.query; // optional YYYY-MM-DD
    const results = await equityScan.getResults(date ?? undefined);
    return res.json(results);
  } catch (err) {
    console.error('[equityScan] /results error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Status check ──────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const status = await equityScan.getStatus();
    const progress = equityScan.getScanProgress();
    return res.json({ ...status, ...progress });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Run patterns on cached candles (no Kite API) ──────────────────────────────

router.post('/run', async (req, res) => {
  try {
    const result = await equityScan.run();
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Force re-run patterns (no Kite API) ───────────────────────────────────────

router.post('/rerun', async (req, res) => {
  try {
    const result = await equityScan.rerun();
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /rerun error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Update candles from Kite + run patterns (full refresh) ────────────────────

router.post('/update-candles', async (req, res) => {
  try {
    const result = await equityScan.fullRefresh();
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /update-candles error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Get universe (stock counts) ───────────────────────────────────────────────

router.get('/universe', (req, res) => {
  try {
    const universe = equityScan.getUniverse();
    return res.json(universe);
  } catch (err) {
    console.error('[equityScan] /universe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Get available patterns for dropdown ───────────────────────────────────────

router.get('/patterns', (req, res) => {
  try {
    const patterns = equityScan.getPatternList();
    return res.json(patterns);
  } catch (err) {
    console.error('[equityScan] /patterns error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Debug: Check candle cache status ──────────────────────────────────────────

router.get('/cache-status', async (req, res) => {
  try {
    const cachedCandles = await equityCandleCacheRepo.loadAll(['60minute', 'day']);

    let count60 = 0, countDay = 0;
    let sample60 = null, sampleDay = null;

    for (const [key, val] of cachedCandles.entries()) {
      if (key.endsWith(':60minute')) {
        count60++;
        if (!sample60 && val.candles) sample60 = { key, bars: val.candles.length };
      } else if (key.endsWith(':day')) {
        countDay++;
        if (!sampleDay && val.candles) sampleDay = { key, bars: val.candles.length };
      }
    }

    return res.json({
      totalEntries: cachedCandles.size,
      count60minute: count60,
      countDay: countDay,
      sample60minute: sample60,
      sampleDay: sampleDay,
      message: count60 === 0 ? 'No 60minute candles cached! Click "Update Candles" to fetch from Kite.' : 'Cache OK'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Clear candle cache ────────────────────────────────────────────────────────

router.post('/clear-candle-cache', async (req, res) => {
  try {
    const deleted = await equityCandleCacheRepo.clearAll();
    return res.json({
      ok: true,
      deleted,
      message: `Cleared ${deleted} candle entries. Next scan will re-fetch from Kite.`,
    });
  } catch (err) {
    console.error('[equityScan] /clear-candle-cache error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Clear scan results ────────────────────────────────────────────────────────

router.post('/clear-scan-results', async (req, res) => {
  try {
    const deleted = await equityScanRepo.clearAll();
    return res.json({
      ok: true,
      deleted,
      message: `Cleared ${deleted} scan results. Next scan will regenerate.`,
    });
  } catch (err) {
    console.error('[equityScan] /clear-scan-results error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
