/**
 * equityScanRepo.js
 *
 * Repository for the equity_scan_cache collection.
 *
 * Completely independent from scan_alerts — equity scan results live in their
 * own collection so the main background scanner is never touched.
 *
 * Collection: equity_scan_cache
 *
 * Indexes:
 *   { firedAtIST: 1 }            — date-based cache lookup
 *   { score: -1 }                — highest quality first
 *   { patternId: 1, signal: 1 }  — pattern filtering
 *   { token: 1 }                 — per-instrument filtering
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'equity_scan_cache';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function _istDateStr(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 10); // 'YYYY-MM-DD'
}

/**
 * Bulk insert an array of signal result docs for a scan run.
 * Fire-and-forget — errors logged, never thrown.
 *
 * @param {object[]} docs
 * @returns {Promise<void>}
 */
async function insert(docs) {
  if (!docs || docs.length === 0) return;
  if (!mongo.isReady()) {
    console.warn('[equityScanRepo] MongoDB not ready — skipping insert');
    return;
  }
  try {
    await mongo.db().collection(COLLECTION).insertMany(docs, { ordered: false });
  } catch (err) {
    // ordered:false means partial success is acceptable (ignore duplicate key errors)
    if (err.code !== 11000) {
      console.warn('[equityScanRepo] insertMany failed:', err.message);
    }
  }
}

/**
 * Fetch all results for a given IST date (YYYY-MM-DD).
 * Returns sorted by score descending.
 *
 * @param {string} dateIST  e.g. '2026-05-27'
 * @returns {Promise<object[]>}
 */
async function getByDate(dateIST) {
  if (!mongo.isReady()) return [];
  try {
    return await mongo
      .db()
      .collection(COLLECTION)
      .find({ firedAtIST: { $regex: `^${dateIST}` } })
      .sort({ score: -1 })
      .limit(5000)
      .toArray();
  } catch (err) {
    console.warn('[equityScanRepo] getByDate failed:', err.message);
    return [];
  }
}

/**
 * Check whether any results exist for a given IST date.
 *
 * @param {string} dateIST
 * @returns {Promise<boolean>}
 */
async function hasResultsForDate(dateIST) {
  if (!mongo.isReady()) return false;
  try {
    const doc = await mongo
      .db()
      .collection(COLLECTION)
      .findOne({ firedAtIST: { $regex: `^${dateIST}` } }, { projection: { _id: 1 } });
    return doc !== null;
  } catch (err) {
    console.warn('[equityScanRepo] hasResultsForDate failed:', err.message);
    return false;
  }
}

/**
 * Create MongoDB indexes.  Safe to call multiple times (idempotent).
 */
async function createIndexes() {
  if (!mongo.isReady()) return;
  try {
    const col = mongo.db().collection(COLLECTION);
    await Promise.all([
      col.createIndex({ firedAtIST: 1 }),
      col.createIndex({ score: -1 }),
      col.createIndex({ patternId: 1, signal: 1 }),
      col.createIndex({ token: 1 }),
    ]);
  } catch (err) {
    console.warn('[equityScanRepo] createIndexes failed:', err.message);
  }
}

/**
 * Delete scan results for a specific date.
 * Used before inserting fresh results for the same day.
 *
 * @param {string} dateIST  e.g. '2026-05-27'
 * @returns {Promise<number>} number of documents deleted
 */
async function clearForDate(dateIST) {
  if (!mongo.isReady()) {
    console.warn('[equityScanRepo] MongoDB not ready — skipping clearForDate');
    return 0;
  }
  try {
    const result = await mongo.db().collection(COLLECTION).deleteMany({
      firedAtIST: { $regex: `^${dateIST}` }
    });
    console.log(`[equityScanRepo] Cleared ${result.deletedCount} results for ${dateIST}`);
    return result.deletedCount;
  } catch (err) {
    console.warn('[equityScanRepo] clearForDate failed:', err.message);
    return 0;
  }
}

/**
 * Delete all scan results from the collection.
 * Call this to force a fresh recalculation on the next scan run.
 *
 * @returns {Promise<number>} number of documents deleted
 */
async function clearAll() {
  if (!mongo.isReady()) {
    console.warn('[equityScanRepo] MongoDB not ready — skipping clearAll');
    return 0;
  }
  try {
    const result = await mongo.db().collection(COLLECTION).deleteMany({});
    console.log(`[equityScanRepo] Cleared ${result.deletedCount} scan result documents`);
    return result.deletedCount;
  } catch (err) {
    console.warn('[equityScanRepo] clearAll failed:', err.message);
    return 0;
  }
}

module.exports = { insert, getByDate, hasResultsForDate, clearForDate, clearAll, createIndexes };
