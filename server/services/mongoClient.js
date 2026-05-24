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
 *   • Auto-reconnect — topology event listeners detect disconnects and flip
 *     _ready to false. A background health check retries connection every
 *     30 seconds when down. The MongoDB driver also has built-in reconnect
 *     (retryWrites, retryReads) for transient Atlas/Railway blips.
 *   • Keepalive — socket keepalive + heartbeat prevent Railway's proxy
 *     from killing idle connections.
 *
 * Usage:
 *   const mongo = require('./mongoClient');
 *   await mongo.init();
 *   const db = mongo.db();          // MongoClient.db(dbName)
 *   const ready = mongo.isReady();  // fast boolean guard
 */

const { MongoClient } = require('mongodb');

// ── State ──────────────────────────────────────────────────────────────────────

let _client         = null;
let _db             = null;
let _ready          = false;
let _healthInterval = null;
let _reconnecting   = false;

// Track for logging — avoid spamming the same error every 30s
let _lastErrorMsg   = null;

// ── Config ─────────────────────────────────────────────────────────────────────

const HEALTH_CHECK_MS    = 30_000;  // check connection every 30 seconds
const IST_OFFSET_MS      = 5.5 * 60 * 60 * 1000;

// Active hours in IST — health check + reconnect only runs during this window.
// 07:00 IST (pre-market prep) to 23:45 IST (MCX closes 23:30 + 15m buffer).
// Outside this window, reconnect attempts are skipped to save resources.
const ACTIVE_START_MINS  = 7 * 60;         // 07:00 IST = 420 minutes
const ACTIVE_END_MINS    = 23 * 60 + 45;   // 23:45 IST = 1425 minutes

// ── Connection options ─────────────────────────────────────────────────────────

function _buildOptions() {
  return {
    // ── Timeouts ──────────────────────────────────────────────────────────
    // serverSelectionTimeoutMS: how long the driver waits to find a suitable
    // server. Set to 15s (up from 8s) to survive Atlas primary elections and
    // Railway network hiccups. The driver retries internally during this window.
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS:         10_000,
    socketTimeoutMS:          45_000,

    // ── Retry ─────────────────────────────────────────────────────────────
    retryWrites: true,
    retryReads:  true,

    // ── Keepalive ─────────────────────────────────────────────────────────
    // Railway's proxy may kill idle TCP connections after ~60s.
    // heartbeatFrequencyMS pings the server regularly so the connection
    // stays alive. Combined with socket keepalive, this prevents most
    // "connection closed" errors on idle periods.
    heartbeatFrequencyMS: 15_000,    // driver pings server every 15s (default 10s)

    // ── Connection pool ───────────────────────────────────────────────────
    // Small pool for a single-server trading dashboard.
    // maxPoolSize of 10 is plenty; minPoolSize of 2 keeps connections warm.
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 60_000,           // close idle connections after 60s

    // ── Compression ───────────────────────────────────────────────────────
    compressors: ['zstd', 'snappy'], // reduce bandwidth on Railway ↔ Atlas
  };
}

// ── Topology event handlers ──────────────────────────────────────────────────

function _attachTopologyListeners(client) {
  // The MongoDB driver emits these events on the client's topology:
  //   'serverHeartbeatSucceeded' — server is reachable
  //   'serverHeartbeatFailed'    — server heartbeat failed
  //   'topologyDescriptionChanged' — server set topology changed

  client.on('serverHeartbeatFailed', (event) => {
    if (_ready) {
      _ready = false;
      console.warn(`[MongoDB] ⚠️  Heartbeat failed (${event.failure?.message ?? 'unknown'}) — marking as disconnected`);
    }
  });

  client.on('serverHeartbeatSucceeded', () => {
    if (!_ready && _db) {
      _ready = true;
      _lastErrorMsg = null;
      console.log('[MongoDB] ✅ Heartbeat restored — connection is back');
    }
  });

  // Catch topology changes (e.g., Atlas primary stepdown)
  client.on('topologyDescriptionChanged', (event) => {
    const newDesc = event.newDescription;
    // Check if we have any usable servers
    const hasServer = [...(newDesc.servers?.values() ?? [])].some(
      (s) => s.type !== 'Unknown',
    );
    if (!hasServer && _ready) {
      _ready = false;
      console.warn('[MongoDB] ⚠️  No usable servers in topology — marking as disconnected');
    } else if (hasServer && !_ready && _db) {
      _ready = true;
      _lastErrorMsg = null;
      console.log('[MongoDB] ✅ Usable server found in topology — connection restored');
    }
  });

  // Client-level error — catch so it doesn't crash the process
  client.on('error', (err) => {
    console.error('[MongoDB] Client error event:', err.message);
  });
}

