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
  getCloudExit, getKijunRetest, getTKReversion, getSenkouCross,
  getKumoInsideConsolidation,
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

// F11: Natural-target lookback scales with timeframe.  Higher TFs pack more
// price action per bar, so fewer bars are needed to find meaningful structure.
// 15m=30 bars (7.5h), 1h=20 bars (20h ≈ 3 days), daily=15 bars (3 weeks).
// Default (unknown TF) = 30 for backward compat.
const NATURAL_TARGET_LOOKBACK = 30;
const TF_LOOKBACK = {
  '15minute': 30,
  '60minute': 20,
  '4h':       18,
  'day':      15,
};

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
function _naturalTarget(candles, signal, entry, interval) {
  const lookback = TF_LOOKBACK[interval] ?? NATURAL_TARGET_LOOKBACK;
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;

  // Exclude the current bar so live ticks during pattern formation don't pin
  // the swing to the entry itself.
  const end   = candles.length - 1;
  const start = Math.max(0, end - lookback);

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
function computeSLTarget(patternId, signal, result, candles, interval) {
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
    // R11: kumo-base-entry needs a wider fallback (1% or 1×ATR) because cloud-entry
    // trades inherently have more volatility than surface-level patterns.
    const isBaseEntry = patternId === 'kumo-base-entry';
    const pctSl       = close * (isBaseEntry ? 0.01 : 0.005);
    const atrFallback = atr != null ? (isBaseEntry ? atr : atrFloor) : null;
    const slDistance   = atrFallback != null ? Math.max(pctSl, atrFallback) : pctSl;
    sl = signal === 'bullish' ? close - slDistance : close + slDistance;
  }

  // Safety: SL must sit on the correct side of close
  if (signal === 'bullish' && sl >= close) sl = close * 0.995;
  if (signal === 'bearish' && sl <= close) sl = close * 1.005;

  // F3: ATR floor — widen SL if it's tighter than 0.5×ATR.
  // Widen from the SL anchor (not from close) so the stop stays anchored to
  // the structural level and simply gets pushed a bit further beyond it.
  if (atrFloor != null) {
    const naturalDist = Math.abs(close - sl);
    if (naturalDist < atrFloor) {
      const deficit = atrFloor - naturalDist;
      sl = signal === 'bullish' ? sl - deficit : sl + deficit;
    }
  }

  // F9: Reversal patterns (cloud-exit) default to 1.5:1 instead of 2:1.
  // Cloud exits are trend-reversal trades — the price has to traverse the cloud
  // (strong resistance) so the probability of a full 2:1 payoff is lower.
  const isReversal     = patternId === 'cloud-exit';
  const targetMultiple = isReversal ? 1.5 : 2;

  // ── Target — max(N×risk, recentSwing, ichimokuLevel) in the favourable direction
  const risk        = Math.abs(close - sl);
  const fixedTarget = signal === 'bullish' ? close + targetMultiple * risk : close - targetMultiple * risk;

  let target       = fixedTarget;
  let targetSource = 'fixed';

  // F7: Ichimoku-based target candidates for cloud-penetration patterns.
  // For kumo-base-entry and kumo-breakout, the opposite cloud edge (the side
  // price is heading toward) is a natural structural target — it's where
  // supply/demand will next resist the move.
  if ((patternId === 'kumo-base-entry' || patternId === 'kumo-breakout') && cloudTop != null && cloudBottom != null) {
    const ichTarget = signal === 'bullish' ? cloudTop : cloudBottom;
    // Only use if the Ichimoku target is further than the fixed target
    if (signal === 'bullish' && ichTarget > target) {
      target       = ichTarget;
      targetSource = 'ichimoku';
    } else if (signal === 'bearish' && ichTarget < target) {
      target       = ichTarget;
      targetSource = 'ichimoku';
    }
  }

  const swing = candles ? _naturalTarget(candles, signal, close, interval) : null;
  if (swing != null) {
    if (signal === 'bullish' && swing > target) {
      target       = swing;
      targetSource = 'swing';
    } else if (signal === 'bearish' && swing < target) {
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
 * Bullish setup:
 *   - Tenkan (green) must be ABOVE Kijun (red)
 *   - Current price must be ABOVE Kijun
 *
 * Bearish setup:
 *   - Kijun (red) must be ABOVE Tenkan (green)
 *   - Current price must be BELOW Kijun
 *
 * Returns true when the lines agree with the signal direction,
 * or when tenkan/kijun are unavailable (fail-open so we never
 * silently swallow signals when ichimoku.js return shape changes).
 */
function _tkAligned(result) {
  const { signal, tenkan, kijun, close } = result;
  if (tenkan == null || kijun == null) return true; // fail-open: data unavailable

  if (signal === 'bullish') {
    // Tenkan > Kijun AND price > Kijun
    if (tenkan <= kijun) return false;
    if (close != null && close <= kijun) return false;
    return true;
  }

  if (signal === 'bearish') {
    // Kijun > Tenkan AND price < Kijun
    if (kijun <= tenkan) return false;
    if (close != null && close >= kijun) return false;
    return true;
  }

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
    maxScore:    5,
    // lookback:3 — breakout must have occurred within the last 3 closed candles.
    // lookback:1 (the crossover on the EXACT current candle) combined with TK alignment
    // as a hard filter produced near-zero matches in production.  A 3-bar window
    // still identifies fresh breakouts (not stale trends) while being realistic.
    defaultOpts: { lookback: 3 },

    run(candles, opts = {}) {
      const result = getKumoBreakout(candles, { ...this.defaultOpts, ...opts });
      if (!result) return { matched: false };
      if (result.signal === null) return { matched: false };
      // TK alignment: bullish requires tenkan > kijun, bearish requires kijun > tenkan
      if (!_tkAligned(result)) return { matched: false };

      const { close, cloudTop, cloudBottom, signal } = result;

      if (cloudTop == null || cloudBottom == null) return { matched: false };

      // Kumo Breakout:
      // - Bullish: Price broke ABOVE cloud → SL at cloudBottom, Target ahead (swing high)
      // - Bearish: Price broke BELOW cloud → SL at cloudTop, Target ahead (swing low)
      const atr = getATR(candles, 14);

      // SL = far cloud edge (price must traverse whole cloud to invalidate)
      let sl = signal === 'bullish' ? cloudBottom : cloudTop;

      // Apply buffer to SL
      const pctBuf = sl * SL_ANCHOR_BUFFER_PCT;
      const atrBuf = atr != null ? SL_ANCHOR_BUFFER_ATR * atr : 0;
      const buf = Math.max(pctBuf, atrBuf);
      sl = signal === 'bullish' ? sl - buf : sl + buf;

      // Validate: SL must be on correct side of entry
      if (signal === 'bullish' && sl >= close) return { matched: false };
      if (signal === 'bearish' && sl <= close) return { matched: false };

      // Target: Use natural swing target (next resistance/support level)
      // If no natural target found, use ATR-based projection
      let target = _naturalTarget(candles, signal, close, opts.interval);
      let targetSource = 'swing';

      if (target == null && atr != null) {
        // Fallback: 2× ATR projection from entry
        const atrMult = 2.0;
        target = signal === 'bullish'
          ? close + atrMult * atr
          : close - atrMult * atr;
        targetSource = 'atr';
      }

      if (target == null) return { matched: false };

      // Final validation
      if (signal === 'bullish' && target <= close) return { matched: false };
      if (signal === 'bearish' && target >= close) return { matched: false };

      sl = Math.round(sl * 100) / 100;
      const targetRounded = Math.round(target * 100) / 100;

      const trailingAnchor = result.tenkan ?? null;
      return {
        matched: true,
        ...result,
        sl,
        target: targetRounded,
        atr: atr != null ? Math.round(atr * 100) / 100 : null,
        targetSource,
        trailingAnchor,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'kumo-inside-consolidation': {
    id:          'kumo-inside-consolidation',
    label:       'Kumo Inside Consolidation',
    description: 'Price is INSIDE a thick cloud and consolidating in a tight range — coiling for a breakout. TK alignment determines bias. Thick cloud = strong barrier, tight range = energy building.',
    maxScore:    5,
    defaultOpts: {
      consLookback:     10,    // bars to measure consolidation range
      consRatio:        2.0,   // max range = 2× ATR (tight)
      minCloudWidthPct: 0.01,  // 1% cloud width minimum
      minCloudWidthAtr: 1.5,   // 1.5× ATR cloud width minimum (BOTH must pass)
    },

    run(candles, opts = {}) {
      const result = getKumoInsideConsolidation(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };

      const { close, cloudTop, cloudBottom, signal, atr, cloudWidth, consRange } = result;

      if (cloudTop == null || cloudBottom == null || close == null) return { matched: false };

      // SL = opposite cloud edge (if bullish expecting upside breakout, SL at cloudBottom)
      let sl = signal === 'bullish' ? cloudBottom : cloudTop;

      // Apply buffer to SL
      const pctBuf = sl * SL_ANCHOR_BUFFER_PCT;
      const atrBuf = atr != null ? SL_ANCHOR_BUFFER_ATR * atr : 0;
      const buf = Math.max(pctBuf, atrBuf);
      sl = signal === 'bullish' ? sl - buf : sl + buf;

      // Target = breakout through opposite cloud edge + extension
      // Use natural swing target beyond the cloud, or ATR projection
      let target = _naturalTarget(candles, signal, close, opts.interval);
      let targetSource = 'swing';

      if (target == null && atr != null) {
        // Fallback: cloud edge + 1× ATR extension
        const cloudEdge = signal === 'bullish' ? cloudTop : cloudBottom;
        target = signal === 'bullish'
          ? cloudEdge + atr
          : cloudEdge - atr;
        targetSource = 'cloud+atr';
      }

      if (target == null) return { matched: false };

      // Validate directions
      if (signal === 'bullish' && (target <= close || sl >= close)) return { matched: false };
      if (signal === 'bearish' && (target >= close || sl <= close)) return { matched: false };

      sl = Math.round(sl * 100) / 100;
      const targetRounded = Math.round(target * 100) / 100;

      const trailingAnchor = result.tenkan ?? null;
      return {
        matched: true,
        ...result,
        sl,
        target: targetRounded,
        atr: atr != null ? Math.round(atr * 100) / 100 : null,
        targetSource,
        trailingAnchor,
        cloudWidth,
        consRange,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'kumo-bounce': {
    id:          'kumo-bounce',
    label:       'Kumo Bounce',
    description: 'Price pulled back to the cloud edge from outside and reversed on the current candle. Bullish when price tests cloudTop from above; bearish when testing cloudBottom from below. Only fires on wide clouds (strong S/R).',
    maxScore:    5,
    // minCloudWidthPct: 0.5% minimum cloud width relative to price
    // minCloudWidthAtr: 0.5× ATR minimum cloud width (alternative measure)
    // A wide cloud = strong support/resistance; thin cloud = weak, easily broken
    defaultOpts: { lookback: 1, tolerance: 0.005, minCloudWidthPct: 0.005, minCloudWidthAtr: 0.5 },

    run(candles, opts = {}) {
      const result = getKumoBounce(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };

      const { cloudTop, cloudBottom, close } = result;

      // Cloud width filter — only bounce off WIDE clouds (strong S/R)
      // Thin clouds are weak and easily broken through
      if (cloudTop != null && cloudBottom != null && close != null) {
        const cloudWidth = Math.abs(cloudTop - cloudBottom);
        const atr = getATR(candles, 14);

        // Check percentage-based width
        const minWidthPct = opts.minCloudWidthPct ?? 0.005; // 0.5% default
        const pctWidth = cloudWidth / close;
        if (pctWidth < minWidthPct) return { matched: false };

        // Check ATR-based width (if ATR available)
        if (atr != null) {
          const minWidthAtr = opts.minCloudWidthAtr ?? 0.5; // 0.5× ATR default
          if (cloudWidth < minWidthAtr * atr) return { matched: false };
        }
      }

      // R3: Wick-penetration requirement — a true bounce shows a wick INTO the cloud
      // Bullish: low should have dipped to/below cloudTop; Bearish: high should have reached cloudBottom
      if (result.signal === 'bullish' && cloudTop != null) {
        const lastCandle = candles[candles.length - 1];
        if (lastCandle.low > cloudTop) return { matched: false }; // wick never touched cloud
      }
      if (result.signal === 'bearish' && cloudBottom != null) {
        const lastCandle = candles[candles.length - 1];
        if (lastCandle.high < cloudBottom) return { matched: false }; // wick never touched cloud
      }

      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles, opts.interval);
      const trailingAnchor = result.tenkan ?? null;

      // Add cloud width info to result for visibility
      const cloudWidth = (cloudTop != null && cloudBottom != null) ? Math.abs(cloudTop - cloudBottom) : null;

      return {
        matched: true,
        ...result,
        sl, target, atr, targetSource, trailingAnchor,
        cloudWidth: cloudWidth != null ? Math.round(cloudWidth * 100) / 100 : null,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'cloud-support': {
    id:          'cloud-support',
    label:       'Cloud Support / Resistance',
    description: 'Price is above (bullish) or below (bearish) the cloud with a recent pullback toward the cloud edge as entry trigger. Score 0–5 includes TK order, Chikou, and duration.',
    maxScore:    5,
    defaultOpts: { minBars: 3, maxBars: 5 },

    run(candles, opts = {}) {
      const { maxBars, ...icOpts } = { ...this.defaultOpts, ...opts };
      const result = getCloudSupport(candles, icOpts);
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };
      if (result.consecutiveBars > maxBars) return { matched: false };
      if (result.score < 3) return { matched: false };
      // P5: Require an entry trigger — a recent pullback toward the cloud edge.
      // Without this, cloud-support fires on every bar where a trend is in place.
      if (!result.hasEntryTrigger) return { matched: false };
      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles, opts.interval);
      const trailingAnchor = result.tenkan ?? null;
      return { matched: true, ...result, sl, target, atr, targetSource, trailingAnchor, ..._volumeFields(candles), ..._rsiFields(candles) };
    },
  },

  'kumo-base-entry': {
    id:          'kumo-base-entry',
    label:       'Kumo Base Entry',
    description: 'Price consolidated in a tight base just outside a fat cloud, then freshly entered the cloud from the near edge. Fat cloud = strong resistance to traverse (meaningful move expected). SL anchors below the base low (bullish) or above the base high (bearish). Requires BOTH 1% width AND 1.5× ATR.',
    maxScore:    5,
    defaultOpts: {
      consLookback:     10,
      consRatio:        2.5,
      minConsBars:      3,
      posThreshold:     0.4,
      entryLookback:    3,
      // Strict fat cloud requirement — BOTH checks must pass
      minCloudWidthPct: 0.01,   // 1% of price
      minCloudWidthAtr: 1.5,    // 1.5× ATR
    },

    run(candles, opts = {}) {
      const result = getKumoBaseEntry(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      // TK alignment: bullish requires tenkan > kijun, bearish requires kijun > tenkan
      if (!_tkAligned(result)) return { matched: false };

      // Strict cloud width check — BOTH percentage AND ATR checks must pass
      const { cloudTop, cloudBottom, close } = result;
      if (cloudTop != null && cloudBottom != null && close != null) {
        const cloudWidth = Math.abs(cloudTop - cloudBottom);
        const atr = getATR(candles, 14);

        // Must pass percentage check (1%)
        const minWidthPct = opts.minCloudWidthPct ?? 0.01;
        if (cloudWidth / close < minWidthPct) return { matched: false };

        // Must ALSO pass ATR check (1.5× ATR)
        if (atr != null) {
          const minWidthAtr = opts.minCloudWidthAtr ?? 1.5;
          if (cloudWidth < minWidthAtr * atr) return { matched: false };
        }
      }

      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles, opts.interval);
      const trailingAnchor = result.tenkan ?? null;

      // Add cloud width info to result
      const cloudWidth = (cloudTop != null && cloudBottom != null) ? Math.abs(cloudTop - cloudBottom) : null;

      return {
        matched: true,
        ...result,
        sl, target, atr, targetSource, trailingAnchor,
        cloudWidth: cloudWidth != null ? Math.round(cloudWidth * 100) / 100 : null,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'kijun-bounce': {
    id:          'kijun-bounce',
    label:       'Kijun Support / Resistance',
    description: 'Price tested the Kijun-sen (base line) as support (bullish) or resistance (bearish) within the last 2–3 candles — wick touched the level, close must not break through. Requires sufficient TK spread for momentum.',
    maxScore:    4,
    // minTkSpreadPct: 0.3% minimum distance between Tenkan and Kijun
    // minTkSpreadAtr: 0.2× ATR minimum TK spread
    // If TK are too close, there's no momentum — bounce won't have room to move
    defaultOpts: { lookback: 3, tolerance: 0.003, minTkSpreadPct: 0.003, minTkSpreadAtr: 0.2 },

    run(candles, opts = {}) {
      const result = getKijunLevel(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      if (!_tkAligned(result)) return { matched: false };

      const { tenkan, kijun, kijunValue, close } = result;
      const kijunLevel = kijun ?? kijunValue;

      // TK Spread filter — Tenkan and Kijun must have enough distance
      // If they're too close, there's no momentum for the bounce
      if (tenkan != null && kijunLevel != null && close != null) {
        const tkSpread = Math.abs(tenkan - kijunLevel);
        const atr = getATR(candles, 14);

        // Check percentage-based spread
        const minSpreadPct = opts.minTkSpreadPct ?? 0.003; // 0.3% default
        const pctSpread = tkSpread / close;
        if (pctSpread < minSpreadPct) return { matched: false };

        // Check ATR-based spread (if ATR available)
        if (atr != null) {
          const minSpreadAtr = opts.minTkSpreadAtr ?? 0.2; // 0.2× ATR default
          if (tkSpread < minSpreadAtr * atr) return { matched: false };
        }
      }

      // P7: Cloud position hard filter — kijun bounce against the cloud is counter-trend.
      // Bullish bounce requires price above cloud; bearish requires below cloud.
      // Allow 'inside' cloud (transitional) but reject wrong-side bounces.
      if (result.signal === 'bullish' && result.cloudPosition === 'below') return { matched: false };
      if (result.signal === 'bearish' && result.cloudPosition === 'above') return { matched: false };

      // R6: Kijun slope direction check — a falling Kijun on bullish bounce means
      // the baseline is weakening, which fights momentum.
      if (result.kijunSlopeOk === false) return { matched: false };

      const { sl, target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles, opts.interval);
      const trailingAnchor = kijunLevel ?? null;

      // Add TK spread info to result for visibility
      const tkSpread = (tenkan != null && kijunLevel != null) ? Math.abs(tenkan - kijunLevel) : null;

      return {
        matched: true,
        ...result,
        sl, target, atr, targetSource, trailingAnchor,
        tkSpread: tkSpread != null ? Math.round(tkSpread * 100) / 100 : null,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'cloud-exit': {
    id:          'cloud-exit',
    label:       'Kumo Crossover',
    description: 'Price was on one side of the cloud for a long run and has crossed through to the other side for the first time — trend reversal signal.',
    maxScore:    5,
    defaultOpts: { lookback: 5, minRunBars: 5, scanBars: 40 },

    run(candles, opts = {}) {
      const result = getCloudExit(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.matched) return { matched: false };
      // TK alignment: bullish requires tenkan > kijun, bearish requires kijun > tenkan
      if (!_tkAligned(result)) return { matched: false };

      // R7: Volume check on exit candle — cloud exit on low volume fails ~50% of the time
      const volFields = _volumeFields(candles);
      if (volFields.volumeRatio != null && volFields.volumeRatio < 1.0) return { matched: false };

      // Use computeSLTarget for target, then override SL to the exit edge
      const { target, atr, targetSource } = computeSLTarget(this.id, result.signal, result, candles, opts.interval);

      // SL = the cloud edge price just crossed + buffer
      // (going back into the cloud = reversal failed)
      let sl = result.exitEdge;
      if (sl != null) {
        const atrVal = atr ?? 0;
        const pctBuf = sl * SL_ANCHOR_BUFFER_PCT;
        const atrBuf = atrVal > 0 ? SL_ANCHOR_BUFFER_ATR * atrVal : 0;
        const buf    = Math.max(pctBuf, atrBuf);
        sl = result.signal === 'bearish' ? sl + buf : sl - buf;
      }

      // F1: ATR floor — cloud-exit was missing this; thin clouds produce tight stops
      const close = result.close;
      if (sl != null && atr != null && close) {
        const atrFloor    = MIN_SL_ATR_MULT * atr;
        const naturalDist = Math.abs(close - sl);
        if (naturalDist < atrFloor) {
          // F3: Widen from the anchor (exitEdge), not from close
          const anchor    = result.exitEdge ?? sl;
          const deficit   = atrFloor - Math.abs(close - anchor);
          sl = result.signal === 'bearish'
            ? anchor + Math.abs(close - anchor) + deficit
            : anchor - Math.abs(anchor - close) - deficit;
        }
      }
      // Safety: SL must sit on the correct side
      if (sl != null && close) {
        if (result.signal === 'bullish' && sl >= close) sl = close * 0.995;
        if (result.signal === 'bearish' && sl <= close) sl = close * 1.005;
      }
      sl = sl != null ? Math.round(sl * 100) / 100 : null;

      const trailingAnchor = result.tenkan ?? null;
      return { matched: true, ...result, sl, target, atr, targetSource, trailingAnchor, ...volFields, ..._rsiFields(candles) };
    },
  },

  'kijun-retest': {
    id:          'kijun-retest',
    label:       'Kijun Retest',
    description: 'After a kumo crossover, price pulls back to retest the Kijun-sen — wick touches Kijun but close stays on the trend side. Confirms Kijun as new support/resistance.',
    maxScore:    5,
    defaultOpts: { lookback: 3, crossoverScan: 20, tolerance: 0.003 },

    run(candles, opts = {}) {
      const result = getKijunRetest(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.matched) return { matched: false };
      // TK alignment: bullish requires tenkan > kijun, bearish requires kijun > tenkan
      if (!_tkAligned(result)) return { matched: false };
      // SL = Kijun itself (if price closes through it, the retest failed)
      const { sl, target, atr, targetSource } = computeSLTarget('kijun-bounce', result.signal, result, candles, opts.interval);
      const trailingAnchor = result.kijun ?? result.kijunValue ?? null;
      return { matched: true, ...result, sl, target, atr, targetSource, trailingAnchor, ..._volumeFields(candles), ..._rsiFields(candles) };
    },
  },

  'tk-reversion': {
    id:          'tk-reversion',
    label:       'TK Reversion',
    description: 'After a fast move widened the Tenkan–Kijun spread (min 5% gap), price crosses Tenkan in the direction of Kijun — mean reversion toward Kijun or cloud.',
    maxScore:    5,
    defaultOpts: { lookback: 3, minSpreadPct: 5.0, spreadLookback: 10 },

    run(candles, opts = {}) {
      const result = getTKReversion(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.matched) return { matched: false };

      // R8: Only allow trades moving TOWARD Kijun from the extended side.
      // Bearish reversion while below cloud = fighting the primary trend for a small
      // TK spread contraction. Only allow inside-cloud or toward-cloud reversions.
      if (result.signal === 'bearish' && result.cloudPosition === 'below') return { matched: false };
      if (result.signal === 'bullish' && result.cloudPosition === 'above') return { matched: false };

      // New TK Reversion Logic:
      // Entry = Tenkan line (result.close already set to tenkan in getTKReversion)
      // SL = wick extreme (result.slPrice)
      // Target = Kijun (the reversion destination)

      const { signal, kijun } = result;
      const close = result.close;        // Entry at Tenkan line
      const sl = result.slPrice;         // SL at wick extreme
      const atr = getATR(candles, 14);

      // Apply small buffer to SL for safety
      const pctBuf = sl * SL_ANCHOR_BUFFER_PCT;
      const atrBuf = atr != null ? SL_ANCHOR_BUFFER_ATR * atr : 0;
      const slWithBuffer = signal === 'bullish'
        ? sl - Math.max(pctBuf, atrBuf)
        : sl + Math.max(pctBuf, atrBuf);

      const slFinal = Math.round(slWithBuffer * 100) / 100;

      // Target = closer of Kijun or cloud edge (first obstacle in reversion direction)
      //   Bullish (reverting UP):   target = min(kijun, cloudBottom) — whichever is nearer above
      //   Bearish (reverting DOWN): target = max(kijun, cloudTop)   — whichever is nearer below
      const risk = Math.abs(close - slFinal);
      const { cloudTop, cloudBottom } = result;

      // Collect valid target candidates on the correct side of close
      const candidates = [];
      if (signal === 'bullish') {
        if (kijun > close)       candidates.push({ level: kijun,       source: 'kijun' });
        if (cloudBottom > close) candidates.push({ level: cloudBottom, source: 'cloud' });
      } else {
        if (kijun < close)       candidates.push({ level: kijun,       source: 'kijun' });
        if (cloudTop < close)    candidates.push({ level: cloudTop,    source: 'cloud' });
      }

      let target, targetSource;
      if (candidates.length > 0) {
        // Pick the closer one (first obstacle price will hit)
        candidates.sort((a, b) => Math.abs(a.level - close) - Math.abs(b.level - close));
        target       = candidates[0].level;
        targetSource = candidates[0].source;
      } else {
        // Neither Kijun nor cloud on the correct side — fallback to 2× risk
        target       = signal === 'bearish' ? close - 2 * risk : close + 2 * risk;
        targetSource = 'fixed';
      }

      // Ensure at least 1:1 R:R — if the natural target is too close, use 2× risk
      if (Math.abs(target - close) < risk) {
        target       = signal === 'bearish' ? close - 2 * risk : close + 2 * risk;
        targetSource = 'fixed';
      }
      target = Math.round(target * 100) / 100;

      const trailingAnchor = result.tenkan ?? null;
      return {
        matched: true,
        ...result,
        sl: slFinal,
        target,
        atr: atr != null ? Math.round(atr * 100) / 100 : null,
        targetSource,
        trailingAnchor,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
    },
  },

  'kumo-senkou-cross': {
    id:          'kumo-senkou-cross',
    label:       'Senkou Cross Confirmation',
    description: 'Cloud color changed (Senkou A/B cross) within the last 5 bars while price was already outside the cloud — triple confirmation: current trend, future cloud just aligned, momentum agrees.',
    maxScore:    5,
    // lookback:5 — the twist must be fresh. A 5-bar-old twist on a 1h chart is
    // 5 hours old; on a 4h chart it's 20 hours. Both are still "fresh" structurally.
    // minCloudWidthPct:0.003 — 0.3% minimum cloud width to skip razor-thin twist noise.
    defaultOpts: { lookback: 5, minCloudWidthPct: 0.003 },

    run(candles, opts = {}) {
      const result = getSenkouCross(candles, { ...this.defaultOpts, ...opts });
      if (!result || !result.signal) return { matched: false };
      // TK alignment: bullish requires tenkan > kijun, bearish requires kijun > tenkan
      if (!_tkAligned(result)) return { matched: false };

      const { sl, target, atr, targetSource } = computeSLTarget(
        this.id, result.signal, result, candles, opts.interval,
      );

      // Trailing anchor = Tenkan (fast line; cloud is too far below to trail on)
      const trailingAnchor = result.tenkan ?? null;

      return {
        matched: true,
        ...result,
        sl, target, atr, targetSource, trailingAnchor,
        ..._volumeFields(candles),
        ..._rsiFields(candles),
      };
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
  return Object.values(PATTERNS).map(({ id, label, description, defaultOpts, maxScore }) => ({
    id,
    label,
    description,
    defaultOpts,
    // R13: maxScore enables normalized cross-pattern comparison: score/maxScore
    maxScore: maxScore ?? 5,
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
