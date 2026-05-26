/**
 * Signal Quality Scorer (0–10)
 *
 * A second, richer quality score that combines 7 Ichimoku factors the pattern
 * score (0–5) doesn't cover. Used as a gate layer: trades scoring 7+ are
 * "A setups", 5–6 are "B setups", below 5 are skipped.
 *
 * Zero impact on TSL/SL/target logic — purely a quality gate.
 *
 * Factors (max 11 raw, capped at 10):
 *   +2  Price above/below cloud (aligns with signal direction)
 *   +2  Cloud expanding (current width > 5-bar-ago width × 1.05)
 *   +1  Kijun angled strongly in signal direction (slope > 0.1% of close)
 *   +2  Chikou free space (close vs candle[n-26] high/low)
 *   +1  RSI in ideal zone (reuses RSI filter config ranges)
 *   +2  Higher TF aligned (cloud position on next higher interval) — weighted +2
 *   +1  Volume supportive (volumeRatio ≥ 1.2)
 *
 * Pattern-specific quality bonus (R14):
 *   kumo-base-entry and kijun-retest get +1 built-in bonus as the
 *   highest-conviction setups in the system.
 *
 * Output: { qualityScore: 0–10, setupGrade: 'A'|'B'|'C', scoreBreakdown: {...} }
 */

const candleStore = require('./candleStore');
const { calculate } = require('./ichimoku');

// Higher timeframe map — covers both index-trade and main scanner intervals
const HTF_MAP = {
  minute:    '5minute',
  '5minute': '15minute',
  '15minute':'60minute',
  '60minute':'day',
  '4h':      'day',
};

// Patterns that receive a built-in quality bonus (R14)
// kumo-senkou-cross: triple Ichimoku confirmation (trend + future cloud + momentum)
const QUALITY_BONUS_PATTERNS = new Set(['kumo-base-entry', 'kijun-retest', 'kumo-senkou-cross']);

/**
 * Compute the quality score for a signal.
 *
 * @param {number|string} token       Instrument token
 * @param {object[]}      candles     Candle array used for the pattern
 * @param {object}        result      Pattern result (must have .signal, .rsi14, .volumeConfirmed)
 * @param {string}        interval    Candle interval (e.g. '15minute', '60minute')
 * @param {object}        config      Quality score config from store
 * @param {string}        [patternId] Pattern ID for bonus calculation
 * @returns {{ qualityScore: number, setupGrade: string, scoreBreakdown: object }}
 */
function compute(token, candles, result, interval, config, patternId) {
  const series = calculate(candles);
  if (!series || series.length < 30) {
    return { qualityScore: 0, setupGrade: 'C', scoreBreakdown: {} };
  }

  const n      = series.length - 1;
  const last   = series[n];
  const isBull = result.signal === 'bullish';
  const breakdown = {
    priceVsCloud:   0,
    cloudExpanding: 0,
    kijunAngle:     0,
    chikouFree:     0,
    rsiZone:        0,
    htfAligned:     0,
    volume:         0,
    patternBonus:   0,
  };

  // 1. Price vs cloud (+2)
  if (isBull && last.aboveCloud) breakdown.priceVsCloud = 2;
  if (!isBull && last.belowCloud) breakdown.priceVsCloud = 2;

  // 2. Cloud expanding (+2) — P2: threshold of 5% expansion, not just any increase
  const CLOUD_LB = 5;
  const prevIdx   = Math.max(0, n - CLOUD_LB);
  const curWidth  = (last.cloudTop  ?? 0) - (last.cloudBottom  ?? 0);
  const prevWidth = (series[prevIdx].cloudTop ?? 0) - (series[prevIdx].cloudBottom ?? 0);
  if (prevWidth > 0 && curWidth > prevWidth * 1.05) breakdown.cloudExpanding = 2;
  // Also award if cloud was zero/negative before and now has meaningful width
  if (prevWidth <= 0 && curWidth > 0) breakdown.cloudExpanding = 2;

  // 3. Kijun angled in signal direction (+1) — P3: minimum 0.1% slope threshold
  const KIJUN_LB  = 5;
  const kijunPrev = series[Math.max(0, n - KIJUN_LB)].kijun ?? last.kijun;
  const kijunNow  = last.kijun ?? kijunPrev;
  if (kijunPrev != null && kijunNow != null && last.close > 0) {
    const slopeRatio = (kijunNow - kijunPrev) / last.close;
    const MIN_SLOPE  = 0.001; // 0.1% of close
    if (isBull  && slopeRatio > MIN_SLOPE)  breakdown.kijunAngle = 1;
    if (!isBull && slopeRatio < -MIN_SLOPE) breakdown.kijunAngle = 1;
  }

  // 4. Chikou free space (+2)
  const CHIKOU_LB = 26;
  if (n >= CHIKOU_LB) {
    const pastCandle = candles[n - CHIKOU_LB];
    if (pastCandle) {
      if (isBull  && last.close > pastCandle.high) breakdown.chikouFree = 2;
      if (!isBull && last.close < pastCandle.low)  breakdown.chikouFree = 2;
    }
  }

  // 5. RSI ideal zone (+1) — reuses existing RSI filter config ranges
  const rsi = result.rsi14;
  if (rsi != null) {
    const rsiMin = isBull ? (config.rsiBullishMin ?? 50) : (config.rsiBearishMin ?? 35);
    const rsiMax = isBull ? (config.rsiBullishMax ?? 65) : (config.rsiBearishMax ?? 50);
    if (rsi >= rsiMin && rsi <= rsiMax) breakdown.rsiZone = 1;
  }

  // 6. Higher timeframe aligned (+2) — P4: increased from +1, most important factor
  const htfInterval = HTF_MAP[interval];
  if (htfInterval) {
    try {
      const htfCandles = candleStore.getCandlesSync(Number(token), htfInterval);
      if (htfCandles && htfCandles.length >= 52) {
        const htfSeries = calculate(htfCandles);
        if (htfSeries && htfSeries.length > 0) {
          const htfLast = htfSeries[htfSeries.length - 1];
          if (isBull  && htfLast.aboveCloud) breakdown.htfAligned = 2;
          if (!isBull && htfLast.belowCloud) breakdown.htfAligned = 2;
        }
      }
    } catch {
      // Graceful skip — no +2 if HTF candles unavailable
    }
  }

  // 7. Volume supportive (+1)
  if (result.volumeConfirmed) breakdown.volume = 1;

  // R14: Pattern-specific quality bonus (+1 for highest-conviction setups)
  if (patternId && QUALITY_BONUS_PATTERNS.has(patternId)) {
    breakdown.patternBonus = 1;
  }

  const rawScore = Object.values(breakdown).reduce((s, v) => s + v, 0);
  const qualityScore = Math.min(10, rawScore);
  const aMin = config.aSetupMinScore ?? 7;
  const setupGrade = qualityScore >= aMin ? 'A' : qualityScore >= 5 ? 'B' : 'C';

  return { qualityScore, setupGrade, scoreBreakdown: breakdown };
}

module.exports = { compute };
