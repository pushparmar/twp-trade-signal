/**
 * phase2/candleCacheRepo.js
 *
 * MongoDB candle cache for the Phase-2 index-option strike scanner.
 * Own collection (`phase2_candle_cache`) — fully standalone from the
 * kumo/equity caches.
 *
 * FIFO guarantee per (token, interval) document:
 *   1. Incoming candles are merged with the cached array
 *   2. Deduplicated by candle date (newest data wins on conflict)
 *   3. Sorted chronologically
 *   4. Trimmed from the FRONT to MAX_BARS — oldest dropped, newest kept
 *
 * Option tokens churn every expiry, so stale documents are pruned:
 * anything not updated for STALE_DAYS is deleted on each upsert cycle.
 */

const mongo = require('../services/mongoClient');

const COLLECTION = 'phase2_candle_cache';

// FIFO caps per interval — enough history for Ichimoku (needs 78) + headroom
const MAX_BARS = { '5minute': 250, '15minute': 250, '60minute': 250 };
const STALE_DAYS = 10;

async function createIndexes() {
  if (!mongo.isReady()) return;
  try {
    const col = mongo.db().collection(COLLECTION);
    await Promise.all([
      col.createIndex({ token: 1, interval: 1 }, { unique: true }),
      col.createIndex({ updatedAt: 1 }),
    ]);
    console.log('[Phase2CandleCache] Indexes ensured');
  } catch (err) {
    console.warn('[Phase2CandleCache] createIndexes failed:', err.message);
  }
}

/**
 * FIFO merge — append new candles, dedup by date, keep only the newest
 * MAX_BARS entries (oldest fall off the front).
 */
function _mergeFifo(existing, incoming, interval) {
  const cap = MAX_BARS[interval] ?? 250;
  if (!existing || existing.length === 0) return incoming.slice(-cap);

  const byDate = new Map();
  for (const c of existing) byDate.set(String(c.date), c);
  for (const c of incoming) byDate.set(String(c.date), c); // newest data wins

  const merged = [...byDate.values()];
  merged.sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  return merged.slice(-cap); // FIFO: drop oldest, keep newest `cap`
}

/**
 * Upsert candles for many (token, interval) pairs with FIFO merging.
 * Fire-and-forget safe — errors are logged, never thrown.
 */
async function upsertCandles(docs) {
  if (!docs?.length || !mongo.isReady()) return;

  try {
    const col = mongo.db().collection(COLLECTION);
    const now = new Date();

    // Load existing docs for all pairs in one query per interval
    const byInterval = new Map();
    for (const d of docs) {
      const list = byInterval.get(d.interval) ?? [];
      list.push(d);
      byInterval.set(d.interval, list);
    }

    const ops = [];
    for (const [interval, list] of byInterval) {
      const tokens = list.map((d) => Number(d.token));
      const existingDocs = await col
        .find({ interval, token: { $in: tokens } }, { projection: { token: 1, candles: 1 } })
        .toArray();
      const existingMap = new Map(existingDocs.map((d) => [d.token, d.candles]));

      for (const { token, candles } of list) {
        const tokenNum = Number(token);
        const merged = _mergeFifo(existingMap.get(tokenNum), candles, interval);
        ops.push({
          updateOne: {
            filter: { token: tokenNum, interval },
            update: { $set: { token: tokenNum, interval, candles: merged, updatedAt: now } },
            upsert: true,
          },
        });
      }
    }

    if (ops.length) await col.bulkWrite(ops, { ordered: false });

    // Prune documents for expired/rotated option tokens
    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    await col.deleteMany({ updatedAt: { $lt: cutoff } });
  } catch (err) {
    console.warn('[Phase2CandleCache] upsertCandles failed:', err.message);
  }
}

/**
 * Load cached candles for an interval.
 * Returns Map<token, candles[]>.
 */
async function loadCandles(interval) {
  const out = new Map();
  if (!mongo.isReady()) return out;
  try {
    const docs = await mongo.db().collection(COLLECTION)
      .find({ interval }, { projection: { _id: 0, token: 1, candles: 1 } })
      .toArray();
    for (const d of docs) out.set(d.token, d.candles);
  } catch (err) {
    console.warn('[Phase2CandleCache] loadCandles failed:', err.message);
  }
  return out;
}

module.exports = { createIndexes, upsertCandles, loadCandles, mergeFifo: _mergeFifo, MAX_BARS };
