/**
 * autoTrader.js
 *
 * Automatically places paper trades when scan alerts arrive.
 *
 * Testing-mode position sizing:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  quantity = 1 (fixed — generates max samples for analysis)│
 *   │  Require R:R ≥ minRR (default 2.0)                       │
 *   │  No max R:R cap — pattern's natural target is used as-is │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Guards:
 *   • autoTrader.enabled must be true (off by default — user opts in)
 *   • alert must carry close, sl, and target from the pattern engine
 *   • R:R = |target − entry| / |entry − sl| must be ≥ minRR
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
const derivativeResolver = require('./derivativeResolver');
const { IST_OFFSET_MS, isNseOpen, isMcxOpen } = require('../utils/marketHours');

// ── Dedup ─────────────────────────────────────────────────────────────────────

// "token:interval:patternId:signal" → IST date string (YYYY-MM-DD)
// Prevents the same setup from re-firing within the same trading day.
const _dedup = new Map();

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Trade qualifier ──────────────────────────────────────────────────────────

function _round2(v) { return Math.round(v * 100) / 100; }

/**
 * @param {number} entry        Entry price (spot close)
 * @param {number} sl           Stop-loss from the pattern engine
 * @param {number} target       Target from the pattern engine
 * @param {number} minRR        Minimum reward:risk ratio
 * @param {number} lotSize      Exchange lot size for the instrument
 * @param {number} riskPerTrade Max risk in rupees per trade
 * @param {string} sizingMode   'risk' | 'fixed'
 * @returns {{ lots, lotSize, quantity, riskPerUnit, potentialProfit, rrRatio } | null}
 */
function _qualifyTrade(entry, sl, target, minRR, lotSize, riskPerTrade, sizingMode) {
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return null;

  const rrRatio = Math.abs(target - entry) / riskPerUnit;
  if (rrRatio < minRR) return null;

  let lots;
  if (sizingMode === 'fixed') {
    lots = 1;
  } else {
    const riskPerLot = riskPerUnit * lotSize;
    lots = Math.max(1, Math.floor(riskPerTrade / riskPerLot));
  }

  const quantity = lots * lotSize;

  return {
    lots,
    lotSize,
    quantity,
    riskPerUnit:     _round2(riskPerUnit),
    potentialProfit: _round2(Math.abs(target - entry) * quantity),
    rrRatio:         _round2(rrRatio),
  };
}

// ── Core handler ──────────────────────────────────────────────────────────────

/**
 * Invoked for every alert emitted on alertBus.
 * Runs all guards, resolves the derivative instrument, sizes the position,
 * and places the paper trade.
 *
 * @param {object} alert   The full alert payload (same shape as scan_alert SSE)
 * @param {string} source  'background' | 'live' | 'manual'
 */
