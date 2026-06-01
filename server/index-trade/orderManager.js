/**
 * orderManager.js — Index Trade module
 *
 * Manages paper trade lifecycle: entry on signal, per-tick SL/Target/TSL
 * monitoring, and close. Fully independent from main autoTrader.js.
 *
 * Two entry strategies:
 *
 *  1. Pattern-based — signals from scanner (5m/15m/60m, BUY-only on bullish)
 *
 *  2. Low Premium Scalper (LP) — buys any subscribed option whose LTP is in
 *     the [lpEntryMin, lpEntryMax] range (e.g. ₹5–₹10). No pattern needed.
 *     • Averages down ONCE when price drops lpAvgDownPct (60%) from entry.
 *       Example: enter ₹10 → avg trigger = ₹10 × 0.40 = ₹4 → avg-down buy.
 *       After avg-down: lotCount=2, avgPrice=(10+4)/2=₹7, SL updated.
 *     • Max lpMaxPositions (4) concurrent LP trades at any time.
 *     • TSL activates when LTP ≥ lpTslTrigger; trails at lpTslTrailPct × peak.
 */

const candleStore    = require('../services/candleStore');
const { broadcast }  = require('../sseHub');
const { isNseOpen }  = require('../utils/marketHours');
const { getRSI }     = require('../services/ichimoku');

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

// IST date string of the last day EOD close was executed.
// Guards against firing the EOD sweep more than once per session.
let _eodClosedDate = null;

// IST date string of the last morning purge — resets in-memory closed trades.
let _morningPurgeDate = null;

// ── IST time window helper ──────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns true when the current IST time is within the configured trading window.
 * Reads tradeStartHHMM / tradeEndHHMM from config (format 'HH:MM').
 * Defaults to '09:20'–'15:15' so both pattern and LP entries respect the gate.
 */
