const express = require('express');
const { getTradingDefaults, setTradingDefaults, getTelegramChatId, setTelegramChatId } = require('../store');

const router = express.Router();

router.get('/trading', (req, res) => {
  res.json(getTradingDefaults());
});

router.post('/trading', (req, res) => {
  const { quantity, exchange, product } = req.body;
  const updates = {};
  if (quantity !== undefined) updates.quantity = Math.max(1, parseInt(quantity, 10) || 1);
  if (exchange !== undefined) updates.exchange = exchange;
  if (product !== undefined) updates.product = product;
  res.json(setTradingDefaults(updates));
});

router.get('/telegram', (req, res) => {
  res.json({ chatId: getTelegramChatId() });
});

router.post('/telegram', (req, res) => {
  const { chatId } = req.body;
  if (!chatId || !String(chatId).trim()) {
    return res.status(400).json({ error: 'chatId is required' });
  }
  const saved = setTelegramChatId(chatId);
  res.json({ chatId: saved });
});

module.exports = router;
