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
  getKijunLevel, getCloudSupport,
} = require('./ichimoku');

// ─────────────────────────────────────────────────────────────────────────────
// Active patterns — kumo-breakout, kumo-bounce, cloud-support only.
// The remaining patterns are commented out; uncomment to re-enable.
// ─────────────────────────────────────────────────────────────────────────────

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
      // TK alignment: bullish → Tenkan above Kijun; bearish → Kijun above Tenkan
      if (!_tkAligned(result)) return { matched: false };
      return { matched: true, ...result };
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
      // TK alignment: bullish → Tenkan above Kijun; bearish → Kijun above Tenkan
      if (!_tkAligned(result)) return { matched: false };
      return { matched: true, ...result };
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
      // TK alignment is a hard requirement (not just a score bonus):
      // bullish → Tenkan above Kijun; bearish → Kijun above Tenkan
      if (!_tkAligned(result)) return { matched: false };
      // Only fire when the setup is fresh — too many consecutive bars means it's
      // already a well-known trend, not a newly confirmed support/resistance.
      if (result.consecutiveBars > maxBars) return { matched: false };
      // Only fire when score is at least 3 — avoids alerting on weak/thin cloud setups
      if (result.score < 3) return { matched: false };
      return { matched: true, ...result };
    },
  },

  'kijun-bounce': {
    id:          'kijun-bounce',
    label:       'Kijun Support / Resistance',
    description: 'Price tested the Kijun-sen (base line) as support (bullish) or resistance (bearish) within the last 2–3 candles — wick touched the level, no close confirmation required.',
    // lookback:3 — the wick touch must have occurred within the last 3 closed candles.
    // tolerance:0.003 — wick must come within 0.3% of the Kijun at that bar.
    defaultOpts: { lookback: 3, tolerance: 0.003 },

    run(candles, opts = {}) {
      const result = getKijunLevel(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      // TK alignment: bullish → Tenkan above Kijun; bearish → Kijun above Tenkan.
      if (!_tkAligned(result)) return { matched: false };
      return { matched: true, ...result };
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

module.exports = { list, get };
