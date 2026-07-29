/**
 * Phase-2 API routes.
 *
 * GET  /api/phase2/strikes   — current strike universe (grouped metadata included)
 * GET  /api/phase2/results   — latest in-memory scan results per interval
 * GET  /api/phase2/status    — scheduler status (running, last/next scan per TF)
 * POST /api/phase2/start     — start the auto-scan scheduler
 * POST /api/phase2/stop      — stop the auto-scan scheduler
 * POST /api/phase2/run       — trigger a full scan of all intervals now
 */

const express = require('express');
const strikeUniverse = require('../phase2/strikeUniverse');
const scanService = require('../phase2/scanService');

const router = express.Router();

router.get('/strikes', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const universe = await strikeUniverse.getUniverse(force);
    res.json(universe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/results', (_req, res) => {
  res.json(scanService.getResults());
});

router.get('/status', (_req, res) => {
  res.json(scanService.getStatus());
});

router.post('/start', (_req, res) => {
  scanService.start();
  res.json({ ok: true, status: scanService.getStatus() });
});

router.post('/stop', (_req, res) => {
  scanService.stop();
  res.json({ ok: true, status: scanService.getStatus() });
});

router.post('/run', async (_req, res) => {
  try {
    const results = await scanService.runAll();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
