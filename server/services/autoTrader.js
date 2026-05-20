/**
 * autoTrader.js
 *
 * Automatically places paper trades on the underlying SHARE (cash/equity)
 * when scan alerts arrive.  No futures, no options — entry, SL, and target
 * are all share-price levels straight from the alert.
 *
 * Flow on every alert:
 *   1. Validate alert + guards (market hours, dedup, no stacking)
 *   2. Optional MTF override (use higher-TF levels when aligned)
 *   3. Size the position (risk-based or fixed)
 *   4. Subscribe the share's instrument token to the live ticker
 *   5. tradeWatcher manages SL / TSL / target on share ticks per-tick
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

const { v4: uuidv4 } = require('uuid');
const store          = require('../store');
const { broadcast }  = require('../sseHub');
const alertBus       = require('./alertBus');
const kiteTicker     = require('./kiteTicker');
const db             = require('../db');
const { IST_OFFSET_MS, isNseOpen, isMcxOpen } = require('../utils/marketHours');

// ── Dedup ─────────────────────────────────────────────────────────────────────

// "token:interval:patternId:signal" → IST date string (YYYY-MM-DD)
// Prevents the same setup from re-firing within the same trading day.
const _dedup = new Map();

// ── MTF alert cache ──────────────────────────────────────────────────────────
// Stores the most recent alert per (token, signal, interval) for today.
// When an MTF-confluent alert arrives, we look up the largest aligned TF's
// SL/target/entry so the trade uses higher-timeframe levels.
// Map key: "token:signal:interval" → { close, sl, target, tfLabel, interval }
const _alertCache = new Map();
const TF_RANK = { '1d': 4, 'day': 4, '4h': 3, '1h': 2, '60minute': 2, '15m': 1, '15minute': 1 };

function _labelToInterval(tfLabel) {
  const map = { '15m': '15minute', '1h': '60minute', '4h': '4h', '1d': 'day' };
  return map[tfLabel] ?? tfLabel;
}

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Trade qualifier ──────────────────────────────────────────────────────────

function _round2(v) { return Math.round(v * 100) / 100; }

/**
 * @param {number} entry         Share entry price
 * @param {number} sl            Stop-loss from the pattern engine
 * @param {number} target        Target from the pattern engine
 * @param {number} minRR         Minimum reward:risk ratio
 * @param {number} riskPerTrade  Max risk in rupees per trade
 * @param {string} sizingMode    'risk' | 'fixed'
 * @returns {{ quantity, riskPerUnit, potentialProfit, rrRatio } | null}
 */
function _qualifyTrade(entry, sl, target, minRR, riskPerTrade, sizingMode) {
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return null;

  const rrRatio = Math.abs(target - entry) / riskPerUnit;
  if (rrRatio < minRR) return null;

  const quantity = sizingMode === 'fixed'
    ? 1
    : Math.max(1, Math.floor(riskPerTrade / riskPerUnit));

  return {
    quantity,
    riskPerUnit:     _round2(riskPerUnit),
    potentialProfit: _round2(Math.abs(target - entry) * quantity),
    rrRatio:         _round2(rrRatio),
  };
}

// ── Core handler ──────────────────────────────────────────────────────────────

/**
 * Invoked for every alert emitted on alertBus.
 *
 * @param {object} alert   The full alert payload (same shape as scan_alert SSE)
 * @param {string} source  'background' | 'live' | 'manual'
 */
