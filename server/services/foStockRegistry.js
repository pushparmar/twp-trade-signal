/**
 * F&O Stock Registry
 *
 * Maintains a persistent, on-disk list of NSE equity instruments that are
 * F&O-eligible (i.e., have active futures/options on NFO).
 *
 * WHY NSE EQUITY INSTEAD OF NFO FUTURES:
 *   Futures contracts expire every month (RELIANCE25MAYFUT → RELIANCE25JUNFUT).
 *   Each rollover means a new instrument token, so any cached candles, persisted
 *   scan alerts, or watchlist subscriptions from last month's contract become stale
 *   and return "Need at least 52 candles, got 0" from the Kite historical API.
 *
 *   The underlying NSE equity token (RELIANCE on NSE) is PERMANENT — it never
 *   changes. Using EQ tokens for scanning gives identical price action (the
 *   futures price tracks the cash price almost exactly) with zero rollover pain.
 *
 * STORAGE:  server/data/fo-stocks.json
 * FORMAT:   { builtAt: <epoch ms>, stocks: [{ name, tradingsymbol, instrumentToken,
 *                                             exchange, lotSize }] }
 *
 * LIFECYCLE:
 *   1. Server boot → load() reads the JSON file (fast, no auth required)
 *   2. After Kite auth + instrumentCache.load() → build() if file is missing,
 *      empty, or older than STALE_THRESHOLD_MS (~35 days)
 *   3. Manual monthly cross-check → POST /api/scan/refresh-fo-registry calls build()
 *
 * ADDING A NEW STOCK:
 *   Just call build() — it re-derives the full list from instrumentCache automatically.
 *   New NSE additions (e.g. a new F&O stock NSE announces) are picked up automatically.
 */

const fs   = require('fs');
const path = require('path');

const REGISTRY_PATH      = path.join(__dirname, '../data/fo-stocks.json');
const STALE_THRESHOLD_MS = 35 * 24 * 60 * 60 * 1000; // ~35 days — covers one full expiry cycle

// Indices have their own scan logic (patternAlertWatcher) — exclude from stock registry.
const INDEX_NAMES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']);

// In-memory cache filled by load() or build()
let _stocks   = [];   // [{ name, tradingsymbol, instrumentToken, exchange, lotSize }]
let _builtAt  = null; // epoch ms

// ── Disk helpers ──────────────────────────────────────────────────────────────

function _readDisk() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return null;
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function _writeDisk(data) {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load the registry from disk into memory.
 * Fast, synchronous, no auth required. Call on server start.
 */
function load() {
  const data = _readDisk();
  if (data && Array.isArray(data.stocks) && data.stocks.length > 0) {
    _stocks  = data.stocks;
    _builtAt = data.builtAt || null;
    console.log(`[FoRegistry] Loaded ${_stocks.length} F&O stocks from disk (built ${
      _builtAt ? new Date(_builtAt).toLocaleDateString('en-IN') : 'unknown'
    })`);
  } else {
    console.log('[FoRegistry] No registry on disk — will auto-build after Kite auth');
  }
}

/**
 * Build the registry from the live instrumentCache.
 *
 * For each F&O-eligible stock name (from NFO futures), find its permanent
 * NSE EQ instrument token. Saves to disk and refreshes the in-memory cache.
 *
 * Returns a diff report: { total, added, removed, missing }
 * 'missing' = names with an active future but no NSE EQ found (unusual, logged as warning).
 *
 * @throws if instrumentCache has not been loaded yet.
 */
function build() {
  // Late-require to avoid circular dependency at module load time
  const instrumentCache = require('./instrumentCache');

  if (!instrumentCache.isLoaded()) {
    throw new Error('[FoRegistry] instrumentCache not loaded — call instrumentCache.load() first');
  }

  const foNames = instrumentCache.getFutureNames(); // ['RELIANCE', 'TCS', 'INFY', ...]
  const prevByName = new Map(_stocks.map(s => [s.name, s]));

  const newStocks = [];
  const missing   = [];

  for (const name of foNames) {
    if (INDEX_NAMES.has(name)) continue;

    // Find the permanent NSE equity instrument for this name.
    // getNseEquity() tries exact tradingsymbol match first, then name-field match.
    const eq = instrumentCache.getNseEquity(name);
    if (!eq) {
      missing.push(name);
      continue;
    }

    // Carry over lot size from the current front-month future (for reference in
    // paper-trade risk calculation). Falls back to 1 if future not found.
    const fut     = instrumentCache.getFrontMonthFuture(name, 'NFO');
    const lotSize = fut?.lotSize ?? eq.lotSize ?? 1;

    newStocks.push({
      name,
      tradingsymbol:   eq.tradingsymbol,
      instrumentToken: eq.instrumentToken,
      exchange:        'NSE',
      lotSize,
    });
  }

  // Compute diff for the response
  const newByName  = new Map(newStocks.map(s => [s.name, s]));
  const added      = newStocks.filter(s => !prevByName.has(s.name)).map(s => s.name);
  const removed    = _stocks.filter(s => !newByName.has(s.name)).map(s => s.name);

  _stocks  = newStocks;
  _builtAt = Date.now();

  _writeDisk({ builtAt: _builtAt, stocks: _stocks });

  if (missing.length > 0) {
    console.warn(`[FoRegistry] No NSE EQ found for ${missing.length} name(s): ${missing.join(', ')}`);
  }
  console.log(
    `[FoRegistry] Built: ${_stocks.length} stocks — ` +
    `+${added.length} added, -${removed.length} removed, ${missing.length} missing`
  );

  return { total: _stocks.length, added, removed, missing };
}

/**
 * Return the full list of F&O-eligible NSE equity instruments.
 *
 * If the in-memory list is empty but instrumentCache is ready, auto-builds
 * synchronously (first-boot case where the disk file didn't exist yet).
 *
 * Returns [{ name, tradingsymbol, instrumentToken, exchange: 'NSE', lotSize }]
 */
function getAll() {
  if (_stocks.length === 0) {
    try {
      const instrumentCache = require('./instrumentCache');
      if (instrumentCache.isLoaded()) {
        console.log('[FoRegistry] In-memory list empty — building now from instrumentCache');
        build();
      }
    } catch (err) {
      console.warn('[FoRegistry] Auto-build failed:', err.message);
    }
  }
  return _stocks;
}

/**
 * True if the registry is stale (>35 days since last build) — used on boot
 * to decide whether to auto-refresh.
 */
function isStale() {
  if (!_builtAt) return true;
  return (Date.now() - _builtAt) > STALE_THRESHOLD_MS;
}

function getStats() {
  return {
    total:    _stocks.length,
    builtAt:  _builtAt,
    isStale:  isStale(),
  };
}

function getByToken(token) {
  const numToken = Number(token);
  return _stocks.find((s) => s.instrumentToken === numToken) || null;
}

module.exports = { load, build, getAll, getByToken, isStale, getStats };
