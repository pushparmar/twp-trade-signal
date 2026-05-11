const express = require('express');
const telegramPoller = require('../services/telegramPoller');

const router = express.Router();

router.post('/start', (req, res) => {
  try {
    telegramPoller.start();
    res.json({ ok: true, status: 'running' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/stop', (req, res) => {
  telegramPoller.stop();
  res.json({ ok: true, status: 'stopped' });
});

router.get('/status', (req, res) => {
  res.json(telegramPoller.getStatus());
});


module.exports = router;
