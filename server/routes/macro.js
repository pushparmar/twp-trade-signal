const express = require('express');
const { analyze } = require('../services/macroAnalysis');
const macroWatcher = require('../services/macroWatcher');
const kiteTicker   = require('../services/kiteTicker');

const router = express.Router();

// GET /api/macro/analysis — used for initial page load; live updates via SSE macro_update
router.get('/analysis', async (req, res) => {
  try {
    // Re-ensure macro tokens are subscribed (idempotent — Set semantics).
    // This fixes the boot-time race where macroWatcher.start() can run before
    // the WebSocket has actually connected, leaving macro tokens un-subscribed.
    if (kiteTicker.isConnected()) {
      macroWatcher.ensureSubscribed();
    }
    const data = await analyze();
    res.json(data);
  } catch (err) {
    console.error('[macro/analysis] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
