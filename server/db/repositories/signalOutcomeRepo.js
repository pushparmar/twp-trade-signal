/**
 * signalOutcomeRepo.js
 *
 * MongoDB repository for signal outcome tracking (Phase 2 data collection).
 *
 * Every fired alert gets a document here. The signalOutcomeTracker service
 * inserts a pending document at signal time, then updates it candle-by-candle
 * (pricePath[], MFE/MAE) until the outcome resolves (target_hit / sl_hit /
 * expired at 20 bars).
 *
 * Design:
 *   - Fire-and-forget writes — insert/update errors are logged, never thrown.
 *   - findPending() is used on boot to recover in-progress observations that
 *     survive server restarts (critical for 1h/4h/day signals that span days).
 *   - Aggregation helpers (getStats, getPricePathStats) power the analytics API
 *     for pattern performance analysis and TSL calibration.
 *
 * Collection: signal_outcomes
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'signal_outcomes';

// ── Index bootstrap ───────────────────────────────────────────────────────────

async function createIndexes() {
  if (!mongo.isReady()) return;
  const col = mongo.db().collection(COLLECTION);
  try {
    await Promise.all([
      col.createIndex({ patternId: 1 }),
      col.createIndex({ token: 1, firedAt: -1 }),
      col.createIndex({ outcome: 1 }),
      col.createIndex({ tfLabel: 1, outcome: 1 }),
      col.createIndex({ firedAt: -1 }),
    ]);
    console.log(`[signalOutcomeRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[signalOutcomeRepo] createIndexes failed:', err.message);
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Insert a pending signal outcome document.
 * Called at signal time by signalOutcomeTracker.
 *
 * @param {object} doc  Full signal_outcomes document (outcome=null, pricePath=[])
 * @returns {Promise<string|null>} Inserted _id as string, or null on failure
 */
async function insert(doc) {
  if (!mongo.isReady()) return null;
  try {
    const result = await mongo.db().collection(COLLECTION).insertOne(doc);
    return result.insertedId.toString();
  } catch (err) {
    console.warn('[signalOutcomeRepo] insert failed:', err.message);
    return null;
  }
}

/**
 * Resolve a signal outcome — sets final fields when target/SL/expiry is reached.
 *
 * @param {string} id      Document _id (string)
 * @param {object} fields  { outcome, exitPrice, exitAt, barsToExit, mfeR, maeR,
 *                           returnFromMfeR, breakEvenBar, firstR1Bar, firstR2Bar,
 *                           pathShape, pricePath, resolvedAt }
 */
function resolve(id, fields) {
  if (!mongo.isReady()) return;
  const { ObjectId } = require('mongodb');
  mongo.db().collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: fields },
  ).catch((err) => {
    console.warn('[signalOutcomeRepo] resolve failed:', err.message);
  });
}

/**
 * Mid-track progress save — updates pricePath and running MFE/MAE every 5 bars.
 * Prevents data loss if the server restarts before the outcome resolves.
 *
 * @param {string} id      Document _id (string)
 * @param {object} fields  { pricePath, mfeR, maeR }
 */
function updateProgress(id, fields) {
  if (!mongo.isReady()) return;
  const { ObjectId } = require('mongodb');
  mongo.db().collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: fields },
  ).catch((err) => {
    console.warn('[signalOutcomeRepo] updateProgress failed:', err.message);
  });
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Find all pending (unresolved) observations — used on boot to recover
 * in-progress tracking that was interrupted by a server restart.
 *
 * @returns {Promise<Array>} Documents where outcome is null
 */
async function findPending() {
  if (!mongo.isReady()) return [];
  try {
    return await mongo.db().collection(COLLECTION)
      .find({ outcome: null })
      .toArray();
  } catch (err) {
    console.warn('[signalOutcomeRepo] findPending failed:', err.message);
    return [];
  }
}

/**
 * Signal outcome stats — win rate, avg MFE/MAE per patternId + tfLabel.
 * Powers the GET /api/analytics/signal-outcomes endpoint.
 *
 * @param {object} [opts]  { fromDate, toDate, patternId, tfLabel }
 * @returns {Promise<Array>} Aggregation results
 */
