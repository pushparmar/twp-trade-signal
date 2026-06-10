/**
 * dateHelpers.js
 * IST date/time formatting utilities
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Convert timestamp to IST date string (YYYY-MM-DD)
 * @param {number} [timestamp=Date.now()] - epoch ms
 * @returns {string} 'YYYY-MM-DD'
 */
function toISTDate(timestamp = Date.now()) {
  const ist = new Date(timestamp + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

/**
 * Convert timestamp to full IST datetime ISO string
 * @param {number} [timestamp=Date.now()] - epoch ms
 * @returns {string} ISO datetime string
 */
function toISTDateTime(timestamp = Date.now()) {
  const ist = new Date(timestamp + IST_OFFSET_MS);
  return ist.toISOString();
}

/**
 * Get current IST Date object
 * @param {number} [timestamp=Date.now()]
 * @returns {Date}
 */
function getISTDate(timestamp = Date.now()) {
  return new Date(timestamp + IST_OFFSET_MS);
}

module.exports = { toISTDate, toISTDateTime, getISTDate, IST_OFFSET_MS };
