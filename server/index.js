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
const telegramPoller = require('./services/telegramPoller');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// SSE stream endpoint — clients connect once and receive all events
app.get('/api/stream', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Trading dashboard server running on http://localhost:${PORT}`);
  try {
    telegramPoller.start();
    console.log('[Telegram] Auto-started polling on server boot');
  } catch (err) {
    console.warn('[Telegram] Could not auto-start polling:', err.message);
  }
});
