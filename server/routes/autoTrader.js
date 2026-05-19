/**
 * Auto-trader settings routes.
 *
 * GET  /api/auto-trader/settings  — fetch current settings
 * POST /api/auto-trader/settings  — update enabled / riskPerTrade / minProfit
 */

const express   = require('express');
const { broadcast } = require('../sseHub');
const { getAutoTraderSettings, setAutoTraderSettings } = require('../store');
const autoTrader = require('../services/autoTrader');

const router = express.Router();

router.get('/settings', (req, res) => {
  res.json(getAutoTraderSettings());
});

router.post('/settings', (req, res) => {
  const { enabled, riskPerTrade, minProfit, tradingMode, sizingMode, minRR } = req.body;
  const updates = {};

  if (enabled !== undefined) {
    updates.enabled = !!enabled;
  }

  if (tradingMode !== undefined) {
    if (!['futures', 'options'].includes(tradingMode)) {
      return res.status(400).json({ error: 'tradingMode must be "futures" or "options"' });
    }
    updates.tradingMode = tradingMode;
  }

  if (sizingMode !== undefined) {
    if (!['risk', 'fixed'].includes(sizingMode)) {
      return res.status(400).json({ error: 'sizingMode must be "risk" or "fixed"' });
    }
    updates.sizingMode = sizingMode;
  }

  if (riskPerTrade !== undefined) {
    const r = Number(riskPerTrade);
    if (isNaN(r) || r <= 0) {
      return res.status(400).json({ error: 'riskPerTrade must be a positive number' });
    }
    updates.riskPerTrade = r;
  }

  if (minProfit !== undefined) {
    const m = Number(minProfit);
    if (isNaN(m) || m <= 0) {
      return res.status(400).json({ error: 'minProfit must be a positive number' });
    }
    updates.minProfit = m;
  }

  if (minRR !== undefined) {
    const rr = Number(minRR);
    if (isNaN(rr) || rr <= 0) {
      return res.status(400).json({ error: 'minRR must be a positive number' });
    }
    updates.minRR = rr;
  }

  const settings = setAutoTraderSettings(updates);
  broadcast('auto_trader_settings', settings);

  const state = settings.enabled ? 'ENABLED' : 'DISABLED';
  console.log(`[AutoTrader] Settings updated — ${state}, mode=${settings.tradingMode}, sizing=${settings.sizingMode}, risk=₹${settings.riskPerTrade}`);

  res.json(settings);
});

// Clear the intra-day dedup map — also useful after a full system reset
router.post('/clear-dedup', (req, res) => {
  const count = autoTrader.clearDedup();
  res.json({ ok: true, clearedEntries: count });
});

module.exports = router;
