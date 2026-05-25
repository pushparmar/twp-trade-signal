/**
 * settingsRepo.js
 *
 * Key-value settings store in MongoDB for configuration that must survive
 * Railway redeploys (where config.json is ephemeral).
 *
 * Each document has shape: { key: string, value: any, updatedAt: Date }
 *
 * Currently stores:
 *   • 'patternConfig' — per-pattern per-timeframe enable/disable for scan/alert/order
 *
 * Design principles:
 *   • Fire-and-forget writes — errors logged, never thrown
 *   • Reads return null on failure — caller falls back to config.json / defaults
 *   • Upsert on write — always creates or replaces the document for a given key
 *
 * Collection: settings
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'settings';

// ── Index bootstrap ───────────────────────────────────────────────────────────

async function createIndexes() {
  if (!mongo.isReady()) return;
  const col = mongo.db().collection(COLLECTION);
  try {
    await col.createIndex({ key: 1 }, { unique: true });
    console.log(`[settingsRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[settingsRepo] createIndexes failed:', err.message);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Retrieve a setting by key.
 * Returns the stored value, or null if not found / DB unavailable.
 *
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  if (!mongo.isReady()) return null;
  try {
    const doc = await mongo.db().collection(COLLECTION).findOne({ key });
    return doc ? doc.value : null;
  } catch (err) {
    console.warn(`[settingsRepo] get("${key}") failed:`, err.message);
    return null;
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a setting by key.
 * Fire-and-forget — caller should NOT await unless it needs confirmation.
 *
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
async function set(key, value) {
  if (!mongo.isReady()) return;
  try {
    await mongo.db().collection(COLLECTION).updateOne(
      { key },
      { $set: { key, value, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.warn(`[settingsRepo] set("${key}") failed:`, err.message);
  }
}

module.exports = { createIndexes, get, set };