async function _onAlert(alert, source) {
  // ── 1. Feature gate ──────────────────────────────────────────────────────
  const settings = store.getAutoTraderSettings();
  if (!settings.enabled) return;

  // ── 2. Required fields ───────────────────────────────────────────────────
  const entry    = alert.close;
  const { sl, target, token, interval, patternId, signal } = alert;

  if (!entry || !sl || !target || !token || !signal) return;

  // ── 2.5  Market-hours gate ────────────────────────────────────────────────
  const mcxSymbolHint = /^(CRUDE|GOLD|SILVER|COPPER|NATURAL|ALUMIN|ZINC|LEAD|NICKEL|MENTHA)/i;
  const isMcxSymbol   = alert.exchange === 'MCX'
    || mcxSymbolHint.test(String(alert.label ?? ''));
  if (!isNseOpen() && !isMcxOpen()) return;
  if (!isNseOpen() && isMcxOpen() && !isMcxSymbol) return;

  const numToken = Number(token);

  // ── 3. Dedup — once per (token, interval, patternId, signal) per IST day ─
  const today    = _istDateStr();
  const dedupKey = `${numToken}:${interval}:${patternId}:${signal}`;
  const lastFired = _dedup.get(dedupKey);
  if (lastFired && lastFired === today) return;

  // ── 4. No stacking ───────────────────────────────────────────────────────
  const alreadyOpen = store.getPaperTrades().some(
    (t) =>
      t.status   === 'OPEN'  &&
      Number(t.token) === numToken &&
      t.interval === interval,
  );
  if (alreadyOpen) {
    console.log(`[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — open trade already exists on this TF`);
    return;
  }

  // ── 5. Resolve derivative instrument ──────────────────────────────────────
  const resolved = await derivativeResolver.resolve(alert, settings.tradingMode);
  if (!resolved) return;

  // ── 6. Qualify the trade with real lot sizing ─────────────────────────────
  const pos = _qualifyTrade(
    entry, sl, target, settings.minRR,
    resolved.lotSize, settings.riskPerTrade, settings.sizingMode,
  );
  if (!pos) {
    const rrRatio = (Math.abs(target - entry) / Math.abs(entry - sl)).toFixed(2);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — ` +
      `skipped: R:R=${rrRatio} < minRR=${settings.minRR}`,
    );
    return;
  }

  // ── 6.5 Capital check ────────────────────────────────────────────────────
  const derivativeEntry = settings.tradingMode === 'options'
    ? resolved.premium
    : (resolved.premium || Number(entry));
  const cost = pos.quantity * derivativeEntry;
  const balance = store.getPaperBalance();
  if (cost > balance.available) {
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} — insufficient balance ` +
      `(need ₹${_round2(cost)}, have ₹${_round2(balance.available)})`,
    );
    return;
  }

  // ── 7. Claim the dedup slot ───────────────────────────────────────────────
  _dedup.set(dedupKey, today);

  const action = signal === 'bullish' ? 'BUY' : 'SELL';

  // ── 8. Build trade object ─────────────────────────────────────────────────
  const trade = {
    id:              uuidv4(),
    ts:              Date.now(),
    source:          'auto',
    autoSource:      source,
    // Underlying instrument
    symbol:          alert.label || String(numToken),
    token:           numToken,
    exchange:        alert.exchange ?? (isMcxSymbol ? 'MCX' : 'NSE'),
    // Derivative instrument
    tradingMode:     settings.tradingMode,
    derivativeSymbol:   resolved.derivativeSymbol,
    derivativeToken:    resolved.derivativeToken,
    derivativeExchange: resolved.derivativeExchange,
    optionType:      resolved.optionType ?? null,
    strike:          resolved.strike ?? null,
    expiry:          resolved.expiry ?? null,
    premium:         resolved.premium ?? null,
    // Order sizing
    action,
    quantity:        pos.quantity,
    lots:            pos.lots,
    lotSize:         pos.lotSize,
    // Entry: premium for options, futures LTP for futures
    entryPrice:      derivativeEntry,
    spotEntry:       Number(entry),
    exitPrice:       null,
    // SL/target in spot price terms (monitoring uses underlying)
    sl:              Number(sl),
    initialSl:       Number(sl),
    target:          Number(target),
    // TSL state
    tslActivated:    false,
    peakPrice:       Number(entry),
    status:          'OPEN',
    pnl:             null,
    closedTs:        null,
    // Pattern context
    patternId:       patternId       ?? null,
    patternLabel:    alert.patternLabel ?? null,
    signal,
    interval:        interval         ?? null,
    tfLabel:         alert.tfLabel    ?? null,
    // Risk metadata
    riskPerUnit:     pos.riskPerUnit,
    rrRatio:         pos.rrRatio,
    potentialProfit: pos.potentialProfit,
    targetSource:    alert.targetSource ?? null,
  };

  // ── 9. Persist + broadcast ────────────────────────────────────────────────
  store.addPaperTrade(trade);
  broadcast('paper_trade', trade);
  broadcast('paper_balance', store.getPaperBalance());

  // Subscribe underlying + derivative token to live ticker
  try {
    const tokens = [numToken];
    if (resolved.derivativeToken) tokens.push(resolved.derivativeToken);
    kiteTicker.subscribe(tokens);
  } catch (err) {
    console.warn(`[AutoTrader] Could not subscribe tokens:`, err.message);
  }

  db.tradeRepo.upsertTrade(trade);

  const modeTag = settings.tradingMode === 'options'
    ? `${resolved.optionType} ₹${resolved.strike} prem=₹${resolved.premium}`
    : `FUT ₹${derivativeEntry}`;
  console.log(
    `[AutoTrader] 🤖 ${action} ${trade.symbol} ${modeTag} ` +
    `[${alert.tfLabel ?? interval}] ${patternId} ` +
    `spot=₹${entry} sl=₹${sl} tgt=₹${target} ` +
    `R:R=${pos.rrRatio} ${pos.lots}L×${pos.lotSize}=${pos.quantity}qty [${source}]`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start listening for scan alerts. Call once after store is loaded. */
function start() {
  alertBus.on('alert', (alert, source) => {
    _onAlert(alert, source).catch((err) => {
      console.error('[AutoTrader] _onAlert error:', err.message);
    });
  });
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
