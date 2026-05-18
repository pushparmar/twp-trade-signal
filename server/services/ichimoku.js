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
 *   Only complete groups of exactly 4 consecutive 1h bars within the SAME
 *   calendar day are combined. A partial end-of-day group (< 4 bars) is skipped.
 *
 * Indian market produces ~6 complete 1h bars per session (9:15-15:15).
 * That gives exactly ONE complete 4h candle per day (bars 0-3) and leaves
 * the last 2 bars out. A 1200-bar 1h buffer (~192 days) therefore yields
 * ~192 4h candles — well above the 52 required by Ichimoku.
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

  const out = [];
  for (const dayCandles of byDay.values()) {
    // Only process complete groups of 4 — partial end-of-session groups are dropped
    for (let i = 0; i + 3 < dayCandles.length; i += 4) {
      const slice = dayCandles.slice(i, i + 4);
      out.push({
        date:  slice[0].date,
        open:  slice[0].open,
        high:  Math.max(...slice.map((c) => c.high)),
        low:   Math.min(...slice.map((c) => c.low)),
        close: slice[slice.length - 1].close,
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
    close:         last.close,
    cloudTop:      last.cloudTop  != null ? round(last.cloudTop)    : null,
    cloudBottom:   last.cloudBottom != null ? round(last.cloudBottom) : null,
    tenkan:        last.tenkan != null ? round(last.tenkan) : null,
    kijun:         last.kijun  != null ? round(last.kijun)  : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  calculate,
  snapshot,
  getSignals,
  getKumoBreakoutTwist,
  getKumoBreakout,
  getKumoTwist,
  getTKCross,
  getKijunCross,
  getChikouCross,
  getPerfectOrder,
  getKumoBounce,
  getKijunLevel,
  getCloudSupport,
  to4H,
};
