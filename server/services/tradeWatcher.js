/**
 * tradeWatcher.js
 *
 * Server-side SL / Target / Trailing-SL handler for cash/equity paper trades.
 *
 * Per-tick monitoring: SL, TSL, and target fire immediately when the share
 * price tick breaches the level — no candle-close gating, no derivatives.
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

function _ticker() {
  return require('./kiteTicker');
}

const _closing           = new Set();
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
  const entry       = trade.entryPrice;
  const riskPerUnit = Math.abs(entry - initialSl);
  if (riskPerUnit < 0.01) return false;

  const profit = trade.action === 'BUY'
    ? ltp - entry
    : entry - ltp;
  if (profit < settings.tslTriggerR * riskPerUnit) return false;

  const prevPeak = trade.peakPrice ?? entry;
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
 * Check if the current tick price breaches SL or target.
 * Called on every tick — fires immediately on the first breach.
 *
 * @returns {{ closeAt: number, reason: string } | null}
 */
function _checkExit(trade, lastPrice) {
  if (trade.action === 'BUY') {
    if (trade.sl     != null && lastPrice <= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && lastPrice >= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  } else if (trade.action === 'SELL') {
    if (trade.sl     != null && lastPrice >= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && lastPrice <= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  }
  return null;
}

function _closeTrade(trade, closeAt, reason) {
  if (_closing.has(trade.id)) return;
  _closing.add(trade.id);

  const closed = store.closePaperTrade(trade.id, closeAt);
  if (!closed) { _closing.delete(trade.id); return; }

  _lastTickBroadcast.delete(trade.id);

  broadcast('paper_trade_update', closed);
  broadcast('paper_balance',      store.getPaperBalance());
  db.tradeRepo.closeTrade(closed);

  // Unsubscribe the share token if no other trade or watchlist needs it
  try {
    const tk = Number(closed.token);
    const stillNeeded = store.getPaperTrades().some(
      (t) => (t.status === 'OPEN' || t.status === 'PENDING') &&
             Number(t.token) === tk,
    );
    const inWatchlist = store.getWatchlist().some(
      (w) => Number(w.instrumentToken) === tk,
    );
    if (!stillNeeded && !inWatchlist) _ticker().unsubscribe([tk]);
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
 *
 * @param {number} token      Instrument token
 * @param {number} lastPrice  Live price (tick.last_price)
 */
function onTick(token, lastPrice) {
  if (lastPrice == null) return;

  const numToken = Number(token);

  // ── Pending order activation (tick-based — limit orders fill immediately) ─
  const pendingTrades = store.getPaperTrades().filter(
    (t) =>
      t.status === 'PENDING' &&
      Number(t.token) === numToken &&
      t.triggerPrice != null,
  );
  for (const trade of pendingTrades) {
    const triggered =
      trade.triggerDir === 'above'
        ? lastPrice >= trade.triggerPrice
        : lastPrice <= trade.triggerPrice;
    if (!triggered) continue;

    const activated = store.activatePendingTrade(trade.id);
    if (!activated) continue;

    broadcast('paper_trade_update', activated);
    broadcast('paper_balance', store.getPaperBalance());
    db.tradeRepo.upsertTrade(activated);

    console.log(
      `[TradeWatcher] ⚡ TRIGGERED — ${activated.symbol} ${activated.action}` +
      ` @ ₹${activated.entryPrice} (trigger ₹${activated.triggerPrice}, ltp ₹${lastPrice})`,
    );
  }

  // Match open trades by share token
  const openTrades = store.getPaperTrades().filter(
    (t) =>
      t.status === 'OPEN' &&
      Number(t.token) === numToken &&
      (t.source === 'auto' || t.source === 'scan'),
  );
  if (openTrades.length === 0) return;

  const settings = store.getAutoTraderSettings();
  const now      = Date.now();

  for (const trade of openTrades) {
    // ── TSL trailing + SL/Target exit — per-tick on share price ─────────────
    _maybeTrail(trade, lastPrice, settings);

    const exit = _checkExit(trade, lastPrice);
    if (exit) {
      _closeTrade(trade, exit.closeAt, exit.reason);
      continue;
    }

    // ── Live PnL broadcast — throttled to 500 ms per trade ──────────────────
    const lastBcast = _lastTickBroadcast.get(trade.id) ?? 0;
    if (now - lastBcast >= 500) {
      _lastTickBroadcast.set(trade.id, now);
      // Apply MCX lot multiplier so live PnL matches the closed-trade PnL scale.
      const lotMult       = store.getLotMultiplier(trade);
      const unrealizedPnl = trade.action === 'BUY'
        ? (lastPrice - trade.entryPrice) * (trade.quantity ?? 1) * lotMult
        : (trade.entryPrice - lastPrice) * (trade.quantity ?? 1) * lotMult;
      broadcast('paper_trade_tick', {
        id:            trade.id,
        token:         Number(trade.token),
        ltp:           lastPrice,
        unrealizedPnl: +unrealizedPnl.toFixed(2),
      });
    }
  }
}

module.exports = { onTick };
