/**
 * kumoBreakoutCacheRepo.js
 *
 * MongoDB repository for the Kumo Breakout scheduled scanner.
 *
 * Two collections:
 *   1. kumo_candle_cache  — persists raw candle arrays per (token, interval)
 *      so restarts don't require re-fetching from Kite API.
 *   2. kumo_scan_results  — persists scan results per (interval, scanDate)
 *      so the UI can load cached breakout signals instantly.
 *
 * Design:
 *   - Fire-and-forget writes — errors logged, never thrown.
 *   - Candle cache uses upsert keyed on (token, interval).
 *   - Scan results use upsert keyed on (interval, scanDate) — one doc per
 *     interval per day, overwritten on each scan cycle.
 */

const mongo = require('../../services/mongoClient');

const CANDLE_COLLECTION = 'kumo_candle_cache';
const RESULT_COLLECTION = 'kumo_scan_results';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function _todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Index bootstrap ───────────────────────────────────────────────────────────

async function createIndexes() {
  if (!mongo.isReady()) return;
  try {
    const candleCol = mongo.db().collection(CANDLE_COLLECTION);
    const resultCol = mongo.db().collection(RESULT_COLLECTION);
    await Promise.all([
      candleCol.createIndex({ token: 1, interval: 1 }, { unique: true }),
      candleCol.createIndex({ updatedAt: 1 }),
      resultCol.createIndex({ interval: 1, scanDate: 1 }, { unique: true }),
      resultCol.createIndex({ scanDate: 1 }),
    ]);
    console.log('[kumoBreakoutCache] Indexes ensured');
  } catch (err) {
    console.warn('[kumoBreakoutCache] createIndexes failed:', err.message);
  }
}

// ── Candle Cache ──────────────────────────────────────────────────────────────

// ── FIFO cap per interval ─────────────────────────────────────────────────────
// Maximum candle bars stored per (token, interval) document.
// When new candles arrive, they're appended and oldest are dropped from the front
// to maintain this cap. This prevents unbounded document growth.
const MAX_BARS = { '15minute': 200, '60minute': 450, day: 150 };

/**
 * FIFO merge: append new candles to existing, deduplicate by date, drop oldest
 * to stay within MAX_BARS cap. Newest candles are always kept (tail of array).
 *
 * @param {object[]} existing - Previously cached candles (may be empty/null)
 * @param {object[]} incoming - Fresh candles from Kite API
 * @param {string}   interval - Kite interval string
 * @returns {object[]} Merged array capped at MAX_BARS[interval]
 */
function _mergeCandles(existing, incoming, interval) {
  const cap = MAX_BARS[interval] ?? 200;

  if (!existing || existing.length === 0) {
    return incoming.slice(-cap);
  }

  // Build a Set of existing candle dates for O(1) dedup lookup
  const existingDates = new Set(existing.map(c => String(c.date)));

  // Append only genuinely new candles (newer than what's cached)
  const newCandles = incoming.filter(c => !existingDates.has(String(c.date)));

  if (newCandles.length === 0) {
    // No new data — just ensure cap
    return existing.slice(-cap);
  }

  // Merge: existing + new, sorted by date ascending, then FIFO trim from front
  const merged = [...existing, ...newCandles];
  // Sort chronologically (candle dates are ISO strings — lexicographic sort works)
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // FIFO: keep only the latest `cap` candles (drop oldest from front)
  return merged.slice(-cap);
}

/**
 * Bulk-upsert candle arrays with FIFO merging.
 *
 * For each (token, interval):
 *   1. Load existing candles from DB
 *   2. Merge with incoming (dedup by date)
 *   3. FIFO trim to MAX_BARS cap (drop oldest)
 *   4. Write back
 */
async function upsertCandles(docs) {
  if (!docs || docs.length === 0) return;
  if (!mongo.isReady()) return;

  const col = mongo.db().collection(CANDLE_COLLECTION);
  const now = new Date();

  // Group docs by interval for efficient batch loading
  const byInterval = new Map();
  for (const doc of docs) {
    const list = byInterval.get(doc.interval) || [];
    list.push(doc);
    byInterval.set(doc.interval, list);
  }

  const ops = [];

  for (const [interval, intervalDocs] of byInterval.entries()) {
    // Bulk-load existing cached candles for this interval to merge with
    const tokens = intervalDocs.map(d => Number(d.token));
    let existingMap = new Map();
    try {
      const existingDocs = await col.find(
        { interval, token: { $in: tokens } },
        { projection: { token: 1, candles: 1 } },
      ).toArray();
      for (const d of existingDocs) {
        existingMap.set(d.token, d.candles);
      }
    } catch {
      // If load fails, proceed with full replacement (no merge)
    }

    for (const { token, candles } of intervalDocs) {
      const tokenNum = Number(token);
      const existing = existingMap.get(tokenNum) ?? null;
      const merged = _mergeCandles(existing, candles, interval);
      const lastCandle = merged[merged.length - 1];
      const lastCandleDate = lastCandle?.date ? String(lastCandle.date).slice(0, 10) : null;

      ops.push({
        updateOne: {
          filter: { token: tokenNum, interval },
          update: {
            $set: { token: tokenNum, interval, candles: merged, lastCandleDate, updatedAt: now },
          },
          upsert: true,
        },
      });
    }
  }

  if (ops.length === 0) return;

  try {
    await col.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.warn('[kumoBreakoutCache] upsertCandles failed:', err.message);
  }
}

