const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { getConfig } = require('../store');

let _instruments = [];
let _lastLoaded = null;
let _loading = false;

/**
 * Download and cache the full Kite instruments CSV.
 * Called once on server start (after Kite auth) and refreshed daily.
 */
async function load() {
  if (_loading) return;
  _loading = true;

  const { kite } = getConfig();
  if (!kite.apiKey || !kite.accessToken) {
    console.warn('[InstrumentCache] Kite not authenticated — skipping load');
    _loading = false;
    return;
  }

  try {
    console.log('[InstrumentCache] Downloading instruments CSV...');
    const response = await axios.get('https://api.kite.trade/instruments', {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
      },
      timeout: 30_000,
      responseType: 'text',
    });

    const rows = parse(response.data, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    _instruments = rows.map((r) => ({
      instrumentToken: Number(r.instrument_token),
      exchangeToken: Number(r.exchange_token),
      tradingsymbol: r.tradingsymbol,
      name: r.name || '',
      lastPrice: Number(r.last_price) || 0,
      expiry: r.expiry || '',
      strike: Number(r.strike) || 0,
      tickSize: Number(r.tick_size) || 0.05,
      lotSize: Number(r.lot_size) || 1,
      instrumentType: r.instrument_type || '',
      segment: r.segment || '',
      exchange: r.exchange || '',
    }));

    _lastLoaded = Date.now();
    console.log(`[InstrumentCache] Loaded ${_instruments.length} instruments`);
  } catch (err) {
    console.error('[InstrumentCache] Failed to load instruments:', err.message);
  } finally {
    _loading = false;
  }
}

/**
 * Search instruments by tradingsymbol substring.
 * Optionally filter by exchange (e.g. "NFO", "NSE").
 * Returns top 20 matches.
 */
function search(query, exchange = '') {
  if (!query || query.length < 2) return [];
  const q = query.toUpperCase();
  const results = _instruments.filter((i) => {
    const matchSymbol = i.tradingsymbol.includes(q) || i.name.toUpperCase().includes(q);
    const matchExchange = exchange ? i.exchange === exchange : true;
    return matchSymbol && matchExchange;
  });
  return results.slice(0, 20);
}

/**
 * Find the front-month futures contract for a given instrument name + exchange.
 *
 * Strategy (in order):
 *   1. Exact match on the `name` field  (e.g. name === "CRUDEOIL")
 *   2. Tradingsymbol starts with name + digit  (e.g. "CRUDEOIL25MAY")
 *      — the digit guard avoids GOLDM when searching for GOLD.
 *
 * No result cap — scans the full instrument list.
 */
function getFrontMonthFuture(name, exchange) {
  const n = name.toUpperCase();

  // 1. Exact name field match
  let futures = _instruments.filter(
    (i) => i.name.toUpperCase() === n
        && i.exchange === exchange
        && i.instrumentType === 'FUT'
        && i.expiry,
  );

  // 2. Tradingsymbol prefix + digit fallback
  //    Matches "CRUDEOIL25MAY" but not "CRUDEOILM25MAY";
  //    matches "GOLD25APR" but not "GOLDM25APR".
  if (!futures.length) {
    const re = new RegExp(`^${n}\\d`, 'i');
    futures = _instruments.filter(
      (i) => re.test(i.tradingsymbol)
          && i.exchange === exchange
          && i.instrumentType === 'FUT'
          && i.expiry,
    );
  }

  if (!futures.length) {
    console.warn(`[InstrumentCache] getFrontMonthFuture: no FUT found for "${name}" on ${exchange}`);
    return null;
  }

  futures.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
  return futures[0];
}

/**
 * Exact lookup by exchange + tradingsymbol.
 * Returns the instrument object or null.
 */
function getBySymbol(exchange, tradingsymbol) {
  return _instruments.find(
    (i) => i.exchange === exchange && i.tradingsymbol === tradingsymbol,
  ) || null;
}

/**
 * Lookup by instrument token.
 */
function getByToken(instrumentToken) {
  return _instruments.find((i) => i.instrumentToken === Number(instrumentToken)) || null;
}

/**
 * Find CE and PE options for given strike values, filtered to nearest future expiry.
 * name: e.g. 'NIFTY', exchange: e.g. 'NFO', strikeValues: [24000, 24050, ...]
 */
function getOptionsByStrike(name, exchange, strikeValues) {
  const today = new Date().toISOString().split('T')[0];
  const strikeSet = new Set(strikeValues);
  const candidates = _instruments.filter(
    (i) =>
      i.name === name &&
      i.exchange === exchange &&
      (i.instrumentType === 'CE' || i.instrumentType === 'PE') &&
      strikeSet.has(i.strike) &&
      (!i.expiry || i.expiry >= today),
  );
  if (!candidates.length) return [];
  const expiries = [...new Set(candidates.map((i) => i.expiry).filter(Boolean))].sort();
  const nearest = expiries[0];
  return candidates.filter((i) => i.expiry === nearest);
}

