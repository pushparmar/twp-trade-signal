/**
 * tradeWatcher.js
 *
 * Authoritative server-side SL / Target / Trailing-SL handler.
 *
 * Runs inside the KiteTicker tick handler so trades close the instant a tick
 * breaches a level — no 250 ms SSE throttle, no dependence on a browser tab
 * being open, no race with the client's optimistic close.
 *
 * Responsibilities:
 *   • Trail the stop-loss favourably when TSL is enabled and triggered
 *   • Close the trade at SL when LTP (or current-day high/low) breaches it
 *   • Close the trade at Target when LTP (or current-day high/low) reaches it
 *
 * Why use ohlc.high/low (not just lastPrice)?
 *   Kite tick LTP is throttled in our hot path; a fast spike may print one
 *   tick at the post-spike price.  ohlc.high/low always reflects the day's
 *   true extreme so we catch gap-throughs that the LTP alone would miss.
 *
 * Output:
 *   • broadcast('paper_trade_update', closedTrade)   — same shape as POST /:id/close
 *   • broadcast('paper_balance', balance)            — refreshed available cash
 *   • db.tradeRepo.closeTrade(trade)                 — MongoDB sync
 *   • kiteTicker unsubscribes the token if no other open trade or watchlist
 *     entry needs it (mirrors the manual /close route behaviour)
 */

const store        = require('../store');
const { broadcast } = require('../sseHub');
const db           = require('../db');

// Lazy-require kiteTicker to avoid the circular dep when kiteTicker requires
// THIS module via require() in its tick handler.
function _ticker() {
  return require('./kiteTicker');
}

// Per-trade close-claim guard — prevents the same trade from being closed twice
// when multiple ticks arrive in the same JS event loop frame.
const _closing = new Set();

/**
 * Move the stop-loss favourably if the user has TSL enabled and the trade has
 * crossed the trigger threshold.  Mutates the trade in-place and persists.
 *
 * @returns true when the SL was moved
 */
function _maybeTrail(trade, ltp, settings) {
  if (!settings.tslEnabled)                  return false;
  if (trade.action !== 'BUY' && trade.action !== 'SELL') return false;

  const initialSl   = trade.initialSl ?? trade.sl;
  const riskPerUnit = Math.abs(trade.entryPrice - initialSl);
  if (riskPerUnit < 0.01) return false;

  const profit = trade.action === 'BUY' ? ltp - trade.entryPrice : trade.entryPrice - ltp;
  if (profit < settings.tslTriggerR * riskPerUnit) return false;

  const prevPeak = trade.peakPrice ?? trade.entryPrice;
  const newPeak  = trade.action === 'BUY' ? Math.max(prevPeak, ltp) : Math.min(prevPeak, ltp);

  const trailGap    = settings.tslDistanceR * riskPerUnit;
  const candidateSl = trade.action === 'BUY' ? newPeak - trailGap : newPeak + trailGap;

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

  // Mirror to MongoDB so analytics see the trailed SL on close
  db.tradeRepo.upsertTrade(trade);
  // Broadcast so clients re-render the SL cell immediately
  broadcast('paper_trade_update', trade);

  if (!wasArmed) {
    console.log(`[TradeWatcher] 🔒 TSL armed — ${trade.symbol} SL → ₹${newSl}`);
  }
  return true;
}

/**
 * Decide whether a hit fires and what exit price to record.
 * Uses the most adverse value between ltp and the day's high/low so a gap-
 * through that overshoots the level still records the level (not the over-
 * shoot price) for paper-trade fill realism.
 *
 * Returns null if no hit, otherwise { closeAt, reason }.
 */
