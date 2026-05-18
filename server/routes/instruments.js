const express = require('express');
const instrumentCache = require('../services/instrumentCache');
const kiteTicker = require('../services/kiteTicker');
const kiteService = require('../services/kiteService');
const candleStore = require('../services/candleStore');
const liveScanner = require('../services/liveScanner');
const store = require('../store');

const BATCH_SIZE = 500; // Kite quote API limit per request

// Intervals that liveScanner runs on — must stay in sync with liveScanner.WATCHED_INTERVALS.
// (60minute also seeds the 4h synthesis buffer.)
const SCANNER_INTERVALS = ['15minute', '60minute', 'day'];

/**
 * Seed candleStore for one token across all scanner intervals.
 *
 * WHY THIS EXISTS:
 *   liveScanner.onCandleClose requires `candles.length >= 52` to compute Ichimoku.
 *   Without seeding, a freshly-subscribed stock's candle buffer is empty and
 *   live ticks only build it 1 candle at a time — meaning pattern alerts for
 *   that stock would not fire until ~52 trading-day-bars or ~13 hours of 15m
 *   bars have accumulated.
 *
 *   Seeding pre-fills the buffer from Kite historical so the very next candle
 *   close triggers pattern detection.
 *
 * Non-blocking: each fetch runs in the background. Errors are logged but never
 * thrown — one slow Kite call should not delay the /subscribe HTTP response.
 */
function _seedScannerBuffers(token, label) {
  for (const interval of SCANNER_INTERVALS) {
    candleStore.getCandles(token, interval).catch((err) => {
      console.warn(`[Subscribe] Seed failed ${label || token}:${interval} —`, err.message);
    });
  }
}

const router = express.Router();

// Search instruments by symbol/name substring
router.get('/search', (req, res) => {
  const { q = '', exchange = '' } = req.query;
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded yet. Kite must be authenticated first.' });
  }
  const results = instrumentCache.search(q, exchange);
  res.json(results);
});

// Get current watchlist
router.get('/watchlist', (req, res) => {
  res.json(store.getWatchlist());
});

// Add instrument to watchlist and subscribe to ticker
router.post('/subscribe', (req, res) => {
  const { instrumentToken, tradingsymbol, exchange, name, lotSize, expiry, instrumentType, strike } = req.body;
  if (!instrumentToken || !tradingsymbol || !exchange) {
    return res.status(400).json({ error: 'instrumentToken, tradingsymbol and exchange are required' });
  }

  const item = {
    instrumentToken: Number(instrumentToken),
    tradingsymbol,
    exchange,
    name: name || '',
    lotSize: Number(lotSize) || 1,
    expiry: expiry || '',
    instrumentType: instrumentType || '',
    strike: Number(strike) || 0,
  };

  const watchlist = store.addToWatchlist(item);
  kiteTicker.subscribe([item.instrumentToken]);
  // Register with live scanner so candle closes for this token trigger pattern checks
  liveScanner.addWatch(item.instrumentToken, item.tradingsymbol || item.name || `Token ${item.instrumentToken}`);
  // Seed candle buffers so pattern detection works on the next candle close (not in 13+ hours)
  _seedScannerBuffers(item.instrumentToken, item.tradingsymbol);
  res.json({ ok: true, watchlist });
});

// Remove instrument from watchlist and unsubscribe from ticker
router.post('/unsubscribe', (req, res) => {
  const { instrumentToken } = req.body;
  if (!instrumentToken) {
    return res.status(400).json({ error: 'instrumentToken is required' });
  }
  const token = Number(instrumentToken);
  const watchlist = store.removeFromWatchlist(token);
  kiteTicker.unsubscribe([token]);
  candleStore.remove(token);
  liveScanner.removeWatch(token);
  res.json({ ok: true, watchlist });
});

