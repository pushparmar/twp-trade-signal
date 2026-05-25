/**
 * strikeManager.js — Index Trade module
 *
 * Resolves ATM ± 5 strikes for NIFTY and SENSEX, subscribes their
 * instrument tokens to the live ticker, and refreshes when ATM shifts.
 *
 * Imports from outside (read-only):
 *   kiteService, instrumentCache, kiteTicker, candleStore, atmResolver
 */

const kiteService     = require('../services/kiteService');
const instrumentCache = require('../services/instrumentCache');
const kiteTicker      = require('../services/kiteTicker');
const candleStore     = require('../services/candleStore');
const { INDEX_CONFIG } = require('../services/atmResolver');
const { isNseOpen }   = require('../utils/marketHours');

// Indices to trade — NIFTY (NFO) and SENSEX (BFO)
const INDICES = ['NIFTY', 'SENSEX'];
const STRIKE_RANGE = 5;          // ATM ± 5
const REFRESH_MS   = 5 * 60_000; // refresh every 5 minutes
const SEED_INTERVALS = ['minute', '5minute', '15minute'];

// ── State ───────────────────────────────────────────────────────────────────

// { NIFTY: { atmStrike, ltp, instruments: Map<token, instrumentInfo> }, ... }
const _subscriptions = new Map();
let _refreshTimer = null;
let _allTokens = new Set(); // all currently subscribed tokens

// ── Core logic ──────────────────────────────────────────────────────────────

/**
 * Resolve ATM ± 5 strikes for a single index and subscribe tokens.
 */
async function _refreshIndex(indexName) {
  const cfg = INDEX_CONFIG[indexName];
  if (!cfg) return;

  // Get current LTP
  let ltp = null;
  try {
    const ltpData = await kiteService.getLTP([cfg.ltpSymbol]);
    const entry = ltpData[cfg.ltpSymbol] || Object.values(ltpData)[0];
    ltp = entry?.last_price ?? null;
  } catch (err) {
    console.warn(`[IdxStrike] LTP fetch failed for ${indexName}:`, err.message);
    return;
  }
  if (!ltp) return;

  const atmStrike = Math.round(ltp / cfg.step) * cfg.step;

  // Check if ATM hasn't changed
  const prev = _subscriptions.get(indexName);
  if (prev && prev.atmStrike === atmStrike) return;

  // Generate strike array: ATM - 5*step ... ATM + 5*step
  const strikes = [];
  for (let i = -STRIKE_RANGE; i <= STRIKE_RANGE; i++) {
    strikes.push(atmStrike + i * cfg.step);
  }

  // Resolve instruments from cache (nearest expiry CE + PE for each strike)
  if (!instrumentCache.isLoaded()) {
    console.warn(`[IdxStrike] Instrument cache not loaded — skipping ${indexName}`);
    return;
  }
  const instruments = instrumentCache.getOptionsByStrike(cfg.name, cfg.exchange, strikes);
  if (instruments.length === 0) {
    console.warn(`[IdxStrike] No instruments found for ${indexName} ATM ${atmStrike}`);
    return;
  }

  // Build instrument map
  const instrumentMap = new Map();
  for (const inst of instruments) {
    instrumentMap.set(inst.instrumentToken, {
      token: inst.instrumentToken,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      optionType: inst.instrumentType, // 'CE' | 'PE'
      exchange: inst.exchange,
      lotSize: inst.lotSize || 1,
      expiry: inst.expiry,
      index: indexName,
    });
  }

  // Unsubscribe old tokens that are no longer in the new set
  const oldTokens = prev ? [...prev.instruments.keys()] : [];
  const newTokens = [...instrumentMap.keys()];
  const toUnsub = oldTokens.filter(t => !instrumentMap.has(t));
  const toSub   = newTokens.filter(t => !prev?.instruments.has(t));

  if (toUnsub.length > 0) {
    try { kiteTicker.unsubscribe(toUnsub); } catch { /* ignore */ }
    toUnsub.forEach(t => _allTokens.delete(t));
  }

  if (toSub.length > 0) {
    try { kiteTicker.subscribe(toSub); } catch { /* ignore */ }
    toSub.forEach(t => _allTokens.add(t));

    // Seed candle buffers for new tokens (fire-and-forget)
    for (const token of toSub) {
      for (const interval of SEED_INTERVALS) {
        candleStore.getCandles(token, interval, 300, false).catch(() => {});
      }
    }
  }

  _subscriptions.set(indexName, {
    atmStrike,
    ltp: Math.round(ltp * 100) / 100,
    instruments: instrumentMap,
  });

  console.log(
    `[IdxStrike] ${indexName} ATM ${atmStrike} — subscribed ${instrumentMap.size} instruments` +
    (toSub.length > 0 ? ` (+${toSub.length} new)` : '') +
    (toUnsub.length > 0 ? ` (-${toUnsub.length} removed)` : ''),
  );
}