async function getStats(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = { outcome: { $ne: null } }; // only resolved
    if (opts.fromDate || opts.toDate) {
      match.firedAt = {};
      if (opts.fromDate) match.firedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.firedAt.$lte = opts.toDate;
    }
    if (opts.patternId) match.patternId = opts.patternId;
    if (opts.tfLabel)   match.tfLabel   = opts.tfLabel;

    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
      {
        $group: {
          _id: { patternId: '$patternId', tfLabel: '$tfLabel' },
          total:       { $sum: 1 },
          targetHit:   { $sum: { $cond: [{ $eq: ['$outcome', 'target_hit'] }, 1, 0] } },
          slHit:       { $sum: { $cond: [{ $eq: ['$outcome', 'sl_hit'] }, 1, 0] } },
          expired:     { $sum: { $cond: [{ $eq: ['$outcome', 'expired'] }, 1, 0] } },
          avgMfeR:     { $avg: '$mfeR' },
          avgMaeR:     { $avg: '$maeR' },
          avgReturnFromMfeR: { $avg: '$returnFromMfeR' },
          avgBarsToExit:     { $avg: '$barsToExit' },
          avgRR:       { $avg: '$rrRatio' },
        },
      },
      {
        $addFields: {
          winRate: {
            $cond: [
              { $gt: ['$total', 0] },
              { $round: [{ $multiply: [{ $divide: ['$targetHit', '$total'] }, 100] }, 1] },
              0,
            ],
          },
        },
      },
      { $sort: { total: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[signalOutcomeRepo] getStats failed:', err.message);
    return [];
  }
}

/**
 * Price path distribution for a specific pattern — MFE, MAE, returnFromMFE.
 * Used for TSL trigger calibration analysis.
 *
 * @param {object} [opts]  { patternId, tfLabel, fromDate, toDate }
 * @returns {Promise<Array>} Raw documents with mfeR, maeR, returnFromMfeR, pathShape
 */
async function getPricePathStats(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = { outcome: { $ne: null } };
    if (opts.patternId) match.patternId = opts.patternId;
    if (opts.tfLabel)   match.tfLabel   = opts.tfLabel;
    if (opts.fromDate || opts.toDate) {
      match.firedAt = {};
      if (opts.fromDate) match.firedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.firedAt.$lte = opts.toDate;
    }

    return await mongo.db().collection(COLLECTION)
      .find(match)
      .project({
        patternId: 1, tfLabel: 1, symbol: 1, signal: 1,
        outcome: 1, mfeR: 1, maeR: 1, returnFromMfeR: 1,
        pathShape: 1, barsToExit: 1, rrRatio: 1,
        breakEvenBar: 1, firstR1Bar: 1, firstR2Bar: 1,
      })
      .sort({ firedAt: -1 })
      .limit(500)
      .toArray();
  } catch (err) {
    console.warn('[signalOutcomeRepo] getPricePathStats failed:', err.message);
    return [];
  }
}

/**
 * Count of resolved outcomes for a given IST date.
 * Used by dailySnapshotJob.
 *
 * @param {string} dateIST  e.g. '2026-05-24'
 * @returns {Promise<number>}
 */
async function countResolvedOnDate(dateIST) {
  if (!mongo.isReady()) return 0;
  try {
    const dayStart = new Date(`${dateIST}T00:00:00+05:30`);
    const dayEnd   = new Date(`${dateIST}T23:59:59+05:30`);
    return await mongo.db().collection(COLLECTION).countDocuments({
      resolvedAt: { $gte: dayStart, $lte: dayEnd },
    });
  } catch (err) {
    console.warn('[signalOutcomeRepo] countResolvedOnDate failed:', err.message);
    return 0;
  }
}

module.exports = {
  createIndexes,
  insert,
  resolve,
  updateProgress,
  findPending,
  getStats,
  getPricePathStats,
  countResolvedOnDate,
};
