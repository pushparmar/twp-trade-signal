/**
 * baseTradeRepo.js
 *
 * Shared base repository for trade persistence (paper_trades & index_trades).
 *
 * Both paper trades and index trades share identical CRUD patterns:
 *   - Fire-and-forget writes (never block trade execution)
 *   - Upsert on tradeId (idempotent)
 *   - Same analytics aggregations (dailyPnl, patternWinRate, etc.)
 *
 * This factory creates a repository bound to a specific collection, avoiding
 * ~300 lines of duplicate code between tradeRepo.js and indexTradeRepo.js.
 *
 * Usage:
 *   const { createTradeRepo } = require('./baseTradeRepo');
 *   const repo = createTradeRepo('paper_trades', 'tradeRepo', mapDocFn, buildDocFn);
 */

const mongo = require('../../services/mongoClient');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Create a trade repository bound to a specific collection.
 *
 * @param {string} collectionName - MongoDB collection name
 * @param {string} logPrefix - Prefix for console logs (e.g., 'tradeRepo', 'indexTradeRepo')
 * @param {Function} mapDocFn - Function to map MongoDB doc → in-memory trade object
 * @param {Function} buildDocFn - Function to build MongoDB doc from trade object
 * @param {string[]} [extraIndexes] - Additional indexes beyond the standard set
 * @returns {object} Repository with CRUD and analytics methods
 */