// Subscribe ATM options for an index (NIFTY or SENSEX) around current price
// Body: { index: 'NIFTY' | 'SENSEX', offsets: number[] }
// offsets are strike count offsets from ATM, e.g. [-2,-1,0,1,2]
router.post('/subscribe-atm', async (req, res) => {
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded. Authenticate Kite first.' });
  }

  const INDEX_CONFIG = {
    NIFTY:     { ltpSymbol: 'NSE:NIFTY 50',   exchange: 'NFO', name: 'NIFTY',     step: 50  },
    BANKNIFTY: { ltpSymbol: 'NSE:NIFTY BANK', exchange: 'NFO', name: 'BANKNIFTY', step: 100 },
    SENSEX:    { ltpSymbol: 'BSE:SENSEX',      exchange: 'BFO', name: 'SENSEX',    step: 100 },
  };

  const { index, offsets } = req.body;
  const cfg = INDEX_CONFIG[String(index).toUpperCase()];
  if (!cfg) return res.status(400).json({ error: 'index must be NIFTY, BANKNIFTY or SENSEX' });
  if (!Array.isArray(offsets) || offsets.length === 0) {
    return res.status(400).json({ error: 'offsets must be a non-empty array' });
  }

  try {
    // Primary: symbol-string LTP lookup
    let price = null;
    try {
      const ltpData = await kiteService.getLTP([cfg.ltpSymbol]);
      const ltpEntry = ltpData[cfg.ltpSymbol] || Object.values(ltpData)[0];
      price = ltpEntry?.last_price ?? null;
      console.log(`[ATM] ${index} ltpSymbol=${cfg.ltpSymbol} keys=${Object.keys(ltpData)} price=${price}`);
    } catch (e) {
      console.warn(`[ATM] symbol LTP failed for ${cfg.ltpSymbol}:`, e.message);
    }

    // Fallback: look up instrument token from cache and use numeric LTP
    if (!price) {
      const [ltpExchange, ltpTradingsymbol] = cfg.ltpSymbol.split(':');
      const idxInst = instrumentCache.getBySymbol(ltpExchange, ltpTradingsymbol);
      if (idxInst?.instrumentToken) {
        try {
          const tokenLtp = await kiteService.getLTP([String(idxInst.instrumentToken)]);
          price = Object.values(tokenLtp)[0]?.last_price ?? null;
          console.log(`[ATM] ${index} token fallback token=${idxInst.instrumentToken} price=${price}`);
        } catch (e2) {
          console.warn(`[ATM] token LTP fallback failed for ${index}:`, e2.message);
        }
      }
    }

    if (!price) return res.status(500).json({ error: `Could not get LTP for ${index}` });

    const atm = Math.round(price / cfg.step) * cfg.step;
    const strikeValues = offsets.map((o) => atm + o * cfg.step);

    const instruments = instrumentCache.getOptionsByStrike(cfg.name, cfg.exchange, strikeValues);
    if (!instruments.length) {
      return res.status(404).json({
        error: `No options found for ${index} near ATM ${atm}. ` +
               `Tried strikes: ${strikeValues.join(', ')} on ${cfg.exchange}`,
      });
    }

    // Remove all previously subscribed options for this index before adding new ATM set
    const existing = store.getWatchlist().filter(
      (i) => i.name === cfg.name && (i.instrumentType === 'CE' || i.instrumentType === 'PE'),
    );
    if (existing.length) {
      const oldTokens = existing.map((i) => i.instrumentToken);
      oldTokens.forEach((t) => {
        store.removeFromWatchlist(t);
        candleStore.remove(t);
        liveScanner.removeWatch(t);
      });
      kiteTicker.unsubscribe(oldTokens);
    }

    const tokens = [];
    for (const inst of instruments) {
      store.addToWatchlist({
        instrumentToken: inst.instrumentToken,
        tradingsymbol:   inst.tradingsymbol,
        exchange:        inst.exchange,
        name:            inst.name,
        lotSize:         inst.lotSize,
        expiry:          inst.expiry,
        instrumentType:  inst.instrumentType,
        strike:          inst.strike,
      });
      tokens.push(inst.instrumentToken);
      liveScanner.addWatch(inst.instrumentToken, inst.tradingsymbol);
      _seedScannerBuffers(inst.instrumentToken, inst.tradingsymbol);
    }

    if (tokens.length) kiteTicker.subscribe(tokens);

    res.json({
      ok: true,
      index,
      atm,
      price: Math.round(price * 100) / 100,
      strikeValues,
      subscribed: instruments.map((i) => i.tradingsymbol),
      watchlist: store.getWatchlist(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Return all unique stock names that have active NFO futures
router.get('/futures-list', (req, res) => {
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded. Authenticate Kite first.' });
  }
  res.json(instrumentCache.getFutureNames());
});

// Subscribe the nearest-expiry futures contract for a stock
// Body: { symbol: 'RELIANCE' }
router.post('/subscribe-future', (req, res) => {
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded. Authenticate Kite first.' });
  }
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  const name = String(symbol).toUpperCase();
  const today = new Date().toISOString().split('T')[0];

  const futures = instrumentCache.search(name, 'NFO')
    .filter((i) => i.instrumentType === 'FUT' && i.name === name && i.expiry >= today)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : 1));

  if (!futures.length) {
    return res.status(404).json({ error: `No active futures found for ${name} on NFO` });
  }

  const inst = futures[0];
  const watchlist = store.addToWatchlist({
    instrumentToken: inst.instrumentToken,
    tradingsymbol:   inst.tradingsymbol,
    exchange:        inst.exchange,
    name:            inst.name,
    lotSize:         inst.lotSize,
    expiry:          inst.expiry,
    instrumentType:  inst.instrumentType,
    strike:          inst.strike,
  });
  kiteTicker.subscribe([inst.instrumentToken]);
  liveScanner.addWatch(inst.instrumentToken, inst.tradingsymbol);
  _seedScannerBuffers(inst.instrumentToken, inst.tradingsymbol);
  res.json({ ok: true, instrument: inst, watchlist });
});

// Subscribe nearest-expiry futures for ALL active NFO stocks at once
// Used when the Stocks tab is opened for the first time
router.post('/subscribe-all-futures', (req, res) => {
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded. Authenticate Kite first.' });
  }
  const today = new Date().toISOString().split('T')[0];
  const names = instrumentCache.getFutureNames();
  const tokens = [];

  for (const name of names) {
    const futures = instrumentCache.search(name, 'NFO')
      .filter((i) => i.instrumentType === 'FUT' && i.name === name && i.expiry >= today)
      .sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    if (!futures.length) continue;
    const inst = futures[0];
    store.addToWatchlist({
      instrumentToken: inst.instrumentToken,
      tradingsymbol:   inst.tradingsymbol,
      exchange:        inst.exchange,
      name:            inst.name,
      lotSize:         inst.lotSize,
      expiry:          inst.expiry,
      instrumentType:  inst.instrumentType,
      strike:          inst.strike,
    });
    tokens.push(inst.instrumentToken);
    liveScanner.addWatch(inst.instrumentToken, inst.tradingsymbol);
    _seedScannerBuffers(inst.instrumentToken, inst.tradingsymbol);
  }

  if (tokens.length) kiteTicker.subscribe(tokens);
  res.json({ ok: true, subscribed: tokens.length, watchlist: store.getWatchlist() });
});

