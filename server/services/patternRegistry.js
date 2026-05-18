/**
 * Pattern Registry — central place to register and retrieve scan patterns.
 *
 * Adding a new pattern:
 *   1. Write the detection logic (e.g. as a function in ichimoku.js or its own file).
 *   2. Add an entry to PATTERNS below.
 *   3. The scan route and client dropdown pick it up automatically.
 *
 * Each pattern entry must have:
 *   id          — unique kebab-case string used as the API key
 *   label       — human-readable name shown in the UI dropdown
 *   description — one-line explanation shown as a tooltip / subtitle
 *   defaultOpts — default option values (passed to run() when client omits them)
 *   run(candles, opts) — receives a candle array and options object;
 *                        MUST return { matched: boolean, signal, score, ... }
 *                        returning null or throwing skips the instrument silently.
 */

const {
  getKumoBreakoutTwist, getKumoBreakout, getKumoTwist,
  getTKCross, getKijunCross, getChikouCross, getPerfectOrder, getKumoBounce,
  getKijunLevel, getCloudSupport, getVolumeContext, getATR,
} = require('./ichimoku');

// Minimum SL distance as a multiple of ATR14.  Anything tighter gets widened
// to this floor so positions don't get wicked out by normal noise and the
// natural Kijun/cloud SL is preserved when it's already sensible.
const MIN_SL_ATR_MULT = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a suggested SL and 2:1 R:R target from a pattern result.
 *
 * SL anchor per pattern:
 *   kijun-bounce  → Kijun itself  (close through it = setup failed)
 *   cloud patterns → cloud edge   (re-entering the cloud = setup failed)
 *
 * ATR floor:
 *   When the natural SL sits closer than MIN_SL_ATR_MULT × ATR14, it gets
 *   widened to that floor.  This prevents 1-rupee-stop pathologies on tight
 *   Kijun touches and stops getting wicked out by normal noise.  Skipped
 *   when candles are unavailable or there aren't enough bars for ATR14.
 *
 * Fallback when the natural level is missing or on the wrong side of close:
 *   max(0.5% × close, 0.5 × ATR14) — always returns a valid pair.
 *
 * Target = entry ± 2 × risk  (fixed 2:1 R:R minimum; max uncapped).
 *
 * @param {string} patternId  — one of the PATTERNS keys
 * @param {'bullish'|'bearish'} signal
 * @param {object} result     — the raw return from the ichimoku detector
 * @param {object[]} [candles] — optional candle array used to derive ATR
 * @returns {{ sl: number|null, target: number|null, atr?: number|null }}
 */
function computeSLTarget(patternId, signal, result, candles) {
  const { close, cloudBottom, cloudTop, kijun, kijunValue } = result;
  if (!close || !signal) return { sl: null, target: null };

  const kijunLevel = kijun ?? kijunValue ?? null;
  // ATR14 — used both as a floor for the natural SL and as a richer fallback
  const atr = candles ? getATR(candles, 14) : null;
  const atrFloor = atr != null ? MIN_SL_ATR_MULT * atr : null;

  let sl;
  if (patternId === 'kijun-bounce') {
    sl = kijunLevel;
  } else {
    sl = signal === 'bullish'
      ? (cloudBottom ?? kijunLevel)
      : (cloudTop    ?? kijunLevel);
  }

  // Fallback when no natural level was found — use the bigger of 0.5% and 0.5·ATR
  if (sl == null) {
    const pctSl = signal === 'bullish' ? close * 0.005 : close * 0.005;
    const slDistance = atrFloor != null ? Math.max(pctSl, atrFloor) : pctSl;
    sl = signal === 'bullish' ? close - slDistance : close + slDistance;
  }

  // Safety: SL must sit on the correct side of close
  if (signal === 'bullish' && sl >= close) sl = close * 0.995;
  if (signal === 'bearish' && sl <= close) sl = close * 1.005;

  // ATR floor — widen SL if it's tighter than 0.5×ATR
  if (atrFloor != null) {
    const naturalDist = Math.abs(close - sl);
    if (naturalDist < atrFloor) {
      sl = signal === 'bullish' ? close - atrFloor : close + atrFloor;
    }
  }

  const risk   = Math.abs(close - sl);
  const target = signal === 'bullish' ? close + 2 * risk : close - 2 * risk;

  return {
    sl:     Math.round(sl     * 100) / 100,
    target: Math.round(target * 100) / 100,
    atr:    atr != null ? Math.round(atr * 100) / 100 : null,
  };
}

