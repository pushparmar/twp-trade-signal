/**
 * indexTradeRepo.js
 *
 * Write-through repository for index option trades.
 *
 * Mirrors the tradeRepo.js pattern for equity paper trades but manages the
 * index_trades collection. Every open/close action on an index trade is
 * persisted here so we can later correlate trades with the scan alerts and
 * measure per-pattern/per-strategy win rates and average P&L.
 *
 * Design principles:
 *   • Fire-and-forget — all writes are non-blocking. Errors are logged but
 *     never thrown so a DB outage cannot affect trade execution or balance
 *     calculations (those live in the in-memory tradeStore.js).
 *   • Upsert on tradeId — safe to call multiple times for the same trade
 *     (e.g. on server restart or after a network retry).
 *   • No balance logic — balances are computed from the live in-memory array;
 *     this repo only stores the raw trade events for offline analysis.
 *
 * Collection: index_trades
 *
 * Indexes (created once on first connection):
 *   { tradeId: 1 }        — unique; primary lookup key
 *   { status: 1 }         — filter OPEN vs CLOSED
 *   { patternId: 1 }      — pattern → P&L correlation
 *   { strategyType: 1 }   — 'pattern' vs 'low-premium'
 *   { index: 1 }          — NIFTY vs BANKNIFTY correlation
 *   { openedAt: -1 }      — chronological listing
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'index_trades';

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
    await col.createIndex({ strategyType: 1 });
    await col.createIndex({ index: 1 });
    await col.createIndex({ openedAt: -1 });
    console.log(`[indexTradeRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[indexTradeRepo] createIndexes failed:', err.message);
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/**
 * Insert or update a trade record when an index trade is opened.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The trade object from tradeStore.addTrade().
 */
function upsertTrade(trade) {
  if (!trade?.id) {
    console.warn('[indexTradeRepo] upsertTrade skipped — trade has no id');
    return;
  }

  // If MongoDB isn't ready yet (boot race or transient blip), wait up to 10s
  // before giving up. This prevents silent data loss during Railway deploys
  // where orderManager starts before db.init() resolves.
  if (!mongo.isReady()) {
    _waitForReady(10_000).then((ready) => {
      if (!ready) {
        console.warn(`[indexTradeRepo] upsertTrade skipped — MongoDB not ready after 10s wait (trade=${trade.id.slice(0, 8)}…)`);
        return;
      }
      _doUpsert(trade);
    });
    return;
  }

  _doUpsert(trade);
}

/** Wait for mongo.isReady() to become true, polling every 1s up to maxMs. */
function _waitForReady(maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (mongo.isReady()) return resolve(true);
      if (Date.now() - start >= maxMs) return resolve(false);
      setTimeout(check, 1000);
    };
    check();
  });
}

