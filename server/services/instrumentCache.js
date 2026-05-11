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
  const result = futures[0];
  console.log(`[InstrumentCache] getFrontMonthFuture: ${name}/${exchange} → ${result.tradingsymbol} (token ${result.instrumentToken})`);
  return result;
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

function isLoaded() {
  return _instruments.length > 0;
}

function getLastLoaded() {
  return _lastLoaded;
}

function getCount() {
  return _instruments.length;
}

module.exports = { load, search, getBySymbol, getByToken, getFrontMonthFuture, getOptionsByStrike, getFutureNames, isLoaded, getLastLoaded, getCount };
