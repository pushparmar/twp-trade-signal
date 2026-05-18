/**
 * autoTrader.js
 *
 * Automatically places paper trades when scan alerts arrive.
 *
 * Position sizing (fixed-risk model):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  risk       = riskPerTrade (default ₹5,000)             │
 *   │  riskPerUnit = |entry − SL|                              │
 *   │  quantity   = ceil(risk / riskPerUnit)                   │
 *   │  potProfit  = |target − entry| × quantity               │
 *   │  → only execute when potProfit ≥ minProfit (₹10,000)    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Guards:
 *   • autoTrader.enabled must be true (off by default — user opts in)
 *   • alert must carry close, sl, and target from the pattern engine
 *   • at most one OPEN auto-trade per (token, interval) at a time
 *   • same (token, patternId, signal, interval) fires at most once per IST day
 *
 * Lifecycle:
 *   • start()  — subscribes to alertBus; call once on boot
 *   • stop()   — unsubscribes; called on graceful shutdown
 */

const { v4: uuidv4 }    = require('uuid');
const store             = require('../store');
const { broadcast }     = require('../sseHub');
const alertBus          = require('./alertBus');
const kiteTicker        = require('./kiteTicker');
const db                = require('../db');
const { IST_OFFSET_MS } = require('../utils/marketHours');

// ── Dedup ─────────────────────────────────────────────────────────────────────

// "token:interval:patternId:signal" → IST date string (YYYY-MM-DD)
// Prevents the same setup from re-firing within the same trading day.
const _dedup = new Map();

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Position sizing ───────────────────────────────────────────────────────────

/**
 * Calculate position size based on fixed rupee risk.
 *
 * @param {number} entry         Last candle close — used as entry proxy
 * @param {number} sl            Stop-loss price from Ichimoku engine
 * @param {number} target        Target price (2:1 R:R minimum from engine)
 * @param {number} riskPerTrade  Max rupee risk per trade (e.g. 5000)
 * @param {number} minProfit     Minimum acceptable rupee profit (e.g. 10000)
 * @returns {{ quantity, potentialProfit, riskPerUnit } | null}
 */
function _calcPosition(entry, sl, target, riskPerTrade, minProfit) {
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return null; // SL too tight — likely data issue

  const quantity      = Math.ceil(riskPerTrade / riskPerUnit);
  const potentialProfit = Math.abs(target - entry) * quantity;

  // Reject if the trade can't reach the minimum profit target at this sizing
  if (potentialProfit < minProfit) return null;

  return {
    quantity,
    potentialProfit: Math.round(potentialProfit * 100) / 100,
    riskPerUnit:     Math.round(riskPerUnit * 100)     / 100,
  };
}

// ── Core handler ──────────────────────────────────────────────────────────────

/**
 * Invoked for every alert emitted on alertBus.
 * Runs all guards, sizes the position, and places the paper trade.
 *
 * @param {object} alert   The full alert payload (same shape as scan_alert SSE)
 * @param {string} source  'background' | 'live' | 'manual'
 */
function _onAlert(alert, source) {
  // ── 1. Feature gate ──────────────────────────────────────────────────────
  const settings = store.getAutoTraderSettings();
  if (!settings.enabled) return;

  // ── 2. Required fields ───────────────────────────────────────────────────
  const entry    = alert.close;     // last candle close = entry proxy
  const { sl, target, token, interval, patternId, signal } = alert;

  if (!entry || !sl || !target || !token || !signal) return;

  const numToken = Number(token);

  // ── 3. Dedup — once per (token, interval, patternId, signal) per IST day ─
  const today    = _istDateStr();
  const dedupKey = `${numToken}:${interval}:${patternId}:${signal}`;
  const lastFired = _dedup.get(dedupKey);
  if (lastFired && lastFired === today) return;

  // ── 4. No stacking — skip if OPEN auto-trade already exists for this slot ─
  const alreadyOpen = store.getPaperTrades().some(
    (t) =>
      t.status   === 'OPEN'  &&
      t.source   === 'auto'  &&
      Number(t.token) === numToken &&
      t.interval === interval,
  );
  if (alreadyOpen) return;

  // ── 5. Position sizing ────────────────────────────────────────────────────
  const pos = _calcPosition(entry, sl, target, settings.riskPerTrade, settings.minProfit);
  if (!pos) {
    // Log why we skipped — useful when tuning risk settings
    const rrRatio = (Math.abs(target - entry) / Math.abs(entry - sl)).toFixed(1);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — ` +
      `skipped: R:R=${rrRatio}, ` +
      `potProfit=₹${(Math.abs(target - entry) * Math.ceil(settings.riskPerTrade / Math.abs(entry - sl))).toFixed(0)} ` +
      `< minProfit=₹${settings.minProfit}`,
    );
    return;
  }

  // ── 6. Claim the dedup slot BEFORE creating the trade ─────────────────────
  _dedup.set(dedupKey, today);

  const action = signal === 'bullish' ? 'BUY' : 'SELL';

  // ── 7. Build trade object ─────────────────────────────────────────────────
  const trade = {
    id:              uuidv4(),
    ts:              Date.now(),
    // Source markers — 'auto' identifies it as auto-placed; autoSource tells which scanner
    source:          'auto',
    autoSource:      source,
    // Instrument
    symbol:          alert.label || String(numToken),
    token:           numToken,
    exchange:        alert.exchange ?? 'NSE',
    // Order
    action,
    quantity:        pos.quantity,
    lots:            1,
    lotSize:         1,
    entryPrice:      Number(entry),
    exitPrice:       null,
    sl:              Number(sl),
    target:          Number(target),
    status:          'OPEN',
    pnl:             null,
    closedTs:        null,
    // Pattern context — preserved for analytics
    patternId:       patternId       ?? null,
    patternLabel:    alert.patternLabel ?? null,
    signal,
    interval:        interval         ?? null,
    tfLabel:         alert.tfLabel    ?? null,
    // Risk metadata
    riskAmount:      settings.riskPerTrade,
    potentialProfit: pos.potentialProfit,
  };

  // ── 8. Persist + broadcast ────────────────────────────────────────────────
  store.addPaperTrade(trade);
  broadcast('paper_trade', trade);
  broadcast('paper_balance', store.getPaperBalance());

  // Subscribe token to Kite ticker so SL/target auto-close gets live prices
  try {
    kiteTicker.subscribe([numToken]);
  } catch (err) {
    console.warn(`[AutoTrader] Could not subscribe token ${numToken}:`, err.message);
  }

  // Mirror to MongoDB — fire-and-forget
  db.tradeRepo.upsertTrade(trade);

  console.log(
    `[AutoTrader] 🤖 ${action} ${trade.symbol} ` +
    `[${alert.tfLabel ?? interval}] ${patternId} ` +
    `entry=₹${entry} sl=₹${sl} target=₹${target} ` +
    `qty=${pos.quantity} risk=₹${settings.riskPerTrade} pot=₹${pos.potentialProfit} [${source}]`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start listening for scan alerts. Call once after store is loaded. */
function start() {
  alertBus.on('alert', _onAlert);
  console.log('[AutoTrader] Started — will auto-place paper trades on scan alerts');
}

/** Stop listening — called on graceful shutdown. */
function stop() {
  alertBus.off('alert', _onAlert);
}

/**
 * Clear the per-day dedup map — same as calling clearDedup on the scanners.
 * Useful after a manual reset so alerts can re-fire immediately.
 */
function clearDedup() {
  const count = _dedup.size;
  _dedup.clear();
  return count;
}

module.exports = { start, stop, clearDedup };