function _checkExit(trade, ltp, ohlc) {
  const dayHigh = ohlc?.high ?? ltp;
  const dayLow  = ohlc?.low  ?? ltp;

  if (trade.action === 'BUY') {
    if (trade.sl != null) {
      // SL hit when low pierced or current tick is at/under SL
      if (dayLow <= trade.sl || ltp <= trade.sl) {
        return { closeAt: trade.sl, reason: trade.tslActivated ? 'TSL' : 'SL' };
      }
    }
    if (trade.target != null) {
      if (dayHigh >= trade.target || ltp >= trade.target) {
        return { closeAt: trade.target, reason: 'TARGET' };
      }
    }
  } else if (trade.action === 'SELL') {
    if (trade.sl != null) {
      if (dayHigh >= trade.sl || ltp >= trade.sl) {
        return { closeAt: trade.sl, reason: trade.tslActivated ? 'TSL' : 'SL' };
      }
    }
    if (trade.target != null) {
      if (dayLow <= trade.target || ltp <= trade.target) {
        return { closeAt: trade.target, reason: 'TARGET' };
      }
    }
  }
  return null;
}

/**
 * Close a trade and mirror the change everywhere.  Idempotent: a second call
 * for the same id is a no-op because closePaperTrade returns null when the
 * trade is already CLOSED.
 */
function _closeTrade(trade, closeAt, reason) {
  if (_closing.has(trade.id)) return;
  _closing.add(trade.id);

  const closed = store.closePaperTrade(trade.id, closeAt);
  if (!closed) { _closing.delete(trade.id); return; }

  broadcast('paper_trade_update', closed);
  broadcast('paper_balance',      store.getPaperBalance());
  db.tradeRepo.closeTrade(closed);

  // Unsubscribe token if no other open trade or watchlist entry needs it
  try {
    const numToken = Number(closed.token);
    const stillOpen = store.getPaperTrades().some(
      (t) => t.status === 'OPEN' && Number(t.token) === numToken,
    );
    const inWatchlist = store.getWatchlist().some(
      (w) => Number(w.instrumentToken) === numToken,
    );
    if (!stillOpen && !inWatchlist) _ticker().unsubscribe([numToken]);
  } catch { /* ticker may not be connected — safe to ignore */ }

  const emoji = reason === 'TARGET' ? '🎯' : reason === 'TSL' ? '🔒' : '🛑';
  console.log(
    `[TradeWatcher] ${emoji} ${reason} hit — ${closed.symbol} ` +
    `[${closed.tfLabel ?? closed.interval ?? '-'}] ${closed.action} ` +
    `entry=₹${closed.entryPrice} exit=₹${closeAt} ` +
    `pnl=₹${closed.pnl} (${closed.source}/${closed.patternId})`,
  );

  // Release the close-claim after a short delay so out-of-order ticks don't
  // try to close an already-closed id and produce spurious 404 logs.
  setTimeout(() => _closing.delete(trade.id), 1_000);
}

/**
 * Called on every Kite tick from kiteTicker.js.  MUST stay synchronous and
 * fast — there can be hundreds of ticks per second across all subscriptions.
 *
 * @param {number} token       Instrument token from the tick
 * @param {number} lastPrice   tick.last_price
 * @param {object} [ohlc]      tick.ohlc = { high, low, open, close }
 */
function onTick(token, lastPrice, ohlc) {
  if (lastPrice == null) return;

  const numToken = Number(token);
  // Fast filter: skip if we have no open trades on this token at all
  const openTrades = store.getPaperTrades().filter(
    (t) =>
      t.status === 'OPEN' &&
      Number(t.token) === numToken &&
      (t.source === 'auto' || t.source === 'scan'),
  );
  if (openTrades.length === 0) return;

  // Read TSL settings once per tick (cheap — single config.json read cached
  // by Node's fs; could be cached further in store.js later if hot).
  const settings = store.getAutoTraderSettings();

  for (const trade of openTrades) {
    // 1. Trailing stop loss — may move trade.sl favourably
    _maybeTrail(trade, lastPrice, settings);

    // 2. SL or target hit check (uses updated trade.sl)
    const exit = _checkExit(trade, lastPrice, ohlc);
    if (exit) _closeTrade(trade, exit.closeAt, exit.reason);
  }
}

module.exports = { onTick };