function _isWithinTradingWindow() {
    const config = tradeStore.getConfig();
    const start  = config.tradeStartHHMM ?? '09:20';
    const end    = config.tradeEndHHMM   ?? '15:15';

    const nowIST  = new Date(Date.now() + IST_OFFSET_MS);
    const nowMins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();

    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;

    return nowMins >= startMins && nowMins <= endMins;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Use the latest 1-minute candle close as a live price proxy.
 * candleStore currentCandle.close is updated on every tick from kiteTicker.
 *
 * Falls back to 5-minute candles if 1-minute candles are not yet available
 * (e.g. during async seeding on startup). Without this fallback, _handlePatternTSL
 * returns early and broadcasts no idx_trade_tick → UI shows frozen PnL.
 */
function _getCurrentPrice(token) {
    const numToken = Number(token);
    const minuteCandles = candleStore.getCandlesSync(numToken, 'minute');
    if (minuteCandles && minuteCandles.length > 0) {
        return minuteCandles[minuteCandles.length - 1].close;
    }
    // Fallback: use 5-minute candles while 1m candles are still seeding
    const fiveMinCandles = candleStore.getCandlesSync(numToken, '5minute');
    if (fiveMinCandles && fiveMinCandles.length > 0) {
        return fiveMinCandles[fiveMinCandles.length - 1].close;
    }
    return null;
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

    // ── Time window gate ──────────────────────────────────────────────────────
    if (!_isWithinTradingWindow()) {
        const cfg = tradeStore.getConfig();
        console.log(
            `[IdxOrder] ⏰ Time filter: outside trading window ` +
            `(${cfg.tradeStartHHMM}–${cfg.tradeEndHHMM} IST) — ${signal.symbol} skipped`,
        );
        return;
    }

    const { token, interval, close, sl, target, signal: direction } = signal;
    if (!close || !sl || !target || !token || !direction) return;

    if (!ORDER_INTERVALS.includes(interval)) return;

    // ── RSI order gate ────────────────────────────────────────────────────────
    // signal.rsi14 is pre-computed by scanner.js — no candle re-read needed.
    // Only blocks execution; the signal is already in the feed at this point.
    if (config.rsiFilterEnabled && config.rsiFilterOrder) {
      const rsiVal = signal.rsi14;
      if (rsiVal != null) {
        // We only place BUY orders — always check bullish RSI window
        const rsiMin = config.rsiBullishMin;
        const rsiMax = config.rsiBullishMax;
        if (rsiVal < rsiMin || rsiVal > rsiMax) {
          console.log(
            `[IdxOrder] ⏭ RSI filter (order): ${signal.symbol} ${signal.tfLabel} ` +
            `RSI=${rsiVal} outside [${rsiMin}–${rsiMax}] — order skipped`,
          );
          return;
        }
      }
    }

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
 * Scans ALL subscribed option tokens every tick. If any option's LTP is in
 * the [lpEntryMin, lpEntryMax] range and no trade is open for that token,
 * buy it immediately.
 *
 * Max lpMaxPositions concurrent LP trades enforced here.
 * Each new trade records an avgDownAt price so the monitor knows when to average.
 */
function _checkLowPremiumEntry() {
    if (!isNseOpen()) return;
    if (!_isWithinTradingWindow()) return; // respect trading time window

    const config = tradeStore.getConfig();
    if (!config.enabled || !config.lowPremiumEnabled) return;

    // Sanity check: target must be strictly above the entry range.
    // If an old/corrupt MongoDB config has lpTarget ≤ lpEntryMax, every "target"
    // exit would produce a negative PnL — block all entries until the user fixes it.
    if (config.lpTarget <= config.lpEntryMax) {
        console.warn(
            `[IdxOrder] ⚠ LP config invalid: lpTarget (${config.lpTarget}) ≤ lpEntryMax (${config.lpEntryMax})` +
            ` — LP entries blocked until config is corrected`,
        );
        return;
    }

    // Count currently open LP positions — cap at lpMaxPositions
    const openLpCount = tradeStore.getOpenTrades()
        .filter(t => t.strategyType === 'low-premium').length;
    if (openLpCount >= config.lpMaxPositions) return;

    const allTokens = strikeManager.getAllTokens();

    for (const token of allTokens) {
        // Re-check limit inside loop (a previous iteration may have filled it)
        const currentLpCount = tradeStore.getOpenTrades()
            .filter(t => t.strategyType === 'low-premium').length;
        if (currentLpCount >= config.lpMaxPositions) break;

        const numToken = Number(token);

        // Skip if there is already an open trade on this strike
        if (_openKeys.has(numToken)) continue;

        const ltp = _getCurrentPrice(numToken);

        // Must be in the [lpEntryMin, lpEntryMax] window
        if (!ltp || ltp < config.lpEntryMin || ltp > config.lpEntryMax) continue;

        // ── RSI order gate for LP entries ─────────────────────────────────────
        // Uses 5-minute candles — a reasonable resolution for momentum context.
        // If candles aren't available yet (< 15 bars), the gate is skipped.
        if (config.rsiFilterEnabled && config.rsiFilterOrder) {
          const lpCandles = candleStore.getCandlesSync(numToken, '5minute');
          if (lpCandles && lpCandles.length >= 15) {
            const lpRsi = getRSI(lpCandles, 14);
            if (lpRsi != null) {
              const rsiMin = config.rsiBullishMin;
              const rsiMax = config.rsiBullishMax;
              if (lpRsi < rsiMin || lpRsi > rsiMax) {
                // No console log here — this runs every tick per token; would flood logs
                continue;
              }
            }
          }
        }

        const inst = strikeManager.getInstrumentByToken(numToken);
        if (!inst) continue;

        // Avg-down trigger: price at which we will buy the 2nd lot
        // (lpAvgDownPct below entry, e.g. 60% drop → ltp × 0.40)
        const avgDownAt = Math.round(ltp * (1 - config.lpAvgDownPct) * 100) / 100;

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
            avgPrice:        ltp,   // weighted avg entry — updated on avg-down
            lotCount:        1,     // total lots held — incremented on avg-down
            avgDownCount:    0,     // how many times we've averaged (max 1)
            avgDownAt,              // price at which to trigger the avg-down buy
            // Initial SL near zero — accept full premium loss until TSL or avg-down
            sl:              0.5,
            initialSl:       0.5,
            target:          config.lpTarget,
            interval:        'tick',
            tfLabel:         'LP',
            patternId:       'low-premium',
            patternLabel:    'Low Premium Scalper',
            signalDirection: 'bullish',
            score:           0,
            rrRatio:         +((config.lpTarget - ltp) / Math.max(ltp - 0.5, 0.1)).toFixed(2),
        });

        _openKeys.add(numToken);

        console.log(
            `[IdxOrder] 💰 LP BUY ${inst.tradingsymbol} @₹${ltp} ` +
            `SL=₹0.5 T=₹${config.lpTarget} avgDownAt=₹${avgDownAt} ` +
            `[${openLpCount + 1}/${config.lpMaxPositions} LP positions]`,
        );

        broadcast('idx_trade', trade);
    }
}

// ── Low Premium Scalper TSL / avg-down monitoring ───────────────────────────

