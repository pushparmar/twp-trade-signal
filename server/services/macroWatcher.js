/**
 * MacroWatcher — subscribes VIX, Crude Oil, Gold, Silver, USDINR to KiteTicker,
 * seeds candleStore buffers, and broadcasts a macro_update SSE event
 * on every candle close — same pattern as indexSignalWatcher.
 *
 * Clients receive real-time macro analysis without polling.
 */

const candleStore    = require('./candleStore');
const { broadcast }  = require('../sseHub');
const { analyze, VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');

// Lazy-required to break the kiteTicker ↔ macroWatcher circular dependency.
// Importing at top-level captures a partial module.exports (subscribe undefined).
function _kiteTicker() {
  return require('./kiteTicker');
}

const MACRO_INTERVALS = ['15minute', '60minute', 'day'];

// Set of "token:interval" we care about — populated on start()
const _watchSet = new Set();

// token → instrument key mapping: { 264969: 'vix', 12345: 'crude', ... }
const _tokenToKey = new Map();

// Latest live prices: { vix, crude, gold, silver, usdinr }
const _prices = {};

// Debounce handle so we don't flood SSE on every tick
let _priceTimer = null;

/**
 * Called by kiteTicker on every raw tick for any macro token.
 * Updates live price and debounces a `macro_prices` SSE broadcast.
 */
let _tickLogCount = 0;
function onTick(token, lastPrice) {
  const key = _tokenToKey.get(Number(token));
  if (!key) return;
  _prices[key] = lastPrice;
  // Log first 3 ticks per instrument so you can confirm data is flowing
  if (_tickLogCount < 15) {
    console.log(`[MacroWatcher] tick — ${key}: ${lastPrice}`);
    _tickLogCount++;
  }

  if (_priceTimer) return; // already scheduled
  _priceTimer = setTimeout(() => {
    _priceTimer = null;
    broadcast('macro_prices', { ..._prices });
  }, 500); // batch ticks arriving within 500 ms
}

/**
 * Called by kiteTicker on every candle close.
 * Runs full macro analysis (signals + prices) and pushes to all SSE clients.
 */
async function onCandleClose(token, interval) {
  if (!_watchSet.has(`${Number(token)}:${interval}`)) return;
  try {
    const data = await analyze();
    broadcast('macro_update', data);
  } catch (err) {
    console.warn('[MacroWatcher] Analysis error:', err.message);
  }
}

// Cache of resolved macro tokens — populated by start(), reused by ensureSubscribed()
let _resolvedTokens = [];

/**
 * Idempotent: re-subscribe macro tokens to the live ticker.
 * Called both at boot (after WebSocket connects) and on every /api/macro/analysis
 * request as a safety net for the boot race condition.
 */
function ensureSubscribed() {
  if (!_resolvedTokens.length) return;
  _kiteTicker().subscribe(_resolvedTokens);
  console.log(`[MacroWatcher] ensureSubscribed — pushed ${_resolvedTokens.length} tokens to ticker`);
}

/**
 * Subscribe macro tokens to KiteTicker and pre-seed candleStore buffers.
 * Must be called after instrumentCache has loaded.
 */
function start() {
  const crudeInst  = getFrontMonthFutures('CRUDEOIL', 'MCX');
  const goldInst   = getFrontMonthFutures('GOLD',     'MCX');
  const silverInst = getFrontMonthFutures('SILVER',   'MCX');
  const usdinrInst = getFrontMonthFutures('USDINR',   'CDS');

  const tokens = [
    VIX_TOKEN,
    crudeInst?.instrumentToken,
    goldInst?.instrumentToken,
    silverInst?.instrumentToken,
    usdinrInst?.instrumentToken,
  ].filter(Boolean);

  // Build fast-lookup set and token→key map for live price updates
  _watchSet.clear();
  _tokenToKey.clear();
  for (const token of tokens) {
    for (const interval of MACRO_INTERVALS) {
      _watchSet.add(`${token}:${interval}`);
    }
  }
  _tokenToKey.set(VIX_TOKEN,                          'vix');
  if (crudeInst)  _tokenToKey.set(crudeInst.instrumentToken,  'crude');
  if (goldInst)   _tokenToKey.set(goldInst.instrumentToken,   'gold');
  if (silverInst) _tokenToKey.set(silverInst.instrumentToken, 'silver');
  if (usdinrInst) _tokenToKey.set(usdinrInst.instrumentToken, 'usdinr');

  // Cache tokens for later ensureSubscribed() calls
  _resolvedTokens = tokens;

  // Subscribe to live tick stream — may be deferred if WebSocket not yet connected
  _kiteTicker().subscribe(tokens);

  // Retry after 5s — twin purposes:
  //   1. Re-subscribe to WebSocket in case the initial subscribe() lost the race
  //      with the WebSocket connect event.
  //   2. Re-seed any candleStore buffer whose initial Kite API fetch failed
  //      (e.g. network blip on boot). The second attempt runs after the ticker
  //      is already live, so the fetch is more likely to succeed; and if it does,
  //      the first candle close will have historical data ready instead of an
  //      empty ring.
  setTimeout(() => {
    const t = _kiteTicker();
    if (t.isConnected()) {
      console.log('[MacroWatcher] Retrying subscribe 5s after start (safety net)');
      t.subscribe(tokens);
    }

    // Re-seed any buffer that hasn't been seeded yet (seededWith=0 means the
    // initial fetch either failed or is still in-flight — getCandles() is
    // idempotent and deduplicates concurrent requests via _seeding map).
    const s = candleStore.stats();
    console.log(`[MacroWatcher] 5s retry — candleStore has ${s.keys} keys, ${s.totalCandles} total candles`);
    for (const token of tokens) {
      for (const interval of MACRO_INTERVALS) {
        candleStore.getCandles(token, interval).catch((e) => {
          console.warn(`[MacroWatcher] Retry seed failed ${token}:${interval} —`, e.message);
        });
      }
    }
  }, 5000);

  // Pre-seed candle buffers so first candle close has data ready
  for (const token of tokens) {
    for (const interval of MACRO_INTERVALS) {
      candleStore.getCandles(token, interval).catch((e) => {
        console.warn(`[MacroWatcher] Seed failed ${token}:${interval} —`, e.message);
      });
    }
  }

  const names = [
    'VIX',
    crudeInst  ? 'Crude'  : null,
    goldInst   ? 'Gold'   : null,
    silverInst ? 'Silver' : null,
    usdinrInst ? 'USDINR' : null,
  ].filter(Boolean).join(', ');
  console.log(`[MacroWatcher] Ready — watching ${names} on 15m / 1h / 1d (tokens: ${tokens.join(', ')})`);
  if (!crudeInst)  console.warn('[MacroWatcher] CRUDEOIL not found in instrument cache (MCX)');
  if (!goldInst)   console.warn('[MacroWatcher] GOLD not found in instrument cache (MCX)');
  if (!silverInst) console.warn('[MacroWatcher] SILVER not found in instrument cache (MCX)');
  if (!usdinrInst) console.warn('[MacroWatcher] USDINR not found in instrument cache (CDS)');
}

module.exports = { start, ensureSubscribed, onTick, onCandleClose };
