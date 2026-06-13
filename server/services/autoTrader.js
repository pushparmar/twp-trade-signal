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

const { v4: uuidv4 }  = require('uuid');
const store           = require('../store');
const { broadcast }   = require('../sseHub');
const alertBus        = require('./alertBus');
const kiteTicker      = require('./kiteTicker');
const db              = require('../db');
const instrumentCache = require('./instrumentCache');
const kiteOrderBridge = require('./kiteOrderBridge');
const { IST_OFFSET_MS, isNseOpen, isMcxOpen } = require('../utils/marketHours');
const { NON_TRADEABLE_TOKENS, NON_TRADEABLE_LABEL_RE } = require('../constants');
const { normalizeToken } = require('../utils/tokenHelpers');
const { qualifyTrade } = require('../utils/tradeQualifier');
const priceService    = require('./priceService');
const candleStore     = require('./candleStore');
const { getSignals: ichimokuGetSignals, to4H } = require('./ichimoku');

// ── Trading time window helper ───────────────────────────────────────────────

/**
 * Returns true when the current IST time is within the configured entry window.
 * Reads tradeStartHHMM / tradeEndHHMM from autoTrader settings (format 'HH:MM').
 * Defaults: 09:20–15:15 IST.
 */
function _isWithinTradingWindow() {
  const settings  = store.getAutoTraderSettings();
  const start     = settings.tradeStartHHMM ?? '09:20';
  const end       = settings.tradeEndHHMM   ?? '15:15';

  const nowIST  = new Date(Date.now() + IST_OFFSET_MS);
  const nowMins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);

  return nowMins >= sh * 60 + sm && nowMins <= eh * 60 + em;
}

