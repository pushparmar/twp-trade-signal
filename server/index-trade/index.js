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

const router        = require('./routes');
const strikeManager = require('./strikeManager');
const scanner       = require('./scanner');
const orderManager  = require('./orderManager');
const tradeStore    = require('./tradeStore');

async function start() {
  // Create MongoDB indexes + restore open trades
  await tradeStore.createIndexes();
  await tradeStore.restore();

  // Start sub-modules
  strikeManager.start();   // resolves ATM strikes, subscribes ticker tokens
  scanner.start();         // polls for candle closes, runs patterns
  orderManager.start();    // monitors SL/Target/TSL per-tick

  console.log('[IndexTrade] Module started');
}

function stop() {
  orderManager.stop();
  scanner.stop();
  strikeManager.stop();
  console.log('[IndexTrade] Module stopped');
}

module.exports = { router, start, stop };
