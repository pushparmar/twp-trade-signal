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
const { to4H }            = require('./ichimoku');
const patternAlertMessage = require('./patternAlertMessage');
const instrumentCache     = require('./instrumentCache');
const foStockRegistry     = require('./foStockRegistry');
const { isAnyMarketOpen, isNseOpen, isMcxOpen, IST_OFFSET_MS } = require('../utils/marketHours');
const { getFrontMonthFutures } = require('./macroAnalysis');
const db                  = require('../db');
const alertBus            = require('./alertBus');

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

  const t0 = Date.now();
  console.log(`[BgScanner] ${tfLabel} candle close — scanning ${instruments.length} stocks × ${patterns.length} patterns`);

  // Notify that the scan has started
  if (chatId) {
    const now = new Date(Date.now() + IST_OFFSET_MS);
    const timeStr = now.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
    try {
      await telegramNotifier.sendMessage(
        chatId,
        `🔍 <b>Auto-scan started</b> — ${tfLabel} candle close\n` +
        `📊 Scanning ${instruments.length} F&O stocks × ${patterns.length} patterns\n` +
        `🕐 ${timeStr}`,
      );
    } catch (err) {
      console.warn('[BgScanner] Start notification failed:', err.message);
    }
  }

  let scannedCount = 0;
  let matchCount   = 0;

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

    // Store cloud bias for this token×interval so MTF alignment checks below
    // can compare against other intervals already scanned (or scanned earlier today).
    const _bias = _computeCloudBias(candles);
    const _bEntry = _biasMap.get(Number(inst.instrumentToken)) ?? {};
    _bEntry[interval] = _bias;
    _biasMap.set(Number(inst.instrumentToken), _bEntry);

    const label = inst.name || inst.tradingsymbol;

    for (const { id: patternId, label: patternLabel } of patterns) {
      const patternDef = patternRegistry.get(patternId);

      let result;
      try {
        result = patternDef.run(candles, patternDef.defaultOpts);
      } catch (err) {
        console.warn(`[BgScanner] pattern.run failed (${patternId}) ${label}:${interval} —`, err.message);
        continue;
      }

      if (!result?.matched || !result.signal) continue;

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
        // MTF alignment — other TFs where price confirms the same direction
        mtfAligned,
        alignedTfs,
        // Keep confluenceTfs/confluenceCount for Telegram message builder compat
        confluenceTfs:   alignedTfs,
        confluenceCount: alignedTfs.length + 1,
        ts:              Date.now(),
      };
      broadcast('scan_alert', alertPayload);

      // ── MongoDB — fire-and-forget (never blocks the scan loop) ────────────
      db.alertRepo.insertAlert(alertPayload, 'background');

      // ── Auto-trader — fire-and-forget internal event ──────────────────────
      alertBus.emit('alert', alertPayload, 'background');

      const volTag = result.volumeConfirmed ? ' 📈vol' : '';
      const mtfTag = alignedTfs.length      ? ` ⚡MTF(${alignedTfs.join('+')})` : '';
      console.log(`[BgScanner] ${result.signal === 'bullish' ? '🟢' : '🔴'} ${patternId} — ${label} (${tfLabel})${volTag}${mtfTag}`);

      // ── Telegram — gated on the instrument's own exchange hours ─────────
      // NSE / CDS stocks  → only alert during NSE session  (09:15–15:30 IST)
      // MCX commodities   → only alert during MCX session  (09:00–23:30 IST)
      // SSE broadcast above always fires so the Scanner UI stays live.
      const mktOpen = inst.exchange === 'MCX' ? isMcxOpen() : isNseOpen();
      if (chatId && mktOpen) {
        const text = patternAlertMessage.build({
          label, tfLabel, patternLabel, result, kind: inst.exchange === 'MCX' ? 'macro' : 'stock',
          confluenceTfs: alignedTfs,
        });
        try {
          await telegramNotifier.sendMessage(chatId, text);
        } catch (err) {
          console.warn(`[BgScanner] Telegram failed for ${label}:`, err.message);
        }
      } else if (chatId && !mktOpen) {
        console.log(`[BgScanner] ⏸ Telegram skipped — ${label} (${inst.exchange} closed)`);
      }
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[BgScanner] ${tfLabel} done — ${scannedCount}/${instruments.length} scanned, ` +
    `${matchCount} alert${matchCount !== 1 ? 's' : ''} sent (${elapsed}s)`,
  );

  // Send completion summary
  if (chatId) {
    const summary = matchCount > 0
      ? `✅ <b>Scan done</b> — ${tfLabel} · ${matchCount} match${matchCount !== 1 ? 'es' : ''} found\n` +
        `📊 ${scannedCount} stocks scanned in ${elapsed}s`
      : `✅ <b>Scan done</b> — ${tfLabel} · no new matches\n` +
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
 */
function start() {
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
  const count = _dedup.size;
  _dedup.clear();
  _biasMap.clear();   // also reset MTF bias so next scan starts fresh
  console.log(`[BgScanner] Dedup cleared — ${count} entries removed`);
  return count;
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