/**
 * Find the permanent NSE EQ instrument for a given F&O stock name.
 *
 * This is the key helper for the F&O stock registry. It resolves an F&O
 * name (e.g. "RELIANCE") to the NSE cash equity instrument whose token
 * never changes — unlike monthly futures contracts.
 *
 * Strategy (tried in order):
 *   1. Exact tradingsymbol match on NSE (instrumentType === 'EQ')
 *   2. Name-field match on NSE (handles edge cases like 'M&MFIN' where
 *      the futures `name` field is the same as the equity tradingsymbol)
 *
 * Returns null if no NSE EQ is found (unusual — logged as a warning by caller).
 */
function getNseEquity(name) {
  const n = name.toUpperCase();

  // 1. Exact tradingsymbol match (covers >95% of F&O stocks)
  const bySymbol = _instruments.find(
    (i) => i.exchange === 'NSE'
         && i.instrumentType === 'EQ'
         && i.tradingsymbol.toUpperCase() === n,
  );
  if (bySymbol) return bySymbol;

  // 2. Name-field match — fallback for stocks where futures `name` ≠ tradingsymbol
  return _instruments.find(
    (i) => i.exchange === 'NSE'
         && i.instrumentType === 'EQ'
         && i.name.toUpperCase() === n,
  ) || null;
}

/**
 * Return sorted list of unique stock names that have active futures on NFO.
 * Excludes index futures (NIFTY, BANKNIFTY, etc.).
 */
function getFutureNames() {
  const today = new Date().toISOString().split('T')[0];
  const indexNames = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']);
  const seen = new Set();
  for (const i of _instruments) {
    if (
      i.exchange === 'NFO' &&
      i.instrumentType === 'FUT' &&
      i.expiry >= today &&
      i.name &&
      !indexNames.has(i.name)
    ) {
      seen.add(i.name);
    }
  }
  return [...seen].sort();
}

function getNearestATMOption(name, exchange, spotPrice, optionType) {
  const today = new Date().toISOString().split('T')[0];
  const candidates = _instruments.filter(
    (i) =>
      i.name === name &&
      i.exchange === exchange &&
      i.instrumentType === optionType &&
      (!i.expiry || i.expiry >= today),
  );
  if (!candidates.length) return null;

  const expiries = [...new Set(candidates.map((i) => i.expiry).filter(Boolean))].sort();
  const nearest = expiries[0];
  const expiryFiltered = candidates.filter((i) => i.expiry === nearest);

  expiryFiltered.sort(
    (a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice),
  );
  return expiryFiltered[0] || null;
}

// ── Patterns that identify non-equity instruments mis-tagged as EQ on NSE ──────
// Kite's instrument dump marks several debt/bond/ETF instruments as exchange=NSE,
// instrumentType=EQ. These are NOT tradeable equity stocks and should be excluded
// from the equity scan universe.
//
// Excluded categories:
//   GOI / government loans  — "GOI", "LOAN" in name  (e.g. "7.17GS2028")
//   Sovereign Gold Bonds    — "SGB" prefix in symbol
//   ETFs                    — "ETF", "BEES", "NIFTY" at start (index ETFs)
//   Bonds / debentures      — "BOND", "NCD", "SERIES", "SECURED", "UNSECURED" in name
//   REITs / InvITs          — "REIT", "INVIT" in name
//   Symbols with % or rate  — trading symbols containing digits mid-string
//     (e.g. "7.17GS2028", "6.84GS2022") are government securities
const _EQUITY_EXCLUDE_NAME = /GOI|LOAN|BOND|DEBENTURE|NCD|SERIES[- ]|REIT|INVIT|SGB|SECURED|UNSECURED|TBILL|GSEC/i;
const _EQUITY_EXCLUDE_SYM  = /^(NIFTY|SGB|LIQUIDBEES|GOLDBEES|JUNIORBEES|BANKBEES|SETFNN50|KOTAKBKETF|N100|MOM|NV20|MIDCAP|SMALLCAP|CPSE)/i;
// Government securities have rate+tenor in symbol: digits followed by GS/SDL/TB
// Also exclude pure numeric symbols (bonds) and symbols with dashes followed by numbers (bond series)
const _GOVT_SEC_SYM        = /^\d+\.?\d*(GS|SDL|TB|OIL|CS|RF)\d*|^\d+$|[-]\d+$/i;

/**
 * getAllNseEquity — returns ALL NSE EQ instruments (F&O and non-F&O alike),
 * excluding non-equity instruments (GOI bonds, ETFs, SGBs, debentures).
 *
 * Sort order: F&O-eligible stocks first (most liquid, reliable candle data),
 * then remaining NSE EQ stocks alphabetically by trading symbol.
 *
 * @returns {object[]} Array of instrument objects with instrumentToken, tradingsymbol, exchange, name
 */
