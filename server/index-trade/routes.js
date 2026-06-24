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
const tradePairing  = require('../services/tradePairing');

const router = express.Router();

// Helper to mask pattern labels in trades/alerts if config.maskPatternNames is true
function maskTradePatterns(trades) {
  const config = tradeStore.getConfig();
  if (!config.maskPatternNames) return trades;
  return trades.map(t => ({
    ...t,
    patternLabel: tradeStore.getMaskedPatternLabel(t.patternId, t.patternLabel),
  }));
}

function maskAlertPatterns(alerts) {
  const config = tradeStore.getConfig();
  if (!config.maskPatternNames) return alerts;
  return alerts.map(a => ({
    ...a,
    patternLabel: tradeStore.getMaskedPatternLabel(a.patternId, a.patternLabel),
  }));
}

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
// Returns in-memory trades, or fetches from MongoDB if memory is empty
router.get('/trades', async (_req, res) => {
  let trades = tradeStore.getAllTrades();

  // If memory is empty, try to restore from MongoDB
  if (trades.length === 0) {
    console.log('[IndexTrade] Memory empty, attempting restore from MongoDB...');
    await tradeStore.restore();
    trades = tradeStore.getAllTrades();
  }

  res.json(maskTradePatterns(trades));
});

// POST /api/index-trade/restore — manually restore trades from MongoDB
router.post('/restore', async (_req, res) => {
  try {
    await tradeStore.restore();
    const trades = tradeStore.getAllTrades();
    res.json({
      ok: true,
      restored: trades.length,
      open: trades.filter(t => t.status === 'OPEN').length,
      closed: trades.filter(t => t.status === 'CLOSED').length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/trades/open
router.get('/trades/open', (_req, res) => {
  res.json(maskTradePatterns(tradeStore.getOpenTrades()));
});

// GET /api/index-trade/trades/history
router.get('/trades/history', (_req, res) => {
  const closed = tradeStore.getClosedTrades()
    .sort((a, b) => (b.closedTs || 0) - (a.closedTs || 0));
  res.json(maskTradePatterns(closed));
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
  res.json(maskAlertPatterns(scanner.getAlertHistory()));
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
    res.json(maskTradePatterns(trades));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/comprehensive
// Returns detailed analytics: by pattern, timeframe, entry time, with/without RSI
router.get('/analytics/comprehensive', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 2000;
    const trades = await db.indexTradeRepo.getRecentTrades(limit);
    const closed = trades.filter(t => t.status === 'CLOSED');

    // Helper for IST hour from timestamp
    const getIstHour = (ts) => {
      if (!ts) return null;
      const d = new Date(ts + 5.5 * 60 * 60 * 1000);
      return d.getUTCHours();
    };

    // 1. By Pattern
    const byPattern = {};
    for (const t of closed) {
      const key = t.patternId || 'unknown';
      if (!byPattern[key]) byPattern[key] = { wins: 0, losses: 0, totalPnl: 0, trades: [] };
      if (t.pnl > 0) byPattern[key].wins++;
      else byPattern[key].losses++;
      byPattern[key].totalPnl += t.pnl || 0;
      byPattern[key].trades.push(t);
    }

    // 2. By Timeframe
    const byTimeframe = {};
    for (const t of closed) {
      const key = t.interval || t.tfLabel || 'unknown';
      if (!byTimeframe[key]) byTimeframe[key] = { wins: 0, losses: 0, totalPnl: 0, target: 0, sl: 0 };
      if (t.pnl > 0) byTimeframe[key].wins++;
      else byTimeframe[key].losses++;
      byTimeframe[key].totalPnl += t.pnl || 0;
      if (t.exitReason === 'target') byTimeframe[key].target++;
      if (t.exitReason === 'sl') byTimeframe[key].sl++;
    }

    // 3. By Entry Hour (IST)
    const byEntryHour = {};
    for (const t of closed) {
      const hour = getIstHour(t.ts);
      if (hour === null) continue;
      const key = `${hour.toString().padStart(2, '0')}:00`;
      if (!byEntryHour[key]) byEntryHour[key] = { wins: 0, losses: 0, totalPnl: 0 };
      if (t.pnl > 0) byEntryHour[key].wins++;
      else byEntryHour[key].losses++;
      byEntryHour[key].totalPnl += t.pnl || 0;
    }

    // 4. RSI analysis (trades that have RSI vs those without)
    const withRsi = closed.filter(t => t.rsiAtEntry != null);
    const withoutRsi = closed.filter(t => t.rsiAtEntry == null);
    const rsiAnalysis = {
      withRsi: {
        count: withRsi.length,
        wins: withRsi.filter(t => t.pnl > 0).length,
        losses: withRsi.filter(t => t.pnl <= 0).length,
        totalPnl: withRsi.reduce((s, t) => s + (t.pnl || 0), 0),
      },
      withoutRsi: {
        count: withoutRsi.length,
        wins: withoutRsi.filter(t => t.pnl > 0).length,
        losses: withoutRsi.filter(t => t.pnl <= 0).length,
        totalPnl: withoutRsi.reduce((s, t) => s + (t.pnl || 0), 0),
      },
    };

    // 5. Summary
    const summary = {
      totalTrades: closed.length,
      wins: closed.filter(t => t.pnl > 0).length,
      losses: closed.filter(t => t.pnl <= 0).length,
      totalPnl: closed.reduce((s, t) => s + (t.pnl || 0), 0),
      targetHits: closed.filter(t => t.exitReason === 'target').length,
      slHits: closed.filter(t => t.exitReason === 'sl').length,
    };

    res.json({
      summary,
      byPattern,
      byTimeframe,
      byEntryHour,
      rsiAnalysis,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/analytics/export
// Export all trades as JSON for download
router.get('/analytics/export', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10000;
    const trades = await db.indexTradeRepo.getRecentTrades(limit);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=index-trades-export.json');
    res.json(maskTradePatterns(trades));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade Pairing & Backtesting Analytics ────────────────────────────────────

// GET /api/index-trade/paired-trades
// Returns trades paired into complete round-trip cycles for backtesting
router.get('/paired-trades', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
    let trades = await db.indexTradeRepo.getRecentTrades(limit);

    // Optional date filtering
    if (req.query.fromDate || req.query.toDate) {
      const fromMs = req.query.fromDate ? new Date(req.query.fromDate).getTime() : 0;
      const toMs = req.query.toDate ? new Date(req.query.toDate).getTime() : Infinity;
      trades = trades.filter(t => t.ts >= fromMs && t.ts <= toMs);
    }

    const pairs = tradePairing.pairTrades(trades);
    const stats = tradePairing.generateBacktestStats(pairs);

    res.json({
      count: pairs.length,
      stats,
      trades: pairs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/backtest-by-symbol
// Groups paired trades by symbol (option contract)
router.get('/backtest-by-symbol', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    const trades = await db.indexTradeRepo.getRecentTrades(limit);
    const pairs = tradePairing.pairTrades(trades);
    const grouped = tradePairing.groupBySymbol(pairs);

    const results = Object.values(grouped)
      .sort((a, b) => b.totalPnl - a.totalPnl);

    res.json({
      count: results.length,
      symbols: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/backtest-by-pattern
// Groups paired trades by pattern for pattern performance analysis
router.get('/backtest-by-pattern', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    const trades = await db.indexTradeRepo.getRecentTrades(limit);
    const pairs = tradePairing.pairTrades(trades);
    const grouped = tradePairing.groupByPattern(pairs);

    const results = Object.values(grouped)
      .sort((a, b) => b.winRate - a.winRate);

    res.json({
      count: results.length,
      patterns: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-trade/backtest-summary
// Comprehensive backtesting statistics
router.get('/backtest-summary', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    let trades = await db.indexTradeRepo.getRecentTrades(limit);

    if (req.query.fromDate || req.query.toDate) {
      const fromMs = req.query.fromDate ? new Date(req.query.fromDate).getTime() : 0;
      const toMs = req.query.toDate ? new Date(req.query.toDate).getTime() : Infinity;
      trades = trades.filter(t => t.ts >= fromMs && t.ts <= toMs);
    }

    const pairs = tradePairing.pairTrades(trades);
    const stats = tradePairing.generateBacktestStats(pairs);
    const bySymbol = tradePairing.groupBySymbol(pairs);
    const byPattern = tradePairing.groupByPattern(pairs);

    res.json({
      overall: stats,
      topSymbols: Object.values(bySymbol)
        .sort((a, b) => b.totalPnl - a.totalPnl)
        .slice(0, 10),
      topPatterns: Object.values(byPattern)
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
