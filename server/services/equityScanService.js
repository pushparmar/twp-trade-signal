/**
 * equityScanService.js
 *
 * On-demand, once-a-day full equity scan.
 *
 * Scans ALL NSE EQ instruments (F&O and non-F&O) across 3 timeframes:
 *   4H, 1D, 1W
 *
 * Design principles:
 *   • Completely standalone — zero impact on backgroundScanner or any other service
 *   • Non-blocking — run() returns immediately; scan happens in setImmediate
 *   • Once-a-day cache — results stored in equity_scan_cache MongoDB collection
 *   • Re-run same day returns cached status without re-scanning
 *   • Own dedup set per run — isolated from backgroundScanner dedup map
 *
 * Timeframe candle sources:
 *   4h   → synthesised from 60minute via to4H()   (450 × 1h bars)
 *   day  → candleStore 'day' interval              (200 bars)
 *   week → synthesised from daily via toWeekly()   (400 × day bars → ~80 weeks)
 */

const candleStore      = require('./candleStore');
const patternRegistry  = require('./patternRegistry');
const instrumentCache  = require('./instrumentCache');
const equityScanRepo   = require('../db/repositories/equityScanRepo');
const { to4H }         = require('./ichimoku');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum instruments to scan. Set high enough to cover all NSE EQ (~1200-1400). */
const EQUITY_SCAN_MAX = 1500;

/** Minimum candle bars needed for valid Ichimoku (52 for SenkouB + 26 chikou = 78 minimum). */
const MIN_BARS = 52;

/** Candle bars to fetch per interval. */
const CANDLE_BARS = {
  '4h':   450,   // 1h bars → to4H → ~75 4h candles
  'day':  200,   // ~286 trading days
  'week': 400,   // daily bars → toWeekly → ~80 weekly candles
};

/** Human-readable TF label for each interval. */
const TF_LABELS = { '4h': '4H', 'day': '1D', 'week': '1W' };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── In-memory state ───────────────────────────────────────────────────────────

