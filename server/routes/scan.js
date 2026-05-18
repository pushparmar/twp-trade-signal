/**
 * Pattern scan routes.
 *
 * GET  /api/scan/patterns          — list all registered patterns (for the UI dropdown)
 * POST /api/scan                   — run a pattern against every token in the watchlist
 *
 * POST body:
 *   {
 *     patternId:  string,                         // e.g. "kumo-breakout-twist"
 *     intervals:  string[],                       // e.g. ["15minute","60minute","4h","day"]
 *     opts:       object,                         // pattern-specific overrides (optional)
 *   }
 *
 * POST response:
 *   {
 *     patternId:        string,
 *     patternLabel:     string,
 *     scannedCount:     number,   // token×interval pairs that had enough candle data
 *     totalInstruments: number,   // tokens in the watchlist
 *     matches: [
 *       {
 *         token, tradingsymbol, exchange, name,
 *         interval,
 *         signal,      // "bullish" | "bearish"
 *         score,       // 0–5
 *         checks,      // { kumoBreakout, cloudColor, kumoTwist, chikou, kijun }
 *         twistBarsAgo,
 *         close, kijunValue, cloudTop, cloudBottom, senkouA, senkouB, price26ago,
 *       }
 *     ],
 *   }
 */

const express          = require('express');
const candleStore      = require('../services/candleStore');
const patternRegistry  = require('../services/patternRegistry');
const liveScanner       = require('../services/liveScanner');
const backgroundScanner = require('../services/backgroundScanner');
const historicalCache  = require('../services/historicalCache');
const { broadcast }    = require('../sseHub');
const store            = require('../store');
const { to4H }         = require('../services/ichimoku');
const { VIX_TOKEN, getFrontMonthFutures } = require('../services/macroAnalysis');
const instrumentCache  = require('../services/instrumentCache');
const foStockRegistry  = require('../services/foStockRegistry');
const db               = require('../db');
const alertBus         = require('../services/alertBus');

/**
 * Return the scan universe of F&O-eligible stocks.
 *
 * Uses the persistent F&O stock registry (NSE EQ tokens) instead of resolving
 * NFO front-month futures on every call. NSE equity tokens are PERMANENT —
 * no monthly rollover, no "got 0 candles" from expired contracts.
 *
 * Falls back to the old live-derivation from instrumentCache if the registry
 * hasn't been built yet (e.g. first boot before auth).
 *
 * Returns: [{ instrumentToken, tradingsymbol, exchange, name }]
 */
function _allFoStocks() {
  const fromRegistry = foStockRegistry.getAll();
  if (fromRegistry.length > 0) return fromRegistry;

  // Fallback: derive from instrumentCache directly (old behaviour).
  // This path is hit only on the very first boot before the registry file exists.
  if (!instrumentCache.isLoaded()) return [];
  const names = instrumentCache.getFutureNames();
  const out = [];
  for (const name of names) {
    const eq = instrumentCache.getNseEquity(name);
    if (!eq) continue;
    out.push({ instrumentToken: eq.instrumentToken, tradingsymbol: eq.tradingsymbol, exchange: 'NSE', name });
  }
  return out;
}

/**
 * Build the list of macro + index instruments that are always included in the
 * on-demand scan. Matches the set covered by patternAlertWatcher so the
 * Scanner UI never says "no matches" just because the user's watchlist is
 * empty on a fresh server boot.
 *
 * Returns: [{ instrumentToken, tradingsymbol, exchange, name }]
 */
function _macroAndIndexInstruments() {
  const list = [
    // Indices — always present, no instrument cache lookup needed
    { instrumentToken: 256265, tradingsymbol: 'NIFTY 50',   exchange: 'NSE', name: 'NIFTY 50'   },
    { instrumentToken: 260105, tradingsymbol: 'NIFTY BANK', exchange: 'NSE', name: 'NIFTY BANK' },
    { instrumentToken: VIX_TOKEN, tradingsymbol: 'INDIA VIX', exchange: 'NSE', name: 'India VIX' },
  ];

  // Macro futures — depend on instrumentCache being loaded; skip silently if unavailable
  const macros = [
    ['CRUDEOIL', 'MCX', 'Crude Oil'],
    ['GOLD',     'MCX', 'Gold'],
    ['SILVER',   'MCX', 'Silver'],
    ['USDINR',   'CDS', 'USD/INR'],
  ];
  for (const [symbol, exchange, label] of macros) {
    try {
      const inst = getFrontMonthFutures(symbol, exchange);
      if (inst) {
        list.push({
          instrumentToken: inst.instrumentToken,
          tradingsymbol:   inst.tradingsymbol,
          exchange:        inst.exchange,
          name:            label,
        });
      }
    } catch { /* instrument cache not ready — ignore */ }
  }
  return list;
}

