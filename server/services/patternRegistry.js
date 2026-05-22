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
  getKumoBreakoutTwist, getKumoBreakout, getKumoBaseEntry, getKumoTwist,
  getTKCross, getKijunCross, getChikouCross, getPerfectOrder, getKumoBounce,
  getKijunLevel, getCloudSupport, getVolumeContext, getATR, getRSI,
} = require('./ichimoku');

// Minimum SL distance as a multiple of ATR14.  Anything tighter gets widened
// to this floor so positions don't get wicked out by normal noise and the
// natural Kijun/cloud SL is preserved when it's already sensible.
const MIN_SL_ATR_MULT = 0.5;

// Buffer applied below (bullish) or above (bearish) a Kijun / cloud-edge SL
// anchor.  Kijun is a support/resistance line, not a hard stop — placing the
// SL exactly AT the level gets wicked out by normal candle noise.  A 0.3%
// buffer gives the level a small safety margin without meaningfully changing
// the R:R.  When ATR is available the buffer is the larger of the two so it
// automatically scales with the instrument's volatility.
const SL_ANCHOR_BUFFER_PCT = 0.003;   // 0.3% of the anchor level
const SL_ANCHOR_BUFFER_ATR = 0.15;    // 0.15 × ATR14 (used when ATR available)

// Kijun-bounce uses a wider buffer because the Kijun is a structural S/R zone,
// not a precise hard level — a small wick through it is normal candle noise.
// 0.6% (double the standard) + 0.4×ATR gives meaningful breathing room without
// materially shifting the logical invalidation point.
const KIJUN_SL_BUFFER_PCT = 0.006;   // 0.6% of the Kijun level
const KIJUN_SL_BUFFER_ATR = 0.40;    // 0.40 × ATR14

// Natural-target search window — how many recent bars to scan for swing high/low.
// 30 bars is enough to catch the most recent meaningful structure on any TF
// without reaching back to stale levels from a previous trend.
const NATURAL_TARGET_LOOKBACK = 30;

/**
 * Find a natural resistance (bullish) or support (bearish) level the trade
 * could realistically extend to.  We use the highest high (bullish) or lowest
 * low (bearish) in the last NATURAL_TARGET_LOOKBACK closed bars — a simple but
 * effective proxy for the "next significant level" a trend trader would target.
 *
 * Returns null when:
 *   • candles[] is too short
 *   • the swing level is on the wrong side of entry (e.g. for BUY, swing high
 *     is already below entry — meaning we're already in price discovery)
 *
 * @param {object[]} candles  full candle array (includes current)
 * @param {'bullish'|'bearish'} signal
 * @param {number}   entry    typically the pattern's close price
 * @returns {number|null}
 */
function _naturalTarget(candles, signal, entry) {
  if (!Array.isArray(candles) || candles.length < NATURAL_TARGET_LOOKBACK + 2) return null;

  // Exclude the current bar so live ticks during pattern formation don't pin
  // the swing to the entry itself.
  const end   = candles.length - 1;
  const start = Math.max(0, end - NATURAL_TARGET_LOOKBACK);

  if (signal === 'bullish') {
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      if (candles[i]?.high > hi) hi = candles[i].high;
    }
    return hi > entry ? hi : null;
  } else {
    let lo = Infinity;
    for (let i = start; i < end; i++) {
      if (candles[i]?.low < lo) lo = candles[i].low;
    }
    return lo < entry ? lo : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a suggested SL and target from a pattern result.
 *
 * ── SL ─────────────────────────────────────────────────────────────────────
 *   Anchor per pattern:
 *     kijun-bounce  → Kijun itself  (close through it = setup failed)
 *     cloud patterns → cloud edge   (re-entering the cloud = setup failed)
 *
 *   ATR floor: when the natural SL sits closer than MIN_SL_ATR_MULT × ATR14
 *   it gets widened to that floor.  Prevents 1-rupee-stop pathologies on
 *   tight Kijun touches and stops getting wicked out by normal noise.
 *
 *   Fallback when no natural level is available or it's on the wrong side
 *   of close:  max(0.5% × close, 0.5 × ATR14).
 *
 * ── Target (option A — "1:2 minimum, max anything") ────────────────────────
 *   We compute TWO candidates and pick whichever is FURTHER from entry:
 *
 *     a) Fixed 2× risk target           — guaranteed 1:2 R:R floor
 *     b) Natural swing high/low target  — highest high (bullish) or lowest
 *                                          low (bearish) in the last 30 bars
 *
 *   If the natural level is closer than 2× risk it's ignored — we never go
 *   below 1:2.  When the natural level is further (e.g. trend has more room
 *   to run), we use it directly so winners ride to real resistance.
 *
 *   targetSource indicates which candidate won: 'fixed' or 'swing'.
 *
 * @param {string} patternId
 * @param {'bullish'|'bearish'} signal
 * @param {object} result      raw return from the ichimoku detector
 * @param {object[]} [candles] optional candle array used for ATR + swing scan
 * @returns {{
 *   sl: number|null, target: number|null,
 *   atr: number|null, targetSource: 'fixed'|'swing'|null
 * }}
 */
