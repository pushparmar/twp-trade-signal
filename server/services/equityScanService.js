/**
 * equityScanService.js
 *
 * Simple equity scan architecture:
 *
 * 1. CANDLE STORAGE (MongoDB: equity_candle_cache)
 *    - Stores 100 candles per stock per interval (1h, day)
 *    - Updated daily via updateCandles() — fetches latest from Kite, merges FIFO
 *
 * 2. SCAN RESULTS (MongoDB: equity_scan_cache)
 *    - Stores pattern scan results per day
 *    - Generated via runAndStore() — runs patterns on cached candles
 *
 * 3. UI FLOW
 *    - /results → reads cached scan results (no computation)
 *    - All filtering done client-side
 *
 * Daily scheduler (11:55 PM IST):
 *    updateCandles() → runAndStore()
 *
 * Timeframes:
 *    4H   → synthesized from 1h candles via to4H()
 *    Day  → stored directly
 */

const candleStore           = require('./candleStore');
const patternRegistry       = require('./patternRegistry');
const instrumentCache       = require('./instrumentCache');
const equityScanRepo        = require('../db/repositories/equityScanRepo');
const equityCandleCacheRepo = require('../db/repositories/equityCandleCacheRepo');
const { to4H }              = require('./ichimoku');
const { getConfig }         = require('../store');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum candle bars needed for valid Ichimoku (52 for SenkouB + 26 chikou = 78 minimum). */
const MIN_BARS = 52;

/** Candle count to store per interval (enough for Ichimoku + buffer). */
const STORE_BARS = 100;

/** Bars to fetch from Kite for full history. */
const FETCH_BARS = {
  '60minute': 400,  // fetch 400 → to4H() → ~100 4h candles
  'day':      100,  // fetch 100 day candles
};

/** Bars to fetch for incremental update (covers weekends + holidays). */
const INCR_BARS = { '60minute': 20, 'day': 10 };

/** Human-readable TF label for each interval. */
const TF_LABELS = { '60minute': '1H', '4h': '4H', 'day': '1D' };

/** Supported scan intervals. */
const SCAN_INTERVALS = ['60minute', '4h', 'day'];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Concurrency limit for parallel Kite API calls (avoid rate limiting). */
const CONCURRENCY = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Process items in parallel with concurrency limit.
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to call for each item
 * @param {number} concurrency - Max concurrent operations
 * @returns {Promise<Array>} Results array
 */
