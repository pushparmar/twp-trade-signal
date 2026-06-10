/**
 * equityCandleCacheRepo.js
 *
 * Persistent candle cache for the equity scan.
 *
 * Collection: equity_candle_cache
 * One document per (token, interval) — upserted on each scan run.
 *
 * Why: the equity scan fetches 2600 Kite historical API calls on every run
 * (1300 stocks × 2 intervals).  Persisting the candle arrays in MongoDB means
 * subsequent same-day runs (or runs after a server restart) load from the DB
 * instead of hitting the Kite API again — reducing prefetch from 5-9 min to
 * a few seconds.
 *
 * Freshness: a cached entry is considered stale when its `lastCandleDate`
 * (date of the most recent candle in IST) is older than the last trading day.
 * The caller compares against `todayIST` or `yesterdayIST` as appropriate.
 *
 * Document shape:
 * {
 *   token:          Number,   // instrumentToken (unique compound key with interval)
 *   interval:       String,   // '60minute' | 'day'
 *   candles:        Array,    // raw OHLCV array from historicalCache
 *   lastCandleDate: String,   // date field of candles[candles.length-1] — 'YYYY-MM-DD' prefix
 *   updatedAt:      Date,     // wall-clock time of last upsert
 * }
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'equity_candle_cache';

// ── Ichimoku-specific storage optimization ───────────────────────────────────
// Ichimoku requires minimum 52 bars (Senkou B) + 26 (Chikou) = 78 bars.
// Store 90 bars (15% buffer) instead of 400-1200 → 80-90% storage reduction.
const ICHIMOKU_MIN_BARS = 78;
const STORAGE_BARS = 90;  // small buffer above minimum

/**
 * Trim candle array to only what's needed for Ichimoku calculations.
 * Keeps the most recent STORAGE_BARS candles, discarding older history.
 *
 * @param {object[]} candles - Full candle array
 * @returns {object[]} Trimmed array (most recent 90 bars)
 */
function _trimToIchimokuNeeds(candles) {
  if (!candles || candles.length <= STORAGE_BARS) return candles;
  return candles.slice(-STORAGE_BARS);
}

// ── Freshness ─────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function _todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Extract the date prefix ('YYYY-MM-DD') from a candle's date field.
 * Kite returns dates as ISO strings ('2026-05-23T09:15:00+0530') or
 * plain date strings ('2026-05-23').
 */
function _candleDatePrefix(dateStr) {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 10);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Bulk-upsert candle arrays for multiple (token, interval) pairs.
 *
 * @param {Array<{ token, interval, candles }>} docs
 * @returns {Promise<void>}
 */
async function bulkUpsert(docs) {
  if (!docs || docs.length === 0) return;
  if (!mongo.isReady()) {
    console.warn('[equityCandleCache] MongoDB not ready — skipping cache write');
    return;
  }

  const now = new Date();
  let originalSize = 0;
  let trimmedSize = 0;

  const ops = docs.map(({ token, interval, candles }) => {
    // Trim to Ichimoku minimum (90 bars) before storing
    const trimmedCandles = _trimToIchimokuNeeds(candles);
    originalSize += candles.length;
    trimmedSize += trimmedCandles.length;

    const lastCandle     = trimmedCandles[trimmedCandles.length - 1];
    const lastCandleDate = _candleDatePrefix(lastCandle?.date);
    return {
      updateOne: {
        filter: { token: Number(token), interval },
        update: {
          $set: { token: Number(token), interval, candles: trimmedCandles, lastCandleDate, updatedAt: now },
        },
        upsert: true,
      },
    };
  });

  try {
    const result = await mongo.db().collection(COLLECTION).bulkWrite(ops, { ordered: false });
    const reduction = ((1 - trimmedSize / originalSize) * 100).toFixed(1);
    console.log(
      `[equityCandleCache] Upserted ${result.upsertedCount + result.modifiedCount}` +
      ` candle arrays (${docs.length} total) — storage reduced ${reduction}% (${originalSize}→${trimmedSize} bars)`,
    );
  } catch (err) {
    // Non-fatal — next scan will re-fetch from Kite
    console.warn('[equityCandleCache] bulkUpsert failed:', err.message);
  }
}

/**
 * Load all cached candle entries for the given intervals.
 * Returns a Map keyed by `"token:interval"` → `{ candles, lastCandleDate }`.
 * No date filter — caller decides which entries are fresh vs stale.
 *
 * @param {string[]} intervals  e.g. ['60minute', 'day']
 * @returns {Promise<Map<string, { candles: object[], lastCandleDate: string }>>}
 */
