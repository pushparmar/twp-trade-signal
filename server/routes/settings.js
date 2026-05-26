const express = require('express');
const { getTradingDefaults, setTradingDefaults, getTelegramChatId, setTelegramChatId, getTelegramBotToken, setTelegramBotToken, getPatternConfig, setPatternConfig, getQualityScoreConfig, setQualityScoreConfig } = require('../store');
const patternRegistry = require('../services/patternRegistry');

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
  const chatId  = getTelegramChatId();
  const botToken = getTelegramBotToken();
  // Never echo the full token — just confirm presence for the UI
  res.json({ chatId, botTokenSet: !!botToken });
});

router.post('/telegram', (req, res) => {
  const { chatId, botToken } = req.body;

  // Allow updating chatId and/or botToken in one request
  if (botToken !== undefined) {
    if (!String(botToken).trim()) {
      return res.status(400).json({ error: 'botToken must not be empty' });
    }
    setTelegramBotToken(botToken);
  }

  if (chatId !== undefined) {
    if (!String(chatId).trim()) {
      return res.status(400).json({ error: 'chatId must not be empty' });
    }
    setTelegramChatId(chatId);
  }

  if (chatId === undefined && botToken === undefined) {
    return res.status(400).json({ error: 'chatId or botToken is required' });
  }

  res.json({ chatId: getTelegramChatId(), botTokenSet: !!getTelegramBotToken() });
});

// ── Pattern Config ──────────────────────────────────────────────────────────
// GET  /api/settings/pattern-config → { patterns: [...], intervals: [...], config: {...} }
// POST /api/settings/pattern-config → update config entries

const SCAN_INTERVALS = ['15minute', '60minute', '4h', 'day'];

router.get('/pattern-config', (_req, res) => {
  const patterns  = patternRegistry.list().map(p => ({ id: p.id, label: p.label }));
  const config    = getPatternConfig();
  res.json({ patterns, intervals: SCAN_INTERVALS, config });
});

router.post('/pattern-config', (req, res) => {
  // Body: { "patternId:interval": { scan: bool, alert: bool, order: bool }, ... }
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be an object of pattern:interval → { scan, alert, order }' });
  }
  const saved = setPatternConfig(updates);
  res.json({ config: saved });
});

// ── Quality Score Config ────────────────────────────────────────────────────
// GET  /api/settings/quality-score → current quality score config
// POST /api/settings/quality-score → update quality score config

router.get('/quality-score', (_req, res) => {
  res.json(getQualityScoreConfig());
});

router.post('/quality-score', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be an object of config fields' });
  }
  const saved = setQualityScoreConfig(updates);
  res.json(saved);
});

module.exports = router;
