const express = require('express');
const { getPaperTrades, closePaperTrade, clearPaperTrades, getTestMode, setTestMode, getPaperBalance, setPaperInitialBalance } = require('../store');
const { broadcast } = require('../sseHub');

const router = express.Router();

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

module.exports = router;