// Subscribe stock futures that are up minPct–maxPct% from today's open price.
// Body: { minPct: 6, maxPct: 8 }  — maxPct is optional (open-ended if omitted)
// Uses Kite /quote (batch, up to 500 per call) to get OHLC for all active futures,
// computes (last_price - ohlc.open) / ohlc.open * 100, subscribes matching instruments.
router.post('/subscribe-movers', async (req, res) => {
  if (!instrumentCache.isLoaded()) {
    return res.status(503).json({ error: 'Instrument cache not loaded. Authenticate Kite first.' });
  }

  const rawMin = Math.abs(Number(req.body.minPct ?? 6));
  const rawMax = req.body.maxPct != null ? Math.abs(Number(req.body.maxPct)) : null;
  // Always use absolute values; lo/hi define the positive bound — mirrored for fallers below
  const lo = rawMax != null ? Math.min(rawMin, rawMax) : rawMin;
  const hi = rawMax != null ? Math.max(rawMin, rawMax) : null;

  const today = new Date().toISOString().split('T')[0];
  const names = instrumentCache.getFutureNames();

  // Collect nearest-expiry future for each stock name
  const futures = [];
  for (const name of names) {
    const candidates = instrumentCache.search(name, 'NFO')
      .filter((i) => i.instrumentType === 'FUT' && i.name === name && i.expiry >= today)
      .sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    if (candidates.length) futures.push(candidates[0]);
  }

  if (!futures.length) {
    return res.status(404).json({ error: 'No active stock futures found' });
  }

  // Build symbol strings and fetch quotes in batches of 500
  const symbols = futures.map((f) => `${f.exchange}:${f.tradingsymbol}`);
  let quoteData = {};
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    try {
      const batch = await kiteService.getQuote(symbols.slice(i, i + BATCH_SIZE));
      Object.assign(quoteData, batch);
    } catch (err) {
      console.error('[subscribe-movers] Quote fetch failed:', err.message);
    }
  }

  // Filter by open-to-current change %
  const matched = [];
  for (const fut of futures) {
    const key = `${fut.exchange}:${fut.tradingsymbol}`;
    const q = quoteData[key];
    if (!q || !q.ohlc?.open || q.ohlc.open === 0) continue;
    const changePct = ((q.last_price - q.ohlc.open) / q.ohlc.open) * 100;
    const abs = Math.abs(changePct);
    const inRange = abs >= lo && (hi == null || abs <= hi);
    if (!inRange) continue;
    matched.push({ ...fut, changePct: Math.round(changePct * 100) / 100, lastPrice: q.last_price, open: q.ohlc.open });
  }

  const tokens = [];
  for (const inst of matched) {
    store.addToWatchlist({
      instrumentToken: inst.instrumentToken,
      tradingsymbol:   inst.tradingsymbol,
      exchange:        inst.exchange,
      name:            inst.name,
      lotSize:         inst.lotSize,
      expiry:          inst.expiry,
      instrumentType:  inst.instrumentType,
      strike:          inst.strike,
    });
    tokens.push(inst.instrumentToken);
    liveScanner.addWatch(inst.instrumentToken, inst.tradingsymbol);
    _seedScannerBuffers(inst.instrumentToken, inst.tradingsymbol);
  }

  if (tokens.length) kiteTicker.subscribe(tokens);

  res.json({
    ok: true,
    filter: { lo, hi },
    matched: matched.length,
    symbols: matched.map((m) => ({ tradingsymbol: m.tradingsymbol, changePct: m.changePct, lastPrice: m.lastPrice, open: m.open })),
    watchlist: store.getWatchlist(),
  });
});

