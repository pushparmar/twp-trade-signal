/**
 * phase2/ichimokuCore.js
 *
 * Standalone Ichimoku engine for the Phase-2 app.
 * Fresh implementation — does NOT import from server/services/ichimoku.js.
 *
 * Exports:
 *   computeIchimoku(candles)        — full per-candle Ichimoku series
 *   getATR(candles, period)         — Wilder's ATR
 *   getFutureCloud(candles)         — 'bullish' | 'bearish' | 'neutral'
 *   detectKumoBreakout(candles, o)  — fresh kumo breakout detector
 *   detectTKReversion(candles, o)   — fresh TK reversion detector
 *
 * Both detectors return:
 *   null when not matched, otherwise
 *   { signal, entry, sl, target, rr, score, ...context }
 */

const TENKAN_LEN = 9;
const KIJUN_LEN = 26;
const SENKOU_B_LEN = 52;
const SHIFT = 26;

// Minimum candles for a valid senkouB at the last bar:
// bar (n-1) needs source bar (n-1-SHIFT) to have SENKOU_B_LEN history.
const MIN_BARS = SENKOU_B_LEN + SHIFT; // 78

function round2(x) {
  return x == null ? null : Math.round(x * 100) / 100;
}

function hiLoMid(candles, period, endIdx) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const c = candles[i];
    if (!c) return null;
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  if (hi === -Infinity || lo === Infinity) return null;
  return (hi + lo) / 2;
}

/**
 * Compute the Ichimoku series for every candle.
 * senkouA/senkouB are stored SHIFTED — the values plotted AT each candle
 * (i.e. computed from data 26 bars earlier), matching how charts draw the cloud.
 */
function computeIchimoku(candles) {
  const n = candles.length;
  const out = new Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = {
      date: candles[i].date,
      open: candles[i].open,
      high: candles[i].high,
      low: candles[i].low,
      close: candles[i].close,
      volume: candles[i].volume ?? null,
      tenkan: i >= TENKAN_LEN - 1 ? hiLoMid(candles, TENKAN_LEN, i) : null,
      kijun: i >= KIJUN_LEN - 1 ? hiLoMid(candles, KIJUN_LEN, i) : null,
      senkouA: null,
      senkouB: null,
      cloudTop: null,
      cloudBottom: null,
      aboveCloud: false,
      belowCloud: false,
      inCloud: false,
    };
  }

  // Project senkou spans 26 bars ahead
  for (let i = 0; i < n; i++) {
    const target = i + SHIFT;
    if (target >= n) break;

    const t = out[i].tenkan;
    const k = out[i].kijun;
    if (t != null && k != null) {
      out[target].senkouA = (t + k) / 2;
    }
    if (i >= SENKOU_B_LEN - 1) {
      out[target].senkouB = hiLoMid(candles, SENKOU_B_LEN, i);
    }
  }

  // Derive cloud edges and price position
  for (let i = 0; i < n; i++) {
    const r = out[i];
    if (r.senkouA != null && r.senkouB != null) {
      r.cloudTop = Math.max(r.senkouA, r.senkouB);
      r.cloudBottom = Math.min(r.senkouA, r.senkouB);
      r.aboveCloud = r.close > r.cloudTop;
      r.belowCloud = r.close < r.cloudBottom;
      r.inCloud = !r.aboveCloud && !r.belowCloud;
    }
  }

  return out;
}

