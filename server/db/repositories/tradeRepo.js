/**
 * tradeRepo.js
 *
 * Write-through repository for paper trades.
 *
 * Every open/close action on a paper trade is mirrored here so we can later
 * correlate trades with the scan alerts that triggered them and measure
 * per-pattern win rates and average P&L.
 *
 * Design principles:
 *   • Fire-and-forget — all writes are non-blocking.  Errors are logged but
 *     never thrown so a DB outage cannot affect trade execution or balance
 *     calculations (those live in the in-memory store.js).
 *   • Upsert on tradeId — safe to call multiple times for the same trade
 *     (e.g. re-submitting a POST /api/paper/ after a network retry).
 *   • No balance logic — balances are computed from the live in-memory array;
 *     this repo only stores the raw trade events for offline analysis.
 *
 * Collection: paper_trades
 *
 * Indexes (created once on first connection):
 *   { tradeId: 1 }        — unique; primary lookup key
 *   { status: 1 }         — filter OPEN vs CLOSED
 *   { patternId: 1 }      — pattern → P&L correlation
 *   { openedAt: -1 }      — chronological listing
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'paper_trades';

// ── Index bootstrap ───────────────────────────────────────────────────────────

/**
 * Create indexes if they don't already exist.
 * Called once on first connection (from db/index.js).
 */
async function createIndexes() {
  if (!mongo.isReady()) return;
  const col = mongo.db().collection(COLLECTION);
  try {
    await col.createIndex({ tradeId: 1 }, { unique: true });
    await col.createIndex({ status: 1 });
    await col.createIndex({ patternId: 1 });
    await col.createIndex({ openedAt: -1 });
    console.log(`[tradeRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[tradeRepo] createIndexes failed:', err.message);
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/**
 * Insert or update a trade record when a paper trade is opened.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The trade object from store.addPaperTrade().
 */
function upsertTrade(trade) {
  if (!mongo.isReady()) return;
  if (!trade?.id) return;

  const doc = {
    tradeId:      trade.id,
    // Instrument
    symbol:       trade.symbol                   ?? null,
    token:        trade.token ? Number(trade.token) : null,
    exchange:     trade.exchange                 ?? null,
    // Trade details
    action:       trade.action                   ?? null,
    lots:         trade.lots                     ?? 1,
    lotSize:      trade.lotSize                  ?? 1,
    quantity:     trade.quantity                 ?? null,
    entryPrice:   trade.entryPrice               ?? null,
    exitPrice:    trade.exitPrice                ?? null,
    sl:           trade.sl                       ?? null,
    target:       trade.target                   ?? null,
    status:       trade.status                   ?? 'OPEN',
    pnl:          trade.pnl                      ?? null,
    // Pattern context
    patternId:    trade.patternId                ?? null,
    patternLabel: trade.patternLabel             ?? null,
    signal:       trade.signal                   ?? null,
    interval:     trade.interval                 ?? null,
    tfLabel:      trade.tfLabel                  ?? null,
    // Source
    source:       trade.source                   ?? null,
    // Timestamps
    openedAt:     new Date(trade.ts || Date.now()),
    closedAt:     trade.closedTs ? new Date(trade.closedTs) : null,
    updatedAt:    new Date(),
  };

  mongo.db().collection(COLLECTION)
    .updateOne(
      { tradeId: trade.id },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    )
    .catch((err) => {
      console.warn('[tradeRepo] upsertTrade failed:', err.message);
    });
}

/**
 * Mark a trade as CLOSED and record the exit price + P&L.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The closed trade object returned by store.closePaperTrade().
 */
function closeTrade(trade) {
  if (!mongo.isReady()) return;
  if (!trade?.id) return;

  mongo.db().collection(COLLECTION)
    .updateOne(
      { tradeId: trade.id },
      {
        $set: {
          status:    'CLOSED',
          exitPrice: trade.exitPrice ?? null,
          pnl:       trade.pnl       ?? null,
          closedAt:  trade.closedTs ? new Date(trade.closedTs) : new Date(),
          updatedAt: new Date(),
        },
      },
    )
    .catch((err) => {
      console.warn('[tradeRepo] closeTrade failed:', err.message);
    });
}

// ── Read helpers (for future analysis dashboard) ──────────────────────────────

/**
 * Aggregate daily P&L grouped by IST date.
 * Returns an array of { date, totalPnl, wins, losses, count }.
 *
 * @param {{ fromDate?: Date, toDate?: Date }} [opts]
 * @returns {Promise<Array>}
 */
async function dailyPnl(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = { status: 'CLOSED', pnl: { $ne: null } };
    if (opts.fromDate || opts.toDate) {
      match.closedAt = {};
      if (opts.fromDate) match.closedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.closedAt.$lte = opts.toDate;
    }
    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
      {
        $group: {
          _id:      { $dateToString: { format: '%Y-%m-%d', date: '$closedAt', timezone: '+05:30' } },
          totalPnl: { $sum: '$pnl' },
          wins:     { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          losses:   { $sum: { $cond: [{ $lt: ['$pnl', 0] }, 1, 0] } },
          count:    { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[tradeRepo] dailyPnl failed:', err.message);
    return [];
  }
}

/**
 * Pattern-level win rate: for each patternId, returns { count, wins, winRate, avgPnl }.
 * Helps identify which Ichimoku patterns produce the best paper-trade outcomes.
 *
 * @returns {Promise<Array>}
 */
async function patternWinRate() {
  if (!mongo.isReady()) return [];
  try {
    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: { status: 'CLOSED', patternId: { $ne: null }, pnl: { $ne: null } } },
      {
        $group: {
          _id:    '$patternId',
          count:  { $sum: 1 },
          wins:   { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          avgPnl: { $avg: '$pnl' },
        },
      },
      {
        $addFields: {
          winRate: {
            $cond: [
              { $gt: ['$count', 0] },
              { $divide: ['$wins', '$count'] },
              0,
            ],
          },
        },
      },
      { $sort: { winRate: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[tradeRepo] patternWinRate failed:', err.message);
    return [];
  }
}

module.exports = { createIndexes, upsertTrade, closeTrade, dailyPnl, patternWinRate };
