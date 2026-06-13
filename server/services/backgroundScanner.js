/**
 * Background Scanner
 *
 * Automatically runs all registered Ichimoku patterns against every NFO
 * front-month future at each candle close boundary — no manual button click
 * required.  Sends Telegram alerts + SSE events for every new match.
 *
 * Why this exists:
 *   • patternAlertWatcher covers 7 hardcoded macro/index instruments via
 *     KiteTicker candle-close events.
 *   • liveScanner covers only the user's market-watch list (~3 indices).
 *   • The ~200 NFO futures that appear in the manual screener tab have no
 *     background watcher — this service fills that gap.
 *
 * How it works:
 *   At startup, a timer is set for the next candle-close boundary on each
 *   interval (15m / 1h / 4h / 1d).  When the timer fires:
 *     1. Fetch candle data for every NFO future via historicalCache
 *        (rate-limited; same as the manual /api/scan endpoint).
 *     2. Run every registered pattern on that candle data.
 *     3. For each new (first-of-day) match:
 *        a. Broadcast a `scan_alert` SSE → Scanner UI tab updates instantly.
 *        b. Send a Telegram message (if chatId is configured).
 *     4. Reschedule for the NEXT boundary.
 *
 * Dedup:
 *   Each (token, interval, patternId, signal) fires at most once per IST
 *   trading day.  Keyed with a "bg:" namespace so it stays isolated from the
 *   liveScanner/patternAlertWatcher dedup maps.  Resets automatically the
 *   next day.
 *
 * Skips:
 *   • Macro/index instruments — already covered by patternAlertWatcher.
 *   • Off-market hours — no point scanning when candle data is frozen.
 *   • Scans that take longer than the interval (degenerate case — logged).
 */

const candleStore         = require('./candleStore');
const patternRegistry     = require('./patternRegistry');
const telegramNotifier    = require('./telegramNotifier');
const { broadcast }       = require('../sseHub');
const store               = require('../store');
const { to4H, getFutureCloudColor, snapshot, getATR, getRSI, getSignals: ichimokuGetSignals } = require('./ichimoku');
const patternAlertMessage = require('./patternAlertMessage');
const instrumentCache     = require('./instrumentCache');
const foStockRegistry     = require('./foStockRegistry');
const { isAnyMarketOpen, isNseOpen, isMcxOpen, IST_OFFSET_MS } = require('../utils/marketHours');
const { getFrontMonthFutures } = require('./macroAnalysis');
const db                  = require('../db');
const alertBus            = require('./alertBus');
const signalScorer        = require('./signalScorer');

// Lazy require to avoid circular dependency (tradeWatcher → store ← backgroundScanner)
function _tradeWatcher() { return require('./tradeWatcher'); }

// ── Constants ────────────────────────────────────────────────────────────────

// Intervals driven by this scanner; 4h is synthesised from 60minute.
const INTERVALS = ['15minute', '60minute', '4h', 'day'];

// Delay after the candle boundary — lets Kite finish writing the final tick.
const CLOSE_DELAY_MS = 45 * 1000;  // 45 seconds

// Minimum candle count needed for reliable Ichimoku calculation.
const MIN_BARS = 52;

// Bar counts to request per interval (matches the /api/scan endpoint).
// 1h:  NSE produces 6 1h bars per trading day. 450 bars = ~75 trading days, giving
//      adequate Ichimoku history for direct 1h scans.
// 4h:  Synthesised from 60minute bars via to4H().  NSE gives exactly 1 4h candle per
//      trading day (first 4 of 6 1h bars form a complete group; last 2 are dropped).
//      Ichimoku requires ≥ 52 bars → need ≥ 52 × 6 = 312 1h bars → use 450 for buffer.
//      FIX: the old value of 300 gave only 50 4h candles (<52) → all patterns returned
//      null → zero 4h alerts.
// day: 150 gives ~300 calendar days → ~214 trading days — enough for all patterns.
const SCAN_BARS = {
  '15minute': 100,
  '60minute': 450,
  'day':      150,
};

const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// Score dedup per (token, signal, interval, day) — prevents re-sending the same
// alert when a later scan produces an equal or lower score on the same TF.
// Each TF fires independently; 15m is NOT suppressed by 1h.
// Key: "token:signal:interval:YYYY-MM-DD"  Value: { score }
const _tgSentTfMap = new Map();

// ── Dedup ────────────────────────────────────────────────────────────────────

const _dedup = new Map();

// ── MTF bias map ──────────────────────────────────────────────────────────────
// Stores the last-known Ichimoku direction bias per token per interval.
// Populated as each scan phase runs; persists across interval boundaries so
// the 4h scan's bias is visible when the 1h scan computes MTF alignment.
// Map<instrumentToken (number), Record<interval, 'bullish'|'bearish'|'neutral'>>
const _biasMap = new Map();

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Telegram alert gate helpers — mirror autoTrader order gates ───────────────
// These enforce the same trading-rule filters on Telegram alerts as autoTrader
// applies to order execution.  A signal that wouldn't get an order shouldn't
// clutter the Telegram feed either.

const NIFTY_TOKEN_BG = 256265;
let _bgCachedBias = null; // { slot, bias } — refreshed every 15-minute IST slot

