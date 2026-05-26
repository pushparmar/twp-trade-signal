/**
 * orderManager.js — Index Trade module
 *
 * Manages paper trade lifecycle: entry on signal, per-tick SL/Target/TSL
 * monitoring, and close. Fully independent from main autoTrader.js.
 *
 * Two entry strategies:
 *
 *  1. Pattern-based — signals from scanner (5m/15m/60m, BUY-only on bullish)
 *  2. Low Premium Scalper — any subscribed option whose LTP ≤ lpEntryMax (₹)
 *     is bought immediately; special TSL kicks in when LTP hits lpTslTrigger.
 */

const candleStore    = require('../services/candleStore');
const { broadcast }  = require('../sseHub');
const { isNseOpen }  = require('../utils/marketHours');

const tradeStore     = require('./tradeStore');
const strikeManager  = require('./strikeManager');

// ── Config ──────────────────────────────────────────────────────────────────

const TICK_POLL_MS = 500; // check SL/Target every 500ms

// Only execute pattern orders on these intervals — 1m is too noisy for options
const ORDER_INTERVALS = ['5minute', '15minute', '60minute'];

// ── State ───────────────────────────────────────────────────────────────────

let _tickTimer = null;
// Dedup: one open trade per token — same strike can't be entered again
// from a different timeframe, pattern, or strategy while a trade is open.
const _openKeys = new Set(); // token (Number)

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Use the latest 1-minute candle close as a live price proxy.
 * candleStore currentCandle.close is updated on every tick from kiteTicker.
 */
function _getCurrentPrice(token) {
    const candles = candleStore.getCandlesSync(Number(token), 'minute');
    if (!candles || candles.length === 0) return null;
    return candles[candles.length - 1].close;
}

// ── Signal handler (pattern-based entry) ────────────────────────────────────

/**
 * Called by scanner when a pattern fires on a subscribed option candle.
 * Only places a BUY order — we never sell options (requires margin).
 */
function onSignal(signal) {
    const config = tradeStore.getConfig();
    if (!config.enabled) return;
    if (!isNseOpen()) return;

    const { token, interval, close, sl, target, signal: direction } = signal;
    if (!close || !sl || !target || !token || !direction) return;

    if (!ORDER_INTERVALS.includes(interval)) return;

    // Sanity check — for a BUY: target must be above entry, SL must be below entry.
    // If the pattern returned inverted levels, skip rather than place a bad trade.
    if (target <= close) {
        console.log(`[IdxOrder] ⏭ Skipped ${signal.symbol} — target ${target} ≤ entry ${close} (invalid for BUY)`);
        return;
    }
    if (sl >= close) {
        console.log(`[IdxOrder] ⏭ Skipped ${signal.symbol} — SL ${sl} ≥ entry ${close} (invalid for BUY)`);
        return;
    }

    // No stacking: one open trade per token (across all patterns + timeframes)
    const stackKey = Number(token);
    if (_openKeys.has(stackKey)) return;

    // R:R check
    const riskPerUnit = Math.abs(close - sl);
    if (riskPerUnit < 0.01) return;
    const rrRatio = Math.abs(target - close) / riskPerUnit;
    if (rrRatio < config.minRR) {
        console.log(`[IdxOrder] ⏭ Skipped ${signal.symbol} — R:R ${rrRatio.toFixed(2)} < min ${config.minRR}`);
        return;
    }

    const inst = strikeManager.getInstrumentByToken(token);
    if (!inst) return;

    // Index options — only BUY when the OPTION'S OWN price chart is bullish.
    //
    // Patterns run on the option token's candles, not the underlying index.
    // CE price goes up when underlying goes up → bullish signal on CE → BUY CE ✅
    // PE price goes up when underlying goes down → bullish signal on PE → BUY PE ✅
    //
    // A bearish signal on an option means that option's price is expected to fall
    // → skip (we only buy options, never sell).
    if (direction !== 'bullish') return;

    const lotSize  = inst.lotSize || 1;
    const quantity = config.lotQuantity || 1;

    const trade = tradeStore.addTrade({
        source:          'index-trade',
        strategyType:    'pattern',
        index:           inst.index,
        symbol:          inst.tradingsymbol,
        token:           Number(token),
        optionType:      inst.optionType,
        strike:          inst.strike,
        exchange:        inst.exchange,
        action:          'BUY', // always BUY — never sell options
        quantity,
        lotSize,
        entryPrice:      close,
        sl,
        initialSl:       sl,
        target,
        interval,
        tfLabel:         signal.tfLabel,
        patternId:       signal.patternId,
        patternLabel:    signal.patternLabel,
        signalDirection: direction,
        score:           signal.score,
        rrRatio:         Math.round(rrRatio * 100) / 100,
    });

    _openKeys.add(stackKey);

    console.log(
        `[IdxOrder] 📋 BUY ${inst.tradingsymbol} @${close} ` +
        `SL=${sl} T=${target} R:R=${rrRatio.toFixed(2)} ` +
        `[${signal.patternId} ${signal.tfLabel}]`,
    );

    broadcast('idx_trade', trade);
}