function _doUpsert(trade) {
  const doc = {
    tradeId:          trade.id,
    // Strategy classification
    source:           trade.source                   ?? 'index-trade',
    strategyType:     trade.strategyType             ?? 'pattern',
    // Index option details
    index:            trade.index                    ?? null,
    symbol:           trade.symbol                   ?? null,
    token:            trade.token ? Number(trade.token) : null,
    optionType:       trade.optionType               ?? null,  // 'CE' or 'PE'
    strike:           trade.strike                   ?? null,
    exchange:         trade.exchange                 ?? 'NFO',
    // Trade details
    action:           trade.action                   ?? 'BUY',
    quantity:         trade.quantity                 ?? 1,
    lotSize:          trade.lotSize                  ?? 1,
    entryPrice:       trade.entryPrice               ?? null,
    exitPrice:        trade.exitPrice                ?? null,
    sl:               trade.sl                       ?? null,
    initialSl:        trade.initialSl                ?? null,
    target:           trade.target                   ?? null,
    status:           trade.status                   ?? 'OPEN',
    pnl:              trade.pnl                      ?? null,
    exitReason:       trade.exitReason               ?? null,
    // Low-premium specific fields (avg-down support)
    avgPrice:         trade.avgPrice                 ?? null,
    lotCount:         trade.lotCount                 ?? null,
    avgDownCount:     trade.avgDownCount             ?? null,
    avgDownAt:        trade.avgDownAt                ?? null,
    // TSL fields
    tslActivated:     trade.tslActivated             ?? false,
    peakPrice:        trade.peakPrice                ?? null,
    // Pattern context
    patternId:        trade.patternId                ?? null,
    patternLabel:     trade.patternLabel             ?? null,
    signalDirection:  trade.signalDirection          ?? null,
    interval:         trade.interval                 ?? null,
    tfLabel:          trade.tfLabel                  ?? null,
    score:            trade.score                    ?? null,
    rrRatio:          trade.rrRatio                  ?? null,
    // Timestamps
    openedAt:         new Date(trade.ts || Date.now()),
    closedAt:         trade.closedTs ? new Date(trade.closedTs) : null,
    updatedAt:        new Date(),
  };

  mongo.db().collection(COLLECTION)
    .updateOne(
      { tradeId: trade.id },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    )
    .then((r) => {
      const action = r.upsertedCount > 0 ? 'inserted' : 'updated';
      console.log(`[indexTradeRepo] ${action} ${trade.symbol} (${trade.id.slice(0,8)}…) → MongoDB`);
    })
    .catch((err) => {
      console.warn('[indexTradeRepo] upsertTrade FAILED:', err.message);
    });
}

/**
 * Mark a trade as CLOSED and record the exit price + P&L.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The closed trade object returned by tradeStore.closeTrade().
 */
function closeTrade(trade) {
  if (!trade?.id) return;

  const doClose = () => {
    mongo.db().collection(COLLECTION)
      .updateOne(
        { tradeId: trade.id },
        {
          $set: {
            status:       'CLOSED',
            exitPrice:    trade.exitPrice  ?? null,
            exitReason:   trade.exitReason ?? null,
            pnl:          trade.pnl        ?? null,
            // Low-premium fields (may have been updated by avg-down)
            avgPrice:     trade.avgPrice   ?? null,
            lotCount:     trade.lotCount   ?? null,
            avgDownCount: trade.avgDownCount ?? null,
            sl:           trade.sl         ?? null,
            tslActivated: trade.tslActivated ?? false,
            peakPrice:    trade.peakPrice  ?? null,
            closedAt:     trade.closedTs ? new Date(trade.closedTs) : new Date(),
            updatedAt:    new Date(),
          },
        },
      )
      .catch((err) => {
        console.warn('[indexTradeRepo] closeTrade failed:', err.message);
      });
  };

  if (!mongo.isReady()) {
    _waitForReady(10_000).then((ready) => {
      if (!ready) {
        console.warn(`[indexTradeRepo] closeTrade skipped — MongoDB not ready after 10s wait (trade=${trade.id.slice(0, 8)}…)`);
        return;
      }
      doClose();
    });
    return;
  }
  doClose();
}

/**
 * Update a trade's live fields during monitoring (SL, peak, TSL, avg-down).
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The updated trade object
 */
