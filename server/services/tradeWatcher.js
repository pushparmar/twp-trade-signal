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

function _ticker() {
  return require('./kiteTicker');
}

function _kiteService() {
  return require('./kiteService');
}

const _closing = new Set();
const _lastTickBroadcast = new Map();

function _spotEntry(trade) {
  return trade.spotEntry ?? trade.entryPrice;
}

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

async function _closeTrade(trade, closeAt, reason) {
  if (_closing.has(trade.id)) return;
  _closing.add(trade.id);

  let exitPrice = closeAt;

  // For options trades, fetch current option premium for accurate PnL
  if (trade.tradingMode === 'options' && trade.derivativeSymbol) {
    try {
      const ltpKey = `${trade.derivativeExchange}:${trade.derivativeSymbol}`;
      const ltpData = await _kiteService().getLTP([ltpKey]);
      const premiumNow = ltpData[ltpKey]?.last_price;
      if (premiumNow != null) {
        exitPrice = premiumNow;
      } else {
        exitPrice = trade.entryPrice;
      }
    } catch (err) {
      console.warn(`[TradeWatcher] Option LTP fetch failed for ${trade.derivativeSymbol}:`, err.message);
      exitPrice = trade.entryPrice;
    }
  }

  const closed = store.closePaperTrade(trade.id, exitPrice);
  if (!closed) { _closing.delete(trade.id); return; }

  _lastTickBroadcast.delete(trade.id);

  broadcast('paper_trade_update', closed);
  broadcast('paper_balance',      store.getPaperBalance());
  db.tradeRepo.closeTrade(closed);

  // Unsubscribe tokens if no longer needed
  try {
    const tokensToCheck = [Number(closed.token)];
    if (closed.derivativeToken) tokensToCheck.push(Number(closed.derivativeToken));

    for (const tk of tokensToCheck) {
      const stillNeeded = store.getPaperTrades().some(
        (t) => t.status === 'OPEN' && (Number(t.token) === tk || Number(t.derivativeToken) === tk),
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

  // Match trades by underlying token OR derivative (futures) token
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
    const isOptions = trade.tradingMode === 'options';

    // SL/target/TSL monitoring — price series must match what trade.sl/target represent:
    //   Options : trade.sl/target are SPOT levels → check against spot (underlying) tick
    //   Futures : trade.sl/target are SPOT levels → check against futures tick (≈ spot)
    //   Legacy  : no derivative → check against underlying tick
    if (isOptions && isUnderlyingTick) {
      // Options: monitor via spot price so ₹30 premium is never compared to ₹1,180 SL
      _maybeTrail(trade, lastPrice, settings);
      const exit = _checkExit(trade, lastPrice);
      if (exit) {
        _closeTrade(trade, exit.closeAt, exit.reason);
        continue;
      }
    } else if (!isOptions && trade.derivativeToken && isDerivativeTick) {
      // Futures: futures price tracks spot closely — use it directly
      _maybeTrail(trade, lastPrice, settings);
      const exit = _checkExit(trade, lastPrice);
      if (exit) {
        _closeTrade(trade, exit.closeAt, exit.reason);
        continue;
      }
    } else if (!trade.derivativeToken && isUnderlyingTick) {
      // Legacy spot trade
      _maybeTrail(trade, lastPrice, settings);
      const exit = _checkExit(trade, lastPrice);
      if (exit) {
        _closeTrade(trade, exit.closeAt, exit.reason);
        continue;
      }
    }

    // Broadcast PnL — always use derivative tick (premium for options, futures price for futures)
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
