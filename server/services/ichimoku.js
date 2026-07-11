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
// Kite uses 'minute' (not '1minute') for the 1-min interval
const KIJUN_FLAT_PARAMS = {
  'minute':    { lookback: 30, thresholdPct: 0.05 },
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

/**
 * Kumo Breakout + Twist confluence — perfect 5/5 setup detector.
 *
 * All five conditions must agree in the same direction AND both the breakout
 * and the twist must have occurred within the last `lookback` candles.
 *
 * The five checks:
 *   1. kumoBreakout  — price crossed out of the cloud within the last `lookback` bars
 *                      and has not re-entered since.
 *   2. cloudColor    — Senkou A > Senkou B at the current bar (bullish = green cloud).
 *   3. kumoTwist     — Senkou A crossed Senkou B within the last `lookback` bars.
 *   4. chikou        — current close vs close 26 bars ago (momentum direction).
 *   5. kijun         — current close vs Kijun base line (equilibrium).
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=10]  — window for both breakout and twist detection
 */
function getKumoBreakoutTwist(candles, { lookback = 10 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  // ── 1. Kumo Breakout — crossover must be within `lookback` bars ──────────
  // Price must currently be outside the cloud AND the cross itself must be recent.
  let kumoBreakout = 'neutral';
  if (last.aboveCloud || last.belowCloud) {
    const wantBullish = last.aboveCloud;
    for (let offset = 0; offset < lookback; offset++) {
      const idx  = n - 1 - offset;
      const idxP = idx - 1;
      if (idxP < 0) break;
      const cur  = results[idx];
      const prev = results[idxP];
      if (wantBullish && cur.aboveCloud && !prev.aboveCloud) {
        kumoBreakout = 'bullish';
        break;
      }
      if (!wantBullish && cur.belowCloud && !prev.belowCloud) {
        kumoBreakout = 'bearish';
        break;
      }
    }
    // If the cross is older than `lookback`, kumoBreakout stays 'neutral' — stale.
  }

  // ── 2. Cloud color at current bar ────────────────────────────────────────
  const cloudColor = last.senkouA == null || last.senkouB == null ? 'neutral'
    : last.senkouA > last.senkouB ? 'bullish'
    : last.senkouA < last.senkouB ? 'bearish'
    : 'neutral';

  // ── 3. Kumo Twist — Senkou A/B crossover within `lookback` bars ──────────
  let kumoTwist    = 'neutral';
  let twistBarsAgo = null;
  for (let offset = 1; offset <= lookback; offset++) {
    const idx  = n - 1 - offset;
    const idxP = idx - 1;
    if (idxP < 0) break;
    const cur  = results[idx];
    const prev = results[idxP];
    if (cur.senkouA == null || cur.senkouB == null) continue;
    if (prev.senkouA == null || prev.senkouB == null) continue;
    const prevBull = prev.senkouA > prev.senkouB;
    const curBull  = cur.senkouA  > cur.senkouB;
    if (!prevBull && curBull)  { kumoTwist = 'bullish'; twistBarsAgo = offset; break; }
    if (prevBull  && !curBull) { kumoTwist = 'bearish'; twistBarsAgo = offset; break; }
  }

  // ── 4. Chikou — current close vs close 26 bars ago ───────────────────────
  const price26ago = n >= 27 ? candles[n - 1 - 26].close : null;
  const chikou = price26ago == null ? 'neutral'
    : last.close > price26ago ? 'bullish'
    : last.close < price26ago ? 'bearish'
    : 'neutral';

  // ── 5. Price vs Kijun ────────────────────────────────────────────────────
  const kijun = last.kijun == null ? 'neutral'
    : last.close > last.kijun ? 'bullish'
    : last.close < last.kijun ? 'bearish'
    : 'neutral';

  // ── Score ─────────────────────────────────────────────────────────────────
  const checks    = { kumoBreakout, cloudColor, kumoTwist, chikou, kijun };
  const votes     = Object.values(checks);
  const bullScore = votes.filter((v) => v === 'bullish').length;
  const bearScore = votes.filter((v) => v === 'bearish').length;
  const score     = Math.max(bullScore, bearScore);

  // Signal only on clean 5/5
  const signal = bullScore === 5 ? 'bullish'
    : bearScore === 5            ? 'bearish'
    : null;

  return {
    signal,
    score,
    checks,
    twistBarsAgo,
    close:       last.close,
    kijunValue:  last.kijun,
    cloudTop:    last.cloudTop,
    cloudBottom: last.cloudBottom,
    senkouA:     last.senkouA,
    senkouB:     last.senkouB,
    price26ago,
  };
}

/**
 * Kumo Breakout — detects the moment price crossed out of the cloud.
 *
 * A breakout is valid only when the crossover itself happened within the last
 * `lookback` candles AND price is currently still on the breakout side.
 * If price broke out 3 bars ago and has already re-entered the cloud, the
 * signal is stale and returns null.
 *
 * Bullish breakout: bar[i-1] was NOT above the cloud → bar[i] IS above the cloud.
 * Bearish breakout: bar[i-1] was NOT below the cloud → bar[i] IS below the cloud.
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=10]  — how many bars back to search for the crossover
 *
 * @returns {{
 *   signal:       'bullish' | 'bearish' | null,
 *   barsAgo:      number | null,   // candles since the breakout bar (0 = current bar)
 *   close:        number,
 *   cloudTop:     number | null,
 *   cloudBottom:  number | null,
 *   senkouA:      number | null,
 *   senkouB:      number | null,
 * } | null}
 */
function getKumoBreakout(candles, { lookback = 10 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  // Price must currently be outside the cloud — if it drifted back in, signal is dead.
  if (!last.aboveCloud && !last.belowCloud) {
    return {
      signal: null, barsAgo: null,
      close:       last.close,
      cloudTop:    last.cloudTop,    cloudBottom: last.cloudBottom,
      senkouA:     last.senkouA,     senkouB:     last.senkouB,
      tenkan:      last.tenkan != null ? round(last.tenkan) : null,
      kijun:       last.kijun  != null ? round(last.kijun)  : null,
    };
  }

  const lookingForBullish = last.aboveCloud;

  // Scan backwards to find when the crossover happened within `lookback` bars.
  for (let offset = 0; offset < lookback; offset++) {
    const idx  = n - 1 - offset;
    const idxP = idx - 1;
    if (idxP < 0) break;

    const cur  = results[idx];
    const prev = results[idxP];

    if (lookingForBullish) {
      if (cur.aboveCloud && !prev.aboveCloud) {
        return {
          signal:      'bullish',
          barsAgo:     offset,
          close:       last.close,
          cloudTop:    last.cloudTop,
          cloudBottom: last.cloudBottom,
          senkouA:     last.senkouA,
          senkouB:     last.senkouB,
          tenkan:      last.tenkan != null ? round(last.tenkan) : null,
          kijun:       last.kijun  != null ? round(last.kijun)  : null,
        };
      }
    } else {
      if (cur.belowCloud && !prev.belowCloud) {
        return {
          signal:      'bearish',
          barsAgo:     offset,
          close:       last.close,
          cloudTop:    last.cloudTop,
          cloudBottom: last.cloudBottom,
          senkouA:     last.senkouA,
          senkouB:     last.senkouB,
          tenkan:      last.tenkan != null ? round(last.tenkan) : null,
          kijun:       last.kijun  != null ? round(last.kijun)  : null,
        };
      }
    }
  }

  // Price is outside the cloud but the crossover happened more than `lookback` bars ago — stale.
  return {
    signal: null, barsAgo: null,
    close:       last.close,
    cloudTop:    last.cloudTop,    cloudBottom: last.cloudBottom,
    senkouA:     last.senkouA,     senkouB:     last.senkouB,
    tenkan:      last.tenkan != null ? round(last.tenkan) : null,
    kijun:       last.kijun  != null ? round(last.kijun)  : null,
  };
}

/**
 * Kumo Twist — detects a recent Senkou A / Senkou B crossover (cloud color flip).
 *
 * A twist is a forward-looking signal: the cloud is changing bias.
 * This function only reports the twist if it occurred within the last `lookback` candles.
 * It does NOT require price to be above/below the cloud — the twist alone is the signal.
 *
 * Bullish twist: Senkou A crossed ABOVE Senkou B → cloud turned green.
 * Bearish twist: Senkou A crossed BELOW Senkou B → cloud turned red.
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=10]  — how many bars back to search for a twist
 *
 * @returns {{
 *   signal:       'bullish' | 'bearish' | null,
 *   barsAgo:      number | null,
 *   close:        number,
 *   senkouA:      number | null,
 *   senkouB:      number | null,
 *   cloudColor:   'bullish' | 'bearish' | null,   // current cloud color (post-twist)
 * } | null}
 */
function getKumoTwist(candles, { lookback = 10 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  // Current cloud color (independent of whether a recent twist exists)
  const cloudColor = last.senkouA == null || last.senkouB == null ? null
    : last.senkouA > last.senkouB ? 'bullish'
    : last.senkouA < last.senkouB ? 'bearish'
    : null;

  // Scan backwards: look for the bar where senkouA crossed senkouB.
  // offset=1 means the PREVIOUS bar was the twist bar (most recent closed candle was the cross).
  for (let offset = 1; offset <= lookback; offset++) {
    const idx  = n - 1 - offset; // candidate twist bar
    const idxP = idx - 1;        // bar just before it
    if (idxP < 0) break;

    const cur  = results[idx];
    const prev = results[idxP];
    if (cur.senkouA == null || cur.senkouB == null) continue;
    if (prev.senkouA == null || prev.senkouB == null) continue;

    const prevBullish = prev.senkouA > prev.senkouB;
    const curBullish  = cur.senkouA  > cur.senkouB;

    if (!prevBullish && curBullish) {
      // Senkou A crossed above Senkou B — bullish twist
      return { signal: 'bullish', barsAgo: offset, close: last.close, senkouA: last.senkouA, senkouB: last.senkouB, cloudColor };
    }
    if (prevBullish && !curBullish) {
      // Senkou A crossed below Senkou B — bearish twist
      return { signal: 'bearish', barsAgo: offset, close: last.close, senkouA: last.senkouA, senkouB: last.senkouB, cloudColor };
    }
  }

  // No twist found within the lookback window
  return { signal: null, barsAgo: null, close: last.close, senkouA: last.senkouA, senkouB: last.senkouB, cloudColor };
}

/**
 * Kumo Pre-Breakout — price is currently INSIDE the cloud, positioned near
 * one edge, with enough momentum to exit through the opposite edge within
 * roughly 2 candles.
 *
 * ── Concept ──────────────────────────────────────────────────────────────────
 * When price enters the cloud it is in a "decision zone".  This detector
 * catches the moment before the decision resolves:
 *
 *   BULLISH setup — price entered from below, sits near cloudBottom
 *   ┌─ cloudTop ──────────────────────────────────── exit target ─┐
 *   │                                                              │
 *   │   close ← near lower edge (posInCloud ≤ posThreshold)       │
 *   └─ cloudBottom ─────────────────────────────────── SL ────────┘
 *   The distance from close to cloudTop ≤ atrMultiple × ATR14,
 *   so the cloud can be cleared in ~2 candles of normal volatility.
 *
 *   BEARISH setup — price entered from above, sits near cloudTop
 *   ┌─ cloudTop ──────────────────────────────────── SL ──────────┐
 *   │   close ← near upper edge (posInCloud ≥ 1 − posThreshold)  │
 *   │                                                              │
 *   └─ cloudBottom ──────────────────────────────── exit target ──┘
 *
 * ── Filters ──────────────────────────────────────────────────────────────────
 *   1. inCloud must be true  (price is between cloudBottom and cloudTop)
 *   2. posInCloud ≤ posThreshold  (bullish) or ≥ 1−posThreshold  (bearish)
 *   3. Distance to exit edge ≤ atrMultiple × ATR14  (reachable in ~2 candles)
 *   4. TK direction agrees with signal  (tenkan > kijun = bullish)
 *
 * ── SL / target (patternRegistry.computeSLTarget) ───────────────────────────
 *   SL anchor = the edge the price ENTERED from:
 *     bullish → cloudBottom  (falling back below it = cloud rejected the move)
 *     bearish → cloudTop     (rising back above it  = cloud rejected the move)
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.posThreshold=0.35]   fraction of cloud width from entry edge
 * @param {number}   [opts.atrMultiple=2.5]     max candles of ATR to reach exit edge
 *
 * @returns {{
 *   signal:          'bullish' | 'bearish' | null,
 *   posInCloud:      number,          0 = at cloudBottom, 1 = at cloudTop
 *   distToExit:      number | null,   price distance to exit edge
 *   exitEdge:        number | null,   cloudTop (bullish) or cloudBottom (bearish)
 *   cloudWidth:      number,
 *   close:           number,
 *   cloudTop:        number | null,
 *   cloudBottom:     number | null,
 *   senkouA:         number | null,
 *   senkouB:         number | null,
 *   tenkan:          number | null,
 *   kijun:           number | null,
 *   atr:             number | null,
 * } | null}
 */
function getKumoPreBreakout(candles, { posThreshold = 0.35, atrMultiple = 2.5 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];
  if (!last) return null;

  // ── Must be inside the cloud ──────────────────────────────────────────────
  if (last.aboveCloud || last.belowCloud) return {
    signal: null, posInCloud: null, distToExit: null, exitEdge: null,
    cloudWidth: null, close: last.close,
    cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
    senkouA: last.senkouA, senkouB: last.senkouB,
    tenkan: last.tenkan != null ? round(last.tenkan) : null,
    kijun:  last.kijun  != null ? round(last.kijun)  : null,
    atr: null,
  };

  if (last.cloudTop == null || last.cloudBottom == null) return null;

  const cloudWidth = last.cloudTop - last.cloudBottom;
  if (cloudWidth <= 0) return null;

  // ── Position within the cloud: 0 = at cloudBottom, 1 = at cloudTop ───────
  const posInCloud = (last.close - last.cloudBottom) / cloudWidth;

  // ── ATR for "reachable in ~2 candles" filter ──────────────────────────────
  const atr = getATR(candles, 14);

  // ── TK direction ──────────────────────────────────────────────────────────
  const tkDir = last.tenkan == null || last.kijun == null ? null
    : last.tenkan > last.kijun ? 'bullish'
    : last.tenkan < last.kijun ? 'bearish'
    : null;

  // ── Signal detection ──────────────────────────────────────────────────────
  let signal      = null;
  let exitEdge    = null;
  let distToExit  = null;

  if (posInCloud <= posThreshold) {
    // Price is in the LOWER portion of the cloud — entered from below.
    // Bullish: heading toward cloudTop as the exit target.
    distToExit = last.cloudTop - last.close;
    // Reachability: distance to cloudTop must be within atrMultiple × ATR
    const reachable = atr == null || distToExit <= atrMultiple * atr;
    // TK must be bullish (or not available) to confirm upward momentum
    if (reachable && (tkDir === 'bullish' || tkDir === null)) {
      signal   = 'bullish';
      exitEdge = last.cloudTop;
    }
  } else if (posInCloud >= (1 - posThreshold)) {
    // Price is in the UPPER portion of the cloud — entered from above.
    // Bearish: heading toward cloudBottom as the exit target.
    distToExit = last.close - last.cloudBottom;
    const reachable = atr == null || distToExit <= atrMultiple * atr;
    // TK must be bearish (or not available) to confirm downward momentum
    if (reachable && (tkDir === 'bearish' || tkDir === null)) {
      signal   = 'bearish';
      exitEdge = last.cloudBottom;
    }
  }

  return {
    signal,
    posInCloud:  Math.round(posInCloud  * 1000) / 1000,  // 3 d.p. (e.g. 0.182)
    distToExit:  distToExit  != null ? round(distToExit)  : null,
    exitEdge:    exitEdge    != null ? round(exitEdge)     : null,
    cloudWidth:  round(cloudWidth),
    close:       last.close,
    cloudTop:    last.cloudTop,
    cloudBottom: last.cloudBottom,
    senkouA:     last.senkouA,
    senkouB:     last.senkouB,
    tenkan:      last.tenkan != null ? round(last.tenkan) : null,
    kijun:       last.kijun  != null ? round(last.kijun)  : null,
    atr:         atr         != null ? round(atr)         : null,
  };
}

// ── Shared helpers for cross-signal functions ─────────────────────────────────

/** Returns 'above' | 'in' | 'below' based on the result bar's cloud position. */
function _cloudPos(r) {
  if (!r) return 'in';
  if (r.aboveCloud) return 'above';
  if (r.belowCloud) return 'below';
  return 'in';
}

/**
 * Standard Ichimoku signal strength based on where the signal occurred
 * relative to the cloud.
 *   Bullish: strong above cloud, neutral in cloud, weak below cloud.
 *   Bearish: strong below cloud, neutral in cloud, weak above cloud.
 */
function _crossStrength(signal, cloudPosition) {
  if (signal === 'bullish') {
    return cloudPosition === 'above' ? 'strong'
      : cloudPosition === 'in'      ? 'neutral'
      : 'weak';
  }
  if (signal === 'bearish') {
    return cloudPosition === 'below' ? 'strong'
      : cloudPosition === 'in'      ? 'neutral'
      : 'weak';
  }
  return null;
}

// ── TK Cross ──────────────────────────────────────────────────────────────────

/**
 * Tenkan-Kijun Cross — Tenkan (9-period, green/fast) crossing Kijun (26-period, red/slow).
 * The most widely traded Ichimoku signal.
 *
 * Fires on any TK cross regardless of cloud position.
 * Strength is labelled (strong/neutral/weak) based on cloud position for context,
 * but does NOT filter out crosses inside the cloud or on the counter-trend side.
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=5]  — bars back to search for the cross
 *
 * @returns {{
 *   signal:        'bullish' | 'bearish' | null,
 *   barsAgo:       number | null,
 *   crossType:     string,
 *   strength:      'strong' | 'neutral' | 'weak' | null,
 *   cloudPosition: 'above' | 'in' | 'below',
 *   close:         number,
 *   tenkan:        number | null,
 *   kijun:         number | null,
 * }}
 */
function getTKCross(candles, { lookback = 5 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  for (let offset = 1; offset <= lookback; offset++) {
    const idx = n - 1 - offset;
    if (idx < 0) break;

    const r = results[idx];
    if (r.tkCross === null) continue;

    const crossCloudPos = _cloudPos(r);

    return {
      signal:        r.tkCross,
      barsAgo:       offset,
      crossType:     'TK Cross',
      strength:      _crossStrength(r.tkCross, crossCloudPos),
      cloudPosition: _cloudPos(last), // current price position (context)
      close:         last.close,
      tenkan:        last.tenkan,
      kijun:         last.kijun,
    };
  }

  return {
    signal: null, barsAgo: null, crossType: 'TK Cross',
    strength: null, cloudPosition: _cloudPos(last),
    close: last.close, tenkan: last.tenkan, kijun: last.kijun,
  };
}

// ── Kijun Cross ───────────────────────────────────────────────────────────────

/**
 * Kijun Cross — price (close) crosses the Kijun (base line).
 * Stronger signal than TK Cross when it occurs above/below the cloud.
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=5]
 */
function getKijunCross(candles, { lookback = 5 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  for (let offset = 1; offset <= lookback; offset++) {
    const idx  = n - 1 - offset;
    const idxP = idx - 1;
    if (idxP < 0) break;

    const r    = results[idx];
    const prev = results[idxP];
    if (r.kijun == null || prev.kijun == null) continue;

    const wasAbove = prev.close > prev.kijun;
    const isAbove  = r.close    > r.kijun;

    if (!wasAbove && isAbove) {
      const crossCloudPos = _cloudPos(r);
      return {
        signal:        'bullish',
        barsAgo:       offset,
        crossType:     'Kijun Cross',
        strength:      _crossStrength('bullish', crossCloudPos),
        cloudPosition: _cloudPos(last),
        close:         last.close,
        kijun:         last.kijun,
      };
    }
    if (wasAbove && !isAbove) {
      const crossCloudPos = _cloudPos(r);
      return {
        signal:        'bearish',
        barsAgo:       offset,
        crossType:     'Kijun Cross',
        strength:      _crossStrength('bearish', crossCloudPos),
        cloudPosition: _cloudPos(last),
        close:         last.close,
        kijun:         last.kijun,
      };
    }
  }

  return {
    signal: null, barsAgo: null, crossType: 'Kijun Cross',
    strength: null, cloudPosition: _cloudPos(last),
    close: last.close, kijun: last.kijun,
  };
}

// ── Chikou Cross ──────────────────────────────────────────────────────────────

/**
 * Chikou Cross — the lagging span (current close plotted 26 bars back) crossing
 * the historical price from 26 bars ago.
 *
 * This is the final confirmation signal in Ichimoku analysis — considered the
 * most reliable because it factors in the full 26-bar momentum shift.
 *
 * A bullish Chikou cross: close[i] > close[i-26]  AND  close[i-1] ≤ close[i-1-26]
 * A bearish Chikou cross: close[i] < close[i-26]  AND  close[i-1] ≥ close[i-1-26]
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=5]
 */
function getChikouCross(candles, { lookback = 5 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  const currentChikou     = last.close;
  const currentHistorical = n >= 27 ? candles[n - 1 - 26].close : null;

  for (let offset = 1; offset <= lookback; offset++) {
    const idx  = n - 1 - offset; // candidate cross bar
    const idxP = idx - 1;        // bar before cross

    // Need 26 bars before the candidate bar to compare historical prices
    if (idxP < 26) break;

    const chikouCur  = candles[idx].close;
    const histCur    = candles[idx - 26].close;
    const chikouPrev = candles[idxP].close;
    const histPrev   = candles[idxP - 26].close;

    const wasAbove = chikouPrev > histPrev;
    const isAbove  = chikouCur  > histCur;

    if (!wasAbove && isAbove) {
      const crossCloudPos = _cloudPos(results[idx]);
      return {
        signal:          'bullish',
        barsAgo:         offset,
        crossType:       'Chikou Cross',
        strength:        _crossStrength('bullish', crossCloudPos),
        cloudPosition:   _cloudPos(last),
        close:           last.close,
        chikouValue:     currentChikou,
        historicalClose: currentHistorical,
      };
    }
    if (wasAbove && !isAbove) {
      const crossCloudPos = _cloudPos(results[idx]);
      return {
        signal:          'bearish',
        barsAgo:         offset,
        crossType:       'Chikou Cross',
        strength:        _crossStrength('bearish', crossCloudPos),
        cloudPosition:   _cloudPos(last),
        close:           last.close,
        chikouValue:     currentChikou,
        historicalClose: currentHistorical,
      };
    }
  }

  return {
    signal: null, barsAgo: null, crossType: 'Chikou Cross',
    strength: null, cloudPosition: _cloudPos(last),
    close: last.close, chikouValue: currentChikou, historicalClose: currentHistorical,
  };
}

// ── Perfect Order ─────────────────────────────────────────────────────────────

/**
 * Perfect Order (Ideal Order) — all 5 Ichimoku components are aligned.
 *
 * Bullish Perfect Order requires all 5 conditions simultaneously at the current bar:
 *   1. close > tenkan            (price above conversion line)
 *   2. tenkan > kijun            (conversion line above base line)
 *   3. price above cloud         (aboveCloud = true)
 *   4. senkouA > senkouB         (cloud is bullish / green)
 *   5. close > close[n-27]       (chikou above historical price = momentum up)
 *
 * Bearish Perfect Order: all conditions inverted.
 *
 * Score = how many of the 5 conditions satisfy the dominant direction.
 * Signal only fires at 5/5.
 *
 * @param {Object[]} candles
 */
function getPerfectOrder(candles) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  if (last.tenkan == null || last.kijun == null) return null;

  const price26ago = n >= 27 ? candles[n - 1 - 26].close : null;

  // Evaluate each check as 'bullish' or 'bearish'
  const checks = {
    priceVsTenkan: last.close  > last.tenkan  ? 'bullish' : 'bearish',
    tenkanVsKijun: last.tenkan > last.kijun   ? 'bullish' : 'bearish',
    cloudPosition: last.aboveCloud            ? 'bullish' : last.belowCloud ? 'bearish' : 'neutral',
    cloudColor:    last.senkouA != null && last.senkouB != null
      ? (last.senkouA > last.senkouB ? 'bullish' : 'bearish')
      : 'neutral',
    chikou:        price26ago != null
      ? (last.close > price26ago ? 'bullish' : 'bearish')
      : 'neutral',
  };

  const votes     = Object.values(checks);
  const bullScore = votes.filter((v) => v === 'bullish').length;
  const bearScore = votes.filter((v) => v === 'bearish').length;
  const score     = Math.max(bullScore, bearScore);

  const signal = bullScore === 5 ? 'bullish'
    : bearScore === 5             ? 'bearish'
    : null;

  // Cloud position and strength: perfect-order bullish requires aboveCloud,
  // bearish requires belowCloud — both map to 'strong' by Ichimoku doctrine.
  const cloudPosition = last.aboveCloud ? 'above' : last.belowCloud ? 'below' : 'in';
  const strength      = signal ? 'strong' : null; // 5/5 always qualifies as strong

  return {
    signal,
    score,
    checks,
    crossType:     'Perfect Order',
    cloudPosition,
    strength,
    close:         last.close,
    tenkan:        last.tenkan,
    kijun:         last.kijun,
    senkouA:       last.senkouA,
    senkouB:       last.senkouB,
    price26ago,
  };
}

// ── Kumo Bounce ───────────────────────────────────────────────────────────────

/**
 * Kumo Bounce — price tests the cloud edge from outside and reverses.
 * The cloud acts as dynamic support (bullish) or resistance (bearish).
 *
 * Bullish Kumo Bounce:
 *   - Current bar is above the cloud
 *   - Within `lookback` bars, the candle LOW touched cloudTop (within `tolerance`)
 *   - Current close is higher than the touch bar's close (bounce confirmed)
 *
 * Bearish Kumo Bounce:
 *   - Current bar is below the cloud
 *   - Within `lookback` bars, the candle HIGH touched cloudBottom (within `tolerance`)
 *   - Current close is lower than the touch bar's close (bounce confirmed)
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=5]         — bars to search for the touch
 * @param {number}   [opts.tolerance=0.005]    — touch proximity (0.5% of cloud edge)
 */
function getKumoBounce(candles, { lookback = 5, tolerance = 0.005 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  // Price must currently be outside the cloud
  if (!last.aboveCloud && !last.belowCloud) {
    return { signal: null, barsAgo: null, close: last.close, cloudLevel: null, cloudPosition: 'in' };
  }

  const isBullish = last.aboveCloud;

  for (let offset = 1; offset <= lookback; offset++) {
    const idx = n - 1 - offset;
    if (idx < 0) break;

    const r = results[idx];
    const c = candles[idx]; // raw candle for high/low

    if (isBullish) {
      if (!r.cloudTop || !r.aboveCloud) continue;

      // Did the LOW touch cloudTop within tolerance?
      const touchDist = (c.low - r.cloudTop) / r.cloudTop;
      if (touchDist >= 0 && touchDist <= tolerance) {
        // Bounce confirmed: current close is higher than touch-bar close
        if (last.close > r.close) {
          return {
            signal:        'bullish',
            barsAgo:       offset,
            crossType:     'Kumo Bounce',
            cloudPosition: 'above',
            close:         last.close,
            cloudLevel:    round(r.cloudTop),
            tenkan:        last.tenkan != null ? round(last.tenkan) : null,
            kijun:         last.kijun  != null ? round(last.kijun)  : null,
          };
        }
      }
    } else {
      if (!r.cloudBottom || !r.belowCloud) continue;

      // Did the HIGH touch cloudBottom within tolerance?
      const touchDist = (r.cloudBottom - c.high) / r.cloudBottom;
      if (touchDist >= 0 && touchDist <= tolerance) {
        if (last.close < r.close) {
          return {
            signal:        'bearish',
            barsAgo:       offset,
            crossType:     'Kumo Bounce',
            cloudPosition: 'below',
            close:         last.close,
            cloudLevel:    round(r.cloudBottom),
            tenkan:        last.tenkan != null ? round(last.tenkan) : null,
            kijun:         last.kijun  != null ? round(last.kijun)  : null,
          };
        }
      }
    }
  }

  return {
    signal: null, barsAgo: null, crossType: 'Kumo Bounce',
    cloudPosition: isBullish ? 'above' : 'below',
    close: last.close,
    cloudLevel: isBullish ? last.cloudTop : last.cloudBottom,
  };
}

// ── Kijun Level (Support / Resistance Hit) ────────────────────────────────────

/**
 * Kijun Level — price tests the Kijun-sen (base line) as support or resistance
 * within the last `lookback` candles.
 *
 * Fires the moment a wick touches the Kijun zone — no close confirmation
 * required.  Signal direction is determined by the current price relative to
 * the Kijun: if price is above the Kijun the line is acting as support
 * (bullish); if price is below it is acting as resistance (bearish).
 *
 * Bullish (Kijun Support Hit):
 *   - Current close is ABOVE the Kijun (Kijun is below = support).
 *   - Within `lookback` bars, at least one candle's LOW came within
 *     `tolerance`% of the Kijun level at that bar (wick tested support).
 *   - That candle's CLOSE is at or above the Kijun — if it closed below,
 *     the level broke down and the signal is rejected.
 *
 * Bearish (Kijun Resistance Hit):
 *   - Current close is BELOW the Kijun (Kijun is above = resistance).
 *   - Within `lookback` bars, at least one candle's HIGH came within
 *     `tolerance`% of the Kijun level at that bar.
 *   - That candle's CLOSE is at or below the Kijun — if it closed above,
 *     resistance was broken and the signal is rejected.
 *
 * Score (1–4) — confirming factors:
 *   +1 base  — Kijun touch found within lookback bars
 *   +1       — price is on the correct side of the cloud (above for bullish)
 *   +1       — cloud colour agrees (green for bullish, red for bearish)
 *   +1       — Chikou confirms (close > price 26 bars ago for bullish)
 *
 * @param {Object[]} candles
 * @param {Object}   [opts]
 * @param {number}   [opts.lookback=3]      — bars back to search for the touch
 * @param {number}   [opts.tolerance=0.003] — wick proximity threshold (0.3%)
 */
function getKijunLevel(candles, { lookback = 3, tolerance = 0.003 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  const _nullReturn = (crossType = 'Kijun Level') => ({
    signal: null, barsAgo: null, crossType,
    strength: null, cloudPosition: _cloudPos(last), score: 0,
    close:       last.close,
    kijunValue:  last.kijun != null ? round(last.kijun) : null,
    tenkan:      last.tenkan != null ? round(last.tenkan) : null,
    kijun:       last.kijun  != null ? round(last.kijun)  : null,
    cloudTop:    last.cloudTop    != null ? round(last.cloudTop)    : null,
    cloudBottom: last.cloudBottom != null ? round(last.cloudBottom) : null,
  });

  if (last.kijun == null) return _nullReturn();

  // Signal direction: price above Kijun → support test (bullish);
  //                   price below Kijun → resistance test (bearish).
  const currentlyAbove = last.close > last.kijun;
  const currentlyBelow = last.close < last.kijun;
  if (!currentlyAbove && !currentlyBelow) return _nullReturn();

  const signal       = currentlyAbove ? 'bullish' : 'bearish';
  const cloudPosition = _cloudPos(last);

  // ── Kijun slope direction (R6) ────────────────────────────────────────────
  // Flat or rising Kijun for bullish = ideal. Falling Kijun on bullish bounce
  // means baseline is weakening — trade is fighting momentum.
  const KIJUN_SLOPE_LB = 5;
  const kijunPrevIdx   = Math.max(0, n - 1 - KIJUN_SLOPE_LB);
  const kijunPrev      = results[kijunPrevIdx].kijun;
  const kijunSlopeOk   = kijunPrev != null
    ? (signal === 'bullish' ? last.kijun >= kijunPrev : last.kijun <= kijunPrev)
    : true; // fail-open when data unavailable

  // Score: extra confirming conditions at the current bar.
  const price26ago = n >= 27 ? candles[n - 1 - 26].close : null;
  function _score() {
    let s = 1; // base — Kijun touch found
    if (signal === 'bullish') {
      if (last.aboveCloud) s++;
      if (last.senkouA != null && last.senkouB != null && last.senkouA > last.senkouB) s++;
      if (price26ago != null && last.close > price26ago) s++;
    } else {
      if (last.belowCloud) s++;
      if (last.senkouA != null && last.senkouB != null && last.senkouB > last.senkouA) s++;
      if (price26ago != null && last.close < price26ago) s++;
    }
    return s;
  }

  // Scan from current bar (offset=0) back through `lookback` bars.
  for (let offset = 0; offset <= lookback; offset++) {
    const idx = n - 1 - offset;
    if (idx < 0) break;

    const r = results[idx]; // ichimoku values at the candidate bar
    const c = candles[idx]; // raw OHLC for actual wick levels
    if (r.kijun == null) continue;

    const kijunAtBar = r.kijun;

    // Bullish: wick low came within tolerance% of Kijun (tested as support).
    // low <= kijun * (1 + tolerance) catches exact touches and slight overshoots.
    // close >= kijun — the candle must NOT have closed below the Kijun; a close
    // below means the level broke down, not held as support.
    if (signal === 'bullish' && c.low <= kijunAtBar * (1 + tolerance) && r.close >= kijunAtBar) {
      return {
        signal:        'bullish',
        barsAgo:       offset,
        crossType:     'Kijun Level',
        strength:      _crossStrength('bullish', cloudPosition),
        cloudPosition,
        kijunSlopeOk,
        score:         _score(),
        close:         last.close,
        kijunValue:    round(last.kijun),
        tenkan:        last.tenkan != null ? round(last.tenkan) : null,
        kijun:         last.kijun  != null ? round(last.kijun)  : null,
        cloudTop:      last.cloudTop    != null ? round(last.cloudTop)    : null,
        cloudBottom:   last.cloudBottom != null ? round(last.cloudBottom) : null,
        senkouA:       last.senkouA,
        senkouB:       last.senkouB,
      };
    }

    // Bearish: wick high came within tolerance% of Kijun (tested as resistance).
    // close <= kijun — the candle must NOT have closed above the Kijun; a close
    // above means resistance was broken, not held.
    if (signal === 'bearish' && c.high >= kijunAtBar * (1 - tolerance) && r.close <= kijunAtBar) {
      return {
        signal:        'bearish',
        barsAgo:       offset,
        crossType:     'Kijun Level',
        strength:      _crossStrength('bearish', cloudPosition),
        cloudPosition,
        kijunSlopeOk,
        score:         _score(),
        close:         last.close,
        kijunValue:    round(last.kijun),
        tenkan:        last.tenkan != null ? round(last.tenkan) : null,
        kijun:         last.kijun  != null ? round(last.kijun)  : null,
        cloudTop:      last.cloudTop    != null ? round(last.cloudTop)    : null,
        cloudBottom:   last.cloudBottom != null ? round(last.cloudBottom) : null,
        senkouA:       last.senkouA,
        senkouB:       last.senkouB,
      };
    }
  }

  return _nullReturn();
}

// ── Shared 4h synthesis ───────────────────────────────────────────────────────

/**
 * Synthesise 4h candles from an array of 1h candles.
 *
 * WHY THIS EXISTS HERE (and not inline in callers):
 *   The naive approach of grouping from buffer index 0 produces cross-session
 *   "4h candles" that span overnight or weekends — e.g. the last 2 bars of
 *   Tuesday grouped with the first 2 bars of Wednesday. The OHLC values are
 *   wrong and Ichimoku calculations on those candles produce garbage signals.
 *
 * FIX: group by trading session date first.
 *   Groups of up to 4 consecutive 1h bars within the SAME calendar day are
 *   combined. The end-of-day tail group (NSE bars 4-5, 13:15-15:15) is kept
 *   as its own closed candle — those are real closed bars covering the most
 *   volatile stretch of the session, not partial data.
 *
 * Indian market produces ~6 complete 1h bars per session (9:15-15:15).
 * That gives TWO 4h candles per day: bars 0-3 and the 2-bar tail (bars 4-5).
 * A 1200-bar 1h buffer (~192 days) therefore yields ~384 4h candles — well
 * above the 52 required by Ichimoku.
 *
 * @param {Array<{date: string, open: number, high: number, low: number, close: number}>} candles1h
 * @returns {Array<{date, open, high, low, close}>}
 */
function to4H(candles1h) {
  // Group bars by their date prefix (YYYY-MM-DD) — Kite returns ISO 8601 strings
  const byDay = new Map();
  for (const c of candles1h) {
    const day = String(c.date).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }

  // Track the most-recent day so we can emit a partial group for it.
  // For all earlier days a partial group at the end is dropped (historical
  // accuracy matters — but the most-recent day's intraday move should NOT
  // be invisible to the 4h scan just because the day hasn't finished yet).
  const days = [...byDay.keys()].sort(); // ISO YYYY-MM-DD sorts chronologically
  const todayKey = days[days.length - 1];

  const out = [];
  for (const day of days) {
    const dayCandles = byDay.get(day);
    const isToday    = day === todayKey;

    for (let i = 0; i < dayCandles.length; i += 4) {
      const slice = dayCandles.slice(i, i + 4);
      if (slice.length < 1) continue;

      // Historical days: every group is closed — including the 2-bar session
      // tail (13:15-15:15 on NSE). Those bars are real closed data; dropping
      // them hid 2 hours of price action from the 4h series every day.
      // Today: the last group is still forming — flag it so scanners can
      // exclude it. A group is "still forming" when it's the final group of
      // today AND the session could still add bars to it (< 4 bars so far).
      const isLastGroupOfToday = isToday && i + 4 >= dayCandles.length;

      out.push({
        date:  slice[0].date,
        open:  slice[0].open,
        high:  Math.max(...slice.map((c) => c.high)),
        low:   Math.min(...slice.map((c) => c.low)),
        close: slice[slice.length - 1].close,
        // Flag forming candles so downstream scanners can opt to exclude them
        partial: isLastGroupOfToday && slice.length < 4,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cloud Support / Cloud Resistance
 *
 * A trend-continuation confirmation: price is currently sitting cleanly
 * above (bullish) or below (bearish) the cloud, the cloud color agrees
 * with the direction, and price has held that position for at least
 * `minBars` consecutive bars.
 *
 * This is distinct from kumo-bounce (which requires a touch-and-reverse
 * event) — Cloud Support is about sustained position relative to the cloud,
 * i.e. "the cloud is acting as a floor/ceiling right now."
 *
 * Score (0–5):
 *   1 — price is above/below cloud
 *   2 — cloud color agrees with direction (green above / red below)
 *   3 — Tenkan is on the correct side of Kijun
 *   4 — Chikou confirms (above/below price from 26 bars ago)
 *   5 — Price has held above/below cloud for ≥ minBars consecutive bars
 *
 * @param {object[]} candles
 * @param {{ minBars?: number }} opts
 * @returns {{ signal, score, consecutiveBars, cloudThickness, cloudPosition,
 *             close, cloudTop, cloudBottom, tenkan, kijun }}
 */
function getCloudSupport(candles, { minBars = 3 } = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];

  // Must be cleanly outside the cloud at the current bar
  if (!last.aboveCloud && !last.belowCloud) {
    return {
      signal: null, score: 0,
      cloudPosition: 'in',
      close: last.close,
      cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
    };
  }

  const isBullish = last.aboveCloud;
  const signal = isBullish ? 'bullish' : 'bearish';

  // Count consecutive bars where price has been on the correct side of the cloud
  let consecutiveBars = 1;
  for (let i = n - 2; i >= 0; i--) {
    const r = results[i];
    if (isBullish ? r.aboveCloud : r.belowCloud) {
      consecutiveBars++;
    } else {
      break;
    }
  }

  // ── Entry trigger check ───────────────────────────────────────────────────
  // Cloud-support is a trend condition, not a standalone entry event.
  // Require a pullback toward the cloud edge in the last 3 bars to confirm
  // "something happened NOW":
  //   Bullish: at least one of the last 3 bars' low touched or dipped toward cloudTop
  //   Bearish: at least one of the last 3 bars' high reached toward cloudBottom
  // "Near" = within 0.5% of the cloud edge.
  const ENTRY_LOOKBACK = 3;
  let hasEntryTrigger = false;
  for (let k = 0; k < ENTRY_LOOKBACK && (n - 1 - k) >= 0; k++) {
    const bar = results[n - 1 - k];
    if (bar.cloudTop == null || bar.cloudBottom == null) continue;
    const nearPct = 0.005;
    if (isBullish) {
      // Low dipped near the cloud top (support test)
      if (bar.low <= bar.cloudTop * (1 + nearPct)) hasEntryTrigger = true;
    } else {
      // High reached near the cloud bottom (resistance test)
      if (bar.high >= bar.cloudBottom * (1 - nearPct)) hasEntryTrigger = true;
    }
  }

  // Cloud color should agree: green (senkouA > senkouB) for bullish, red for bearish
  const cloudColorAgrees = isBullish
    ? (last.senkouA != null && last.senkouB != null && last.senkouA > last.senkouB)
    : (last.senkouA != null && last.senkouB != null && last.senkouB > last.senkouA);

  // Tenkan vs Kijun — should agree with direction
  const tkAgrees = isBullish
    ? (last.tenkan != null && last.kijun != null && last.tenkan > last.kijun)
    : (last.tenkan != null && last.kijun != null && last.tenkan < last.kijun);

  // Chikou: close[now] vs close[now - 26]
  const chikouIdx = n - 1 - 26;
  const chikouAgrees = chikouIdx >= 0
    ? (isBullish ? last.close > results[chikouIdx].close : last.close < results[chikouIdx].close)
    : false;

  // ── Flat Senkou B detection (R1) ──────────────────────────────────────────
  // Flat Senkou B = price magnet zone. When Senkou B hasn't moved for 5+ bars,
  // the cloud edge is a strong attractor level.
  let flatSenkouB = false;
  if (n >= 6 && last.senkouB != null) {
    flatSenkouB = true;
    for (let f = n - 2; f >= n - 6 && f >= 0; f--) {
      if (results[f].senkouB == null || Math.abs(results[f].senkouB - last.senkouB) > 0.01) {
        flatSenkouB = false;
        break;
      }
    }
  }

  // Build score
  let score = 1; // price is above/below cloud (already confirmed)
  if (cloudColorAgrees) score++;
  if (tkAgrees)         score++;
  if (chikouAgrees)     score++;
  if (consecutiveBars >= minBars) score++;

  // Cloud thickness as a measure of support/resistance strength
  const cloudThickness = last.cloudTop != null && last.cloudBottom != null
    ? round(last.cloudTop - last.cloudBottom)
    : null;

  return {
    signal,
    score,
    consecutiveBars,
    cloudThickness,
    cloudPosition: isBullish ? 'above' : 'below',
    strength:      _crossStrength(signal, isBullish ? 'above' : 'below'),
    hasEntryTrigger,
    flatSenkouB,
    close:         last.close,
    cloudTop:      last.cloudTop  != null ? round(last.cloudTop)    : null,
    cloudBottom:   last.cloudBottom != null ? round(last.cloudBottom) : null,
    tenkan:        last.tenkan != null ? round(last.tenkan) : null,
    kijun:         last.kijun  != null ? round(last.kijun)  : null,
  };
}

// ── Volume context ────────────────────────────────────────────────────────────

/**
 * Compare the current candle's volume against a rolling average of the
 * previous `lookback` candles (the current bar is excluded from the average
 * so the ratio is based on confirmed closed candles only).
 *
 * Returns null when the candle data lacks volume fields or there are fewer
 * than lookback+1 bars available.
 *
 * volumeRatio > 1.0 means current volume is above average.
 * volumeRatio >= 1.2 is a meaningful confirmation (20 %+ above average).
 * volumeRatio >= 2.0 signals an unusually active candle.
 *
 * @param {Object[]} candles
 * @param {number}   [lookback=20]
 * @returns {{ currentVolume: number, avgVolume: number, volumeRatio: number } | null}
 */
/**
 * Average True Range (ATR) over `period` bars.
 * Classic Wilder TR = max(high-low, |high-prevClose|, |low-prevClose|).
 *
 * Returns the simple average over the last `period` true-range values, computed
 * on the closed history portion of the array.  Returns null when there aren't
 * enough bars to satisfy the period (need period+1 candles to form `period` TRs).
 *
 * Used by patternRegistry.computeSLTarget to widen tight SLs (e.g. when Kijun
 * sits 0.1% from price) to a minimum distance of `0.5 * ATR14`.  This avoids
 * "1-rupee stop" position-sizing pathologies and stops getting wicked out by
 * normal noise.
 */
/**
 * Wilder's Smoothed RSI (standard 14-period).
 *
 * Calculated from the same candle array already used for Ichimoku — no extra
 * API call required.  Returns the RSI of the LAST (most recent) candle.
 *
 * Algorithm:
 *   1. Compute close-to-close changes for the full candle history.
 *   2. Seed avgGain / avgLoss as simple averages over the first `period` changes.
 *   3. Apply Wilder's smoothing (EMA with alpha = 1/period) for all subsequent bars.
 *   4. RSI = 100 − (100 / (1 + avgGain/avgLoss))
 *
 * Returns null when fewer than period+1 candles are available.
 * Returns 100 when avgLoss is zero (all gains — fully overbought).
 * Returns 0   when avgGain is zero (all losses — fully oversold).
 */
function getRSI(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // ── Seed: simple average over the first `period` changes ─────────────────
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else            avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // ── Wilder's smoothing for the remaining bars ─────────────────────────────
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain   = change > 0 ? change : 0;
    const loss   = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function getATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low  - prev.close),
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}

function getVolumeContext(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) return null;

  const n = candles.length;
  let sum = 0;
  for (let i = n - 1 - lookback; i < n - 1; i++) {
    sum += candles[i].volume ?? 0;
  }

  const avgVolume     = sum / lookback;
  const currentVolume = candles[n - 1].volume ?? 0;

  // Avoid division by zero on instruments with no volume data
  if (avgVolume === 0) return null;

  return {
    currentVolume: Math.round(currentVolume),
    avgVolume:     Math.round(avgVolume),
    volumeRatio:   Math.round((currentVolume / avgVolume) * 100) / 100,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kumo Base Entry — the single unified "fat cloud base" setup.
 *
 * Three things must be true simultaneously:
 *
 *   1. FAT CLOUD — Kumo is thick (cloudWidth ≥ threshold).  A thin cloud is
 *      noise; a thick one means genuine overhead resistance / support.
 *
 *   2. BASE (prior consolidation) — In the `consLookback` bars before now,
 *      price was OUTSIDE the cloud on the correct side (belowCloud for bullish,
 *      aboveCloud for bearish) for at least `minConsBars` bars, AND those bars
 *      formed a tight range (H-L spread ≤ consRatio × ATR14).
 *      This is the "coiling below the cloud" base.
 *
 *   3. FRESH CLOUD ENTRY — The current bar is INSIDE the cloud and near the
 *      entry edge (posInCloud ≤ posThreshold for bullish, ≥ 1-posThreshold for
 *      bearish).  Within the last `entryLookback` bars at least one bar was
 *      still outside, confirming the entry is fresh (not stale mid-cloud drift).
 *
 * TK direction must agree (tenkan > kijun bullish, < kijun bearish).
 *
 * SL = consLow (bullish) or consHigh (bearish) — the far edge of the base.
 * Target = cloud far edge (cloudTop for bullish, cloudBottom for bearish),
 * then natural swing level beyond it.
 *
 * Options:
 *   consLookback    — bars to search for the consolidation base  (default 10)
 *   consRatio       — base H-L range ≤ consRatio × ATR14        (default 2.5)
 *   minConsBars     — minimum bars outside cloud in the window   (default 3)
 *   posThreshold    — max posInCloud for fresh-entry test        (default 0.4)
 *   entryLookback   — bars back to check for "recently outside"  (default 3)
 *   minCloudWidthPct — fat-cloud floor as fraction of close      (default 0.01)
 *   minCloudWidthAtr — fat-cloud floor in ATR14 multiples        (default 1.0)
 */
function getKumoBaseEntry(candles, {
  consLookback     = 10,
  consRatio        = 2.5,
  minConsBars      = 3,
  posThreshold     = 0.4,
  entryLookback    = 3,
  minCloudWidthPct = 0.01,
  minCloudWidthAtr = 1.0,
} = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];
  if (!last) return null;

  // ── 1. Current bar must be INSIDE the cloud ───────────────────────────────
  if (!last.inCloud) return null;
  if (last.cloudTop == null || last.cloudBottom == null) return null;

  const cloudWidth = last.cloudTop - last.cloudBottom;
  if (cloudWidth <= 0) return null;

  // ── Position within cloud ─────────────────────────────────────────────────
  const posInCloud = (last.close - last.cloudBottom) / cloudWidth;
  const isLowerEntry = posInCloud <= posThreshold;           // entered from below → bullish
  const isUpperEntry = posInCloud >= (1 - posThreshold);     // entered from above → bearish
  if (!isLowerEntry && !isUpperEntry) return null;           // too far from entry edge

  const signal = isLowerEntry ? 'bullish' : 'bearish';

  // ── ATR ───────────────────────────────────────────────────────────────────
  const atr = getATR(candles, 14);

  // ── 2. Fat cloud — BOTH the pct and ATR floors must be satisfied ─────────
  // A thin cloud on a low-volatility day must not qualify just because the
  // ATR floor happens to be small (and vice versa).
  const pctMin       = minCloudWidthPct * last.close;
  const atrMin       = atr != null ? minCloudWidthAtr * atr : pctMin;
  const minCloudSize = Math.max(pctMin, atrMin);
  if (cloudWidth < minCloudSize) return null;

  // ── 3a. Fresh entry — within `entryLookback` bars, at least one was outside ─
  let recentlyOutside = false;
  for (let k = 1; k <= entryLookback && n - 1 - k >= 0; k++) {
    const r = results[n - 1 - k];
    if (signal === 'bullish' && r.belowCloud) { recentlyOutside = true; break; }
    if (signal === 'bearish' && r.aboveCloud) { recentlyOutside = true; break; }
  }
  if (!recentlyOutside) return null; // price has been inside cloud too long — stale

  // ── 3b. Prior consolidation — scan the `consLookback` window before current bar ─
  const lookStart = Math.max(0, n - 1 - consLookback);
  let outsideBars = 0;
  let consHigh    = -Infinity;
  let consLow     =  Infinity;
  for (let i = lookStart; i < n - 1; i++) {  // exclude current bar
    const r        = results[i];
    const isOutside = signal === 'bullish' ? r.belowCloud : r.aboveCloud;
    if (!isOutside) continue;
    outsideBars++;
    if (r.high > consHigh) consHigh = r.high;
    if (r.low  < consLow)  consLow  = r.low;
  }

  if (outsideBars < minConsBars) return null; // not enough base bars

  const consRange     = consHigh - consLow;
  const consThreshold = atr != null ? consRatio * atr : null;
  if (consThreshold != null && consRange > consThreshold) return null; // range too wide — not consolidating

  // ── TK direction must confirm ─────────────────────────────────────────────
  const tkDir = last.tenkan == null || last.kijun == null ? null
    : last.tenkan > last.kijun ? 'bullish'
    : last.tenkan < last.kijun ? 'bearish'
    : null;
  if (tkDir !== null && tkDir !== signal) return null;

  return {
    signal,
    posInCloud:   Math.round(posInCloud * 1000) / 1000,
    cloudWidth:   round(cloudWidth),
    consRange:    round(consRange),
    consLow:      round(consLow),
    consHigh:     round(consHigh),
    outsideBars,
    close:        last.close,
    cloudTop:     last.cloudTop,
    cloudBottom:  last.cloudBottom,
    senkouA:      last.senkouA,
    senkouB:      last.senkouB,
    tenkan:       last.tenkan != null ? round(last.tenkan) : null,
    kijun:        last.kijun  != null ? round(last.kijun)  : null,
    atr:          atr         != null ? round(atr)         : null,
  };
}

/**
 * Kumo Consolidation — price is consolidating just outside a fat cloud,
 * coiling before a potential cloud-entry breakout.
 *
 * Criteria (all must pass):
 *   1. Price is OUTSIDE the cloud (belowCloud for bullish, aboveCloud for bearish).
 *   2. Price is CLOSE to the cloud edge — within max(proximityPct × close, proximityAtr × ATR14).
 *   3. Recent `consLookback` bars are TIGHT — highest-high minus lowest-low
 *      of that window ≤ consRatio × ATR14.  Tight range = coiling/consolidation.
 *   4. Cloud is FAT — cloudWidth ≥ max(minCloudWidthPct × close, minCloudWidthAtr × ATR14).
 *      A thick cloud is meaningful resistance/support; thin clouds are noise.
 *   5. TK direction must confirm the signal direction (tenkan > kijun for bullish,
 *      tenkan < kijun for bearish, or null if either line is unavailable).
 *
 * Returns:
 *   {
 *     signal:       'bullish' | 'bearish' | null,
 *     distToCloud:  distance from close to the nearest cloud edge,
 *     cloudWidth:   cloud thickness (cloudTop - cloudBottom),
 *     consRange:    high-low spread of the last consLookback bars,
 *     consLow:      lowest low of the consolidation window (SL anchor for bullish),
 *     consHigh:     highest high of the consolidation window (SL anchor for bearish),
 *     close, cloudTop, cloudBottom, tenkan, kijun, senkouA, senkouB, atr
 *   } | null
 *
 * Options:
 *   proximityPct      — max distance to cloud edge as fraction of close (default 0.03 = 3%)
 *   proximityAtr      — max distance to cloud edge in ATR14 units      (default 2.5)
 *   consLookback      — bars to inspect for consolidation range          (default 7)
 *   consRatio         — consolidation range ≤ consRatio × ATR14          (default 2.0)
 *                       Note: ATR14 is a single-bar average.  Over 7 bars a tight
 *                       consolidation realistically spans 1.5–2× ATR, so 2.0 is the
 *                       practical floor for this filter.
 *   minCloudWidthPct  — cloud must be ≥ this fraction of close           (default 0.01 = 1%)
 *   minCloudWidthAtr  — cloud must be ≥ this multiple of ATR14           (default 1.0)
 */
function getKumoConsolidation(candles, {
  proximityPct     = 0.03,
  proximityAtr     = 2.5,
  consLookback     = 7,
  consRatio        = 2.0,
  minCloudWidthPct = 0.01,
  minCloudWidthAtr = 1.0,
} = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];
  if (!last) return null;

  // ── Must be outside the cloud ─────────────────────────────────────────────
  if (!last.aboveCloud && !last.belowCloud) {
    // Inside cloud — not this pattern
    return {
      signal: null, distToCloud: 0, cloudWidth: null,
      consRange: null, consLow: null, consHigh: null,
      close: last.close,
      cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
      tenkan: last.tenkan != null ? round(last.tenkan) : null,
      kijun:  last.kijun  != null ? round(last.kijun)  : null,
      atr: null,
    };
  }

  if (last.cloudTop == null || last.cloudBottom == null) return null;

  const cloudWidth = last.cloudTop - last.cloudBottom;
  if (cloudWidth <= 0) return null;

  // ── ATR ───────────────────────────────────────────────────────────────────
  const atr = getATR(candles, 14);

  // ── Proximity to cloud edge ───────────────────────────────────────────────
  // Use the more generous of the two thresholds so the filter adapts to
  // both high-priced instruments (ATR-based) and low-volatility ones (pct-based).
  const proximityThreshold = Math.max(
    proximityPct * last.close,
    atr != null ? proximityAtr * atr : 0,
  );

  const distToCloud = last.belowCloud
    ? last.cloudBottom - last.close   // bullish: gap below cloudBottom
    : last.close - last.cloudTop;     // bearish: gap above cloudTop

  if (distToCloud > proximityThreshold) {
    // Too far from the cloud
    return {
      signal: null, distToCloud: round(distToCloud), cloudWidth: round(cloudWidth),
      consRange: null, consLow: null, consHigh: null,
      close: last.close,
      cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
      tenkan: last.tenkan != null ? round(last.tenkan) : null,
      kijun:  last.kijun  != null ? round(last.kijun)  : null,
      atr: atr != null ? round(atr) : null,
    };
  }

  // ── Fat cloud check ───────────────────────────────────────────────────────
  // BOTH the pct and ATR floors must be satisfied ("thick cloud" per the
  // pattern description). Math.max picks the stricter threshold.
  const pctMin = minCloudWidthPct * last.close;
  const atrMin = atr != null ? minCloudWidthAtr * atr : pctMin;
  const minCloudWidth = Math.max(pctMin, atrMin);

  if (cloudWidth < minCloudWidth) {
    // Thin cloud — not a meaningful barrier, skip
    return {
      signal: null, distToCloud: round(distToCloud), cloudWidth: round(cloudWidth),
      consRange: null, consLow: null, consHigh: null,
      close: last.close,
      cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
      tenkan: last.tenkan != null ? round(last.tenkan) : null,
      kijun:  last.kijun  != null ? round(last.kijun)  : null,
      atr: atr != null ? round(atr) : null,
    };
  }

  // ── Consolidation range ───────────────────────────────────────────────────
  // Look at the last consLookback candles (excluding the very latest to avoid
  // in-progress bar bias — not an issue for daily/weekly but good practice).
  const lookStart = Math.max(0, n - consLookback);
  let consHigh = -Infinity;
  let consLow  =  Infinity;
  for (let i = lookStart; i < n; i++) {
    const r = results[i];
    if (r.high > consHigh) consHigh = r.high;
    if (r.low  < consLow)  consLow  = r.low;
  }
  const consRange = consHigh - consLow;

  // Tight range = consolidation.  Compare against ATR-scaled threshold.
  const consThreshold = atr != null ? consRatio * atr : null;
  if (consThreshold != null && consRange > consThreshold) {
    // Range is too wide — not consolidating
    return {
      signal: null, distToCloud: round(distToCloud), cloudWidth: round(cloudWidth),
      consRange: round(consRange),
      consLow:   round(consLow),
      consHigh:  round(consHigh),
      close: last.close,
      cloudTop: last.cloudTop, cloudBottom: last.cloudBottom,
      tenkan: last.tenkan != null ? round(last.tenkan) : null,
      kijun:  last.kijun  != null ? round(last.kijun)  : null,
      atr: round(atr),
    };
  }

  // ── TK direction ──────────────────────────────────────────────────────────
  const tkDir = last.tenkan == null || last.kijun == null ? null
    : last.tenkan > last.kijun ? 'bullish'
    : last.tenkan < last.kijun ? 'bearish'
    : null;

  // ── Signal ────────────────────────────────────────────────────────────────
  let signal = null;
  if (last.belowCloud && (tkDir === 'bullish' || tkDir === null)) {
    signal = 'bullish';
  } else if (last.aboveCloud && (tkDir === 'bearish' || tkDir === null)) {
    signal = 'bearish';
  }

  return {
    signal,
    distToCloud:  round(distToCloud),
    cloudWidth:   round(cloudWidth),
    consRange:    round(consRange),
    consLow:      round(consLow),
    consHigh:     round(consHigh),
    close:        last.close,
    cloudTop:     last.cloudTop,
    cloudBottom:  last.cloudBottom,
    senkouA:      last.senkouA,
    senkouB:      last.senkouB,
    tenkan:       last.tenkan != null ? round(last.tenkan) : null,
    kijun:        last.kijun  != null ? round(last.kijun)  : null,
    atr:          atr         != null ? round(atr)         : null,
  };
}

/**
 * Kumo Inside Consolidation — price is INSIDE a thick cloud and consolidating.
 *
 * This is a pre-breakout setup: price has entered the cloud and is coiling
 * in a tight range, building energy for a breakout in either direction.
 *
 * Setup criteria:
 *   1. Price must be INSIDE the cloud (inCloud = true)
 *   2. Cloud must be thick (minCloudWidthPct AND minCloudWidthAtr)
 *   3. Price range over lookback bars must be tight (< consRatio × ATR)
 *   4. TK alignment determines bias (bullish = T>K, bearish = K>T)
 *
 * Signal:
 *   - Bullish: TK aligned bullish → expecting upside breakout
 *   - Bearish: TK aligned bearish → expecting downside breakout
 *
 * Trade setup:
 *   - Entry: Current close (inside cloud)
 *   - SL: Opposite cloud edge (if bullish, SL at cloudBottom)
 *   - Target: Opposite cloud edge breakout target (swing high/low beyond cloud)
 */
function getKumoInsideConsolidation(candles, {
  consLookback     = 10,
  consRatio        = 2.0,
  minCloudWidthPct = 0.01,
  minCloudWidthAtr = 1.5,
} = {}) {
  if (!candles || candles.length < 52) return null;

  const results = calculate(candles);
  const n    = results.length;
  const last = results[n - 1];
  if (!last) return null;

  const base = {
    close:       last.close,
    cloudTop:    last.cloudTop,
    cloudBottom: last.cloudBottom,
    senkouA:     last.senkouA,
    senkouB:     last.senkouB,
    tenkan:      last.tenkan != null ? round(last.tenkan) : null,
    kijun:       last.kijun  != null ? round(last.kijun)  : null,
  };

  // Must be INSIDE the cloud
  if (!last.inCloud) {
    return { signal: null, reason: 'not_in_cloud', ...base, atr: null, cloudWidth: null, consRange: null };
  }

  if (last.cloudTop == null || last.cloudBottom == null) return null;

  const cloudWidth = Math.abs(last.cloudTop - last.cloudBottom);
  if (cloudWidth <= 0) return null;

  const atr = getATR(candles, 14);

  // Thick cloud check — BOTH must pass (strict)
  const pctMin = minCloudWidthPct * last.close;
  if (cloudWidth < pctMin) {
    return { signal: null, reason: 'cloud_too_thin_pct', ...base, atr: atr != null ? round(atr) : null, cloudWidth: round(cloudWidth), consRange: null };
  }
  if (atr != null) {
    const atrMin = minCloudWidthAtr * atr;
    if (cloudWidth < atrMin) {
      return { signal: null, reason: 'cloud_too_thin_atr', ...base, atr: round(atr), cloudWidth: round(cloudWidth), consRange: null };
    }
  }

  // Consolidation range — price must be coiling tight
  const lookStart = Math.max(0, n - consLookback);
  let consHigh = -Infinity;
  let consLow  =  Infinity;
  for (let i = lookStart; i < n; i++) {
    const r = results[i];
    if (r.high > consHigh) consHigh = r.high;
    if (r.low  < consLow)  consLow  = r.low;
  }
  const consRange = consHigh - consLow;

  // Tight range = consolidation. Compare against ATR-scaled threshold.
  const consThreshold = atr != null ? consRatio * atr : null;
  if (consThreshold != null && consRange > consThreshold) {
    return {
      signal: null, reason: 'range_too_wide',
      ...base,
      atr: round(atr),
      cloudWidth: round(cloudWidth),
      consRange: round(consRange),
      consHigh: round(consHigh),
      consLow: round(consLow),
    };
  }

  // TK direction determines bias
  const tkDir = last.tenkan == null || last.kijun == null ? null
    : last.tenkan > last.kijun ? 'bullish'
    : last.tenkan < last.kijun ? 'bearish'
    : null;

  // If TK is flat/neutral, check if price is closer to one edge
  let signal = tkDir;
  if (signal == null && last.close != null) {
    const midCloud = (last.cloudTop + last.cloudBottom) / 2;
    signal = last.close > midCloud ? 'bullish' : 'bearish';
  }

  return {
    signal,
    reason: 'matched',
    ...base,
    atr: atr != null ? round(atr) : null,
    cloudWidth: round(cloudWidth),
    consRange: round(consRange),
    consHigh: round(consHigh),
    consLow: round(consLow),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Determine the colour of the FUTURE Ichimoku cloud — the cloud currently
 * being projected 26 bars ahead of the last candle.
 *
 * In standard Ichimoku charting the cloud you see at the current price was
 * calculated 26 bars ago.  The cloud plotted AHEAD of price is determined by
 * the Senkou Span values computed from the CURRENT (most-recent) candle:
 *
 *   Future Senkou A = (Tenkan₀ + Kijun₀) / 2   (9-bar and 26-bar midpoints)
 *   Future Senkou B = (52-bar high + 52-bar low) / 2
 *
 * Bullish future cloud  →  Span A > Span B  (green cloud ahead — uptrend bias)
 * Bearish future cloud  →  Span A < Span B  (red cloud ahead  — downtrend bias)
 *
 * @param {Array} candles  Raw OHLCV array, at least 52 bars required.
 * @returns {'bullish' | 'bearish' | 'neutral' | null}
 */
function getFutureCloudColor(candles) {
  if (!candles || candles.length < 52) return null;
  const n = candles.length;

  // Tenkan-sen — 9-period midpoint of the most recent 9 candles
  const tenkanH = highest(candles, 9,  n - 1);
  const tenkanL = lowest(candles,  9,  n - 1);
  if (tenkanH == null || tenkanL == null) return null;
  const tenkan = (tenkanH + tenkanL) / 2;

  // Kijun-sen — 26-period midpoint of the most recent 26 candles
  const kijunH = highest(candles, 26, n - 1);
  const kijunL = lowest(candles,  26, n - 1);
  if (kijunH == null || kijunL == null) return null;
  const kijun = (kijunH + kijunL) / 2;

  // Future Senkou Span A — plotted 26 bars ahead
  const futureSenkouA = (tenkan + kijun) / 2;

  // Future Senkou Span B — 52-period midpoint, plotted 26 bars ahead
  const senkou52H = highest(candles, 52, n - 1);
  const senkou52L = lowest(candles,  52, n - 1);
  if (senkou52H == null || senkou52L == null) return null;
  const futureSenkouB = (senkou52H + senkou52L) / 2;

  if (futureSenkouA > futureSenkouB) return 'bullish';
  if (futureSenkouA < futureSenkouB) return 'bearish';
  return 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Exit (Kumo Exit) — Trend Reversal Cloud Crossover
// ─────────────────────────────────────────────────────────────────────────────
//
// Detects the FIRST TIME price appears on the opposite side of the cloud
// after a long run on one side.
//
//   Bearish: price was ABOVE cloud for many bars → now below cloud (first time)
//   Bullish: price was BELOW cloud for many bars → now above cloud (first time)
//
// This is a trend reversal signal — the cloud acted as support/resistance for
// a long time and price has finally crossed through to the other side.
//
// How it works:
//   1. Current bar: price is below cloud (bearish signal) or above cloud (bullish)
//   2. Scan backward to find how recently price was on the OPPOSITE side
//   3. Count how many bars it was on the opposite side (the "long run")
//   4. If the opposite-side run was long enough → match

function getCloudExit(candles, opts = {}) {
  if (!candles || candles.length < 78) return null;

  const ichi = calculate(candles);
  const n    = ichi.length;

  const lookback     = opts.lookback     ?? 5;   // current bar must be outside cloud within last N bars
  const minRunBars   = opts.minRunBars   ?? 5;   // minimum bars on the opposite side before crossover
  const scanBars     = opts.scanBars     ?? 40;  // how far back to scan for the opposite-side run

  // ── Step 1: Find a recent bar that is outside the cloud ───────────────────
  let exitIdx = -1;
  let signal  = null;

  for (let i = n - 1; i >= Math.max(0, n - lookback); i--) {
    const bar = ichi[i];
    if (!bar || bar.cloudTop == null || bar.cloudBottom == null) continue;

    if (bar.belowCloud) {
      exitIdx = i;
      signal  = 'bearish';
      break;
    }
    if (bar.aboveCloud) {
      exitIdx = i;
      signal  = 'bullish';
      break;
    }
  }

  if (exitIdx < 0 || !signal) return { matched: false, signal: null };

  // ── Step 2: Scan backward — find the opposite-side run ────────────────────
  // Walk back from exitIdx to find bars that were on the OPPOSITE side.
  // Allow cloud-inside bars as "transition" — they don't break the pattern.
  //
  // We want: [ABOVE ABOVE ABOVE ... INSIDE INSIDE ... BELOW(current)]  → bearish
  //          ^^^^^^^^^^^^^^^^^^^^^^ this is the "opposite run" for bearish

  let transitionBars = 0;  // bars inside the cloud (the crossing period)
  let oppositeBars   = 0;  // bars on the opposite side (the long run)
  let phase          = 'transition';  // start looking for transition, then opposite

  const scanStart = Math.max(0, exitIdx - scanBars);

  for (let i = exitIdx - 1; i >= scanStart; i--) {
    const bar = ichi[i];
    if (!bar || bar.cloudTop == null) continue;

    if (phase === 'transition') {
      // In transition: bars inside cloud or already on opposite side
      if (bar.inCloud) {
        transitionBars++;
        continue;
      }
      // Check if this bar was on the OPPOSITE side (the long run we're looking for)
      const wasOpposite = (signal === 'bearish' && bar.aboveCloud) ||
                          (signal === 'bullish' && bar.belowCloud);
      if (wasOpposite) {
        oppositeBars++;
        phase = 'opposite';  // now count the run
        continue;
      }
      // Bar is on the SAME side as current → not a crossover, just continuation
      break;
    }

    if (phase === 'opposite') {
      const stillOpposite = (signal === 'bearish' && bar.aboveCloud) ||
                            (signal === 'bullish' && bar.belowCloud);
      // Allow cloud-inside bars mixed in (price can dip into cloud and come back)
      if (stillOpposite || bar.inCloud) {
        oppositeBars++;
      } else {
        break;  // hit same side or no data — end of the run
      }
    }
  }

  // ── Step 3: Was the opposite-side run long enough? ────────────────────────
  if (oppositeBars < minRunBars) return { matched: false, signal: null };

  const exitBar = ichi[exitIdx];
  const close   = exitBar.close;
  const tenkan  = exitBar.tenkan;
  const kijun   = exitBar.kijun;

  // ── Score (0–5) ───────────────────────────────────────────────────────────
  let score = 1;  // base: crossover detected

  // +1 TK alignment agrees with new direction
  if (tenkan != null && kijun != null) {
    if (signal === 'bearish' && tenkan < kijun)  score++;
    if (signal === 'bullish' && tenkan > kijun)  score++;
  }

  // +1 Strong candle body on exit bar
  const bodySize  = Math.abs(exitBar.close - exitBar.open);
  const rangeSize = exitBar.high - exitBar.low;
  const bodyRatio = rangeSize > 0 ? bodySize / rangeSize : 0;
  if (signal === 'bearish' && exitBar.close < exitBar.open && bodyRatio > 0.4) score++;
  if (signal === 'bullish' && exitBar.close > exitBar.open && bodyRatio > 0.4) score++;

  // +1 Future cloud agrees with exit direction
  const futureCloudColor = getFutureCloudColor(candles);
  if ((signal === 'bearish' && futureCloudColor === 'bearish') ||
      (signal === 'bullish' && futureCloudColor === 'bullish')) score++;

  // +1 Long opposite-side run (10+ bars = strong trend was in place)
  if (oppositeBars >= 10) score++;

  // +1 Chikou span confirms
  if (exitBar.chikou != null && exitIdx >= 26) {
    const pastBar = ichi[exitIdx - 26];
    if (pastBar) {
      if (signal === 'bearish' && exitBar.chikou < pastBar.close) score++;
      if (signal === 'bullish' && exitBar.chikou > pastBar.close) score++;
    }
  }

  score = Math.min(score, 5);

  const exitEdge = signal === 'bearish' ? exitBar.cloudBottom : exitBar.cloudTop;
  const strength = score >= 4 ? 'strong' : score >= 3 ? 'neutral' : 'weak';

  return {
    matched:           true,
    signal,
    score,
    close,
    strength,
    tenkan:            tenkan ?? null,
    kijun:             kijun  ?? null,
    senkouA:           exitBar.senkouA,
    senkouB:           exitBar.senkouB,
    cloudTop:          exitBar.cloudTop,
    cloudBottom:       exitBar.cloudBottom,
    cloudPosition:     signal === 'bearish' ? 'below' : 'above',
    oppositeBars,
    transitionBars,
    exitEdge,
    futureCloudColor,
    barsAgo:           n - 1 - exitIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kijun Retest — pullback to Kijun after a cloud crossover
// ─────────────────────────────────────────────────────────────────────────────
//
// After price crosses through the cloud to the other side (kumo crossover),
// it often pulls back to retest the Kijun-sen (26-period baseline).
//
//   Bearish: price is below cloud, pulls back UP to touch Kijun → Kijun = resistance
//   Bullish: price is above cloud, pulls back DOWN to touch Kijun → Kijun = support
//
// The wick must touch/cross the Kijun but the close stays on the trend side.
// This confirms the Kijun is holding as the new support/resistance after the crossover.
//
// Conditions:
//   1. Price is currently on one side of the cloud (above/below)
//   2. Price was on the OPPOSITE side within the last N bars (recent crossover)
//   3. Recent bar's wick touched or crossed the Kijun
//   4. Close stays on the correct side of Kijun (didn't break through)

function getKijunRetest(candles, opts = {}) {
  if (!candles || candles.length < 78) return null;

  const ichi = calculate(candles);
  const n    = ichi.length;

  const lookback       = opts.lookback       ?? 3;    // bars to check for the retest candle
  const crossoverScan  = opts.crossoverScan  ?? 20;   // how far back to look for the crossover
  const tolerance      = opts.tolerance      ?? 0.003; // 0.3% tolerance for "touching" kijun

  // ── Step 1: Find the retest candle within last `lookback` bars ────────────
  let retestIdx = -1;
  let signal    = null;

  for (let i = n - 1; i >= Math.max(0, n - lookback); i--) {
    const bar = ichi[i];
    if (!bar || bar.kijun == null || bar.cloudTop == null) continue;

    const kijun    = bar.kijun;
    const tol      = kijun * tolerance;

    // Bearish retest: price is below cloud, wick reached up to Kijun, close stayed below Kijun
    if (bar.belowCloud || bar.inCloud) {
      const wickTouchedKijun = bar.high >= kijun - tol;
      const closeBelow       = bar.close < kijun;
      if (wickTouchedKijun && closeBelow) {
        retestIdx = i;
        signal    = 'bearish';
        break;
      }
    }

    // Bullish retest: price is above cloud, wick reached down to Kijun, close stayed above Kijun
    if (bar.aboveCloud || bar.inCloud) {
      const wickTouchedKijun = bar.low <= kijun + tol;
      const closeAbove       = bar.close > kijun;
      if (wickTouchedKijun && closeAbove) {
        retestIdx = i;
        signal    = 'bullish';
        break;
      }
    }
  }

  if (retestIdx < 0 || !signal) return { matched: false, signal: null };

  // ── Step 2: Verify a recent crossover happened ────────────────────────────
  // Scan backward from the retest bar to confirm price was on the OPPOSITE
  // side of the cloud recently — proving this is a post-crossover retest,
  // not just a random Kijun touch in a ranging market.
  let hadOpposite = false;
  const scanStart = Math.max(0, retestIdx - crossoverScan);

  for (let i = retestIdx - 1; i >= scanStart; i--) {
    const bar = ichi[i];
    if (!bar || bar.cloudTop == null) continue;

    if (signal === 'bearish' && bar.aboveCloud) { hadOpposite = true; break; }
    if (signal === 'bullish' && bar.belowCloud) { hadOpposite = true; break; }
  }

  if (!hadOpposite) return { matched: false, signal: null };

  const retestBar = ichi[retestIdx];
  const close     = retestBar.close;
  const tenkan    = retestBar.tenkan;
  const kijun     = retestBar.kijun;

  // ── Score (0–5) ───────────────────────────────────────────────────────────
  let score = 1;  // base: retest detected after crossover

  // +1 TK alignment agrees with signal
  if (tenkan != null && kijun != null) {
    if (signal === 'bearish' && tenkan < kijun) score++;
    if (signal === 'bullish' && tenkan > kijun) score++;
  }

  // +1 Close is well away from Kijun (strong rejection, not just sitting on it)
  const distFromKijun = Math.abs(close - kijun);
  const distPct       = close > 0 ? distFromKijun / close : 0;
  if (distPct > 0.003) score++;  // close is >0.3% away from Kijun

  // +1 Future cloud agrees
  const futureCloudColor = getFutureCloudColor(candles);
  if ((signal === 'bearish' && futureCloudColor === 'bearish') ||
      (signal === 'bullish' && futureCloudColor === 'bullish')) score++;

  // +1 Rejection candle — wick shows the retest, body closes away
  //   Bearish: upper wick is long (reached to Kijun), body is in lower half
  //   Bullish: lower wick is long (dipped to Kijun), body is in upper half
  const bodyTop = Math.max(retestBar.open, retestBar.close);
  const bodyBot = Math.min(retestBar.open, retestBar.close);
  const range   = retestBar.high - retestBar.low;
  if (range > 0) {
    if (signal === 'bearish') {
      const upperWick = retestBar.high - bodyTop;
      if (upperWick / range > 0.3) score++;  // long upper wick = rejection
    }
    if (signal === 'bullish') {
      const lowerWick = bodyBot - retestBar.low;
      if (lowerWick / range > 0.3) score++;  // long lower wick = rejection
    }
  }

  // +1 Price is below cloud (bearish) or above cloud (bullish) — clean position
  if (signal === 'bearish' && retestBar.belowCloud) score++;
  if (signal === 'bullish' && retestBar.aboveCloud) score++;

  score = Math.min(score, 5);

  const strength = score >= 4 ? 'strong' : score >= 3 ? 'neutral' : 'weak';

  return {
    matched:           true,
    signal,
    score,
    close,
    strength,
    tenkan:            tenkan ?? null,
    kijun,
    kijunValue:        kijun,
    senkouA:           retestBar.senkouA,
    senkouB:           retestBar.senkouB,
    cloudTop:          retestBar.cloudTop,
    cloudBottom:       retestBar.cloudBottom,
    cloudPosition:     retestBar.aboveCloud ? 'above' : retestBar.belowCloud ? 'below' : 'inside',
    futureCloudColor,
    barsAgo:           n - 1 - retestIdx,
  };
}

// ─── TK Reversion (Mean Reversion to Kijun) ─────────────────────────────────
//
// After a fast move in one direction, the Tenkan–Kijun spread widens.
// Price then slows down and crosses the Tenkan in the direction of the Kijun.
// This signals a mean-reversion move toward Kijun or the cloud edge.
//
// Bearish signal (after bullish rally):
//   • Tenkan well above Kijun (spread > minSpreadPct)
//   • Previous bar closed above Tenkan, current bar closes below Tenkan
//   • Target = Kijun (price reverting down)
//
// Bullish signal (after bearish dump):
//   • Kijun well above Tenkan (spread > minSpreadPct)
//   • Previous bar closed below Tenkan, current bar closes above Tenkan
//   • Target = Kijun (price reverting up)
//
// Returns null when conditions are not met.

/**
 * @param {object[]} candles
 * @param {object}   opts
 * @param {number}   opts.minSpreadPct   — minimum |tenkan − kijun| / close × 100 to qualify (default 0.5%)
 * @param {number}   opts.lookback       — how many recent bars to check for the Tenkan cross (default 3)
 * @param {number}   opts.spreadLookback — bars to look back for peak spread to confirm it was widening (default 10)
 * @returns {object|null}
 */
function getTKReversion(candles, opts = {}) {
  // minSpreadPct: Minimum gap between Tenkan and Kijun as % of current price.
  // Default 5% — requires significant TK divergence before reversion triggers.
  // Example: If price is ₹100, TK gap must be at least ₹5 (5%).
  const minSpreadPct   = opts.minSpreadPct   ?? 5.0;
  const lookback       = opts.lookback       ?? 3;
  const spreadLookback = opts.spreadLookback ?? 10;

  if (!candles || candles.length < 78) return null;

  const results = calculate(candles);
  const n       = results.length;

  // ── New TK Reversion Logic ───────────────────────────────────────────────────
  // Setup: Latest candle closes inside Tenkan-Kijun gap
  // Confirmation: Within next 2 candles, find a wick rejection:
  //   - Bullish: Low wicks below Tenkan, close stays above Tenkan
  //   - Bearish: High wicks above Tenkan, close stays below Tenkan
  // Entry: Tenkan line value
  // SL: Below wick low (bullish) / Above wick high (bearish)
  // Target: Kijun (current logic)

  // Start from latest candle
  const latest = results[n - 1];
  if (!latest || latest.tenkan == null || latest.kijun == null) return null;

  const close    = latest.close;
  const tenkan   = latest.tenkan;
  const kijun    = latest.kijun;
  const tkSpread = Math.abs(tenkan - kijun);
  const spreadPct = (tkSpread / close) * 100;

  // Must have wide enough TK spread (minimum 5% of current price)
  if (spreadPct < minSpreadPct) return null;

  const tkHigh = Math.max(tenkan, kijun);
  const tkLow  = Math.min(tenkan, kijun);
  const insideGap = close > tkLow && close < tkHigh;

  // Latest candle must close inside TK gap
  if (!insideGap) return null;

  let signal = null;
  let wickCandleIdx = null;
  let wickLow = null;
  let wickHigh = null;

  // ── Bullish Setup: Kijun > Tenkan (price was below, reverting up) ────────
  // Look for wick rejection in next 2 candles (current + 1 past)
  if (kijun > tenkan) {
    // Check current candle (n-1) and previous candle (n-2)
    for (let i = 0; i < 2 && n - 1 - i >= 0; i++) {
      const idx = n - 1 - i;
      const c = results[idx];
      if (!c || c.tenkan == null) continue;

      // Wick rejection: low below Tenkan, close above Tenkan
      if (c.low < c.tenkan && c.close > c.tenkan) {
        signal = 'bullish';
        wickCandleIdx = idx;
        wickLow = c.low;
        break;
      }
    }
  }

  // ── Bearish Setup: Tenkan > Kijun (price was above, reverting down) ──────
  // Look for wick rejection in next 2 candles (current + 1 past)
  if (tenkan > kijun) {
    // Check current candle (n-1) and previous candle (n-2)
    for (let i = 0; i < 2 && n - 1 - i >= 0; i++) {
      const idx = n - 1 - i;
      const c = results[idx];
      if (!c || c.tenkan == null) continue;

      // Wick rejection: high above Tenkan, close below Tenkan
      if (c.high > c.tenkan && c.close < c.tenkan) {
        signal = 'bearish';
        wickCandleIdx = idx;
        wickHigh = c.high;
        break;
      }
    }
  }

  if (!signal || wickCandleIdx == null) return null;

  // ── Verify the spread was genuinely widening (not just flat-wide) ────────
  // Check that the current spread is near peak over the spreadLookback window.
  let peakSpreadPct = 0;
  const spreadStart = Math.max(0, n - 1 - spreadLookback);
  for (let j = spreadStart; j <= n - 1; j++) {
    const r = results[j];
    if (r.tenkan != null && r.kijun != null && r.close > 0) {
      const sp = (Math.abs(r.tenkan - r.kijun) / r.close) * 100;
      if (sp > peakSpreadPct) peakSpreadPct = sp;
    }
  }
  // Current spread must be at least 60% of peak — confirms it's still wide
  if (peakSpreadPct > 0 && spreadPct < peakSpreadPct * 0.6) return null;

  // ── Score (0–5) ──────────────────────────────────────────────────────
  const wickCandle = results[wickCandleIdx];
  let score = 3; // base: wide spread + wick rejection confirmed

  // Wider spread = stronger reversion potential
  if (spreadPct >= minSpreadPct * 2)  score++;
  if (spreadPct >= minSpreadPct * 3)  score++;

  // Wick size: larger rejection wick = stronger signal
  const wickSize = signal === 'bullish'
    ? Math.abs(wickCandle.tenkan - wickLow)
    : Math.abs(wickHigh - wickCandle.tenkan);
  const wickSizePct = (wickSize / wickCandle.close) * 100;
  if (wickSizePct >= 0.5) score++; // meaningful wick (≥0.5%)

  // Cloud agreement: reversion toward cloud adds conviction
  if (signal === 'bearish' && latest.aboveCloud) score = Math.min(score + 1, 5); // above cloud, room to fall
  if (signal === 'bullish' && latest.belowCloud) score = Math.min(score + 1, 5); // below cloud, room to rise

  score = Math.min(score, 5);
  const strength = score >= 4 ? 'strong' : score >= 3 ? 'neutral' : 'weak';

  // ── Future cloud color ───────────────────────────────────────────────
  const futureCloudColor = getFutureCloudColor(candles);

  // Entry price = Tenkan (not the candle close)
  const entryPrice = tenkan;

  // SL = below wick low (bullish) / above wick high (bearish)
  const slPrice = signal === 'bullish' ? wickLow : wickHigh;

  return {
    matched: true,
    signal,
    score,
    close: entryPrice,          // Entry at Tenkan line
    strength,
    tenkan,
    kijun,
    kijunValue:       kijun,
    senkouA:          latest.senkouA,
    senkouB:          latest.senkouB,
    cloudTop:         latest.cloudTop,
    cloudBottom:      latest.cloudBottom,
    cloudPosition:    latest.aboveCloud ? 'above' : latest.belowCloud ? 'below' : 'inside',
    futureCloudColor,
    tkSpreadPct:      +spreadPct.toFixed(2),
    wickLow:          wickLow,          // Store wick extremes for reference
    wickHigh:         wickHigh,
    wickCandleIdx:    wickCandleIdx,
    slPrice:          slPrice,          // SL at wick extreme
    barsAgo:          0,                // Always current bar now
  };
}

// ── Senkou Span Cross Confirmation ────────────────────────────────────────────

/**
 * Senkou Span Cross — the cloud color changes (Senkou A crosses Senkou B)
 * within the last `lookback` bars WHILE price was ALREADY outside the cloud
 * on the SAME side as the twist, and has not re-entered the cloud since.
 *
 * ── Why this is high-conviction ───────────────────────────────────────────────
 * Three simultaneous Ichimoku confirmations:
 *   1. CURRENT cloud:  price is above (bullish) / below (bearish) the cloud
 *   2. FUTURE cloud:   just turned to agree with the trade direction
 *                      (Senkou A/B cross = cloud 26 bars ahead now aligned)
 *   3. MOMENTUM:       TK aligned + Kijun slope in signal direction
 *
 * Unlike kumo-breakout (price just crossed the cloud) or kumo-bounce (price
 * tested the cloud edge), this fires when the CLOUD ITSELF catches up to
 * confirm a move that price has already committed to.  Japanese institutional
 * Ichimoku traders watch this as the highest structural confirmation signal.
 *
 * ── Conditions ────────────────────────────────────────────────────────────────
 *   1. Senkou A/B cross occurred within last `lookback` bars (default 5)
 *   2. Twist direction matches signal (bullish: A > B after being A < B)
 *   3. Price is OUTSIDE the cloud on the SAME side at the current bar
 *   4. Price has NOT re-entered the cloud at any bar since the twist
 *   5. Cloud width ≥ minCloudWidthPct × close (filters noisy thin-cloud twists)
 *
 * ── Score (0–5) ───────────────────────────────────────────────────────────────
 *   +1  twist found + price on correct side  (base)
 *   +1  cloud width ≥ 0.5% of close  (meaningful structural barrier)
 *   +1  TK aligned (Tenkan > Kijun for bullish, vice versa for bearish)
 *   +1  Kijun sloping in signal direction over last 5 bars
 *   +1  price on correct side of Kijun
 *
 * @param {object[]} candles
 * @param {object}   [opts]
 * @param {number}   [opts.lookback=5]            — max bars back to find the twist
 * @param {number}   [opts.minCloudWidthPct=0.003] — min cloud width as fraction of close
 * @returns {object|null}
 */
function getSenkouCross(candles, { lookback = 5, minCloudWidthPct = 0.003 } = {}) {
  // Need at least 78 bars so senkouB is valid at the last position
  // (senkouB at index n−1 requires bar n−1−26 = n−27 to have i ≥ 51)
  if (!candles || candles.length < 78) return null;

  const series = calculate(candles);
  const n      = series.length;
  const last   = series[n - 1];

  if (!last) return null;

  // Build the null-result shape used when the pattern doesn't fire
  const _miss = (extra = {}) => ({
    signal:       null,
    twistBarsAgo: null,
    close:        last.close,
    cloudTop:     last.cloudTop    ?? null,
    cloudBottom:  last.cloudBottom ?? null,
    senkouA:      last.senkouA     ?? null,
    senkouB:      last.senkouB     ?? null,
    tenkan:       last.tenkan      ?? null,
    kijun:        last.kijun       ?? null,
    ...extra,
  });

  if (last.senkouA == null || last.senkouB == null) return _miss();
  if (last.cloudTop == null || last.cloudBottom == null) return _miss();

  // ── 1. Find most recent Senkou A/B cross within lookback ──────────────────
  let twistBarsAgo = null;
  let twistSignal  = null;

  for (let offset = 1; offset <= lookback; offset++) {
    const idx  = n - 1 - offset;
    const idxP = idx - 1;
    if (idxP < 0) break;

    const cur  = series[idx];
    const prev = series[idxP];
    if (!cur || !prev) continue;
    if (cur.senkouA  == null || cur.senkouB  == null) continue;
    if (prev.senkouA == null || prev.senkouB == null) continue;

    const prevBullish = prev.senkouA > prev.senkouB;
    const curBullish  = cur.senkouA  > cur.senkouB;

    if (!prevBullish && curBullish)  { twistSignal = 'bullish'; twistBarsAgo = offset; break; }
    if (prevBullish  && !curBullish) { twistSignal = 'bearish'; twistBarsAgo = offset; break; }
  }

  if (!twistSignal) return _miss();

  // ── 2. Price must be OUTSIDE the cloud on the SAME side as the twist ──────
  const priceOnTwistSide = twistSignal === 'bullish' ? last.aboveCloud : last.belowCloud;
  if (!priceOnTwistSide) return _miss({ twistBarsAgo });

  // ── 3. Price must NOT have re-entered the cloud since the twist ────────────
  // If price dipped into the cloud after the twist the setup is structurally
  // broken — the cloud no longer acts as clean support/resistance.
  for (let offset = 0; offset < twistBarsAgo; offset++) {
    const checkIdx = n - 1 - offset;
    if (checkIdx < 0) break;
    const bar = series[checkIdx];
    if (bar && bar.inCloud) return _miss({ twistBarsAgo }); // cloud re-entry = invalidated
  }

  // ── 4. Cloud width filter ─────────────────────────────────────────────────
  const cloudWidth    = last.cloudTop - last.cloudBottom;
  const cloudWidthPct = last.close > 0 ? cloudWidth / last.close : 0;
  if (cloudWidthPct < minCloudWidthPct) return _miss({ twistBarsAgo });

  // ── 5. Score ──────────────────────────────────────────────────────────────
  let score = 1; // base: twist found + price on correct side

  // +1 fat cloud (≥ 0.5% of close)
  if (cloudWidthPct >= 0.005) score++;

  // +1 TK aligned in signal direction
  const tkAligned = last.tenkan != null && last.kijun != null && (
    twistSignal === 'bullish' ? last.tenkan > last.kijun : last.tenkan < last.kijun
  );
  if (tkAligned) score++;

  // +1 Kijun sloping in signal direction over last 5 bars
  const KIJUN_LB  = 5;
  const kijunPrev = series[Math.max(0, n - 1 - KIJUN_LB)]?.kijun ?? null;
  const kijunNow  = last.kijun;
  let   kijunSloping = false;
  if (kijunPrev != null && kijunNow != null) {
    kijunSloping = twistSignal === 'bullish'
      ? kijunNow > kijunPrev
      : kijunNow < kijunPrev;
    if (kijunSloping) score++;
  }

  // +1 price on correct side of Kijun
  let priceVsKijun = null;
  if (last.kijun != null) {
    priceVsKijun = last.close > last.kijun ? 'above' : 'below';
    const kijunCorrect = priceVsKijun === (twistSignal === 'bullish' ? 'above' : 'below');
    if (kijunCorrect) score++;
  }

  // ── 6. Cloud position label for downstream use ───────────────────────────
  const cloudPosition = last.aboveCloud ? 'above' : last.belowCloud ? 'below' : 'inside';

  return {
    signal:        twistSignal,
    matched:       true,
    score:         Math.min(5, score),
    twistBarsAgo,
    cloudWidth:    Math.round(cloudWidth    * 100) / 100,
    cloudWidthPct: Math.round(cloudWidthPct * 10000) / 100, // e.g. 0.72 means 0.72%
    close:         last.close,
    cloudTop:      last.cloudTop,
    cloudBottom:   last.cloudBottom,
    senkouA:       last.senkouA,
    senkouB:       last.senkouB,
    tenkan:        last.tenkan,
    kijun:         last.kijun,
    tkAligned,
    kijunSloping,
    priceVsKijun,
    cloudPosition,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat SpanB Rejection — First Touch of Flat Cloud Edge from Outside
// ─────────────────────────────────────────────────────────────────────────────
//
// Detects price approaching a flat Senkou Span B (strong S/R) for the first
// time after trending away from the cloud. Works both directions:
//
//   BEARISH (sell setup — retest from below):
//     - Future cloud is red (bearish bias ahead)
//     - SpanB flat for N candles (strong resistance)
//     - Price BELOW cloud for last M candles (established downtrend)
//     - Made lowest low in last K candles (fresh push down = snapback expected)
//     - Current candle's high reaches within proximity of SpanB (first touch)
//     - Current open is below SpanB (approaching from below)
//     - Previous P candles never touched SpanB (confirming first touch)
//
//   BULLISH (buy setup — retest from above):
//     - Future cloud is green (bullish bias ahead)
//     - SpanB flat for N candles (strong support)
//     - Price ABOVE cloud for last M candles (established uptrend)
//     - Made highest high in last K candles (fresh push up = pullback expected)
//     - Current candle's low reaches within proximity of SpanB (first touch)
//     - Current open is above SpanB (approaching from above)
//     - Previous P candles never touched SpanB (confirming first touch)

function getFlatSpanBRejection(candles, opts = {}) {
  const {
    flatBars       = 8,     // SpanB must be flat for this many bars
    flatThreshold  = 0.003, // max % variation to consider "flat" (0.3%)
    belowCloudBars = 5,     // price must be outside cloud for this many bars
    lowestLookback = 10,    // lookback for lowest-low / highest-high
    noTouchBars    = 5,     // previous N bars must not have touched SpanB
    proximity      = 0.05,  // within 5% of SpanB to trigger
  } = opts;

  if (!candles || candles.length < 78) return null;

  const results = calculate(candles);
  const n = results.length;
  const last = results[n - 1];
  if (!last || last.senkouB == null || last.senkouA == null) return null;

  const { close, high, low, open } = last;
  const spanB = last.senkouB;
  const spanA = last.senkouA;
  const cloudTop = last.cloudTop;
  const cloudBottom = last.cloudBottom;
  const tenkan = last.tenkan;
  const kijun = last.kijun;

  if (cloudTop == null || cloudBottom == null) return null;

  // ── Check SpanB is flat for flatBars candles ──────────────────────────────
  const spanBValues = [];
  for (let i = n - flatBars; i < n; i++) {
    if (i < 0 || !results[i] || results[i].senkouB == null) return null;
    spanBValues.push(results[i].senkouB);
  }
  const sbMax = Math.max(...spanBValues);
  const sbMin = Math.min(...spanBValues);
  const sbAvg = spanBValues.reduce((a, b) => a + b, 0) / spanBValues.length;
  if (sbAvg <= 0) return null;
  if ((sbMax - sbMin) / sbAvg > flatThreshold) return null;

  // The flat SpanB level
  const flatLevel = sbAvg;

  // ── Determine direction: is SpanB the cloud top or cloud bottom? ──────────
  // If SpanB > SpanA → SpanB is cloud top (resistance from below = bearish)
  // If SpanB < SpanA → SpanB is cloud bottom (support from above = bullish)
  const spanBisTop = spanB >= spanA;

  // ── Future cloud color ────────────────────────────────────────────────────
  const futureCloud = getFutureCloudColor(candles);

  let signal = null;

  if (spanBisTop) {
    // SpanB is cloud TOP → potential BEARISH rejection (approaching resistance from below)
    // Future cloud should be bearish (red)
    if (futureCloud !== 'bearish') return null;

    // Price must be BELOW cloud for last belowCloudBars
    for (let i = n - belowCloudBars; i < n; i++) {
      if (i < 0) return null;
      if (!results[i] || !results[i].belowCloud) return null;
    }

    // Must have made lowest low in last lowestLookback candles
    let lowestLow = Infinity;
    let lowestIdx = -1;
    for (let i = n - lowestLookback; i < n; i++) {
      if (i < 0) continue;
      if (results[i] && results[i].low < lowestLow) {
        lowestLow = results[i].low;
        lowestIdx = i;
      }
    }
    if (lowestIdx < 0 || lowestIdx === n - 1) return null;

    // Current candle must TOUCH the cloud border (cloudBottom) from below.
    // High must reach within proximity of cloudBottom (the near edge).
    const nearEdge = cloudBottom;
    const distToEdge = (nearEdge - high) / nearEdge;
    if (distToEdge > proximity) return null; // too far — hasn't reached cloud border
    // Price must stay outside cloud: close must remain below cloudBottom
    if (close >= nearEdge) return null;

    // Current open must be below cloud
    if (open >= nearEdge) return null;

    // Previous noTouchBars candles must NOT have touched cloud border (first touch)
    for (let i = n - 1 - noTouchBars; i < n - 1; i++) {
      if (i < 0) continue;
      if (results[i] && results[i].high >= nearEdge * (1 - flatThreshold)) return null;
    }

    signal = 'bearish';
  } else {
    // SpanB is cloud BOTTOM → potential BULLISH rejection (approaching support from above)
    // Future cloud should be bullish (green)
    if (futureCloud !== 'bullish') return null;

    // Price must be ABOVE cloud for last belowCloudBars
    for (let i = n - belowCloudBars; i < n; i++) {
      if (i < 0) return null;
      if (!results[i] || !results[i].aboveCloud) return null;
    }

    // Must have made highest high in last lowestLookback candles
    let highestHigh = -Infinity;
    let highestIdx = -1;
    for (let i = n - lowestLookback; i < n; i++) {
      if (i < 0) continue;
      if (results[i] && results[i].high > highestHigh) {
        highestHigh = results[i].high;
        highestIdx = i;
      }
    }
    if (highestIdx < 0 || highestIdx === n - 1) return null;

    // Current candle must TOUCH the cloud border (cloudTop) from above.
    // Low must reach within proximity of cloudTop (the near edge).
    const nearEdge = cloudTop;
    const distToEdge = (low - nearEdge) / nearEdge;
    if (distToEdge > proximity) return null; // too far — hasn't reached cloud border
    // Price must stay outside cloud: close must remain above cloudTop
    if (close <= nearEdge) return null;

    // Current open must be above cloud
    if (open <= nearEdge) return null;

    // Previous noTouchBars candles must NOT have touched cloud border (first touch)
    for (let i = n - 1 - noTouchBars; i < n - 1; i++) {
      if (i < 0) continue;
      if (results[i] && results[i].low <= nearEdge * (1 + flatThreshold)) return null;
    }

    signal = 'bullish';
  }

  // ── Score (0–5) ───────────────────────────────────────────────────────────
  let score = 0;
  // +1: Future cloud confirms direction
  score++;
  // +1: SpanB very flat (variation < 0.1%)
  if ((sbMax - sbMin) / sbAvg < 0.001) score++;
  // +1: Price was outside cloud for extra time (>= belowCloudBars + 3)
  let extraOutside = 0;
  for (let i = n - belowCloudBars - 5; i < n - belowCloudBars; i++) {
    if (i >= 0 && results[i]) {
      if (signal === 'bearish' && results[i].belowCloud) extraOutside++;
      if (signal === 'bullish' && results[i].aboveCloud) extraOutside++;
    }
  }
  if (extraOutside >= 3) score++;
  // +1: Volume confirmation (current bar higher than average)
  const volCtx = getVolumeContext(candles);
  if (volCtx && volCtx.volumeRatio >= 1.2) score++;
  // +1: Actually touched the cloud border (within 1%)
  const touchDist = signal === 'bearish'
    ? (cloudBottom - high) / cloudBottom
    : (low - cloudTop) / cloudTop;
  if (touchDist <= 0.01) score++;

  return {
    signal,
    close,
    high,
    low,
    open,
    tenkan,
    kijun,
    spanB: round(flatLevel),
    cloudTop,
    cloudBottom,
    futureCloud,
    score: Math.min(5, score),
  };
}

module.exports = {
  calculate,
  snapshot,
  getSignals,
  getKumoBreakoutTwist,
  getKumoBreakout,
  getKumoBaseEntry,
  getKumoPreBreakout,
  getKumoConsolidation,
  getKumoInsideConsolidation,
  getKumoTwist,
  getTKCross,
  getKijunCross,
  getChikouCross,
  getPerfectOrder,
  getKumoBounce,
  getKijunLevel,
  getCloudSupport,
  getVolumeContext,
  getATR,
  getRSI,
  to4H,
  getFutureCloudColor,
  getCloudExit,
  getKijunRetest,
  getTKReversion,
  getSenkouCross,
  getFlatSpanBRejection,
};