function updateTrade(trade) {
  if (!trade?.id) return;

  const doUpdate = () => {
    const updates = {
      sl:           trade.sl           ?? null,
      peakPrice:    trade.peakPrice    ?? null,
      tslActivated: trade.tslActivated ?? false,
      // Low-premium avg-down fields
      avgPrice:     trade.avgPrice     ?? null,
      lotCount:     trade.lotCount     ?? null,
      avgDownCount: trade.avgDownCount ?? null,
      avgDownAt:    trade.avgDownAt    ?? null,
      updatedAt:    new Date(),
    };

    mongo.db().collection(COLLECTION)
      .updateOne(
        { tradeId: trade.id },
        { $set: updates },
      )
      .catch((err) => {
        console.warn('[indexTradeRepo] updateTrade failed:', err.message);
      });
  };

  if (!mongo.isReady()) {
    // Silent skip — this fires every tick, logging would spam
    return;
  }
  doUpdate();
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch all OPEN trades from MongoDB.
 *
 * Used on server boot to restore the in-memory trade list when the server
 * restarts (e.g. after a Railway redeploy).
 *
 * Returns the documents re-shaped to match the plain JS trade object used by
 * tradeStore.addTrade() so the result can be dropped straight in.
 *
 * @returns {Promise<Array>}
 */
async function getOpenTrades() {
  if (!mongo.isReady()) return [];
  try {
    const docs = await mongo.db().collection(COLLECTION)
      .find({ status: 'OPEN' })
      .sort({ openedAt: -1 })
      .toArray();

    return docs.map((doc) => ({
      id:               doc.tradeId,
      ts:               doc.openedAt instanceof Date ? doc.openedAt.getTime() : Date.now(),
      source:           doc.source           ?? 'index-trade',
      strategyType:     doc.strategyType     ?? 'pattern',
      index:            doc.index            ?? null,
      symbol:           doc.symbol           ?? '',
      token:            doc.token            ?? null,
      optionType:       doc.optionType       ?? null,
      strike:           doc.strike           ?? null,
      exchange:         doc.exchange         ?? 'NFO',
      action:           doc.action           ?? 'BUY',
      quantity:         doc.quantity         ?? 1,
      lotSize:          doc.lotSize          ?? 1,
      entryPrice:       doc.entryPrice       ?? 0,
      exitPrice:        doc.exitPrice        ?? null,
      sl:               doc.sl               ?? null,
      initialSl:        doc.initialSl        ?? doc.sl ?? null,
      target:           doc.target           ?? null,
      status:           'OPEN',
      pnl:              null,
      closedTs:         null,
      avgPrice:         doc.avgPrice         ?? null,
      lotCount:         doc.lotCount         ?? null,
      avgDownCount:     doc.avgDownCount     ?? null,
      avgDownAt:        doc.avgDownAt        ?? null,
      tslActivated:     doc.tslActivated     ?? false,
      peakPrice:        doc.peakPrice        ?? doc.entryPrice ?? null,
      patternId:        doc.patternId        ?? null,
      patternLabel:     doc.patternLabel     ?? null,
      signalDirection:  doc.signalDirection  ?? null,
      interval:         doc.interval         ?? null,
      tfLabel:          doc.tfLabel          ?? null,
      score:            doc.score            ?? null,
      rrRatio:          doc.rrRatio          ?? null,
    }));
  } catch (err) {
    console.warn('[indexTradeRepo] getOpenTrades failed:', err.message);
    return [];
  }
}

/**
 * Fetch the most recent trades (any status) from MongoDB.
 * Used on server boot and client sync to restore the full order book
 * — open AND closed — so every device sees the same state.
 *
 * @param {number} [limit=200]  Max number of records to return
 * @returns {Promise<Array>}
 */
async function getRecentTrades(limit = 200) {
  if (!mongo.isReady()) return [];
  try {
    const docs = await mongo.db().collection(COLLECTION)
      .find({})
      .sort({ openedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      id:               doc.tradeId,
      ts:               doc.openedAt instanceof Date ? doc.openedAt.getTime() : Date.now(),
      source:           doc.source           ?? 'index-trade',
      strategyType:     doc.strategyType     ?? 'pattern',
      index:            doc.index            ?? null,
      symbol:           doc.symbol           ?? '',
      token:            doc.token            ?? null,
      optionType:       doc.optionType       ?? null,
      strike:           doc.strike           ?? null,
      exchange:         doc.exchange         ?? 'NFO',
      action:           doc.action           ?? 'BUY',
      quantity:         doc.quantity         ?? 1,
      lotSize:          doc.lotSize          ?? 1,
      entryPrice:       doc.entryPrice       ?? 0,
      exitPrice:        doc.exitPrice        ?? null,
      sl:               doc.sl               ?? null,
      initialSl:        doc.initialSl        ?? doc.sl ?? null,
      target:           doc.target           ?? null,
      status:           doc.status           ?? 'OPEN',
      pnl:              doc.pnl              ?? null,
      closedTs:         doc.closedAt instanceof Date ? doc.closedAt.getTime() : null,
      exitReason:       doc.exitReason       ?? null,
      avgPrice:         doc.avgPrice         ?? null,
      lotCount:         doc.lotCount         ?? null,
      avgDownCount:     doc.avgDownCount     ?? null,
      avgDownAt:        doc.avgDownAt        ?? null,
      tslActivated:     doc.tslActivated     ?? false,
      peakPrice:        doc.peakPrice        ?? doc.entryPrice ?? null,
      patternId:        doc.patternId        ?? null,
      patternLabel:     doc.patternLabel     ?? null,
      signalDirection:  doc.signalDirection  ?? null,
      interval:         doc.interval         ?? null,
      tfLabel:          doc.tfLabel          ?? null,
      score:            doc.score            ?? null,
      rrRatio:          doc.rrRatio          ?? null,
    }));
  } catch (err) {
    console.warn('[indexTradeRepo] getRecentTrades failed:', err.message);
    return [];
  }
}

