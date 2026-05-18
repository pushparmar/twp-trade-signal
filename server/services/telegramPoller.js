const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const store = require('../store');
const signalParser = require('./signalParser');
const kiteService = require('./kiteService');
const { broadcast } = require('../sseHub');
const { isAnyMarketOpen } = require('../utils/marketHours');

let offset     = 0;
let isPolling  = false;
let pollTimeout = null;
let lastMessages = [];
let _conflictRetries = 0;

// On Railway redeploy the old instance gets SIGTERM but Telegram's servers
// hold the long-poll socket open for up to ~10 s after the process exits.
// We retry with generous backoff so the new instance waits out that window.
// 15 retries × 10 s = up to 150 s total — well past Telegram's 90 s timeout.
const MAX_CONFLICT_RETRIES = 15;
const CONFLICT_BACKOFF_MS  = 10_000;

function getStatus() {
  return { isPolling, offset };
}

async function start() {
  if (isPolling) throw new Error('Telegram polling is already running');
  const { telegram } = store.getConfig();
  if (!telegram.botToken) throw new Error('Telegram bot token is not configured');

  // Delete any existing webhook before polling — webhook + getUpdates = 409
  try {
    await axios.post(
      `https://api.telegram.org/bot${telegram.botToken}/deleteWebhook`,
      { drop_pending_updates: false },
      { timeout: 8_000 },
    );
    console.log('[Telegram] Webhook cleared — polling mode active');
  } catch (err) {
    // Non-fatal: if deleteWebhook fails we still try to poll
    console.warn('[Telegram] deleteWebhook failed (non-fatal):', err.message);
  }

  _conflictRetries = 0;
  isPolling = true;
  broadcast('status', { pollingStatus: 'running' });
  // Startup delay — on Railway, the old instance gets SIGTERM but Telegram's
  // servers hold the long-poll socket open for several seconds after the process
  // exits. Waiting 12 s here means the very first poll attempt lands after the
  // stale connection has expired, eliminating 409s on normal redeployments.
  pollTimeout = setTimeout(poll, 12_000);
}

function stop() {
  isPolling = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  broadcast('status', { pollingStatus: 'stopped' });
}

function schedulePoll() {
  if (!isPolling) return;
  pollTimeout = setTimeout(poll, 2000);
}

