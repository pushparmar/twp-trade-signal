/**
 * MacroWatcher — subscribes VIX, Crude Oil, USDINR to KiteTicker,
 * seeds candleStore buffers, and broadcasts a macro_update SSE event
 * on every candle close — same pattern as indexSignalWatcher.
 *
 * Clients receive real-time macro analysis without polling.
 */

const candleStore    = require('./candleStore');
const kiteTicker     = require('./kiteTicker');
const { broadcast }  = require('../sseHub');
const { analyze, VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');

const MACRO_INTERVALS = ['15minute', '60minute', 'day'];

// Set of "token:interval" we care about — populated on start()
const _watchSet = new Set();

/**
 * Called by kiteTicker on every candle close.
 * Runs full macro analysis and pushes result to all SSE clients.
 */
async function onCandleClose(token, interval) {
  if (!_watchSet.has(`${Number(token)}:${interval}`)) return;
  try {
    const data = await analyze();
    broadcast('macro_update', data);
  } catch (err) {
    console.warn('[MacroWatcher] Analysis error:', err.message);
  }
}

/**
 * Subscribe macro tokens to KiteTicker and pre-seed candleStore buffers.
 * Must be called after instrumentCache has loaded.
 */
function start() {
  const crudeInst  = getFrontMonthFutures('CRUDEOIL', 'MCX');
  const usdinrInst = getFrontMonthFutures('USDINR',   'CDS');

  const tokens = [
    VIX_TOKEN,
    crudeInst?.instrumentToken,
    usdinrInst?.instrumentToken,
  ].filter(Boolean);

  // Build fast-lookup set
  _watchSet.clear();
  for (const token of tokens) {
    for (const interval of MACRO_INTERVALS) {
      _watchSet.add(`${token}:${interval}`);
    }
  }

  // Subscribe to live tick stream
  kiteTicker.subscribe(tokens);

  // Pre-seed candle buffers so first candle close has data ready
  for (const token of tokens) {
    for (const interval of MACRO_INTERVALS) {
      candleStore.getCandles(token, interval).catch((e) => {
        console.warn(`[MacroWatcher] Seed failed ${token}:${interval} —`, e.message);
      });
    }
  }

  const names = ['VIX', crudeInst ? 'Crude' : null, usdinrInst ? 'USDINR' : null]
    .filter(Boolean).join(', ');
  console.log(`[MacroWatcher] Ready — watching ${names} on 15m / 1h / 1d`);
}

module.exports = { start, onCandleClose };