// ── Analytics helpers ─────────────────────────────────────────────────────────

/**
 * Aggregate daily P&L grouped by IST date.
 * Returns an array of { date, totalPnl, wins, losses, count }.
 *
 * @param {{ fromDate?: Date, toDate?: Date, index?: string, strategyType?: string }} [opts]
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
    // Filter by index when provided (e.g. 'NIFTY' or 'BANKNIFTY')
    if (opts.index) match.index = opts.index;
    // Filter by strategy type ('pattern' or 'low-premium')
    if (opts.strategyType) match.strategyType = opts.strategyType;

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
    console.warn('[indexTradeRepo] dailyPnl failed:', err.message);
    return [];
  }
}

/**
 * Pattern-level win rate: for each patternId, returns { count, wins, winRate, avgPnl }.
 * Helps identify which patterns produce the best index option trade outcomes.
 *
 * @param {{ index?: string, strategyType?: string }} [opts]
 * @returns {Promise<Array>}
 */
async function patternWinRate(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = {
      status: 'CLOSED',
      patternId: { $ne: null },
      pnl: { $ne: null },
    };
    if (opts.index) match.index = opts.index;
    if (opts.strategyType) match.strategyType = opts.strategyType;

    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
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
    console.warn('[indexTradeRepo] patternWinRate failed:', err.message);
    return [];
  }
}

/**
 * Strategy-level performance: compare 'pattern' vs 'low-premium' strategy.
 * Returns { strategyType, count, wins, winRate, avgPnl, totalPnl }.
 *
 * @param {{ index?: string, fromDate?: Date, toDate?: Date }} [opts]
 * @returns {Promise<Array>}
 */