async function poll() {
  if (!isPolling) return;

  const { telegram } = store.getConfig();
  if (!telegram.botToken) { stop(); return; }

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${telegram.botToken}/getUpdates`,
      { params: { offset, timeout: 10, allowed_updates: ['message'] }, timeout: 15_000 },
    );
    _conflictRetries = 0; // successful poll — reset backoff counter
    for (const update of response.data?.result || []) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (err) {
    const status = err.response?.status;

    if (status === 409) {
      // Another instance (or a webhook) is holding the connection.
      // Back off and retry — the stale connection usually drops within seconds.
      _conflictRetries++;
      if (_conflictRetries > MAX_CONFLICT_RETRIES) {
        console.error(`[Telegram] 409 conflict persists after ${MAX_CONFLICT_RETRIES} retries — stopping poller. Run deleteWebhook or kill the other process, then restart.`);
        stop();
        return;
      }
      console.warn(`[Telegram] 409 conflict — another instance is polling. Backing off ${CONFLICT_BACKOFF_MS / 1000}s (attempt ${_conflictRetries}/${MAX_CONFLICT_RETRIES}). Set DISABLE_TELEGRAM_POLLING=true in local .env if running alongside Railway.`);
      pollTimeout = setTimeout(poll, CONFLICT_BACKOFF_MS);
      return; // skip schedulePoll() below
    }

    console.error('[Telegram] Poll error:', err.message);
  }

  schedulePoll();
}

async function handleUpdate(update) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const text = message.text || message.caption || '';
  if (!text) return;

  const chatId = String(message.chat?.id || '');

  // Auto-register the first chat that messages the bot
  if (chatId && !store.getTelegramChatId()) {
    store.setTelegramChatId(chatId);
    console.log(`[Telegram] Auto-registered chat ID: ${chatId}`);
  }

  const parsed = signalParser.parse(text);

  // Market-hours gate — drop signals outside live session (NSE 09:15–15:30,
  // MCX 09:00–23:30, weekdays only).  We still record the message in
  // lastMessages so the dashboard shows it, but tagged NO_MATCH_OFF_HOURS.
  if (parsed && !isAnyMarketOpen()) {
    console.log(`[Telegram] ⏰ Signal ignored — market closed: ${parsed.action} ${parsed.symbol}`);
    lastMessages.unshift({
      ts:     new Date().toISOString(),
      text,
      chatId,
      parsed,
      status: 'OFF_HOURS',
    });
    if (lastMessages.length > 50) lastMessages.pop();
    return;
  }

  lastMessages.unshift({
    ts: new Date().toISOString(),
    text,
    chatId,
    parsed: parsed || null,
    status: parsed ? 'MATCHED' : 'NO_MATCH',
  });
  if (lastMessages.length > 50) lastMessages.pop();

  if (!parsed) {
    // Not logged — format mismatches can be frequent (bot receives all group messages)
    return;
  }

  console.log(`[Telegram] ✓ Signal: ${parsed.action} ${parsed.symbol} entries=${parsed.entries.join(',')} sl=${parsed.sl} targets=${parsed.targets.join(',')}`);

  const signalId = uuidv4();
  broadcast('signal', {
    id: signalId,
    ts: Date.now(),
    chatId,
    raw: text,
    parsed,
  });

  const { quantity, exchange, product } = store.getTradingDefaults();

  // Paper trading — bypass Kite entirely, fills simulate after 30 s
  if (store.getTestMode()) {
    for (const entryPrice of parsed.entries) {
      const tradeId = uuidv4();
      // Broadcast a pending signal so the UI can show the countdown
      broadcast('paper_trade_pending', {
        id: tradeId,
        signalId,
        symbol: parsed.symbol,
        action: parsed.action,
        entryPrice,
        fillsAt: Date.now() + 30_000,
      });

      setTimeout(() => {
        if (!store.getTestMode()) return; // cancelled if mode switched off
        const paperTrade = {
          id: tradeId,
          ts: Date.now(),
          signalId,
          symbol: parsed.symbol,
          action: parsed.action,
          entryPrice,
          quantity,
          sl: parsed.sl,
          target: parsed.targets[0] ?? null,
          targets: parsed.targets,
          status: 'OPEN',
          exitPrice: null,
          pnl: null,
          closedTs: null,
        };
        store.addPaperTrade(paperTrade);
        broadcast('paper_trade', paperTrade);
        broadcast('paper_balance', store.getPaperBalance());
      }, 30_000);
    }
    return;
  }

  // Live trading — place one BUY order per entry price
  for (const entryPrice of parsed.entries) {
    let orderId = null;
    try {
      const orderResult = await kiteService.placeOrder({
        variety: 'regular',
        tradingsymbol: parsed.symbol,
        exchange,
        transaction_type: parsed.action,
        quantity,
        product,
        order_type: entryPrice ? 'LIMIT' : 'MARKET',
        ...(entryPrice ? { price: entryPrice } : {}),
      });
      orderId = orderResult?.data?.order_id || null;

      broadcast('order_placed', {
        id: uuidv4(),
        ts: Date.now(),
        signalId,
        orderId,
        symbol: parsed.symbol,
        action: parsed.action,
        price: entryPrice,
        sl: parsed.sl,
        target: parsed.targets[0] ?? null,
        targets: parsed.targets,
        status: 'OPEN',
        gttStatus: null,
      });
    } catch (err) {
      console.error('[Order] Entry order failed:', err.message);
      broadcast('order_placed', {
        id: uuidv4(),
        ts: Date.now(),
        signalId,
        symbol: parsed.symbol,
        action: parsed.action,
        price: entryPrice,
        status: 'FAILED',
        error: err.message,
        gttStatus: null,
      });
      continue;
    }

    // GTT for SL + Target
    if (!parsed.sl && parsed.targets.length === 0) continue;

    const exitAction = parsed.action === 'BUY' ? 'SELL' : 'BUY';
    const triggerValues = buildTriggerValues(parsed.action, parsed.sl, parsed.targets[0]);
    if (triggerValues.length === 0) continue;

    try {
      const gttResult = await kiteService.placeGTT({
        type: parsed.sl && parsed.targets[0] ? 'two-leg' : 'single',
        tradingsymbol: parsed.symbol,
        exchange,
        trigger_values: triggerValues,
        last_price: entryPrice,
        orders: buildGTTOrders(parsed.sl, parsed.targets[0], exitAction, quantity, product),
      });

      broadcast('gtt_placed', {
        id: uuidv4(),
        ts: Date.now(),
        signalId,
        orderId,
        gttId: gttResult?.data?.trigger_id || null,
        symbol: parsed.symbol,
        sl: parsed.sl,
        target: parsed.targets[0] ?? null,
        status: 'active',
      });
    } catch (err) {
      console.error('[GTT] Failed:', err.message);
      broadcast('gtt_placed', {
        id: uuidv4(),
        ts: Date.now(),
        signalId,
        orderId,
        symbol: parsed.symbol,
        sl: parsed.sl,
        target: parsed.targets[0] ?? null,
        status: 'FAILED',
        error: err.message,
      });
    }
  }
}

function buildTriggerValues(action, sl, target) {
  return [sl, target].filter(Boolean).map(Number).sort((a, b) => a - b);
}

function buildGTTOrders(sl, target, exitAction, quantity, product) {
  return [sl, target]
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .map((triggerPrice) => ({
      transaction_type: exitAction,
      quantity,
      product,
      order_type: 'LIMIT',
      price: triggerPrice,
    }));
}

function getDebugInfo() {
  return { isPolling, offset, lastMessages };
}

module.exports = { start, stop, getStatus, getDebugInfo };
