/**
 * orderManager.js — Index Trade module
 *
 * Manages paper trade lifecycle: entry on signal, per-tick SL/Target/TSL
 * monitoring, and close. Fully independent from main autoTrader.js.
 */

const candleStore   = require('../services/candleStore');
const { broadcast } = require('../sseHub');
const { isNseOpen } = require('../utils/marketHours');

const tradeStore    = require('./tradeStore');
const strikeManager = require('./strikeManager');

// ── Config ──────────────────────────────────────────────────────────────────

const TICK_POLL_MS = 500; // check SL/Target every 500ms

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────────

let _tickTimer = null;
// Dedup: prevent stacking — one open trade per (token, interval)
const _openKeys = new Set(); // "token:interval"

// ── Signal handler (called by scanner) ──────────────────────────────────────

function onSignal(signal) {
  const config = tradeStore.getConfig();
  if (!config.enabled) return;
  if (!isNseOpen()) return;

  const { token, interval, close, sl, target, signal: direction } = signal;
  if (!close || !sl || !target || !token || !direction) return;

  // No stacking: one open trade per token:interval
  const stackKey = `${token}:${interval}`;
  if (_openKeys.has(stackKey)) return;

  // R:R check
  const riskPerUnit = Math.abs(close - sl);
  if (riskPerUnit < 0.01) return;
  const rrRatio = Math.abs(target - close) / riskPerUnit;
  if (rrRatio < config.minRR) {
    console.log(
      `[IdxOrder] ⏭ Skipped ${signal.symbol} — R:R ${rrRatio.toFixed(2)} < min ${config.minRR}`,
    );
    return;
  }

  const inst = strikeManager.getInstrumentByToken(token);
  if (!inst) return;

  const action = direction === 'bullish' ? 'BUY' : 'SELL';
  const lotSize = inst.lotSize || 1;
  const quantity = config.lotQuantity || 1;

  const trade = tradeStore.addTrade({
    source: 'index-trade',
    index: inst.index,
    symbol: inst.tradingsymbol,
    token: Number(token),
    optionType: inst.optionType,
    strike: inst.strike,
    exchange: inst.exchange,
    action,
    quantity,
    lotSize,
    entryPrice: close,
    sl,
    initialSl: sl,
    target,
    interval,
    tfLabel: signal.tfLabel,
    patternId: signal.patternId,
    patternLabel: signal.patternLabel,
    signalDirection: direction,
    score: signal.score,
    rrRatio: Math.round(rrRatio * 100) / 100,
  });

  _openKeys.add(stackKey);

  console.log(
    `[IdxOrder] 📋 ${action} ${inst.tradingsymbol} @${close} ` +
    `SL=${sl} T=${target} R:R=${rrRatio.toFixed(2)} ` +
    `[${signal.patternId} ${signal.tfLabel}]`,
  );

  broadcast('idx_trade', trade);
}

// ── Per-tick SL / Target / TSL monitoring ────────────────────────────────────

function _getCurrentPrice(token) {
  // Use the latest candle close from the 1-minute buffer as LTP proxy.
  // candleStore's currentCandle.close is updated on every tick from kiteTicker.
  const candles = candleStore.getCandlesSync(Number(token), 'minute');
  if (!candles || candles.length === 0) return null;
  return candles[candles.length - 1].close;
}

function _checkTrades() {
  if (!isNseOpen()) return;

  const openTrades = tradeStore.getOpenTrades();
  if (openTrades.length === 0) return;

  const config = tradeStore.getConfig();

  for (const trade of openTrades) {
    const ltp = _getCurrentPrice(trade.token);
    if (!ltp) continue;

    const isBuy = trade.action === 'BUY';

    // ── TSL: Trailing Stop Loss ─────────────────────────────────────────
    if (config.tslEnabled) {
      const riskPerUnit = Math.abs(trade.entryPrice - trade.initialSl);
      if (riskPerUnit > 0) {
        const unrealizedR = isBuy
          ? (ltp - trade.entryPrice) / riskPerUnit
          : (trade.entryPrice - ltp) / riskPerUnit;

        // Update peak
        const currentPeak = trade.peakPrice || trade.entryPrice;
        const newPeak = isBuy ? Math.max(currentPeak, ltp) : Math.min(currentPeak, ltp);
        if (newPeak !== currentPeak) {
          tradeStore.updateTrade(trade.id, { peakPrice: newPeak });
          trade.peakPrice = newPeak;
        }

        // Activate TSL when profit >= triggerR × risk
        if (!trade.tslActivated && unrealizedR >= config.tslTriggerR) {
          tradeStore.updateTrade(trade.id, { tslActivated: true });
          trade.tslActivated = true;
          console.log(`[IdxOrder] 🔒 TSL activated: ${trade.symbol} @${ltp} (${unrealizedR.toFixed(2)}R)`);
        }

        // Trail SL
        if (trade.tslActivated) {
          const trailDistance = config.tslDistanceR * riskPerUnit;
          const trailedSl = isBuy
            ? trade.peakPrice - trailDistance
            : trade.peakPrice + trailDistance;
          const currentSl = trade.sl;
          const shouldUpdate = isBuy ? trailedSl > currentSl : trailedSl < currentSl;
          if (shouldUpdate) {
            tradeStore.updateTrade(trade.id, { sl: Math.round(trailedSl * 100) / 100 });
            trade.sl = Math.round(trailedSl * 100) / 100;
          }
        }
      }
    }

    // ── Check exit conditions ───────────────────────────────────────────
    let exitPrice = null;
    let exitReason = null;

    if (isBuy) {
      if (ltp <= trade.sl)     { exitPrice = trade.sl;     exitReason = trade.tslActivated ? 'tsl' : 'sl'; }
      if (ltp >= trade.target) { exitPrice = trade.target;  exitReason = 'target'; }
    } else {
      if (ltp >= trade.sl)     { exitPrice = trade.sl;     exitReason = trade.tslActivated ? 'tsl' : 'sl'; }
      if (ltp <= trade.target) { exitPrice = trade.target;  exitReason = 'target'; }
    }

    if (exitPrice && exitReason) {
      const closedTrade = tradeStore.closeTrade(trade.id, exitPrice, exitReason);
      if (closedTrade) {
        const stackKey = `${trade.token}:${trade.interval}`;
        _openKeys.delete(stackKey);

        console.log(
          `[IdxOrder] ${exitReason === 'target' ? '🎯' : '🛑'} ` +
          `${trade.symbol} closed @${exitPrice} (${exitReason}) ` +
          `PnL=₹${closedTrade.pnl}`,
        );
        broadcast('idx_trade_update', closedTrade);
      }
    } else {
      // Broadcast live PnL update
      const lotSize = trade.lotSize || 1;
      const qty = trade.quantity || 1;
      const unrealizedPnl = isBuy
        ? (ltp - trade.entryPrice) * qty * lotSize
        : (trade.entryPrice - ltp) * qty * lotSize;

      broadcast('idx_trade_tick', {
        id: trade.id,
        token: trade.token,
        ltp,
        sl: trade.sl,
        tslActivated: trade.tslActivated,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      });
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function start() {
  // Rebuild _openKeys from existing open trades
  const openTrades = tradeStore.getOpenTrades();
  for (const t of openTrades) {
    _openKeys.add(`${t.token}:${t.interval}`);
  }

  _tickTimer = setInterval(_checkTrades, TICK_POLL_MS);
  console.log(`[IdxOrder] Order manager started — poll=${TICK_POLL_MS}ms`);
}

function stop() {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

module.exports = { start, stop, onSignal };