/**
 * Handles the full LP trade lifecycle on every tick:
 *
 *  Phase 0 — No TSL yet, avg-down armed:
 *    • SL = ₹0.5 (accept full loss)
 *    • If LTP ≤ avgDownAt AND avgDownCount = 0 → execute avg-down:
 *        lotCount +=1, recalculate avgPrice, SL = avgDownPrice × lpAvgDownSlPct
 *
 *  Phase 1 → 2 — TSL activation:
 *    • When LTP ≥ lpTslTrigger → activate TSL, SL = lpTslInitialSl
 *
 *  Phase 2 — TSL trailing:
 *    • On every new peak: SL = peakPrice × lpTslTrailPct (70% of peak)
 *
 *  Exit: SL hit OR hard target hit
 *
 * Avg-down example (entry ₹10, lpAvgDownPct=60%, lpAvgDownSlPct=50%):
 *   avgDownAt = 10 × 0.40 = ₹4
 *   Price drops to ₹4 → buy 2nd lot @₹4
 *   avgPrice  = (10 + 4) / 2 = ₹7
 *   lotCount  = 2
 *   SL        = 4 × 0.50 = ₹2   (gives room below avg-down price)
 */
function _handleLowPremiumTSL(trade, ltp) {
    const config   = tradeStore.getConfig();
    const numToken = Number(trade.token);

    // ── Track peak (used for TSL trailing) ────────────────────────────────
    const currentPeak = trade.peakPrice || trade.entryPrice;
    const newPeak     = Math.max(currentPeak, ltp);
    if (newPeak !== currentPeak) {
        tradeStore.updateTrade(trade.id, { peakPrice: newPeak });
        trade.peakPrice = newPeak;
    }

    // ── Avg-down: execute once when price drops lpAvgDownPct from entry ───
    // Only if TSL hasn't activated yet (once TSL is on, we're in recovery mode)
    if (!trade.tslActivated && (trade.avgDownCount ?? 0) === 0 && ltp <= (trade.avgDownAt ?? 0)) {
        const prevLots    = trade.lotCount || 1;
        const prevAvg     = trade.avgPrice ?? trade.entryPrice;
        const newLots     = prevLots + 1;
        // Weighted average: (prevAvg × prevLots + ltp × 1) / newLots
        const newAvgPrice = Math.round(((prevAvg * prevLots + ltp) / newLots) * 100) / 100;
        // SL = lpAvgDownSlPct fraction of the price we just averaged at
        // Always below ltp so it doesn't trigger immediately
        const newSl       = Math.round(ltp * config.lpAvgDownSlPct * 100) / 100;

        tradeStore.updateTrade(trade.id, {
            lotCount:     newLots,
            avgPrice:     newAvgPrice,
            avgDownCount: 1,
            avgDownAt:    null, // disarm — no more avg-downs
            sl:           newSl,
        });

        // Update local reference so exit check below uses new values
        trade.lotCount     = newLots;
        trade.avgPrice     = newAvgPrice;
        trade.avgDownCount = 1;
        trade.avgDownAt    = null;
        trade.sl           = newSl;

        console.log(
            `[IdxOrder] ➕ LP Avg-Down ${trade.symbol} @₹${ltp} ` +
            `lots=${newLots} avgPrice=₹${newAvgPrice} SL=₹${newSl}`,
        );

        // Broadcast updated trade so UI reflects new lotCount / avgPrice
        broadcast('idx_trade_update', { ...trade, status: 'OPEN' });
    }

    // ── TSL Phase 1 → 2: activate when LTP hits trigger price ─────────────
    if (!trade.tslActivated && ltp >= config.lpTslTrigger) {
        const initialSl = config.lpTslInitialSl;
        tradeStore.updateTrade(trade.id, { tslActivated: true, sl: initialSl });
        trade.tslActivated = true;
        trade.sl           = initialSl;
        console.log(
            `[IdxOrder] 🔒 LP TSL activated: ${trade.symbol} @₹${ltp} — SL set to ₹${initialSl}`,
        );
    }

    // ── TSL Phase 2: trail SL upward as peak rises ─────────────────────────
    if (trade.tslActivated) {
        // Cap at (target - 0.01) so that a high trail% can never push SL above
        // target — which would cause a TSL exit at a price below entry (negative PnL).
        const trailedSl = Math.min(
            Math.round(trade.peakPrice * config.lpTslTrailPct * 100) / 100,
            trade.target - 0.01,
        );
        if (trailedSl > trade.sl) {
            tradeStore.updateTrade(trade.id, { sl: trailedSl });
            trade.sl = trailedSl;
        }
    }

    // ── Check exit conditions ──────────────────────────────────────────────
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
                `lots=${trade.lotCount ?? 1} PnL=₹${closedTrade.pnl}`,
            );
            broadcast('idx_trade_update', closedTrade);
        }
        return;
    }

    // ── Live PnL tick (uses avgPrice + lotCount for accuracy) ─────────────
    const lotSize       = trade.lotSize || 1;
    const totalLots     = trade.lotCount || (trade.quantity || 1);
    const effectiveEntry = trade.avgPrice ?? trade.entryPrice;
    const unrealizedPnl = (ltp - effectiveEntry) * totalLots * lotSize;

    broadcast('idx_trade_tick', {
        id:             trade.id,
        token:          trade.token,
        ltp,
        sl:             trade.sl,
        tslActivated:   trade.tslActivated,
        avgPrice:       trade.avgPrice ?? null,
        lotCount:       trade.lotCount ?? 1,
        unrealizedPnl:  Math.round(unrealizedPnl * 100) / 100,
    });
}

