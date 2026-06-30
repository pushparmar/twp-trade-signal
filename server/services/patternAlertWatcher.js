/**
 * Pattern Alert Watcher
 *
 * Runs every registered pattern on each 15m / 1h / 4h / 1d candle close
 * for index and macro instruments. Fires a Telegram message on first match.
 *
 * Note: liveScanner.js does the same for user watchlist stocks — both watchers
 * now share patternAlertMessage.build() so the Telegram wording stays in sync.
 *
 * Deduplication:
 *   Each (token, interval, patternId, signal) is allowed to fire at most ONCE
 *   per trading day. It resets at midnight IST, so the same setup can alert
 *   again on the next session.
 *
 * 4h handling:
 *   Kite has no native 4h interval. When a '60minute' candle closes we
 *   synthesise 4h candles from the 1h buffer and run patterns on those too.
 */

const candleStore      = require('./candleStore');
const patternRegistry  = require('./patternRegistry');
const telegramNotifier = require('./telegramNotifier');
const store            = require('../store');
const { broadcast }    = require('../sseHub');
const { to4H, getFutureCloudColor, snapshot, getATR, getRSI } = require('./ichimoku');
const patternAlertMessage = require('./patternAlertMessage');
const { isNseOpen, isMcxOpen, IST_OFFSET_MS } = require('../utils/marketHours');
const db             = require('../db');
const alertBus       = require('./alertBus');
const signalScorer   = require('./signalScorer');

// Lazy-required to keep the same circular-dep pattern used in macroWatcher.
const { getFrontMonthFutures } = require('./macroAnalysis');

// ── Constants ────────────────────────────────────────────────────────────────

// Native intervals we care about — '60minute' also triggers the synthetic 4h check.
const WATCHED_INTERVALS = new Set(['15minute', '60minute', 'day']);

// Human-readable TF labels for Telegram messages
const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// ── State ────────────────────────────────────────────────────────────────────

// token (number) → display label, e.g. 256265 → 'NIFTY 50'
const _tokenLabel = new Map();

// token (number) → actual tradingsymbol, e.g. 12345 → 'CRUDEOIL25MAYFUT'
const _tokenTradingsymbol = new Map();

// token (number) → exchange string — used to pick the right market-hours gate
// 'NSE' / 'BSE' → isNseOpen()   |   'MCX' → isMcxOpen()
const _exchangeMap = new Map();

// Dedup: "token:interval:patternId:signal" → { fired: bool, date: string (IST) }
const _dedup = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Returns true if this combination has NOT yet fired today and marks it as fired.
 * Returns false if it already fired today (suppress duplicate alert).
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

// Session-aware 4h synthesis — imported from ichimoku.js.
const _to4H = to4H;

// ── MTF alignment helper ─────────────────────────────────────────────────────

/**
 * Returns true if at least one pattern on any higher timeframe (1h / 4h / 1d)
 * matches the given signal direction for this token.
 *
 * Used as the 15m Telegram gate: an index/macro 15m alert is only worth
 * sending to Telegram when a structurally higher TF confirms the same bias.
 */
function _hasHigherTfAlignment(token, signal) {
  const intervals = [
    { interval: '60minute', candles: candleStore.getCandlesSync(token, '60minute') },
    { interval: 'day',      candles: candleStore.getCandlesSync(token, 'day') },
  ];

  // Synthesise 4h from the 1h buffer when enough bars exist.
  const c1h = candleStore.getCandlesSync(token, '60minute');
  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    if (c4h.length >= 52) {
      intervals.push({ interval: '4h', candles: c4h });
    }
  }

  for (const { interval, candles } of intervals) {
    if (!candles || candles.length < 52) continue;
    for (const { id: patternId } of patternRegistry.list()) {
      const pattern = patternRegistry.get(patternId);
      let result;
      try {
        result = pattern.run(candles, pattern.defaultOpts);
      } catch {
        continue;
      }
      if (result?.matched && result.signal === signal) return true;
    }
  }
  return false;
}

// ── Phase 2 data enrichment helpers ──────────────────────────────────────────

function _getNiftyBias() {
  try {
    const niftyCandles = candleStore.getCandlesSync(256265, 'day');
    if (!niftyCandles || niftyCandles.length < 52) return null;
    return getFutureCloudColor(niftyCandles);
  } catch { return null; }
}

