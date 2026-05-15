const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { addPaperTrade, getPaperTrades, closePaperTrade, clearPaperTrades, getTestMode, setTestMode, getPaperBalance, setPaperInitialBalance } = require('../store');
const { broadcast } = require('../sseHub');

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

// Create a new paper trade — called by the client after adding it locally so the
// server's trades-current.json stays in sync for the daily 6 AM archive.
router.post('/', (req, res) => {
  const trade = req.body;
  if (!trade || !trade.id || !trade.symbol || !trade.entryPrice) {
    return res.status(400).json({ error: 'Invalid trade — id, symbol and entryPrice are required' });
  }
  addPaperTrade(trade); // writes through to trades-current.json
  res.status(201).json(trade);
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
