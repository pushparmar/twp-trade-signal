// Manages SSE connections and broadcasts events to all connected clients.
const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// ── Per-token tick throttle ───────────────────────────────────────────────────
// Kite WebSocket can fire 3-5 ticks/second per instrument. Broadcasting every
// single tick saturates the SSE pipe and causes the browser EventSource queue
// to back up, producing the appearance of 5-second batch updates on the chart.
//
// Strategy: for 'tick' events, keep the LATEST payload for each token and flush
// it on a fixed interval (TICK_INTERVAL_MS). All other event types bypass this
// and are sent immediately as before.
const TICK_INTERVAL_MS = 250; // 4 updates/sec — smooth and lightweight
const _pendingTicks = new Map(); // instrumentToken → latest payload object
let _tickFlushTimer = null;

function _scheduledTickFlush() {
  if (_pendingTicks.size === 0) {
    _tickFlushTimer = null;
    return;
  }

  for (const [, tickData] of _pendingTicks) {
    broadcast('tick', tickData); // uses the normal broadcast path
  }
  _pendingTicks.clear();

  // Reschedule only while there are clients
  if (clients.size > 0) {
    _tickFlushTimer = setTimeout(_scheduledTickFlush, TICK_INTERVAL_MS);
  } else {
    _tickFlushTimer = null;
  }
}

/**
 * Queue a tick payload for throttled delivery.
 * Only the most recent value per token is kept — intermediate ticks during the
 * interval window are dropped (only the latest price matters for chart updates).
 */
function broadcastTick(tickData) {
  _pendingTicks.set(tickData.instrumentToken, tickData);

  if (!_tickFlushTimer) {
    _tickFlushTimer = setTimeout(_scheduledTickFlush, TICK_INTERVAL_MS);
  }
}

module.exports = { addClient, broadcast, broadcastTick };