// Unsubscribe and remove all FUT instruments from the watchlist at once
router.post('/unsubscribe-all-futures', (req, res) => {
  const watchlist = store.getWatchlist();
  const futures   = watchlist.filter((i) => i.instrumentType === 'FUT');
  if (!futures.length) return res.json({ ok: true, removed: 0, watchlist });

  const tokens = futures.map((i) => i.instrumentToken);
  tokens.forEach((t) => {
    store.removeFromWatchlist(t);
    candleStore.remove(t);
    liveScanner.removeWatch(t);
  });
  kiteTicker.unsubscribe(tokens);
  res.json({ ok: true, removed: tokens.length, watchlist: store.getWatchlist() });
});

// Reload instrument cache on demand
router.post('/reload-cache', async (req, res) => {
  try {
    await instrumentCache.load();
    res.json({ ok: true, count: instrumentCache.getCount(), lastLoaded: instrumentCache.getLastLoaded() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ticker + cache status
router.get('/status', (req, res) => {
  res.json({
    tickerConnected: kiteTicker.isConnected(),
    subscribedCount: kiteTicker.getSubscribed().length,
    cacheLoaded: instrumentCache.isLoaded(),
    instrumentCount: instrumentCache.getCount(),
    cacheLastLoaded: instrumentCache.getLastLoaded(),
  });
});

// ── Peek-subscribe / peek-unsubscribe ─────────────────────────────────────────
// Lightweight endpoints for temporary chart-viewing subscriptions.
//
// Unlike /subscribe (which modifies the watchlist + liveScanner), these only
// touch the KiteTicker. Use them when a chart modal opens so live tick prices
// flow in, and clean up when the modal closes.
//
// POST /api/instruments/peek-subscribe   { tokens: number[] }
// POST /api/instruments/peek-unsubscribe { tokens: number[] }

router.post('/peek-subscribe', (req, res) => {
  const tokens = (req.body?.tokens || []).map(Number).filter(Boolean);
  if (!tokens.length) return res.status(400).json({ error: 'tokens array is required' });

  kiteTicker.subscribe(tokens);
  res.json({ ok: true, subscribed: tokens });
});

router.post('/peek-unsubscribe', (req, res) => {
  const tokens = (req.body?.tokens || []).map(Number).filter(Boolean);
  if (!tokens.length) return res.status(400).json({ error: 'tokens array is required' });

  const watchlistTokens = new Set(
    store.getWatchlist().map((w) => Number(w.instrumentToken)),
  );
  const openTradeTokens = new Set(
    store.getPaperTrades()
      .filter((t) => t.status === 'OPEN' && t.token)
      .map((t) => Number(t.token)),
  );

  // Only unsubscribe tokens that are not still needed by the watchlist or open trades
  const toUnsub = tokens.filter(
    (t) => !watchlistTokens.has(t) && !openTradeTokens.has(t),
  );
  if (toUnsub.length) kiteTicker.unsubscribe(toUnsub);

  res.json({ ok: true, unsubscribed: toUnsub, kept: tokens.length - toUnsub.length });
});

module.exports = router;
