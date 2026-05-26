/**
 * priceBroadcaster.js — Index Trade module
 *
 * Pushes live option chain prices to connected clients via SSE every 3s.
 * Clients subscribe once on page load; all subsequent price updates arrive
 * via the `idx_option_chain` SSE event — no client-side polling needed.
 *
 * Also broadcasts a heartbeat so the client knows the feed is alive.
 */

const { broadcast } = require('../sseHub');
const { isNseOpen } = require('../utils/marketHours');
const strikeManager = require('./strikeManager');

const BROADCAST_MS = 3_000; // push prices every 3 seconds

let _timer = null;
let _lastChainJson = '';   // skip broadcast if data hasn't changed

function _push() {
  try {
    const chain = strikeManager.getOptionChain();
    const json  = JSON.stringify(chain);

    // Only broadcast if data changed (saves bandwidth)
    if (json === _lastChainJson) return;
    _lastChainJson = json;

    broadcast('idx_option_chain', chain);
  } catch { /* ignore */ }
}

function start() {
  _timer = setInterval(_push, BROADCAST_MS);
  console.log(`[IdxPriceBroadcaster] Started — pushing option chain every ${BROADCAST_MS}ms via SSE`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop };
