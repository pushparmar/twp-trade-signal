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
const kiteService     = require('./kiteService');
const kiteOrderBridge = require('./kiteOrderBridge');
const { IST_OFFSET_MS, isNseOpen, isMcxOpen } = require('../utils/marketHours');
const candleStore     = require('./candleStore');
const { getSignals: ichimokuGetSignals, to4H } = require('./ichimoku');

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

function _round2(v) { return Math.round(v * 100) / 100; }

/**
 * Per-exchange sizing:
 *   NSE → risk-based.  quantity = floor(riskPerTrade / riskPerUnit).
 *         Example: entry=100, sl=95 → 10000/5 = 2000 shares (risk ≈ ₹10k).
 *         Must clear minProfit (e.g. ≥₹20k expected gain on target).
 *   MCX → lot-based.  quantity = lotSize (1 lot of the commodity contract).
 *         No R:R or profit gate — every signal trades 1 lot.
 *
 * @param {number} entry         Entry price
 * @param {number} sl            Stop-loss from the pattern engine
 * @param {number} target        Target from the pattern engine
 * @param {object} settings      autoTrader settings (riskPerTrade, minProfit)
 * @param {string} exchange      'NSE' | 'MCX'
 * @param {number} lotSize       Exchange lot size (used for MCX)
 * @returns {{ quantity, riskPerUnit, potentialProfit, rrRatio } | null}
 */
