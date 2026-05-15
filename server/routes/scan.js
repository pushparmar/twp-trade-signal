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
const { broadcast }    = require('../sseHub');
const store            = require('../store');
const { to4H }         = require('../services/ichimoku');
const { VIX_TOKEN, getFrontMonthFutures } = require('../services/macroAnalysis');
const instrumentCache  = require('../services/instrumentCache');

/**
 * Build the list of every active NFO front-month stock future (~200-250 names).
 * Reads from instrumentCache — returns [] if cache hasn't loaded yet.
 *
 * Used as the default scan universe so the Screener button doesn't need
 * any manual subscription — every F&O-eligible stock is included automatically.
 *
 * Returns: [{ instrumentToken, tradingsymbol, exchange, name }]
 */
function _allNfoFutures() {
  if (!instrumentCache.isLoaded()) return [];

  const names = instrumentCache.getFutureNames();
  const out = [];
  for (const name of names) {
    const inst = instrumentCache.getFrontMonthFuture(name, 'NFO');
    if (!inst) continue;
    out.push({
      instrumentToken: inst.instrumentToken,
      tradingsymbol:   inst.tradingsymbol,
      exchange:        inst.exchange,
      name:            inst.name,
    });
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
  '60minute': 208,  // 4h synthesis needs 52×4 = 208 1h bars
  'day':      100,
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
  const futures  = _allNfoFutures();
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

// ── POST /api/scan/clear-dedup ────────────────────────────────────────────────
// Clears the background-scanner dedup map so every pattern will re-fire on the
// next candle close. Use this when you want to re-receive today's alerts.
router.post('/clear-dedup', (req, res) => {
  const count = backgroundScanner.clearDedup();
  res.json({ ok: true, clearedEntries: count });
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
    const futures  = (scope === 'all' || scope === 'futures') ? _allNfoFutures() : [];

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
              } catch {
                continue; // bad pattern run — skip
              }
              if (!result || !result.matched) continue;

              phaseMatched++;
              matches.push({
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
              });
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
