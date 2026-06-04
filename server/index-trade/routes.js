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
const db            = require('../db');

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

// GET /api/index-trade/alerts — recent scan alerts (survives page refresh)
router.get('/alerts', (_req, res) => {
  res.json(scanner.getAlertHistory());
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

// ── Analytics endpoints (MongoDB-backed) ─────────────────────────────────────

// GET /api/index-trade/analytics/daily-pnl
// Query params: fromDate, toDate, index (NIFTY/BANKNIFTY), strategyType (pattern/low-premium)
router.get('/analytics/daily-pnl', async (req, res) => {
  try {
    const opts = {};
    if (req.query.fromDate) opts.fromDate = new Date(req.query.fromDate);
    if (req.query.toDate)   opts.toDate   = new Date(req.query.toDate);
    if (req.query.index)    opts.index    = req.query.index;
    if (req.query.strategyType) opts.strategyType = req.query.strategyType;

    const result = await db.indexTradeRepo.dailyPnl(opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/pattern-win-rate
// Query params: index (NIFTY/BANKNIFTY), strategyType (pattern/low-premium)
router.get('/analytics/pattern-win-rate', async (req, res) => {
  try {
    const opts = {};
    if (req.query.index) opts.index = req.query.index;
    if (req.query.strategyType) opts.strategyType = req.query.strategyType;

    const result = await db.indexTradeRepo.patternWinRate(opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/strategy-performance
// Compare pattern vs low-premium strategy performance
// Query params: index (NIFTY/BANKNIFTY), fromDate, toDate
router.get('/analytics/strategy-performance', async (req, res) => {
  try {
    const opts = {};
    if (req.query.index)    opts.index    = req.query.index;
    if (req.query.fromDate) opts.fromDate = new Date(req.query.fromDate);
    if (req.query.toDate)   opts.toDate   = new Date(req.query.toDate);

    const result = await db.indexTradeRepo.strategyPerformance(opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/cumulative-pnl
router.get('/analytics/cumulative-pnl', async (_req, res) => {
  try {
    const total = await db.indexTradeRepo.getCumulativePnl();
    res.json({ cumulativePnl: total ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/trading-dates
router.get('/analytics/trading-dates', async (_req, res) => {
  try {
    const dates = await db.indexTradeRepo.getTradingDates();
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/by-date/:date
// Fetch all trades for a specific IST date (YYYY-MM-DD)
router.get('/analytics/by-date/:date', async (req, res) => {
  try {
    const trades = await db.indexTradeRepo.getByDate(req.params.date);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/recent-trades
// Fetch recent trades from MongoDB (includes closed trades beyond today)
// Query params: limit (default 200)
router.get('/analytics/recent-trades', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
    const trades = await db.indexTradeRepo.getRecentTrades(limit);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