function computeSLTarget(patternId, signal, result, candles) {
  const { close, cloudBottom, cloudTop, kijun, kijunValue } = result;
  if (!close || !signal) return { sl: null, target: null, atr: null, targetSource: null };

  const kijunLevel = kijun ?? kijunValue ?? null;
  const atr = candles ? getATR(candles, 14) : null;
  const atrFloor = atr != null ? MIN_SL_ATR_MULT * atr : null;

  // ── SL anchor ──────────────────────────────────────────────────────────────
  let sl;
  if (patternId === 'kijun-bounce') {
    // SL = Kijun itself (close through it = setup failed)
    sl = kijunLevel;
  } else if (patternId === 'kumo-base-entry') {
    // SL = far edge of the prior consolidation base.  The base (tight range
    // below/above the cloud) defines the risk zone — if price falls back through
    // the base low (bullish) or base high (bearish) the setup has failed.
    // Fall back to the cloud entry edge if consLow/consHigh not in result.
    const { consLow, consHigh } = result;
    sl = signal === 'bullish'
      ? (consLow  ?? cloudBottom ?? kijunLevel)
      : (consHigh ?? cloudTop    ?? kijunLevel);
  } else {
    // All other cloud patterns (kumo-breakout, cloud-support, etc.):
    // SL = far cloud edge — price must traverse the whole cloud to invalidate.
    sl = signal === 'bullish'
      ? (cloudBottom ?? kijunLevel)
      : (cloudTop    ?? kijunLevel);
  }

  // ── Buffer — push SL just beyond the anchor level ──────────────────────────
  // Kijun and cloud edges are support/resistance zones, not hard lines.
  // Placing SL exactly at the level means a single wick through it exits the
  // trade even when price immediately reverses back.  We apply a small buffer
  // (larger of 0.3% or 0.15×ATR) so the stop only triggers on a genuine break.
  if (sl != null) {
    // kijun-bounce gets a wider dedicated buffer (0.6% / 0.4×ATR) — the Kijun
    // is a structural zone and a normal wick through it should not exit the trade.
    const bufPct = patternId === 'kijun-bounce' ? KIJUN_SL_BUFFER_PCT : SL_ANCHOR_BUFFER_PCT;
    const bufAtr = patternId === 'kijun-bounce' ? KIJUN_SL_BUFFER_ATR : SL_ANCHOR_BUFFER_ATR;
    const pctBuf = sl * bufPct;
    const atrBuf = atr != null ? bufAtr * atr : 0;
    const buf    = Math.max(pctBuf, atrBuf);
    sl = signal === 'bullish' ? sl - buf : sl + buf;
  }

  // Fallback when no natural level was found
  if (sl == null) {
    const pctSl     = close * 0.005;
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

  // ── Target — option A: max(2×risk, recentSwing) in the favourable direction ─
  const risk        = Math.abs(close - sl);
  const fixedTarget = signal === 'bullish' ? close + 2 * risk : close - 2 * risk;

  let target       = fixedTarget;
  let targetSource = 'fixed';
  const swing      = candles ? _naturalTarget(candles, signal, close) : null;
  if (swing != null) {
    if (signal === 'bullish' && swing > fixedTarget) {
      target       = swing;
      targetSource = 'swing';
    } else if (signal === 'bearish' && swing < fixedTarget) {
      target       = swing;
      targetSource = 'swing';
    }
  }

  return {
    sl:           Math.round(sl     * 100) / 100,
    target:       Math.round(target * 100) / 100,
    atr:          atr != null ? Math.round(atr * 100) / 100 : null,
    targetSource,
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

/**
 * RSI fields — calculated from the same candle array used for Ichimoku.
 * No extra API call needed; candles are already in memory at scan time.
 * Returns { rsi14 } where rsi14 is Wilder's 14-period RSI of the last bar.
 */
function _rsiFields(candles) {
  return { rsi14: getRSI(candles, 14) };
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
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, targetSource, ..._volumeFields(candles), ..._rsiFields(candles) };
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
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, targetSource, ..._volumeFields(candles), ..._rsiFields(candles) };
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
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, targetSource, ..._volumeFields(candles), ..._rsiFields(candles) };
    },
  },

  'kumo-base-entry': {
    id:          'kumo-base-entry',
    label:       'Kumo Base Entry',
    description: 'Price consolidated in a tight base just outside a fat cloud, then freshly entered the cloud from the near edge. Fat cloud = strong resistance to traverse (meaningful move expected). SL anchors below the base low (bullish) or above the base high (bearish).',
    defaultOpts: {
      consLookback:     10,
      consRatio:        2.5,
      minConsBars:      3,
      posThreshold:     0.4,
      entryLookback:    3,
      minCloudWidthPct: 0.01,
      minCloudWidthAtr: 1.0,
    },

    run(candles, opts = {}) {
      const result = getKumoBaseEntry(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles);
      return {
        matched: true,
        ...result,
        sl, target, atr, targetSource,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
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
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles);
      return { matched: true, ...result, sl, target, atr, targetSource, ..._volumeFields(candles), ..._rsiFields(candles) };
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