/**
 * Load all cached candles for a given interval.
 * Returns Map<token, candles[]>.
 */
async function loadCandles(interval) {
  const out = new Map();
  if (!mongo.isReady()) return out;

  try {
    const docs = await mongo.db().collection(CANDLE_COLLECTION)
      .find({ interval }, { projection: { _id: 0, token: 1, candles: 1, lastCandleDate: 1 } })
      .toArray();

    for (const doc of docs) {
      out.set(doc.token, { candles: doc.candles, lastCandleDate: doc.lastCandleDate });
    }
  } catch (err) {
    console.warn('[kumoBreakoutCache] loadCandles failed:', err.message);
  }

  return out;
}

/**
 * Load candles for a specific token and interval.
 */
async function loadCandlesForToken(token, interval) {
  if (!mongo.isReady()) return null;
  try {
    const doc = await mongo.db().collection(CANDLE_COLLECTION)
      .findOne({ token: Number(token), interval }, { projection: { _id: 0, candles: 1, lastCandleDate: 1 } });
    return doc ? doc.candles : null;
  } catch (err) {
    console.warn('[kumoBreakoutCache] loadCandlesForToken failed:', err.message);
    return null;
  }
}

// ── Scan Results ──────────────────────────────────────────────────────────────

/**
 * Save scan results for an interval.
 * Upserts one document per (interval, scanDate).
 */
async function saveScanResults(interval, matches, meta = {}) {
  if (!mongo.isReady()) return;

  const scanDate = _todayIST();
  const doc = {
    interval,
    scanDate,
    matches,
    scannedCount: meta.scannedCount ?? 0,
    totalInstruments: meta.totalInstruments ?? 0,
    scannedAt: new Date(),
    ts: Date.now(),
  };

  try {
    await mongo.db().collection(RESULT_COLLECTION).updateOne(
      { interval, scanDate },
      { $set: doc },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[kumoBreakoutCache] saveScanResults failed:', err.message);
  }
}

/**
 * Load today's scan results for a given interval.
 * Returns { matches, scannedAt, scannedCount, totalInstruments } or null.
 */
async function loadScanResults(interval, date) {
  if (!mongo.isReady()) return null;

  const scanDate = date ?? _todayIST();
  try {
    const doc = await mongo.db().collection(RESULT_COLLECTION).findOne(
      { interval, scanDate },
      { projection: { _id: 0, matches: 1, scannedAt: 1, scannedCount: 1, totalInstruments: 1, ts: 1 } },
    );
    return doc ?? null;
  } catch (err) {
    console.warn('[kumoBreakoutCache] loadScanResults failed:', err.message);
    return null;
  }
}

/**
 * Load today's scan results for ALL intervals.
 * Returns Map<interval, { matches, scannedAt, ... }>.
 */
async function loadAllScanResults(date) {
  const out = new Map();
  if (!mongo.isReady()) return out;

  const scanDate = date ?? _todayIST();
  try {
    const docs = await mongo.db().collection(RESULT_COLLECTION)
      .find({ scanDate }, { projection: { _id: 0 } })
      .toArray();

    for (const doc of docs) {
      out.set(doc.interval, doc);
    }
  } catch (err) {
    console.warn('[kumoBreakoutCache] loadAllScanResults failed:', err.message);
  }

  return out;
}

/**
 * Clear all candle cache and scan results.
 */
async function clearAll() {
  if (!mongo.isReady()) return;
  try {
    await Promise.all([
      mongo.db().collection(CANDLE_COLLECTION).deleteMany({}),
      mongo.db().collection(RESULT_COLLECTION).deleteMany({}),
    ]);
    console.log('[kumoBreakoutCache] Cleared all cache');
  } catch (err) {
    console.warn('[kumoBreakoutCache] clearAll failed:', err.message);
  }
}

module.exports = {
  createIndexes,
  upsertCandles,
  loadCandles,
  loadCandlesForToken,
  saveScanResults,
  loadScanResults,
  loadAllScanResults,
  clearAll,
  _todayIST,
};