function _onAlert(alert, source) {
  // ── 1. Feature gate ──────────────────────────────────────────────────────
  const settings = store.getAutoTraderSettings();
  if (!settings.enabled) return;

  // ── 2. Required fields ───────────────────────────────────────────────────
  const entry    = alert.close;
  const { sl, target, token, interval, patternId, signal } = alert;

  if (!entry || !sl || !target || !token || !signal) return;

  // Cache this alert's levels for MTF lookups by other timeframes
  const cacheKey = `${token}:${signal}:${interval}`;
  _alertCache.set(cacheKey, { close: entry, sl, target, tfLabel: alert.tfLabel, interval });

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

  // ── 4.5 MTF confluence — use the largest timeframe's SL/target/entry ─────
  let usedEntry  = entry;
  let usedSl     = sl;
  let usedTarget = target;
  let mtfSource  = null;

  if (alert.mtfAligned && alert.alignedTfs?.length > 0) {
    const currentRank = TF_RANK[alert.tfLabel] ?? TF_RANK[interval] ?? 0;
    let bestRank = currentRank;
    let bestData = null;

    for (const tfLabel of alert.alignedTfs) {
      const tfCacheKey = `${token}:${signal}:${_labelToInterval(tfLabel)}`;
      const cached = _alertCache.get(tfCacheKey);
      if (!cached || cached.sl == null || cached.target == null) continue;
      const rank = TF_RANK[tfLabel] ?? TF_RANK[cached.interval] ?? 0;
      if (rank > bestRank) {
        bestRank = rank;
        bestData = cached;
      }
    }

    if (bestData) {
      usedEntry  = bestData.close;
      usedSl     = bestData.sl;
      usedTarget = bestData.target;
      mtfSource  = bestData.tfLabel;
      console.log(
        `[AutoTrader] ⚡ MTF override — ${alert.label} using ${mtfSource} levels: ` +
        `entry=₹${usedEntry} sl=₹${usedSl} tgt=₹${usedTarget} (alert TF=${alert.tfLabel})`,
      );
    }
  }

  // ── 5. Qualify trade — risk sizing on share price ────────────────────────
  const pos = _qualifyTrade(
    usedEntry, usedSl, usedTarget, settings.minRR,
    settings.riskPerTrade, settings.sizingMode,
  );
  if (!pos) {
    const rrRatio = (Math.abs(usedTarget - usedEntry) / Math.abs(usedEntry - usedSl)).toFixed(2);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — ` +
      `skipped: R:R=${rrRatio} < minRR=${settings.minRR}`,
    );
    return;
  }

  // ── 6. Capital check ─────────────────────────────────────────────────────
  const shareEntry = Number(usedEntry);
  const cost       = pos.quantity * shareEntry;
  const balance    = store.getPaperBalance();
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

  // ── 8. Build trade object — cash equity, all share-price levels ──────────
  const trade = {
    id:              uuidv4(),
    ts:              Date.now(),
    source:          'auto',
    autoSource:      source,
    // Instrument (share)
    symbol:          alert.label || String(numToken),
    token:           numToken,
    exchange:        alert.exchange ?? (isMcxSymbol ? 'MCX' : 'NSE'),
    // Order sizing
    action,
    quantity:        pos.quantity,
    // Entry / SL / target — all share-price levels
    entryPrice:      shareEntry,
    exitPrice:       null,
    sl:              Number(usedSl),
    initialSl:       Number(usedSl),
    target:          Number(usedTarget),
    mtfSource:       mtfSource,
    // TSL state
    tslActivated:    false,
    peakPrice:       shareEntry,
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

  // Subscribe the share's instrument token to the live ticker
  try {
    kiteTicker.subscribe([numToken]);
  } catch (err) {
    console.warn(`[AutoTrader] Could not subscribe token:`, err.message);
  }

  db.tradeRepo.upsertTrade(trade);

  const mtfTag = mtfSource ? ` ⚡MTF(${mtfSource})` : '';
  console.log(
    `[AutoTrader] 🤖 ${action} ${trade.symbol} @ ₹${shareEntry} ` +
    `[${alert.tfLabel ?? interval}] ${patternId}${mtfTag} ` +
    `sl=₹${usedSl} tgt=₹${usedTarget} ` +
    `R:R=${pos.rrRatio} qty=${pos.quantity} [${source}]`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start listening for scan alerts. Call once after store is loaded. */
function start() {
  alertBus.on('alert', (alert, source) => {
    try {
      _onAlert(alert, source);
    } catch (err) {
      console.error('[AutoTrader] _onAlert error:', err.message);
    }
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
  _alertCache.clear();
  return count;
}

module.exports = { start, stop, clearDedup };