// ── F5: Pattern-specific TSL trigger R-values ────────────────────────────────
// Trend patterns (breakout, support, bounce) need 1.5R room before trailing
// so the trade can develop.  Bounce/retest patterns already have confirmation
// so the standard 1.0R works.  Reversion trades target a short move so a
// tight 0.5R trigger locks in gains early.
const PATTERN_TSL_TRIGGER = {
  'kumo-breakout':      1.5,
  'kumo-bounce':        1.5,
  'cloud-support':      1.5,
  'kumo-base-entry':    1.5,
  'kumo-senkou-cross':  1.5,  // trend-continuation: give the trade room to develop
  'kijun-bounce':       1.0,
  'kijun-retest':       1.0,
  'cloud-exit':         1.0,
  'tk-reversion':       0.5,
};
function _patternTslTriggerR(patternId) {
  return PATTERN_TSL_TRIGGER[patternId] ?? null; // null = use settings.tslTriggerR
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

// Tokens currently being processed (async LTP fetch in flight).
// Prevents a race where two alerts arrive simultaneously and both pass
// the no-stacking check before either has created a trade.
// Cleared immediately after the trade is placed (or skipped).
const _processing = new Set(); // numToken

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

// ── Market bias gate (NIFTY multi-TF consensus) ─────────────────────────────
// Same logic as the "Consensus Bias" card on the UI (OverallSignalCard):
//   1. Run getSignals() on NIFTY 50 for 15m, 1h, 4h, day
//   2. Each TF votes bullish/bearish/neutral (or callBuy/putBuy overrides)
//   3. Majority vote across 4 TFs determines the final bias
// Cached per IST 15-minute slot — the multi-TF consensus can shift intraday
// as new candles close, so we refresh every 15 minutes.

const NIFTY_TOKEN   = 256265;
let _cachedBias     = null;  // { slot: 'YYYY-MM-DD_HH:MM', bias, confidence, details }

/**
 * Determine per-TF signal — matches the UI's overallSig() helper exactly.
 * Priority: callBuySignal > putBuySignal > majority of 4 ichimoku indicators.
 */
function _tfSignal(ichi) {
  if (!ichi) return 'neutral';
  if (ichi.callBuySignal) return 'bullish';
  if (ichi.putBuySignal)  return 'bearish';
  const sigs = [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal];
  const bull = sigs.filter((s) => s === 'bullish').length;
  const bear = sigs.filter((s) => s === 'bearish').length;
  return bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
}

/**
 * Get current market bias from NIFTY 50 multi-TF Ichimoku consensus.
 * Returns 'bullish' | 'bearish' | 'neutral'.
 *
 * Mirrors the UI's OverallSignalCard logic:
 *   - If any TF has exclusive callBuySignal → bullish
 *   - If any TF has exclusive putBuySignal  → bearish
 *   - Else: count bullish vs bearish TFs; majority wins
 *
 * Cached per 15-minute IST slot so it refreshes as new candles close.
 */
function _getMarketBias() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const slot = nowIST.toISOString().slice(0, 10) + '_'
    + String(nowIST.getHours()).padStart(2, '0') + ':'
    + String(Math.floor(nowIST.getMinutes() / 15) * 15).padStart(2, '0');

  // Return cached value if same 15-minute slot
  if (_cachedBias && _cachedBias.slot === slot) return _cachedBias.bias;

  try {
    // ── Gather candles for all 4 TFs (all in-memory, zero I/O) ──────────
    const candles15m = candleStore.getCandlesSync(NIFTY_TOKEN, '15minute');
    const candles1h  = candleStore.getCandlesSync(NIFTY_TOKEN, '60minute');
    const candles1d  = candleStore.getCandlesSync(NIFTY_TOKEN, 'day');

    // 4h is synthesised from 1h candles (same as chart + UI)
    const candles4h = candles1h && candles1h.length >= 52 ? to4H(candles1h) : null;

    // ── Run getSignals() on each TF ─────────────────────────────────────
    const sig15m = candles15m && candles15m.length >= 52 ? ichimokuGetSignals(candles15m, '15minute') : null;
    const sig1h  = candles1h  && candles1h.length  >= 52 ? ichimokuGetSignals(candles1h,  '60minute') : null;
    const sig4h  = candles4h  && candles4h.length  >= 52 ? ichimokuGetSignals(candles4h,  '4h')       : null;
    const sig1d  = candles1d  && candles1d.length  >= 52 ? ichimokuGetSignals(candles1d,  'day')      : null;

    const allSigs = [sig15m, sig1h, sig4h, sig1d];
    const tfLabels = ['15m', '1h', '4h', '1d'];

    // ── Check for strong callBuy / putBuy signals (override) ────────────
    const hasCallBuy = allSigs.some((s) => s?.callBuySignal);
    const hasPutBuy  = allSigs.some((s) => s?.putBuySignal);

    // ── Per-TF vote ─────────────────────────────────────────────────────
    const tfVotes = allSigs.map((s) => _tfSignal(s));
    const bullCount = tfVotes.filter((v) => v === 'bullish').length;
    const bearCount = tfVotes.filter((v) => v === 'bearish').length;

    // ── Final consensus (same as UI OverallSignalCard) ──────────────────
    let bias = 'neutral';
    let label = 'NEUTRAL';

    if (hasCallBuy && !hasPutBuy) {
      bias = 'bullish'; label = 'CALL BUY';
    } else if (hasPutBuy && !hasCallBuy) {
      bias = 'bearish'; label = 'PUT BUY';
    } else if (bullCount > bearCount) {
      bias = 'bullish'; label = 'BULLISH';
    } else if (bearCount > bullCount) {
      bias = 'bearish'; label = 'BEARISH';
    }

    const confidence = Math.round((Math.max(bullCount, bearCount) / 4) * 100);
    const details = tfLabels.map((lbl, i) => `${lbl}:${tfVotes[i]}`).join(' ');

    _cachedBias = { slot, bias, confidence, label, details };
    console.log(
      `[AutoTrader] 📊 Market bias: ${label} (${confidence}%) [${details}]`,
    );
    return bias;
  } catch (err) {
    console.warn('[AutoTrader] _getMarketBias error:', err.message);
    return 'neutral';
  }
}

// ── Trade qualifier ──────────────────────────────────────────────────────────
// Now using shared utility from utils/tradeQualifier.js

