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
const liveScanner      = require('../services/liveScanner');
const { broadcast }    = require('../sseHub');
const store            = require('../store');

const router = express.Router();

// Synthesise 4h candles by collapsing four consecutive 1h candles.
// Mirrors the same helper in routes/ichimoku.js and services/macroAnalysis.js.
function _to4H(candles1h) {
  const out = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const slice = candles1h.slice(i, i + 4);
    out.push({
      date:  slice[0].date,
      open:  slice[0].open,
      high:  Math.max(...slice.map((c) => c.high)),
      low:   Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

// Fetch candles for any interval, handling the synthetic 4h case.
async function _getCandles(token, interval) {
  if (interval === '4h') {
    // Pull enough 1h bars to produce at least 52 synthesised 4h candles (52×4 = 208 1h bars)
    const c1h = await candleStore.getCandles(token, '60minute', 208);
    return c1h && c1h.length >= 8 ? _to4H(c1h) : null;
  }
  return candleStore.getCandles(token, interval);
}

// ── GET /api/scan/patterns ────────────────────────────────────────────────────
router.get('/patterns', (_req, res) => {
  res.json(patternRegistry.list());
});

// ── GET /api/scan/scanner-status ─────────────────────────────────────────────
// Diagnostic: shows how many instruments are registered in liveScanner,
// candleStore memory stats, and current watchlist.
router.get('/scanner-status', (req, res) => {
  const storeStats = candleStore.stats();
  const watchlist  = store.getWatchlist();
  res.json({
    liveScannerWatchCount: liveScanner.watchCount(),
    watchlistLength:       watchlist.length,
    candleStoreKeys:       storeStats.keys,
    candleStoreCandles:    storeStats.totalCandles,
    watchlist:             watchlist.map(i => ({ token: i.instrumentToken, symbol: i.tradingsymbol })),
  });
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
  const {
    patternId,
    intervals   = ['15minute', '60minute', '4h', 'day'],
    opts        = {},
    // Optional explicit instrument list — used when the caller wants to scan tokens
    // that are not in the persistent watchlist (e.g. macro instruments: VIX, Crude…).
    // Shape: [{ instrumentToken, tradingsymbol, exchange, name }]
    instruments = null,
  } = req.body;

  if (!patternId) {
    return res.status(400).json({ error: 'patternId is required' });
  }

  const pattern = patternRegistry.get(patternId);
  if (!pattern) {
    return res.status(400).json({ error: `Unknown pattern: "${patternId}"` });
  }

  // Prefer the caller-supplied list; fall back to the persistent watchlist.
  const watchlist = instruments
    ? instruments.map(i => ({ ...i, instrumentToken: Number(i.instrumentToken) }))
    : store.getWatchlist();

  if (!watchlist.length) {
    return res.json({ patternId, patternLabel: pattern.label, scannedCount: 0, totalInstruments: 0, matches: [] });
  }

  // Build the full task list: one entry per (instrument × interval)
  const tasks = [];
  for (const item of watchlist) {
    for (const interval of intervals) {
      tasks.push({ item, interval });
    }
  }

  const matches      = [];
  let scannedCount   = 0;

  // Process in small concurrent batches to avoid hammering the Kite historical API
  const BATCH_SIZE = 8;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    await Promise.allSettled(
      tasks.slice(i, i + BATCH_SIZE).map(async ({ item, interval }) => {
        try {
          const candles = await _getCandles(item.instrumentToken, interval);
          // Skip instruments with insufficient history — not an error worth logging
          if (!candles || candles.length < 52) return;

          scannedCount++;

          const result = pattern.run(candles, opts);
          if (!result || !result.matched) return;

          matches.push({
            token:         item.instrumentToken,
            tradingsymbol: item.tradingsymbol,
            exchange:      item.exchange,
            name:          item.name  || '',
            interval,
            signal:        result.signal,
            score:         result.score,
            checks:        result.checks,
            twistBarsAgo:  result.twistBarsAgo  ?? null,
            close:         result.close         ?? null,
            kijunValue:    result.kijunValue     ?? null,
            cloudTop:      result.cloudTop       ?? null,
            cloudBottom:   result.cloudBottom    ?? null,
            senkouA:       result.senkouA        ?? null,
            senkouB:       result.senkouB        ?? null,
            price26ago:    result.price26ago     ?? null,
          });
        } catch (err) {
          // Silence per-instrument errors — one bad token shouldn't abort the scan
          console.warn(`[Scan] ${item.tradingsymbol}:${interval} —`, err.message);
        }
      }),
    );
  }

  // Sort: bullish first, then bearish; then by score descending within each group
  matches.sort((a, b) => {
    if (a.signal !== b.signal) return a.signal === 'bullish' ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  console.log(`[Scan] ${patternId} — scanned ${scannedCount} pairs across ${watchlist.length} instruments → ${matches.length} matches`);

  res.json({
    patternId,
    patternLabel:     pattern.label,
    scannedCount,
    totalInstruments: watchlist.length,
    matches,
  });
});

module.exports = router;
