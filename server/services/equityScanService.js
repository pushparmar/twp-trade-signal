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

const candleStore           = require('./candleStore');
const patternRegistry       = require('./patternRegistry');
const instrumentCache       = require('./instrumentCache');
const equityScanRepo        = require('../db/repositories/equityScanRepo');
const equityCandleCacheRepo = require('../db/repositories/equityCandleCacheRepo');
const { to4H }              = require('./ichimoku');

// ── Constants ─────────────────────────────────────────────────────────────────

// No hard cap — scan ALL NSE EQ instruments returned by getAllNseEquity()
// (~1200-1400 stocks).  F&O stocks come first so the most liquid names
// always get scanned even if the run is interrupted.

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

// ── Candle merge helper ───────────────────────────────────────────────────────

/**
 * Merge a full historical candle array (from MongoDB) with a small set of
 * recently-fetched bars (from Kite).  Only bars whose timestamp is strictly
 * after the last historical bar are appended — prevents duplicates when the
 * Kite fetch window overlaps the stored history.
 *
 * @param {object[]} historical  Full candle array from MongoDB cache
 * @param {object[]} recent      Small recent-bars batch from Kite API
 * @param {number}   maxSize     Ring-buffer cap — oldest bars are trimmed
 * @returns {object[]}
 */
function _mergeCandles(historical, recent, maxSize) {
  if (!recent      || recent.length      === 0) return historical;
  if (!historical  || historical.length  === 0) return recent.slice(-maxSize);

  // 'YYYY-MM-DDTHH:MM' prefix is sortable as a plain string for both ISO and plain dates
  const lastPrefix = String(historical[historical.length - 1].date).slice(0, 16);
  const newBars    = recent.filter(c => String(c.date).slice(0, 16) > lastPrefix);

  if (newBars.length === 0) return historical;  // nothing new from Kite

  const merged = [...historical, ...newBars];
  return merged.length > maxSize ? merged.slice(merged.length - maxSize) : merged;
}

