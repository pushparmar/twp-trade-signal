const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getConfig, setAccessToken, getWatchlist } = require('../store');
const instrumentCache = require('../services/instrumentCache');
const kiteTicker = require('../services/kiteTicker');
const indexSignalWatcher  = require('../services/indexSignalWatcher');
const macroWatcher        = require('../services/macroWatcher');
const patternAlertWatcher = require('../services/patternAlertWatcher');

const router = express.Router();

// Returns the Kite login URL for the frontend to redirect to
router.get('/login-url', (req, res) => {
  const { kite } = getConfig();
  if (!kite.apiKey) {
    return res.status(400).json({ error: 'KITE_API_KEY is not set in environment variables' });
  }
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${kite.apiKey}&v=3`;
  res.json({ loginUrl });
});

// Owner-only daily token refresh page — bookmark this URL.
// Visiting it redirects straight to Kite login without needing the frontend.
// Protected by OWNER_SECRET env var (set a random string in Railway).
router.get('/owner-refresh', (req, res) => {
  const secret = process.env.OWNER_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(403).send('Forbidden');
  }
  const { kite } = getConfig();
  if (!kite.apiKey) {
    return res.status(400).send('KITE_API_KEY not configured');
  }
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${kite.apiKey}&v=3`;
  res.redirect(loginUrl);
});

// Called after Kite redirects back with request_token
// POST /api/kite/auth/token  { requestToken }
router.post('/token', async (req, res) => {
  const { requestToken } = req.body;
  if (!requestToken) {
    return res.status(400).json({ error: 'requestToken is required' });
  }

  const { kite } = getConfig();
  if (!kite.apiKey || !kite.apiSecret) {
    return res.status(400).json({ error: 'KITE_API_KEY and KITE_API_SECRET must be set in environment variables' });
  }

  // Kite checksum = sha256(api_key + request_token + api_secret)
  const checksum = crypto
    .createHash('sha256')
    .update(`${kite.apiKey}${requestToken}${kite.apiSecret}`)
    .digest('hex');

  try {
    const response = await axios.post(
      'https://api.kite.trade/session/token',
      new URLSearchParams({ api_key: kite.apiKey, request_token: requestToken, checksum }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' } },
    );

    const accessToken = response.data?.data?.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token returned from Kite' });
    }

    setAccessToken(accessToken);
    console.log('[Kite Auth] Access token refreshed successfully');

    res.json({ ok: true, message: 'Access token updated successfully' });
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.error('[Kite Auth] Token exchange failed:', detail);
    res.status(400).json({ error: `Token exchange failed: ${detail}` });
  }
});

// Full connection health check — token validity + ticker state + subscribed instruments
router.get('/status', async (req, res) => {
  const { kite } = getConfig();

  if (!kite.accessToken) {
    return res.json({
      authenticated: false,
      reason: 'No access token set',
      tickerConnected: false,
      subscribedTokens: [],
    });
  }

  let authenticated = false;
  let reason = null;
  let profile = null;

  try {
    const r = await axios.get('https://api.kite.trade/user/profile', {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
      },
      timeout: 6000,
    });
    authenticated = true;
    profile = r.data?.data ?? null;
  } catch (err) {
    reason = err.response?.data?.message || err.message;
  }

  res.json({
    authenticated,
    reason,
    profile: profile ? { user_id: profile.user_id, user_name: profile.user_name, email: profile.email } : null,
    tickerConnected:  kiteTicker.isConnected(),
    subscribedTokens: kiteTicker.getSubscribed(),
    tokenPrefix: kite.accessToken ? kite.accessToken.slice(0, 6) + '…' : null,
  });
});