/** Per-TF vote — same logic as autoTrader._tfSignal and the UI OverallSignalCard. */
function _bgTfSignal(ichi) {
  if (!ichi) return 'neutral';
  if (ichi.callBuySignal) return 'bullish';
  if (ichi.putBuySignal)  return 'bearish';
  const sigs = [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal];
  const bull = sigs.filter((s) => s === 'bullish').length;
  const bear = sigs.filter((s) => s === 'bearish').length;
  return bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
}

/**
 * NIFTY multi-TF consensus — exact copy of autoTrader._getMarketBias().
 * Cached per 15-minute IST slot (refreshes as new candles close intraday).
 * Returns 'bullish' | 'bearish' | 'neutral'.
 */
function _bgGetMarketBias() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const slot   = nowIST.toISOString().slice(0, 10) + '_'
    + String(nowIST.getHours()).padStart(2, '0') + ':'
    + String(Math.floor(nowIST.getMinutes() / 15) * 15).padStart(2, '0');

  if (_bgCachedBias && _bgCachedBias.slot === slot) return _bgCachedBias.bias;

  try {
    const c15m  = candleStore.getCandlesSync(NIFTY_TOKEN_BG, '15minute');
    const c1h   = candleStore.getCandlesSync(NIFTY_TOKEN_BG, '60minute');
    const c1d   = candleStore.getCandlesSync(NIFTY_TOKEN_BG, 'day');
    const c4h   = c1h && c1h.length >= 52 ? to4H(c1h) : null;

    const s15m  = c15m && c15m.length >= 52 ? ichimokuGetSignals(c15m, '15minute') : null;
    const s1h   = c1h  && c1h.length  >= 52 ? ichimokuGetSignals(c1h,  '60minute') : null;
    const s4h   = c4h  && c4h.length  >= 52 ? ichimokuGetSignals(c4h,  '4h')       : null;
    const s1d   = c1d  && c1d.length  >= 52 ? ichimokuGetSignals(c1d,  'day')      : null;

    const allSigs   = [s15m, s1h, s4h, s1d];
    const hasCall   = allSigs.some((s) => s?.callBuySignal);
    const hasPut    = allSigs.some((s) => s?.putBuySignal);
    const tfVotes   = allSigs.map((s) => _bgTfSignal(s));
    const bullCount = tfVotes.filter((v) => v === 'bullish').length;
    const bearCount = tfVotes.filter((v) => v === 'bearish').length;

    let bias = 'neutral';
    if      (hasCall && !hasPut)    bias = 'bullish';
    else if (hasPut  && !hasCall)   bias = 'bearish';
    else if (bullCount > bearCount) bias = 'bullish';
    else if (bearCount > bullCount) bias = 'bearish';

    _bgCachedBias = { slot, bias };
    return bias;
  } catch {
    return 'neutral';
  }
}

// Non-tradeable index tokens — never send Telegram for these
const _NON_TRADEABLE_TG = new Set([
  256265,  // NIFTY 50
  260105,  // BANKNIFTY
  264969,  // India VIX
  274441,  // FINNIFTY
  288009,  // MIDCPNIFTY
  265,     // BSE SENSEX
  270857,  // BSE BANKEX
]);

// MCX symbol prefix hint — same regex as autoTrader
const _MCX_HINT_RE = /^(CRUDE|GOLD|SILVER|COPPER|NATURAL|ALUMIN|ZINC|LEAD|NICKEL|MENTHA)/i;

/**
 * Mark a (token, interval, patternId, signal) combo as fired for today.
 * Returns true on the first claim; false if it already fired today (suppress).
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

/**
 * Compute the Ichimoku directional bias for the most recent candle.
 * Uses the Kijun-sen (26-period midpoint) as the equilibrium baseline —
 * the primary trend filter in Ichimoku: price above = bullish, below = bearish.
 *
 * Works with as few as 26 candles, so all intervals (including synthetic 4h)
 * can be evaluated even when bar counts are close to the 52-bar minimum.
 *
 * @param {Array}  candles  OHLCV candle array, newest last
 * @returns {'bullish'|'bearish'|'neutral'}
 */
function _computeCloudBias(candles) {
  if (!candles || candles.length < 26) return 'neutral';
  const n     = candles.length;
  const close = candles[n - 1].close;

  // Kijun-sen: (26-period high + 26-period low) / 2
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 26; i < n; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low  < lo) lo = candles[i].low;
  }
  const kijun = (hi + lo) / 2;

  if (close > kijun) return 'bullish';
  if (close < kijun) return 'bearish';
  return 'neutral';
}

/**
 * Determine MTF alignment for a new alert.
 * Looks up _biasMap for ALL other timeframes of the same token and returns
 * those whose stored bias matches the alert's signal direction.
 *
 * Example: RELIANCE 1h bullish alert fires.  If 4h bias = 'bullish' and
 * 1d bias = 'bullish', alignedTfs = ['4h', '1d'] and mtfAligned = true.
 *
 * @param {number} token           Instrument token
 * @param {string} currentInterval The interval the alert fired on (excluded from check)
 * @param {string} signal          'bullish' | 'bearish'
 * @returns {{ mtfAligned: boolean, alignedTfs: string[] }}
 */
function _getMtfAlignment(token, currentInterval, signal) {
  const tokenBias = _biasMap.get(Number(token));
  if (!tokenBias) return { mtfAligned: false, alignedTfs: [] };

  const alignedTfs = [];
  for (const [interval, bias] of Object.entries(tokenBias)) {
    if (interval === currentInterval) continue;
    if (bias === signal) alignedTfs.push(TF_LABEL[interval] || interval);
  }
  return { mtfAligned: alignedTfs.length > 0, alignedTfs };
}

