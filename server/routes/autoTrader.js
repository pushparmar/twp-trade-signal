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
  const {
    enabled, riskPerTrade, minProfit, minRR,
    tslEnabled, tslTriggerR, tslDistanceR,
    slViaCandleClose,
  } = req.body;
  const updates = {};

  if (enabled !== undefined) {
    updates.enabled = !!enabled;
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

  if (tslEnabled !== undefined) {
    updates.tslEnabled = !!tslEnabled;
  }

  if (tslTriggerR !== undefined) {
    const v = Number(tslTriggerR);
    if (isNaN(v) || v <= 0) {
      return res.status(400).json({ error: 'tslTriggerR must be a positive number' });
    }
    updates.tslTriggerR = v;
  }

  if (tslDistanceR !== undefined) {
    const v = Number(tslDistanceR);
    if (isNaN(v) || v <= 0) {
      return res.status(400).json({ error: 'tslDistanceR must be a positive number' });
    }
    updates.tslDistanceR = v;
  }

  if (slViaCandleClose !== undefined) {
    if (typeof slViaCandleClose !== 'boolean') {
      return res.status(400).json({ error: 'slViaCandleClose must be boolean' });
    }
    updates.slViaCandleClose = slViaCandleClose;
  }

  const settings = setAutoTraderSettings(updates);
  broadcast('auto_trader_settings', settings);

  const state = settings.enabled ? 'ENABLED' : 'DISABLED';
  console.log(
    `[AutoTrader] Settings updated — ${state}, risk=₹${settings.riskPerTrade},` +
    ` minProfit=₹${settings.minProfit}, minRR=${settings.minRR},` +
    ` tsl=${settings.tslEnabled}, slViaCandleClose=${settings.slViaCandleClose}`,
  );

  res.json(settings);
});

// Clear the intra-day dedup map — also useful after a full system reset
router.post('/clear-dedup', (req, res) => {
  const count = autoTrader.clearDedup();
  res.json({ ok: true, clearedEntries: count });
});

module.exports = router;
