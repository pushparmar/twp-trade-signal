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

const { getKumoBreakoutTwist, getKumoBreakout, getKumoTwist } = require('./ichimoku');

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

  // ── Add future patterns here, e.g.:
  // 'tk-cross-above-cloud': { ... },
  // 'chikou-breakout':      { ... },
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