// ── Phase 2 data enrichment helpers ──────────────────────────────────────────

/** NIFTY 50 daily cloud colour — cached for the whole scan cycle. */
function _getNiftyBias() {
  try {
    const niftyCandles = candleStore.getCandlesSync(256265, 'day');
    if (!niftyCandles || niftyCandles.length < 52) return null;
    return getFutureCloudColor(niftyCandles); // 'bullish' | 'bearish' | 'neutral'
  } catch { return null; }
}

/**
 * Enrich an alertPayload with Ichimoku snapshot, ATR, RSI, and context fields.
 * All values are computed from already-in-memory candles — no network I/O.
 * Mutates alertPayload in place.
 */
function _enrichAlertPayload(alertPayload, candles) {
  const ich   = snapshot(candles);
  const atr14 = getATR(candles, 14);
  const rsi14 = getRSI(candles, 14);

  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const hour   = nowIST.getHours();

  const closePrice = alertPayload.close;

  Object.assign(alertPayload, {
    tenkan:            ich?.tenkan            ?? null,
    kijun:             ich?.kijun             ?? null,
    senkouA:           ich?.senkouA           ?? null,
    senkouB:           ich?.senkouB           ?? null,
    cloudTop:          ich?.cloudTop          ?? null,
    cloudBottom:       ich?.cloudBottom       ?? null,
    cloudThicknessPct: ich && ich.cloudTop != null && ich.cloudBottom != null && closePrice
      ? +((ich.cloudTop - ich.cloudBottom) / closePrice * 100).toFixed(2)
      : null,
    priceVsCloud:      ich?.aboveCloud ? 'above' : ich?.belowCloud ? 'below' : ich ? 'inside' : null,
    tkCross:           ich?.tkCross           ?? null,
    atr14:             atr14 != null ? +atr14.toFixed(2) : null,
    atr14Pct:          atr14 != null && closePrice
      ? +(atr14 / closePrice * 100).toFixed(2)
      : null,
    rsi14:             rsi14 != null ? +rsi14.toFixed(1) : null,
    alignedTfCount:    alertPayload.alignedTfs?.length ?? 0,
    dayOfWeek:         nowIST.getDay(),
    hourIST:           hour,
    sessionSlot:       hour < 11 ? 'open' : hour >= 14 ? 'close' : 'mid',
    niftyBias:         _getNiftyBias(),
  });
}

// ── Next-candle-close calculator ──────────────────────────────────────────────

/**
 * Returns the UTC-ms timestamp of the next candle-close boundary for the
 * given interval, plus CLOSE_DELAY_MS so Kite has time to finalise.
 *
 * '15minute' → next :00/:15/:30/:45 minute mark
 * '60minute' → next :15 past the hour (NSE sessions start at 9:15)
 * '4h'       → synthesised from 60minute — fires on the same 1h boundary
 * 'day'      → 15:30 IST (NSE EOD); wraps to the next trading day
 */
function _nextCloseMs(interval, now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const totalMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const totalSec = totalMin * 60 + ist.getUTCSeconds();

  let targetMs;

  if (interval === 'day') {
    // Daily close = 15:30 IST = minute 930
    const EOD_MIN = 930;
    const todayEod = new Date(ist);
    todayEod.setUTCHours(15, 30, 0, 0);

    if (totalMin < EOD_MIN) {
      targetMs = todayEod.getTime();
    } else {
      // Already past today's close — schedule for tomorrow (skip weekend)
      const next = new Date(todayEod);
      do {
        next.setUTCDate(next.getUTCDate() + 1);
      } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
      targetMs = next.getTime();
    }
  } else {
    // Periodic intervals: align to next multiple of `periodMin`
    // 4h is driven by 60minute (synthesised), so uses the same 1h boundary.
    const periodMin = interval === '15minute' ? 15
                    : /* 60minute | 4h */       60;

    const nextPeriodMin = (Math.floor(totalMin / periodMin) + 1) * periodMin;

    const target = new Date(ist);
    if (nextPeriodMin >= 24 * 60) {
      // Roll into the next calendar day
      const overflow = nextPeriodMin - 24 * 60;
      target.setUTCDate(target.getUTCDate() + 1);
      target.setUTCHours(Math.floor(overflow / 60), overflow % 60, 0, 0);
    } else {
      target.setUTCHours(Math.floor(nextPeriodMin / 60), nextPeriodMin % 60, 0, 0);
    }
    targetMs = target.getTime();
  }

  // Convert IST target → UTC, then add the post-close delay
  return (targetMs - IST_OFFSET_MS) + CLOSE_DELAY_MS;
}

// ── Universe builder ──────────────────────────────────────────────────────────

/**
 * Build the list of F&O stocks to scan on each background run.
 *
 * Uses the persistent F&O stock registry (NSE equity tokens) instead of
 * resolving NFO front-month futures on every call.  This matters for two
 * reasons:
 *
 *   1. STABILITY — NSE equity tokens never expire.  NFO futures tokens roll
 *      over every month; a fresh contract has only ~42 trading days of history,
 *      which is BELOW the MIN_BARS = 52 threshold.  The daily-interval scan
 *      was silently producing zero alerts because every front-month contract
 *      was skipped for insufficient candle data.
 *
 *   2. CONSISTENCY — The manual /api/scan endpoint already uses foStockRegistry.
 *      Using the same universe here ensures background and manual scans agree.
 *
 * Falls back to deriving from instrumentCache if the registry file hasn't been
 * built yet (first boot before Kite auth completes the fo-registry build).
 */
