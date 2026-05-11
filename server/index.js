require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { addClient, broadcast } = require('./sseHub');
const { apiKeyMiddleware } = require('./middleware/auth');

const kiteRouter = require('./routes/kite');
const kiteAuthRouter = require('./routes/kiteAuth');
const telegramRouter = require('./routes/telegram');
const paperTradesRouter = require('./routes/paperTrades');
const settingsRouter = require('./routes/settings');
const instrumentsRouter = require('./routes/instruments');
const historicalRouter = require('./routes/historical');
const ichimokuRouter = require('./routes/ichimoku');
const macroRouter    = require('./routes/macro');
const telegramPoller = require('./services/telegramPoller');
const instrumentCache = require('./services/instrumentCache');
const kiteTicker = require('./services/kiteTicker');
const indexSignalWatcher = require('./services/indexSignalWatcher');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3001;

// L2 — Security headers
app.use(helmet());

// L3 — Rate limiting: 200 req/min per IP on API routes
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

// H2 — CORS allowlist (never reflect arbitrary Origin)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map((o) => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server requests (no Origin header) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(morgan('dev'));
app.use(express.json());

// H1 — API key guard on all /api/* routes (public routes excluded inside middleware)
app.use('/api', apiKeyMiddleware);

// SSE stream endpoint — clients connect once and receive all events
app.get('/api/stream', (req, res) => {
  // H2 — use validated origin from CORS allowlist, never reflect blindly
  const requestOrigin = req.headers.origin;
  const allowedOrigin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
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

app.listen(PORT, async () => {
  // Warn loudly if DASHBOARD_API_KEY is not set — all routes will return 401
  if (!process.env.DASHBOARD_API_KEY) {
    console.warn('[Security] ⚠️  DASHBOARD_API_KEY is not set — all API routes will return 401. Set it in your .env / Railway secrets.');
  }

  console.log(`Trading dashboard server running on http://localhost:${PORT}`);

  try {
    telegramPoller.start();
    console.log('[Telegram] Auto-started polling on server boot');
  } catch (err) {
    console.warn('[Telegram] Could not auto-start polling:', err.message);
  }

  // Init market data — load instruments and connect ticker if Kite is authenticated
  const { kite } = store.getConfig();
  if (kite.accessToken) {
    try {
      await instrumentCache.load();
    } catch (err) {
      console.warn('[InstrumentCache] Load failed on boot:', err.message);
    }

    try {
      kiteTicker.connect();
      // Clear the entire watchlist on every boot — each session starts fresh.
      // The client re-subscribes index underlyings and fresh ATM strikes on load.
      // This also prevents stale/expired option strikes from persisting day-to-day.
      store.setWatchlist([]);
      console.log('[KiteTicker] Watchlist cleared on boot — client will re-subscribe on connect');
    } catch (err) {
      console.warn('[KiteTicker] Could not connect on boot:', err.message);
    }

    try {
      indexSignalWatcher.start();
    } catch (err) {
      console.warn('[IndexSignalWatcher] Could not start:', err.message);
    }
  } else {
    console.log('[MarketWatch] Kite not authenticated — ticker and instrument cache will init after login');
  }
});
