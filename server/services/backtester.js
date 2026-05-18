/**
 * backtester.js
 *
 * Walk-forward backtest engine for Ichimoku patterns.
 *
 * Given a list of instruments, a set of patterns, a timeframe, and a date
 * range, it:
 *
 *   1. Fetches historical candles for [fromDate - warmup, toDate + buffer]
 *      so Ichimoku has its 52-bar warmup and trades can complete after toDate.
 *   2. Walks bar-by-bar with NO LOOK-AHEAD — at candle i the pattern only
 *      sees candles[0..i] (the current bar inclusive).
 *   3. When a pattern fires AND candle.date ≥ fromDate, opens a simulated
 *      trade at result.close with SL/Target from the pattern engine.
 *   4. Walks forward bar-by-bar checking exit:
 *        BUY  → SL when bar.low ≤ sl, Target when bar.high ≥ target
 *        SELL → SL when bar.high ≥ sl, Target when bar.low ≤ target
 *      If both hit in the same bar, the conservative SL fill wins.
 *   5. Trades still open at the end of data are marked OPEN.
 *
 * Dedup: at most one OPEN trade per (token, patternId, signal) at any time —
 *        same rule the live auto-trader applies.
 *
 * Output: { summary, byPattern, byInterval, trades }
 *
 * Performance: candles fetched in parallel via historicalCache (which is
 * internally rate-limited).  A daily backtest of a 20-stock watchlist over
 * 1 year typically completes in 5–15 s.
 */

const { fetchCandles, formatDate } = require('./historicalCache');
const patternRegistry = require('./patternRegistry');
const { to4H }        = require('./ichimoku');

// Ichimoku needs 52 bars for the cloud — pattern run() returns null otherwise
const MIN_WARMUP_BARS = 52;

// How many calendar days of pre-history to fetch BEFORE fromDate so Ichimoku
// has its 52-bar warmup.  Wider for daily because trading-day density is low.
const WARMUP_DAYS = {
  '15minute': 30,
  '60minute': 90,
  '4h':       90,  // synthesised from 60minute
  'day':      180,
};

