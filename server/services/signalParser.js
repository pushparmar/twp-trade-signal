/**
 * Signal format from Telegram (4 lines):
 *   Line 1 — symbol        e.g. nifty24550ce
 *   Line 2 — entry price(s) e.g. 216  OR  216,-205  OR  216-205
 *   Line 3 — target(s)      e.g. 289  OR  289-310  OR  289,310
 *   Line 4 — stop loss      e.g. 200
 *
 * NOTE: Only BUY signals are accepted (upward direction).
 * Strict validation: target > entry > sl. Anything else is rejected.
 */

function extractNums(str) {
  return (str.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

function parse(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  // Check for SELL keywords in the message — reject sell signals
  const textLower = text.toLowerCase();
  if (textLower.includes('sell') || textLower.includes('short')) {
    console.log('[SignalParser] ⏭ SELL signal rejected (keyword) — only BUY signals allowed');
    return null;
  }

  const symbol = lines[0].toUpperCase().replace(/\s+/g, '');
  const entries = extractNums(lines[1]);
  const targets = extractNums(lines[2]);           // Line 3 = target(s)
  const slNums  = lines[3] ? extractNums(lines[3]) : [];  // Line 4 = stop loss

  if (!symbol || entries.length === 0 || targets.length === 0) return null;

  const entry = entries[0];
  const target = targets[0];
  const sl = slNums[0] ?? null;

  // STRICT validation: only accept signals where target > entry > sl
  if (target <= entry) {
    console.log(
      `[SignalParser] ⏭ Rejected (target ≤ entry) — ${symbol} ` +
      `entry=₹${entry} target=₹${target} sl=₹${sl}. Need target > entry > sl.`
    );
    return null;
  }

  if (sl !== null && sl >= entry) {
    console.log(
      `[SignalParser] ⏭ Rejected (sl ≥ entry) — ${symbol} ` +
      `entry=₹${entry} target=₹${target} sl=₹${sl}. Need target > entry > sl.`
    );
    return null;
  }

  // Minimum R:R filter — reject signals with reward:risk below 1:2
  if (sl !== null) {
    const risk = entry - sl;
    const reward = target - entry;
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < 2) {
      console.log(
        `[SignalParser] ⏭ Rejected (R:R < 1:2) — ${symbol} ` +
        `entry=₹${entry} target=₹${target} sl=₹${sl} R:R=1:${rr.toFixed(1)}`
      );
      return null;
    }
  }

  return {
    symbol,
    action:  'BUY',
    entries,
    price:   entry,
    sl,
    targets,
    target,
  };
}

module.exports = { parse };