function _buildUniverse() {
  const universe = [];

  // ── NSE F&O equity stocks ─────────────────────────────────────────────────
  // Primary path: use the stable NSE equity token registry.
  const fromRegistry = foStockRegistry.getAll();
  if (fromRegistry.length > 0) {
    universe.push(...fromRegistry);
  } else if (instrumentCache.isLoaded()) {
    // Fallback: derive from instrumentCache the first time (before registry exists).
    // Identical to the fallback in scan.js _allFoStocks().
    const names = instrumentCache.getFutureNames();
    for (const name of names) {
      const eq = instrumentCache.getNseEquity(name);
      if (!eq) continue;
      universe.push({
        instrumentToken: eq.instrumentToken,
        tradingsymbol:   eq.tradingsymbol,
        exchange:        'NSE',
        name,
      });
    }
  }

  // ── MCX macro instruments ─────────────────────────────────────────────────
  // Add Crude Oil, Gold, Silver, Natural Gas so MCX alerts fire during MCX hours (09:00–23:30 IST).
  // These are covered by patternAlertWatcher via live KiteTicker ticks, but adding
  // them here ensures the scheduled bg scan also catches candle-close setups.
  const MCX_MACROS = [
    ['CRUDEOIL',   'Crude Oil'],
    ['GOLD',       'Gold'],
    ['SILVER',     'Silver'],
    ['NATURALGAS', 'Natural Gas'],
  ];
  for (const [symbol, label] of MCX_MACROS) {
    try {
      const inst = getFrontMonthFutures(symbol, 'MCX');
      if (inst) {
        universe.push({
          instrumentToken: inst.instrumentToken,
          tradingsymbol:   inst.tradingsymbol,
          exchange:        'MCX',
          name:            label,
        });
      }
    } catch { /* instrumentCache not ready yet — skip silently */ }
  }

  return universe;
}

// ── Core scan ────────────────────────────────────────────────────────────────

/**
 * Run all patterns against all NFO futures for the given interval.
 * Sends Telegram + SSE for every new match.
 */
