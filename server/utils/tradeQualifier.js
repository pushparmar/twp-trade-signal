/**
 * tradeQualifier.js
 * Position sizing and risk calculation for NSE and MCX trades
 */

function _round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Per-exchange sizing:
 *   NSE → risk-based.  quantity = floor(riskPerTrade / riskPerUnit).
 *         Example: entry=100, sl=95 → 10000/5 = 2000 shares (risk ≈ ₹10k).
 *         Must clear minProfit (e.g. ≥₹20k expected gain on target).
 *   MCX → lot-based.  quantity = lotSize (1 lot of the commodity contract).
 *         No R:R or profit gate — every signal trades 1 lot.
 *
 * @param {number} entry         Entry price
 * @param {number} sl            Stop-loss from the pattern engine
 * @param {number} target        Target from the pattern engine
 * @param {object} settings      autoTrader settings (riskPerTrade, minProfit, minRR)
 * @param {string} exchange      'NSE' | 'MCX'
 * @param {number} lotSize       Exchange lot size (used for MCX)
 * @returns {{ quantity, riskPerUnit, potentialProfit, rrRatio, lotSize? } | null}
 */
function qualifyTrade(entry, sl, target, settings, exchange, lotSize) {
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return null;

  const rrRatio = Math.abs(target - entry) / riskPerUnit;
  const isMcx   = exchange === 'MCX';

  if (isMcx) {
    // Gate on minRR — same rule as NSE.  A Natural Gas signal with a 1:1.5 R:R
    // should be skipped just like any equity signal.
    if (rrRatio < settings.minRR) return null;

    // MCX trades 1 lot.  potentialProfit is in ₹ (price move × contract lot size).
    const contractLotSize = lotSize || 1;
    return {
      quantity:        1,                 // number of lots
      lotSize:         contractLotSize,   // stored so closePaperTrade can apply it
      riskPerUnit:     _round2(riskPerUnit),
      potentialProfit: _round2(Math.abs(target - entry) * contractLotSize),
      rrRatio:         _round2(rrRatio),
    };
  }

  // NSE: size by ₹riskPerTrade, gate on minProfit.
  const quantity        = Math.max(1, Math.floor(settings.riskPerTrade / riskPerUnit));
  const potentialProfit = Math.abs(target - entry) * quantity;
  if (potentialProfit < settings.minProfit) return null;

  return {
    quantity,
    riskPerUnit:     _round2(riskPerUnit),
    potentialProfit: _round2(potentialProfit),
    rrRatio:         _round2(rrRatio),
  };
}

module.exports = { qualifyTrade };