// ── Pattern trade TSL monitoring ─────────────────────────────────────────────

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

        // Pattern-specific TSL trigger:
        // tk-reversion targets are close (Kijun / cloud edge ~1-1.5R away), so we
        // arm the TSL early at 0.5R. All other patterns use the global tslTriggerR.
        const triggerR = trade.patternId === 'tk-reversion'
            ? Math.min(0.5, config.tslTriggerR)
            : config.tslTriggerR;

        // Activate TSL when profit >= triggerR × risk
        if (!trade.tslActivated && unrealizedR >= triggerR) {
            tradeStore.updateTrade(trade.id, { tslActivated: true });
            trade.tslActivated = true;
            console.log(`[IdxOrder] 🔒 TSL activated: ${trade.symbol} @${ltp} (${unrealizedR.toFixed(2)}R, trigger=${triggerR}R)`);
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

// ── Morning reset — purge previous day's closed trades ───────────────────────

/**
 * Fires once per day at tradeStartHHMM (09:20 by default).
 * Drops previous-day closed trades from the in-memory _trades array so
 * getPnlSummary() and the trade list start fresh each morning.
 * Historical data is preserved in MongoDB.
 */
function _checkMorningPurge() {
    const config    = tradeStore.getConfig();
    const startTime = config.tradeStartHHMM ?? '09:20';

    const nowIST   = new Date(Date.now() + IST_OFFSET_MS);
    const nowMins  = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
    const [sh, sm] = startTime.split(':').map(Number);
    const startMins = sh * 60 + sm;

    if (nowMins < startMins) return; // before market open

    const todayIST = nowIST.toISOString().slice(0, 10);
    if (_morningPurgeDate === todayIST) return; // already done today
    _morningPurgeDate = todayIST;

    tradeStore.purgePreviousDayTrades();
}

// ── EOD force-close ──────────────────────────────────────────────────────────

/**
 * At eodCloseHHMM IST, close every open trade at the current market price.
 * Fires once per calendar day (guarded by _eodClosedDate).
 * Runs regardless of isNseOpen() so trades don't carry over midnight.
 */
function _checkEodClose() {
    const config  = tradeStore.getConfig();
    const eodTime = config.eodCloseHHMM ?? '15:25';

    const nowIST    = new Date(Date.now() + IST_OFFSET_MS);
    const nowMins   = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
    const [eh, em]  = eodTime.split(':').map(Number);
    const eodMins   = eh * 60 + em;

    if (nowMins < eodMins) return; // not yet time

    // One sweep per calendar day — avoids re-closing on every subsequent tick
    const todayIST = nowIST.toISOString().slice(0, 10);
    if (_eodClosedDate === todayIST) return;
    _eodClosedDate = todayIST;

    const openTrades = tradeStore.getOpenTrades();
    if (openTrades.length === 0) return;

    console.log(
        `[IdxOrder] 🕐 EOD sweep at ${eodTime} IST — force-closing ${openTrades.length} open trade(s)`,
    );

    for (const trade of openTrades) {
        // Use the live price; fall back to entry price if candles aren't available
        const ltp          = _getCurrentPrice(trade.token) ?? trade.entryPrice;
        const closedTrade  = tradeStore.closeTrade(trade.id, ltp, 'eod');
        if (closedTrade) {
            _openKeys.delete(Number(trade.token));
            console.log(
                `[IdxOrder] 🕐 EOD closed ${trade.symbol} @₹${ltp} PnL=₹${closedTrade.pnl}`,
            );
            broadcast('idx_trade_update', closedTrade);
        }
    }
}

// ── Main tick loop ───────────────────────────────────────────────────────────

function _checkTrades() {
    // Daily lifecycle hooks — run unconditionally (independent of market hours)
    _checkMorningPurge();
    _checkEodClose();

    if (!isNseOpen()) return;

    const openTrades = tradeStore.getOpenTrades();

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
