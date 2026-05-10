/**
 * Ichimoku Cloud calculator.
 * All calculations use standard settings: 9, 26, 52, 26
 *
 * Requires at minimum 52 candles for Senkou Span B.
 * Returns 78+ candles results including 26-period cloud projection.
 */

function highest(candles, period, endIdx) {
  let h = -Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (candles[i] && candles[i].high > h) h = candles[i].high;
  }
  return h === -Infinity ? null : h;
}

function lowest(candles, period, endIdx) {
  let l = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (candles[i] && candles[i].low < l) l = candles[i].low;
  }
  return l === Infinity ? null : l;
}

/**
 * Calculate Ichimoku for an array of candles.
 * Returns an array of result objects, one per candle.
 *
 * Each result: {
 *   date, open, high, low, close, volume,
 *   tenkan,         // Conversion line (9-period)
 *   kijun,          // Base line (26-period)
 *   senkouA,        // Leading Span A (plotted 26 ahead)
 *   senkouB,        // Leading Span B (52-period, plotted 26 ahead)
 *   chikou,         // Lagging Span (close plotted 26 behind)
 *   cloudTop,       // max(senkouA, senkouB) at this candle's position
 *   cloudBottom,    // min(senkouA, senkouB) at this candle's position
 *   aboveCloud,     // close > cloudTop
 *   belowCloud,     // close < cloudBottom
 *   inCloud,        // between cloud bands
 *   tkCross,        // 'bullish' | 'bearish' | null
 * }
 */
function calculate(candles) {
  const n = candles.length;
  const results = candles.map((c) => ({ ...c, tenkan: null, kijun: null, senkouA: null, senkouB: null, chikou: null, cloudTop: null, cloudBottom: null, aboveCloud: false, belowCloud: false, inCloud: false, tkCross: null }));

  for (let i = 0; i < n; i++) {
    // Tenkan-sen: (9H + 9L) / 2
    if (i >= 8) {
      const h = highest(candles, 9, i);
      const l = lowest(candles, 9, i);
      results[i].tenkan = h != null && l != null ? round((h + l) / 2) : null;
    }

    // Kijun-sen: (26H + 26L) / 2
    if (i >= 25) {
      const h = highest(candles, 26, i);
      const l = lowest(candles, 26, i);
      results[i].kijun = h != null && l != null ? round((h + l) / 2) : null;
    }

    // Senkou Span A: (Tenkan + Kijun) / 2 — plotted 26 periods AHEAD
    // Store in the future candle slot
    if (results[i].tenkan != null && results[i].kijun != null) {
      const futureIdx = i + 26;
      if (futureIdx < n) {
        results[futureIdx].senkouA = round((results[i].tenkan + results[i].kijun) / 2);
      }
    }

    // Senkou Span B: (52H + 52L) / 2 — plotted 26 periods AHEAD
    if (i >= 51) {
      const h = highest(candles, 52, i);
      const l = lowest(candles, 52, i);
      if (h != null && l != null) {
        const futureIdx = i + 26;
        if (futureIdx < n) {
          results[futureIdx].senkouB = round((h + l) / 2);
        }
      }
    }

    // Chikou Span: close plotted 26 periods BEHIND
    const pastIdx = i - 26;
    if (pastIdx >= 0) {
      results[pastIdx].chikou = candles[i].close;
    }
  }

  // Derive cloud position and TK cross for each candle
  for (let i = 1; i < n; i++) {
    const r = results[i];
    const prev = results[i - 1];

    if (r.senkouA != null && r.senkouB != null) {
      r.cloudTop = Math.max(r.senkouA, r.senkouB);
      r.cloudBottom = Math.min(r.senkouA, r.senkouB);
      r.aboveCloud = r.close > r.cloudTop;
      r.belowCloud = r.close < r.cloudBottom;
      r.inCloud = !r.aboveCloud && !r.belowCloud;
    }

    // TK cross
    if (r.tenkan != null && r.kijun != null && prev.tenkan != null && prev.kijun != null) {
      const wasBullish = prev.tenkan > prev.kijun;
      const isBullish = r.tenkan > r.kijun;
      if (!wasBullish && isBullish) r.tkCross = 'bullish';
      else if (wasBullish && !isBullish) r.tkCross = 'bearish';
    }
  }

  return results;
}

/**
 * Get the Ichimoku state snapshot at the last candle.
 * Useful for condition checking.
 */
function snapshot(candles) {
  if (!candles || candles.length < 52) return null;
  const results = calculate(candles);
  return results[results.length - 1];
}

/**
 * Returns true if Kijun barely moved over the last `lookback` candles.
 * Threshold: (max - min) / avg < thresholdPct%
 * For NIFTY at ~22000 with 0.1% threshold that's ~22 points range.
 */
const KIJUN_FLAT_PARAMS = {
  '1minute':   { lookback: 30, thresholdPct: 0.05 },
  '5minute':   { lookback: 20, thresholdPct: 0.10 },
  '15minute':  { lookback: 10, thresholdPct: 0.15 },
};

