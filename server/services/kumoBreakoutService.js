/**
 * kumoBreakoutService.js
 *
 * Standalone scheduled Kumo Breakout scanner.
 *
 * IMPORTANT: This service does NOT use candleStore (shared in-memory state).
 * It fetches candles directly via historicalCache (read-only Kite API fetcher)
 * and caches them in its own MongoDB collection (kumo_candle_cache).
 * This ensures zero interference with the index-trade scanner, live ticker,
 * or any other service that uses candleStore.
 *
 * Schedule:
 *   - Every 15 minutes: scan 15minute candles
 *   - Every 1 hour: scan 60minute candles
 *   - On manual trigger: scan all intervals (15m, 1h, 4h, day)
 *
 * Flow per scan cycle:
 *   1. Build universe (indices + MCX + F&O stocks)
 *   2. For each token: try DB cache first, then fetch from Kite API
 *   3. Cache updated candles in DB (FIFO — capped at max bars per interval)
 *   4. Run kumo-breakout pattern
 *   5. Store matches in DB
 *   6. Broadcast to UI via SSE
 */

const { fetchLastNCandles } = require('./historicalCache');
const patternRegistry  = require('./patternRegistry');
const foStockRegistry  = require('./foStockRegistry');
const { to4H, getFutureCloudColor } = require('./ichimoku');
const { VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');
const { broadcast }    = require('../sseHub');
const { isNseOpen }    = require('../utils/marketHours');
const kumoBreakoutCacheRepo = require('../db/repositories/kumoBreakoutCacheRepo');

// ── Config ──────────────────────────────────────────────────────────────────

const INTERVALS = ['15minute', '60minute', '4h', 'day'];
const TF_LABEL  = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };
const SCAN_BARS = { '15minute': 100, '60minute': 450, 'day': 150 };

