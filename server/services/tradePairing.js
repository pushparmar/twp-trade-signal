/**
 * tradePairing.js
 *
 * Pairs BUY/SELL trades into complete round-trip cycles for backtesting.
 *
 * Current structure: Each trade record has entry + exit in one object.
 * New structure: Group trades by symbol and show complete position lifecycle.
 *
 * Example:
 *   Input:  [BUY RELIANCE @2400, SELL RELIANCE @2450, BUY INFY @1500, SELL INFY @1480]
 *   Output: [
 *     { entry: BUY RELIANCE @2400, exit: SELL @2450, pnl: +50 },
 *     { entry: BUY INFY @1500, exit: SELL @1480, pnl: -20 }
 *   ]
 */

/**
 * Convert trade list into round-trip pairs for backtesting.
 *
 * Groups trades by symbol and pairs entry/exit to show complete trade cycles.
 * Each pair shows: entry time, entry price, exit time, exit price, PnL, duration.
 *
 * @param {Array} trades - Array of trade objects from tradeRepo
 * @returns {Array} Array of paired trades with complete cycle info
 */
function pairTrades(trades) {
  if (!trades || trades.length === 0) return [];

  // Each trade already has entry + exit in one record
  // We'll enrich it with additional computed fields for backtesting
  const pairs = trades
    .filter(t => t.status === 'CLOSED' && t.pnl != null)
    .map(trade => {
      const entryTime = new Date(trade.ts);
      const exitTime = trade.closedTs ? new Date(trade.closedTs) : null;
      const durationMs = exitTime ? exitTime - entryTime : null;
      const durationMins = durationMs ? Math.round(durationMs / 60000) : null;

      // Calculate R-multiple (actual profit/loss relative to risk)
      const risk = Math.abs(trade.entryPrice - trade.initialSl);
      const actualProfit = trade.action === 'BUY'
        ? (trade.exitPrice - trade.entryPrice)
        : (trade.entryPrice - trade.exitPrice);
      const rMultiple = risk > 0 ? actualProfit / risk : null;

      return {
        // Trade identification
        id: trade.id,
        symbol: trade.symbol,
        exchange: trade.exchange,

        // Entry details
        action: trade.action,              // 'BUY' or 'SELL'
        entryTime: entryTime.toISOString(),
        entryPrice: trade.entryPrice,
        quantity: trade.quantity,
        lotSize: trade.lotSize || 1,

        // Exit details
        exitTime: exitTime ? exitTime.toISOString() : null,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,      // 'sl', 'tsl', 'target', 'manual', 'eod'

        // Risk management
        initialSl: trade.initialSl,
        finalSl: trade.sl,
        target: trade.target,
        targetSource: trade.targetSource,

        // Performance metrics
        pnl: trade.pnl,
        rMultiple: rMultiple ? Math.round(rMultiple * 100) / 100 : null,
        durationMins,
        durationHours: durationMins ? Math.round(durationMins / 60 * 10) / 10 : null,

        // Pattern context
        patternId: trade.patternId,
        patternLabel: trade.patternLabel,
        signal: trade.signal,
        interval: trade.interval,
        tfLabel: trade.tfLabel,
        score: trade.score,
        rrRatio: trade.rrRatio,

        // Indicators
        rsi14: trade.rsi14,
        volumeConfirmed: trade.volumeConfirmed,
        mtfAligned: trade.mtfAligned,

        // TSL tracking
        tslActivated: trade.tslActivated,
        peakPrice: trade.peakPrice,

        // Source
        source: trade.source,
        autoSource: trade.autoSource,
      };
    })
    .sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime)); // newest first

  return pairs;
}

/**
 * Group paired trades by symbol for aggregate analysis.
 *
 * @param {Array} pairs - Array from pairTrades()
 * @returns {Object} Map of symbol → trade stats
 */
function groupBySymbol(pairs) {
  const grouped = {};

  for (const pair of pairs) {
    const sym = pair.symbol;
    if (!grouped[sym]) {
      grouped[sym] = {
        symbol: sym,
        exchange: pair.exchange,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        avgPnl: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        avgDurationMins: 0,
        bestTrade: null,
        worstTrade: null,
        trades: [],
      };
    }

    const g = grouped[sym];
    g.totalTrades++;
    g.totalPnl += pair.pnl;
    g.trades.push(pair);

    if (pair.pnl > 0) {
      g.wins++;
    } else if (pair.pnl < 0) {
      g.losses++;
    }

    if (!g.bestTrade || pair.pnl > g.bestTrade.pnl) {
      g.bestTrade = pair;
    }
    if (!g.worstTrade || pair.pnl < g.worstTrade.pnl) {
      g.worstTrade = pair;
    }
  }

  // Calculate averages
  for (const sym in grouped) {
    const g = grouped[sym];
    g.avgPnl = g.totalTrades > 0 ? Math.round(g.totalPnl / g.totalTrades * 100) / 100 : 0;
    g.winRate = g.totalTrades > 0 ? Math.round((g.wins / g.totalTrades) * 100) : 0;

    const winTrades = g.trades.filter(t => t.pnl > 0);
    const lossTrades = g.trades.filter(t => t.pnl < 0);
    g.avgWin = winTrades.length > 0
      ? Math.round(winTrades.reduce((sum, t) => sum + t.pnl, 0) / winTrades.length * 100) / 100
      : 0;
    g.avgLoss = lossTrades.length > 0
      ? Math.round(lossTrades.reduce((sum, t) => sum + t.pnl, 0) / lossTrades.length * 100) / 100
      : 0;

    const durations = g.trades.filter(t => t.durationMins != null).map(t => t.durationMins);
    g.avgDurationMins = durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : 0;
  }

  return grouped;
}

