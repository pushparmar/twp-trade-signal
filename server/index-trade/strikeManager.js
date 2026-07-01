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
const REFRESH_MS   = 5 * 60_000; // refresh every 5 minutes
const SEED_INTERVALS = ['minute', '5minute', '15minute', '60minute'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Strike subscription limits relative to ATM
const OTM_STRIKES = 2;  // 2 strikes OTM (above ATM for CE, below ATM for PE)
const ITM_STRIKES = 5;  // 5 strikes ITM (below ATM for CE, above ATM for PE)

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
let _openTradeTokens = new Set(); // tokens for open trades — always stay subscribed

// ── Core logic ──────────────────────────────────────────────────────────────

/**
 * Subscribe to strikes around ATM: OTM_STRIKES out-of-the-money, ITM_STRIKES in-the-money.
 * For CE: ITM = below ATM, OTM = above ATM
 * For PE: ITM = above ATM, OTM = below ATM
 * Combined: ATM ± max(OTM, ITM) strikes, then filter per option type.
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

  // Check if ATM hasn't changed significantly (within one step)
  const prev = _subscriptions.get(indexName);
  if (prev && Math.abs(prev.atmStrike - atmStrike) < cfg.step) return;

  // Resolve instruments from cache — current + next week expiry
  if (!instrumentCache.isLoaded()) {
    console.warn(`[IdxStrike] Instrument cache not loaded — skipping ${indexName}`);
    return;
  }

  const currentExpiry = instrumentCache.getAllOptionsForCurrentExpiry(cfg.name, cfg.exchange);
  const nextExpiry = instrumentCache.getAllOptionsForNextExpiry(cfg.name, cfg.exchange);
  const allOptions = [...currentExpiry, ...nextExpiry];

  if (allOptions.length === 0) {
    console.warn(`[IdxStrike] No instruments found for ${indexName}`);
    return;
  }

  // Filter strikes: OTM_STRIKES out, ITM_STRIKES in (relative to ATM per option type)
  // CE: strikes from (ATM - ITM*step) to (ATM + OTM*step)
  // PE: strikes from (ATM - OTM*step) to (ATM + ITM*step)
  const ceMinStrike = atmStrike - (ITM_STRIKES * cfg.step);
  const ceMaxStrike = atmStrike + (OTM_STRIKES * cfg.step);
  const peMinStrike = atmStrike - (OTM_STRIKES * cfg.step);
  const peMaxStrike = atmStrike + (ITM_STRIKES * cfg.step);

  const instruments = allOptions.filter(i => {
    if (i.instrumentType === 'CE') {
      return i.strike >= ceMinStrike && i.strike <= ceMaxStrike;
    } else if (i.instrumentType === 'PE') {
      return i.strike >= peMinStrike && i.strike <= peMaxStrike;
    }
    return false;
  });

  if (instruments.length === 0) {
    console.warn(`[IdxStrike] No instruments in range for ${indexName} ATM ${atmStrike}`);
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
  // BUT keep tokens that have open trades — never unsubscribe those
  const oldTokens = prev ? [...prev.instruments.keys()] : [];
  const newTokens = [...instrumentMap.keys()];
  const toUnsub = oldTokens.filter(t => !instrumentMap.has(t) && !_openTradeTokens.has(t));
  const toSub   = newTokens.filter(t => !prev?.instruments.has(t));

  if (toUnsub.length > 0) {
    try { kiteTicker.unsubscribe(toUnsub); } catch { /* ignore */ }
    toUnsub.forEach(t => _allTokens.delete(t));
    console.log(`[IdxStrike] Unsubscribed ${toUnsub.length} old tokens`);
  }

  if (toSub.length > 0) {
    try { kiteTicker.subscribe(toSub); } catch { /* ignore */ }
    toSub.forEach(t => _allTokens.add(t));

    // Seed candle buffers for new tokens (fire-and-forget)
    // Only seed 5minute for broad scanning — 1m is too heavy for 100+ tokens
    for (const token of toSub) {
      candleStore.getCandles(token, '5minute', 300, false).catch(() => {});
    }
  }

  // Collect unique expiries for logging
  const expiries = [...new Set(instruments.map(i => i.expiry).filter(Boolean))].sort();

  _subscriptions.set(indexName, {
    atmStrike,
    ltp: Math.round(ltp * 100) / 100,
    instruments: instrumentMap,
    expiry: expiries[0] || null,
    expiries, // store all expiries
  });

  console.log(
    `[IdxStrike] ${indexName} ATM ${atmStrike} — subscribed ${instrumentMap.size} instruments (ITM ${ITM_STRIKES}, OTM ${OTM_STRIKES})` +
    ` expiries=${expiries.join(', ') || 'unknown'}`,
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
 * Groups by index → expiry → strike, pairs CE/PE with current LTP from candleStore.
 *
 * Returns: {
 *   NIFTY: { atmStrike, spotLtp, expiries: [
 *     { expiry: '2026-07-03', strikes: [
 *       { strike: 24500, ce: { token, symbol, ltp }, pe: { token, symbol, ltp } },
 *       ...
 *     ]},
 *     { expiry: '2026-07-10', strikes: [...] }
 *   ]},
 *   SENSEX: { ... }
 * }
 */
function getOptionChain() {
  const result = {};
  for (const [indexName, data] of _subscriptions) {
    // Group instruments by expiry → strike
    const byExpiry = new Map();

    for (const inst of data.instruments.values()) {
      const exp = inst.expiry || 'unknown';
      if (!byExpiry.has(exp)) byExpiry.set(exp, new Map());
      const byStrike = byExpiry.get(exp);
      if (!byStrike.has(inst.strike)) byStrike.set(inst.strike, {});

      let currentLtp = null;
      let dayOpen = null;
      let dayHigh = null;
      let dayLow = null;
      let changePct = null;

      // Try minute candles first (live market), fall back to 5minute
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
        expiry: inst.expiry,
      };
    }

    // Build expiries array sorted by date
    const expiries = [...byExpiry.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([expiry, strikeMap]) => ({
        expiry,
        strikes: [...strikeMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([strike, sides]) => ({ strike, ce: sides.ce || null, pe: sides.pe || null })),
      }));

    result[indexName] = {
      atmStrike: data.atmStrike,
      spotLtp: data.ltp,
      expiries,
    };
  }
  return result;
}

