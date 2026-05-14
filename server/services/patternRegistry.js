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
  getCloudSupport,
} = require('./ichimoku');

// ─────────────────────────────────────────────────────────────────────────────
// Pattern definitions
// ─────────────────────────────────────────────────────────────────────────────

const PATTERNS = {
  // All three patterns share the same `lookback: 10` window — every event
  // (breakout cross, twist cross) must have occurred within the last 10 candles.

  'kumo-breakout-twist': {
    id:          'kumo-breakout-twist',
    label:       'Kumo Breakout + Twist (5/5)',
    description: 'All 5 must agree within last 10 bars: price broke cloud · cloud color matches · twist occurred · chikou confirms · price vs kijun',
    defaultOpts: { lookback: 10 },

    run(candles, opts = {}) {
      const result = getKumoBreakoutTwist(candles, { ...this.defaultOpts, ...opts });
      if (!result) return { matched: false };
      return { matched: result.signal !== null, ...result };
    },
  },

  'kumo-breakout': {
    id:          'kumo-breakout',
    label:       'Kumo Breakout (last 10 candles)',
    description: 'Price broke above or below the cloud within the last 10 bars and has not re-entered it',
    defaultOpts: { lookback: 10 },

    run(candles, opts = {}) {
      const result = getKumoBreakout(candles, { ...this.defaultOpts, ...opts });
      if (!result) return { matched: false };
      return { matched: result.signal !== null, ...result };
    },
  },

  'kumo-twist': {
    id:          'kumo-twist',
    label:       'Kumo Twist (last 10 candles)',
    description: 'Cloud color flipped (Senkou A crossed Senkou B) within the last 10 bars',
    defaultOpts: { lookback: 10 },

    run(candles, opts = {}) {
      const result = getKumoTwist(candles, { ...this.defaultOpts, ...opts });
      if (!result) return { matched: false };
      return { matched: result.signal !== null, ...result };
    },
  },

  // ── Tier 1: Core Signals ──────────────────────────────────────────────────

  'tk-cross': {
    id:          'tk-cross',
    label:       'TK Cross (last 5 bars)',
    description: 'Tenkan crossed above/below Kijun within last 5 bars. Strength depends on cloud position: above=Strong, inside=Neutral, below=Weak.',
    defaultOpts: { lookback: 5 },

    run(candles, opts = {}) {
      const result = getTKCross(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      return { matched: true, ...result };
    },
  },

  'kijun-cross': {
    id:          'kijun-cross',
    label:       'Kijun Cross (last 5 bars)',
    description: 'Price (close) crossed above/below the Kijun-sen within last 5 bars. Strong when price is also on the correct side of the cloud.',
    defaultOpts: { lookback: 5 },

    run(candles, opts = {}) {
      const result = getKijunCross(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      return { matched: true, ...result };
    },
  },

  'chikou-cross': {
    id:          'chikou-cross',
    label:       'Chikou Cross (last 5 bars)',
    description: 'Chikou Span (lagging line) crossed above/below the price from 26 bars back within last 5 bars.',
    defaultOpts: { lookback: 5 },

    run(candles, opts = {}) {
      const result = getChikouCross(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      return { matched: true, ...result };
    },
  },

  // ── Tier 2: Confluence / High-Probability ────────────────────────────────

  'perfect-order': {
    id:          'perfect-order',
    label:       'Perfect Order (all lines stacked)',
    description: 'All 5 Ichimoku components are perfectly stacked at the current bar: Tenkan > Kijun > Price > Cloud (or inverse). Highest-conviction setup.',
    defaultOpts: {},

    run(candles, opts = {}) {
      const result = getPerfectOrder(candles);
      if (!result || !result.signal) return { matched: false };
      return { matched: true, ...result };
    },
  },

  'kumo-bounce': {
    id:          'kumo-bounce',
    label:       'Kumo Bounce (last 5 bars)',
    description: 'Price pulled back to the cloud edge from outside and reversed within last 5 bars. Bullish when price tests cloudTop from above; bearish when testing cloudBottom from below.',
    defaultOpts: { lookback: 5, tolerance: 0.005 },

    run(candles, opts = {}) {
      const result = getKumoBounce(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      return { matched: true, ...result };
    },
  },

  // ── Tier 2: Cloud Position Patterns ─────────────────────────────────────

  'cloud-support': {
    id:          'cloud-support',
    label:       'Cloud Support / Resistance',
    description: 'Price is currently above (bullish) or below (bearish) the cloud, cloud color agrees, and price has held that position for ≥ 3 consecutive bars. Score 0–5 includes TK order, Chikou, and duration.',
    defaultOpts: { minBars: 3 },

    run(candles, opts = {}) {
      const result = getCloudSupport(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      // Only fire when score is at least 3 — avoids alerting on weak/thin cloud setups
      if (result.score < 3) return { matched: false };
      return { matched: true, ...result };
    },
  },
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
