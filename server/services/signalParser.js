/**
 * Fixed signal format (4 lines):
 *   Line 1 — symbol        e.g. nifty24550ce
 *   Line 2 — entry price(s) e.g. 216  OR  216,-205  OR  216-205
 *   Line 3 — stop loss      e.g. 200
 *   Line 4 — target(s)      e.g. 289  OR  289-310  OR  289,310   (optional)
 *
 * NOTE: Only BUY signals are supported (upward direction).
 * SELL signals are filtered out by:
 *   1. Checking for "sell" or "short" keywords
 *   2. Validating target > entry (upward movement expected)
 *   3. Validating stop loss < entry (downward protection)
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
  const slNums  = extractNums(lines[2]);
  const targets = lines[3] ? extractNums(lines[3]) : [];

  if (!symbol || entries.length === 0 || slNums.length === 0) return null;

  const entry = entries[0];
  const sl = slNums[0];
  const target = targets[0] ?? null;

  // Validate BUY signal structure: target > entry and sl < entry
  // This filters out downward/sell signals where target < entry
  if (target !== null && target <= entry) {
    console.log(
      `[SignalParser] ⏭ SELL signal rejected (target ≤ entry) — ` +
      `${symbol} entry=₹${entry} target=₹${target}. Only upward signals allowed.`
    );
    return null;
  }

  // Additional validation: stop loss should be below entry for BUY
  if (sl >= entry) {
    console.log(
      `[SignalParser] ⏭ Invalid signal rejected (sl ≥ entry) — ` +
      `${symbol} entry=₹${entry} sl=₹${sl}. Stop loss must be below entry for BUY.`
    );
    return null;
  }

  return {
    symbol,
    action:  'BUY',
    entries,               // all entry prices  [216] or [216, 205]
    price:   entry,        // primary entry
    sl,
    targets,               // all targets  [289] or [289, 310]
    target,
  };
}

module.exports = { parse };