// ── Low Premium Scalper entry ────────────────────────────────────────────────

/**
 * Scans ALL subscribed option tokens every tick. If any option's LTP is ≤
 * lpEntryMax and no trade is open for that token, buy it immediately.
 *
 * This is a premium-expansion scalp — we accept near-total premium loss
 * (initial SL ≈ ₹0.5) hoping for a large expansion move.
 */
function _checkLowPremiumEntry() {
    if (!isNseOpen()) return;

    const config = tradeStore.getConfig();
    if (!config.enabled || !config.lowPremiumEnabled) return;

    const allTokens = strikeManager.getAllTokens();

    for (const token of allTokens) {
        const numToken = Number(token);

        // Skip if there is already an open trade on this strike
        if (_openKeys.has(numToken)) continue;

        const ltp = _getCurrentPrice(numToken);

        // Must have a live price and be at or below the entry threshold
        if (!ltp || ltp <= 0 || ltp > config.lpEntryMax) continue;

        const inst = strikeManager.getInstrumentByToken(numToken);
        if (!inst) continue;

        // R:R at entry: reward = (lpTarget - ltp), risk = (ltp - 0.5)
        const riskAtEntry   = Math.max(ltp - 0.5, 0.1);
        const rewardAtEntry = config.lpTarget - ltp;
        const rrRatio       = +(rewardAtEntry / riskAtEntry).toFixed(2);

        const trade = tradeStore.addTrade({
            source:          'index-trade',
            strategyType:    'low-premium',
            index:           inst.index,
            symbol:          inst.tradingsymbol,
            token:           numToken,
            optionType:      inst.optionType,
            strike:          inst.strike,
            exchange:        inst.exchange,
            action:          'BUY',
            quantity:        config.lotQuantity || 1,
            lotSize:         inst.lotSize || 1,
            entryPrice:      ltp,
            // Initial SL near zero — accept full premium loss until TSL activates
            sl:              0.5,
            initialSl:       0.5,
            target:          config.lpTarget,
            interval:        'tick',
            tfLabel:         'LP',
            patternId:       'low-premium',
            patternLabel:    'Low Premium Scalper',
            signalDirection: 'bullish',
            score:           0,
            rrRatio,
        });

        _openKeys.add(numToken);

        console.log(
            `[IdxOrder] 💰 LP BUY ${inst.tradingsymbol} @₹${ltp} ` +
            `SL=₹0.5 T=₹${config.lpTarget} R:R=${rrRatio} [low-premium scalper]`,
        );

        broadcast('idx_trade', trade);
    }
}

// ── Per-tick SL / Target / TSL monitoring ────────────────────────────────────

/**
 * Handles TSL trailing for Low Premium Scalper trades.
 *
 * TSL logic:
 *   Phase 1 (before trigger): SL stays at ₹0.5 until LTP hits lpTslTrigger (e.g., ₹10)
 *   Phase 2 (after trigger):  SL = lpTslTrailPct × peakPrice (e.g., 70% of peak)
 *     → any new peak immediately tightens SL
 *     → SL moves up-only, never down
 *
 * Example with defaults (trigger=10, trail=70%):
 *   LTP 10 → TSL activates → SL = ₹7
 *   LTP 11 → peak=11 → SL = ₹7.70
 *   LTP 13 → peak=13 → SL = ₹9.10
 *   LTP 12 (pullback) → peak still 13 → SL stays ₹9.10
 *   LTP 9.10 → TSL hit → close @₹9.10
 */