/**
 * TK alignment guard — shared by all active patterns.
 *
 * Bullish setup: Tenkan (green) must be ABOVE Kijun (red).
 * Bearish setup: Kijun (red)   must be ABOVE Tenkan (green).
 *
 * Returns true when the lines agree with the signal direction,
 * or when tenkan/kijun are unavailable (fail-open so we never
 * silently swallow signals when ichimoku.js return shape changes).
 */
function _tkAligned(result) {
  const { signal, tenkan, kijun } = result;
  if (tenkan == null || kijun == null) return true; // fail-open: data unavailable
  if (signal === 'bullish') return tenkan > kijun;  // green above red
  if (signal === 'bearish') return kijun  > tenkan; // red above green
  return true;
}

/**
 * Extract volume fields from raw candles and return them ready to spread
 * into a pattern result.  volumeConfirmed=true when the current candle's
 * volume is at least 20% above the 20-bar average — a meaningful signal that
 * the move has participation behind it.
 */
function _volumeFields(candles) {
  const volCtx = getVolumeContext(candles);
  return {
    volumeRatio:     volCtx?.volumeRatio    ?? null,
    volumeConfirmed: volCtx != null ? volCtx.volumeRatio >= 1.2 : null,
  };
}

const PATTERNS = {

  'kumo-breakout': {
    id:          'kumo-breakout',
    label:       'Kumo Breakout',
    description: 'Price broke above or below the cloud within the last N bars and has not re-entered it.',
    // lookback:3 — breakout must have occurred within the last 3 closed candles.
    // lookback:1 (the crossover on the EXACT current candle) combined with TK alignment
    // as a hard filter produced near-zero matches in production.  A 3-bar window
    // still identifies fresh breakouts (not stale trends) while being realistic.
    defaultOpts: { lookback: 3 },

    run(candles, opts = {}) {
      const result = getKumoBreakout(candles, { ...this.defaultOpts, ...opts });
      if (!result) return { matched: false };
      if (result.signal === null) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };
      const { sl, target, atr } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, ..._volumeFields(candles) };
    },
  },

  'kumo-bounce': {
    id:          'kumo-bounce',
    label:       'Kumo Bounce',
    description: 'Price pulled back to the cloud edge from outside and reversed on the current candle. Bullish when price tests cloudTop from above; bearish when testing cloudBottom from below.',
    defaultOpts: { lookback: 1, tolerance: 0.005 },

    run(candles, opts = {}) {
      const result = getKumoBounce(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };
      const { sl, target, atr } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, ..._volumeFields(candles) };
    },
  },

  'cloud-support': {
    id:          'cloud-support',
    label:       'Cloud Support / Resistance',
    description: 'Price is currently above (bullish) or below (bearish) the cloud, cloud color agrees, and price has held that position for 3–5 consecutive bars. Score 0–5 includes TK order, Chikou, and duration.',
    defaultOpts: { minBars: 3, maxBars: 5 },

    run(candles, opts = {}) {
      const { maxBars, ...icOpts } = { ...this.defaultOpts, ...opts };
      const result = getCloudSupport(candles, icOpts);
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };
      if (result.consecutiveBars > maxBars) return { matched: false };
      if (result.score < 3) return { matched: false };
      const { sl, target, atr } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, ..._volumeFields(candles) };
    },
  },

  'kijun-bounce': {
    id:          'kijun-bounce',
    label:       'Kijun Support / Resistance',
    description: 'Price tested the Kijun-sen (base line) as support (bullish) or resistance (bearish) within the last 2–3 candles — wick touched the level, close must not break through.',
    defaultOpts: { lookback: 3, tolerance: 0.003 },

    run(candles, opts = {}) {
      const result = getKijunLevel(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };
      const { sl, target, atr } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, ..._volumeFields(candles) };
    },
  },

  // ── Disabled patterns — uncomment any entry to re-enable ─────────────────

  // 'kumo-breakout-twist': {
  //   id:          'kumo-breakout-twist',
  //   label:       'Kumo Breakout + Twist (5/5)',
  //   description: 'All 5 must agree on the current candle: price broke cloud · cloud color matches · twist occurred · chikou confirms · price vs kijun',
  //   defaultOpts: { lookback: 1 },
  //   run(candles, opts = {}) {
  //     const result = getKumoBreakoutTwist(candles, { ...this.defaultOpts, ...opts });
  //     if (!result) return { matched: false };
  //     return { matched: result.signal !== null, ...result };
  //   },
  // },

  // 'kumo-twist': {
  //   id:          'kumo-twist',
  //   label:       'Kumo Twist',
  //   description: 'Cloud color flipped (Senkou A crossed Senkou B) on the current candle',
  //   defaultOpts: { lookback: 1 },
  //   run(candles, opts = {}) {
  //     const result = getKumoTwist(candles, { ...this.defaultOpts, ...opts });
  //     if (!result) return { matched: false };
  //     return { matched: result.signal !== null, ...result };
  //   },
  // },

  // 'tk-cross': {
  //   id:          'tk-cross',
  //   label:       'TK Cross',
  //   description: 'Tenkan (green/fast) crossed Kijun (red/slow) within the last N bars. Fires on any cross regardless of cloud position. Strength label (strong/neutral/weak) shows where price was relative to the cloud.',
  //   defaultOpts: { lookback: 1 },
  //   run(candles, opts = {}) {
  //     const result = getTKCross(candles, { ...this.defaultOpts, ...opts });
  //     if (!result || !result.signal) return { matched: false };
  //     return { matched: true, ...result };
  //   },
  // },

  // 'kijun-cross': {
  //   id:          'kijun-cross',
  //   label:       'Kijun Cross',
  //   description: 'Price (close) crossed above/below the Kijun-sen on the current candle. Strong when price is also on the correct side of the cloud.',
  //   defaultOpts: { lookback: 1 },
  //   run(candles, opts = {}) {
  //     const result = getKijunCross(candles, { ...this.defaultOpts, ...opts });
  //     if (!result || !result.signal) return { matched: false };
  //     return { matched: true, ...result };
  //   },
  // },

  // 'chikou-cross': {
  //   id:          'chikou-cross',
  //   label:       'Chikou Cross',
  //   description: 'Chikou Span (lagging line) crossed above/below the price from 26 bars back on the current candle.',
  //   defaultOpts: { lookback: 1 },
  //   run(candles, opts = {}) {
  //     const result = getChikouCross(candles, { ...this.defaultOpts, ...opts });
  //     if (!result || !result.signal) return { matched: false };
  //     return { matched: true, ...result };
  //   },
  // },

  // 'perfect-order': {
  //   id:          'perfect-order',
  //   label:       'Perfect Order (all lines stacked)',
  //   description: 'All 5 Ichimoku components are perfectly stacked at the current bar: Tenkan > Kijun > Price > Cloud (or inverse). Highest-conviction setup.',
  //   defaultOpts: {},
  //   run(candles, opts = {}) {
  //     const result = getPerfectOrder(candles);
  //     if (!result || !result.signal) return { matched: false };
  //     return { matched: true, ...result };
  //   },
  // },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a lightweight list of all patterns (no run function) — safe to
 * serialise and send to the client for the dropdown.
 */
function list() {
  return Object.values(PATTERNS).map(({ id, label, description, defaultOpts }) => ({
    id,
    label,
    description,
    defaultOpts,
  }));
}

/**
 * Returns the full pattern object (including run()) for a given id.
 * Returns null when the pattern is not registered.
 */
function get(id) {
  return PATTERNS[id] || null;
}

module.exports = { list, get, computeSLTarget };
