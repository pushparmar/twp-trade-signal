/**
 * routes.js — Index Trade module
 *
 * REST API endpoints for the Index Trade UI tab.
 * Mounted at /api/index-trade/ by the main server.
 */

const express = require('express');
const tradeStore    = require('./tradeStore');
const strikeManager = require('./strikeManager');
const scanner       = require('./scanner');

const router = express.Router();

// GET /api/index-trade/status
router.get('/status', (_req, res) => {
  const config = tradeStore.getConfig();
  res.json({
    enabled: config.enabled,
    subscriptions: strikeManager.getStatus(),
    scanner: scanner.getStats(),
    openCount: tradeStore.getOpenTrades().length,
    totalTrades: tradeStore.getAllTrades().length,
  });
});

// GET /api/index-trade/trades
router.get('/trades', (_req, res) => {
  res.json(tradeStore.getAllTrades());
});

// GET /api/index-trade/trades/open
router.get('/trades/open', (_req, res) => {
  res.json(tradeStore.getOpenTrades());
});

// GET /api/index-trade/trades/history
router.get('/trades/history', (_req, res) => {
  const closed = tradeStore.getClosedTrades()
    .sort((a, b) => (b.closedTs || 0) - (a.closedTs || 0));
  res.json(closed);
});

// GET /api/index-trade/pnl
router.get('/pnl', (_req, res) => {
  res.json(tradeStore.getPnlSummary());
});

// GET /api/index-trade/config
router.get('/config', (_req, res) => {
  res.json(tradeStore.getConfig());
});

// POST /api/index-trade/config
router.post('/config', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be an object' });
  }
  res.json(tradeStore.setConfig(updates));
});

// POST /api/index-trade/trades/:id/close — manual close
router.post('/trades/:id/close', (req, res) => {
  const { exitPrice } = req.body;
  if (!exitPrice) return res.status(400).json({ error: 'exitPrice required' });
  const trade = tradeStore.closeTrade(req.params.id, Number(exitPrice), 'manual');
  if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });
  res.json(trade);
});

// DELETE /api/index-trade/trades — clear all
router.delete('/trades', (_req, res) => {
  tradeStore.clearTrades();
  res.json({ ok: true });
});

// GET /api/index-trade/option-chain
router.get('/option-chain', (_req, res) => {
  res.json(strikeManager.getOptionChain());
});

// POST /api/index-trade/clear-dedup
router.post('/clear-dedup', (_req, res) => {
  scanner.clearDedup();
  res.json({ ok: true });
});

// POST /api/index-trade/refresh-strikes — manually re-resolve ATM strikes + re-subscribe tokens
router.post('/refresh-strikes', async (_req, res) => {
  try {
    await strikeManager.refresh();
    res.json({ ok: true, subscriptions: strikeManager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