async function _runScan(scanDate) {
  console.log(`[EquityScan] Starting full equity scan for ${scanDate}`);
  console.log(`[EquityScan] ═══════════════════════════════════════════════════════════════`);

  // ── Phase -1: Fetch and list ALL NSE + BSE equity instruments first ───────────
  const instruments = instrumentCache.getAllEquity(); // ALL NSE + BSE EQ
  const patterns    = patternRegistry.list();
  const intervals   = ['4h', 'day', 'week'];

  // Classify by exchange and F&O status
  const foStockRegistry = require('./foStockRegistry');
  const foStocks = foStockRegistry.getAll();
  const foTokens = new Set(foStocks.map(s => Number(s.instrumentToken)));

  const nseStocks = instruments.filter(i => i.exchange === 'NSE');
  const bseStocks = instruments.filter(i => i.exchange === 'BSE');
  const foCount   = instruments.filter(i => foTokens.has(Number(i.instrumentToken))).length;
  const nonFOCount = instruments.length - foCount;

  console.log(`[EquityScan] ┌──────────────────────────────────────────────────────────────┐`);
  console.log(`[EquityScan] │         EQUITY UNIVERSE - ALL STOCKS TO SCAN                │`);
  console.log(`[EquityScan] ├──────────────────────────────────────────────────────────────┤`);
  console.log(`[EquityScan] │  NSE Stocks:     ${String(nseStocks.length).padStart(5)}                                      │`);
  console.log(`[EquityScan] │  BSE Stocks:     ${String(bseStocks.length).padStart(5)}                                      │`);
  console.log(`[EquityScan] │  ─────────────────────────                                   │`);
  console.log(`[EquityScan] │  F&O Stocks:     ${String(foCount).padStart(5)}                                      │`);
  console.log(`[EquityScan] │  Non-F&O Stocks: ${String(nonFOCount).padStart(5)}                                      │`);
  console.log(`[EquityScan] │  ─────────────────────────                                   │`);
  console.log(`[EquityScan] │  TOTAL:          ${String(instruments.length).padStart(5)}                                      │`);
  console.log(`[EquityScan] └──────────────────────────────────────────────────────────────┘`);

  // Log first 50 and last 50 instruments as a sample
  console.log(`[EquityScan] First 30 stocks in scan list:`);
  instruments.slice(0, 30).forEach((inst, idx) => {
    const fo = foTokens.has(Number(inst.instrumentToken)) ? '[F&O]' : '     ';
    console.log(`  ${String(idx + 1).padStart(4)}. ${fo} ${inst.exchange}:${inst.tradingsymbol.padEnd(20)} - ${inst.name || 'N/A'}`);
  });

  if (instruments.length > 60) {
    console.log(`  ... (${instruments.length - 60} more stocks) ...`);
    console.log(`[EquityScan] Last 30 stocks in scan list:`);
    instruments.slice(-30).forEach((inst, idx) => {
      const fo = foTokens.has(Number(inst.instrumentToken)) ? '[F&O]' : '     ';
      const num = instruments.length - 30 + idx + 1;
      console.log(`  ${String(num).padStart(4)}. ${fo} ${inst.exchange}:${inst.tradingsymbol.padEnd(20)} - ${inst.name || 'N/A'}`);
    });
  }

  console.log(`[EquityScan] ═══════════════════════════════════════════════════════════════`);
  console.log(`[EquityScan] Scanning ${patterns.length} patterns across ${intervals.length} timeframes`);

  _state.progress.total = instruments.length;

  // ── Phase 0: Classify instruments against MongoDB candle cache ──────────────
  //
  // Strategy:
  //   fresh   — both intervals stored AND lastCandleDate >= yesterdayIST
  //             → seed from MongoDB directly, zero Kite calls
  //   stale   — both intervals stored, but lastCandleDate < yesterdayIST
  //             → fetch a small recent window from Kite, merge onto stored history
  //   missing — at least one interval not stored (first-ever run, or new stock)
  //             → full Kite fetch for both intervals
  //
  // "yesterday" is the minimum freshness threshold: day candles close at 15:30 IST
  // so during a morning scan the newest candle is always from the prior session.
  const todayIST     = scanDate;
  const yesterdayIST = (() => {
    const d = new Date(Date.now() + 5.5 * 3600_000 - 86_400_000);
    return d.toISOString().slice(0, 10);
  })();

  _state.prefetching = true;
  console.log(`[EquityScan] Phase 0: loading candle history from MongoDB (fresh ≥ ${yesterdayIST})…`);

  const cachedCandles = await equityCandleCacheRepo.loadAll(['60minute', 'day']);

  const freshInsts   = [];  // both intervals fresh  — MongoDB only
  const staleInsts   = [];  // both exist, needs top-up — incremental Kite fetch
  const missingInsts = [];  // at least one interval absent — full Kite fetch

  for (const inst of instruments) {
    const e60  = cachedCandles.get(`${inst.instrumentToken}:60minute`);
    const eDay = cachedCandles.get(`${inst.instrumentToken}:day`);

    const hasBoth   = e60  != null && eDay != null;
    const bothFresh = hasBoth &&
                      (e60.lastCandleDate  ?? '') >= yesterdayIST &&
                      (eDay.lastCandleDate ?? '') >= yesterdayIST;

    if (bothFresh) {
      freshInsts.push(inst);
      candleStore.seed(Number(inst.instrumentToken), '60minute', e60.candles);
      candleStore.seed(Number(inst.instrumentToken), 'day',      eDay.candles);
    } else if (hasBoth) {
      staleInsts.push(inst);
    } else {
      missingInsts.push(inst);
    }
  }

  console.log(
    `[EquityScan] Phase 0: ${freshInsts.length} fresh (MongoDB), ` +
    `${staleInsts.length} stale (incremental), ${missingInsts.length} missing (full fetch)`,
  );

  // ── Phase 1a: Incremental update for stale instruments ───────────────────
  //
  // Fetch only a small recent window from Kite (10 day bars / 20 hourly bars —
  // enough to cover any multi-day gap including weekends and holidays).
  // Merge new bars onto the end of the existing MongoDB history so the full
  // 400–450 bar depth is always available for pattern detection.
  // The merged arrays are upserted back to MongoDB so the next run sees them
  // as "fresh" and skips Kite entirely.
  const INCR_BARS = { '60minute': 20, 'day': 10 };

  if (staleInsts.length > 0) {
    console.log(`[EquityScan] Phase 1a: incremental Kite fetch for ${staleInsts.length} stale instruments…`);

    const stalePromises = staleInsts.flatMap((inst) => {
      const e60  = cachedCandles.get(`${inst.instrumentToken}:60minute`);
      const eDay = cachedCandles.get(`${inst.instrumentToken}:day`);

      return [
        candleStore.getCandles(inst.instrumentToken, '60minute', INCR_BARS['60minute'])
          .then((recent) => {
            const merged = _mergeCandles(e60.candles, recent, CANDLE_BARS['4h']);
            candleStore.seed(Number(inst.instrumentToken), '60minute', merged);
            return { token: Number(inst.instrumentToken), interval: '60minute', candles: merged };
          })
          .catch(() => null),

        candleStore.getCandles(inst.instrumentToken, 'day', INCR_BARS['day'])
          .then((recent) => {
            const merged = _mergeCandles(eDay.candles, recent, CANDLE_BARS['week']);
            candleStore.seed(Number(inst.instrumentToken), 'day', merged);
            return { token: Number(inst.instrumentToken), interval: 'day', candles: merged };
          })
          .catch(() => null),
      ];
    });

    const staleResults = (await Promise.all(stalePromises)).filter(Boolean);
    console.log(`[EquityScan] Phase 1a: done — ${staleResults.length} entries merged`);

    // Persist merged histories back to MongoDB (fire-and-forget)
    if (staleResults.length > 0) {
      setImmediate(() =>
        equityCandleCacheRepo.bulkUpsert(staleResults)
          .catch((err) => console.warn('[EquityScan] Stale upsert failed:', err.message)),
      );
    }
  }

  // ── Phase 1b: Full fetch for instruments with no cached history ───────────
  //
  // First-ever run (or new stocks added to the exchange): fetch the full
  // candle depth from Kite.  Results are upserted to MongoDB so subsequent
  // runs hit Phase 1a (incremental) instead.
  if (missingInsts.length > 0) {
    console.log(
      `[EquityScan] Phase 1b: full Kite fetch for ${missingInsts.length} instruments` +
      ` (${freshInsts.length + staleInsts.length} from MongoDB)…`,
    );

    const fetchPromises = missingInsts.flatMap((inst) => [
      candleStore.getCandles(inst.instrumentToken, '60minute', CANDLE_BARS['4h']).catch(() => null),
      candleStore.getCandles(inst.instrumentToken, 'day',      CANDLE_BARS['week']).catch(() => null),
    ]);

    await Promise.all(fetchPromises);
    console.log(`[EquityScan] Phase 1b: full fetch complete`);

    // Persist to MongoDB so the next run only does an incremental top-up
    setImmediate(async () => {
      try {
        const toCache = [];
        for (const inst of missingInsts) {
          for (const interval of ['60minute', 'day']) {
            const candles = candleStore.getCandlesSync(inst.instrumentToken, interval);
            if (candles && candles.length >= MIN_BARS) {
              toCache.push({ token: Number(inst.instrumentToken), interval, candles });
            }
          }
        }
        if (toCache.length > 0) {
          await equityCandleCacheRepo.bulkUpsert(toCache);
          console.log(`[EquityScan] Saved ${toCache.length} new candle arrays to MongoDB`);
        }
      } catch (err) {
        console.warn('[EquityScan] MongoDB candle cache write failed:', err.message);
      }
    });
  } else {
    console.log(`[EquityScan] Phase 1b: skipped — all instruments have cached history`);
  }

  _state.prefetching = false;
  console.log(`[EquityScan] Starting pattern scan on ${instruments.length} instruments…`);

  // ── Phase 2: Pattern scan from buffer (no API calls) ──────────────────────

  const batch     = [];           // collect all signal docs — bulk insert at end
  const _dedup    = new Set();    // own dedup, isolated from backgroundScanner

  let scanned = 0;
  let matched = 0;
  let nonFOMatched = 0;  // Track non-F&O matches separately

  for (const inst of instruments) {
    const label = inst.name ?? inst.tradingsymbol;
    const isFO = foTokens.has(Number(inst.instrumentToken));
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
        if (!isFO) {
          nonFOMatched++;
          const exch = inst.exchange || 'NSE';
          console.log(`[EquityScan] ✅ Non-F&O match: ${exch}:${label} (${TF_LABELS[interval]}) ${result.signal} ${patternId}`);
        }

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

  // Count NSE vs BSE signals
  const nseSignals = batch.filter(s => s.exchange === 'NSE').length;
  const bseSignals = batch.filter(s => s.exchange === 'BSE').length;

  console.log(`[EquityScan] ═══════════════════════════════════════════════════════════════`);
  console.log(`[EquityScan] SCAN COMPLETE for ${scanDate}`);
  console.log(`[EquityScan]   Instruments scanned: ${scanned}`);
  console.log(`[EquityScan]   Total signals found: ${matched}`);
  console.log(`[EquityScan]   Signals stored:      ${batch.length}`);
  console.log(`[EquityScan]   ─────────────────────`);
  console.log(`[EquityScan]   F&O signals:     ${matched - nonFOMatched}`);
  console.log(`[EquityScan]   Non-F&O signals: ${nonFOMatched}`);
  console.log(`[EquityScan]   NSE signals:     ${nseSignals}`);
  console.log(`[EquityScan]   BSE signals:     ${bseSignals}`);
  console.log(`[EquityScan] ═══════════════════════════════════════════════════════════════`);
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

/**
 * Get the equity universe that will be scanned.
 * Returns all NSE + BSE equity instruments with their details.
 * @returns {object} Universe breakdown and instrument list
 */
function getUniverse() {
  const instruments = instrumentCache.getAllEquity();
  const foStockRegistry = require('./foStockRegistry');
  const foStocks = foStockRegistry.getAll();
  const foTokens = new Set(foStocks.map(s => Number(s.instrumentToken)));

  const nseStocks = instruments.filter(i => i.exchange === 'NSE');
  const bseStocks = instruments.filter(i => i.exchange === 'BSE');
  const foCount = instruments.filter(i => foTokens.has(Number(i.instrumentToken))).length;

  return {
    total: instruments.length,
    nseCount: nseStocks.length,
    bseCount: bseStocks.length,
    foCount: foCount,
    nonFoCount: instruments.length - foCount,
    instruments: instruments.map(i => ({
      token: i.instrumentToken,
      symbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange,
      isFO: foTokens.has(Number(i.instrumentToken))
    }))
  };
}

module.exports = { run, getStatus, getResults, isCachedToday, toWeekly, _forceRun, getUniverse };