async function _runScanForInterval(interval) {
  // Record the start time before the market-hours guard so diagnostics reflect
  // every trigger attempt, not just the ones that proceeded past the guard.
  _lastRunAt[interval] = Date.now();

  // Check module config — skip if backgroundScan was disabled while running
  if (!store.isModuleEnabled('backgroundScan')) {
    console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — skipped (module disabled)`);
    return;
  }

  if (!isAnyMarketOpen()) {
    console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — skipped (market closed)`);
    return;
  }

  const instruments = _buildUniverse();
  if (!instruments.length) {
    console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — skipped (instrument cache not ready)`);
    return;
  }

  const patterns = patternRegistry.list();
  const chatId   = store.getTelegramChatId();
  const tfLabel  = TF_LABEL[interval] || interval;

  if (!chatId) {
    console.warn(`[BgScanner] ⚠️  Telegram chatId not set — alerts will NOT reach Telegram. Set TELEGRAM_CHAT_ID env var or send /start to the bot.`);
  }

  const t0 = Date.now();
  console.log(`[BgScanner] ${tfLabel} candle close — scanning ${instruments.length} stocks × ${patterns.length} patterns`);

  let scannedCount = 0;
  let matchCount   = 0;
  let tgSentCount  = 0;

  for (const inst of instruments) {
    // Fetch candles; 4h synthesised from 1h buffer
    let candles;
    try {
      if (interval === '4h') {
        const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute', SCAN_BARS['60minute']);
        candles   = (c1h && c1h.length >= 8) ? to4H(c1h) : null;
      } else {
        candles = await candleStore.getCandles(inst.instrumentToken, interval, SCAN_BARS[interval] ?? 100);
      }
    } catch (err) {
      console.warn(`[BgScanner] Candle fetch failed ${inst.tradingsymbol}:${interval} —`, err.message);
      continue;
    }

    if (!candles || candles.length < MIN_BARS) continue;
    scannedCount++;

    // Notify tradeWatcher of the latest 15m candle close so it can confirm or
    // cancel any pending SL breach for trades on this instrument.
    // This runs for every subscribed token regardless of whether a pattern matched.
    if (interval === '15minute') {
      try {
        _tradeWatcher().onCandleClose(inst.instrumentToken, interval, candles[candles.length - 1].close);
      } catch { /* never let candle-close notification block the scan */ }
    }

    // Future cloud colour for this instrument+interval — computed once and
    // attached to every alert payload so autoTrader can gate on it.
    const futureCloudColor = getFutureCloudColor(candles);

    // Store cloud bias for this token×interval so MTF alignment checks below
    // can compare against other intervals already scanned (or scanned earlier today).
    const _bias = _computeCloudBias(candles);
    const _bEntry = _biasMap.get(Number(inst.instrumentToken)) ?? {};
    _bEntry[interval] = _bias;
    _biasMap.set(Number(inst.instrumentToken), _bEntry);

    const label = inst.name || inst.tradingsymbol;

    // ── Ichimoku snapshot — computed ONCE per instrument, shared across all patterns ──
    // Patterns use inconsistent field names (some return `kijunValue` not `kijun`,
    // some omit `tenkan` entirely). snapshot() always returns the full last-bar
    // Ichimoku from calculate(), guaranteeing tenkan/kijun/cloud fields are present.
    const _ichSnap    = snapshot(candles);
    const _snapClose  = candles[candles.length - 1]?.close ?? null;
    const _snapKijun  = _ichSnap?.kijun  ?? null;
    const _snapTenkan = _ichSnap?.tenkan ?? null;
    const _snapCloudPos = !_ichSnap ? null
      : _ichSnap.aboveCloud ? 'above'
      : _ichSnap.belowCloud ? 'below'
      : 'in';

    // Per-instrument Telegram candidates — keyed by signal.
    // After the pattern loop we pick the highest-score match per signal and
    // apply the MTF gate + TF-priority rules before sending to Telegram.
    // SSE, MongoDB, and alertBus still fire for EVERY match regardless.
    const tgBestBySignal = new Map(); // signal → { alertPayload, score, result, patternLabel }

    for (const { id: patternId, label: patternLabel } of patterns) {
      // Pattern config gate — skip if scan is disabled for this pattern+interval
      if (!store.isPatternEnabled(patternId, interval, 'scan')) continue;

      const patternDef = patternRegistry.get(patternId);

      let result;
      try {
        // F11: Pass interval so _naturalTarget lookback scales with TF
        result = patternDef.run(candles, { ...patternDef.defaultOpts, interval });
      } catch (err) {
        console.warn(`[BgScanner] pattern.run failed (${patternId}) ${label}:${interval} —`, err.message);
        continue;
      }

      if (!result?.matched || !result.signal) continue;

      // ── TK / Price vs Kijun alignment gate ───────────────────────────────────
      // Uses the per-instrument snapshot (not result fields) — reliable across all
      // patterns regardless of what field names each pattern returns.
      //
      // Bullish: Tenkan > Kijun AND (price > Kijun OR price > Tenkan)
      //          → simplifies to: Tenkan > Kijun AND price > Kijun
      //            (since Kijun ≤ Tenkan, being above Kijun is the minimum bar)
      // Bearish: Tenkan < Kijun AND price < Kijun
      //
      // tk-reversion is exempt — it deliberately fires from the extended side
      // (bearish from above Kijun reverting down; bullish from below Kijun reverting up).
      // NOT marked in dedup — can re-fire once alignment corrects.
      if (patternId !== 'tk-reversion' && _snapKijun != null && _snapTenkan != null && _snapClose != null) {
        if (result.signal === 'bullish' && !(_snapTenkan > _snapKijun && _snapClose > _snapKijun)) {
          continue;
        }
        if (result.signal === 'bearish' && !(_snapTenkan < _snapKijun && _snapClose < _snapKijun)) {
          continue;
        }
      }

      // ── Cloud position gate ───────────────────────────────────────────────────
      // Uses the per-instrument snapshot cloud position (reliable, not result.cloudPosition
      // which some patterns omit or compute differently).
      //
      // For all patterns EXCEPT tk-reversion:
      //   Bullish → above or inside cloud  (NOT below)
      //   Bearish → below or inside cloud  (NOT above)
      //
      // tk-reversion is exempt: bearish fires above cloud, bullish fires below cloud.
      // Its R8 rule in patternRegistry already enforces the correct cloud side.
      if (patternId !== 'tk-reversion' && _snapCloudPos != null) {
        if (result.signal === 'bullish' && _snapCloudPos === 'below') continue;
        if (result.signal === 'bearish' && _snapCloudPos === 'above') continue;
      }

      // ── Quality score — computed BEFORE dedup so filtered signals can retry next candle
      const qCfg = store.getQualityScoreConfig();
      const { qualityScore, setupGrade, scoreBreakdown } = qCfg.enabled
        ? signalScorer.compute(inst.instrumentToken, candles, result, interval, qCfg, patternId)
        : { qualityScore: null, setupGrade: null, scoreBreakdown: null };

      // Scan gate: skip if quality too low — NOT marked in dedup so it can re-fire
      if (qCfg.enabled && qCfg.scanGateEnabled && qualityScore !== null && qualityScore < qCfg.minQualityScore) {
        console.log(`[BgScanner] ⏭ Quality: ${inst.tradingsymbol} ${patternId} (${tfLabel}) score=${qualityScore} (${setupGrade}) < min ${qCfg.minQualityScore}`);
        continue;
      }

      // Dedup: at most one alert per (stock, interval, pattern, direction) per IST day
      const dedupKey = `bg:${inst.instrumentToken}:${interval}:${patternId}:${result.signal}`;
      if (!_claimFire(dedupKey)) continue;

      matchCount++;

      // MTF alignment: check if OTHER timeframes for this token confirm the direction.
      // A TF is "aligned" when its last-known Kijun bias matches the alert signal —
      // meaning price is above/below the Kijun on that TF as well.
      const { mtfAligned, alignedTfs } = _getMtfAlignment(
        inst.instrumentToken, interval, result.signal,
      );

      // ── SSE → Scanner UI tab ──────────────────────────────────────────────
      const alertPayload = {
        token:             Number(inst.instrumentToken),
        label,
        tradingsymbol:     inst.tradingsymbol,
        exchange:          inst.exchange,   // 'NSE' | 'MCX' — used by autoTrader market-hours gate
        interval,
        tfLabel,
        patternId,
        patternLabel,
        signal:            result.signal,
        score:             result.score            ?? null,
        close:             result.close            ?? null,
        strength:          result.strength         ?? null,
        cloudPosition:     result.cloudPosition    ?? null,
        barsAgo:           result.barsAgo          ?? null,
        consecutiveBars:   result.consecutiveBars  ?? null,
        cloudThickness:    result.cloudThickness   ?? null,
        // SL / Target — targetSource = 'fixed' (2× risk) or 'swing' (recent high/low)
        sl:                result.sl               ?? null,
        target:            result.target           ?? null,
        targetSource:      result.targetSource     ?? null,
        // Volume
        volumeRatio:       result.volumeRatio      ?? null,
        volumeConfirmed:   result.volumeConfirmed  ?? null,
        // Future cloud colour — 'bullish' | 'bearish' | 'neutral' | null
        // Used by autoTrader to gate orders on cloud direction alignment.
        futureCloudColor,
        // MTF alignment — other TFs where price confirms the same direction
        mtfAligned,
        alignedTfs,
        // Keep confluenceTfs/confluenceCount for Telegram message builder compat
        confluenceTfs:   alignedTfs,
        confluenceCount: alignedTfs.length + 1,
        // Quality score (0–10)
        qualityScore,
        setupGrade,
        scoreBreakdown,
        // R12: Trailing anchor suggestion for TSL
        trailingAnchor:  result.trailingAnchor ?? null,
        // R13: Normalized score for cross-pattern comparison
        normalizedScore: result.score != null ? +(result.score / (patternRegistry.get(patternId)?.maxScore ?? 5)).toFixed(2) : null,
        ts:              Date.now(),
      };

      // ── Phase 2: enrich with Ichimoku snapshot + context (no recompute) ───
      _enrichAlertPayload(alertPayload, candles);

      broadcast('scan_alert', alertPayload);

      // ── MongoDB — fire-and-forget (never blocks the scan loop) ────────────
      db.alertRepo.insertAlert(alertPayload, 'background');

      // ── Auto-trader — fire-and-forget internal event ──────────────────────
      alertBus.emit('alert', alertPayload, 'background');

      const volTag = result.volumeConfirmed ? ' 📈vol' : '';
      const mtfTag = alignedTfs.length      ? ` ⚡MTF(${alignedTfs.join('+')})` : '';
      const gradeTag = setupGrade ? ` 🏅${setupGrade}(${qualityScore}/10)` : '';
      console.log(`[BgScanner] ${result.signal === 'bullish' ? '🟢' : '🔴'} ${patternId} — ${label} (${tfLabel})${volTag}${mtfTag}${gradeTag}`);

      // Collect Telegram candidate — keep highest score per signal for this instrument
      const score = result.score ?? 0;
      const prevBest = tgBestBySignal.get(result.signal);
      if (!prevBest || score > (prevBest.score ?? 0)) {
        tgBestBySignal.set(result.signal, { alertPayload, score, result, patternLabel });
      }
    }

    // ── Telegram — one message per instrument per signal (best score only) ──
    // Score dedup per TF: skip if same (token, signal, interval) already sent
    // with equal or higher score today. Each TF fires independently — 15m is
    // NOT suppressed by a prior 1h alert for the same stock.
    // SSE and alertBus already fired above for every match — this rule only
    // controls what reaches the user's Telegram chat.
    const mktOpen = inst.exchange === 'MCX' ? isMcxOpen() : isNseOpen();
    if (chatId && mktOpen && tgBestBySignal.size > 0) {
      const today = _istDateStr();

      for (const [signal, best] of tgBestBySignal) {
        // Pattern config gate — skip Telegram if alert is disabled for this pattern+interval
        if (!store.isPatternEnabled(best.alertPayload.patternId, interval, 'alert')) continue;

        // Quality score alert gate — block Telegram when quality too low
        const qCfgTg = store.getQualityScoreConfig();
        if (qCfgTg.enabled && qCfgTg.alertGateEnabled && best.alertPayload.qualityScore != null) {
          if (best.alertPayload.qualityScore < qCfgTg.minQualityScore) continue;
        }

        // ── Trading-rule gates — mirror autoTrader order filters ────────────────
        // These ensure every Telegram alert represents a signal that would also
        // pass the order execution gates.  No alert for a signal we'd never trade.

        // Gate 1: non-tradeable indices (NIFTY, SENSEX, VIX etc.)
        if (_NON_TRADEABLE_TG.has(Number(best.alertPayload.token))) continue;

        // Gate 2: MCX — no 15-minute alerts (too noisy; MCX needs ≥ 1h setup)
        const isMcxAlert = best.alertPayload.exchange === 'MCX'
          || _MCX_HINT_RE.test(String(label ?? ''));
        if (isMcxAlert && (interval === '15minute' || best.alertPayload.tfLabel === '15m')) {
          console.log(`[BgScanner] ⏸ Telegram skipped — ${label} MCX 15m (too noisy)`);
          continue;
        }

        // Gate 3: market bias (15m / 1h only) — skip if NIFTY consensus opposes direction
        if (interval === '15minute' || interval === '60minute') {
          const bias = _bgGetMarketBias();
          if (bias === 'bullish' && signal === 'bearish') {
            console.log(`[BgScanner] ⏸ Telegram skipped — ${label} ${signal} (${best.alertPayload.tfLabel}) NIFTY bias=BULLISH`);
            continue;
          }
          if (bias === 'bearish' && signal === 'bullish') {
            console.log(`[BgScanner] ⏸ Telegram skipped — ${label} ${signal} (${best.alertPayload.tfLabel}) NIFTY bias=BEARISH`);
            continue;
          }
        }

        // Gate 4: future cloud direction — must agree with signal OR score ≥ 3
        {
          const { futureCloudColor, score: alertScore } = best.alertPayload;
          const expectedCloud = signal === 'bullish' ? 'bullish' : 'bearish';
          if (futureCloudColor && futureCloudColor !== 'neutral' && futureCloudColor !== expectedCloud) {
            if ((alertScore ?? 0) < 3) {
              console.log(`[BgScanner] ⏸ Telegram skipped — ${label} (${best.alertPayload.tfLabel}) future cloud=${futureCloudColor} opposes ${signal}, score=${alertScore ?? 0} < 3`);
              continue;
            }
          }
        }

        // Gate 5: 15m requires at least one higher-TF alignment (1h / 4h / 1d)
        if (interval === '15minute' || best.alertPayload.tfLabel === '15m') {
          const higherTfs  = new Set(['1h', '4h', '1d']);
          const hasHigherTf = best.alertPayload.alignedTfs?.some((tf) => higherTfs.has(tf));
          if (!hasHigherTf) {
            console.log(`[BgScanner] ⏸ Telegram skipped — ${label} 15m ${signal}: no 1h/4h/1d MTF alignment`);
            continue;
          }
        }

        // Gate 6: minimum R:R — same threshold as autoTrader.minRR
        {
          const { close: aC, sl: aSl, target: aTgt } = best.alertPayload;
          if (aC && aSl && aTgt) {
            const riskPerUnit = Math.abs(aC - aSl);
            if (riskPerUnit > 0.01) {
              const rrRatio   = Math.abs(aTgt - aC) / riskPerUnit;
              const minRR     = store.getAutoTraderSettings().minRR ?? 2.0;
              if (rrRatio < minRR) {
                console.log(`[BgScanner] ⏸ Telegram skipped — ${label} (${best.alertPayload.tfLabel}) R:R=${rrRatio.toFixed(2)} < min ${minRR}`);
                continue;
              }
            }
          }
        }
        // ── End trading-rule gates ──────────────────────────────────────────────

        // Score dedup — skip if same TF + same signal already sent with equal/higher score today.
        // Each TF fires independently — 15m alerts are NOT suppressed by a prior 1h alert.
        const sentKey  = `${inst.instrumentToken}:${signal}:${interval}:${today}`;
        const prevSent = _tgSentTfMap.get(sentKey);
        if (prevSent && prevSent.score >= best.score) {
          // Same TF, already sent equal or better score today
          continue;
        }

        const text = patternAlertMessage.build({
          label,
          tfLabel,
          patternLabel: best.patternLabel,
          result:       best.result,
          kind:         inst.exchange === 'MCX' ? 'macro' : 'stock',
          confluenceTfs: best.alertPayload.alignedTfs,
        });
        try {
          await telegramNotifier.sendMessage(chatId, text);
          _tgSentTfMap.set(sentKey, { score: best.score });
          tgSentCount++;
        } catch (err) {
          console.warn(`[BgScanner] Telegram failed for ${label}:`, err.message);
        }
      }
    } else if (chatId && !mktOpen && tgBestBySignal.size > 0) {
      console.log(`[BgScanner] ⏸ Telegram skipped — ${label} (${inst.exchange} closed)`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[BgScanner] ${tfLabel} done — ${scannedCount}/${instruments.length} scanned, ` +
    `${matchCount} match${matchCount !== 1 ? 'es' : ''}, ` +
    `${tgSentCount} Telegram msg${tgSentCount !== 1 ? 's' : ''} sent (${elapsed}s)`,
  );

  // Send completion summary ONLY when matches were found.
  // "No matches" messages would flood the chat (one every 15 min during MCX hours)
  // and bury the actual alerts that matter. The scan result is always visible in
  // the Railway / server console logs and the Scanner tab in the UI.
  if (chatId && matchCount > 0) {
    const summary =
      `✅ <b>Scan done</b> — ${tfLabel} · ${matchCount} match${matchCount !== 1 ? 'es' : ''} found\n` +
      `📊 ${scannedCount} stocks scanned in ${elapsed}s`;
    try {
      await telegramNotifier.sendMessage(chatId, summary);
    } catch (err) {
      console.warn('[BgScanner] Done notification failed:', err.message);
    }
  }
}

