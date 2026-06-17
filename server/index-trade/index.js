/**
 * Index Trade Module — Entry Point
 *
 * Self-contained index options trading system.
 * Subscribes to ATM ± 5 strikes of NIFTY/SENSEX, runs Ichimoku patterns
 * on 1m/5m/15m, auto-executes paper trades with SL/Target/TSL.
 *
 * Usage (add to server/index.js):
 *   const indexTrade = require('./index-trade');
 *   app.use('/api/index-trade', indexTrade.router);
 *   // after kite auth: indexTrade.start();
 *   // on shutdown: indexTrade.stop();
 */

const router            = require('./routes');
const strikeManager     = require('./strikeManager');
const scanner           = require('./scanner');
const orderManager      = require('./orderManager');
const priceBroadcaster  = require('./priceBroadcaster');
const tradeStore        = require('./tradeStore');

// Lazy require to avoid circular dependency
function _store() { return require('../store'); }

async function start() {
  // ALWAYS restore trades and start the order manager (for EOD close, morning purge).
  // Module config is checked on every signal/entry, not at startup.
  // This allows enabling/disabling at runtime without server restart.

  // Restore open trades from MongoDB (indexes are created by db/index.js on boot)
  await tradeStore.restore();

  // Start sub-modules - ALL must run for lifecycle functions (EOD close, morning purge)
  strikeManager.start();    // resolves ATM strikes, subscribes ticker tokens
  scanner.start();          // polls for candle closes, runs 3 patterns on 1m/5m/15m
  orderManager.start();     // monitors SL/Target/TSL per-tick, places paper orders, EOD close
  priceBroadcaster.start(); // pushes option chain prices via SSE every 3s

  const enabled = _store().isModuleEnabled('indexTrade');
  console.log(`[IndexTrade] Module started (auto-trade currently ${enabled ? 'ENABLED' : 'DISABLED'} via Module Config)`);
}

function stop() {
  priceBroadcaster.stop();
  orderManager.stop();
  scanner.stop();
  strikeManager.stop();
  console.log('[IndexTrade] Module stopped');
}

module.exports = { router, start, stop };
