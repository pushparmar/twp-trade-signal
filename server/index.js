require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { addClient, broadcast } = require('./sseHub');

const kiteRouter = require('./routes/kite');
const kiteAuthRouter = require('./routes/kiteAuth');
const telegramRouter = require('./routes/telegram');
const paperTradesRouter = require('./routes/paperTrades');
const settingsRouter = require('./routes/settings');
const instrumentsRouter = require('./routes/instruments');
const historicalRouter = require('./routes/historical');
const ichimokuRouter = require('./routes/ichimoku');
const macroRouter    = require('./routes/macro');
const scanRouter      = require('./routes/scan');
const analyticsRouter = require('./routes/analytics');
const telegramPoller = require('./services/telegramPoller');
const instrumentCache = require('./services/instrumentCache');
const kiteTicker = require('./services/kiteTicker');
const indexSignalWatcher    = require('./services/indexSignalWatcher');
const macroWatcher          = require('./services/macroWatcher');
const patternAlertWatcher   = require('./services/patternAlertWatcher');
const liveScanner           = require('./services/liveScanner');
const backgroundScanner     = require('./services/backgroundScanner');
const foStockRegistry       = require('./services/foStockRegistry');
const tradeArchiver         = require('./services/tradeArchiver');
const db                    = require('./db');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
// Only log errors and slow requests — skip routine GET/POST noise and SSE heartbeats
app.use(morgan('combined', {
  skip: (req, res) => {
    // Skip SSE stream (heartbeats every 30s = ~3000 lines/day per client)
    if (req.path === '/api/stream') return true;
    // Skip fast successful requests — only log errors or slow responses
    return res.statusCode < 400;
  },
}));
app.use(express.json());

// SSE stream endpoint — clients connect once and receive all events
app.get('/api/stream', (req, res) => {
  // Explicit CORS for SSE — required for cross-origin streaming (Vercel → Railway)
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addClient(res);

  // Send a heartbeat immediately so the client knows the connection is live
  res.write(`event: status\ndata: ${JSON.stringify({ connected: true })}\n\n`);

  // Periodic heartbeat to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  req.on('close', () => clearInterval(heartbeat));
});

// Kite redirects to root when redirect URL in app is set to http://localhost:3001
app.get('/', (req, res) => {
  const { request_token, status } = req.query;
  if (status === 'success' && request_token) {
    return res.redirect(`/api/kite/auth/callback?request_token=${request_token}&status=success`);
  }
  res.redirect('http://localhost:5173');
});

app.use('/api/kite/auth', kiteAuthRouter);
app.use('/api/kite', kiteRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/paper', paperTradesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/instruments', instrumentsRouter);
app.use('/api/historical', historicalRouter);
app.use('/api/ichimoku', ichimokuRouter);
app.use('/api/macro',   macroRouter);
app.use('/api/scan',      scanRouter);
app.use('/api/analytics', analyticsRouter);