function _handleLowPremiumTSL(trade, ltp) {
    const config    = tradeStore.getConfig();
    const numToken  = Number(trade.token);

    // ── Track peak ─────────────────────────────────────────────────────────
    const currentPeak = trade.peakPrice || trade.entryPrice;
    const newPeak     = Math.max(currentPeak, ltp);
    if (newPeak !== currentPeak) {
        tradeStore.updateTrade(trade.id, { peakPrice: newPeak });
        trade.peakPrice = newPeak;
    }

    // ── Phase 1 → 2: activate TSL when LTP hits the trigger price ──────────
    if (!trade.tslActivated && ltp >= config.lpTslTrigger) {
        const initialSl = config.lpTslInitialSl;
        tradeStore.updateTrade(trade.id, { tslActivated: true, sl: initialSl });
        trade.tslActivated = true;
        trade.sl           = initialSl;
        console.log(
            `[IdxOrder] 🔒 LP TSL activated: ${trade.symbol} @₹${ltp} — SL set to ₹${initialSl}`,
        );
    }

    // ── Phase 2: trail SL upward as peak rises ─────────────────────────────
    if (trade.tslActivated) {
        // SL = trailing % of the highest price seen since entry
        const trailedSl = Math.round(trade.peakPrice * config.lpTslTrailPct * 100) / 100;
        if (trailedSl > trade.sl) {
            tradeStore.updateTrade(trade.id, { sl: trailedSl });
            trade.sl = trailedSl;
        }
    }

    // ── Check exit conditions ───────────────────────────────────────────────
    let exitPrice  = null;
    let exitReason = null;

    if (ltp <= trade.sl) {
        exitPrice  = trade.sl;
        exitReason = trade.tslActivated ? 'tsl' : 'sl';
    }
    if (ltp >= trade.target) {
        exitPrice  = trade.target;
        exitReason = 'target';
    }

    if (exitPrice && exitReason) {
        const closedTrade = tradeStore.closeTrade(trade.id, exitPrice, exitReason);
        if (closedTrade) {
            _openKeys.delete(numToken);
            console.log(
                `[IdxOrder] ${exitReason === 'target' ? '🎯' : '🛑'} ` +
                `LP ${trade.symbol} closed @₹${exitPrice} (${exitReason}) ` +
                `PnL=₹${closedTrade.pnl}`,
            );
            broadcast('idx_trade_update', closedTrade);
        }
        return; // trade closed — no tick broadcast
    }

    // Live PnL tick
    const lotSize        = trade.lotSize || 1;
    const qty            = trade.quantity || 1;
    const unrealizedPnl  = (ltp - trade.entryPrice) * qty * lotSize;

    broadcast('idx_trade_tick', {
        id:             trade.id,
        token:          trade.token,
        ltp,
        sl:             trade.sl,
        tslActivated:   trade.tslActivated,
        unrealizedPnl:  Math.round(unrealizedPnl * 100) / 100,
    });
}

/**
 * Handles TSL trailing for standard pattern-based BUY trades.
 *
 * TSL logic (R-multiple based):
 *   Activates when unrealizedR >= tslTriggerR.
 *   Trails at: SL = peak - tslDistanceR × initialRisk
 */
function _handlePatternTSL(trade, ltp) {
    const config      = tradeStore.getConfig();
    const numToken    = Number(trade.token);
    const riskPerUnit = Math.abs(trade.entryPrice - trade.initialSl);

    // ── TSL: Trailing Stop Loss ─────────────────────────────────────────────
    if (config.tslEnabled && riskPerUnit > 0) {
        const unrealizedR = (ltp - trade.entryPrice) / riskPerUnit;

        // Track peak (highest price reached since entry)
        const currentPeak = trade.peakPrice || trade.entryPrice;
        const newPeak     = Math.max(currentPeak, ltp);
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
            const trailedSl = trade.peakPrice - config.tslDistanceR * riskPerUnit;
            if (trailedSl > trade.sl) {
                tradeStore.updateTrade(trade.id, { sl: Math.round(trailedSl * 100) / 100 });
                trade.sl = Math.round(trailedSl * 100) / 100;
            }
        }
    }

    // ── Check exit conditions (always BUY — options only) ──────────────────
    let exitPrice  = null;
    let exitReason = null;

    if (ltp <= trade.sl) {
        exitPrice  = trade.sl;
        exitReason = trade.tslActivated ? 'tsl' : 'sl';
    }
    if (ltp >= trade.target) {
        exitPrice  = trade.target;
        exitReason = 'target';
    }

    if (exitPrice && exitReason) {
        const closedTrade = tradeStore.closeTrade(trade.id, exitPrice, exitReason);
        if (closedTrade) {
            _openKeys.delete(numToken);
            console.log(
                `[IdxOrder] ${exitReason === 'target' ? '🎯' : '🛑'} ` +
                `${trade.symbol} closed @${exitPrice} (${exitReason}) ` +
                `PnL=₹${closedTrade.pnl}`,
            );
            broadcast('idx_trade_update', closedTrade);
        }
        return;
    }

    // Broadcast live PnL update (BUY: profit when ltp > entry)
    const lotSize       = trade.lotSize || 1;
    const qty           = trade.quantity || 1;
    const unrealizedPnl = (ltp - trade.entryPrice) * qty * lotSize;

    broadcast('idx_trade_tick', {
        id:            trade.id,
        token:         trade.token,
        ltp,
        sl:            trade.sl,
        tslActivated:  trade.tslActivated,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    });
}

function _checkTrades() {
    if (!isNseOpen()) return;

    const openTrades = tradeStore.getOpenTrades();
    if (openTrades.length === 0) {
        // Still check for new low-premium entries even when no trades are open
        _checkLowPremiumEntry();
        return;
    }

    // Monitor all open trades
    for (const trade of openTrades) {
        const ltp = _getCurrentPrice(trade.token);
        if (!ltp) continue;

        if (trade.strategyType === 'low-premium') {
            _handleLowPremiumTSL(trade, ltp);
        } else {
            _handlePatternTSL(trade, ltp);
        }
    }

    // Check for new low-premium entries after monitoring existing trades
    _checkLowPremiumEntry();
}

// ── Public API ──────────────────────────────────────────────────────────────

function start() {
    // Rebuild _openKeys from existing open trades (survives server restart)
    const openTrades = tradeStore.getOpenTrades();
    for (const t of openTrades) {
        _openKeys.add(Number(t.token));
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
