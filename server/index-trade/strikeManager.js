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
const SEED_INTERVALS = ['minute', '5minute', '15minute', '60minute'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Morning reset fires at 9:20 IST — opening price has settled by then
const MORNING_RESET_HOUR_IST   = 9;
const MORNING_RESET_MINUTE_IST = 20;

// ── State ───────────────────────────────────────────────────────────────────

// { NIFTY: { atmStrike, ltp, instruments: Map<token, instrumentInfo> }, ... }
const _subscriptions = new Map();
let _refreshTimer     = null;
let _morningTimer     = null; // fires daily at 9:20 IST
let _lastMorningReset = null; // IST date string of last reset e.g. '2026-05-26'
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

/**
 * Full morning reset — clears all existing subscriptions so ATM is
 * re-resolved from scratch against today's opening price.
 * Called once per trading day at 9:20 IST.
 */
async function _morningReset() {
  const nowIST   = new Date(Date.now() + IST_OFFSET_MS);
  const todayStr = nowIST.toISOString().slice(0, 10);
  const dayOfWeek = nowIST.getDay(); // 0=Sun, 6=Sat

  // Skip weekends and repeat calls on same day
  if (dayOfWeek === 0 || dayOfWeek === 6) return;
  if (_lastMorningReset === todayStr) return;
  _lastMorningReset = todayStr;

  console.log(`[IdxStrike] Morning reset ${todayStr} — clearing subscriptions and re-resolving ATM from opening price`);

  // Unsubscribe all existing tokens first so _refreshIndex treats everything as new
  const oldTokens = [..._allTokens];
  if (oldTokens.length > 0) {
    try { kiteTicker.unsubscribe(oldTokens); } catch { /* ignore */ }
  }
  _allTokens.clear();
  _subscriptions.clear();

  // Re-resolve from fresh opening LTP
  if (!instrumentCache.isLoaded()) return;
  for (const index of INDICES) {
    await _refreshIndex(index);
  }

  // Also clear scanner dedup so patterns fire fresh on the new day
  try {
    const scanner = require('./scanner');
    scanner.clearDedup();
    console.log('[IdxStrike] Scanner dedup cleared for new trading day');
  } catch { /* scanner may not be started yet */ }
}

/**
 * Returns milliseconds until the next 9:20 IST on a weekday.
 */
function _msUntilMorningReset() {
  const nowIST    = new Date(Date.now() + IST_OFFSET_MS);
  const target    = new Date(nowIST);
  target.setHours(MORNING_RESET_HOUR_IST, MORNING_RESET_MINUTE_IST, 0, 0);

  // If we're already past 9:20 today, schedule for tomorrow
  if (nowIST >= target) target.setDate(target.getDate() + 1);

  // Skip to Monday if target falls on weekend
  const day = target.getDay();
  if (day === 0) target.setDate(target.getDate() + 1); // Sun → Mon
  if (day === 6) target.setDate(target.getDate() + 2); // Sat → Mon

  // Convert back: target is in IST, subtract offset to get UTC ms from now
  const targetUtcMs = target.getTime() - IST_OFFSET_MS;
  return Math.max(0, targetUtcMs - Date.now());
}

function _scheduleMorningReset() {
  const msUntil = _msUntilMorningReset();
  const hh = Math.floor(msUntil / 3_600_000);
  const mm = Math.floor((msUntil % 3_600_000) / 60_000);
  console.log(`[IdxStrike] Morning reset scheduled in ${hh}h ${mm}m (9:20 IST)`);

  _morningTimer = setTimeout(() => {
    _morningReset().catch(err => console.warn('[IdxStrike] Morning reset failed:', err.message));
    // Re-schedule for the next day
    _scheduleMorningReset();
  }, msUntil);
}

// ── Public API ──────────────────────────────────────────────────────────────

function start() {
  // Initial refresh
  _refresh().catch(err => console.warn('[IdxStrike] Initial refresh failed:', err.message));

  // Periodic ATM shift refresh every 5 min
  _refreshTimer = setInterval(() => {
    _refresh().catch(err => console.warn('[IdxStrike] Refresh failed:', err.message));
  }, REFRESH_MS);

  // Daily 9:20 IST morning reset — re-resolves ATM from opening price
  _scheduleMorningReset();

  console.log('[IdxStrike] Strike manager started');
}

function stop() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  if (_morningTimer) {
    clearTimeout(_morningTimer);
    _morningTimer = null;
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

module.exports = { start, stop, refresh: _refresh, getStatus, getInstrumentByToken, getAllTokens, isOurToken, getOptionChain };