// ── Last-run tracking (for diagnostics) ──────────────────────────────────────

// Records the UTC-ms timestamp of the start of each interval's most recent run.
// Used by getDebugInfo() and visible via GET /api/scan/bg-status.
const _lastRunAt = {};

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timers  = {};
let _running = false;

/**
 * Return the UTC-ms timestamp of the next market open (MCX 09:00 IST or NSE 09:15 IST,
 * whichever comes first on the next available weekday) at or after `from`.
 *
 * MCX opens at 09:00 IST — earlier than NSE (09:15) — so waking at 09:00 covers both.
 * Used by the scheduler to sleep outside ALL market hours instead of burning timers
 * overnight when neither NSE nor MCX is open.
 */
function _nextMarketOpenMs(from = Date.now()) {
  // Add 1 min to avoid returning "now" when we just opened
  let ist = new Date(from + IST_OFFSET_MS + 60_000);
  // MCX opens at 09:00 IST (minute 540); use 30s buffer → 09:00:30
  const MCX_OPEN_MIN = 540;
  for (let i = 0; i < 8; i++) {
    const dow = ist.getUTCDay();
    const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const isWeekend = dow === 0 || dow === 6;
    if (!isWeekend && min < MCX_OPEN_MIN) {
      // Same day — wake at MCX open 09:00:30 IST
      ist.setUTCHours(9, 0, 30, 0);
      return ist.getTime() - IST_OFFSET_MS;
    }
    // Roll to next calendar day at 09:00:30 IST
    ist.setUTCDate(ist.getUTCDate() + 1);
    ist.setUTCHours(9, 0, 30, 0);
    const newDow = ist.getUTCDay();
    if (newDow !== 0 && newDow !== 6) {
      return ist.getTime() - IST_OFFSET_MS;
    }
  }
  // Fallback — shouldn't reach here
  return from + 24 * 60 * 60 * 1000;
}