// ── Dev-only: hot-swap the access token without restarting the server ──────────
// POST /api/kite/auth/dev-token  { "token": "<access_token>" }
// Blocked in production (NODE_ENV=production).
router.post('/dev-token', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: '"token" field is required' });

  // 1. Persist token in memory + config.json
  setAccessToken(token);
  console.log('[DevToken] Access token updated');

  // 2. Reload instrument cache (non-blocking — errors are logged, not fatal)
  instrumentCache.load().catch((e) =>
    console.warn('[DevToken] instrumentCache.load() failed:', e.message),
  );

  // 3. Reconnect ticker with new token
  kiteTicker.connect();

  // 4. Re-subscribe watchlist after ticker connects (small delay for handshake)
  const watchlist = getWatchlist();
  if (watchlist.length > 0) {
    setTimeout(() => {
      kiteTicker.subscribe(watchlist.map((i) => i.instrumentToken));
    }, 2500);
  }

  // 5. (Re-)start signal watchers — safe to call multiple times
  try { indexSignalWatcher.start();  } catch {}
  try { macroWatcher.start();        } catch {}
  try { patternAlertWatcher.start(); } catch {}

  res.json({ ok: true, message: 'Token saved — ticker reconnecting, watchers restarted' });
});

// Silently pushes the new access token to Railway env vars so it survives redeployments.
// Requires RAILWAY_API_TOKEN + RAILWAY_SERVICE_ID + RAILWAY_ENVIRONMENT_ID in env.
async function pushTokenToRailway(token) {
  const { RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID } = process.env;
  if (!RAILWAY_API_TOKEN || !RAILWAY_SERVICE_ID || !RAILWAY_ENVIRONMENT_ID) return;

  const mutation = `
    mutation variableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;
  try {
    await axios.post(
      'https://backboard.railway.app/graphql/v2',
      {
        query: mutation,
        variables: {
          input: {
            projectId: RAILWAY_PROJECT_ID,
            serviceId: RAILWAY_SERVICE_ID,
            environmentId: RAILWAY_ENVIRONMENT_ID,
            name: 'KITE_ACCESS_TOKEN',
            value: token,
          },
        },
      },
      { headers: { Authorization: `Bearer ${RAILWAY_API_TOKEN}`, 'Content-Type': 'application/json' } },
    );
    console.log('[Kite Auth] KITE_ACCESS_TOKEN updated in Railway env vars');
  } catch (err) {
    // Non-fatal — token is already in memory, Railway update is best-effort
    console.warn('[Kite Auth] Could not update Railway env var:', err.message);
  }
}

// Callback — Kite redirects here after login, auto-exchanges token and redirects to dashboard
// Set your Kite app's redirect URL to: https://<your-railway-server>/api/kite/auth/callback
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

router.get('/callback', async (req, res) => {
  const { request_token, status } = req.query;

  if (status !== 'success' || !request_token) {
    return res.redirect(`${FRONTEND_URL}?kite=error`);
  }

  const { kite } = getConfig();
  const checksum = crypto
    .createHash('sha256')
    .update(`${kite.apiKey}${request_token}${kite.apiSecret}`)
    .digest('hex');

  try {
    const response = await axios.post(
      'https://api.kite.trade/session/token',
      new URLSearchParams({ api_key: kite.apiKey, request_token, checksum }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' } },
    );

    const accessToken = response.data?.data?.access_token;
    if (!accessToken) throw new Error('No access token in response');

    setAccessToken(accessToken);
    console.log('[Kite Auth] Access token activated via callback');

    // Push token to Railway env vars so it survives restarts (best-effort, non-blocking)
    pushTokenToRailway(accessToken).catch(() => {});

    // Init market data now that we have a valid token
    instrumentCache.load().catch((e) => console.warn('[InstrumentCache] Load failed:', e.message));
    kiteTicker.connect();
    const watchlist = getWatchlist();
    if (watchlist.length > 0) {
      // Small delay to let ticker connect before subscribing
      setTimeout(() => {
        kiteTicker.subscribe(watchlist.map((i) => i.instrumentToken));
      }, 2000);
    }

    res.redirect(`${FRONTEND_URL}?kite=connected`);
  } catch (err) {
    console.error('[Kite Auth] Callback token exchange failed:', err.response?.data?.message || err.message);
    res.redirect(`${FRONTEND_URL}?kite=error`);
  }
});

module.exports = router;