/**
 * Enrich an alertPayload with Ichimoku snapshot, ATR, RSI, and context fields.
 * All values come from already-in-memory candles — no network I/O.
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
    dayOfWeek:         nowIST.getDay(),
    hourIST:           hour,
    sessionSlot:       hour < 11 ? 'open' : hour >= 14 ? 'close' : 'mid',
    niftyBias:         _getNiftyBias(),
  });
}

// ── Alert builder ────────────────────────────────────────────────────────────

async function _runAndAlert(token, interval, candles) {
  const chatId = store.getTelegramChatId();
  // Note: chatId may be null if Telegram is not configured. SSE broadcasts,
  // MongoDB writes, and alertBus events still fire — only Telegram is skipped.

  const label   = _tokenLabel.get(Number(token)) || `Token ${token}`;
  const tfLabel = TF_LABEL[interval] || interval;

  // ── Ichimoku snapshot — computed ONCE per candle set, shared across all patterns ──
  // Patterns use inconsistent field names (kijunValue vs kijun, missing tenkan etc.).
  // snapshot() always returns the full last-bar Ichimoku from calculate().
  const _ichSnap    = snapshot(candles);
  const _snapClose  = candles[candles.length - 1]?.close ?? null;
  const _snapKijun  = _ichSnap?.kijun  ?? null;
  const _snapTenkan = _ichSnap?.tenkan ?? null;
  const _snapCloudPos = !_ichSnap ? null
    : _ichSnap.aboveCloud ? 'above'
    : _ichSnap.belowCloud ? 'below'
    : 'in';

  for (const { id: patternId, label: patternLabel } of patternRegistry.list()) {
    // ── Config gate: respect Settings UI — skip if scan disabled ─────────
    // Same check as backgroundScanner.js line 441. Without this, disabling
    // a pattern+interval in the UI had no effect on patternAlertWatcher.
    if (!store.isPatternEnabled(patternId, interval, 'scan')) continue;

    const pattern = patternRegistry.get(patternId);

    let result;
    try {
      // F11: Pass interval so _naturalTarget lookback scales with TF
      result = pattern.run(candles, { ...pattern.defaultOpts, interval });
    } catch {
      continue; // bad candle data — skip silently
    }

    if (!result?.matched || !result.signal) {
      // Pattern not active — skip silently.
      // Do NOT call _resetFire here: resetting when the pattern briefly
      // goes false (e.g. price dips inside the cloud for one bar) causes
      // the alert to re-fire on the next candle, producing a Telegram
      // message every 15 min. The dedup resets at midnight IST so a
      // genuine new setup on the next trading day always fires correctly.
      continue;
    }

    // ── TK / Price vs Kijun alignment gate ───────────────────────────────────
    // Uses per-candle snapshot (not result fields) — reliable across all patterns
    // regardless of inconsistent field names (kijunValue vs kijun, missing tenkan).
    //
    // Bullish: Tenkan > Kijun AND price > Kijun
    // Bearish: Tenkan < Kijun AND price < Kijun
    //
    // tk-reversion is exempt — fires from the extended side by design.
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
    // Uses per-candle snapshot cloud position — reliable, not result.cloudPosition.
    //
    // For all patterns EXCEPT tk-reversion:
    //   Bullish → above or inside cloud  (NOT below)
    //   Bearish → below or inside cloud  (NOT above)
    //
    // tk-reversion is exempt: fires above cloud for bearish, below cloud for bullish.
    if (patternId !== 'tk-reversion' && _snapCloudPos != null) {
      if (result.signal === 'bullish' && _snapCloudPos === 'below') continue;
      if (result.signal === 'bearish' && _snapCloudPos === 'above') continue;
    }

    // ── Quality score — computed BEFORE dedup so filtered signals can retry next candle
    const qCfg = store.getQualityScoreConfig();
    const { qualityScore, setupGrade, scoreBreakdown } = qCfg.enabled
      ? signalScorer.compute(token, candles, result, interval, qCfg, patternId)
      : { qualityScore: null, setupGrade: null, scoreBreakdown: null };

    // Scan gate: skip if quality too low — NOT marked in dedup
    if (qCfg.enabled && qCfg.scanGateEnabled && qualityScore !== null && qualityScore < qCfg.minQualityScore) {
      console.log(`[PatternAlert] ⏭ Quality: ${label} ${patternId} (${tfLabel}) score=${qualityScore} (${setupGrade}) < min ${qCfg.minQualityScore}`);
      continue;
    }

    const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
    if (!_claimFire(dedupKey)) continue; // already sent today

    // Build a full alertPayload (same shape as backgroundScanner) so MongoDB,
    // alertBus, and signalOutcomeTracker all receive enriched data.
    const exchange = _exchangeMap.get(Number(token)) ?? 'NSE';
    const alertPayload = {
      token:           Number(token),
      label,
      tradingsymbol:   _tokenTradingsymbol.get(Number(token)) ?? null,
      exchange,
      interval,
      tfLabel,
      patternId,
      patternLabel,
      signal:          result.signal,
      score:           result.score           ?? null,
      close:           result.close           ?? null,
      strength:        result.strength        ?? null,
      cloudPosition:   result.cloudPosition   ?? null,
      barsAgo:         result.barsAgo         ?? null,
      consecutiveBars: result.consecutiveBars ?? null,
      cloudThickness:  result.cloudThickness  ?? null,
      sl:              result.sl              ?? null,
      target:          result.target          ?? null,
      targetSource:    result.targetSource    ?? null,
      volumeRatio:     result.volumeRatio     ?? null,
      volumeConfirmed: result.volumeConfirmed ?? null,
      futureCloudColor: null,
      mtfAligned:      false,
      alignedTfs:      [],
      confluenceTfs:   [],
      confluenceCount: 1,
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

    // ── Phase 2: enrich with Ichimoku snapshot + context ──────────────────
    _enrichAlertPayload(alertPayload, candles);

    // Note: MTF and bias filtering are handled in autoTrader.js (order gate only).
    // Telegram alerts fire for ALL pattern matches so the user sees every signal.

    // Use the shared message builder so the wording stays in sync with liveScanner.
    // 'index' for NIFTY/BANKNIFTY, 'macro' for VIX/Crude/Gold/Silver/USDINR.
    const kind = (Number(token) === 256265 || Number(token) === 260105) ? 'index' : 'macro';
    const text = patternAlertMessage.build({ label, tfLabel, patternLabel, result, kind });

    // Quality score alert gate — block Telegram when quality too low
    const qualityAlertBlocked = qCfg.enabled && qCfg.alertGateEnabled
      && qualityScore !== null && qualityScore < qCfg.minQualityScore;

    // Gate Telegram on chatId + exchange hours + alert channel config:
    //   MCX alerts disabled — no Telegram for commodities
    //   NSE / VIX / CDS         → isNseOpen()  [09:00–15:30 IST]
    // SSE broadcast below always fires so the Scanner UI stays live.
    if (chatId && !qualityAlertBlocked && store.isPatternEnabled(patternId, interval, 'alert')) {
      // Skip MCX symbols — no Telegram for commodities
      if (exchange === 'MCX') {
        console.log(`[PatternAlert] ⏸ ${patternId} ${result.signal} — ${label} (${tfLabel}) — MCX Telegram disabled`);
      } else if (isNseOpen()) {
        try {
          await telegramNotifier.sendMessage(chatId, text);
          console.log(`[PatternAlert] ✅ ${patternId} ${result.signal} — ${label} (${tfLabel})`);
        } catch (err) {
          console.warn(`[PatternAlert] Telegram send failed for ${label}:`, err.message);
        }
      } else {
        console.log(`[PatternAlert] ⏸ ${patternId} ${result.signal} — ${label} (${tfLabel}) — Telegram skipped (${exchange} closed)`);
      }
    }

    // Broadcast to SSE + store in MongoDB + emit to alertBus for outcome tracking
    broadcast('scan_alert', alertPayload);
    db.alertRepo.insertAlert(alertPayload, 'live');
    alertBus.emit('alert', alertPayload, 'live');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by kiteTicker on every candle close.
 * Returns immediately for intervals / tokens we don't watch.
 */