const _state = {
  running:     false,
  prefetching: false,     // true during phase-1 candle prefetch
  scanDate:    null,      // IST date string 'YYYY-MM-DD' of most recent run
  progress:    { done: 0, total: 0 },
  resultCount: 0,
  startedAt:   null,
  completedAt: null,
  error:       null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _istDateStr(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function _istTimeStr(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16); // 'YYYY-MM-DD HH:mm'
}

/**
 * Synthesise weekly OHLCV candles from daily candles.
 *
 * Groups daily bars by ISO-week Monday key. Emits partial current week
 * (same logic as to4H's today-partial behaviour) so the latest week's
 * price action is always visible.
 *
 * Requires ~390 daily bars for 78 full weekly bars (valid Ichimoku).
 * With 400 daily bars fed in, the result has ~80 weekly candles.
 *
 * @param {object[]} dailyCandles
 * @returns {object[]} Weekly OHLCV candle array
 */
function toWeekly(dailyCandles) {
  const weeks = new Map();

  for (const c of dailyCandles) {
    const d   = new Date(c.date);
    const day = d.getDay(); // 0=Sun … 6=Sat
    // Step back to Monday of this week (ISO week starts Monday)
    const diff    = day === 0 ? -6 : 1 - day;
    const monday  = new Date(d);
    monday.setDate(d.getDate() + diff);
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(c);
  }

  const keys      = [...weeks.keys()].sort();
  const todayKey  = keys[keys.length - 1];
  const out       = [];

  for (const key of keys) {
    const bars   = weeks.get(key);
    const isLast = key === todayKey;

    // Historical weeks with < 3 bars are partial/holiday — skip (same as to4H historical behaviour)
    if (!isLast && bars.length < 3) continue;
    // Current week: emit even 1-bar partial so latest price is visible
    if (bars.length < 1) continue;

    out.push({
      date:    bars[0].date,
      open:    bars[0].open,
      high:    Math.max(...bars.map((c) => c.high)),
      low:     Math.min(...bars.map((c) => c.low)),
      close:   bars[bars.length - 1].close,
      volume:  bars.reduce((s, c) => s + (c.volume || 0), 0),
      partial: isLast && bars.length < 5,
    });
  }

  return out;
}

// ── Cache check ───────────────────────────────────────────────────────────────

/**
 * True if a scan was already run today (checks memory first, then DB).
 * @returns {Promise<boolean>}
 */
async function isCachedToday() {
  const today = _istDateStr();
  if (_state.scanDate === today && !_state.running) return true;
  return equityScanRepo.hasResultsForDate(today);
}

// ── Core scan ─────────────────────────────────────────────────────────────────

/**
 * Start the equity scan in the background (non-blocking).
 *
 * Returns immediately with a status object. The actual scan runs via
 * setImmediate so it does not block the HTTP response.
 *
 * @returns {Promise<{ status: 'started'|'cached'|'running' }>}
 */
async function run() {
  if (_state.running) {
    return { status: 'running', progress: _state.progress };
  }

  const today = _istDateStr();
  const cached = await isCachedToday();
  if (cached) {
    return { status: 'cached', scanDate: today, resultCount: _state.resultCount };
  }

  // Mark running immediately — prevents double-trigger before setImmediate fires
  _state.running     = true;
  _state.prefetching = false;
  _state.scanDate    = today;
  _state.resultCount = 0;
  _state.error       = null;
  _state.startedAt   = new Date().toISOString();
  _state.completedAt = null;
  _state.progress    = { done: 0, total: 0 };

  setImmediate(() => _runScan(today).catch((err) => {
    console.error('[EquityScan] Unexpected scan error:', err.message);
    _state.running     = false;
    _state.prefetching = false;
    _state.error       = err.message;
  }));

  return { status: 'started' };
}

async function _runScan(scanDate) {
  console.log(`[EquityScan] Starting full equity scan for ${scanDate}`);

  const instruments = instrumentCache.getAllNseEquity().slice(0, EQUITY_SCAN_MAX);
  const patterns    = patternRegistry.list();
  const intervals   = ['4h', 'day', 'week'];

  _state.progress.total = instruments.length;   // shows stocks count, not stocks×intervals

  // ── Phase 1: Parallel candle prefetch ─────────────────────────────────────
  // Non-F&O stocks are NOT pre-buffered by backgroundScanner. We kick off ALL
  // API fetches simultaneously so historicalCache queues them at its own rate
  // limit (3 concurrent, 300ms gap ≈ 5-8 req/s). This means ~1300 non-F&O
  // stocks × 2 intervals = 2600 fetches complete in ~5-9 min rather than
  // hours of sequential blocking. F&O stocks return instantly from buffer.
  //
  // We fetch '60minute' (covers 4h synthesis) and 'day' (covers both 1D and
  // 1W synthesis) — only 2 fetches per stock.
  console.log(`[EquityScan] Prefetching candles for ${instruments.length} instruments…`);
  _state.prefetching = true;

  const prefetchPromises = instruments.flatMap((inst) => [
    candleStore.getCandles(inst.instrumentToken, '60minute', CANDLE_BARS['4h'])
      .catch(() => null),
    candleStore.getCandles(inst.instrumentToken, 'day', CANDLE_BARS['week'])
      .catch(() => null),
  ]);

  await Promise.all(prefetchPromises);
  _state.prefetching = false;
  console.log(`[EquityScan] Prefetch complete — starting pattern scan`);

  // ── Phase 2: Pattern scan from buffer (no API calls) ──────────────────────

  const batch     = [];           // collect all signal docs — bulk insert at end
  const _dedup    = new Set();    // own dedup, isolated from backgroundScanner

  let scanned = 0;
  let matched = 0;

  for (const inst of instruments) {
    const label = inst.name ?? inst.tradingsymbol;
    _state.progress.done++;                      // increment per stock, not per interval

    for (const interval of intervals) {
      // ── Read candles from buffer (prefetched above — no API calls) ────────
      let candles;
      try {
        if (interval === '4h') {
          const c1h = candleStore.getCandlesSync(inst.instrumentToken, '60minute');
          candles   = (c1h && c1h.length >= 8) ? to4H(c1h) : null;
        } else if (interval === 'week') {
          const cDay = candleStore.getCandlesSync(inst.instrumentToken, 'day');
          candles    = (cDay && cDay.length >= 30) ? toWeekly(cDay) : null;
        } else {
          // 'day' interval — buffer was seeded by the 'day' prefetch above
          candles = candleStore.getCandlesSync(inst.instrumentToken, interval);
        }
      } catch (err) {
        // Candle read failed — skip this instrument × interval silently
      }

      if (!candles || candles.length < MIN_BARS) continue;
      scanned++;

      // ── Run all patterns ──────────────────────────────────────────────────
      for (const { id: patternId, label: patternLabel } of patterns) {
        const patternDef = patternRegistry.get(patternId);
        if (!patternDef) continue;

        let result;
        try {
          result = patternDef.run(candles, { ...patternDef.defaultOpts, interval });
        } catch (err) {
          // Pattern run error — skip silently
          continue;
        }

        if (!result?.matched || !result.signal) continue;

        // Per-run dedup: at most one signal per (token, interval, pattern, direction)
        const dedupKey = `${inst.instrumentToken}:${interval}:${patternId}:${result.signal}`;
        if (_dedup.has(dedupKey)) continue;
        _dedup.add(dedupKey);

        matched++;

        // ── Build result document (same shape as scan_alerts) ─────────────
        const firedAt    = new Date();
        const firedAtIST = _istTimeStr(firedAt);

        batch.push({
          token:          Number(inst.instrumentToken),
          tradingsymbol:  inst.tradingsymbol,
          label,
          exchange:       inst.exchange ?? 'NSE',
          patternId,
          patternLabel,
          signal:         result.signal,
          interval,
          tfLabel:        TF_LABELS[interval],
          score:          result.score          ?? null,
          close:          result.close          ?? null,
          sl:             result.sl             ?? null,
          target:         result.target         ?? null,
          targetSource:   result.targetSource   ?? null,
          cloudPosition:  result.cloudPosition  ?? null,
          strength:       result.strength       ?? null,
          volumeRatio:    result.volumeRatio     ?? null,
          volumeConfirmed:result.volumeConfirmed ?? null,
          rsi14:          result.rsi14           ?? null,
          atr14:          result.atr             ?? null,
          mtfAligned:     false,                        // no MTF in standalone scan
          firedAt,
          firedAtIST,
        });
      }
    }
  }

  // ── Bulk insert to MongoDB ─────────────────────────────────────────────────
  if (batch.length > 0) {
    await equityScanRepo.insert(batch);
  }

  _state.resultCount = batch.length;
  _state.running     = false;
  _state.prefetching = false;
  _state.completedAt = new Date().toISOString();

  console.log(
    `[EquityScan] Done — scanned ${scanned} instruments, found ${matched} signals (${batch.length} stored) for ${scanDate}`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get current scan state (for polling).
 * @returns {object}
 */
function getStatus() {
  const today = _istDateStr();
  return {
    running:     _state.running,
    prefetching: _state.prefetching,   // true during phase-1 candle download
    scanDate:    _state.scanDate,
    cachedToday: _state.scanDate === today && !_state.running,
    progress:    _state.progress,
    resultCount: _state.resultCount,
    startedAt:   _state.startedAt,
    completedAt: _state.completedAt,
    error:       _state.error,
  };
}

/**
 * Get scan results for a given IST date (defaults to today).
 *
 * @param {string} [dateIST]  'YYYY-MM-DD', defaults to today
 * @returns {Promise<object[]>}
 */
async function getResults(dateIST) {
  const date = dateIST ?? _istDateStr();
  return equityScanRepo.getByDate(date);
}

/**
 * Reset the in-memory scanDate guard so the next run() call ignores the cache.
 * Used by the /rerun endpoint.
 */
function _forceRun() {
  _state.scanDate = null;
}

module.exports = { run, getStatus, getResults, isCachedToday, toWeekly, _forceRun };
