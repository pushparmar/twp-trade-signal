const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const { addPaperTrade, getPaperTrades, closePaperTrade, updatePaperTrade, cancelPendingTrade, clearPaperTrades, getTestMode, setTestMode, getPaperBalance, setPaperInitialBalance, getWatchlist } = require('../store');
const TradeExporter = require('../services/tradeExporter');
const { broadcast }   = require('../sseHub');
const kiteTicker  = require('../services/kiteTicker');
const kiteService = require('../services/kiteService');
const db          = require('../db');
const tradePairing = require('../services/tradePairing');

// ── Ticker subscription helpers ───────────────────────────────────────────────

/**
 * Subscribe a paper trade token to the Kite ticker so live ticks flow in and
 * the client's usePaperAutoClose hook can evaluate SL / target hits.
 */
function _subscribeTradeToken(token) {
  if (!token) return;
  try {
    kiteTicker.subscribe([Number(token)]);
  } catch (err) {
    console.warn(`[Paper] Could not subscribe token ${token}:`, err.message);
  }
}

/**
 * Unsubscribe a token ONLY when it is no longer needed by any open paper trade
 * AND is not present in the user's watchlist.  Calling this after a trade closes
 * keeps the ticker lean without disrupting watchlist live-price display.
 */
function _unsubscribeIfUnneeded(token) {
  if (!token) return;
  const num = Number(token);
  // Keep subscribed for both OPEN and PENDING (pending needs ticks to detect trigger)
  const stillOpen = getPaperTrades().some(
    (t) => (t.status === 'OPEN' || t.status === 'PENDING') && Number(t.token) === num,
  );
  if (stillOpen) return; // another active trade still needs this token

  const inWatchlist = getWatchlist().some((w) => Number(w.instrumentToken) === num);
  if (inWatchlist) return; // watchlist display needs it

  try {
    kiteTicker.unsubscribe([num]);
  } catch (err) {
    console.warn(`[Paper] Could not unsubscribe token ${num}:`, err.message);
  }
}

const router = express.Router();

// Directory where daily archive files are stored (mirrors tradeArchiver.js)
const HISTORY_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'history')
  : path.join(__dirname, '..', 'data', 'history');

router.get('/mode', (req, res) => {
  res.json({ testMode: getTestMode() });
});

router.post('/mode', (req, res) => {
  const { enabled } = req.body;
  setTestMode(!!enabled);
  broadcast('test_mode', { testMode: getTestMode() });
  res.json({ testMode: getTestMode() });
});

router.get('/', (req, res) => {
  res.json(getPaperTrades());
});

/**
 * GET /api/paper/open-from-db
 * Returns OPEN trades directly from MongoDB, bypassing the in-memory store.
 * Used by the client on mount to sync state when localStorage was cleared
 * or the user logs in from a new device.
 * Returns [] (not an error) when MongoDB is not configured.
 */
