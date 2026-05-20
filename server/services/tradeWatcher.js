/**
 * tradeWatcher.js
 *
 * Server-side SL / Target / Trailing-SL handler.
 *
 * SL / Target exit rule:
 *   Only triggers when a 15-minute candle CLOSES beyond the level — wick
 *   touches are ignored.  TSL trailing still runs on every tick so the SL
 *   moves up/down responsively, but the close decision waits for candle close.
 *
 * Price levels per trading mode:
 *   Futures → trade.sl/target are stored as futures-adjusted levels (spot + basis).
 *             Futures candle close is compared against futures SL/target. ✓
 *   Options → trade.sl/target are spot levels; spot candle close is monitored. ✓
 *   Spot    → trade.sl/target are spot levels; spot candle close is monitored. ✓
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

function _kiteService() {
  return require('./kiteService');
}

const _closing           = new Set();
const _lastTickBroadcast = new Map();
// Last known derivative (option premium / futures price) per trade — updated on
// every derivative tick.  Used by _closeTrade so exit PnL is always based on
// a real market price, not the spot SL/target level.
const _lastDerivativeLtp = new Map(); // tradeId → lastDerivativePrice

// ── 15-minute candle close tracking ─────────────────────────────────────────
// SL / Target checks fire only on candle CLOSE to avoid wick-triggered exits.
const CANDLE_MS        = 15 * 60_000;
const _tokenSlot       = new Map(); // instrumentToken → current 15m slot start (ms)
const _tokenClosePrice = new Map(); // instrumentToken → last tick price in current slot

function _15mSlot(nowMs) {
  return Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
}

/**
 * Update the per-token 15m candle tracker and return the close price of the
 * candle that JUST ended, or null if no boundary was crossed on this tick.
 */
function _trackCandle(token, lastPrice) {
  const slot = _15mSlot(Date.now());
  const prev = _tokenSlot.get(token);
  // A boundary is crossed when we move into a new 15m slot AND we had seen
  // at least one previous tick (prev != null).
  const closePrice = (prev != null && prev !== slot)
    ? _tokenClosePrice.get(token) ?? null
    : null;
  _tokenSlot.set(token, slot);
  _tokenClosePrice.set(token, lastPrice);
  return closePrice;
}

function _spotEntry(trade) {
  return trade.spotEntry ?? trade.entryPrice;
}

/**
 * Move the stop-loss favourably when TSL is enabled and the profit threshold
 * has been crossed.  Mutates trade in-place and persists to store + MongoDB.
 * Runs on every tick (not just candle close) for responsive trailing.
 *
 * @returns {boolean} true when SL was moved
 */
