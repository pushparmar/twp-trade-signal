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
 * Entry / SL logic:
 *   Price crosses chikou → pulls back to chikou → enter at chikou ± 1%
 *   CALL BUY: entry = chikou + 1%,  SL = swing low  if ≤5% from chikou, else chikou − 5%
 *   PUT  BUY: entry = chikou − 1%,  SL = swing high if ≤5% from chikou, else chikou + 5%
 */

const candleStore = require('./candleStore');
const { getSignals } = require('./ichimoku');
const atmResolver = require('./atmResolver');
const telegramNotifier = require('./telegramNotifier');
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
 * Entry  = chikou ± 1%  (price expected to pull back to chikou before moving)
 * SL     = swing low/high of last 5 candles IF within 5% of chikou
 *          otherwise cap at chikou ∓ 5% (avoid oversized risk)
 *
 * chikou = signals.price26ago (close from 26 bars ago — the level price crossed)
 */
function _calculateEntryAndSL(candles, signals, signalType) {
  const chikou = signals.price26ago;
  if (!chikou) return { entry: null, sl: null, slBasis: 'n/a' };

  const n     = candles.length;
  const slice = candles.slice(Math.max(0, n - 6), n - 1); // 5 candles before current

  if (signalType === 'CALL_BUY') {
    const entry    = Math.round(chikou * 1.01 * 100) / 100;
    const lows     = slice.map((c) => c.low).filter(Boolean);
    const swingLow = lows.length > 0 ? Math.min(...lows) : null;

    if (swingLow != null) {
      const distPct = ((chikou - swingLow) / chikou) * 100;
      if (distPct <= 5) {
        return { entry, sl: Math.round(swingLow * 100) / 100, slBasis: `swing low (${distPct.toFixed(1)}% from chikou)` };
      }
    }
    return { entry, sl: Math.round(chikou * 0.95 * 100) / 100, slBasis: 'chikou − 5%' };
  }

  // PUT_BUY
  const entry     = Math.round(chikou * 0.99 * 100) / 100;
  const highs     = slice.map((c) => c.high).filter(Boolean);
  const swingHigh = highs.length > 0 ? Math.max(...highs) : null;

  if (swingHigh != null) {
    const distPct = ((swingHigh - chikou) / chikou) * 100;
    if (distPct <= 5) {
      return { entry, sl: Math.round(swingHigh * 100) / 100, slBasis: `swing high (${distPct.toFixed(1)}% from chikou)` };
    }
  }
  return { entry, sl: Math.round(chikou * 1.05 * 100) / 100, slBasis: 'chikou + 5%' };
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
    if (!candles || candles.length < 52) return;

    const signals = getSignals(candles, interval);
    if (!signals) return;

    const st = _getState(key);

    if (signals.putBuySignal && !st.putBuySignal) {
      st.putBuySignal  = true;
      st.callBuySignal = false;
      const { entry, sl, slBasis } = _calculateEntryAndSL(candles, signals, 'PUT_BUY');
      await _notify(cfg.name, 'PUT_BUY', signals, entry, sl, slBasis, interval);
    }

    if (signals.callBuySignal && !st.callBuySignal) {
      st.callBuySignal = true;
      st.putBuySignal  = false;
      const { entry, sl, slBasis } = _calculateEntryAndSL(candles, signals, 'CALL_BUY');
      await _notify(cfg.name, 'CALL_BUY', signals, entry, sl, slBasis, interval);
    }

    // Reset when signal clears so the next crossing can fire again
    if (!signals.putBuySignal)  st.putBuySignal  = false;
    if (!signals.callBuySignal) st.callBuySignal = false;

  } catch (err) {
    console.warn(`[IndexSignalWatcher] Error on ${key}:`, err.message);
  }
}

async function _notify(indexName, signalType, signals, entry, sl, slBasis, interval) {
  const chatId = store.getTelegramChatId();
  if (!chatId) {
    console.warn('[IndexSignalWatcher] No Telegram chat ID configured — signal not sent');
    return;
  }

  const optionType = signalType === 'PUT_BUY' ? 'PE' : 'CE';
  let atmOption = null;
  try {
    atmOption = await atmResolver.resolve(indexName, optionType);
  } catch (e) {
    atmOption = { error: e.message };
  }

  const text = _formatMessage(indexName, signalType, signals, entry, sl, slBasis, interval, atmOption);

  try {
    await telegramNotifier.sendMessage(chatId, text);
    console.log(`[IndexSignalWatcher] Sent ${signalType} on ${indexName} (${interval})`);
  } catch (err) {
    console.error('[IndexSignalWatcher] Telegram send failed:', err.message);
  }
}

function _formatMessage(indexName, signalType, signals, entry, sl, slBasis, interval, atmOption) {
  const optionType  = signalType === 'PUT_BUY' ? 'PE' : 'CE';
  const emoji       = signalType === 'PUT_BUY' ? '🔴' : '🟢';
  const label       = signalType === 'PUT_BUY' ? 'PUT BUY' : 'CALL BUY';
  const crossDir    = signalType === 'CALL_BUY' ? 'above' : 'below';
  const entryOffset = signalType === 'CALL_BUY' ? '+1%' : '−1%';

  const lines = [
    `${emoji} <b>${label} — ${indexName} (${interval})</b>`,
    ``,
    `Close  : ${signals.close}`,
    `Chikou : <b>${signals.price26ago}</b>  (price closed ${crossDir})`,
    `Kijun  : ${signals.kijun}  |  Expansion: ${signals.expansionPct}%`,
    ``,
    `Entry  : <b>${entry ?? '—'}</b>  <i>(chikou ${entryOffset} on pullback)</i>`,
    `SL     : <b>${sl ?? '—'}</b>  <i>(${slBasis})</i>`,
  ];

  if (atmOption && !atmOption.error) {
    const inst = atmOption.instrument;
    lines.push(``);
    lines.push(`<b>ATM ${optionType}: ${inst?.tradingsymbol || `${indexName} ${atmOption.atmStrike}${optionType}`}</b>`);
    if (atmOption.atmStrike) lines.push(`Strike : ${atmOption.atmStrike}`);
    if (inst?.expiry)        lines.push(`Expiry : ${inst.expiry}`);
    if (atmOption.ltp)       lines.push(`Index LTP: ${atmOption.ltp}`);
  } else if (atmOption?.error) {
    lines.push(``);
    lines.push(`ATM resolve failed: ${atmOption.error}`);
  }

  return lines.join('\n');
}

/**
 * Pre-seed candle buffers for all watched token+interval combos.
 * getCandlesSync returns null until the async seed completes — calling
 * getCandles() here ensures data is ready before the first candle close.
 */
function start() {
  for (const { token, interval } of INDEX_WATCHES) {
    candleStore.getCandles(token, interval).catch((e) => {
      console.warn(`[IndexSignalWatcher] Seed failed ${token}:${interval} —`, e.message);
    });
  }
  console.log('[IndexSignalWatcher] Ready — watching NIFTY/BANKNIFTY on 1m / 5m / 15m');
}

function stop() {
  _state.clear();
}

module.exports = { start, stop, onCandleClose };
