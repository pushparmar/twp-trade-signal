/**
 * routes/equityScan.js
 *
 * On-demand equity scan API.
 *
 * POST /api/equity-scan/run
 *   Triggers a full NSE equity scan (4H / 1D / 1W).
 *   Non-blocking — returns immediately with { status: 'started'|'cached'|'running' }.
 *   If the scan was already run today the cached status is returned, no re-scan.
 *
 * GET /api/equity-scan/status
 *   Returns current scan state: running, progress, resultCount, cachedToday.
 *
 * GET /api/equity-scan/results
 *   Returns stored results for today (or ?date=YYYY-MM-DD for a previous day).
 *
 * POST /api/equity-scan/rerun
 *   Force re-run even if already cached today (clears in-memory date guard).
 *
 * POST /api/equity-scan/cache-scan
 *   Run a filtered scan on CACHED candles only — zero Kite API calls.
 *   Body: { patternIds?: string[], intervals?: string[] }
 *   Returns results directly (not stored to MongoDB).
 *
 * GET /api/equity-scan/patterns
 *   Returns list of all available patterns for dropdown selection.
 *
 * POST /api/equity-scan/clear-candle-cache
 *   Delete all stored candle history from MongoDB (equity_candle_cache collection).
 *   The next scan run will re-fetch everything from the Kite historical API and
 *   rebuild the cache from scratch.  Useful when candle data looks stale or corrupt.
 */

const express               = require('express');
const equityScan            = require('../services/equityScanService');
const equityCandleCacheRepo = require('../db/repositories/equityCandleCacheRepo');

const router = express.Router();

// ── Trigger scan ──────────────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
  try {
    const result = await equityScan.run();
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /run error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Force re-run (ignores today's cache) ─────────────────────────────────────

router.post('/rerun', async (req, res) => {
  try {
    // Clear in-memory date guard so the next run() ignores today's cache
    equityScan._forceRun();
    const result = await equityScan.run();
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /rerun error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Poll status ───────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  try {
    return res.json(equityScan.getStatus());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Fetch results ─────────────────────────────────────────────────────────────

router.get('/results', async (req, res) => {
  try {
    const { date } = req.query; // optional YYYY-MM-DD
    const results  = await equityScan.getResults(date ?? undefined);
    return res.json(results);
  } catch (err) {
    console.error('[equityScan] /results error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Get universe (all stocks to be scanned) ───────────────────────────────────

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

// ── Cache-only scan (no Kite API calls) ───────────────────────────────────────

router.post('/cache-scan', async (req, res) => {
  try {
    const { patternIds, intervals } = req.body || {};
    const result = await equityScan.runCacheOnly({ patternIds, intervals });
    return res.json(result);
  } catch (err) {
    console.error('[equityScan] /cache-scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Clear candle cache (force full re-fetch on next scan) ─────────────────────

router.post('/clear-candle-cache', async (req, res) => {
  try {
    const deleted = await equityCandleCacheRepo.clearAll();
    // Also reset the in-memory date guard so the next run() doesn't skip
    equityScan._forceRun();
    return res.json({
      ok:      true,
      deleted,
      message: `Cleared ${deleted} candle cache entries. Next scan will re-fetch from Kite.`,
    });
  } catch (err) {
    console.error('[equityScan] /clear-candle-cache error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Trim existing candle cache (reduce storage by ~80-90%) ────────────────────

router.post('/trim-candle-cache', async (req, res) => {
  try {
    const result = await equityCandleCacheRepo.trimExistingCache();
    return res.json({
      ok:      true,
      processed: result.processed,
      trimmed:   result.trimmed,
      savedMB:   (result.savedBytes / 1024 / 1024).toFixed(2),
      message: `Trimmed ${result.trimmed}/${result.processed} cached entries. Saved ~${(result.savedBytes / 1024 / 1024).toFixed(2)} MB.`,
    });
  } catch (err) {
    console.error('[equityScan] /trim-candle-cache error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