async function _parallelWithLimit(items, fn, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function _istDateStr(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function _istTimeStr(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

/**
 * Merge historical candles with recent bars (FIFO — oldest trimmed).
 */
function _mergeCandles(historical, recent, maxSize) {
  if (!recent || recent.length === 0) return historical;
  if (!historical || historical.length === 0) return recent.slice(-maxSize);

  const lastPrefix = String(historical[historical.length - 1].date).slice(0, 16);
  const newBars = recent.filter(c => String(c.date).slice(0, 16) > lastPrefix);

  if (newBars.length === 0) return historical;

  const merged = [...historical, ...newBars];
  return merged.length > maxSize ? merged.slice(merged.length - maxSize) : merged;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1: UPDATE CANDLES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update candle cache — fetch latest from Kite, merge FIFO into MongoDB.
 *
 * Strategy:
 *   - Load existing candles from MongoDB
 *   - For each stock: fetch small recent window from Kite, merge onto history
 *   - Save merged candles back to MongoDB
 *   - If stock has no history: full fetch from Kite
 *
 * @returns {Promise<{updated: number, fetched: number, errors: number}>}
 */
async function updateCandles() {
  console.log('[EquityScan] ═══════════════════════════════════════════════════════════════');
  console.log('[EquityScan] Updating candle cache...');

  // Check Kite auth
  const { kite } = getConfig();
  if (!kite.apiKey || !kite.accessToken) {
    console.error('[EquityScan] Kite not authenticated');
    return { error: 'Kite not authenticated' };
  }

  // Get all equity instruments
  const instruments = instrumentCache.getAllEquity();
  console.log(`[EquityScan] Instruments to update: ${instruments.length}`);

  // Load existing candle cache from MongoDB
  const cachedCandles = await equityCandleCacheRepo.loadAll(['60minute', 'day']);
  console.log(`[EquityScan] Existing cache entries: ${cachedCandles.size}`);

  const stats = { updated: 0, fetched: 0, errors: 0 };
  const toUpsert = [];
  let processed = 0;

  // Process stocks in parallel with concurrency limit
  console.log(`[EquityScan] Processing stocks with concurrency=${CONCURRENCY}...`);

  await _parallelWithLimit(instruments, async (inst) => {
    const token = Number(inst.instrumentToken);
    const e60 = cachedCandles.get(`${token}:60minute`);
    const eDay = cachedCandles.get(`${token}:day`);
    const hasBoth = e60 != null && eDay != null;

    try {
      if (hasBoth) {
        // Incremental update — fetch small recent window, merge
        const [recent60, recentDay] = await Promise.all([
          candleStore.getCandles(token, '60minute', INCR_BARS['60minute']).catch(() => null),
          candleStore.getCandles(token, 'day', INCR_BARS['day']).catch(() => null),
        ]);

        if (recent60) {
          const merged = _mergeCandles(e60.candles, recent60, STORE_BARS * 4);
          toUpsert.push({ token, interval: '60minute', candles: merged });
        }
        if (recentDay) {
          const merged = _mergeCandles(eDay.candles, recentDay, STORE_BARS);
          toUpsert.push({ token, interval: 'day', candles: merged });
        }
        stats.updated++;
      } else {
        // Full fetch — no history exists
        const [c60, cDay] = await Promise.all([
          candleStore.getCandles(token, '60minute', FETCH_BARS['60minute']).catch(() => null),
          candleStore.getCandles(token, 'day', FETCH_BARS['day']).catch(() => null),
        ]);

        if (c60 && c60.length >= MIN_BARS) {
          toUpsert.push({ token, interval: '60minute', candles: c60.slice(-STORE_BARS * 4) });
        }
        if (cDay && cDay.length >= MIN_BARS) {
          toUpsert.push({ token, interval: 'day', candles: cDay.slice(-STORE_BARS) });
        }
        stats.fetched++;
      }
    } catch {
      stats.errors++;
    }

    // Progress log every 100 stocks
    processed++;
    if (processed % 100 === 0) {
      console.log(`[EquityScan] Progress: ${processed}/${instruments.length} stocks processed`);
    }
  }, CONCURRENCY);

  // Bulk upsert to MongoDB
  if (toUpsert.length > 0) {
    console.log(`[EquityScan] Saving ${toUpsert.length} candle entries to MongoDB...`);
    await equityCandleCacheRepo.bulkUpsert(toUpsert);
  }

  console.log(`[EquityScan] Candle update complete: ${stats.updated} updated, ${stats.fetched} new, ${stats.errors} errors`);
  console.log('[EquityScan] ═══════════════════════════════════════════════════════════════');

  return stats;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2: RUN SCAN AND STORE RESULTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Run pattern scan on cached candles and store results to MongoDB.
 *
 * @returns {Promise<{count: number, scanDate: string}>}
 */
async function runAndStore() {
  const scanDate = _istDateStr();
  console.log('[EquityScan] ═══════════════════════════════════════════════════════════════');
  console.log(`[EquityScan] Running pattern scan for ${scanDate}...`);

  // Load all cached candles from MongoDB
  const cachedCandles = await equityCandleCacheRepo.loadAll(['60minute', 'day']);

  if (cachedCandles.size === 0) {
    console.log('[EquityScan] No cached candles found — run updateCandles() first');
    return { error: 'No cached candles', count: 0, scanDate };
  }

  // Get instrument metadata
  const instruments = instrumentCache.getAllEquity();
  const instMap = new Map(instruments.map(i => [Number(i.instrumentToken), i]));

  // Get patterns
  const patterns = patternRegistry.list();
  console.log(`[EquityScan] Scanning ${patterns.length} patterns across ${SCAN_INTERVALS.length} TFs`);

  // Get unique tokens from cache
  const tokens = new Set();
  for (const key of cachedCandles.keys()) {
    const [tokenStr] = key.split(':');
    tokens.add(Number(tokenStr));
  }

  console.log(`[EquityScan] Stocks with cached candles: ${tokens.size}`);

  // Run scan
  const results = [];
  const _dedup = new Set();
  let scanned = 0;

  for (const token of tokens) {
    const inst = instMap.get(token);
    if (!inst) continue;

    const label = inst.name ?? inst.tradingsymbol;
    const e60 = cachedCandles.get(`${token}:60minute`);
    const eDay = cachedCandles.get(`${token}:day`);

    for (const interval of SCAN_INTERVALS) {
      // Build candles
      let candles;
      try {
        if (interval === '60minute') {
          // Use 1H candles directly
          candles = e60?.candles;
        } else if (interval === '4h') {
          // Convert 1H to 4H
          const c1h = e60?.candles;
          candles = (c1h && c1h.length >= 8) ? to4H(c1h) : null;
        } else if (interval === 'day') {
          candles = eDay?.candles;
        }
      } catch {
        continue;
      }

      if (!candles || candles.length < MIN_BARS) continue;
      scanned++;

      // Run patterns
      for (const { id: patternId, label: patternLabel } of patterns) {
        const patternDef = patternRegistry.get(patternId);
        if (!patternDef) continue;

        let result;
        try {
          result = patternDef.run(candles, { ...patternDef.defaultOpts, interval });
        } catch {
          continue;
        }

        if (!result?.matched || !result.signal) continue;

        // Dedup
        const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
        if (_dedup.has(dedupKey)) continue;
        _dedup.add(dedupKey);

        const firedAt = new Date();

        results.push({
          token,
          tradingsymbol: inst.tradingsymbol,
          label,
          exchange: inst.exchange ?? 'NSE',
          patternId,
          patternLabel,
          signal: result.signal,
          interval,
          tfLabel: TF_LABELS[interval],
          score: result.score ?? null,
          close: result.close ?? null,
          sl: result.sl ?? null,
          target: result.target ?? null,
          targetSource: result.targetSource ?? null,
          cloudPosition: result.cloudPosition ?? null,
          strength: result.strength ?? null,
          volumeRatio: result.volumeRatio ?? null,
          volumeConfirmed: result.volumeConfirmed ?? null,
          rsi14: result.rsi14 ?? null,
          atr14: result.atr ?? null,
          mtfAligned: false,
          firedAt,
          firedAtIST: _istTimeStr(firedAt),
        });
      }
    }
  }

  // Sort by score
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Clear old results and insert new
  await equityScanRepo.clearForDate(scanDate);
  if (results.length > 0) {
    await equityScanRepo.insert(results);
  }

  console.log(`[EquityScan] Scan complete: ${scanned} TF-instrument pairs, ${results.length} signals stored`);
  console.log('[EquityScan] ═══════════════════════════════════════════════════════════════');

  return { count: results.length, scanDate };
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — SIMPLE GETTERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get cached scan results for a date (defaults to today).
 * This is the main endpoint for UI — just reads from MongoDB.
 */
async function getResults(dateIST) {
  const date = dateIST ?? _istDateStr();
  return equityScanRepo.getByDate(date);
}

/**
 * Check if results exist for today.
 */
async function hasResultsToday() {
  const today = _istDateStr();
  return equityScanRepo.hasResultsForDate(today);
}

/**
 * Get scan status (simple — just checks if results exist for today).
 */
async function getStatus() {
  const today = _istDateStr();
  const hasResults = await equityScanRepo.hasResultsForDate(today);
  const resultCount = hasResults ? (await equityScanRepo.getByDate(today)).length : 0;

  return {
    scanDate: today,
    hasResults,
    resultCount,
  };
}

/**
 * Get the equity universe that will be scanned.
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
  };
}

/**
 * Get list of all available patterns for dropdown.
 */
function getPatternList() {
  return patternRegistry.list().map(p => ({ id: p.id, label: p.label }));
}

// ══════════════════════════════════════════════════════════════════════════════
// MANUAL TRIGGERS (for API endpoints)
// ══════════════════════════════════════════════════════════════════════════════

// Track running state for async scan
let _scanRunning = false;
let _scanProgress = { phase: 'idle', done: 0, total: 0 };

/**
 * Manual trigger: update candles + run scan.
 * Returns immediately, runs in background to avoid HTTP timeout.
 */
async function run() {
  console.log('[EquityScan] Manual run triggered');

  // Check if already running
  if (_scanRunning) {
    return { status: 'running', progress: _scanProgress };
  }

  // Check if already have results today
  const hasResults = await hasResultsToday();
  if (hasResults) {
    return { status: 'cached', message: 'Results already exist for today' };
  }

  // Start scan in background (don't await)
  _scanRunning = true;
  _scanProgress = { phase: 'starting', done: 0, total: 0 };

  setImmediate(async () => {
    try {
      _scanProgress = { phase: 'updating_candles', done: 0, total: 0 };
      const candleResult = await updateCandles();
      if (candleResult.error) {
        console.error('[EquityScan] Candle update failed:', candleResult.error);
        _scanRunning = false;
        _scanProgress = { phase: 'error', error: candleResult.error };
        return;
      }

      _scanProgress = { phase: 'scanning_patterns', done: 0, total: 0 };
      const scanResult = await runAndStore();
      if (scanResult.error) {
        console.error('[EquityScan] Pattern scan failed:', scanResult.error);
        _scanRunning = false;
        _scanProgress = { phase: 'error', error: scanResult.error };
        return;
      }

      _scanProgress = { phase: 'complete', count: scanResult.count };
      console.log(`[EquityScan] Background scan complete: ${scanResult.count} results`);
    } catch (err) {
      console.error('[EquityScan] Background scan error:', err.message);
      _scanProgress = { phase: 'error', error: err.message };
    } finally {
      _scanRunning = false;
    }
  });

  return { status: 'started', message: 'Scan started in background' };
}

/**
 * Get current scan progress (for polling).
 */
function getScanProgress() {
  return { running: _scanRunning, ..._scanProgress };
}

/**
 * Legacy run function kept for reference - DO NOT USE
 */
async function _runSync() {
  console.log('[EquityScan] Sync run triggered');

  const hasResults = await hasResultsToday();
  if (hasResults) {
    return { status: 'cached', message: 'Results already exist for today' };
  }

  const candleResult = await updateCandles();
  if (candleResult.error) {
    return { status: 'error', error: candleResult.error };
  }

  const scanResult = await runAndStore();
  if (scanResult.error) {
    return { status: 'error', error: scanResult.error };
  }

  return { status: 'complete', count: scanResult.count, scanDate: scanResult.scanDate };
}

/**
 * Force re-run (bypass today's cache check).
 * Returns immediately, runs in background.
 */
async function rerun() {
  console.log('[EquityScan] Force re-run triggered');

  if (_scanRunning) {
    return { status: 'running', progress: _scanProgress };
  }

  _scanRunning = true;
  _scanProgress = { phase: 'starting', done: 0, total: 0 };

  setImmediate(async () => {
    try {
      _scanProgress = { phase: 'updating_candles', done: 0, total: 0 };
      const candleResult = await updateCandles();
      if (candleResult.error) {
        console.error('[EquityScan] Candle update failed:', candleResult.error);
        _scanRunning = false;
        _scanProgress = { phase: 'error', error: candleResult.error };
        return;
      }

      _scanProgress = { phase: 'scanning_patterns', done: 0, total: 0 };
      const scanResult = await runAndStore();
      if (scanResult.error) {
        console.error('[EquityScan] Pattern scan failed:', scanResult.error);
        _scanRunning = false;
        _scanProgress = { phase: 'error', error: scanResult.error };
        return;
      }

      _scanProgress = { phase: 'complete', count: scanResult.count };
      console.log(`[EquityScan] Background re-run complete: ${scanResult.count} results`);
    } catch (err) {
      console.error('[EquityScan] Background re-run error:', err.message);
      _scanProgress = { phase: 'error', error: err.message };
    } finally {
      _scanRunning = false;
    }
  });

  return { status: 'started', message: 'Re-run started in background' };
}

module.exports = {
  // Daily scheduler functions
  updateCandles,
  runAndStore,

  // API functions
  run,
  rerun,
  getResults,
  getStatus,
  getScanProgress,
  getUniverse,
  getPatternList,
  hasResultsToday,
};