/** Wilder's ATR */
function getATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const n = candles.length;

  let atr = 0;
  // Seed with simple average of first `period` TRs
  for (let i = 1; i <= period; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr += tr;
  }
  atr /= period;

  // Wilder smoothing over the rest
  for (let i = period + 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

/**
 * Future cloud direction — the cloud 26 bars ahead of the last candle,
 * computed from the freshest tenkan/kijun/52-period data.
 */
function getFutureCloud(candles) {
  if (!candles || candles.length < SENKOU_B_LEN) return null;
  const n = candles.length;

  const tenkan = hiLoMid(candles, TENKAN_LEN, n - 1);
  const kijun = hiLoMid(candles, KIJUN_LEN, n - 1);
  const spanB = hiLoMid(candles, SENKOU_B_LEN, n - 1);
  if (tenkan == null || kijun == null || spanB == null) return null;

  const spanA = (tenkan + kijun) / 2;
  if (spanA > spanB) return 'bullish';
  if (spanA < spanB) return 'bearish';
  return 'neutral';
}

/**
 * Natural swing target — highest high (bullish) / lowest low (bearish)
 * over the previous `lookback` closed bars (excludes the current bar).
 * Returns null when the swing level is on the wrong side of entry.
 */
function swingTarget(candles, signal, entry, lookback = 20) {
  const n = candles.length;
  if (n < lookback + 2) return null;
  const end = n - 1; // exclude current bar
  const start = Math.max(0, end - lookback);

  if (signal === 'bullish') {
    let hi = -Infinity;
    for (let i = start; i < end; i++) if (candles[i].high > hi) hi = candles[i].high;
    return hi > entry ? hi : null;
  }
  let lo = Infinity;
  for (let i = start; i < end; i++) if (candles[i].low < lo) lo = candles[i].low;
  return lo < entry ? lo : null;
}

/** Volume ratio of last bar vs 20-bar average. Null when volume missing. */
function volumeRatio(candles, lookback = 20) {
  const n = candles.length;
  if (n < lookback + 1) return null;
  let sum = 0;
  let cnt = 0;
  for (let i = n - 1 - lookback; i < n - 1; i++) {
    const v = candles[i]?.volume;
    if (v != null && v > 0) {
      sum += v;
      cnt++;
    }
  }
  const lastVol = candles[n - 1]?.volume;
  if (!cnt || lastVol == null) return null;
  const avg = sum / cnt;
  return avg > 0 ? lastVol / avg : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kumo Breakout (fresh)
// ─────────────────────────────────────────────────────────────────────────────
//
// Bullish: price closed above the cloud within the last `lookback` bars after
//          being inside/below it, is still above the cloud, close within
//          `maxDistance` of the cloud top, and Tenkan > Kijun.
// Bearish: mirror image below the cloud.
//
// Entry  = last close
// SL     = far cloud edge − buffer (bullish) / + buffer (bearish)
// Target = max(swing level, entry ± 2×risk) — never below 1:2 R:R

function detectKumoBreakout(candles, opts = {}) {
  const {
    lookback = 2,       // breakout must be within last N closed bars (fresh only)
    maxDistance = 0.05, // close must be within 5% of the near cloud edge
    slBufferPct = 0.003,
    slBufferAtr = 0.15,
  } = opts;

  if (!candles || candles.length < MIN_BARS) return null;

  const series = computeIchimoku(candles);
  const n = series.length;
  const last = series[n - 1];
  if (!last || last.cloudTop == null) return null;

  let signal = null;
  if (last.aboveCloud) signal = 'bullish';
  else if (last.belowCloud) signal = 'bearish';
  else return null;

  // TK alignment
  if (last.tenkan == null || last.kijun == null) return null;
  if (signal === 'bullish' && last.tenkan <= last.kijun) return null;
  if (signal === 'bearish' && last.tenkan >= last.kijun) return null;

  // Breakout freshness: within the last `lookback` bars there must be a bar
  // that was NOT on the breakout side (inside or opposite side of cloud).
  let fresh = false;
  for (let i = n - 1 - lookback; i < n - 1; i++) {
    if (i < 0) continue;
    const r = series[i];
    if (!r || r.cloudTop == null) continue;
    if (signal === 'bullish' && !r.aboveCloud) fresh = true;
    if (signal === 'bearish' && !r.belowCloud) fresh = true;
  }
  if (!fresh) return null;

  // Proximity: close still near the breakout edge (not extended)
  const nearEdge = signal === 'bullish' ? last.cloudTop : last.cloudBottom;
  const distance = Math.abs(last.close - nearEdge) / nearEdge;
  if (distance > maxDistance) return null;

  const atr = getATR(candles, 14);
  const entry = last.close;

  // SL: far cloud edge with buffer
  const farEdge = signal === 'bullish' ? last.cloudBottom : last.cloudTop;
  const buf = Math.max(farEdge * slBufferPct, atr != null ? slBufferAtr * atr : 0);
  let sl = signal === 'bullish' ? farEdge - buf : farEdge + buf;
  sl = round2(sl);

  if (signal === 'bullish' && sl >= entry) return null;
  if (signal === 'bearish' && sl <= entry) return null;

  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;

  // Target: swing level if further than 2×risk, else 2×risk
  const swing = swingTarget(candles, signal, entry);
  const fixed = signal === 'bullish' ? entry + 2 * risk : entry - 2 * risk;
  let target;
  let targetSource;
  if (swing != null && Math.abs(swing - entry) > Math.abs(fixed - entry)) {
    target = swing;
    targetSource = 'swing';
  } else {
    target = fixed;
    targetSource = 'fixed';
  }
  target = round2(target);

  const rr = Math.abs(target - entry) / risk;

  // Score 0–5
  let score = 2; // base: fresh breakout + TK aligned
  const futureCloud = getFutureCloud(candles);
  if (futureCloud === signal) score++;
  const volR = volumeRatio(candles);
  if (volR != null && volR >= 1.2) score++;
  if (distance <= 0.02) score++; // very fresh, right at the edge
  score = Math.min(5, score);

  return {
    pattern: 'kumo-breakout',
    signal,
    entry: round2(entry),
    close: round2(entry),
    sl,
    target,
    rr: +rr.toFixed(2),
    score,
    targetSource,
    tenkan: round2(last.tenkan),
    kijun: round2(last.kijun),
    cloudTop: round2(last.cloudTop),
    cloudBottom: round2(last.cloudBottom),
    futureCloud,
    volumeRatio: volR != null ? +volR.toFixed(2) : null,
    atr: round2(atr),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TK Reversion (fresh)
// ─────────────────────────────────────────────────────────────────────────────
//
// Setup: Tenkan-Kijun spread is wide (≥ minSpreadPct of price) and the latest
// close sits INSIDE the TK gap (price reverting from an extended move).
// Confirmation: within the last 2 bars there is a wick rejection at Tenkan:
//   Bullish (Kijun > Tenkan): low pierces Tenkan, close recovers above it
//   Bearish (Tenkan > Kijun): high pierces Tenkan, close rejects below it
//
// Entry  = Tenkan value
// SL     = wick extreme
// Target = Kijun (the reversion magnet)

function detectTKReversion(candles, opts = {}) {
  const {
    minSpreadPct = 5.0,   // TK gap must be at least 5% of price
    spreadLookback = 10,  // gap must be near its recent peak (still wide)
  } = opts;

  if (!candles || candles.length < MIN_BARS) return null;

  const series = computeIchimoku(candles);
  const n = series.length;
  const last = series[n - 1];
  if (!last || last.tenkan == null || last.kijun == null) return null;

  const { close, tenkan, kijun } = last;
  const spreadPct = (Math.abs(tenkan - kijun) / close) * 100;
  if (spreadPct < minSpreadPct) return null;

  // Close must be inside the TK gap
  const gapHigh = Math.max(tenkan, kijun);
  const gapLow = Math.min(tenkan, kijun);
  if (!(close > gapLow && close < gapHigh)) return null;

  // Direction + wick rejection at Tenkan within last 2 bars
  let signal = null;
  let wickExtreme = null;

  if (kijun > tenkan) {
    // Price fell below equilibrium, reverting UP toward Kijun
    for (let i = n - 1; i >= n - 2 && i >= 0; i--) {
      const c = series[i];
      if (!c || c.tenkan == null) continue;
      if (c.low < c.tenkan && c.close > c.tenkan) {
        signal = 'bullish';
        wickExtreme = c.low;
        break;
      }
    }
  } else if (tenkan > kijun) {
    // Price rose above equilibrium, reverting DOWN toward Kijun
    for (let i = n - 1; i >= n - 2 && i >= 0; i--) {
      const c = series[i];
      if (!c || c.tenkan == null) continue;
      if (c.high > c.tenkan && c.close < c.tenkan) {
        signal = 'bearish';
        wickExtreme = c.high;
        break;
      }
    }
  }

  if (!signal || wickExtreme == null) return null;

  // Spread must still be near its recent peak (reversion just starting)
  let peak = 0;
  for (let i = Math.max(0, n - 1 - spreadLookback); i < n; i++) {
    const r = series[i];
    if (r.tenkan != null && r.kijun != null && r.close > 0) {
      const sp = (Math.abs(r.tenkan - r.kijun) / r.close) * 100;
      if (sp > peak) peak = sp;
    }
  }
  if (peak > 0 && spreadPct < peak * 0.6) return null;

  const entry = tenkan;
  const sl = wickExtreme;
  const target = kijun;

  if (signal === 'bullish' && (sl >= entry || target <= entry)) return null;
  if (signal === 'bearish' && (sl <= entry || target >= entry)) return null;

  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const rr = Math.abs(target - entry) / risk;

  // Score 0–5
  let score = 3; // base: wide spread + wick rejection
  if (spreadPct >= minSpreadPct * 2) score++;
  const futureCloud = getFutureCloud(candles);
  if (signal === 'bullish' && last.belowCloud) score++;
  if (signal === 'bearish' && last.aboveCloud) score++;
  score = Math.min(5, score);

  return {
    pattern: 'tk-reversion',
    signal,
    entry: round2(entry),
    close: round2(entry),
    sl: round2(sl),
    target: round2(target),
    rr: +rr.toFixed(2),
    score,
    targetSource: 'kijun',
    tenkan: round2(tenkan),
    kijun: round2(kijun),
    cloudTop: round2(last.cloudTop),
    cloudBottom: round2(last.cloudBottom),
    futureCloud,
    tkSpreadPct: +spreadPct.toFixed(2),
    volumeRatio: (() => {
      const v = volumeRatio(candles);
      return v != null ? +v.toFixed(2) : null;
    })(),
    atr: round2(getATR(candles, 14)),
  };
}

module.exports = {
  computeIchimoku,
  getATR,
  getFutureCloud,
  detectKumoBreakout,
  detectTKReversion,
  MIN_BARS,
};