async function strategyPerformance(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = { status: 'CLOSED', pnl: { $ne: null } };
    if (opts.index) match.index = opts.index;
    if (opts.fromDate || opts.toDate) {
      match.closedAt = {};
      if (opts.fromDate) match.closedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.closedAt.$lte = opts.toDate;
    }

    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
      {
        $group: {
          _id:      '$strategyType',
          count:    { $sum: 1 },
          wins:     { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          avgPnl:   { $avg: '$pnl' },
          totalPnl: { $sum: '$pnl' },
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
      { $sort: { totalPnl: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[indexTradeRepo] strategyPerformance failed:', err.message);
    return [];
  }
}

/**
 * Sum of realized PnL across all CLOSED trades in MongoDB.
 * Used on startup to restore the in-memory cumulative PnL counter.
 *
 * @returns {Promise<number>}
 */
async function getCumulativePnl() {
  if (!mongo.isReady()) return null; // null = not available, caller uses fallback
  try {
    const rows = await mongo.db().collection(COLLECTION).aggregate([
      { $match: { status: 'CLOSED', pnl: { $ne: null } } },
      { $group: { _id: null, total: { $sum: '$pnl' } } },
    ]).toArray();
    return Math.round((rows[0]?.total ?? 0) * 100) / 100;
  } catch (err) {
    console.warn('[indexTradeRepo] getCumulativePnl failed:', err.message);
    return null;
  }
}

/**
 * Fetch all trades (any status) opened on a specific IST calendar date.
 *
 * @param {string} dateStr  IST date in "YYYY-MM-DD" format, e.g. "2026-06-04"
 * @returns {Promise<Array>}
 */
async function getByDate(dateStr) {
  if (!mongo.isReady()) return [];
  try {
    // Build IST day boundaries as UTC Date objects.
    // IST = UTC+5:30, so IST midnight = UTC 18:30 the previous day.
    const [y, m, d] = dateStr.split('-').map(Number);
    const fromUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
    const toUtc   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 5.5 * 60 * 60 * 1000);

    const docs = await mongo.db().collection(COLLECTION)
      .find({ openedAt: { $gte: fromUtc, $lte: toUtc } })
      .sort({ openedAt: -1 })
      .toArray();

    return docs.map((doc) => ({
      id:               doc.tradeId,
      ts:               doc.openedAt instanceof Date ? doc.openedAt.getTime() : Date.now(),
      source:           doc.source           ?? 'index-trade',
      strategyType:     doc.strategyType     ?? 'pattern',
      index:            doc.index            ?? null,
      symbol:           doc.symbol           ?? '',
      token:            doc.token            ?? null,
      optionType:       doc.optionType       ?? null,
      strike:           doc.strike           ?? null,
      exchange:         doc.exchange         ?? 'NFO',
      action:           doc.action           ?? 'BUY',
      quantity:         doc.quantity         ?? 1,
      lotSize:          doc.lotSize          ?? 1,
      entryPrice:       doc.entryPrice       ?? 0,
      exitPrice:        doc.exitPrice        ?? null,
      sl:               doc.sl               ?? null,
      initialSl:        doc.initialSl        ?? doc.sl ?? null,
      target:           doc.target           ?? null,
      status:           doc.status           ?? 'OPEN',
      pnl:              doc.pnl              ?? null,
      closedTs:         doc.closedAt instanceof Date ? doc.closedAt.getTime() : null,
      exitReason:       doc.exitReason       ?? null,
      avgPrice:         doc.avgPrice         ?? null,
      lotCount:         doc.lotCount         ?? null,
      avgDownCount:     doc.avgDownCount     ?? null,
      tslActivated:     doc.tslActivated     ?? false,
      peakPrice:        doc.peakPrice        ?? doc.entryPrice ?? null,
      patternId:        doc.patternId        ?? null,
      patternLabel:     doc.patternLabel     ?? null,
      signalDirection:  doc.signalDirection  ?? null,
      interval:         doc.interval         ?? null,
      tfLabel:          doc.tfLabel          ?? null,
      score:            doc.score            ?? null,
      rrRatio:          doc.rrRatio          ?? null,
    }));
  } catch (err) {
    console.warn('[indexTradeRepo] getByDate failed:', err.message);
    return [];
  }
}

/**
 * Return all distinct IST dates that have at least one trade (any status).
 * Used to populate a date picker with only valid trading days.
 * Returns an array of "YYYY-MM-DD" strings, newest first.
 *
 * @returns {Promise<string[]>}
 */
async function getTradingDates() {
  if (!mongo.isReady()) return [];
  try {
    const rows = await mongo.db().collection(COLLECTION).aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$openedAt', timezone: '+05:30' } },
        },
      },
      { $sort: { _id: -1 } },
    ]).toArray();
    return rows.map((r) => r._id).filter(Boolean);
  } catch (err) {
    console.warn('[indexTradeRepo] getTradingDates failed:', err.message);
    return [];
  }
}

module.exports = {
  createIndexes,
  upsertTrade,
  closeTrade,
  updateTrade,
  getOpenTrades,
  getRecentTrades,
  getCumulativePnl,
  dailyPnl,
  patternWinRate,
  strategyPerformance,
  getByDate,
  getTradingDates,
};