app.listen(PORT, async () => {
  console.log(`Trading dashboard server running on http://localhost:${PORT}`);

  // Connect to MongoDB — fire-and-forget (a DB outage must never block startup).
  // All repo writes check mongo.isReady() so they silently skip if DB is down.
  db.init().then((connected) => {
    if (!connected) console.warn('[DB] MongoDB not connected — pattern analytics disabled');
  }).catch((err) => {
    console.warn('[DB] init() threw unexpectedly:', err.message);
  });

  // DISABLE_TELEGRAM_POLLING=true in local .env prevents 409 conflicts when
  // both local dev server and Railway are running simultaneously.
  if (process.env.DISABLE_TELEGRAM_POLLING === 'true') {
    console.log('[Telegram] Polling disabled via DISABLE_TELEGRAM_POLLING env var');
  } else {
    // start() is async (awaits deleteWebhook) — must use .catch(), not try/catch,
    // so errors from async steps (missing bot token, network) are not swallowed.
    telegramPoller.start()
      .then(() => console.log('[Telegram] Auto-started polling on server boot'))
      .catch(err  => console.warn('[Telegram] Could not auto-start polling:', err.message));
  }

  // Start the daily 6 AM IST trade archiver — runs regardless of Kite auth.
  // Archives paper trades to data/history/trades-YYYY-MM-DD.json then clears.
  try {
    tradeArchiver.start();
  } catch (err) {
    console.warn('[TradeArchiver] Could not start:', err.message);
  }

  // Load F&O stock registry from disk immediately — no auth needed.
  // The registry (fo-stocks.json) holds stable NSE EQ tokens that never expire.
  // If the file doesn't exist yet it's a no-op; build() runs after auth below.
  foStockRegistry.load();

  // Init market data — load instruments and connect ticker if Kite is authenticated
  const { kite } = store.getConfig();
  if (kite.accessToken) {
    try {
      await instrumentCache.load();
    } catch (err) {
      console.warn('[InstrumentCache] Load failed on boot:', err.message);
    }

    // Auto-build the F&O registry if it's missing or stale (>35 days old).
    // This runs once after Kite auth and takes only a few milliseconds since
    // it reads from the already-loaded instrumentCache in-memory — no network calls.
    try {
      if (foStockRegistry.isStale()) {
        const result = foStockRegistry.build();
        console.log(`[FoRegistry] Auto-built: ${result.total} stocks (${result.added.length} added, ${result.removed.length} removed)`);
      }
    } catch (err) {
      console.warn('[FoRegistry] Auto-build failed:', err.message);
    }

    try {
      kiteTicker.connect();
      // Clear the entire watchlist on every boot — each session starts fresh.
      // The client re-subscribes index underlyings and fresh ATM strikes on load.
      // This also prevents stale/expired option strikes from persisting day-to-day.
      store.setWatchlist([]);
      console.log('[KiteTicker] Watchlist cleared on boot — client will re-subscribe on connect');

      // Re-subscribe tokens for any open paper trades loaded from trades-current.json.
      // Without this, server restarts would stop live-tick monitoring for those trades
      // until the client manually re-places them.
      const openTradeTokens = store.getPaperTrades()
        .filter((t) => t.status === 'OPEN' && t.token)
        .map((t) => Number(t.token));
      const uniqueTokens = [...new Set(openTradeTokens)];
      if (uniqueTokens.length > 0) {
        kiteTicker.subscribe(uniqueTokens);
        console.log(`[KiteTicker] Re-subscribed ${uniqueTokens.length} open paper trade token(s) from disk`);
      }
    } catch (err) {
      console.warn('[KiteTicker] Could not connect on boot:', err.message);
    }

    // Seed liveScanner from the persisted watchlist so Scanner tab alerts fire
    // correctly after a server restart (even before the client re-subscribes).
    // Note: watchlist is cleared above on boot, so this is a no-op on a fresh start
    // but will pick up items if setWatchlist([]) is removed in the future.
    try {
      liveScanner.seedFromWatchlist();
    } catch (err) {
      console.warn('[LiveScanner] Could not seed from watchlist:', err.message);
    }

    try {
      indexSignalWatcher.start();
    } catch (err) {
      console.warn('[IndexSignalWatcher] Could not start:', err.message);
    }

    try {
      macroWatcher.start();
    } catch (err) {
      console.warn('[MacroWatcher] Could not start:', err.message);
    }

    try {
      patternAlertWatcher.start();
    } catch (err) {
      console.warn('[PatternAlert] Could not start:', err.message);
    }

    // Background scanner — auto-scans all ~200 NFO futures at every candle
    // close (15m / 1h / 4h / 1d) and sends Telegram alerts for pattern matches.
    // This runs independently of KiteTicker so it works even when no user
    // watchlist stocks are explicitly subscribed.
    try {
      backgroundScanner.start();
    } catch (err) {
      console.warn('[BgScanner] Could not start:', err.message);
    }
  } else {
    console.log('[MarketWatch] Kite not authenticated — ticker and instrument cache will init after login');
  }
});

// ── Graceful shutdown (Railway sends SIGTERM on redeploy) ─────────────────────
// Stop Telegram polling before the process exits so the long-poll connection is
// released. Without this the old instance holds the connection while the new one
// starts → 409 conflict on the new instance.
function _gracefulShutdown(signal) {
  console.log(`[Server] ${signal} received — shutting down gracefully`);
  telegramPoller.stop();
  backgroundScanner.stop();
  // Close MongoDB connection so any in-flight writes complete before exit
  db.close().catch(() => {});
  // Give in-flight requests a moment to complete, then exit
  setTimeout(() => process.exit(0), 2_000);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
