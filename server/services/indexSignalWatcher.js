/**
 * Reacts to candle-close events from KiteTicker (via candleStore.onTick).
 * Watches NIFTY and BANKNIFTY across 1m / 5m / 15m intervals.
 *
 * Deduplication per token+interval:
 *   false → true  : send Telegram
 *   stays true    : skip (already notified)
 *   goes false    : reset — next true will fire again
 *   midnight IST  : full reset so a fresh day can re-trigger
 *
 * Signal → ATM option → option LTP → entry/SL/target in option premium terms
 *   Entry  = option LTP at signal time
 *   SL     = entry − (index SL% × option LTP), capped at 25% of option LTP
 *   Target = entry + 2 × risk  (1:2 RR)
 */

const candleStore = require('./candleStore');
const { getSignals } = require('./ichimoku');
const atmResolver = require('./atmResolver');
const telegramNotifier = require('./telegramNotifier');
const kiteService = require('./kiteService');
const store = require('../store');

// All token+interval combinations to watch
const INDEX_WATCHES = [
  { token: 256265, name: 'NIFTY',     interval: '1minute'  },
  { token: 256265, name: 'NIFTY',     interval: '5minute'  },
  { token: 256265, name: 'NIFTY',     interval: '15minute' },
  { token: 260105, name: 'BANKNIFTY', interval: '1minute'  },
  { token: 260105, name: 'BANKNIFTY', interval: '5minute'  },
  { token: 260105, name: 'BANKNIFTY', interval: '15minute' },
];

// Fast lookup: "token:interval" → watch config
const _watchMap = new Map(
  INDEX_WATCHES.map((w) => [`${w.token}:${w.interval}`, w])
);

// Dedup state per "token:interval"
// { putBuySignal: bool, callBuySignal: bool, date: string }
const _state = new Map();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function _getState(key) {
  const today = _istDateStr();
  const existing = _state.get(key);
  // Reset on new day
  if (!existing || existing.date !== today) {
    const fresh = { putBuySignal: false, callBuySignal: false, date: today };
    _state.set(key, fresh);
    return fresh;
  }
  return existing;
}

/**
 * Given the option's current LTP and the index SL % distance from chikou,
 * compute option entry, SL, and target (1:2 RR).
 *
 * CALL BUY: entry = optionLtp, SL below, target above
 * PUT  BUY: entry = optionLtp, SL below (options lose value going wrong way), target above
 *
 * SL distance mirrors the index SL % capped at 25% of option LTP.
 * Target = entry + 2 × risk  (1:2 reward:risk).
 */
function _optionLevels(optionLtp, indexSlPct) {
  const risk   = Math.round(optionLtp * Math.min(indexSlPct / 100, 0.25) * 100) / 100;
  const entry  = Math.round(optionLtp * 100) / 100;
  const sl     = Math.round((entry - risk) * 100) / 100;
  const target = Math.round((entry + risk * 2) * 100) / 100;
  return { entry, sl, target };
}

/**
 * Compute how far the index SL is from chikou as a %.
 * CALL: SL = swing low of last 5 candles if ≤5% from chikou, else chikou − 5%
 * PUT:  SL = swing high of last 5 candles if ≤5% from chikou, else chikou + 5%
 */
function _indexSlPct(candles, signals, signalType) {
  const chikou = signals.price26ago;
  if (!chikou) return 5; // default 5%

  const n     = candles.length;
  const slice = candles.slice(Math.max(0, n - 6), n - 1);

  if (signalType === 'CALL_BUY') {
    const lows     = slice.map((c) => c.low).filter(Boolean);
    const swingLow = lows.length > 0 ? Math.min(...lows) : null;
    if (swingLow != null) {
      const distPct = ((chikou - swingLow) / chikou) * 100;
      return distPct <= 5 ? distPct : 5;
    }
    return 5;
  }

  const highs     = slice.map((c) => c.high).filter(Boolean);
  const swingHigh = highs.length > 0 ? Math.max(...highs) : null;
  if (swingHigh != null) {
    const distPct = ((swingHigh - chikou) / chikou) * 100;
    return distPct <= 5 ? distPct : 5;
  }
  return 5;
}

/**
 * Called by kiteTicker on every candle close.
 * Ignores tokens/intervals not in our watch list instantly.
 */