/**
 * Register a token as having an open trade — ensures it stays subscribed
 * even if ATM shifts and the strike falls out of range.
 */
function registerOpenTradeToken(token) {
  const numToken = Number(token);
  if (!numToken) return;

  _openTradeTokens.add(numToken);

  // If not already subscribed, subscribe now
  if (!_allTokens.has(numToken)) {
    try {
      kiteTicker.subscribe([numToken]);
      _allTokens.add(numToken);
      console.log(`[IdxStrike] Subscribed open-trade token ${numToken} (out of ATM range)`);

      // Seed candle buffers
      for (const interval of SEED_INTERVALS) {
        candleStore.getCandles(numToken, interval, 300, false).catch(() => {});
      }
    } catch (err) {
      console.warn(`[IdxStrike] Failed to subscribe open-trade token ${numToken}:`, err.message);
    }
  }
}

/**
 * Unregister a token when its trade is closed — allows it to be unsubscribed
 * if it's out of the ATM range.
 */
function unregisterOpenTradeToken(token) {
  const numToken = Number(token);
  if (!numToken) return;

  _openTradeTokens.delete(numToken);

  // Check if this token is still in any subscription map
  let stillInRange = false;
  for (const [, data] of _subscriptions) {
    if (data.instruments.has(numToken)) {
      stillInRange = true;
      break;
    }
  }

  // If out of range and no longer has open trade, unsubscribe
  if (!stillInRange && _allTokens.has(numToken)) {
    try {
      kiteTicker.unsubscribe([numToken]);
      _allTokens.delete(numToken);
      console.log(`[IdxStrike] Unsubscribed closed-trade token ${numToken} (out of ATM range)`);
    } catch { /* ignore */ }
  }
}

/**
 * Get all open trade tokens (for debugging).
 */
function getOpenTradeTokens() {
  return [..._openTradeTokens];
}

module.exports = {
  start, stop, refresh: _refresh,
  getStatus, getInstrumentByToken, getAllTokens, isOurToken, getOptionChain,
  registerOpenTradeToken, unregisterOpenTradeToken, getOpenTradeTokens,
};