const router = express.Router();

// Session-aware 4h synthesis — imported from ichimoku.js.
// The old local version grouped from buffer index 0 and produced cross-session candles.
const _to4H = to4H;

// Minimum bars for each interval to satisfy the Ichimoku 52-bar requirement,
// with a small headroom buffer. Keeping this tight means shorter Kite API date
// ranges → faster fetches + better cache hit rates on repeat scans.
const SCAN_BARS = {
  '15minute': 100,
  // 4h synthesis: NSE produces exactly 1 4h candle per trading day (6 1h bars/day, only 4
  // form a complete group). To get the 52 bars required by Ichimoku, we need ≥ 52 × 6 = 312
  // 1h bars; 450 gives 75 4h candles with room for holiday-heavy weeks.
  '60minute': 450,
  'day':      150,  // ~214 trading days — well above Ichimoku's 52-bar requirement
};

// Fetch candles for any interval, handling the synthetic 4h case.
// Uses a minimal bar count (SCAN_BARS) so Kite API requests cover the shortest
// date range needed — this dramatically improves cache hit rates on repeat scans.
async function _getCandles(token, interval) {
  if (interval === '4h') {
    // Pull enough 1h bars to produce at least 52 synthesised 4h candles
    const c1h = await candleStore.getCandles(token, '60minute', SCAN_BARS['60minute']);
    return c1h && c1h.length >= 8 ? _to4H(c1h) : null;
  }
  return candleStore.getCandles(token, interval, SCAN_BARS[interval] ?? 100);
}

// ── GET /api/scan/patterns ────────────────────────────────────────────────────
router.get('/patterns', (_req, res) => {
  res.json(patternRegistry.list());
});

// ── GET /api/scan/universe ────────────────────────────────────────────────────
// Returns the counts of each instrument set the scanner can scan, so the
// client can show an accurate "scanning N instruments" hint before running.
router.get('/universe', (_req, res) => {
  const macros   = _macroAndIndexInstruments();
  const watchlist = store.getWatchlist();
  const futures  = _allFoStocks();
  res.json({
    macros:    macros.length,
    watchlist: watchlist.length,
    futures:   futures.length,
    // Same dedup math the POST handler uses
    all:       new Set([...macros, ...watchlist, ...futures].map(i => Number(i.instrumentToken))).size,
  });
});

// ── GET /api/scan/scanner-status ─────────────────────────────────────────────
// Diagnostic: liveScanner state, candleStore stats, and backgroundScanner schedule.
router.get('/scanner-status', (req, res) => {
  const storeStats = candleStore.stats();
  const watchlist  = store.getWatchlist();
  res.json({
    liveScannerWatchCount:  liveScanner.watchCount(),
    watchlistLength:        watchlist.length,
    candleStoreKeys:        storeStats.keys,
    candleStoreCandles:     storeStats.totalCandles,
    watchlist:              watchlist.map(i => ({ token: i.instrumentToken, symbol: i.tradingsymbol })),
    // Background scanner — next fire times per interval
    backgroundScanSchedule: backgroundScanner.getSchedule(),
  });
});

// ── GET /api/scan/fo-registry ─────────────────────────────────────────────────
// Returns the current F&O stock registry stats (total stocks, build date).
router.get('/fo-registry', (_req, res) => {
  const stats = foStockRegistry.getStats();
  res.json({
    ...stats,
    builtAtISO: stats.builtAt ? new Date(stats.builtAt).toISOString() : null,
  });
});

