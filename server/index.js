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
const analyticsRouter    = require('./routes/analytics');
const autoTraderRouter   = require('./routes/autoTrader');
const backtestRouter     = require('./routes/backtest');
const autoTrader         = require('./services/autoTrader');
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
app.use('/api/analytics',   analyticsRouter);
app.use('/api/auto-trader', autoTraderRouter);
app.use('/api/backtest',    backtestRouter);

app.listen(PORT, async () => {
  console.log(`Trading dashboard server running on http://localhost:${PORT}`);

  // Connect to MongoDB and, if trades-current.json was missing on this boot,
  // restore any OPEN trades from MongoDB so they survive Railway redeploys
  // and accidental file deletions.  All repo writes are still fire-and-forget
  // so a DB outage never blocks the rest of the startup sequence.
  db.init().then(async (connected) => {
    if (!connected) {
      console.warn('[DB] MongoDB not connected — pattern analytics disabled');
      return;
    }

    // ── Restore recent trades from MongoDB if disk file was missing ─────────
    // Restores both OPEN and CLOSED trades so every device sees the same
    // order book regardless of when it loads.
    if (store.getPaperTrades().length === 0) {
      try {
        const recentFromMongo = await db.tradeRepo.getRecentTrades(200);
        if (recentFromMongo.length > 0) {
          for (const trade of recentFromMongo) store.addPaperTrade(trade);
          const open    = recentFromMongo.filter((t) => t.status === 'OPEN');
          const pending = recentFromMongo.filter((t) => t.status === 'PENDING');
          console.log(`[DB] Restored ${recentFromMongo.length} trade(s) from MongoDB (${open.length} open, ${pending.length} pending)`);

          // Subscribe underlying tokens for both OPEN and PENDING trades;
          // derivative tokens only for OPEN (pending hasn't filled yet).
          const rawTokens = [
            ...open.map((t) => t.token),
            ...open.map((t) => t.derivativeToken),
            ...pending.map((t) => t.token),
          ].filter(Boolean).map(Number);
          const tokens = [...new Set(rawTokens)];
          if (tokens.length > 0) {
            try { kiteTicker.subscribe(tokens); } catch { /* ticker may not be connected yet */ }
          }
        }
      } catch (err) {
        console.warn('[DB] Could not restore trades from MongoDB:', err.message);
      }
    }

    // ── Always merge OPEN trades from MongoDB — cross-device safety net ──────
    // The check above only runs when the disk file is empty.  But a trade
    // placed from another device (or before MongoDB was ready) can exist in
    // MongoDB while the local in-memory store already has other trades —
    // causing the "length > 0" guard above to skip the restore entirely.
    // This second pass always runs: it fetches every OPEN trade from MongoDB
    // and adds any that are missing from memory so no open position is lost
    // after a server restart regardless of disk state.
    try {
      const openFromMongo = await db.tradeRepo.getOpenTrades();
      if (openFromMongo.length > 0) {
        const inMemoryIds  = new Set(store.getPaperTrades().map((t) => t.id));
        const missingTrades = openFromMongo.filter((t) => !inMemoryIds.has(t.id));
        if (missingTrades.length > 0) {
          for (const trade of missingTrades) store.addPaperTrade(trade);
          console.log(`[DB] Merged ${missingTrades.length} open trade(s) from MongoDB not present in memory`);

          // Subscribe tokens so tradeWatcher can monitor SL/target on live ticks.
          const rawTokens = [
            ...missingTrades.map((t) => t.token),
            ...missingTrades.map((t) => t.derivativeToken),
          ].filter(Boolean).map(Number);
          const tokens = [...new Set(rawTokens)];
          if (tokens.length > 0) {
            try { kiteTicker.subscribe(tokens); } catch { /* ticker may connect later */ }
          }
        }
      }
    } catch (err) {
      console.warn('[DB] Could not merge open trades from MongoDB:', err.message);
    }

    // ── Restore cumulative PnL from MongoDB — authoritative source of truth ──
    // MongoDB is the definitive record; overrides config.json so the balance
    // survives Railway redeploys, persistent-volume wipes, and config loss.
    try {
      const dbPnl = await db.tradeRepo.getCumulativePnl();
      if (dbPnl !== null) {
        store.setCumulativePnl(dbPnl);
        console.log(`[DB] Cumulative PnL loaded from MongoDB: ₹${dbPnl}`);
      }
    } catch (err) {
      console.warn('[DB] Could not load cumulative PnL from MongoDB:', err.message);
    }

    // ── Backfill: any trades already in memory but not yet in MongoDB ───────
    // Covers the race where a trade was placed during the brief window
    // BEFORE db.init() completed (mongo.isReady() was false at write time).
    const memTrades = store.getPaperTrades();
    if (memTrades.length > 0) {
      console.log(`[DB] Backfilling ${memTrades.length} in-memory trade(s) to MongoDB`);
      for (const trade of memTrades) {
        db.tradeRepo.upsertTrade(trade);
      }
    }
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

  // Auto-trader — listens for scan alerts and places paper trades automatically.
  // Disabled by default; user must enable via Dashboard toggle or POST /api/auto-trader/settings.
  try {
    autoTrader.start();
  } catch (err) {
    console.warn('[AutoTrader] Could not start:', err.message);
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
      const openTrades = store.getPaperTrades().filter((t) => t.status === 'OPEN');
      const openTradeTokens = [
        ...openTrades.filter((t) => t.token).map((t) => Number(t.token)),
        ...openTrades.filter((t) => t.derivativeToken).map((t) => Number(t.derivativeToken)),
      ];
      const uniqueTokens = [...new Set(openTradeTokens)];
      if (uniqueTokens.length > 0) {
        kiteTicker.subscribe(uniqueTokens);
        console.log(`[KiteTicker] Re-subscribed ${uniqueTokens.length} token(s) for open paper trades (incl. derivatives)`);
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
  autoTrader.stop();
  // Close MongoDB connection so any in-flight writes complete before exit
  db.close().catch(() => {});
  // Give in-flight requests a moment to complete, then exit
  setTimeout(() => process.exit(0), 2_000);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