router.get('/open-from-db', async (req, res) => {
  try {
    const trades = await db.tradeRepo.getOpenTrades();
    // Restore any OPEN trades from MongoDB that are missing from the in-memory
    // store (e.g. after a "Clear all" or server restart without disk file).
    const current = getPaperTrades();
    const existingIds = new Set(current.map((t) => t.id));
    const restored = [];
    for (const t of trades) {
      if (!existingIds.has(t.id)) {
        addPaperTrade(t);
        _subscribeTradeToken(t.token);
        if (t.derivativeToken) _subscribeTradeToken(t.derivativeToken);
        restored.push(t);
      }
    }
    if (restored.length > 0) {
      console.log(`[Paper] Restored ${restored.length} OPEN trade(s) from MongoDB into memory`);
      // Broadcast each restored trade via SSE so all connected clients receive
      // them even if the HTTP response arrives before the client state is ready.
      for (const t of restored) broadcast('paper_trade', t);
      broadcast('paper_balance', getPaperBalance());
    }
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/recent-from-db
 * Returns the most recent 200 trades (any status) from MongoDB.
 * Used by the client on mount to fully sync the order book across devices —
 * both OPEN and CLOSED trades are included so a fresh device sees the same
 * state as one that has been running since the trades were placed.
 * Returns [] (not an error) when MongoDB is not configured.
 */
router.get('/recent-from-db', async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const trades = await db.tradeRepo.getRecentTrades(limit);
    // Restore any trades missing from the in-memory store (e.g. server restart
    // without persistent disk, or race between boot and first client connect).
    const current = getPaperTrades();
    const existingIds = new Set(current.map((t) => t.id));
    const restored = [];
    for (const t of trades) {
      if (!existingIds.has(t.id)) {
        addPaperTrade(t);
        if (t.status === 'OPEN' || t.status === 'PENDING') {
          _subscribeTradeToken(t.token);
          if (t.status === 'OPEN' && t.derivativeToken) _subscribeTradeToken(t.derivativeToken);
        }
        restored.push(t);
      }
    }
    if (restored.length > 0) {
      console.log(`[Paper] Restored ${restored.length} trade(s) from MongoDB into memory`);
      for (const t of restored.filter((t) => t.status === 'OPEN')) broadcast('paper_trade', t);
      broadcast('paper_balance', getPaperBalance());
    }
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/by-date?date=YYYY-MM-DD
 * Fetch all trades opened on the given IST calendar date from MongoDB.
 * Supports prev/next navigation from the client without re-fetching the full list.
 */
router.get('/by-date', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }
  try {
    const trades = await db.tradeRepo.getByDate(date);
    res.json({ date, trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/trading-dates
 * Returns all distinct IST dates that have at least one trade in MongoDB.
 * Used by the client date picker to show only valid trading days.
 */
router.get('/trading-dates', async (req, res) => {
  try {
    const dates = await db.tradeRepo.getTradingDates();
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/db-stats
 * Quick diagnostic — counts trades + open/closed split in MongoDB so the user
 * can verify writes are actually landing without opening Atlas.
 */
/**
 * GET /api/paper/db-test
 * SYNCHRONOUS write+read diagnostic — surfaces the exact reason a paper_trade
 * write would fail (auth, permission, validation, schema, etc.) by doing the
 * call awaited instead of fire-and-forget.  Inserts a throwaway doc, reads it
 * back, deletes it, and returns the result.
 *
 * The fire-and-forget upserts in production swallow errors so they never
 * affect the trading hot path — this endpoint exists purely to find out WHY.
 */
router.get('/db-test', async (req, res) => {
  const mongo = require('../services/mongoClient');
  const result = { mongoReady: mongo.isReady(), steps: [] };

  if (!mongo.isReady()) {
    return res.status(500).json({ ...result, error: 'mongo.isReady() === false' });
  }

  const testId = `db-test-${Date.now()}`;
  try {
    // 1. Count before
    const before = await mongo.db().collection('paper_trades').countDocuments({});
    result.steps.push({ step: 'count_before', value: before });

    // 2. Insert with full schema matching upsertTrade
    const insertResult = await mongo.db().collection('paper_trades').insertOne({
      tradeId:     testId,
      symbol:      'DB-TEST',
      token:       0,
      action:      'BUY',
      entryPrice:  1,
      status:      'OPEN',
      openedAt:    new Date(),
      createdAt:   new Date(),
      updatedAt:   new Date(),
    });
    result.steps.push({ step: 'insert', acknowledged: insertResult.acknowledged, insertedId: String(insertResult.insertedId) });

    // 3. Read it back
    const doc = await mongo.db().collection('paper_trades').findOne({ tradeId: testId });
    result.steps.push({ step: 'readback', found: doc !== null, status: doc?.status });

    // 4. Count after
    const after = await mongo.db().collection('paper_trades').countDocuments({});
    result.steps.push({ step: 'count_after', value: after });

    // 5. Clean up
    const del = await mongo.db().collection('paper_trades').deleteOne({ tradeId: testId });
    result.steps.push({ step: 'cleanup', deletedCount: del.deletedCount });

    result.ok = insertResult.acknowledged && doc !== null;
    res.json(result);
  } catch (err) {
    result.error = err.message;
    result.stack = err.stack?.split('\n').slice(0, 4);
    res.status(500).json(result);
  }
});

router.get('/db-stats', async (req, res) => {
  try {
    const opens = await db.tradeRepo.getOpenTrades();
    res.json({
      mongoConnected: opens != null,
      openInDb:       opens.length,
      memoryTrades:   getPaperTrades().length,
      message:        opens.length === 0
        ? 'No open trades in MongoDB yet. Place a trade or wait for an auto-fire.'
        : `${opens.length} open trade(s) persisted in MongoDB.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new paper trade — called by the client after adding it locally so the
// server's trades-current.json stays in sync for the daily 6 AM archive.
// Also subscribes the instrument token to the Kite ticker so live ticks flow
// in for this trade immediately, enabling real-time SL / target monitoring.
router.post('/', (req, res) => {
  const trade = req.body;
  if (!trade || !trade.id || !trade.symbol || !trade.entryPrice) {
    return res.status(400).json({ error: 'Invalid trade — id, symbol and entryPrice are required' });
  }
  addPaperTrade(trade); // writes through to trades-current.json
  _subscribeTradeToken(trade.token);
  // Mirror to MongoDB for pattern performance analysis — fire-and-forget
  db.tradeRepo.upsertTrade(trade);
  res.status(201).json(trade);
});

/**
 * PATCH /api/paper/:id/trail
 * Update an OPEN trade's SL (and trailing metadata) when TSL fires.
 * Body: { sl: number, peakPrice?: number, tslActivated?: boolean }
 *
 * Returns the updated trade so the client can sync.
 */
router.patch('/:id/trail', (req, res) => {
  const { sl, peakPrice, tslActivated } = req.body;
  if (sl == null || isNaN(sl)) {
    return res.status(400).json({ error: 'sl is required (number)' });
  }
  const trade = updatePaperTrade(req.params.id, {
    sl:           Number(sl),
    peakPrice:    peakPrice    != null ? Number(peakPrice) : undefined,
    tslActivated: tslActivated != null ? !!tslActivated    : undefined,
  });
  if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });

  // Mirror the SL change to MongoDB so analytics see the trailed exit value
  db.tradeRepo.upsertTrade(trade);
  // Broadcast so all clients (and the dashboard PnL preview) refresh immediately
  broadcast('paper_trade_update', trade);
  res.json(trade);
});

router.post('/:id/close', (req, res) => {
  const { exitPrice } = req.body;
  if (!exitPrice || isNaN(exitPrice)) {
    return res.status(400).json({ error: 'exitPrice is required' });
  }
  const trade = closePaperTrade(req.params.id, Number(exitPrice), 'MANUAL');
  if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });
  broadcast('paper_trade_update', trade);
  broadcast('paper_balance', getPaperBalance());
  // Unsubscribe the token if no other open trade or watchlist entry needs it
  _unsubscribeIfUnneeded(trade.token);
  // Mirror closed trade to MongoDB — fire-and-forget
  db.tradeRepo.closeTrade(trade);
  res.json(trade);
});

/**
 * DELETE /api/paper/:id
 * Cancel a PENDING order — removes it from the store and unsubscribes the token
 * if no other trade or watchlist entry needs it.
 * Returns 404 when the trade is not found or is not in PENDING state.
 */
router.delete('/:id', (req, res) => {
  const cancelled = cancelPendingTrade(req.params.id);
  if (!cancelled) return res.status(404).json({ error: 'Pending order not found' });
  // Let all clients know the trade is gone
  broadcast('paper_trade_cancelled', { id: req.params.id });
  broadcast('paper_balance', getPaperBalance());
  res.json({ ok: true });
});

router.delete('/', (req, res) => {
  clearPaperTrades();
  broadcast('paper_trades_cleared', {});
  broadcast('paper_balance', getPaperBalance());
  res.json({ ok: true });
});

router.get('/balance', (req, res) => {
  res.json(getPaperBalance());
});

router.post('/balance', (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  setPaperInitialBalance(Number(amount));
  const balance = getPaperBalance();
  broadcast('paper_balance', balance);
  res.json(balance);
});

// ── Trade export (CSV download) ───────────────────────────────────────────────

/**
 * GET /api/paper/export?date=YYYY-MM-DD
 *
 * Downloads a CSV file containing all paper trades for the given IST date.
 * When no date is supplied, defaults to today (IST).
 *
 * Each row includes: symbol, exchange, action, signal, pattern ID/name,
 * timeframe, entry/SL/target/exit prices, PnL, R:R, volume confirmation,
 * MTF alignment, and the full predefined pattern logic explanation.
 */
router.get('/export', async (req, res) => {
  try {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const today = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const date  = req.query.date ?? today;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    // Merge in-memory trades with MongoDB records so the export is complete
    // even when the server was restarted mid-day.
    let trades = getPaperTrades();
    try {
      const dbTrades   = await db.tradeRepo.getRecentTrades(500);
      const memoryIds  = new Set(trades.map((t) => t.id));
      const extraFromDb = dbTrades.filter((t) => !memoryIds.has(t.id));
      trades = [...trades, ...extraFromDb];
    } catch { /* MongoDB unavailable — use in-memory only */ }

    const csv      = TradeExporter.toCSV(trades, date);
    const filename = TradeExporter.filename(date);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Last traded prices for open trades ────────────────────────────────────────
// Returns { [instrumentToken]: lastPrice } for all unique tokens across open
// paper trades.  Works even when market is closed — Kite returns the last
// session's closing price.  Called once on client mount so the order book
// never shows "—" while waiting for live ticks.

router.get('/ltp', async (req, res) => {
  try {
    const open = getPaperTrades().filter((t) => t.status === 'OPEN');
    if (open.length === 0) return res.json({});

    // Build EXCHANGE:SYMBOL strings — Kite's LTP API requires this format.
    const symbolMap = new Map(); // "EXCHANGE:SYMBOL" → instrumentToken
    for (const t of open) {
      if (t.token && t.exchange && t.symbol) {
        symbolMap.set(`${t.exchange}:${t.symbol}`, Number(t.token));
      }
      if (t.derivativeToken && t.derivativeExchange && t.derivativeSymbol) {
        symbolMap.set(`${t.derivativeExchange}:${t.derivativeSymbol}`, Number(t.derivativeToken));
      }
    }

    if (symbolMap.size === 0) return res.json({});

    const ltpData = await kiteService.getLTP([...symbolMap.keys()]);

    const result = {};
    for (const [sym, val] of Object.entries(ltpData)) {
      const token = symbolMap.get(sym) ?? val.instrument_token;
      if (token && val.last_price != null) {
        result[token] = val.last_price;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[Paper/LTP]', err.message);
    res.json({});
  }
});

// ── Trade history (daily archives) ───────────────────────────────────────────

/**
 * GET /api/paper/history
 * Returns a list of available archived dates (newest first).
 * e.g. ["2025-05-16", "2025-05-15"]
 */
router.get('/history', (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return res.json([]);
    const dates = fs.readdirSync(HISTORY_DIR)
      .filter((f) => f.startsWith('trades-') && f.endsWith('.json'))
      .map((f) => f.slice('trades-'.length, -'.json'.length))
      .sort()
      .reverse();
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/history/:date
 * Returns the full archive for a given IST date (YYYY-MM-DD).
 * Includes summary + individual trade records with pattern/signal/TF fields.
 */
router.get('/history/:date', (req, res) => {
  // Basic date format guard to prevent path traversal
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const filePath = path.join(HISTORY_DIR, `trades-${req.params.date}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `No archive found for ${req.params.date}` });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade Pairing & Backtesting Analytics ────────────────────────────────────

/**
 * GET /api/paper/paired-trades
 * Returns trades paired into complete round-trip cycles for backtesting.
 * Each pair shows entry + exit with computed metrics (R-multiple, duration, etc.)
 *
 * Query params:
 *   - limit: max trades to return (default 200)
 *   - fromDate: filter trades from this date (YYYY-MM-DD)
 *   - toDate: filter trades until this date (YYYY-MM-DD)
 */
router.get('/paired-trades', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
    let trades = await db.tradeRepo.getRecentTrades(limit);

    // Optional date filtering
    if (req.query.fromDate || req.query.toDate) {
      const fromMs = req.query.fromDate ? new Date(req.query.fromDate).getTime() : 0;
      const toMs = req.query.toDate ? new Date(req.query.toDate).getTime() : Infinity;
      trades = trades.filter(t => t.ts >= fromMs && t.ts <= toMs);
    }

    const pairs = tradePairing.pairTrades(trades);
    const stats = tradePairing.generateBacktestStats(pairs);

    res.json({
      count: pairs.length,
      stats,
      trades: pairs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/backtest-by-symbol
 * Groups paired trades by symbol for aggregate performance analysis.
 *
 * Query params:
 *   - limit: max trades to analyze (default 500)
 */
router.get('/backtest-by-symbol', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    const trades = await db.tradeRepo.getRecentTrades(limit);
    const pairs = tradePairing.pairTrades(trades);
    const grouped = tradePairing.groupBySymbol(pairs);

    // Convert to array and sort by total PnL
    const results = Object.values(grouped)
      .sort((a, b) => b.totalPnl - a.totalPnl);

    res.json({
      count: results.length,
      symbols: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/backtest-by-pattern
 * Groups paired trades by pattern for pattern performance analysis.
 *
 * Query params:
 *   - limit: max trades to analyze (default 500)
 */
router.get('/backtest-by-pattern', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    const trades = await db.tradeRepo.getRecentTrades(limit);
    const pairs = tradePairing.pairTrades(trades);
    const grouped = tradePairing.groupByPattern(pairs);

    // Convert to array and sort by win rate
    const results = Object.values(grouped)
      .sort((a, b) => b.winRate - a.winRate);

    res.json({
      count: results.length,
      patterns: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/paper/backtest-summary
 * Returns comprehensive backtesting statistics across all trades.
 *
 * Query params:
 *   - limit: max trades to analyze (default 500)
 *   - fromDate: filter from date (YYYY-MM-DD)
 *   - toDate: filter until date (YYYY-MM-DD)
 */
router.get('/backtest-summary', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    let trades = await db.tradeRepo.getRecentTrades(limit);

    // Optional date filtering
    if (req.query.fromDate || req.query.toDate) {
      const fromMs = req.query.fromDate ? new Date(req.query.fromDate).getTime() : 0;
      const toMs = req.query.toDate ? new Date(req.query.toDate).getTime() : Infinity;
      trades = trades.filter(t => t.ts >= fromMs && t.ts <= toMs);
    }

    const pairs = tradePairing.pairTrades(trades);
    const stats = tradePairing.generateBacktestStats(pairs);
    const bySymbol = tradePairing.groupBySymbol(pairs);
    const byPattern = tradePairing.groupByPattern(pairs);

    res.json({
      overall: stats,
      topSymbols: Object.values(bySymbol)
        .sort((a, b) => b.totalPnl - a.totalPnl)
        .slice(0, 10),
      topPatterns: Object.values(byPattern)
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