// ── POST /api/scan/refresh-fo-registry ────────────────────────────────────────
// Rebuilds the F&O stock registry from the live instrumentCache.
// Run this once a month (or after NSE adds/removes F&O stocks) to keep the
// stock list current. Returns a diff: added, removed, missing names.
//
// Requires Kite to be authenticated (instrumentCache must be loaded).
router.post('/refresh-fo-registry', (_req, res) => {
  try {
    if (!instrumentCache.isLoaded()) {
      return res.status(503).json({ error: 'InstrumentCache not loaded — re-login to Kite first' });
    }
    const result = foStockRegistry.build();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/scan/clear-dedup ────────────────────────────────────────────────
// Clears the background-scanner dedup map so every pattern will re-fire on the
// next candle close. Use this when you want to re-receive today's alerts.
router.post('/clear-dedup', (req, res) => {
  const count = backgroundScanner.clearDedup();
  res.json({ ok: true, clearedEntries: count });
});

// ── GET /api/scan/bg-status ───────────────────────────────────────────────────
// Diagnostic info about the background scanner: running state, dedup map size,
// per-interval last-run timestamps, and the next scheduled fire times.
router.get('/bg-status', (req, res) => {
  res.json(backgroundScanner.getDebugInfo());
});

// ── POST /api/scan/trigger-bg-scan ────────────────────────────────────────────
// Immediately runs the background scan for the given interval without waiting
// for the candle-close boundary.  Bypasses the market-hours guard so it works
// during off-hours for testing.
// Body: { interval?: string }  — defaults to '15minute'
router.post('/trigger-bg-scan', async (req, res) => {
  const interval = req.body?.interval || '15minute';
  const valid = ['15minute', '60minute', '4h', 'day'];
  if (!valid.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${valid.join(', ')}` });
  }
  // Fire-and-forget — respond immediately so the client isn't blocked by the
  // potentially long-running scan. Progress is visible in Railway / server logs.
  backgroundScanner.triggerNow(interval).catch((err) =>
    console.error('[ScanRoute] trigger-bg-scan error:', err.message),
  );
  res.json({ ok: true, interval, message: 'Scan triggered — check Telegram and Railway logs' });
});

// ── POST /api/scan/fire-test-alert ────────────────────────────────────────────
// Broadcasts a fake scan_alert SSE event to verify the client pipeline
// (SSE → appStore → Scanner tab) without needing real candle closes.
// Body: { token?, label?, signal?, interval?, patternId? }
router.post('/fire-test-alert', (req, res) => {
  const alert = {
    token:        Number(req.body.token       ?? 256265),
    label:        req.body.label              ?? 'NIFTY 50 [TEST]',
    interval:     req.body.interval           ?? '15minute',
    tfLabel:      req.body.tfLabel            ?? '15m',
    patternId:    req.body.patternId          ?? 'kumo-breakout-twist',
    patternLabel: req.body.patternLabel       ?? 'Kumo Breakout + Twist (5/5)',
    signal:       req.body.signal             ?? 'bullish',
    score:        req.body.score              ?? 4,
    close:        req.body.close              ?? 22500,
    ts:           Date.now(),
  };
  broadcast('scan_alert', alert);
  console.log('[ScanTest] Fired test alert:', alert.label, alert.signal);
  res.json({ ok: true, alert });
});

// ── POST /api/scan/test-telegram ──────────────────────────────────────────────
// Sends a real Telegram message using the stored bot token + chat ID.
// Use this to verify Telegram credentials end-to-end without waiting for a
// candle close. Returns { ok, chatId, error? }.
router.post('/test-telegram', async (req, res) => {
  const telegramNotifier = require('../services/telegramNotifier');
  const chatId = store.getTelegramChatId();
  if (!chatId) {
    return res.status(400).json({ ok: false, error: 'No chat ID configured — open Settings and save your Telegram chat ID' });
  }
  try {
    await telegramNotifier.sendMessage(chatId,
      '✅ <b>Telegram test</b>\n\nAlerts are working correctly. Bot token and chat ID are valid.'
    );
    console.log('[ScanTest] Telegram test message sent to', chatId);
    res.json({ ok: true, chatId });
  } catch (err) {
    console.error('[ScanTest] Telegram test failed:', err.message);
    res.status(500).json({ ok: false, error: err.message, chatId });
  }
});

// ── POST /api/scan/trigger-close ──────────────────────────────────────────────
// Manually invokes liveScanner.onCandleClose for a specific token+interval.
// Uses whatever candles are currently in candleStore (must be seeded first).
// Body: { token: number, interval: string }
router.post('/trigger-close', async (req, res) => {
  const { token, interval } = req.body;
  if (!token || !interval) {
    return res.status(400).json({ error: 'token and interval are required' });
  }

  const candles = candleStore.getCandlesSync(Number(token), interval);
  const entry = {
    token:    Number(token),
    interval,
    hasCandleData:  candles !== null,
    candleCount:    candles?.length ?? 0,
    meetsThreshold: (candles?.length ?? 0) >= 52,
    isWatched:      liveScanner.watchCount() > 0,
  };

  if (!candles) {
    return res.json({ ...entry, result: 'no_candle_data', message: 'candleStore has no entry for this token:interval — subscribe it first' });
  }
  if (candles.length < 52) {
    return res.json({ ...entry, result: 'insufficient_candles', message: `Only ${candles.length} candles — need 52 for Ichimoku signals` });
  }

  // Call the scanner directly — it will broadcast scan_alert if pattern matches
  liveScanner.onCandleClose(Number(token), interval);
  res.json({ ...entry, result: 'triggered', message: 'onCandleClose called — check server logs and Scanner tab for alerts' });
});

// ── POST /api/scan/reset ──────────────────────────────────────────────────────
// Full system reset: clears every in-memory cache and dedup guard so the next
// scan / candle close produces a genuine fresh-start result.
//
// What is reset:
//   historicalCache  — evicts all Kite API response cache entries (TTL 5 min)
//   candleStore      — drops all seeded ring buffers; next getCandles() re-seeds
//   backgroundScanner._dedup  — clears "already fired today" guard per pattern
//   liveScanner._dedup        — same for the live (tick-driven) scanner
//
// What is NOT reset:
//   paperTrades, config, watchlist, Kite auth — persistent data is untouched.
//   Instrument cache — re-loading 250K instruments takes 10+ seconds; skip it.
//
// The client is responsible for clearing its own scanAlerts store and screener
// state after receiving a 200 response.
router.post('/reset', (req, res) => {
  try {
    const historicalCleared  = historicalCache.clearCache()  ?? 0;
    const candleKeysCleared  = candleStore.clearAll();
    const bgDedupCleared     = backgroundScanner.clearDedup();
    const liveDedupCleared   = liveScanner.clearDedup();
    // Also clear auto-trader dedup so trades can re-fire after a reset
    const autoTraderSvc      = require('../services/autoTrader');
    const atDedupCleared     = autoTraderSvc.clearDedup();

    const summary = {
      ok:                 true,
      historicalCache:    'cleared',
      candleStoreKeys:    candleKeysCleared,
      bgScannerDedup:     bgDedupCleared,
      liveScannerDedup:   liveDedupCleared,
      autoTraderDedup:    atDedupCleared,
      note:               'Next scan will re-fetch candles from Kite and all patterns can re-fire.',
    };

    console.log(
      `[Reset] Full cache reset — candleStore: ${candleKeysCleared} keys,` +
      ` bgDedup: ${bgDedupCleared}, liveDedup: ${liveDedupCleared}, atDedup: ${atDedupCleared}`,
    );

    res.json(summary);
  } catch (err) {
    console.error('[Reset] Error during system reset:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/scan ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // The default scope ('all') scans ~250 NFO futures × 4 intervals ≈ 1000 pairs.
  // historicalCache enforces ~5.7 req/s — so the first scan can take ~3 minutes
  // before any per-instrument cache hits. Disable the default socket timeout so
  // the response is never cut off mid-scan. Subsequent scans are much faster
  // (historicalCache TTL = 5 min).
  req.setTimeout(0);
  res.setTimeout(0);

  const {
    patternId,
    intervals   = ['15minute', '60minute', '4h', 'day'],
    opts        = {},
    // Optional explicit instrument list — used when the caller wants to scan tokens
    // that are not in the persistent watchlist (e.g. macro instruments: VIX, Crude…).
    // Shape: [{ instrumentToken, tradingsymbol, exchange, name }]
    instruments = null,
    // Scope of the auto-built universe when `instruments` is not supplied:
    //   'all'       → macros + indices + ALL NFO front-month futures (~200 stocks) [default]
    //   'futures'   → macros + indices + NFO futures (alias of 'all')
    //   'watchlist' → macros + indices + user watchlist only (faster, smaller scan)
    //   'macros'    → macros + indices only (7 instruments)
    scope       = 'all',
    // Pause between consecutive timeframe phases to spread Kite API load.
    // Phases run sequentially: 15m for ALL instruments → wait → 1h for ALL → wait → 4h → wait → 1d.
    // Set to 0 to disable phasing (old behaviour: all intervals interleaved).
    interTfDelayMs = 3000,
    // Concurrent fetches per phase (also rate-limited globally by historicalCache).
    batchSize      = 8,
  } = req.body;

  if (!patternId) {
    return res.status(400).json({ error: 'patternId is required' });
  }

  // Resolve which patterns to run. patternId === 'all' (or 'ALL') runs every
  // registered pattern against each instrument×interval — the candle fetch is
  // shared across patterns so the extra cost is negligible CPU work in-process.
  let patternsToRun;
  if (String(patternId).toLowerCase() === 'all') {
    patternsToRun = patternRegistry.list().map(p => patternRegistry.get(p.id));
  } else {
    const single = patternRegistry.get(patternId);
    if (!single) {
      return res.status(400).json({ error: `Unknown pattern: "${patternId}"` });
    }
    patternsToRun = [single];
  }

  // Build the scan universe based on `instruments` body param or `scope`:
  let watchlist;
  if (instruments) {
    // Explicit list supplied by caller — used by tests / specialised scans
    watchlist = instruments.map(i => ({ ...i, instrumentToken: Number(i.instrumentToken) }));
  } else {
    const macros   = _macroAndIndexInstruments();
    const userList = (scope === 'macros') ? [] : store.getWatchlist();
    const futures  = (scope === 'all' || scope === 'futures') ? _allFoStocks() : [];

    // Merge in priority order — macros at the top, then user watchlist, then
    // the bulk NFO futures list. Dedup by instrumentToken.
    const seen = new Set();
    watchlist = [];
    for (const it of [...macros, ...userList, ...futures]) {
      const tk = Number(it.instrumentToken);
      if (seen.has(tk)) continue;
      seen.add(tk);
      watchlist.push({ ...it, instrumentToken: tk });
    }
  }

  const patternsLabel = patternsToRun.length > 1
    ? `ALL (${patternsToRun.length} patterns)`
    : patternsToRun[0].label;

  console.log(`[Scan] ${patternId} — universe of ${watchlist.length} instruments × ${intervals.length} intervals × ${patternsToRun.length} pattern(s) (scope=${instruments ? 'explicit' : scope})`);

  if (!watchlist.length) {
    return res.json({ patternId, patternLabel: patternsLabel, scannedCount: 0, totalInstruments: 0, matches: [] });
  }

  const matches      = [];
  let scannedCount   = 0;

  // Sleep helper for inter-phase gaps
  const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Scan one (interval × instruments) phase: fetches candles in concurrent
  // sub-batches (capped by `batchSize`, further rate-limited by historicalCache),
  // runs the pattern, and appends matches. Reusable between phases.
  async function _scanPhase(interval) {
    const phaseStart = Date.now();
    let phaseScanned = 0;
    let phaseMatched = 0;

    for (let i = 0; i < watchlist.length; i += batchSize) {
      await Promise.allSettled(
        watchlist.slice(i, i + batchSize).map(async (item) => {
          try {
            // Fetch candles ONCE per instrument×interval — shared across all patterns
            const candles = await _getCandles(item.instrumentToken, interval);
            if (!candles || candles.length < 52) return;

            phaseScanned++;
            scannedCount++;

            // Run every selected pattern against this candle set
            for (const p of patternsToRun) {
              let result;
              try {
                result = p.run(candles, opts);
              } catch (err) {
                console.warn(`[Scan] pattern.run failed (${p.id}) ${item.tradingsymbol}:${interval} —`, err.message);
                continue;
              }
              if (!result || !result.matched) continue;

              phaseMatched++;
              const matchEntry = {
                token:           item.instrumentToken,
                tradingsymbol:   item.tradingsymbol,
                exchange:        item.exchange,
                name:            item.name  || '',
                interval,
                // Pattern identity — included so the client can display and key on them
                patternId:       p.id,
                patternLabel:    p.label,
                signal:          result.signal,
                score:           result.score           ?? null,
                checks:          result.checks          ?? null,
                // Strength / context fields
                strength:        result.strength        ?? null,
                cloudPosition:   result.cloudPosition   ?? null,
                barsAgo:         result.barsAgo         ?? null,
                consecutiveBars: result.consecutiveBars ?? null,
                cloudThickness:  result.cloudThickness  ?? null,
                // Price / cloud values
                close:           result.close           ?? null,
                kijunValue:      result.kijunValue      ?? null,
                cloudTop:        result.cloudTop        ?? null,
                cloudBottom:     result.cloudBottom     ?? null,
                senkouA:         result.senkouA         ?? null,
                senkouB:         result.senkouB         ?? null,
                price26ago:      result.price26ago      ?? null,
                twistBarsAgo:    result.twistBarsAgo    ?? null,
                // Risk management — Ichimoku natural SL, target = max(2×risk, swing)
                sl:              result.sl              ?? null,
                target:          result.target          ?? null,
                targetSource:    result.targetSource    ?? null,
                // Volume context — ratio vs 20-bar avg; confirmed when ≥ 1.2×
                volumeRatio:     result.volumeRatio     ?? null,
                volumeConfirmed: result.volumeConfirmed ?? null,
              };
              matches.push(matchEntry);

              // Mirror to MongoDB + notify auto-trader — both fire-and-forget
              const _alertBusPayload = {
                ...matchEntry,
                label:   matchEntry.name || matchEntry.tradingsymbol,
                tfLabel: { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' }[interval] || interval,
                ts:      Date.now(),
              };
              db.alertRepo.insertAlert(_alertBusPayload, 'manual');
              alertBus.emit('alert', _alertBusPayload, 'manual');
            }
          } catch (err) {
            // Silence per-instrument errors — one bad token shouldn't abort the scan
            console.warn(`[Scan] ${item.tradingsymbol}:${interval} —`, err.message);
          }
        }),
      );
    }

    const took = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(`[Scan] phase ${interval}: ${phaseScanned}/${watchlist.length} scanned, ${phaseMatched} matched (${took}s)`);
  }

  // Run phases sequentially with a configurable pause between them so we don't
  // burst all 4 intervals × N instruments through the Kite rate limiter at once.
  for (let p = 0; p < intervals.length; p++) {
    const interval = intervals[p];
    await _scanPhase(interval);
    // Pause between phases — historicalCache handles per-request rate limiting,
    // so this gap only exists to give the Kite API a brief breath between bulk
    // phases. 500 ms is sufficient; the old 3 000 ms was unnecessary overhead.
    if (interTfDelayMs > 0 && p < intervals.length - 1) {
      console.log(`[Scan] pausing ${interTfDelayMs}ms before next timeframe…`);
      await _sleep(interTfDelayMs);
    }
  }

  // MTF confluence: annotate every match with the set of timeframes where the
  // same (token, patternId, signal) combination also appeared in this scan run.
  // confluenceTfs  — all TF labels for this combo (includes the match's own TF)
  // confluenceCount — total number of TFs; >1 means the signal fired on several TFs
  const _TF_LABEL = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };
  const confluenceMap = new Map();
  for (const m of matches) {
    const key = `${m.token}:${m.patternId}:${m.signal}`;
    if (!confluenceMap.has(key)) confluenceMap.set(key, []);
    confluenceMap.get(key).push(_TF_LABEL[m.interval] || m.interval);
  }
  for (const m of matches) {
    const key = `${m.token}:${m.patternId}:${m.signal}`;
    const tfs = confluenceMap.get(key) || [];
    m.confluenceTfs   = tfs;
    m.confluenceCount = tfs.length;
  }

  // Sort: bullish first, then bearish; then by score descending within each group
  matches.sort((a, b) => {
    if (a.signal !== b.signal) return a.signal === 'bullish' ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  console.log(`[Scan] ${patternId} — scanned ${scannedCount} pairs across ${watchlist.length} instruments × ${patternsToRun.length} pattern(s) → ${matches.length} matches`);

  res.json({
    patternId,
    patternLabel:     patternsLabel,
    patternsRun:      patternsToRun.length,
    scannedCount,
    totalInstruments: watchlist.length,
    matches,
  });
});

module.exports = router;