async function onCandleClose(token, interval) {
  const key = `${Number(token)}:${interval}`;
  const cfg = _watchMap.get(key);
  if (!cfg) return;

  try {
    const candles = candleStore.getCandlesSync(token, interval);
    if (!candles || candles.length < 26) return;

    const signals = getSignals(candles, interval);
    if (!signals) return;

    const st = _getState(key);

    if (signals.putBuySignal && !st.putBuySignal) {
      st.putBuySignal  = true;
      st.callBuySignal = false;
      await _notify(cfg.name, 'PUT_BUY', signals, candles, interval);
    }

    if (signals.callBuySignal && !st.callBuySignal) {
      st.callBuySignal = true;
      st.putBuySignal  = false;
      await _notify(cfg.name, 'CALL_BUY', signals, candles, interval);
    }

    // Reset when signal clears so the next crossing can fire again
    if (!signals.putBuySignal)  st.putBuySignal  = false;
    if (!signals.callBuySignal) st.callBuySignal = false;

  } catch (err) {
    console.warn(`[IndexSignalWatcher] Error on ${key}:`, err.message);
  }
}

async function _notify(indexName, signalType, signals, candles, interval) {
  const chatId = store.getTelegramChatId();
  if (!chatId) {
    console.warn('[IndexSignalWatcher] No Telegram chat ID configured — signal not sent');
    return;
  }

  const optionType = signalType === 'PUT_BUY' ? 'PE' : 'CE';

  // Resolve ATM option
  let atmOption = null;
  try {
    atmOption = await atmResolver.resolve(indexName, optionType);
  } catch (e) {
    console.warn(`[IndexSignalWatcher] ATM resolve failed: ${e.message}`);
  }

  if (!atmOption || atmOption.error) {
    console.warn('[IndexSignalWatcher] Skipping — no ATM option resolved');
    return;
  }

  // Get option's current LTP
  let optionLtp = null;
  try {
    const inst = atmOption.instrument;
    const symbol = `${inst.exchange}:${inst.tradingsymbol}`;
    const ltpData = await kiteService.getLTP([symbol]);
    optionLtp = ltpData[symbol]?.last_price ?? Object.values(ltpData)[0]?.last_price ?? null;
  } catch (e) {
    console.warn(`[IndexSignalWatcher] Option LTP fetch failed: ${e.message}`);
  }

  if (!optionLtp) {
    console.warn('[IndexSignalWatcher] Skipping — could not fetch option LTP');
    return;
  }

  const slPct = _indexSlPct(candles, signals, signalType);
  const { entry, sl, target } = _optionLevels(optionLtp, slPct);
  const text = _formatMessage(indexName, signalType, atmOption, entry, sl, target, interval, signals);

  try {
    await telegramNotifier.sendMessage(chatId, text);
    console.log(`[IndexSignalWatcher] Sent ${signalType} on ${indexName} (${interval}) — option LTP ${optionLtp}`);
  } catch (err) {
    console.error('[IndexSignalWatcher] Telegram send failed:', err.message);
  }
}

function _formatMessage(indexName, signalType, atmOption, entry, sl, target, interval, signals) {
  const emoji = signalType === 'PUT_BUY' ? '🔴' : '🟢';
  const label = signalType === 'PUT_BUY' ? 'PUT BUY' : 'CALL BUY';
  const inst  = atmOption.instrument;

  return [
    `${emoji} <b>${label} — ${indexName} (${interval})</b>`,
    ``,
    `<b>${inst.tradingsymbol}</b>`,
    `Expiry : ${inst.expiry}`,
    ``,
    `Entry  : <b>${entry}</b>`,
    `SL     : <b>${sl}</b>`,
    `Target : <b>${target}</b>`,
  ].join('\n');
}

/**
 * Pre-seed candle buffers for all watched token+interval combos.
 * getCandlesSync returns null until the async seed completes — calling
 * getCandles() here ensures data is ready before the first candle close.
 */
// Additional intervals needed for index tab display (not used for trade signals)
const DISPLAY_INTERVALS = ['60minute', 'day'];
const INDEX_TOKENS = [...new Set(INDEX_WATCHES.map((w) => w.token))]; // [256265, 260105]

function start() {
  // Seed trade-signal intervals
  for (const { token, interval } of INDEX_WATCHES) {
    candleStore.getCandles(token, interval).catch((e) => {
      console.warn(`[IndexSignalWatcher] Seed failed ${token}:${interval} —`, e.message);
    });
  }

  // Seed 1h and 1d so the index tab 4h/1d columns have data on first load
  for (const token of INDEX_TOKENS) {
    for (const interval of DISPLAY_INTERVALS) {
      candleStore.getCandles(token, interval).catch((e) => {
        console.warn(`[IndexSignalWatcher] Seed failed ${token}:${interval} —`, e.message);
      });
    }
  }

  console.log('[IndexSignalWatcher] Ready — watching NIFTY/BANKNIFTY on 1m / 5m / 15m (display: 1h / 4h / 1d)');
}

function stop() {
  _state.clear();
}

module.exports = { start, stop, onCandleClose };
