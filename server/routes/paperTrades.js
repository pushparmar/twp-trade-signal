const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const { addPaperTrade, getPaperTrades, closePaperTrade, updatePaperTrade, clearPaperTrades, getTestMode, setTestMode, getPaperBalance, setPaperInitialBalance, getWatchlist } = require('../store');
const { broadcast }   = require('../sseHub');
const kiteTicker  = require('../services/kiteTicker');
const db          = require('../db');

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
  const stillOpen = getPaperTrades().some(
    (t) => t.status === 'OPEN' && Number(t.token) === num,
  );
  if (stillOpen) return; // another open trade still needs this token

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
    res.json(trades);
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
  const trade = closePaperTrade(req.params.id, Number(exitPrice));
  if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });
  broadcast('paper_trade_update', trade);
  broadcast('paper_balance', getPaperBalance());
  // Unsubscribe the token if no other open trade or watchlist entry needs it
  _unsubscribeIfUnneeded(trade.token);
  // Mirror closed trade to MongoDB — fire-and-forget
  db.tradeRepo.closeTrade(trade);
  res.json(trade);
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

module.exports = router;