function createTradeRepo(collectionName, logPrefix, mapDocFn, buildDocFn, extraIndexes = []) {
  const COLLECTION = collectionName;
  const LOG_PREFIX = `[${logPrefix}]`;

  // ── Index bootstrap ─────────────────────────────────────────────────────────

  async function createIndexes() {
    if (!mongo.isReady()) return;
    const col = mongo.db().collection(COLLECTION);
    try {
      // Standard indexes for all trade collections
      await col.createIndex({ tradeId: 1 }, { unique: true });
      await col.createIndex({ status: 1 });
      await col.createIndex({ patternId: 1 });
      await col.createIndex({ openedAt: -1 });

      // Collection-specific indexes
      for (const idx of extraIndexes) {
        await col.createIndex(idx);
      }

      console.log(`${LOG_PREFIX} Indexes ensured on "${COLLECTION}"`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} createIndexes failed:`, err.message);
    }
  }

  // ── Write helpers ───────────────────────────────────────────────────────────

  function upsertTrade(trade) {
    if (!trade?.id) {
      console.warn(`${LOG_PREFIX} upsertTrade skipped — trade has no id`);
      return;
    }

    if (!mongo.isReady()) {
      console.log(`${LOG_PREFIX} MongoDB not ready, waiting up to 10s for ${trade.symbol}...`);
      mongo.waitForReady(10_000).then((ready) => {
        if (!ready) {
          console.warn(`${LOG_PREFIX} upsertTrade skipped — MongoDB not ready after 10s wait (trade=${trade.id.slice(0, 8)}…)`);
          return;
        }
        console.log(`${LOG_PREFIX} MongoDB ready, proceeding with upsert for ${trade.symbol}`);
        _doUpsert(trade);
      });
      return;
    }

    _doUpsert(trade);
  }

  function _doUpsert(trade) {
    const doc = buildDocFn(trade);

    mongo.db().collection(COLLECTION)
      .updateOne(
        { tradeId: trade.id },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      )
      .then((r) => {
        const action = r.upsertedCount > 0 ? 'inserted' : 'updated';
        console.log(`${LOG_PREFIX} ${action} ${trade.symbol} (${trade.id.slice(0, 8)}…) → MongoDB`);
      })
      .catch((err) => {
        console.warn(`${LOG_PREFIX} upsertTrade FAILED:`, err.message);
      });
  }

  function closeTrade(trade) {
    if (!trade?.id) return;

    const doClose = () => {
      mongo.db().collection(COLLECTION)
        .updateOne(
          { tradeId: trade.id },
          {
            $set: {
              status:       'CLOSED',
              exitPrice:    trade.exitPrice    ?? null,
              exitReason:   trade.exitReason   ?? null,
              pnl:          trade.pnl          ?? null,
              // Include TSL/avg-down fields that may have been updated
              sl:           trade.sl           ?? null,
              tslActivated: trade.tslActivated ?? false,
              peakPrice:    trade.peakPrice    ?? null,
              avgPrice:     trade.avgPrice     ?? null,
              lotCount:     trade.lotCount     ?? null,
              avgDownCount: trade.avgDownCount ?? null,
              closedAt:     trade.closedTs ? new Date(trade.closedTs) : new Date(),
              updatedAt:    new Date(),
            },
          },
        )
        .then(() => {
          console.log(`${LOG_PREFIX} closed ${trade.symbol} (${trade.id.slice(0, 8)}…) pnl=${trade.pnl} → MongoDB`);
        })
        .catch((err) => {
          console.warn(`${LOG_PREFIX} closeTrade failed:`, err.message);
        });
    };

    if (!mongo.isReady()) {
      mongo.waitForReady(10_000).then((ready) => {
        if (!ready) {
          console.warn(`${LOG_PREFIX} closeTrade skipped — MongoDB not ready after 10s wait (trade=${trade.id.slice(0, 8)}…)`);
          return;
        }
        doClose();
      });
      return;
    }
    doClose();
  }

  function updateTrade(trade) {
    if (!trade?.id) return;
    if (!mongo.isReady()) return; // Silent skip for frequent updates

    const updates = {
      sl:           trade.sl           ?? null,
      peakPrice:    trade.peakPrice    ?? null,
      tslActivated: trade.tslActivated ?? false,
      avgPrice:     trade.avgPrice     ?? null,
      lotCount:     trade.lotCount     ?? null,
      avgDownCount: trade.avgDownCount ?? null,
      avgDownAt:    trade.avgDownAt    ?? null,
      updatedAt:    new Date(),
    };

    mongo.db().collection(COLLECTION)
      .updateOne({ tradeId: trade.id }, { $set: updates })
      .catch((err) => {
        console.warn(`${LOG_PREFIX} updateTrade failed:`, err.message);
      });
  }

  // ── Read helpers ────────────────────────────────────────────────────────────

  async function getOpenTrades() {
    if (!mongo.isReady()) return [];
    try {
      const docs = await mongo.db().collection(COLLECTION)
        .find({ status: 'OPEN' })
        .sort({ openedAt: -1 })
        .toArray();
      return docs.map(mapDocFn);
    } catch (err) {
      console.warn(`${LOG_PREFIX} getOpenTrades failed:`, err.message);
      return [];
    }
  }

  async function getRecentTrades(limit = 200) {
    if (!mongo.isReady()) return [];
    try {
      const docs = await mongo.db().collection(COLLECTION)
        .find({})
        .sort({ openedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map(mapDocFn);
    } catch (err) {
      console.warn(`${LOG_PREFIX} getRecentTrades failed:`, err.message);
      return [];
    }
  }

  async function getByDate(dateStr) {
    if (!mongo.isReady()) return [];
    try {
      const [y, m, d] = dateStr.split('-').map(Number);
      const fromUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS);
      const toUtc   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS);

      const docs = await mongo.db().collection(COLLECTION)
        .find({ openedAt: { $gte: fromUtc, $lte: toUtc } })
        .sort({ openedAt: -1 })
        .toArray();

      return docs.map(mapDocFn);
    } catch (err) {
      console.warn(`${LOG_PREFIX} getByDate failed:`, err.message);
      return [];
    }
  }

  // ── Analytics helpers ───────────────────────────────────────────────────────

  async function dailyPnl(opts = {}) {
    if (!mongo.isReady()) return [];
    try {
      const match = { status: 'CLOSED', pnl: { $ne: null } };
      if (opts.fromDate || opts.toDate) {
        match.closedAt = {};
        if (opts.fromDate) match.closedAt.$gte = opts.fromDate;
        if (opts.toDate)   match.closedAt.$lte = opts.toDate;
      }
      if (opts.exchange) match.exchange = opts.exchange;
      if (opts.index) match.index = opts.index;
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
      console.warn(`${LOG_PREFIX} dailyPnl failed:`, err.message);
      return [];
    }
  }

  async function patternWinRate(opts = {}) {
    if (!mongo.isReady()) return [];
    try {
      const match = { status: 'CLOSED', patternId: { $ne: null }, pnl: { $ne: null } };
      if (opts.exchange) match.exchange = opts.exchange;
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
              $cond: [{ $gt: ['$count', 0] }, { $divide: ['$wins', '$count'] }, 0],
            },
          },
        },
        { $sort: { winRate: -1 } },
      ]).toArray();
    } catch (err) {
      console.warn(`${LOG_PREFIX} patternWinRate failed:`, err.message);
      return [];
    }
  }

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
              $cond: [{ $gt: ['$count', 0] }, { $divide: ['$wins', '$count'] }, 0],
            },
          },
        },
        { $sort: { totalPnl: -1 } },
      ]).toArray();
    } catch (err) {
      console.warn(`${LOG_PREFIX} strategyPerformance failed:`, err.message);
      return [];
    }
  }

  async function getCumulativePnl() {
    if (!mongo.isReady()) return null;
    try {
      const rows = await mongo.db().collection(COLLECTION).aggregate([
        { $match: { status: 'CLOSED', pnl: { $ne: null } } },
        { $group: { _id: null, total: { $sum: '$pnl' } } },
      ]).toArray();
      return Math.round((rows[0]?.total ?? 0) * 100) / 100;
    } catch (err) {
      console.warn(`${LOG_PREFIX} getCumulativePnl failed:`, err.message);
      return null;
    }
  }

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
      console.warn(`${LOG_PREFIX} getTradingDates failed:`, err.message);
      return [];
    }
  }

  return {
    createIndexes,
    upsertTrade,
    closeTrade,
    updateTrade,
    getOpenTrades,
    getRecentTrades,
    getByDate,
    dailyPnl,
    patternWinRate,
    strategyPerformance,
    getCumulativePnl,
    getTradingDates,
  };
}

module.exports = { createTradeRepo };