function _qualifyTrade(entry, sl, target, settings, exchange, lotSize) {
  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return null;

  const rrRatio = Math.abs(target - entry) / riskPerUnit;
  const isMcx   = exchange === 'MCX';

  if (isMcx) {
    // Gate on minRR — same rule as NSE.  A Natural Gas signal with a 1:1.5 R:R
    // should be skipped just like any equity signal.
    if (rrRatio < settings.minRR) return null;

    // MCX trades 1 lot.  potentialProfit is in ₹ (price move × contract lot size).
    const contractLotSize = lotSize || 1;
    return {
      quantity:        1,                 // number of lots
      lotSize:         contractLotSize,   // stored so closePaperTrade can apply it
      riskPerUnit:     _round2(riskPerUnit),
      potentialProfit: _round2(Math.abs(target - entry) * contractLotSize),
      rrRatio:         _round2(rrRatio),
    };
  }

  // NSE: size by ₹riskPerTrade, gate on minProfit.
  const quantity        = Math.max(1, Math.floor(settings.riskPerTrade / riskPerUnit));
  const potentialProfit = Math.abs(target - entry) * quantity;
  if (potentialProfit < settings.minProfit) return null;

  return {
    quantity,
    riskPerUnit:     _round2(riskPerUnit),
    potentialProfit: _round2(potentialProfit),
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
async function _onAlert(alert, source) {
  // ── 1. Feature gate ──────────────────────────────────────────────────────
  const settings = store.getAutoTraderSettings();
  if (!settings.enabled) return;

  // ── 1.1  Pattern config gate — skip if order disabled for this pattern+interval
  if (!store.isPatternEnabled(alert.patternId, alert.interval, 'order')) return;

  // ── 2. Required fields ───────────────────────────────────────────────────
  const entry    = alert.close;
  const { sl, target, token, interval, patternId, signal } = alert;

  if (!entry || !sl || !target || !token || !signal) return;

  // ── 2.1  Index / non-tradeable instrument gate ───────────────────────────
  // Indices (NIFTY, BANKNIFTY, SENSEX, VIX, etc.) cannot be traded directly;
  // only their derivatives can.  Drop any alert whose token or label matches
  // a known index so we never accidentally open a paper trade on them.
  const NON_TRADEABLE_TOKENS = new Set([
    256265,  // NIFTY 50  (NSE:NIFTY 50)
    260105,  // NIFTY BANK
    264969,  // India VIX
    274441,  // NIFTY FIN SERVICE (FINNIFTY)
    288009,  // NIFTY MIDCAP SELECT (MIDCPNIFTY)
    265,     // BSE SENSEX
    270857,  // BSE BANKEX
  ]);
  // Label-based guard catches any future index that maps to a known name.
  const NON_TRADEABLE_LABEL_RE =
    /\b(NIFTY|BANK\s?NIFTY|SENSEX|VIX|BANKEX|FINNIFTY|MIDCPNIFTY)\b/i;

  if (NON_TRADEABLE_TOKENS.has(Number(token))) {
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

  const numToken = Number(token);

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

  // ── 3. Dedup — once per (token, interval, signal) per IST day ───────────
  // patternId is intentionally excluded from the key: if two different patterns
  // both fire on the same stock+TF+direction (e.g. kumo-breakout + kijun-bounce
  // on the same 15m bullish bar), only the FIRST one places an order.
  const today    = _istDateStr();
  const dedupKey = `${numToken}:${interval}:${signal}`;
  const lastFired = _dedup.get(dedupKey);
  if (lastFired && lastFired === today) {
    console.log(`[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel} ${signal}) — already traded this direction today`);
    return;
  }

  // ── 4. No stacking — block if OPEN or PENDING trade exists on same TF ───
  // PENDING orders count too: a triggered-entry order that hasn't filled yet
  // still represents an open position intention for this (token, interval).
  const alreadyActive = store.getPaperTrades().some(
    (t) =>
      (t.status === 'OPEN' || t.status === 'PENDING') &&
      Number(t.token) === numToken &&
      t.interval === interval,
  );
  if (alreadyActive) {
    console.log(`[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — open/pending trade already exists on this TF`);
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
    lotSize = cacheSize > 1
      ? cacheSize
      : store.getLotMultiplier({ exchange: 'MCX', symbol: alert.tradingsymbol || alert.label || '' });
  }

  const pos = _qualifyTrade(
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

  let liveLtp = null;
  try {
    const ltpData = await kiteService.getLTP([ltpKey]);
    const price   = ltpData[ltpKey]?.last_price;
    if (price && price > 0) liveLtp = price;
  } catch (err) {
    console.warn(`[AutoTrader] LTP fetch failed for ${alert.label ?? token}: ${err.message}`);
  }

  // (a) LTP unavailable — skip entirely
  if (liveLtp === null) {
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) — ` +
      `skipped: could not fetch live price, refusing to enter at stale close ₹${patternClose}`,
    );
    return;
  }

  const gapPct   = Math.abs(liveLtp - patternClose) / patternClose;
  const hasGap   = gapPct > GAP_THRESHOLD;
  const action   = signal === 'bullish' ? 'BUY' : 'SELL';

  // Entry price for sizing: live LTP if no gap, else patternClose (pending fills there)
  const shareEntry = hasGap ? patternClose : liveLtp;

  // Qualify with the intended entry price
  const posLive = _qualifyTrade(shareEntry, usedSl, usedTarget, settings, tradeExchange, lotSize);
  if (!posLive) {
    const riskPerUnit = Math.abs(shareEntry - usedSl);
    const qty         = Math.max(1, Math.floor(settings.riskPerTrade / riskPerUnit));
    const potential   = (Math.abs(usedTarget - shareEntry) * qty).toFixed(0);
    console.log(
      `[AutoTrader] ⏭  ${alert.label ?? token} (${alert.tfLabel}) [${tradeExchange}] — ` +
      `skipped: profit≈₹${potential} < minProfit ₹${settings.minProfit}`,
    );
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
    return;
  }

  // ── 8. Claim the dedup slot ───────────────────────────────────────────────
  _dedup.set(dedupKey, today);

  // ── 9. Build trade object ─────────────────────────────────────────────────
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
  alertBus.on('alert', (alert, source) => {
    // _onAlert is async (LTP fetch); attach .catch() so a rejected promise never
    // becomes an unhandled rejection and crashes the process.
    _onAlert(alert, source).catch(err =>
      console.error('[AutoTrader] _onAlert error:', err.message),
    );
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
