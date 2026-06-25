const axios = require('axios');
const store = require('../store');

async function sendMessage(chatId, text) {
  // Check module config — skip if telegramAlerts is disabled
  const moduleEnabled = store.isModuleEnabled('telegramAlerts');
  console.log(`[TelegramNotifier] telegramAlerts module enabled: ${moduleEnabled}`);

  if (!moduleEnabled) {
    console.log('[TelegramNotifier] ⚠️ Module disabled — message not sent');
    return { ok: true, skipped: true, reason: 'module_disabled' };
  }

  const { telegram } = store.getConfig();
  if (!telegram.botToken) throw new Error('Telegram bot token not configured');
  if (!chatId) throw new Error('Chat ID is required');

  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  const response = await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }, { timeout: 10_000 });

  return response.data;
}

module.exports = { sendMessage };
