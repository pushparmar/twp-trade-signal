const express = require('express');
const { getTradingDefaults, setTradingDefaults, getTelegramChatId, setTelegramChatId, getTelegramBotToken, setTelegramBotToken } = require('../store');

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

module.exports = router;