function isKijunFlat(results, lastIdx, interval = '15minute') {
  const { lookback, thresholdPct } = KIJUN_FLAT_PARAMS[interval] || KIJUN_FLAT_PARAMS['15minute'];
  const kijuns = [];
  for (let i = lastIdx - lookback + 1; i <= lastIdx; i++) {
    if (i >= 0 && results[i] && results[i].kijun != null) kijuns.push(results[i].kijun);
  }
  if (kijuns.length < lookback) return false;
  const max = Math.max(...kijuns);
  const min = Math.min(...kijuns);
  const avg = kijuns.reduce((a, b) => a + b, 0) / kijuns.length;
  return avg > 0 && ((max - min) / avg) * 100 < thresholdPct;
}

/**
 * Returns the key trading signals at the latest candle.
 * Focuses on Chikou and Kijun as primary signals.
 *
 * chikouSignal: current close vs close 26 periods ago
 *   — "bullish" means price has risen over last 26 bars (momentum up)
 *   — "bearish" means price has fallen over last 26 bars
 *
 * kijunSignal: current close vs Kijun (base line)
 *   — "bullish" means price is above the equilibrium line
 *   — "bearish" means price is below it
 *
 * putBuySignal: true when —
 *   chikou (close) > kijun  AND  kijun flat last 6 candles
 *   AND price just crossed BELOW chikou level (price26ago) for the first time
 *
 * callBuySignal: true when —
 *   chikou (close) < kijun  AND  kijun flat last 6 candles
 *   AND price just crossed ABOVE chikou level (price26ago) for the first time
 */
function getSignals(candles, interval = '15minute') {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const last = results[results.length - 1];
  const n = candles.length;

  // Chikou: current close vs close 26 periods ago
  const price26ago  = n >= 27 ? candles[n - 1 - 26].close : null;
  const prevClose   = n >= 2  ? candles[n - 2].close       : null;
  const chikouValue = last.close;
  const chikouAbovePrice = price26ago != null ? chikouValue > price26ago : null;
  const chikouSignal = chikouAbovePrice == null ? 'neutral'
    : chikouAbovePrice ? 'bullish' : 'bearish';

  // Kijun: close vs base line
  const kijunSignal = last.kijun == null ? 'neutral'
    : last.close > last.kijun ? 'bullish'
    : last.close < last.kijun ? 'bearish'
    : 'neutral';

  // Tenkan: close vs conversion line
  const tenkanSignal = last.tenkan == null ? 'neutral'
    : last.close > last.tenkan ? 'bullish'
    : last.close < last.tenkan ? 'bearish'
    : 'neutral';

  // Cloud position
  const cloudSignal = last.aboveCloud ? 'bullish'
    : last.belowCloud ? 'bearish'
    : 'neutral';

  const cloudColor = last.senkouA != null && last.senkouB != null
    ? (last.senkouA >= last.senkouB ? 'bullish' : 'bearish')
    : null;

  // Overall: all 4 factors (chikou + kijun + cloud + tk) in agreement
  const signals = [chikouSignal, kijunSignal, cloudSignal, tenkanSignal];
  const bullCount = signals.filter((s) => s === 'bullish').length;
  const bearCount = signals.filter((s) => s === 'bearish').length;
  const overallSignal = bullCount >= 3 ? 'bullish' : bearCount >= 3 ? 'bearish' : 'neutral';

  // How far has close expanded from Kijun (as %)
  const expansionPct = last.kijun > 0
    ? Math.abs(last.close - last.kijun) / last.kijun * 100
    : 0;

  // PUT BUY: chikou expanded above kijun, kijun flat, price first-time cross BELOW chikou level
  const kijunFlat = isKijunFlat(results, n - 1, interval);
  const putBuySignal = !!(
    last.kijun != null && price26ago != null && prevClose != null &&
    last.close > last.kijun &&        // chikou (= close) is above kijun
    expansionPct >= 0.5 &&            // expanded at least 0.5% from kijun
    kijunFlat &&                      // kijun has been flat last 6 candles
    prevClose >= price26ago &&        // previous candle was at or above chikou level
    last.close < price26ago           // current candle just closed below chikou level
  );

  // CALL BUY: chikou expanded below kijun, kijun flat, price first-time cross ABOVE chikou level
  const callBuySignal = !!(
    last.kijun != null && price26ago != null && prevClose != null &&
    last.close < last.kijun &&        // chikou (= close) is below kijun
    expansionPct >= 0.5 &&            // expanded at least 0.5% from kijun
    kijunFlat &&                      // kijun has been flat last 6 candles
    prevClose <= price26ago &&        // previous candle was at or below chikou level
    last.close > price26ago           // current candle just closed above chikou level
  );

  return {
    date:          last.date,
    close:         last.close,
    // Chikou (most important)
    chikouValue,
    price26ago,
    chikouAbovePrice,
    chikouSignal,
    // Kijun (most important)
    kijun:         last.kijun,
    kijunSignal,
    kijunFlat,
    // Tenkan
    tenkan:        last.tenkan,
    tenkanSignal,
    // Cloud
    cloudTop:      last.cloudTop,
    cloudBottom:   last.cloudBottom,
    aboveCloud:    last.aboveCloud,
    belowCloud:    last.belowCloud,
    inCloud:       last.inCloud,
    cloudColor,
    cloudSignal,
    // TK cross at last candle
    tkCross:       last.tkCross,
    // Summary
    overallSignal,
    // Index tab signals
    expansionPct:  Math.round(expansionPct * 100) / 100,
    putBuySignal,
    callBuySignal,
    candleCount:   n,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { calculate, snapshot, getSignals };
