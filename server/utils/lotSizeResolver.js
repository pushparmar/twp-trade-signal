/**
 * lotSizeResolver.js
 * MCX commodity lot size resolution
 */

// MCX commodity lot sizes.
// Longer prefixes MUST come before shorter ones because the lookup does
// startsWith() and returns on first match — SILVERM before SILVER, etc.
// All entries use the mini-contract multiplier so position sizing stays
// manageable on paper trades (e.g. GOLD = 10 units of 10g = 100g total,
// instead of the full 1 kg contract at 100 units).
const MCX_LOT_SIZES = {
  NATGASMINI: 1250, // Natural Gas Mini  — 250 mmBtu
  NATURALGAS: 1250, // Natural Gas (map full symbol → mini size)
  CRUDEOILM: 10,    // Crude Oil Mini    — 10 barrels
  CRUDEOIL: 10,     // Crude Oil (map full symbol → mini size)
  SILVERM: 5,       // Silver Mini       — 5 kg
  SILVER: 5,        // Silver (map full symbol → mini size)
  GOLDM: 10,        // Gold Mini         — 10 units of 10g = 100g
  GOLD: 10,         // Gold (map full symbol → mini size)
};

/**
 * Returns the per-unit lot multiplier for a trade.
 * Priority: trade.lotSize (if set by auto-trader) → MCX symbol map → 1.
 *
 * @param {{ exchange?: string, symbol?: string, lotSize?: number }} trade
 * @returns {number}
 */
function getLotMultiplier(trade) {
  // Prefer an explicitly stored lotSize (set by derivatives/auto-trader logic).
  if (trade.lotSize && trade.lotSize > 1) return trade.lotSize;

  // For MCX paper trades, derive lot size from the commodity name prefix.
  if (trade.exchange === 'MCX' && trade.symbol) {
    const sym = trade.symbol.toUpperCase();
    for (const [name, size] of Object.entries(MCX_LOT_SIZES)) {
      if (sym.startsWith(name)) return size;
    }
  }
  return 1;
}

module.exports = { getLotMultiplier, MCX_LOT_SIZES };
