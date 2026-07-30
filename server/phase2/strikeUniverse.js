/**
 * phase2/strikeUniverse.js
 *
 * Resolves the option-strike universe for the Phase-2 scanner:
 *
 *   Indices : NIFTY, BANKNIFTY, SENSEX
 *   Strikes : ATM ± 5 ITM / 2 OTM per option type (same range as index-trade)
 *   Expiries: current (nearest), next (second nearest), monthly
 *
 * Standalone — reads only from instrumentCache (via the additive
 * getOptionChainAllExpiries helper) and kiteService for LTP.
 *
 * Universe shape (per instrument):
 *   {
 *     token, tradingsymbol, index, strike, optionType,
 *     expiry, expiryBucket ('current'|'next'|'monthly'),
 *     exchange, lotSize, atmStrike
 *   }
 */

const kiteService = require('../services/kiteService');
const instrumentCache = require('../services/instrumentCache');

const INDICES = {
  NIFTY:     { ltpSymbol: 'NSE:NIFTY 50',   exchange: 'NFO', name: 'NIFTY',     step: 50 },
  BANKNIFTY: { ltpSymbol: 'NSE:NIFTY BANK', exchange: 'NFO', name: 'BANKNIFTY', step: 100 },
  SENSEX:    { ltpSymbol: 'BSE:SENSEX',     exchange: 'BFO', name: 'SENSEX',    step: 100 },
};

// Strike window relative to ATM — ±3 strikes per option type
const ITM_STRIKES = 3;
const OTM_STRIKES = 3;

// Universe cache — strikes shift with the underlying, so refresh periodically
const CACHE_TTL_MS = 5 * 60_000;
let _cache = null;
let _cacheAt = 0;

/**
 * Pick the three expiry buckets from a sorted list of expiry dates.
 *   current  — nearest expiry
 *   next     — second nearest
 *   monthly  — the LAST expiry within its calendar month (the monthly
 *              contract). Uses the nearest month whose monthly expiry is
 *              not already the current/next pick; falls back to the last
 *              expiry of the current expiry month.
 * Returns Map<expiryDate, bucketName> (deduped — an expiry keeps the
 * earliest bucket it qualifies for).
 */
function pickExpiryBuckets(expiries) {
  const buckets = new Map();
  if (expiries.length === 0) return buckets;

  const current = expiries[0];
  buckets.set(current, 'current');

  if (expiries[1] && !buckets.has(expiries[1])) {
    buckets.set(expiries[1], 'next');
  }

  // Group expiries by YYYY-MM and take the last of each month = monthly contract
  const byMonth = new Map();
  for (const e of expiries) {
    const month = e.slice(0, 7);
    const prev = byMonth.get(month);
    if (!prev || e > prev) byMonth.set(month, e);
  }
  const monthlies = [...byMonth.values()].sort();

  // First monthly that isn't already picked as current/next
  const monthly = monthlies.find((e) => !buckets.has(e)) ?? monthlies[0];
  if (monthly && !buckets.has(monthly)) {
    buckets.set(monthly, 'monthly');
  }

  return buckets;
}

/** Fetch the index LTP, with token-based fallback. */
async function fetchLtp(cfg) {
  try {
    const data = await kiteService.getLTP([cfg.ltpSymbol]);
    const entry = data[cfg.ltpSymbol] || Object.values(data)[0];
    if (entry?.last_price) return entry.last_price;
  } catch { /* fall through to token lookup */ }

  const [ex, sym] = cfg.ltpSymbol.split(':');
  const inst = instrumentCache.getBySymbol(ex, sym);
  if (inst?.instrumentToken) {
    const data = await kiteService.getLTP([String(inst.instrumentToken)]);
    const entry = Object.values(data)[0];
    if (entry?.last_price) return entry.last_price;
  }
  return null;
}

/** Build the strike universe for one index. Returns [] on failure. */
async function buildForIndex(indexKey) {
  const cfg = INDICES[indexKey];
  if (!cfg) return [];
  if (!instrumentCache.isLoaded()) return [];

  let ltp = null;
  try {
    ltp = await fetchLtp(cfg);
  } catch (err) {
    console.warn(`[Phase2Universe] LTP failed for ${indexKey}:`, err.message);
    return [];
  }
  if (!ltp) return [];

  const atmStrike = Math.round(ltp / cfg.step) * cfg.step;

  // Strike window: CE ITM = below ATM, OTM = above; PE mirrored.
  // Union window covers both option types.
  const minStrike = atmStrike - ITM_STRIKES * cfg.step;
  const maxStrike = atmStrike + ITM_STRIKES * cfg.step;

  const chain = instrumentCache.getOptionChainAllExpiries(cfg.name, cfg.exchange);
  if (!chain.length) return [];

  const expiries = [...new Set(chain.map((i) => i.expiry))].sort();
  const buckets = pickExpiryBuckets(expiries);

  const out = [];
  for (const inst of chain) {
    const bucket = buckets.get(inst.expiry);
    if (!bucket) continue;
    if (inst.strike < minStrike || inst.strike > maxStrike) continue;

    // Per-option-type window: CE keeps ATM−5..ATM+2, PE keeps ATM−2..ATM+5
    if (inst.instrumentType === 'CE') {
      if (inst.strike > atmStrike + OTM_STRIKES * cfg.step) continue;
    } else {
      if (inst.strike < atmStrike - OTM_STRIKES * cfg.step) continue;
    }

    out.push({
      token: inst.instrumentToken,
      tradingsymbol: inst.tradingsymbol,
      index: indexKey,
      strike: inst.strike,
      optionType: inst.instrumentType,
      expiry: inst.expiry,
      expiryBucket: bucket,
      exchange: inst.exchange,
      lotSize: inst.lotSize ?? null,
      atmStrike,
    });
  }

  return out;
}

/**
 * Build (or return cached) full universe across all three indices.
 * Returns { instruments: [], byIndex: { NIFTY: {atmStrike, ltp?}, ... }, builtAt }
 */
async function getUniverse(force = false) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  const results = await Promise.all(
    Object.keys(INDICES).map(async (idx) => {
      try {
        return await buildForIndex(idx);
      } catch (err) {
        console.warn(`[Phase2Universe] Build failed for ${idx}:`, err.message);
        return [];
      }
    }),
  );

  const instruments = results.flat();
  const byIndex = {};
  for (const idx of Object.keys(INDICES)) {
    const list = instruments.filter((i) => i.index === idx);
    byIndex[idx] = {
      count: list.length,
      atmStrike: list[0]?.atmStrike ?? null,
      expiries: [...new Set(list.map((i) => `${i.expiryBucket}:${i.expiry}`))].sort(),
    };
  }

  _cache = { instruments, byIndex, builtAt: now };
  _cacheAt = now;
  return _cache;
}

function clearCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { getUniverse, clearCache, INDICES };
