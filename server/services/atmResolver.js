const kiteService = require('./kiteService');
const instrumentCache = require('./instrumentCache');

const INDEX_CONFIG = {
  NIFTY:     { ltpSymbol: 'NSE:NIFTY 50',   exchange: 'NFO', name: 'NIFTY',     step: 50  },
  BANKNIFTY: { ltpSymbol: 'NSE:NIFTY BANK', exchange: 'NFO', name: 'BANKNIFTY', step: 100 },
  SENSEX:    { ltpSymbol: 'BSE:SENSEX',      exchange: 'BFO', name: 'SENSEX',    step: 100 },
};

/**
 * Resolve ATM CE or PE instrument for an index at current price.
 *
 * @param {string} index     - 'NIFTY' | 'BANKNIFTY' | 'SENSEX'
 * @param {string} optionType - 'CE' | 'PE'
 * @returns {object} { index, optionType, ltp, atmStrike, instrument }
 */
async function resolve(index, optionType) {
  const cfg = INDEX_CONFIG[String(index).toUpperCase()];
  if (!cfg) throw new Error(`Unknown index: ${index}. Use NIFTY, BANKNIFTY or SENSEX`);
  if (optionType !== 'CE' && optionType !== 'PE') throw new Error('optionType must be CE or PE');
  if (!instrumentCache.isLoaded()) throw new Error('Instrument cache not loaded — authenticate Kite first');

  // Get current LTP of the index
  let ltp = null;
  try {
    const ltpData = await kiteService.getLTP([cfg.ltpSymbol]);
    const entry = ltpData[cfg.ltpSymbol] || Object.values(ltpData)[0];
    ltp = entry?.last_price ?? null;
  } catch (e) {
    console.warn(`[ATMResolver] Symbol LTP failed for ${cfg.ltpSymbol}:`, e.message);
  }

  // Fallback: token-based LTP lookup
  if (!ltp) {
    const [ex, sym] = cfg.ltpSymbol.split(':');
    const inst = instrumentCache.getBySymbol(ex, sym);
    if (inst?.instrumentToken) {
      try {
        const tokenLtp = await kiteService.getLTP([String(inst.instrumentToken)]);
        ltp = Object.values(tokenLtp)[0]?.last_price ?? null;
      } catch (e2) {
        console.warn(`[ATMResolver] Token LTP fallback failed for ${index}:`, e2.message);
      }
    }
  }

  if (!ltp) throw new Error(`Could not fetch LTP for ${index}`);

  // Round to nearest ATM strike
  const atmStrike = Math.round(ltp / cfg.step) * cfg.step;

  // Find ATM option in nearest expiry
  const options = instrumentCache.getOptionsByStrike(cfg.name, cfg.exchange, [atmStrike]);
  const instrument = options.find((o) => o.instrumentType === optionType) || null;

  if (!instrument) {
    throw new Error(`No ${optionType} found for ${index} ATM ${atmStrike} in nearest expiry`);
  }

  return {
    index,
    optionType,
    ltp: Math.round(ltp * 100) / 100,
    atmStrike,
    instrument,
  };
}

module.exports = { resolve, INDEX_CONFIG };
