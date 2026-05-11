const express = require('express');
const { getTradingDefaults, setTradingDefaults, getTelegramChatId, setTelegramChatId } = require('../store');

const router = express.Router();

// M1 — strict allowlists for exchange and product
const VALID_EXCHANGES = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX']);
const VALID_PRODUCTS  = new Set(['MIS', 'CNC', 'NRML']);

// M6 — cap quantity to prevent accidental large orders
const MAX_QUANTITY = Number(process.env.MAX_ORDER_QUANTITY) || 1800;

router.get('/trading', (req, res) => {
  res.json(getTradingDefaults());
});

router.post('/trading', (req, res) => {
  const { quantity, exchange, product } = req.body;
  const updates = {};

  if (quantity !== undefined) {
    const q = Math.max(1, parseInt(quantity, 10) || 1);
    updates.quantity = Math.min(q, MAX_QUANTITY);
  }
  if (exchange !== undefined) {
    if (!VALID_EXCHANGES.has(exchange)) {
      return res.status(400).json({ error: `invalid exchange — allowed: ${[...VALID_EXCHANGES].join(', ')}` });
    }
    updates.exchange = exchange;
  }
  if (product !== undefined) {
    if (!VALID_PRODUCTS.has(product)) {
      return res.status(400).json({ error: `invalid product — allowed: ${[...VALID_PRODUCTS].join(', ')}` });
    }
    updates.product = product;
  }

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
