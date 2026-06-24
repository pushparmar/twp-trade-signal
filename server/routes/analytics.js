/**
 * Analytics routes — read-only queries over MongoDB pattern and trade data.
 *
 * All endpoints are intentionally GET-only and read-only.
 * Write operations go through their source services (backgroundScanner,
 * liveScanner, paperTrades routes), never through this router.
 *
 * GET /api/analytics/summary          — all three datasets in one call
 * GET /api/analytics/pattern-stats    — scan alert frequency per pattern/signal
 * GET /api/analytics/win-rate         — paper-trade win rate per pattern
 * GET /api/analytics/daily-pnl        — closed trade P&L aggregated by IST date
 */

const express = require('express');
const db      = require('../db');
const mongo   = require('../services/mongoClient');

const router = express.Router();

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Parse optional ?from=YYYY-MM-DD&to=YYYY-MM-DD query params into Date objects.
 * Both are optional; missing params are returned as undefined.
 */
function _parseDateRange(query) {
  const opts = {};
  if (query.from) {
    const d = new Date(query.from);
    if (!isNaN(d)) opts.fromDate = d;
  }
  if (query.to) {
    // Inclusive end-of-day so ?to=2025-05-16 captures the full day
    const d = new Date(query.to);
    if (!isNaN(d)) {
      d.setUTCHours(23, 59, 59, 999);
      opts.toDate = d;
    }
  }
  return opts;
}

// ── GET /api/analytics/summary ────────────────────────────────────────────────
/**
 * Returns all three analytics datasets in a single response.
 * Preferred by the client to avoid three sequential round-trips.
 *
 * Response:
 *   {
 *     patternStats: [...],   // scan alert frequency per (patternId, signal)
 *     winRate:      [...],   // paper-trade win rate per patternId
 *     dailyPnl:     [...],   // P&L aggregated by IST date (YYYY-MM-DD)
 *     dbReady:      boolean, // false when MONGODB_URI is not configured
 *   }
 */
