const express = require('express');
const { v4: uuidv4 } = require('uuid');
const kiteService = require('../services/kiteService');
const { broadcast } = require('../sseHub');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/order', requireApiKey, async (req, res) => {
  try {
    const result = await kiteService.placeOrder(req.body);
    const orderId = result?.data?.order_id || null;
    broadcast('order_placed', {
      id: uuidv4(),
      ts: Date.now(),
      orderId,
      symbol: req.body.tradingsymbol,
      action: req.body.transaction_type,
      price: req.body.price ?? null,
      status: 'OPEN',
      source: 'manual',
      gttStatus: null,
    });
    res.json(result);
  } catch (err) {
    broadcast('order_placed', {
      id: uuidv4(),
      ts: Date.now(),
      symbol: req.body.tradingsymbol,
      action: req.body.transaction_type,
      price: req.body.price ?? null,
      status: 'FAILED',
      source: 'manual',
      error: err.response?.data?.message || err.message,
      gttStatus: null,
    });
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || err.message });
  }
});

router.post('/gtt', requireApiKey, async (req, res) => {
  try {
    const result = await kiteService.placeGTT(req.body);
    res.json(result);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || err.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const orders = await kiteService.getOrders();
    res.json(orders);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || err.message });
  }
});

router.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await kiteService.getOrder(req.params.orderId);
    res.json(order);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
