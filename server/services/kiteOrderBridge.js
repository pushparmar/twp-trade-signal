'use strict';

/**
 * kiteOrderBridge.js
 *
 * Thin adapter between the paper-trade engine and the live Kite Connect API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DISABLED BY DEFAULT — safe to deploy.
 *
 * To enable live order placement, add this line to config.json and restart:
 *
 *   "liveOrderEnabled": true
 *
 * There is NO UI toggle.  The flag must be set by directly editing config.json.
 * This is intentional: live orders carry real financial risk and must only be
 * activated by a deliberate manual change.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What it does when enabled
 * ─────────────────────────
 *   Entry  — places a MARKET MIS order immediately after a paper trade opens.
 *   Exit   — places a MARKET MIS order when SL / target / TSL fires on a trade.
 *   Kite order IDs are written back to the paper trade for auditing.
 *
 * What it deliberately does NOT do
 * ──────────────────────────────────
 *   • Does NOT place bracket / SL-M orders — the paper-trade engine already
 *     monitors price and fires exits; live orders mirror those decisions.
 *   • Does NOT retry on failure — a failed live order is logged with a loud
 *     warning.  You must manually square off that position in Kite.
 *   • Does NOT place orders for PENDING trades — the entry order is placed when
 *     the trigger price is hit and the trade transitions to OPEN.
 *
 * Product: MIS (Margin Intraday Squareoff) — suitable for all NSE/MCX intraday
 * Ichimoku signals.  Change PRODUCT constant below if needed.
 */

const store       = require('../store');
const kiteService = require('./kiteService');

// ── Config ────────────────────────────────────────────────────────────────────

// Product type applied to every live order placed by this bridge.
// MIS  = Margin Intraday Squareoff (Kite auto-squares off before market close)
// NRML = Normal, for overnight / multi-day positions
// CNC  = Cash-and-carry equity delivery (NSE equity only, no F&O/MCX)
const PRODUCT = 'MIS';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine the Kite transaction_type for an entry or exit leg.
 * @param {'BUY'|'SELL'} action  - the paper trade action (entry direction)
 * @param {'entry'|'exit'}  side - whether we're entering or exiting
 */
function _txType(action, side) {
  if (side === 'entry') return action === 'BUY' ? 'BUY' : 'SELL';
  return action === 'BUY' ? 'SELL' : 'BUY'; // exit is always opposite
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Place a live ENTRY order for a paper trade that just became OPEN.
 *
 * No-ops silently when `liveOrderEnabled` is not `true` in config.json.
 *
 * @param {object} trade  - the paper trade object (status must be OPEN)
 * @returns {Promise<void>}
 */
async function placeEntryOrder(trade) {
  if (!store.getLiveOrderEnabled()) return;

  const exchange = String(trade.exchange ?? 'NSE').toUpperCase();

  const params = {
    tradingsymbol:    trade.symbol,
    exchange,
    transaction_type: _txType(trade.action, 'entry'),
    quantity:         String(trade.quantity),
    product:          PRODUCT,
    order_type:       'MARKET',
    validity:         'DAY',
    tag:              'autotrader', // max 20 chars; visible in Kite order book
  };

  console.log(
    `[KiteOrderBridge] 📤 ENTRY ${params.transaction_type} ` +
    `${trade.quantity} × ${exchange}:${trade.symbol} ` +
    `(MARKET ${PRODUCT}) — paper trade ${trade.id}`,
  );

  try {
    const resp    = await kiteService.placeOrder(params);
    const orderId = resp?.data?.order_id ?? resp?.order_id ?? 'unknown';

    store.setTradeKiteOrderIds(trade.id, { kiteEntryOrderId: orderId });

    console.log(
      `[KiteOrderBridge] ✅ ENTRY placed — Kite order_id ${orderId} ` +
      `(${exchange}:${trade.symbol})`,
    );
  } catch (err) {
    // Do NOT throw — the paper trade continues regardless.
    // If this live order failed you must manually square off in Kite.
    console.error(
      `[KiteOrderBridge] ❌ ENTRY order FAILED — ${exchange}:${trade.symbol}: ` +
      (err.response?.data?.message ?? err.message),
    );
    console.error('[KiteOrderBridge] ⚠️  Check Kite — manual action may be required.');
  }
}

/**
 * Place a live EXIT order when a paper trade closes (SL / Target / TSL / manual).
 *
 * No-ops silently when `liveOrderEnabled` is not `true` in config.json.
 *
 * @param {object} trade   - the closed paper trade object
 * @param {string} reason  - 'SL' | 'TSL' | 'TARGET' | 'MANUAL'
 * @returns {Promise<void>}
 */
async function placeExitOrder(trade, reason) {
  if (!store.getLiveOrderEnabled()) return;

  const exchange = String(trade.exchange ?? 'NSE').toUpperCase();

  const params = {
    tradingsymbol:    trade.symbol,
    exchange,
    transaction_type: _txType(trade.action, 'exit'),
    quantity:         String(trade.quantity),
    product:          PRODUCT,
    order_type:       'MARKET',
    validity:         'DAY',
    tag:              'autotrader',
  };

  const emoji = reason === 'TARGET' ? '🎯' : reason === 'TSL' ? '🔒' : '🛑';
  console.log(
    `[KiteOrderBridge] ${emoji} EXIT ${params.transaction_type} ` +
    `${trade.quantity} × ${exchange}:${trade.symbol} ` +
    `(${reason} · MARKET ${PRODUCT}) — paper trade ${trade.id}`,
  );

  try {
    const resp    = await kiteService.placeOrder(params);
    const orderId = resp?.data?.order_id ?? resp?.order_id ?? 'unknown';

    store.setTradeKiteOrderIds(trade.id, { kiteExitOrderId: orderId });

    console.log(
      `[KiteOrderBridge] ✅ EXIT placed — Kite order_id ${orderId} ` +
      `(${exchange}:${trade.symbol} · ${reason})`,
    );
  } catch (err) {
    console.error(
      `[KiteOrderBridge] ❌ EXIT order FAILED — ${exchange}:${trade.symbol} (${reason}): ` +
      (err.response?.data?.message ?? err.message),
    );
    console.error(
      `[KiteOrderBridge] ⚠️  ${exchange}:${trade.symbol} position is OPEN in Kite ` +
      `— square off manually.`,
    );
  }
}

module.exports = { placeEntryOrder, placeExitOrder };
