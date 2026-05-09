const express = require('express');
const { getTradingDefaults, setTradingDefaults } = require('../store');

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

module.exports = router;
