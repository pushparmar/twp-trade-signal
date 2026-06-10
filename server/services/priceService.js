/**
 * priceService.js
 * Centralized live price (LTP) fetching from Kite API
 */

const kiteService = require('./kiteService');

/**
 * Fetch live LTP for a single instrument
 * @param {string} exchange - 'NSE' | 'MCX' | 'NFO' | 'BSE'
 * @param {string} symbol - Trading symbol
 * @returns {Promise<number|null>} LTP or null if unavailable
 */
async function getLTP(exchange, symbol) {
  try {
    const ltpKey = `${exchange}:${symbol}`;
    const ltpData = await kiteService.getLTP([ltpKey]);
    const price = ltpData[ltpKey]?.last_price;
    return price && price > 0 ? price : null;
  } catch (err) {
    console.warn(`[PriceService] LTP fetch failed for ${exchange}:${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch LTP for multiple instruments at once
 * @param {Array<{exchange: string, symbol: string}>} instruments
 * @returns {Promise<Map<string, number>>} Map of 'EXCHANGE:SYMBOL' → LTP
 */
async function getBatchLTP(instruments) {
  const result = new Map();
  if (!instruments || instruments.length === 0) return result;

  try {
    const keys = instruments.map(inst => `${inst.exchange}:${inst.symbol}`);
    const ltpData = await kiteService.getLTP(keys);

    for (const key of keys) {
      const price = ltpData[key]?.last_price;
      if (price && price > 0) {
        result.set(key, price);
      }
    }
  } catch (err) {
    console.warn('[PriceService] Batch LTP fetch failed:', err.message);
  }

  return result;
}

module.exports = { getLTP, getBatchLTP };