async function _refresh() {
  // Always resolve strikes — option chain must be visible even after market hours.
  // Scanner and orderManager have their own isNseOpen() gates for trading logic.
  if (!instrumentCache.isLoaded()) return;
  for (const index of INDICES) {
    await _refreshIndex(index);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function start() {
  // Initial refresh
  _refresh().catch(err => console.warn('[IdxStrike] Initial refresh failed:', err.message));
  // Periodic refresh
  _refreshTimer = setInterval(() => {
    _refresh().catch(err => console.warn('[IdxStrike] Refresh failed:', err.message));
  }, REFRESH_MS);
  console.log('[IdxStrike] Strike manager started');
}

function stop() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  // Unsubscribe all tokens
  const tokens = [..._allTokens];
  if (tokens.length > 0) {
    try { kiteTicker.unsubscribe(tokens); } catch { /* ignore */ }
  }
  _allTokens.clear();
  _subscriptions.clear();
}

/**
 * Returns current subscriptions for UI display.
 * { NIFTY: { atmStrike, ltp, tokenCount, strikes }, SENSEX: { ... } }
 */
function getStatus() {
  const result = {};
  for (const [index, data] of _subscriptions) {
    const strikes = new Set();
    for (const inst of data.instruments.values()) {
      strikes.add(inst.strike);
    }
    result[index] = {
      atmStrike: data.atmStrike,
      ltp: data.ltp,
      tokenCount: data.instruments.size,
      strikeCount: strikes.size,
    };
  }
  return result;
}

/**
 * Reverse lookup: given a token, return instrument info.
 */
function getInstrumentByToken(token) {
  const numToken = Number(token);
  for (const [, data] of _subscriptions) {
    const inst = data.instruments.get(numToken);
    if (inst) return inst;
  }
  return null;
}

/**
 * Returns all subscribed tokens as an array.
 */
function getAllTokens() {
  return [..._allTokens];
}

/**
 * Check if a token is one of our subscribed option instruments.
 */
function isOurToken(token) {
  return _allTokens.has(Number(token));
}

/**
 * Returns the full option chain for UI display.
 * Groups by index → strike, pairs CE/PE with current LTP from candleStore.
 *
 * Returns: {
 *   NIFTY: { atmStrike, ltp, expiry, strikes: [
 *     { strike: 24500, ce: { token, symbol, ltp }, pe: { token, symbol, ltp } },
 *     ...
 *   ]},
 *   SENSEX: { ... }
 * }
 */
function getOptionChain() {
  const result = {};
  for (const [indexName, data] of _subscriptions) {
    // Group instruments by strike
    const byStrike = new Map();
    let expiry = null;
    for (const inst of data.instruments.values()) {
      if (!byStrike.has(inst.strike)) byStrike.set(inst.strike, {});

      let currentLtp = null;
      let dayOpen = null;
      let dayHigh = null;
      let dayLow = null;
      let changePct = null;

      // Try minute candles first (live market), fall back to 5minute, then day candle
      const minuteCandles = candleStore.getCandlesSync(inst.token, 'minute');
      const fiveMinCandles = candleStore.getCandlesSync(inst.token, '5minute');

      const candles = (minuteCandles && minuteCandles.length > 0)
        ? minuteCandles
        : (fiveMinCandles && fiveMinCandles.length > 0)
          ? fiveMinCandles
          : null;

      if (candles && candles.length > 0) {
        currentLtp = candles[candles.length - 1].close;
        dayOpen = candles[0].open;
        dayHigh = -Infinity;
        dayLow = Infinity;
        for (const c of candles) {
          if (c.high > dayHigh) dayHigh = c.high;
          if (c.low < dayLow) dayLow = c.low;
        }
        if (dayOpen > 0) {
          changePct = +((currentLtp - dayOpen) / dayOpen * 100).toFixed(2);
        }
      }

      const side = inst.optionType === 'CE' ? 'ce' : 'pe';
      byStrike.get(inst.strike)[side] = {
        token: inst.token,
        symbol: inst.tradingsymbol,
        ltp: currentLtp,
        dayOpen,
        dayHigh,
        dayLow,
        changePct,
      };
      if (!expiry && inst.expiry) expiry = inst.expiry;
    }

    // Sort strikes ascending
    const strikes = [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, sides]) => ({ strike, ce: sides.ce || null, pe: sides.pe || null }));

    result[indexName] = {
      atmStrike: data.atmStrike,
      spotLtp: data.ltp,
      expiry,
      strikes,
    };
  }
  return result;
}

module.exports = { start, stop, getStatus, getInstrumentByToken, getAllTokens, isOurToken, getOptionChain };