function _round2(v) { return Math.round(v * 100) / 100; }

// ── Core handler ──────────────────────────────────────────────────────────────

/**
 * Invoked for every alert emitted on alertBus.
 *
 * @param {object} alert   The full alert payload (same shape as scan_alert SSE)
 * @param {string} source  'background' | 'live' | 'manual'
 */
async function _onAlert(alert, source) {
  // ── 1. Feature gate ──────────────────────────────────────────────────────
  const settings = store.getAutoTraderSettings();
  if (!settings.enabled) return;

  // ── 1.1  Pattern config gate — skip if order disabled for this pattern+interval
  if (!store.isPatternEnabled(alert.patternId, alert.interval, 'order')) return;

  // ── 1.2  Quality score order gate — skip if quality too low
  const qCfg = store.getQualityScoreConfig();
  if (qCfg.enabled && qCfg.orderGateEnabled && alert.qualityScore != null) {
    if (alert.qualityScore < qCfg.minQualityScore) {
      console.log(
        `[AutoTrader] ⏭  Quality gate: ${alert.label ?? alert.token} (${alert.tfLabel})` +
        ` score=${alert.qualityScore} (${alert.setupGrade}) < min ${qCfg.minQualityScore} — skipped`,
      );
      return;
    }
  }

  // ── 1.3  R10: Cloud-support requires quality 8+ for auto-trade
  if (alert.patternId === 'cloud-support' && qCfg.enabled && alert.qualityScore != null) {
    if (alert.qualityScore < 8) {
      console.log(
        `[AutoTrader] ⏭  cloud-support quality: ${alert.label ?? alert.token} (${alert.tfLabel})` +
        ` score=${alert.qualityScore} < 8 — requires higher conviction for auto-trade`,
      );
      return;
    }
  }

  // ── 2. Required fields ───────────────────────────────────────────────────
  const entry    = alert.close;
  const { sl, target, token, interval, patternId, signal } = alert;

  if (!entry || !sl || !target || !token || !signal) return;

  // ── 2.1  Index / non-tradeable instrument gate ───────────────────────────
  // Indices (NIFTY, BANKNIFTY, SENSEX, VIX, etc.) cannot be traded directly;
  // only their derivatives can.  Drop any alert whose token or label matches
  // a known index so we never accidentally open a paper trade on them.

  if (NON_TRADEABLE_TOKENS.has(normalizeToken(token))) {
    console.log(
      `[AutoTrader] ⛔ Skipped index token ${token} (${alert.label ?? '?'}) — not tradeable`,
    );
    return;
  }
  if (NON_TRADEABLE_LABEL_RE.test(String(alert.label ?? ''))) {
    console.log(
      `[AutoTrader] ⛔ Skipped index label "${alert.label}" — not tradeable`,
    );
    return;
  }

  // Cache this alert's levels for MTF lookups by other timeframes
  const cacheKey = `${token}:${signal}:${interval}`;
  _alertCache.set(cacheKey, { close: entry, sl, target, tfLabel: alert.tfLabel, interval });

  // ── 2.5  Market-hours gate ────────────────────────────────────────────────
  const mcxSymbolHint = /^(CRUDE|GOLD|SILVER|COPPER|NATURAL|ALUMIN|ZINC|LEAD|NICKEL|MENTHA)/i;
  const isMcxSymbol   = alert.exchange === 'MCX'
    || mcxSymbolHint.test(String(alert.label ?? ''));
  if (!isNseOpen() && !isMcxOpen()) return;
  if (!isNseOpen() && isMcxOpen() && !isMcxSymbol) return;

  // ── 2.6a Trading time window gate ────────────────────────────────────────
  // No new entries before 09:20 or after 15:15 IST (configurable).
  // Only NSE equities respect this; MCX sessions run later so we skip the gate.
  if (isNseOpen() && !isMcxSymbol && !_isWithinTradingWindow()) {
    const s = store.getAutoTraderSettings();
    console.log(
      `[AutoTrader] ⏰ Time filter: outside window ` +
      `(${s.tradeStartHHMM}–${s.tradeEndHHMM} IST) — ${alert.label ?? token} skipped`,
    );
    return;
  }

  const numToken = normalizeToken(token);

  // ── 2.55 Market bias gate (15m / 1h only) ──────────────────────────────
  // Uses NIFTY multi-TF consensus (same as "Consensus Bias" card on UI):
  //   - Runs getSignals() on NIFTY 15m, 1h, 4h, day
  //   - Each TF votes bullish/bearish/neutral (callBuy/putBuy override)
  //   - Majority wins → final bias
  // On bullish consensus, skip bearish trades for 15m and 1h.
  // On bearish consensus, skip bullish trades for 15m and 1h.
  // Higher TFs (4h, day) bypass — they represent structural moves.
  // 'neutral' consensus → allow both directions.
  if (interval === '15minute' || interval === '60minute') {
    const marketBias = _getMarketBias();
    if (marketBias === 'bullish' && signal === 'bearish') {
      console.log(
        `[AutoTrader] ⏭  Skipped ${alert.label ?? token} ${signal} (${alert.tfLabel ?? interval})` +
        ` — NIFTY consensus is BULLISH (${_cachedBias?.details}), ignoring bearish on short TF`,
      );
      return;
    }
    if (marketBias === 'bearish' && signal === 'bullish') {
      console.log(
        `[AutoTrader] ⏭  Skipped ${alert.label ?? token} ${signal} (${alert.tfLabel ?? interval})` +
        ` — NIFTY consensus is BEARISH (${_cachedBias?.details}), ignoring bullish on short TF`,
      );
      return;
    }
  }

  // ── 2.6  Future cloud direction gate ────────────────────────────────────
  // The Ichimoku cloud projected 26 bars AHEAD of the current price must agree
  // with the trade direction:
  //   BUY  → future cloud must be bullish (Senkou A > Senkou B)
  //   SELL → future cloud must be bearish (Senkou A < Senkou B)
  //
  // Angle fallback: if the future cloud is wrong but the pattern's overall
  // Ichimoku score is ≥ 3 (most system components — TK position, chikou,
  // cloud colour, consecutive bars — confirm the direction), the trade is
  // still allowed.  score < 3 with a conflicting future cloud = skip.
  {
    const { futureCloudColor } = alert;
    const expectedCloud = signal === 'bullish' ? 'bullish' : 'bearish';
    if (futureCloudColor && futureCloudColor !== 'neutral' && futureCloudColor !== expectedCloud) {
      const score = alert.score ?? 0;
      if (score < 3) {
        console.log(
          `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel} ${signal})` +
          ` — future cloud ${futureCloudColor}, score ${score} < 3 (angle weak, skipped)`,
        );
        return;
      }
      console.log(
        `[AutoTrader] ⚠  ${alert.label ?? token} (${alert.tfLabel} ${signal})` +
        ` — future cloud ${futureCloudColor} but score ${score} ≥ 3 (angle ok, proceeding)`,
      );
    }
  }

  // ── 2.7  MCX — no 15-minute orders ─────────────────────────────────────
  // MCX commodities (Crude, Gold, Silver, NatGas) are volatile and require
  // at least a 1h setup to filter noise. 15m orders are disabled for MCX.
  if ((interval === '15minute' || alert.tfLabel === '15m') && isMcxSymbol) {
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (MCX 15m ${signal}) — skipped: 15m orders disabled for MCX`,
    );
    return;
  }

  // ── 2.7  15m requires 1h MTF alignment ──────────────────────────────────
  // A 15-minute setup only triggers a trade when the scan's own MTF check
  // confirms at least the 1h timeframe is aligned in the same direction.
  // alignedTfs is populated by the pattern engine at scan time — no cache,
  // no timing dependency.
  if (interval === '15minute' || alert.tfLabel === '15m') {
    const higherTfs  = new Set(['1h', '4h', '1d']);
    const hasHigherTf = alert.alignedTfs?.some(tf => higherTfs.has(tf));
    if (!hasHigherTf) {
      console.log(
        `[AutoTrader] ⏭  ${alert.label ?? token} (15m ${signal}) — skipped: no 1h/4h/1d MTF alignment`,
      );
      return;
    }
  }

  // ── 3. No stacking — block if ANY open/pending trade exists for this token
  // Same stock cannot have two simultaneous positions regardless of timeframe.
  // Re-entry is allowed naturally once the trade closes (SL / target / manual).
  const alreadyActive = store.getPaperTrades().some(
    (t) =>
      (t.status === 'OPEN' || t.status === 'PENDING') &&
      normalizeToken(t.token) === numToken,
  );
  if (alreadyActive) {
    console.log(`[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — open/pending trade already exists for this stock`);
    return;
  }

  // ── 4. Race guard — claim the slot before async LTP fetch ───────────────
  // Prevents two alerts arriving in the same millisecond from both passing
  // the no-stacking check before either has created a trade.
  // Slot is always released below (trade placed or skipped).
  if (_processing.has(numToken)) {
    console.log(`[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — concurrent signal ignored`);
    return;
  }
  _processing.add(numToken);

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

  // ── 5. Qualify trade — risk-sized for NSE, lot-sized for MCX ─────────────
  const tradeExchange = alert.exchange ?? (isMcxSymbol ? 'MCX' : 'NSE');
  // MCX alerts already carry the futures token, so the lot size lives in the
  // instrument cache.  NSE cash equity doesn't have lots — pass 1 as the noop.
  let lotSize = 1;
  if (tradeExchange === 'MCX') {
    // Prefer lot size from the instrument cache (populated from Kite master).
    // Fall back to the symbol-name map for well-known commodities so Natural Gas /
    // Crude Oil / Silver / Gold always get the right contract multiplier even if
    // the cache lookup misses (e.g. on first boot before the cache is warm).
    const mcxInst   = instrumentCache.getByToken(numToken);
    const cacheSize = mcxInst?.lotSize ?? 0;
    const { getLotMultiplier } = require('../store');
    lotSize = cacheSize > 1
      ? cacheSize
      : getLotMultiplier({ exchange: 'MCX', symbol: alert.tradingsymbol || alert.label || '' });
  }

  const pos = qualifyTrade(
    usedEntry, usedSl, usedTarget, settings, tradeExchange, lotSize,
  );
  if (!pos) {
    const riskPerUnit = Math.abs(usedEntry - usedSl);
    const qty         = Math.max(1, Math.floor(settings.riskPerTrade / riskPerUnit));
    const potential   = (Math.abs(usedTarget - usedEntry) * qty).toFixed(0);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) [${tradeExchange}] — ` +
      `skipped: profit≈₹${potential} < minProfit ₹${settings.minProfit}`,
    );
    _processing.delete(numToken);
    return;
  }

  // ── 6. Live LTP — three-way gap handling ─────────────────────────────────
  //
  //   a) LTP fetch fails  → SKIP.  We cannot enter at yesterday's close price
  //      because that level may be far from the real market.  Better to miss
  //      the trade than to open a phantom position at a stale price.
  //
  //   b) LTP available, gap ≤ GAP_THRESHOLD (0.5%)  → enter immediately at
  //      live LTP.  Tiny drift is normal; we just use the real market price.
  //
  //   c) LTP available, gap > GAP_THRESHOLD  → place a PENDING limit order
  //      at the pattern's close (the Kijun / cloud level).  The order only
  //      activates once price RETURNS to that structural zone, confirming the
  //      level is still relevant before risking capital.
  //      • Bullish BUY:  triggerDir = 'below'  (fire when price ≤ patternClose)
  //      • Bearish SELL: triggerDir = 'above'  (fire when price ≥ patternClose)
  //
  // Gap threshold — anything wider than 0.5% from the pattern close is treated
  // as a meaningful gap that warrants a limit-style pending order.
  const GAP_THRESHOLD = 0.005;

  const patternClose    = Number(usedEntry); // structural level from scanner
  const tradingSymbol   = alert.tradingsymbol || alert.label || String(numToken);
  const ltpKey          = `${tradeExchange}:${tradingSymbol}`;

  let liveLtp = await priceService.getLTP(tradeExchange, tradingSymbol);

  // (a) LTP unavailable — skip entirely
  if (liveLtp === null) {
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — ` +
      `skipped: could not fetch live price, refusing to enter at stale close ₹${patternClose}`,
    );
    _processing.delete(numToken);
    return;
  }

  const gapPct   = Math.abs(liveLtp - patternClose) / patternClose;
  const hasGap   = gapPct > GAP_THRESHOLD;
  const action   = signal === 'bullish' ? 'BUY' : 'SELL';

  // Entry price for sizing: live LTP if no gap, else patternClose (pending fills there)
  const shareEntry = hasGap ? patternClose : liveLtp;

  // Qualify with the intended entry price
  const posLive = qualifyTrade(shareEntry, usedSl, usedTarget, settings, tradeExchange, lotSize);
  if (!posLive) {
    const riskPerUnit = Math.abs(shareEntry - usedSl);
    const qty         = Math.max(1, Math.floor(settings.riskPerTrade / riskPerUnit));
    const potential   = (Math.abs(usedTarget - shareEntry) * qty).toFixed(0);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) [${tradeExchange}] — ` +
      `skipped: profit≈₹${potential} < minProfit ₹${settings.minProfit}`,
    );
    _processing.delete(numToken);
    return;
  }

  // ── 7. Capital check ──────────────────────────────────────────────────────
  // For MCX: notional cost = quantity(lots) × lotSize × price.
  // For NSE: notional cost = quantity(shares) × price.
  const contractMult = posLive.lotSize ?? 1;
  const cost         = posLive.quantity * contractMult * shareEntry;
  const balance = store.getPaperBalance();
  if (cost > balance.available) {
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} — insufficient balance ` +
      `(need ₹${_round2(cost)}, have ₹${_round2(balance.available)})`,
    );
    _processing.delete(numToken);
    return;
  }

  // ── 8. Build trade object ─────────────────────────────────────────────────
  // status = PENDING when price has gapped; OPEN for direct entry.
  // A PENDING trade activates in tradeWatcher when price returns to triggerPrice.
  const tradeStatus  = hasGap ? 'PENDING' : 'OPEN';
  // triggerDir: which direction the live price must move to reach patternClose.
  //   bullish gap-up  → price must fall  back to Kijun → 'below'
  //   bearish gap-down → price must rally back to Kijun → 'above'
  const triggerDir   = hasGap ? (signal === 'bullish' ? 'below' : 'above') : undefined;
  const triggerPrice = hasGap ? patternClose : undefined;

  const trade = {
    id:              uuidv4(),
    ts:              Date.now(),
    source:          'auto',
    autoSource:      source,
    // Instrument
    symbol:          tradingSymbol,
    token:           numToken,
    exchange:        tradeExchange,
    // Order sizing
    action,
    quantity:        posLive.quantity,
    lotSize,
    // Entry / SL / target
    entryPrice:      shareEntry,
    exitPrice:       null,
    sl:              Number(usedSl),
    initialSl:       Number(usedSl),
    target:          Number(usedTarget),
    mtfSource,
    // Pending-order fields (undefined on direct-entry trades)
    status:          tradeStatus,
    triggerPrice,
    triggerDir,
    // TSL state
    tslActivated:    false,
    peakPrice:       shareEntry,
    // F4: trailingAnchor — Ichimoku structural level (Tenkan or Kijun) used as
    // TSL floor so the trail doesn't drift below the current Ichimoku structure.
    trailingAnchor:  alert.trailingAnchor ?? null,
    // F5: Pattern-specific TSL trigger — trend patterns need more room (1.5R),
    // bounce patterns use default (1.0R), reversion snaps tighter (0.5R).
    tslTriggerR:     _patternTslTriggerR(patternId),
    pnl:             null,
    closedTs:        null,
    // Pattern context
    patternId:       patternId         ?? null,
    patternLabel:    alert.patternLabel ?? null,
    signal,
    interval:        interval           ?? null,
    tfLabel:         alert.tfLabel      ?? null,
    // Risk metadata
    riskPerUnit:     posLive.riskPerUnit,
    rrRatio:         posLive.rrRatio,
    potentialProfit: posLive.potentialProfit,
    targetSource:    alert.targetSource ?? null,
    // Indicator snapshot at scan time — no extra API call needed; RSI is
    // computed from the same candle array the pattern engine already holds.
    rsi14:           alert.rsi14         ?? null,
    volumeConfirmed: alert.volumeConfirmed ?? null,
    volumeRatio:     alert.volumeRatio    ?? null,
    mtfAligned:      alert.mtfAligned     ?? false,
    // Pattern quality score (1–5 stars) — stored for later analysis;
    // not used as a trade filter at this stage.
    score:           alert.score          ?? null,
  };

  // ── 10. Persist + broadcast ───────────────────────────────────────────────
  // Release the race-guard slot — trade is now in the store, so the
  // no-stacking check will block any concurrent duplicates from here on.
  _processing.delete(numToken);

  store.addPaperTrade(trade);
  broadcast('paper_trade', trade);
  broadcast('paper_balance', store.getPaperBalance());

  try {
    kiteTicker.subscribe([numToken]);
  } catch (err) {
    console.warn(`[AutoTrader] Could not subscribe token:`, err.message);
  }

  db.tradeRepo.upsertTrade(trade);

  // ── 11. Live Kite order (only when liveOrderEnabled: true in config.json) ──
  // PENDING trades do NOT get an entry order here — the order fires when the
  // trigger price is hit and tradeWatcher transitions the trade to OPEN.
  if (trade.status === 'OPEN') {
    kiteOrderBridge.placeEntryOrder(trade).catch(err =>
      console.error('[AutoTrader] kiteOrderBridge.placeEntryOrder error:', err.message),
    );
  }

  const mtfTag = mtfSource ? ` ⚡MTF(${mtfSource})` : '';
  const qtyTag = tradeExchange === 'MCX'
    ? `${posLive.quantity}qty (1 lot × ${lotSize})`
    : `${posLive.quantity}qty`;

  if (hasGap) {
    console.log(
      `[AutoTrader] ⏳ PENDING ${action} ${trade.symbol} [${tradeExchange}]` +
      ` — gap ${(gapPct * 100).toFixed(2)}% (ltp ₹${liveLtp} vs kijun ₹${patternClose})` +
      ` trigger=${triggerDir} ₹${patternClose} sl=₹${usedSl} tgt=₹${usedTarget}` +
      ` ${qtyTag} [${source}]`,
    );
  } else {
    console.log(
      `[AutoTrader] 🤖 ${action} ${trade.symbol} [${tradeExchange}] @ ₹${shareEntry}` +
      ` [${alert.tfLabel ?? interval}] ${patternId}${mtfTag}` +
      ` sl=₹${usedSl} tgt=₹${usedTarget}` +
      ` R:R=${posLive.rrRatio} profit≈₹${posLive.potentialProfit} ${qtyTag} [${source}]`,
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start listening for scan alerts. Call once after store is loaded. */
function start() {
  // ── EQUITY AUTO-TRADE DISABLED ────────────────────────────────────────────
  // Background scans still run and track outcomes via signalOutcomeTracker,
  // but no auto paper trades are placed for equity. Users can manually add
  // trades from the Scanner UI. Index-trade module has its own separate
  // auto-trade flow via orderManager.js.
  //
  // alertBus.on('alert', (alert, source) => {
  //   // _onAlert is async (LTP fetch); attach .catch() so a rejected promise never
  //   // becomes an unhandled rejection and crashes the process.
  //   _onAlert(alert, source).catch(err =>
  //     console.error('[AutoTrader] _onAlert error:', err.message),
  //   );
  // });
  console.log('[AutoTrader] DISABLED — equity auto-trade removed; signalOutcomeTracker still tracks all alerts');
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
  _processing.clear();
  _alertCache.clear();
  return 0;
}

module.exports = { start, stop, clearDedup };
