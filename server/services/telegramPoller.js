const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const store = require('../store');
const signalParser = require('./signalParser');
const kiteService = require('./kiteService');
const { broadcast } = require('../sseHub');

let offset = 0;
let isPolling = false;
let pollTimeout = null;
let lastMessages = [];

function getStatus() {
  return { isPolling, offset };
}

function start() {
  if (isPolling) throw new Error('Telegram polling is already running');
  const { telegram } = store.getConfig();
  if (!telegram.botToken) throw new Error('Telegram bot token is not configured');
  isPolling = true;
  broadcast('status', { pollingStatus: 'running' });
  schedulePoll();
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
    for (const update of response.data?.result || []) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (err) {
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

  const parsed = signalParser.parse(text);

  lastMessages.unshift({
    ts: new Date().toISOString(),
    text,
    chatId,
    parsed: parsed || null,
    status: parsed ? 'MATCHED' : 'NO_MATCH',
  });
  if (lastMessages.length > 50) lastMessages.pop();

  if (!parsed) {
    console.log(`[Telegram] ❌ Format mismatch. Message ignored: "${text.replace(/\n/g, ' | ')}"`);
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
