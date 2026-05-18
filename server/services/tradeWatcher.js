/**
 * tradeWatcher.js
 *
 * Server-side SL / Target / Trailing-SL handler.
 *
 * Simple rule: once a trade is placed and the token is subscribed to the live
 * ticker, every tick's lastPrice is checked against SL and target.  That's it.
 * No OHLC, no day high/low, no running-extreme map.  Live price is authoritative.
 *
 * Output:
 *   • broadcast('paper_trade_update', closedTrade)
 *   • broadcast('paper_balance', balance)
 *   • db.tradeRepo.closeTrade(trade)
 *   • kiteTicker unsubscribes the token when no longer needed
 */

const store         = require('../store');
const { broadcast } = require('../sseHub');
const db            = require('../db');

// Lazy-require kiteTicker to avoid circular dep (kiteTicker requires this module).
function _ticker() {
  return require('./kiteTicker');
}

// Per-trade close-claim guard — prevents double-close when multiple ticks
// arrive in the same JS event loop frame.
const _closing = new Set();

// Throttle live-tick SSE broadcasts to once every 500 ms per trade so we
// don't flood the SSE queue.  Map<tradeId, lastBroadcastMs>
const _lastTickBroadcast = new Map();

/**
 * Move the stop-loss favourably when TSL is enabled and the profit threshold
 * has been crossed.  Mutates trade in-place and persists to store + MongoDB.
 *
 * @returns {boolean} true when SL was moved
 */
function _maybeTrail(trade, ltp, settings) {
  if (!settings.tslEnabled) return false;
  if (trade.action !== 'BUY' && trade.action !== 'SELL') return false;

  const initialSl   = trade.initialSl ?? trade.sl;
  const riskPerUnit = Math.abs(trade.entryPrice - initialSl);
  if (riskPerUnit < 0.01) return false;

  const profit = trade.action === 'BUY'
    ? ltp - trade.entryPrice
    : trade.entryPrice - ltp;
  if (profit < settings.tslTriggerR * riskPerUnit) return false;

  const prevPeak = trade.peakPrice ?? trade.entryPrice;
  const newPeak  = trade.action === 'BUY'
    ? Math.max(prevPeak, ltp)
    : Math.min(prevPeak, ltp);

  const trailGap    = settings.tslDistanceR * riskPerUnit;
  const candidateSl = trade.action === 'BUY'
    ? newPeak - trailGap
    : newPeak + trailGap;

  const shouldMove = trade.action === 'BUY'
    ? candidateSl > (trade.sl ?? -Infinity)
    : candidateSl < (trade.sl ??  Infinity);
  if (!shouldMove) return false;

  const newSl = Math.round(candidateSl * 100) / 100;
  const wasArmed = trade.tslActivated;
  store.updatePaperTrade(trade.id, { sl: newSl, peakPrice: newPeak, tslActivated: true });
  trade.sl           = newSl;
  trade.peakPrice    = newPeak;
  trade.tslActivated = true;

  db.tradeRepo.upsertTrade(trade);
  broadcast('paper_trade_update', trade);

  if (!wasArmed) {
    console.log(`[TradeWatcher] 🔒 TSL armed — ${trade.symbol} SL → ₹${newSl}`);
  }
  return true;
}

/**
 * Check if the current live price hits SL or target.
 * Uses lastPrice only — no OHLC, no day extremes.
 *
 * @returns {{ closeAt: number, reason: string } | null}
 */
function _checkExit(trade, ltp) {
  if (trade.action === 'BUY') {
    if (trade.sl     != null && ltp <= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && ltp >= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  } else if (trade.action === 'SELL') {
    if (trade.sl     != null && ltp >= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && ltp <= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  }
  return null;
}

/**
 * Close a trade and sync everywhere.  Idempotent — a second call for the same
 * id is a no-op (closePaperTrade returns null when already CLOSED).
 */
function _closeTrade(trade, closeAt, reason) {
  if (_closing.has(trade.id)) return;
  _closing.add(trade.id);

  const closed = store.closePaperTrade(trade.id, closeAt);
  if (!closed) { _closing.delete(trade.id); return; }

  // Clean up per-trade tick-throttle entry so the Map doesn't grow forever.
  _lastTickBroadcast.delete(trade.id);

  broadcast('paper_trade_update', closed);
  broadcast('paper_balance',      store.getPaperBalance());
  db.tradeRepo.closeTrade(closed);

  // Unsubscribe token if no other open trade or watchlist entry still needs it
  try {
    const numToken   = Number(closed.token);
    const stillOpen  = store.getPaperTrades().some(
      (t) => t.status === 'OPEN' && Number(t.token) === numToken,
    );
    const inWatchlist = store.getWatchlist().some(
      (w) => Number(w.instrumentToken) === numToken,
    );
    if (!stillOpen && !inWatchlist) _ticker().unsubscribe([numToken]);
  } catch { /* ticker may not be connected */ }

  const emoji = reason === 'TARGET' ? '🎯' : reason === 'TSL' ? '🔒' : '🛑';
  console.log(
    `[TradeWatcher] ${emoji} ${reason} — ${closed.symbol} ` +
    `[${closed.tfLabel ?? closed.interval ?? '-'}] ${closed.action} ` +
    `entry=₹${closed.entryPrice} exit=₹${closeAt} pnl=₹${closed.pnl}`,
  );

  setTimeout(() => _closing.delete(trade.id), 1_000);
}

/**
 * Called on every Kite tick from kiteTicker.js.
 * Synchronous and fast — hundreds of ticks/sec across all subscriptions.
 *
 * @param {number} token      Instrument token
 * @param {number} lastPrice  Live price (tick.last_price)
 */
function onTick(token, lastPrice) {
  if (lastPrice == null) return;

  const numToken   = Number(token);
  const openTrades = store.getPaperTrades().filter(
    (t) =>
      t.status   === 'OPEN' &&
      Number(t.token) === numToken &&
      (t.source === 'auto' || t.source === 'scan'),
  );
  if (openTrades.length === 0) return;

  const settings = store.getAutoTraderSettings();
  const now      = Date.now();

  for (const trade of openTrades) {
    _maybeTrail(trade, lastPrice, settings);

    const exit = _checkExit(trade, lastPrice);
    if (exit) {
      // SL or target hit — close and unsubscribe (see _closeTrade).
      _closeTrade(trade, exit.closeAt, exit.reason);
      continue; // trade is now closed; skip live-tick broadcast
    }

    // ── Throttled live-tick SSE (≤ once per 500 ms per trade) ────────────
    // Lets the Dashboard update unrealised P&L in real time without flooding
    // the SSE queue.
    const lastBcast = _lastTickBroadcast.get(trade.id) ?? 0;
    if (now - lastBcast >= 500) {
      _lastTickBroadcast.set(trade.id, now);
      const unrealizedPnl = trade.action === 'BUY'
        ? (lastPrice - trade.entryPrice) * (trade.quantity ?? 1)
        : (trade.entryPrice - lastPrice) * (trade.quantity ?? 1);
      broadcast('paper_trade_tick', {
        id:            trade.id,
        token:         numToken,
        ltp:           lastPrice,
        unrealizedPnl: +unrealizedPnl.toFixed(2),
      });
    }
  }
}

module.exports = { onTick };
