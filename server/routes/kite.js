const express = require('express');
const kiteService = require('../services/kiteService');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/order', requireApiKey, async (req, res) => {
  try {
    const result = await kiteService.placeOrder(req.body);
    res.json(result);
  } catch (err) {
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
