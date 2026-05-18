/**
 * mongoClient.js
 *
 * Singleton MongoDB connection for the trading dashboard.
 *
 * Design principles:
 *   • Never throws — all errors are logged and swallowed so a MongoDB outage
 *     never crashes the trading server or blocks a scan / tick handler.
 *   • Lazy connect — call init() once on boot; all repos check isReady()
 *     before using the client.
 *   • Automatic reconnect — MongoClient's built-in serverSelectionTimeoutMS
 *     + retryWrites handle transient Atlas blips without custom logic.
 *
 * Usage:
 *   const mongo = require('./mongoClient');
 *   await mongo.init();
 *   const db = mongo.db();          // MongoClient.db(dbName)
 *   const ready = mongo.isReady();  // fast boolean guard
 */

const { MongoClient } = require('mongodb');

// ── State ──────────────────────────────────────────────────────────────────────

let _client = null;
let _db     = null;
let _ready  = false;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Connect to MongoDB using the MONGODB_URI env var.
 * Safe to call multiple times — only the first call connects.
 *
 * @returns {Promise<boolean>} true when connected, false when skipped or failed
 */
async function init() {
  if (_ready) return true;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[MongoDB] MONGODB_URI not set — DB persistence disabled');
    return false;
  }

  try {
    _client = new MongoClient(uri, {
      // Fail fast on connection so boot doesn't hang if Atlas is unreachable
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS:         8_000,
      // Retry transient write failures (Atlas failover, etc.)
      retryWrites: true,
      retryReads:  true,
    });

    await _client.connect();

    // Database name from URI path or default to 'twp' (Trading With Purpose)
    const dbName = process.env.MONGODB_DB || 'twp';
    _db    = _client.db(dbName);
    _ready = true;

    console.log(`[MongoDB] Connected → database: "${dbName}"`);
    return true;
  } catch (err) {
    console.error('[MongoDB] Connection failed:', err.message);
    _client = null;
    _db     = null;
    _ready  = false;
    return false;
  }
}

/** Returns the MongoClient Db instance, or null if not connected. */
function db() {
  return _db;
}

/** Fast synchronous guard — use before every repo operation. */
function isReady() {
  return _ready;
}

/**
 * Graceful shutdown — called from the server's SIGTERM handler.
 * Waits for any in-flight operations to complete before closing the socket.
 */
async function close() {
  if (_client) {
    try {
      await _client.close();
      console.log('[MongoDB] Connection closed gracefully');
    } catch (err) {
      console.warn('[MongoDB] Error closing connection:', err.message);
    } finally {
      _client = null;
      _db     = null;
      _ready  = false;
    }
  }
}

module.exports = { init, db, isReady, close };
