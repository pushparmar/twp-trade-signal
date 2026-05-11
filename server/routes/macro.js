const express = require('express');
const { analyze } = require('../services/macroAnalysis');

const router = express.Router();

// GET /api/macro/analysis — used for initial page load; live updates via SSE macro_update
router.get('/analysis', async (req, res) => {
  try {
    const data = await analyze();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