async function loadAll(intervals) {
  const out = new Map();
  if (!mongo.isReady()) return out;

  try {
    const docs = await mongo
      .db()
      .collection(COLLECTION)
      .find(
        { interval: { $in: intervals } },
        { projection: { _id: 0, token: 1, interval: 1, candles: 1, lastCandleDate: 1 } },
      )
      .toArray();

    for (const doc of docs) {
      out.set(`${doc.token}:${doc.interval}`, {
        candles:        doc.candles,
        lastCandleDate: doc.lastCandleDate ?? null,
      });
    }

    console.log(
      `[equityCandleCache] Loaded ${out.size} cached candle entries ` +
      `(intervals=${intervals.join(',')})`,
    );
  } catch (err) {
    console.warn('[equityCandleCache] loadAll failed:', err.message);
  }

  return out;
}

/**
 * Create MongoDB indexes. Safe to call multiple times (idempotent).
 */
async function createIndexes() {
  if (!mongo.isReady()) return;
  try {
    const col = mongo.db().collection(COLLECTION);
    await Promise.all([
      col.createIndex({ token: 1, interval: 1 }, { unique: true }),
      col.createIndex({ lastCandleDate: 1 }),
      col.createIndex({ updatedAt: 1 }),
    ]);
  } catch (err) {
    console.warn('[equityCandleCache] createIndexes failed:', err.message);
  }
}

/**
 * Delete all documents from the candle cache.
 * Call this when you want the next equity scan to re-fetch everything
 * from the Kite historical API and rebuild the cache from scratch.
 *
 * @returns {Promise<number>} number of documents deleted
 */
async function clearAll() {
  if (!mongo.isReady()) {
    console.warn('[equityCandleCache] MongoDB not ready — skipping clearAll');
    return 0;
  }
  try {
    const result = await mongo.db().collection(COLLECTION).deleteMany({});
    console.log(`[equityCandleCache] Cleared ${result.deletedCount} candle cache documents`);
    return result.deletedCount;
  } catch (err) {
    console.warn('[equityCandleCache] clearAll failed:', err.message);
    return 0;
  }
}

/**
 * One-time migration: trim all existing candle arrays to Ichimoku minimum.
 * Run this to reduce storage on existing cached data without re-fetching.
 *
 * @returns {Promise<{ processed: number, trimmed: number, savedBytes: number }>}
 */
async function trimExistingCache() {
  if (!mongo.isReady()) {
    console.warn('[equityCandleCache] MongoDB not ready — skipping trim');
    return { processed: 0, trimmed: 0, savedBytes: 0 };
  }

  try {
    const col = mongo.db().collection(COLLECTION);
    const docs = await col.find({}).toArray();

    if (docs.length === 0) {
      console.log('[equityCandleCache] No documents to trim');
      return { processed: 0, trimmed: 0, savedBytes: 0 };
    }

    let processed = 0;
    let trimmed = 0;
    let originalBars = 0;
    let trimmedBars = 0;

    const ops = [];

    for (const doc of docs) {
      processed++;
      originalBars += doc.candles.length;

      if (doc.candles.length > STORAGE_BARS) {
        const trimmedCandles = _trimToIchimokuNeeds(doc.candles);
        trimmedBars += trimmedCandles.length;
        trimmed++;

        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { candles: trimmedCandles, updatedAt: new Date() } },
          },
        });
      } else {
        trimmedBars += doc.candles.length;
      }
    }

    if (ops.length > 0) {
      await col.bulkWrite(ops, { ordered: false });
    }

    // Rough byte calculation: ~100 bytes per candle document
    const savedBytes = (originalBars - trimmedBars) * 100;
    const reduction = ((1 - trimmedBars / originalBars) * 100).toFixed(1);

    console.log(
      `[equityCandleCache] Trim complete: ${processed} docs, ${trimmed} trimmed ` +
      `(${originalBars}→${trimmedBars} bars = ${reduction}% reduction, ~${(savedBytes / 1024 / 1024).toFixed(2)} MB saved)`,
    );

    return { processed, trimmed, savedBytes };
  } catch (err) {
    console.warn('[equityCandleCache] trimExistingCache failed:', err.message);
    return { processed: 0, trimmed: 0, savedBytes: 0 };
  }
}

module.exports = { bulkUpsert, loadAll, clearAll, trimExistingCache, createIndexes, _todayIST };