/**
 * Group paired trades by pattern for pattern performance analysis.
 *
 * @param {Array} pairs - Array from pairTrades()
 * @returns {Object} Map of patternId → pattern stats
 */
function groupByPattern(pairs) {
  const grouped = {};

  for (const pair of pairs) {
    const pid = pair.patternId || 'unknown';
    if (!grouped[pid]) {
      grouped[pid] = {
        patternId: pid,
        patternLabel: pair.patternLabel || pid,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        avgPnl: 0,
        winRate: 0,
        avgRMultiple: 0,
        avgDurationMins: 0,
        byTimeframe: {},
        trades: [],
      };
    }

    const g = grouped[pid];
    g.totalTrades++;
    g.totalPnl += pair.pnl;
    g.trades.push(pair);

    if (pair.pnl > 0) g.wins++;
    else if (pair.pnl < 0) g.losses++;

    // Group by timeframe within pattern
    const tf = pair.tfLabel || pair.interval || 'unknown';
    if (!g.byTimeframe[tf]) {
      g.byTimeframe[tf] = { count: 0, wins: 0, totalPnl: 0 };
    }
    g.byTimeframe[tf].count++;
    if (pair.pnl > 0) g.byTimeframe[tf].wins++;
    g.byTimeframe[tf].totalPnl += pair.pnl;
  }

  // Calculate averages
  for (const pid in grouped) {
    const g = grouped[pid];
    g.avgPnl = g.totalTrades > 0 ? Math.round(g.totalPnl / g.totalTrades * 100) / 100 : 0;
    g.winRate = g.totalTrades > 0 ? Math.round((g.wins / g.totalTrades) * 100) : 0;

    const rMultiples = g.trades.filter(t => t.rMultiple != null).map(t => t.rMultiple);
    g.avgRMultiple = rMultiples.length > 0
      ? Math.round(rMultiples.reduce((sum, r) => sum + r, 0) / rMultiples.length * 100) / 100
      : 0;

    const durations = g.trades.filter(t => t.durationMins != null).map(t => t.durationMins);
    g.avgDurationMins = durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : 0;

    // Timeframe win rates
    for (const tf in g.byTimeframe) {
      const tfData = g.byTimeframe[tf];
      tfData.winRate = tfData.count > 0
        ? Math.round((tfData.wins / tfData.count) * 100)
        : 0;
      tfData.avgPnl = tfData.count > 0
        ? Math.round(tfData.totalPnl / tfData.count * 100) / 100
        : 0;
    }
  }

  return grouped;
}

/**
 * Generate backtesting summary statistics from paired trades.
 *
 * @param {Array} pairs - Array from pairTrades()
 * @returns {Object} Summary stats for backtesting
 */
function generateBacktestStats(pairs) {
  if (!pairs || pairs.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      totalPnl: 0,
      avgPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      profitFactor: 0,
      avgRMultiple: 0,
      avgDurationMins: 0,
      avgDurationHours: 0,
    };
  }

  const wins = pairs.filter(p => p.pnl > 0);
  const losses = pairs.filter(p => p.pnl < 0);
  const breakeven = pairs.filter(p => p.pnl === 0);

  const totalPnl = pairs.reduce((sum, p) => sum + p.pnl, 0);
  const totalWinPnl = wins.reduce((sum, p) => sum + p.pnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((sum, p) => sum + p.pnl, 0));

  const rMultiples = pairs.filter(p => p.rMultiple != null).map(p => p.rMultiple);
  const durations = pairs.filter(p => p.durationMins != null).map(p => p.durationMins);

  return {
    totalTrades: pairs.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: Math.round((wins.length / pairs.length) * 100),
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round(totalPnl / pairs.length * 100) / 100,
    avgWin: wins.length > 0 ? Math.round(totalWinPnl / wins.length * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round(totalLossPnl / losses.length * 100) / 100 : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map(p => p.pnl)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map(p => p.pnl)) : 0,
    profitFactor: totalLossPnl > 0 ? Math.round(totalWinPnl / totalLossPnl * 100) / 100 : 0,
    avgRMultiple: rMultiples.length > 0
      ? Math.round(rMultiples.reduce((sum, r) => sum + r, 0) / rMultiples.length * 100) / 100
      : 0,
    avgDurationMins: durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : 0,
    avgDurationHours: durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length / 60 * 10) / 10
      : 0,
  };
}

module.exports = {
  pairTrades,
  groupBySymbol,
  groupByPattern,
  generateBacktestStats,
};