router.get('/summary', async (req, res) => {
  // Authoritative readiness check — the repos return [] silently when mongo
  // isn't ready, so we must consult mongoClient directly to avoid reporting
  // dbReady:true on a disconnected database.
  if (!mongo.isReady()) {
    return res.json({ patternStats: [], winRate: [], dailyPnl: [], dbReady: false });
  }

  const opts = _parseDateRange(req.query);
  // Optional exchange filter: 'NSE', 'NFO', 'MCX', etc.
  // Client sends 'NSE' to mean both NSE+NFO equity; we map that here.
  const { exchange } = req.query;
  if (exchange === 'NSE') {
    opts.exchange = { $in: ['NSE', 'NFO'] };
  } else if (exchange) {
    opts.exchange = exchange;
  }

  try {
    const [patternStats, winRate, dailyPnl] = await Promise.all([
      db.alertRepo.patternStats(opts),
      db.tradeRepo.patternWinRate(opts),
      db.tradeRepo.dailyPnl(opts),
    ]);
    res.json({ patternStats, winRate, dailyPnl, dbReady: true });
  } catch (err) {
    console.error('[Analytics] summary failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/pattern-stats ─────────────────────────────────────────
/**
 * Pattern alert frequency — how often each pattern fires and its average score.
 * Useful for identifying high-conviction, frequently-triggering setups.
 *
 * Query params:
 *   from  — ISO date string, inclusive (e.g. "2025-05-01")
 *   to    — ISO date string, inclusive (e.g. "2025-05-31")
 */
router.get('/pattern-stats', async (req, res) => {
  try {
    const stats = await db.alertRepo.patternStats(_parseDateRange(req.query));
    res.json(stats);
  } catch (err) {
    console.error('[Analytics] pattern-stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/win-rate ───────────────────────────────────────────────
/**
 * Paper-trade win rate per pattern.
 * Returns { _id: patternId, count, wins, winRate, avgPnl } sorted by winRate desc.
 */
router.get('/win-rate', async (req, res) => {
  try {
    const rows = await db.tradeRepo.patternWinRate();
    res.json(rows);
  } catch (err) {
    console.error('[Analytics] win-rate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/daily-pnl ─────────────────────────────────────────────
/**
 * Closed trade P&L aggregated by IST date.
 * Returns { _id: "YYYY-MM-DD", totalPnl, wins, losses, count } sorted newest first.
 *
 * Query params:
 *   from  — ISO date string, inclusive
 *   to    — ISO date string, inclusive
 */
router.get('/daily-pnl', async (req, res) => {
  try {
    const rows = await db.tradeRepo.dailyPnl(_parseDateRange(req.query));
    res.json(rows);
  } catch (err) {
    console.error('[Analytics] daily-pnl failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/signal-outcomes ────────────────────────────────────────
/**
 * Signal outcome stats — win rate, avg MFE/MAE per pattern + timeframe.
 * Phase 2 data collection endpoint.
 *
 * Query params:
 *   from       — ISO date string, inclusive
 *   to         — ISO date string, inclusive
 *   patternId  — filter by specific pattern (e.g. "kijun-bounce")
 *   tfLabel    — filter by timeframe label (e.g. "15m", "1h", "4h", "1d")
 */
router.get('/signal-outcomes', async (req, res) => {
  if (!mongo.isReady()) {
    return res.json({ stats: [], dbReady: false });
  }
  try {
    const opts = _parseDateRange(req.query);
    if (req.query.patternId) opts.patternId = req.query.patternId;
    if (req.query.tfLabel)   opts.tfLabel   = req.query.tfLabel;
    const stats = await db.signalOutcomeRepo.getStats(opts);
    res.json({ stats, dbReady: true });
  } catch (err) {
    console.error('[Analytics] signal-outcomes failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/price-path ────────────────────────────────────────────
/**
 * Price path distribution for TSL calibration — MFE, MAE, returnFromMFE.
 * Returns individual signal outcomes with R-multiple stats (no raw pricePath
 * array — just the summary fields to keep response size small).
 *
 * Query params:
 *   patternId  — required or recommended for meaningful results
 *   tfLabel    — optional timeframe filter
 *   from       — ISO date string, inclusive
 *   to         — ISO date string, inclusive
 */
router.get('/price-path', async (req, res) => {
  if (!mongo.isReady()) {
    return res.json({ data: [], dbReady: false });
  }
  try {
    const opts = _parseDateRange(req.query);
    if (req.query.patternId) opts.patternId = req.query.patternId;
    if (req.query.tfLabel)   opts.tfLabel   = req.query.tfLabel;
    const data = await db.signalOutcomeRepo.getPricePathStats(opts);
    res.json({ data, dbReady: true });
  } catch (err) {
    console.error('[Analytics] price-path failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/bias-stats ────────────────────────────────────────────
/**
 * Market bias alignment analysis — compares win rate of bias-aligned signals
 * vs counter-trend signals for intraday (15m, 1h) scans.
 *
 * This answers: "Should we skip bearish trades on bullish days?"
 * After 1-2 months of data, the numbers will show clear evidence either way.
 *
 * Response rows grouped by { biasAligned (true/false), tfLabel, patternId }
 * with winRate, total, targetHit, slHit, avgMfeR, avgMaeR.
 *
 * Query params:
 *   from       — ISO date string, inclusive
 *   to         — ISO date string, inclusive
 *   patternId  — filter by specific pattern
 *   tfLabel    — filter by timeframe ("15m", "1h")
 */
router.get('/bias-stats', async (req, res) => {
  if (!mongo.isReady()) {
    return res.json({ stats: [], dbReady: false });
  }
  try {
    const opts = _parseDateRange(req.query);
    if (req.query.patternId) opts.patternId = req.query.patternId;
    if (req.query.tfLabel)   opts.tfLabel   = req.query.tfLabel;
    const stats = await db.signalOutcomeRepo.getBiasStats(opts);
    res.json({ stats, dbReady: true });
  } catch (err) {
    console.error('[Analytics] bias-stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/comprehensive ─────────────────────────────────────────
/**
 * Comprehensive analytics — by pattern, timeframe, entry hour, with export.
 * Returns detailed stats for equity trades similar to index trade analytics.
 *
 * Query params:
 *   limit      — max trades to analyze (default 2000)
 *   exchange   — optional filter: 'NSE', 'MCX'
 */
router.get('/comprehensive', async (req, res) => {
  if (!mongo.isReady()) {
    return res.json({ summary: null, byPattern: {}, byTimeframe: {}, byEntryHour: {}, dbReady: false });
  }

  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 2000;
    const trades = await db.tradeRepo.getRecentTrades(limit);

    // Optional exchange filter
    let filtered = trades;
    if (req.query.exchange === 'NSE') {
      filtered = trades.filter(t => t.exchange === 'NSE' || t.exchange === 'NFO');
    } else if (req.query.exchange) {
      filtered = trades.filter(t => t.exchange === req.query.exchange);
    }

    const closed = filtered.filter(t => t.status === 'CLOSED');

    // Helper for IST hour from timestamp
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const getIstHour = (ts) => {
      if (!ts) return null;
      const d = new Date(ts + IST_OFFSET_MS);
      return d.getUTCHours();
    };

    // 1. By Pattern
    const byPattern = {};
    for (const t of closed) {
      const key = t.patternId || 'unknown';
      if (!byPattern[key]) byPattern[key] = { wins: 0, losses: 0, totalPnl: 0, target: 0, sl: 0 };
      if (t.pnl > 0) byPattern[key].wins++;
      else byPattern[key].losses++;
      byPattern[key].totalPnl += t.pnl || 0;
      if (t.exitReason === 'target') byPattern[key].target++;
      if (t.exitReason === 'sl') byPattern[key].sl++;
    }

    // 2. By Timeframe
    const byTimeframe = {};
    for (const t of closed) {
      const key = t.tfLabel || t.interval || 'unknown';
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

    // 4. Summary
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
      dbReady: true,
    });
  } catch (err) {
    console.error('[Analytics] comprehensive failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/export ────────────────────────────────────────────────
/**
 * Export all trades as JSON for download.
 *
 * Query params:
 *   limit      — max trades to export (default 10000)
 *   exchange   — optional filter: 'NSE', 'MCX'
 */
router.get('/export', async (req, res) => {
  if (!mongo.isReady()) {
    return res.status(400).json({ error: 'MongoDB not connected' });
  }

  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10000;
    let trades = await db.tradeRepo.getRecentTrades(limit);

    // Optional exchange filter
    if (req.query.exchange === 'NSE') {
      trades = trades.filter(t => t.exchange === 'NSE' || t.exchange === 'NFO');
    } else if (req.query.exchange) {
      trades = trades.filter(t => t.exchange === req.query.exchange);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=equity-trades-export.json');
    res.json(trades);
  } catch (err) {
    console.error('[Analytics] export failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
