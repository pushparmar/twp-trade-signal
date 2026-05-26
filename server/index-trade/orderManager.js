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

  // Index options — only BUY side. No selling options (requires margin/lot money).
  // Bullish signal → BUY CE | Bearish signal → BUY PE
  // Skip if the option type doesn't match the signal direction
  if (direction === 'bullish' && inst.optionType !== 'CE') return;
  if (direction === 'bearish' && inst.optionType !== 'PE') return;

  const action = 'BUY'; // always BUY — never sell options
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

    // All index option trades are BUY-only
    const riskPerUnit = Math.abs(trade.entryPrice - trade.initialSl);

    // ── TSL: Trailing Stop Loss ─────────────────────────────────────────
    if (config.tslEnabled && riskPerUnit > 0) {
      const unrealizedR = (ltp - trade.entryPrice) / riskPerUnit;

      // Track peak (highest price reached)
      const currentPeak = trade.peakPrice || trade.entryPrice;
      const newPeak = Math.max(currentPeak, ltp);
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

      // Trail SL upward only (BUY)
      if (trade.tslActivated) {
        const trailedSl = trade.peakPrice - (config.tslDistanceR * riskPerUnit);
        if (trailedSl > trade.sl) {
          tradeStore.updateTrade(trade.id, { sl: Math.round(trailedSl * 100) / 100 });
          trade.sl = Math.round(trailedSl * 100) / 100;
        }
      }
    }

    // ── Check exit conditions (always BUY — options only) ──────────────
    let exitPrice = null;
    let exitReason = null;

    // BUY: exit when price drops to SL or rises to target
    if (ltp <= trade.sl)     { exitPrice = trade.sl;     exitReason = trade.tslActivated ? 'tsl' : 'sl'; }
    if (ltp >= trade.target) { exitPrice = trade.target;  exitReason = 'target'; }

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
      // Broadcast live PnL update (BUY: profit when ltp > entry)
      const lotSize = trade.lotSize || 1;
      const qty = trade.quantity || 1;
      const unrealizedPnl = (ltp - trade.entryPrice) * qty * lotSize;

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
