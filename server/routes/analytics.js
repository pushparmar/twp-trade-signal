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

module.exports = router;
