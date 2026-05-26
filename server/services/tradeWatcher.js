/**
 * tradeWatcher.js
 *
 * Server-side SL / Target / Trailing-SL handler for cash/equity paper trades.
 *
 * Per-tick monitoring: SL, TSL, and target fire when the share price tick
 * breaches the level.  When the `slViaCandleClose` setting is enabled, SL/TSL
 * exits are deferred until a 15-minute candle *closes* beyond the SL level —
 * preventing wick-triggered false exits.  Target hits are always immediate.
 *
 * Output:
 *   • broadcast('paper_trade_update', closedTrade)
 *   • broadcast('paper_balance', balance)
 *   • db.tradeRepo.closeTrade(trade)
 *   • kiteTicker unsubscribes the token when no longer needed
 */

const store                        = require('../store');
const { broadcast }                = require('../sseHub');
const db                           = require('../db');
const { isNseOpen, isMcxOpen }     = require('../utils/marketHours');
const kiteOrderBridge              = require('./kiteOrderBridge');

function _ticker() {
  return require('./kiteTicker');
}

const _closing           = new Set();
const _lastTickBroadcast = new Map();

// Pending SL breach confirmations — populated when a tick crosses SL and
// settings.slViaCandleClose is true.  Cleared on price recovery or 15m candle close.
// tradeId → { sl: number, reason: string, breachTime: number }
const _slBreachMap = new Map();

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

  // F5: Pattern-specific TSL trigger — trend patterns (kumo-breakout, cloud-support,
  // kumo-bounce) need 1.5R before trailing so the trade has room to develop.
  // Bounce patterns (kijun-bounce, kijun-retest) use the default 1.0R.
  // Reversion patterns (tk-reversion) use 0.5R since the target is close.
  // The per-trade tslTriggerR is set at order-placement time; falls back to settings.
  const triggerR = trade.tslTriggerR ?? settings.tslTriggerR;
  if (profit < triggerR * riskPerUnit) return false;

  const prevPeak = trade.peakPrice ?? entry;
  const newPeak  = trade.action === 'BUY'
    ? Math.max(prevPeak, ltp)
    : Math.min(prevPeak, ltp);

  // F10: MCX instruments have wider intraday swings than NSE equities.
  // A 0.5R trail distance gets stopped out on normal MCX noise.
  // Enforce a minimum 1.0R trail distance for MCX trades.
  const isMcx       = String(trade.exchange ?? '').toUpperCase() === 'MCX';
  const minDistR    = isMcx ? 1.0 : settings.tslDistanceR;
  const trailDistR  = Math.max(settings.tslDistanceR, minDistR);
  const trailGap    = trailDistR * riskPerUnit;
  let candidateSl   = trade.action === 'BUY'
    ? newPeak - trailGap
    : newPeak + trailGap;

  // F4: Incorporate trailingAnchor (Tenkan for trend, Kijun for bounce) as a
  // TSL floor.  The anchor is the structural level the trade should not fall
  // below — if the R-based trail is below the anchor, use the anchor instead.
  // This prevents the trail from drifting too far from the current Ichimoku
  // structure while still allowing the R-based trail to take over when the
  // trend extends beyond the anchor.
  if (trade.trailingAnchor != null && trade.tslActivated) {
    const anchorBuf = riskPerUnit * 0.15;  // small buffer below anchor
    const anchorSl  = trade.action === 'BUY'
      ? trade.trailingAnchor - anchorBuf
      : trade.trailingAnchor + anchorBuf;
    // Use whichever is more protective (closer to price)
    if (trade.action === 'BUY'  && anchorSl > candidateSl) candidateSl = anchorSl;
    if (trade.action === 'SELL' && anchorSl < candidateSl) candidateSl = anchorSl;
  }

  // F8: Breakeven lock — once the trade has reached 2R profit, the SL must
  // never go below the entry price.  This guarantees at minimum a scratch trade
  // after a strong initial move, even if the trail calculation would otherwise
  // place the stop below entry on a deep pullback.
  const currentR = profit / riskPerUnit;
  const BREAKEVEN_LOCK_R = 2.0;
  if (currentR >= BREAKEVEN_LOCK_R || (trade.peakR ?? 0) >= BREAKEVEN_LOCK_R) {
    const entryFloor = trade.action === 'BUY'
      ? Math.max(candidateSl, entry)
      : Math.min(candidateSl, entry);
    candidateSl = entryFloor;
  }

  const shouldMove = trade.action === 'BUY'
    ? candidateSl > (trade.sl ?? -Infinity)
    : candidateSl < (trade.sl ??  Infinity);
  if (!shouldMove) return false;

  const newSl = Math.round(candidateSl * 100) / 100;
  const wasArmed = trade.tslActivated;
  // Track peak R-multiple reached for breakeven lock persistence
  const peakR = Math.max(trade.peakR ?? 0, currentR);
  store.updatePaperTrade(trade.id, { sl: newSl, peakPrice: newPeak, peakR, tslActivated: true });
  trade.sl           = newSl;
  trade.peakPrice    = newPeak;
  trade.peakR        = peakR;
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

  // Place live Kite exit order to square off the real position.
  kiteOrderBridge.placeExitOrder(closed, reason).catch(err =>
    console.error('[TradeWatcher] kiteOrderBridge.placeExitOrder error:', err.message),
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
    // ── Market-hours gate for pending activation ──────────────────────────
    // A pending order placed before market close must NOT activate on a tick
    // that arrives after the exchange has closed.
    //   NSE / F&O / CDS → isNseOpen()   [09:20–15:20 IST]
    //   MCX             → isMcxOpen()   [09:00–23:30 IST]
    const tradeExchange = String(trade.exchange ?? 'NSE').toUpperCase();
    const tradeIsMcx    = tradeExchange === 'MCX';
    if (tradeIsMcx  && !isMcxOpen())  continue; // MCX closed
    if (!tradeIsMcx && !isNseOpen())  continue; // NSE/F&O window closed

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

    // Place live Kite entry order now that the trade is OPEN.
    kiteOrderBridge.placeEntryOrder(activated).catch(err =>
      console.error('[TradeWatcher] kiteOrderBridge.placeEntryOrder error:', err.message),
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
      if (exit.reason !== 'TARGET' && settings.slViaCandleClose) {
        // SL/TSL hit — defer close until a 15m candle close confirms the breach.
        if (!_slBreachMap.has(trade.id)) {
          _slBreachMap.set(trade.id, { sl: exit.closeAt, reason: exit.reason, breachTime: Date.now() });
          console.log(
            `[TradeWatcher] ⚠  SL breached (tick) — ${trade.symbol ?? trade.token}` +
            ` @ ₹${lastPrice} | SL ₹${exit.closeAt} | waiting for 15m close`,
          );
        }
        // Broadcast warning so the UI can show an amber "SL pending" indicator.
        broadcast('paper_trade_tick', {
          id:         trade.id,
          token:      Number(trade.token),
          ltp:        lastPrice,
          slBreached: true,
        });
        continue;
      }
      // TARGET hit, or slViaCandleClose is disabled — close immediately.
      _closeTrade(trade, exit.closeAt, exit.reason);
      continue;
    }

    // Price recovered back inside the SL — cancel any pending breach.
    if (_slBreachMap.has(trade.id)) {
      _slBreachMap.delete(trade.id);
      console.log(`[TradeWatcher] ✅ SL breach cancelled (price recovered) — ${trade.symbol ?? trade.token}`);
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

/**
 * Called by backgroundScanner after every 15-minute candle cycle for each token.
 * When `slViaCandleClose` is enabled, this is the gate that decides whether a
 * pending SL breach is real (candle closed beyond SL) or just a wick (recovered).
 *
 * No-op when the map is empty or the interval is not '15minute'.
 *
 * @param {number} token            Instrument token
 * @param {string} interval         Only '15minute' triggers confirmation
 * @param {number} candleClosePrice Close price of the just-completed 15m candle
 */
function onCandleClose(token, interval, candleClosePrice) {
  if (_slBreachMap.size === 0) return;

  const numToken    = Number(token);
  // F6: Match the trade's own TF instead of hardcoding '15minute'.
  // Each trade stores its entry interval (e.g. '15minute', '60minute', '4h', 'day').
  // SL confirmation should happen on the same TF the signal was taken on — a
  // daily trade should not exit on a 15m candle close, and a 15m trade should
  // not wait for a daily close.  Falls back to '15minute' when the trade has
  // no interval recorded (legacy trades).
  const pendingTrades = store.getPaperTrades().filter(
    (t) => t.status === 'OPEN' &&
           Number(t.token) === numToken &&
           _slBreachMap.has(t.id) &&
           (t.interval ?? '15minute') === interval,
  );

  for (const trade of pendingTrades) {
    const breach = _slBreachMap.get(trade.id);
    _slBreachMap.delete(trade.id);

    const confirmed =
      trade.action === 'BUY'
        ? candleClosePrice <= breach.sl
        : candleClosePrice >= breach.sl;

    if (confirmed) {
      console.log(
        `[TradeWatcher] 🔴 SL confirmed on 15m close — ${trade.symbol ?? trade.token}` +
        ` close ₹${candleClosePrice} vs SL ₹${breach.sl}`,
      );
      _closeTrade(trade, breach.sl, breach.reason);
    } else {
      console.log(
        `[TradeWatcher] ✅ SL NOT confirmed (wick) — ${trade.symbol ?? trade.token}` +
        ` close ₹${candleClosePrice} vs SL ₹${breach.sl}`,
      );
    }
  }
}

module.exports = { onTick, onCandleClose };