async function onCandleClose(token, interval) {
  if (!WATCHED_INTERVALS.has(interval)) return;
  if (!_tokenLabel.has(Number(token)))   return;

  try {
    // ── Native interval (15m / 1h / 1d) ───────────────────────────────────
    const candles = candleStore.getCandlesSync(token, interval);
    if (candles && candles.length >= 52) {
      await _runAndAlert(token, interval, candles);
    }

    // ── Synthetic 4h: run whenever a 1h candle closes ─────────────────────
    if (interval === '60minute') {
      const c1h = candleStore.getCandlesSync(token, '60minute');
      if (c1h && c1h.length >= 8) {
        const c4h = _to4H(c1h);
        if (c4h.length >= 52) {
          await _runAndAlert(token, '4h', c4h);
        }
      }
    }
  } catch (err) {
    console.warn(`[PatternAlert] Unhandled error on ${token}:${interval} —`, err.message);
  }
}

/**
 * Register index and macro tokens to watch, then pre-seed their candle buffers.
 * Must be called AFTER instrumentCache has loaded so getFrontMonthFutures works.
 */
function start() {
  // ── Index instruments (NSE) ───────────────────────────────────────────
  _tokenLabel.set(256265, 'NIFTY 50');   _exchangeMap.set(256265, 'NSE');
  _tokenLabel.set(260105, 'NIFTY BANK'); _exchangeMap.set(260105, 'NSE');

  // ── Macro instruments ─────────────────────────────────────────────────
  // India VIX intentionally excluded — it is a volatility index, not a
  // tradeable instrument, so Ichimoku pattern alerts on it are meaningless.

  const crudeInst      = getFrontMonthFutures('CRUDEOIL',   'MCX');
  const goldInst       = getFrontMonthFutures('GOLD',       'MCX');
  const silverInst     = getFrontMonthFutures('SILVER',     'MCX');
  const naturalgasInst = getFrontMonthFutures('NATURALGAS', 'MCX');
  const usdinrInst     = getFrontMonthFutures('USDINR',     'CDS');

  if (crudeInst) {
    _tokenLabel.set(crudeInst.instrumentToken, `Crude Oil`);
    _tokenTradingsymbol.set(crudeInst.instrumentToken, crudeInst.tradingsymbol);
    _exchangeMap.set(crudeInst.instrumentToken, 'MCX');
  }
  if (goldInst) {
    _tokenLabel.set(goldInst.instrumentToken, `Gold`);
    _tokenTradingsymbol.set(goldInst.instrumentToken, goldInst.tradingsymbol);
    _exchangeMap.set(goldInst.instrumentToken, 'MCX');
  }
  if (silverInst) {
    _tokenLabel.set(silverInst.instrumentToken, `Silver`);
    _tokenTradingsymbol.set(silverInst.instrumentToken, silverInst.tradingsymbol);
    _exchangeMap.set(silverInst.instrumentToken, 'MCX');
  }
  if (naturalgasInst) {
    _tokenLabel.set(naturalgasInst.instrumentToken, `Natural Gas`);
    _tokenTradingsymbol.set(naturalgasInst.instrumentToken, naturalgasInst.tradingsymbol);
    _exchangeMap.set(naturalgasInst.instrumentToken, 'MCX');
  }
  if (usdinrInst) {
    _tokenLabel.set(usdinrInst.instrumentToken, `USD/INR`);
    _tokenTradingsymbol.set(usdinrInst.instrumentToken, usdinrInst.tradingsymbol);
    _exchangeMap.set(usdinrInst.instrumentToken, 'NSE');
  }

  // ── Pre-seed candle buffers for every watched token × interval ─────────
  // Without this, getCandlesSync() always returns null for macro tokens and
  // pattern alerts for those instruments never fire.
  // Index tokens (NIFTY/BANKNIFTY) are already seeded by indexSignalWatcher,
  // but seeding them here is safe — getCandles() deduplicates concurrent requests.
  const seedIntervals = ['15minute', '60minute', 'day'];
  for (const [token] of _tokenLabel) {
    for (const interval of seedIntervals) {
      candleStore.getCandles(token, interval).catch((err) => {
        console.warn(`[PatternAlert] Seed failed ${token}:${interval} —`, err.message);
      });
    }
  }

  const patterns = patternRegistry.list().map((p) => p.label).join(', ');
  console.log(`[PatternAlert] Ready — watching ${_tokenLabel.size} instruments on 15m / 1h / 4h / 1d`);
  console.log(`[PatternAlert] Patterns: ${patterns}`);
}

function clearDedup() {
  const count = _dedup.size;
  _dedup.clear();
  console.log(`[PatternAlert] clearDedup — cleared ${count} entries`);
  return count;
}

module.exports = { start, onCandleClose, clearDedup };
