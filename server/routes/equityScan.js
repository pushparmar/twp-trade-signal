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
 */

const express     = require('express');
const equityScan  = require('../services/equityScanService');

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

module.exports = router;