// ── Health check / auto-reconnect ────────────────────────────────────────────

/** Returns true if current IST time is within the active window (07:00–23:45). */
function _isActiveHours() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const mins   = nowIST.getHours() * 60 + nowIST.getMinutes();
  return mins >= ACTIVE_START_MINS && mins <= ACTIVE_END_MINS;
}

function _startHealthCheck() {
  if (_healthInterval) return;

  _healthInterval = setInterval(async () => {
    // Skip health check outside active hours (07:00–23:45 IST)
    // to avoid unnecessary Atlas pings and reconnect churn at night.
    if (!_isActiveHours()) return;

    // If already connected, run a quick ping to verify
    if (_ready && _client && _db) {
      try {
        await _db.command({ ping: 1 });
        // Connection is healthy — nothing to do
      } catch (err) {
        _ready = false;
        const msg = err.message;
        if (msg !== _lastErrorMsg) {
          console.warn(`[MongoDB] ⚠️  Health check ping failed: ${msg}`);
          _lastErrorMsg = msg;
        }
      }
      return;
    }

    // Not connected — attempt reconnect
    if (_reconnecting) return;
    _reconnecting = true;

    try {
      const uri = process.env.MONGODB_URI;
      if (!uri) { _reconnecting = false; return; }

      // Close old client if it exists
      if (_client) {
        try { await _client.close(true); } catch { /* force close */ }
        _client = null;
        _db     = null;
      }

      _client = new MongoClient(uri, _buildOptions());
      _attachTopologyListeners(_client);
      await _client.connect();

      const dbName = process.env.MONGODB_DB || 'twp';
      _db    = _client.db(dbName);
      _ready = true;
      _lastErrorMsg = null;

      console.log(`[MongoDB] ♻️  Reconnected → database: "${dbName}"`);
    } catch (err) {
      const msg = err.message;
      if (msg !== _lastErrorMsg) {
        console.warn(`[MongoDB] ⚠️  Reconnect failed: ${msg} — will retry in ${HEALTH_CHECK_MS / 1000}s`);
        _lastErrorMsg = msg;
      }
      _client = null;
      _db     = null;
      _ready  = false;
    } finally {
      _reconnecting = false;
    }
  }, HEALTH_CHECK_MS);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Connect to MongoDB using the MONGODB_URI env var.
 * Safe to call multiple times — only the first call connects.
 * Starts a background health check that auto-reconnects on failure.
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
    _client = new MongoClient(uri, _buildOptions());
    _attachTopologyListeners(_client);
    await _client.connect();

    // Database name from URI path or default to 'twp' (Trading With Purpose)
    const dbName = process.env.MONGODB_DB || 'twp';
    _db    = _client.db(dbName);
    _ready = true;
    _lastErrorMsg = null;

    console.log(`[MongoDB] Connected → database: "${dbName}"`);

    // Start background health check — auto-reconnects if connection drops
    _startHealthCheck();

    return true;
  } catch (err) {
    console.error('[MongoDB] Connection failed:', err.message);
    _client = null;
    _db     = null;
    _ready  = false;

    // Start health check even on initial failure — it will keep retrying
    _startHealthCheck();

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
  // Stop health check
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }

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
