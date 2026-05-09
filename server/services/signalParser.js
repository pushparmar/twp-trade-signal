/**
 * Fixed signal format (4 lines):
 *   Line 1 — symbol        e.g. nifty24550ce
 *   Line 2 — entry price(s) e.g. 216  OR  216,-205  OR  216-205
 *   Line 3 — stop loss      e.g. 200
 *   Line 4 — target(s)      e.g. 289  OR  289-310  OR  289,310   (optional)
 */

function extractNums(str) {
  return (str.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

function parse(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  const symbol = lines[0].toUpperCase().replace(/\s+/g, '');
  const entries = extractNums(lines[1]);
  const slNums  = extractNums(lines[2]);
  const targets = lines[3] ? extractNums(lines[3]) : [];

  if (!symbol || entries.length === 0 || slNums.length === 0) return null;

  return {
    symbol,
    action:  'BUY',
    entries,               // all entry prices  [216] or [216, 205]
    price:   entries[0],   // primary entry
    sl:      slNums[0],
    targets,               // all targets  [289] or [289, 310]
    target:  targets[0] ?? null,
  };
}

module.exports = { parse };