function getAllNseEquity() {
  const all = _instruments.filter((i) => {
    if (i.exchange !== 'NSE' || i.instrumentType !== 'EQ') return false;
    const sym  = String(i.tradingsymbol ?? '');
    const name = String(i.name ?? '');
    // Exclude government bonds, ETFs, debentures, REITs
    if (_EQUITY_EXCLUDE_NAME.test(name))  return false;
    if (_EQUITY_EXCLUDE_SYM.test(sym))    return false;
    if (_GOVT_SEC_SYM.test(sym))          return false;
    return true;
  });
  const foNames = new Set(getFutureNames());
  const foFirst = all.filter((i) => foNames.has(i.name ?? i.tradingsymbol));
  const rest    = all
    .filter((i) => !foNames.has(i.name ?? i.tradingsymbol))
    .sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));
  return [...foFirst, ...rest];
}

/**
 * getAllEquity — returns ALL NSE + BSE EQ instruments (F&O and non-F&O alike),
 * excluding non-equity instruments (GOI bonds, ETFs, SGBs, debentures).
 *
 * Sort order: F&O-eligible stocks first (most liquid, reliable candle data),
 * then remaining NSE stocks, then BSE stocks alphabetically by trading symbol.
 *
 * @returns {object[]} Array of instrument objects with instrumentToken, tradingsymbol, exchange, name
 */
function getAllEquity() {
  const all = _instruments.filter((i) => {
    // Accept both NSE and BSE
    if ((i.exchange !== 'NSE' && i.exchange !== 'BSE') || i.instrumentType !== 'EQ') return false;
    const sym  = String(i.tradingsymbol ?? '');
    const name = String(i.name ?? '');
    // Exclude government bonds, ETFs, debentures, REITs
    if (_EQUITY_EXCLUDE_NAME.test(name))  return false;
    if (_EQUITY_EXCLUDE_SYM.test(sym))    return false;
    if (_GOVT_SEC_SYM.test(sym))          return false;
    return true;
  });

  const foNames = new Set(getFutureNames());

  // Sort: F&O first, then NSE, then BSE
  const foFirst = all.filter((i) => foNames.has(i.name ?? i.tradingsymbol));
  const nseRest = all
    .filter((i) => !foNames.has(i.name ?? i.tradingsymbol) && i.exchange === 'NSE')
    .sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));
  const bseRest = all
    .filter((i) => !foNames.has(i.name ?? i.tradingsymbol) && i.exchange === 'BSE')
    .sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));

  return [...foFirst, ...nseRest, ...bseRest];
}

function isLoaded() {
  return _instruments.length > 0;
}

function getLastLoaded() {
  return _lastLoaded;
}

function getCount() {
  return _instruments.length;
}

/**
 * Get ALL options for current (nearest) expiry — no strike filter.
 * Returns all CE and PE options for the index's nearest expiry.
 * name: e.g. 'NIFTY', exchange: e.g. 'NFO'
 */
function getAllOptionsForCurrentExpiry(name, exchange) {
  const today = new Date().toISOString().split('T')[0];
  const candidates = _instruments.filter(
    (i) =>
      i.name === name &&
      i.exchange === exchange &&
      (i.instrumentType === 'CE' || i.instrumentType === 'PE') &&
      (!i.expiry || i.expiry >= today),
  );
  if (!candidates.length) return [];
  const expiries = [...new Set(candidates.map((i) => i.expiry).filter(Boolean))].sort();
  const nearest = expiries[0];
  return candidates.filter((i) => i.expiry === nearest);
}

/**
 * Get ALL options for next week expiry — no strike filter.
 * Returns all CE and PE options for the index's second-nearest expiry.
 * name: e.g. 'NIFTY', exchange: e.g. 'NFO'
 */
function getAllOptionsForNextExpiry(name, exchange) {
  const today = new Date().toISOString().split('T')[0];
  const candidates = _instruments.filter(
    (i) =>
      i.name === name &&
      i.exchange === exchange &&
      (i.instrumentType === 'CE' || i.instrumentType === 'PE') &&
      (!i.expiry || i.expiry >= today),
  );
  if (!candidates.length) return [];
  const expiries = [...new Set(candidates.map((i) => i.expiry).filter(Boolean))].sort();
  if (expiries.length < 2) return []; // No next expiry available
  const nextExpiry = expiries[1];
  return candidates.filter((i) => i.expiry === nextExpiry);
}

module.exports = { load, search, getBySymbol, getByToken, getNseEquity, getFrontMonthFuture, getOptionsByStrike, getNearestATMOption, getFutureNames, getAllNseEquity, getAllEquity, isLoaded, getLastLoaded, getCount, getAllOptionsForCurrentExpiry, getAllOptionsForNextExpiry };