const SCHEDULE_MS = {
  '15minute': 15 * 60 * 1000,
  '60minute': 60 * 60 * 1000,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BATCH_SIZE = 10;

// ── State ───────────────────────────────────────────────────────────────────

const _timers = new Map();
const _lastScanAt = new Map();
const _nextScanAt = new Map();
let _running = false;
const _scanInProgress = new Map();

// ── Universe ────────────────────────────────────────────────────────────────

function _buildUniverse() {
  const universe = [];
  const seen = new Set();

  const indices = [
    { instrumentToken: 256265,   tradingsymbol: 'NIFTY 50',   exchange: 'NSE', name: 'NIFTY 50',   category: 'index' },
    { instrumentToken: 260105,   tradingsymbol: 'NIFTY BANK', exchange: 'NSE', name: 'NIFTY BANK', category: 'index' },
    { instrumentToken: VIX_TOKEN, tradingsymbol: 'INDIA VIX', exchange: 'NSE', name: 'India VIX',  category: 'index' },
  ];
  for (const i of indices) {
    universe.push(i);
    seen.add(i.instrumentToken);
  }

  const mcxMacros = [
    ['CRUDEOIL', 'Crude Oil'],
    ['GOLD',     'Gold'],
    ['SILVER',   'Silver'],
    ['NATURALGAS', 'Natural Gas'],
  ];
  for (const [symbol, label] of mcxMacros) {
    try {
      const inst = getFrontMonthFutures(symbol, 'MCX');
      if (inst && !seen.has(inst.instrumentToken)) {
        universe.push({
          instrumentToken: inst.instrumentToken,
          tradingsymbol:   inst.tradingsymbol,
          exchange:        'MCX',
          name:            label,
          category:        'commodity',
        });
        seen.add(inst.instrumentToken);
      }
    } catch { /* instrumentCache not ready */ }
  }

  const foStocks = foStockRegistry.getAll();
  for (const s of foStocks) {
    if (!seen.has(s.instrumentToken)) {
      universe.push({ ...s, category: 'stock' });
      seen.add(s.instrumentToken);
    }
  }

  return universe;
}

// ── Candle fetching (standalone — NOT using candleStore) ────────────────────

/**
 * Fetch candles for a single token+interval directly from Kite API.
 * Uses historicalCache (read-only rate-limited fetcher) — no shared state.
 */
async function _fetchCandles(token, interval) {
  const bars = SCAN_BARS[interval] ?? 100;
  return fetchLastNCandles(token, interval, bars, false);
}

/**
 * Get candles for a token+interval.
 * First tries DB cache (avoids Kite API call if fresh), then fetches from API.
 * For 4h: fetches 60minute and synthesises.
 */
async function _getCandles(token, interval, dbCacheMap) {
  if (interval === '4h') {
    // 4h is synthesised from 1h — fetch 1h candles
    let c1h = dbCacheMap?.get(token)?.candles;
    if (!c1h || c1h.length < 8) {
      c1h = await _fetchCandles(token, '60minute');
    }
    return c1h && c1h.length >= 8 ? to4H(c1h).filter(c => !c.partial) : null;
  }

  // For non-4h: try DB cache, fallback to Kite API
  const cached = dbCacheMap?.get(token);
  if (cached?.candles && cached.candles.length >= 52) {
    return cached.candles;
  }

  return _fetchCandles(token, interval);
}

// ── Scan single interval ────────────────────────────────────────────────────

async function _scanInterval(interval) {
  if (_scanInProgress.get(interval)) {
    console.log(`[KumoService] ${TF_LABEL[interval]} scan already in progress — skipping`);
    return null;
  }

  _scanInProgress.set(interval, true);
  const tfLabel = TF_LABEL[interval];

  try {
    const pattern = patternRegistry.get('kumo-breakout');
    if (!pattern) {
      console.warn('[KumoService] kumo-breakout pattern not found in registry');
      return null;
    }

    const universe = _buildUniverse();
    console.log(`[KumoService] Scanning ${tfLabel} — ${universe.length} instruments`);

    // Load DB-cached candles for this interval to reduce Kite API calls
    const fetchInterval = interval === '4h' ? '60minute' : interval;
    const dbCacheMap = await kumoBreakoutCacheRepo.loadCandles(fetchInterval);

    const matches = [];
    let scannedCount = 0;
    const candlesToCache = [];

    for (let i = 0; i < universe.length; i += BATCH_SIZE) {
      const batch = universe.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (inst) => {
        let candles;
        try {
          candles = await _getCandles(inst.instrumentToken, interval, dbCacheMap);
        } catch {
          return null;
        }

        if (!candles || candles.length < 52) return null;
        scannedCount++;

        // Cache the raw candles in DB (skip 4h since it's derived)
        if (interval !== '4h') {
          candlesToCache.push({ token: inst.instrumentToken, interval, candles });
        }

        let result;
        try {
          result = pattern.run(candles, { ...pattern.defaultOpts, interval });
        } catch {
          return null;
        }

        if (!result?.matched || !result.signal) return null;

        let futureCloudColor = null;
        try {
          futureCloudColor = getFutureCloudColor(candles);
        } catch {}

        return {
          token:        inst.instrumentToken,
          symbol:       inst.tradingsymbol,
          name:         inst.name || inst.tradingsymbol,
          exchange:     inst.exchange,
          category:     inst.category || 'stock',
          interval,
          tfLabel,
          signal:       result.signal,
          score:        result.score ?? null,
          close:        result.close,
          sl:           result.sl,
          target:       result.target,
          rrRatio:      result.sl && result.target && result.close
                          ? Math.abs(result.target - result.close) / Math.abs(result.close - result.sl)
                          : null,
          cloudTop:     result.cloudTop,
          cloudBottom:  result.cloudBottom,
          cloudWidth:   result.cloudWidth,
          tenkan:       result.tenkan,
          kijun:        result.kijun,
          chikou:       result.chikou,
          atr:          result.atr,
          futureCloudColor,
          ts:           Date.now(),
        };
      });

      const batchResults = await Promise.all(batchPromises);
      matches.push(...batchResults.filter(Boolean));
    }

    // Sort by score descending
    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Cache candles in DB (fire-and-forget, FIFO applied inside repo)
    if (candlesToCache.length > 0) {
      kumoBreakoutCacheRepo.upsertCandles(candlesToCache).catch(() => {});
    }

    // Save scan results in DB
    await kumoBreakoutCacheRepo.saveScanResults(interval, matches, {
      scannedCount,
      totalInstruments: universe.length,
    });

    _lastScanAt.set(interval, Date.now());

    console.log(`[KumoService] ${tfLabel} complete — ${matches.length} matches (${scannedCount} scanned)`);

    // Broadcast to UI
    broadcast('kumo_scan_complete', {
      interval,
      tfLabel,
      matchCount: matches.length,
      scannedCount,
      ts: Date.now(),
    });

    return { interval, tfLabel, matches, scannedCount, totalInstruments: universe.length };
  } catch (err) {
    console.error(`[KumoService] ${tfLabel} scan error:`, err.message);
    return null;
  } finally {
    _scanInProgress.set(interval, false);
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────

function _scheduleInterval(interval) {
  const ms = SCHEDULE_MS[interval];
  if (!ms) return;

  const timer = setInterval(() => {
    if (!isNseOpen()) return;
    _nextScanAt.set(interval, Date.now() + ms);
    _scanInterval(interval).catch((err) => {
      console.error(`[KumoService] Scheduled ${interval} scan error:`, err.message);
    });
  }, ms);

  _timers.set(interval, timer);
  _nextScanAt.set(interval, Date.now() + ms);
}

async function start() {
  if (_running) return;
  _running = true;

  console.log('[KumoService] Starting scheduled scanner...');

  _scheduleInterval('15minute');
  _scheduleInterval('60minute');

  // Run initial scan for all intervals in parallel (if market is open)
  if (isNseOpen()) {
    console.log('[KumoService] Market open — running initial scan for all intervals');
    runAllScans().catch(() => {});
  }
}

function stop() {
  _running = false;
  for (const [, timer] of _timers.entries()) {
    clearInterval(timer);
  }
  _timers.clear();
  _nextScanAt.clear();
  console.log('[KumoService] Scheduler stopped');
}

async function runAllScans() {
  const results = await Promise.all(
    INTERVALS.map(interval => _scanInterval(interval)),
  );
  return results.filter(Boolean);
}

async function runSingleScan(interval) {
  if (!INTERVALS.includes(interval)) {
    throw new Error(`Invalid interval: ${interval}`);
  }
  return _scanInterval(interval);
}

function getStatus() {
  const status = {};
  for (const interval of INTERVALS) {
    status[interval] = {
      tfLabel: TF_LABEL[interval],
      lastScanAt: _lastScanAt.get(interval) ?? null,
      nextScanAt: _nextScanAt.get(interval) ?? null,
      scanning: _scanInProgress.get(interval) ?? false,
    };
  }
  return {
    running: _running,
    intervals: status,
  };
}

async function getCachedResults() {
  const resultMap = await kumoBreakoutCacheRepo.loadAllScanResults();
  const out = {};
  for (const interval of INTERVALS) {
    const cached = resultMap.get(interval);
    out[interval] = cached ? {
      matches: cached.matches,
      scannedAt: cached.scannedAt,
      scannedCount: cached.scannedCount,
      totalInstruments: cached.totalInstruments,
      ts: cached.ts,
    } : null;
  }
  return out;
}

module.exports = {
  start,
  stop,
  runAllScans,
  runSingleScan,
  getStatus,
  getCachedResults,
  INTERVALS,
  TF_LABEL,
};