function _scheduleNext(interval) {
  if (!_running) return;

  const now    = Date.now();
  let   fireAt = _nextCloseMs(interval, now);

  // ── Off-hours guard ──────────────────────────────────────────────────────
  // Now that the universe includes MCX instruments (open 09:00–23:30 IST) as well
  // as NSE stocks (09:15–15:30 IST), we sleep only when BOTH markets are closed —
  // i.e. outside 09:00–23:30 IST on weekdays.  Resume at 09:00 IST (MCX open).
  if (!isAnyMarketOpen(fireAt)) {
    const wakeAt = _nextMarketOpenMs(now);
    if (wakeAt > fireAt) {
      const wakeIST = new Date(wakeAt + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
      console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — all markets closed, sleeping until ${wakeIST} IST`);
      fireAt = wakeAt;
    }
  }

  const delay  = fireAt - now;
  const fireIST = new Date(fireAt + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`[BgScanner] ${TF_LABEL[interval] || interval} — next scan at ${fireIST} IST (in ${Math.round(delay / 60000)} min)`);

  _timers[interval] = setTimeout(async () => {
    if (!_running) return;
    try {
      await _runScanForInterval(interval);
    } catch (err) {
      console.error(`[BgScanner] Unhandled error on ${interval}:`, err.message);
    }
    // Always reschedule — even if the scan failed or market was closed
    _scheduleNext(interval);
  }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the background scanner.
 * Schedules a timer for each candle interval that fires at the next close
 * boundary and then re-schedules itself indefinitely.
 *
 * Should be called once after instrumentCache.load() succeeds.
 * Respects module config — if backgroundScan is disabled, logs and returns.
 */
function start() {
  // Check module config — skip if backgroundScan is disabled
  if (!store.isModuleEnabled('backgroundScan')) {
    console.log('[BgScanner] Module disabled via settings — not starting');
    return;
  }

  if (_running) {
    console.log('[BgScanner] Already running — ignoring duplicate start()');
    return;
  }
  _running = true;

  // Schedule all four intervals independently so they fire at their own boundaries.
  // '4h' shares the 60minute timer logic but runs its own synthesis + dedup.
  for (const interval of INTERVALS) {
    _scheduleNext(interval);
  }

  console.log('[BgScanner] Started — auto-scanning all NFO futures at each candle close');
}

/**
 * Stop the background scanner and cancel all pending timers.
 */
function stop() {
  _running = false;
  for (const t of Object.values(_timers)) clearTimeout(t);
  _timers = {};
  console.log('[BgScanner] Stopped');
}

/**
 * Diagnostic: returns the next fire time for each interval (UTC ms).
 */
function getSchedule() {
  const now = Date.now();
  return Object.fromEntries(
    INTERVALS.map((iv) => {
      const fireAt  = _nextCloseMs(iv, now);
      const fireIST = new Date(fireAt + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
      return [iv, { fireAt, fireIST, inMin: Math.round((fireAt - now) / 60000) }];
    }),
  );
}

/**
 * Clear all dedup entries so every pattern fires again on the next scan.
 * Useful after a server restart or when testing — call via POST /api/scan/clear-dedup.
 */
function clearDedup() {
  const dedupCount = _dedup.size;
  const tgCount    = _tgSentTfMap.size;
  _dedup.clear();
  _tgSentTfMap.clear();  // reset Telegram score dedup so all alerts re-fire
  _biasMap.clear();      // also reset MTF bias so next scan starts fresh
  console.log(`[BgScanner] Dedup cleared — ${dedupCount} pattern entries + ${tgCount} Telegram entries removed`);
  return dedupCount + tgCount;
}

/**
 * Immediately trigger a scan for the given interval, bypassing the market-hours
 * check. Useful for manual testing via POST /api/scan/trigger-bg-scan without
 * waiting for a candle-close boundary.
 *
 * @param {string} [interval='15minute']
 */
async function triggerNow(interval = '15minute') {
  await _runScanForInterval(interval);
}

/**
 * Returns diagnostic info about the scanner's current state:
 *   running   — whether the scheduler loop is active
 *   dedupSize — number of entries in the dedup map (one per fired alert today)
 *   lastRunAt — UTC-ms timestamp of the last run attempt per interval
 *   schedule  — next fire time per interval
 */
function getDebugInfo() {
  return {
    running:   _running,
    dedupSize: _dedup.size,
    lastRunAt: { ..._lastRunAt },
    schedule:  getSchedule(),
  };
}

module.exports = { start, stop, getSchedule, clearDedup, triggerNow, getDebugInfo };
