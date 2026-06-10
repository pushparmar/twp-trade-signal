/**
 * tokenHelpers.js
 * Centralized token normalization utilities
 */

/**
 * Normalize a single token to number
 * @param {string|number} token
 * @returns {number}
 */
function normalizeToken(token) {
  return Number(token);
}

/**
 * Normalize an array of tokens to numbers
 * @param {Array<string|number>} tokens
 * @returns {number[]}
 */
function normalizeTokens(tokens) {
  return tokens.map(Number);
}

module.exports = { normalizeToken, normalizeTokens };