// Kite historical-API max windows per interval (rough — used as a sanity cap)
const KITE_MAX_DAYS = {
  '15minute': 200,
  '60minute': 400,
  '4h':       400,
  'day':      2000,
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch historical candles spanning the requested backtest window plus enough
 * pre-history for Ichimoku warmup.  For 4h synthesises from 60minute.
 */
async function _fetchHistory(token, interval, fromDate, toDate) {
  const warmupDays = WARMUP_DAYS[interval] ?? 60;
  const start = new Date(fromDate);
  start.setUTCDate(start.getUTCDate() - warmupDays);

  // Buffer after toDate so open trades can complete (~30 trading days)
  const end = new Date(toDate);
  end.setUTCDate(end.getUTCDate() + 45);

  // Cap the whole range to Kite's per-interval window to avoid a 400 error
  const maxDays = KITE_MAX_DAYS[interval] ?? 200;
  const spanDays = Math.ceil((end - start) / (24 * 60 * 60 * 1000));
  if (spanDays > maxDays) {
    start.setTime(end.getTime() - maxDays * 24 * 60 * 60 * 1000);
  }

  const fromStr = formatDate(start);
  const toStr   = formatDate(end);

  // 4h is synthesised from 60minute — fetch 60minute then convert
  const kiteInterval = interval === '4h' ? '60minute' : interval;
  const candles = await fetchCandles(token, kiteInterval, fromStr, toStr);
  if (!candles || candles.length === 0) return [];

  return interval === '4h' ? to4H(candles) : candles;
}

/**
 * Simulate exit walking forward through future candles.  Returns
 *   { exitDate, exitBar, exitPrice, outcome, pnl, barsHeld }
 * outcome is 'TARGET' | 'SL' | 'OPEN' (didn't complete in available data).
 */
function _simulateExit(trade, candles, entryBar) {
  for (let j = entryBar + 1; j < candles.length; j++) {
    const bar = candles[j];
    let exitPrice = null;
    let outcome   = null;

    if (trade.action === 'BUY') {
      // Conservative: if both SL and target hit in same bar, SL wins
      if (bar.low <= trade.sl) {
        exitPrice = trade.sl;
        outcome   = 'SL';
      } else if (bar.high >= trade.target) {
        exitPrice = trade.target;
        outcome   = 'TARGET';
      }
    } else {
      if (bar.high >= trade.sl) {
        exitPrice = trade.sl;
        outcome   = 'SL';
      } else if (bar.low <= trade.target) {
        exitPrice = trade.target;
        outcome   = 'TARGET';
      }
    }

    if (outcome) {
      const pnl = trade.action === 'BUY'
        ? exitPrice - trade.entryPrice
        : trade.entryPrice - exitPrice;
      return {
        exitDate:  bar.date,
        exitBar:   j,
        exitPrice,
        outcome,
        pnl,
        barsHeld:  j - entryBar,
      };
    }
  }

  // Ran out of data — trade is still OPEN
  const last = candles[candles.length - 1];
  const pnl  = trade.action === 'BUY'
    ? last.close - trade.entryPrice
    : trade.entryPrice - last.close;
  return {
    exitDate:  last.date,
    exitBar:   candles.length - 1,
    exitPrice: last.close,
    outcome:   'OPEN',
    pnl,
    barsHeld:  candles.length - 1 - entryBar,
  };
}

/**
 * Run all selected patterns on this instrument's candles within the date
 * window.  Returns an array of trade records.
 */
function _backtestInstrument(inst, candles, patterns, fromMs, toMs, minRR) {
  const trades = [];
  if (!candles || candles.length < MIN_WARMUP_BARS + 5) return trades;

  // Track open positions to prevent stacking — same key as live auto-trader
  // openByKey: Map<'patternId:signal', exitBar>
  const openUntil = new Map();

  for (let i = MIN_WARMUP_BARS; i < candles.length - 1; i++) {
    const candle    = candles[i];
    const candleMs  = new Date(candle.date).getTime();
    // Skip patterns until candle is inside the user's window
    if (candleMs < fromMs) continue;
    if (candleMs > toMs)   break;

    const window = candles.slice(0, i + 1); // i included

    for (const p of patterns) {
      let result;
      try {
        result = p.run(window, p.defaultOpts);
      } catch {
        continue;
      }
      if (!result?.matched || !result.signal) continue;
      if (!result.sl || !result.target || !result.close) continue;

      // Min R:R guard — same as live auto-trader
      const risk = Math.abs(result.close - result.sl);
      if (risk < 0.01) continue;
      const rr = Math.abs(result.target - result.close) / risk;
      if (rr < minRR) continue;

      // Stacking guard
      const key = `${p.id}:${result.signal}`;
      const blockedUntil = openUntil.get(key);
      if (blockedUntil != null && i <= blockedUntil) continue;

      const action = result.signal === 'bullish' ? 'BUY' : 'SELL';
      const trade = {
        token:        inst.instrumentToken,
        symbol:       inst.name || inst.tradingsymbol,
        patternId:    p.id,
        patternLabel: p.label,
        signal:       result.signal,
        action,
        interval:     null, // filled in by caller
        entryDate:    candle.date,
        entryBar:     i,
        entryPrice:   Math.round(result.close * 100) / 100,
        sl:           Math.round(result.sl    * 100) / 100,
        target:       Math.round(result.target * 100) / 100,
        rr:           Math.round(rr * 100) / 100,
      };

      const exit = _simulateExit(trade, candles, i);
      trade.exitDate  = exit.exitDate;
      trade.exitBar   = exit.exitBar;
      trade.exitPrice = Math.round(exit.exitPrice * 100) / 100;
      trade.outcome   = exit.outcome;
      trade.pnl       = Math.round(exit.pnl * 100) / 100;
      trade.rMultiple = Math.round((exit.pnl / risk) * 100) / 100; // P&L in units of initial risk
      trade.barsHeld  = exit.barsHeld;

      trades.push(trade);
      openUntil.set(key, exit.exitBar);
    }
  }

  return trades;
}

/**
 * Aggregate trades into summary + per-pattern + per-symbol breakdowns.
 */
function _buildReport(trades, params) {
  const decided = trades.filter((t) => t.outcome !== 'OPEN');
  const wins    = decided.filter((t) => t.outcome === 'TARGET').length;
  const losses  = decided.filter((t) => t.outcome === 'SL').length;
  const open    = trades.length - decided.length;

  const totalPnl    = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const winRate     = decided.length > 0 ? wins / decided.length : 0;
  const profitFact  = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Max drawdown of cumulative P&L (sorted by entryDate)
  const sorted = [...trades].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
  let peak = 0;
  let cum  = 0;
  let maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl || 0;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Per-pattern × per-signal aggregation
  const groups = {};
  for (const t of trades) {
    const k = `${t.patternId}|${t.signal}`;
    if (!groups[k]) {
      groups[k] = {
        patternId:  t.patternId,
        signal:     t.signal,
        count:      0,
        wins:       0,
        losses:     0,
        open:       0,
        totalPnl:   0,
        totalR:     0,
      };
    }
    const g = groups[k];
    g.count++;
    if (t.outcome === 'TARGET') g.wins++;
    else if (t.outcome === 'SL') g.losses++;
    else g.open++;
    g.totalPnl += t.pnl || 0;
    g.totalR   += t.rMultiple || 0;
  }
  const byPattern = Object.values(groups).map((g) => {
    const dec = g.wins + g.losses;
    return {
      ...g,
      winRate:    dec > 0 ? Math.round((g.wins / dec) * 1000) / 1000 : 0,
      avgPnl:     g.count > 0 ? Math.round((g.totalPnl / g.count) * 100) / 100 : 0,
      avgR:       g.count > 0 ? Math.round((g.totalR   / g.count) * 100) / 100 : 0,
      totalPnl:   Math.round(g.totalPnl * 100) / 100,
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    params,
    summary: {
      totalTrades:  trades.length,
      decided:      decided.length,
      wins,
      losses,
      open,
      winRate:      Math.round(winRate * 1000) / 1000,
      totalPnl:     Math.round(totalPnl  * 100) / 100,
      grossProfit:  Math.round(grossProfit * 100) / 100,
      grossLoss:    Math.round(grossLoss   * 100) / 100,
      profitFactor: isFinite(profitFact) ? Math.round(profitFact * 100) / 100 : null,
      maxDrawdown:  Math.round(maxDD * 100) / 100,
      expectancy:   trades.length > 0 ? Math.round((totalPnl / trades.length) * 100) / 100 : 0,
      avgR:         trades.length > 0 ? Math.round((trades.reduce((s,t)=>s+(t.rMultiple||0),0) / trades.length) * 100) / 100 : 0,
    },
    byPattern,
    trades: sorted,
  };
}

/**
 * Main entry point.  Returns a Promise resolving to the report object.
 *
 * @param {object}   opts
 * @param {object[]} opts.instruments   [{ instrumentToken, tradingsymbol, name }]
 * @param {string|string[]} opts.patternIds  'all' or array of pattern ids
 * @param {string}   opts.interval     '15minute' | '60minute' | '4h' | 'day'
 * @param {string}   opts.fromDate     'YYYY-MM-DD'
 * @param {string}   opts.toDate       'YYYY-MM-DD'
 * @param {number}   [opts.minRR=2.0]
 * @param {number}   [opts.concurrency=6]
 */
async function runBacktest(opts) {
  const {
    instruments,
    patternIds = 'all',
    interval,
    fromDate,
    toDate,
    minRR = 2.0,
    concurrency = 6,
  } = opts;

  // Resolve patterns
  const patterns = patternIds === 'all'
    ? patternRegistry.list().map((p) => patternRegistry.get(p.id))
    : (Array.isArray(patternIds) ? patternIds : [patternIds])
        .map((id) => patternRegistry.get(id))
        .filter(Boolean);

  if (patterns.length === 0) throw new Error('No valid patterns selected');

  const fromMs = new Date(fromDate).getTime();
  const toMs   = new Date(toDate).getTime() + (24 * 60 * 60 * 1000) - 1; // inclusive end-of-day

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new Error('Invalid fromDate / toDate');
  }

  const allTrades = [];
  const failed    = [];
  let processed   = 0;

  const t0 = Date.now();
  console.log(`[Backtest] start — ${instruments.length} instruments × ${patterns.length} patterns on ${interval} from ${fromDate} → ${toDate}`);

  // Run instruments in concurrent batches (historicalCache rate-limits internally)
  for (let i = 0; i < instruments.length; i += concurrency) {
    const batch = instruments.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(async (inst) => {
      try {
        const candles = await _fetchHistory(inst.instrumentToken, interval, fromDate, toDate);
        const trades  = _backtestInstrument(inst, candles, patterns, fromMs, toMs, minRR);
        for (const t of trades) t.interval = interval;
        allTrades.push(...trades);
      } catch (err) {
        failed.push({ symbol: inst.name || inst.tradingsymbol, error: err.message });
      }
      processed++;
    }));
    console.log(`[Backtest] progress ${processed}/${instruments.length}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Backtest] done — ${allTrades.length} trades across ${processed - failed.length} instruments (${failed.length} failed, ${elapsed}s)`);

  const report = _buildReport(allTrades, {
    interval,
    fromDate,
    toDate,
    minRR,
    patternIds: patterns.map((p) => p.id),
    instrumentCount: instruments.length,
    failed,
    elapsedSec: Number(elapsed),
  });

  return report;
}

module.exports = { runBacktest };
