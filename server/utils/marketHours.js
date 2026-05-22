'use strict';

/**
 * marketHours.js — shared Indian market session helpers.
 *
 * All checks are performed in IST (UTC+5:30).  Weekend logic uses UTC day-of-week
 * after applying the IST offset so midnight-crossover days are handled correctly.
 *
 * Usage:
 *   const { isNseOpen, isMcxOpen, isAnyMarketOpen } = require('../utils/marketHours');
 *   if (!isAnyMarketOpen()) return; // skip Telegram outside market hours
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/**
 * NSE equity / derivatives trading window: 09:20–15:20 IST, weekdays only.
 * Covers: NIFTY, BANKNIFTY, F&O stocks, indices.
 *
 * Intentionally narrower than the official NSE session (09:15–15:30):
 *   • 09:20 open  — lets the market settle after the opening bell; avoids
 *                   erratic first-minute price discovery noise.
 *   • 15:20 close — stops new orders 10 min before official close; avoids
 *                   end-of-day illiquidity and orders that cannot realistically
 *                   fill after 15:30.
 *
 * @param {number} [now=Date.now()] — epoch ms (injectable for tests)
 * @returns {boolean}
 */
function isNseOpen(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const dow = ist.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 560 && mins <= 920; // 09:20 = 560, 15:20 = 920
}

/**
 * MCX commodities session: 09:00–23:30 IST, weekdays only.
 * Covers: Crude Oil, Gold, Silver, Copper, Natural Gas, Aluminium.
 *
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
function isMcxOpen(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 540 && mins <= 1410; // 09:00 = 540, 23:30 = 1410
}

/**
 * Returns true when EITHER NSE OR MCX is open.
 * Use as the single gate for any mixed NSE+MCX alert service.
 *
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
function isAnyMarketOpen(now = Date.now()) {
  return isNseOpen(now) || isMcxOpen(now);
}

module.exports = { isNseOpen, isMcxOpen, isAnyMarketOpen, IST_OFFSET_MS };
