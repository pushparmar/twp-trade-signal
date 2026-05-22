/**
 * alertRepo.js
 *
 * Write-through repository for scan alerts (pattern matches).
 *
 * Every time the background scanner or live scanner detects a new pattern
 * match, a document is inserted here so we can later analyse which patterns
 * perform best, on which instruments, and on which timeframes.
 *
 * Design principles:
 *   • Fire-and-forget — insert errors are logged but never thrown.
 *     A MongoDB outage must not block the trading server or SSE broadcasts.
 *   • No duplicates — the dedup key (token + interval + patternId + signal)
 *     is stored and indexed; the calling service controls when to write.
 *   • Lean documents — only fields that are useful for pattern analysis.
 *
 * Collection: scan_alerts
 *
 * Indexes (created once on first connection):
 *   { firedAt: -1 }                      — time-series listing, newest first
 *   { patternId: 1, signal: 1 }          — pattern performance aggregation
 *   { token: 1, firedAt: -1 }            — per-instrument history
 *   { score: -1 }                        — high-conviction filter
 *   { firedAtIST: 1 }                    — IST-date range queries
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'scan_alerts';

// ── Index bootstrap ───────────────────────────────────────────────────────────

/**
 * Create indexes if they don't already exist.
 * Called once on first connection (from db/index.js).
 * Safe to call multiple times — MongoDB is idempotent on existing indexes.
 */
async function createIndexes() {
  if (!mongo.isReady()) return;
  const col = mongo.db().collection(COLLECTION);
  try {
    await col.createIndex({ firedAt: -1 });
    await col.createIndex({ patternId: 1, signal: 1 });
    await col.createIndex({ token: 1, firedAt: -1 });
    await col.createIndex({ score: -1 });
    await col.createIndex({ firedAtIST: 1 });
    console.log(`[alertRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[alertRepo] createIndexes failed:', err.message);
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Insert a scan alert document into MongoDB.
 *
 * Fire-and-forget — the caller does NOT await this function.
 * All errors are caught internally so a DB outage never propagates.
 *
 * @param {object} alert  The full alert payload from backgroundScanner / liveScanner.
 * @param {'background'|'live'|'manual'} [source='background']
 */
function insertAlert(alert, source = 'background') {
  if (!mongo.isReady()) return; // DB not connected — skip silently

  const firedAt = new Date(alert.ts || Date.now());

  // IST date + time string for easy range queries ("YYYY-MM-DD HH:mm")
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const firedAtIST = new Date(firedAt.getTime() + IST_OFFSET_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);

  const doc = {
    // Instrument
    token:          Number(alert.token)           || null,
    label:          alert.label                   ?? null,
    // Pattern
    patternId:      alert.patternId               ?? null,
    patternLabel:   alert.patternLabel            ?? null,
    signal:         alert.signal                  ?? null,
    // Timeframe
    interval:       alert.interval                ?? null,
    tfLabel:        alert.tfLabel                 ?? null,
    // Score + position
    score:          alert.score                   ?? null,
    close:          alert.close                   ?? null,
    strength:       alert.strength                ?? null,
    cloudPosition:  alert.cloudPosition           ?? null,
    barsAgo:        alert.barsAgo                 ?? null,
    consecutiveBars:alert.consecutiveBars         ?? null,
    cloudThickness: alert.cloudThickness          ?? null,
    // Trade levels
    sl:             alert.sl                      ?? null,
    target:         alert.target                  ?? null,
    targetSource:   alert.targetSource            ?? null,
    // Volume
    volumeRatio:    alert.volumeRatio             ?? null,
    volumeConfirmed:alert.volumeConfirmed         ?? null,
    // MTF confluence
    confluenceTfs:  alert.confluenceTfs           ?? [],
    confluenceCount:alert.confluenceCount         ?? 0,
    // Metadata
    source,
    firedAt,
    firedAtIST,
  };

  // Fire-and-forget — intentionally not awaited by caller
  mongo.db().collection(COLLECTION).insertOne(doc).catch((err) => {
    console.warn('[alertRepo] insertAlert failed:', err.message);
  });
}

// ── Read helpers (for future analysis dashboard) ──────────────────────────────

/**
 * Aggregate pattern performance:
 * For each (patternId, signal) pair, returns { count, avgScore }.
 * Useful for building a "pattern leaderboard" view.
 *
 * @param {{ fromDate?: Date, toDate?: Date }} [opts]
 * @returns {Promise<Array>}
 */
async function patternStats(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = {};
    if (opts.fromDate || opts.toDate) {
      match.firedAt = {};
      if (opts.fromDate) match.firedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.firedAt.$lte = opts.toDate;
    }
    if (opts.exchange) match.exchange = opts.exchange;
    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
      {
        $group: {
          _id:      { patternId: '$patternId', signal: '$signal' },
          count:    { $sum: 1 },
          avgScore: { $avg: '$score' },
          topTfs:   { $addToSet: '$tfLabel' },
        },
      },
      { $sort: { count: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[alertRepo] patternStats failed:', err.message);
    return [];
  }
}

/**
 * Recent alerts for a single instrument (token), newest first.
 *
 * @param {number} token
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function alertsByToken(token, limit = 50) {
  if (!mongo.isReady()) return [];
  try {
    return await mongo.db().collection(COLLECTION)
      .find({ token: Number(token) })
      .sort({ firedAt: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.warn('[alertRepo] alertsByToken failed:', err.message);
    return [];
  }
}

module.exports = { createIndexes, insertAlert, patternStats, alertsByToken };