function _maybeTrail(trade, ltp, settings) {
  if (!settings.tslEnabled) return false;
  if (trade.action !== 'BUY' && trade.action !== 'SELL') return false;

  const initialSl   = trade.initialSl ?? trade.sl;
  const entry       = _spotEntry(trade);
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
 * Check if the candle-close price breaches SL or target.
 * Called only when a 15m candle closes — wick-only touches never trigger this.
 *
 * @returns {{ closeAt: number, reason: string } | null}
 */
function _checkExit(trade, candleClose) {
  if (trade.action === 'BUY') {
    if (trade.sl     != null && candleClose <= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && candleClose >= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  } else if (trade.action === 'SELL') {
    if (trade.sl     != null && candleClose >= trade.sl)     return { closeAt: trade.sl,     reason: trade.tslActivated ? 'TSL' : 'SL' };
    if (trade.target != null && candleClose <= trade.target) return { closeAt: trade.target, reason: 'TARGET' };
  }
  return null;
}

async function _closeTrade(trade, closeAt, reason) {
  if (_closing.has(trade.id)) return;
  _closing.add(trade.id);

  let exitPrice = closeAt;

  if (trade.derivativeToken) {
    // Fallback chain for derivative trades:
    //   1. Cached tick price  — always the most current option/futures premium
    //   2. Live API fetch     — for options when no tick has arrived yet
    //   3. entryPrice         — absolute last resort (0 PnL); NEVER use closeAt
    //                          (it's a spot level, not the derivative price)
    const cached = _lastDerivativeLtp.get(trade.id);
    if (cached != null) {
      exitPrice = cached;
    } else {
      const hasSymbol = trade.derivativeSymbol && trade.derivativeExchange;
      if (hasSymbol) {
        try {
          const ltpKey     = `${trade.derivativeExchange}:${trade.derivativeSymbol}`;
          const ltpData    = await _kiteService().getLTP([ltpKey]);
          const premiumNow = ltpData[ltpKey]?.last_price;
          if (premiumNow != null) {
            exitPrice = premiumNow;
          } else {
            console.warn(`[TradeWatcher] Derivative LTP null for ${trade.derivativeSymbol}`);
            // For options: spot SL level as exit price gives absurd PnL (e.g. ₹1150 vs ₹50 premium)
            exitPrice = trade.tradingMode === 'options' ? trade.entryPrice : closeAt;
          }
        } catch (err) {
          console.warn(`[TradeWatcher] Derivative LTP fetch failed: ${err.message}`);
          exitPrice = trade.tradingMode === 'options' ? trade.entryPrice : closeAt;
        }
      } else if (trade.tradingMode === 'options') {
        // No symbol at all — cannot use spot closeAt as options exit price
        exitPrice = trade.entryPrice;
      }
      // Futures with no symbol: closeAt ≈ futures price, acceptable fallback
    }
  }

  const closed = store.closePaperTrade(trade.id, exitPrice);
  if (!closed) { _closing.delete(trade.id); return; }

  _lastTickBroadcast.delete(trade.id);
  _lastDerivativeLtp.delete(trade.id);

  broadcast('paper_trade_update', closed);
  broadcast('paper_balance',      store.getPaperBalance());
  db.tradeRepo.closeTrade(closed);

  // Unsubscribe tokens if no longer needed
  try {
    const tokensToCheck = [Number(closed.token)];
    if (closed.derivativeToken) tokensToCheck.push(Number(closed.derivativeToken));

    for (const tk of tokensToCheck) {
      const stillNeeded = store.getPaperTrades().some(
        (t) => (t.status === 'OPEN' || t.status === 'PENDING') &&
               (Number(t.token) === tk || Number(t.derivativeToken) === tk),
      );
      const inWatchlist = store.getWatchlist().some(
        (w) => Number(w.instrumentToken) === tk,
      );
      if (!stillNeeded && !inWatchlist) _ticker().unsubscribe([tk]);
    }
  } catch { /* ticker may not be connected */ }

  const emoji = reason === 'TARGET' ? '🎯' : reason === 'TSL' ? '🔒' : '🛑';
  console.log(
    `[TradeWatcher] ${emoji} ${reason} — ${closed.symbol} ` +
    `[${closed.tfLabel ?? closed.interval ?? '-'}] ${closed.action} ` +
    `entry=₹${closed.entryPrice} exit=₹${exitPrice} pnl=₹${closed.pnl}`,
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

  // ── 15m candle boundary detection ────────────────────────────────────────
  // Returns the close price of the candle that just ended, or null if still
  // within the same 15-minute window.  SL/target checks run ONLY when this
  // is non-null — wick touches within a candle never trigger an exit.
  const candleClosePrice = _trackCandle(numToken, lastPrice);

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

    if (activated.derivativeToken) {
      try { _ticker().subscribe([Number(activated.derivativeToken)]); } catch { /* ticker may not be ready */ }
    }

    broadcast('paper_trade_update', activated);
    broadcast('paper_balance', store.getPaperBalance());
    db.tradeRepo.upsertTrade(activated);

    console.log(
      `[TradeWatcher] ⚡ TRIGGERED — ${activated.symbol} ${activated.action}` +
      ` @ ₹${activated.entryPrice} (trigger ₹${activated.triggerPrice}, ltp ₹${lastPrice})`,
    );
  }

  // Match open trades by underlying token OR derivative token
  const openTrades = store.getPaperTrades().filter(
    (t) =>
      t.status === 'OPEN' &&
      (Number(t.token) === numToken || Number(t.derivativeToken) === numToken) &&
      (t.source === 'auto' || t.source === 'scan'),
  );
  if (openTrades.length === 0) return;

  const settings = store.getAutoTraderSettings();
  const now      = Date.now();

  for (const trade of openTrades) {
    const isDerivativeTick = Number(trade.derivativeToken) === numToken;
    const isUnderlyingTick = Number(trade.token) === numToken;
    const isOptions        = trade.tradingMode === 'options';

    // ── TSL trailing + SL/Target exit ────────────────────────────────────────
    // Options  → spot tick: trade.sl/target are spot levels, spot is monitored
    // Futures  → derivative tick: trade.sl/target are futures-adjusted levels
    //            (spot + basis stored at trade creation), futures price monitored
    // Spot     → underlying tick (no derivativeToken)
    const isMonitorTick =
      (isOptions && isUnderlyingTick) ||
      (!isOptions && trade.derivativeToken && isDerivativeTick) ||
      (!trade.derivativeToken && isUnderlyingTick);

    if (isMonitorTick) {
      _maybeTrail(trade, lastPrice, settings);
    }

    // ── SL / Target exit — fires only on 15m candle CLOSE ────────────────────
    // candleClosePrice is the close of whichever candle this tick belongs to.
    // For futures: futures candle close vs futures-adjusted SL/target ✓
    // For options: spot candle close vs spot SL/target ✓
    if (candleClosePrice != null && isMonitorTick) {
      const exit = _checkExit(trade, candleClosePrice);
      if (exit) {
        _closeTrade(trade, exit.closeAt, exit.reason);
        continue;
      }
    }

    // ── Derivative LTP cache — updated on every derivative tick ─────────────
    // _closeTrade reads this to compute PnL from real option premium,
    // not from the spot SL/target level.
    if (isDerivativeTick && trade.derivativeToken) {
      _lastDerivativeLtp.set(trade.id, lastPrice);
    }

    // ── Live PnL broadcast — throttled to 500 ms per trade ──────────────────
    const shouldBroadcast = trade.derivativeToken ? isDerivativeTick : isUnderlyingTick;
    if (shouldBroadcast) {
      const lastBcast = _lastTickBroadcast.get(trade.id) ?? 0;
      if (now - lastBcast >= 500) {
        _lastTickBroadcast.set(trade.id, now);
        const unrealizedPnl = trade.action === 'BUY'
          ? (lastPrice - trade.entryPrice) * (trade.quantity ?? 1)
          : (trade.entryPrice - lastPrice) * (trade.quantity ?? 1);
        broadcast('paper_trade_tick', {
          id:            trade.id,
          token:         Number(trade.token),
          ltp:           lastPrice,
          unrealizedPnl: +unrealizedPnl.toFixed(2),
        });
      }
    }
  }
}

module.exports = { onTick };
