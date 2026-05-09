const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getConfig, setAccessToken, getWatchlist } = require('../store');
const instrumentCache = require('../services/instrumentCache');
const kiteTicker = require('../services/kiteTicker');

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

// Check if current access token is valid
router.get('/status', async (req, res) => {
  const { kite } = getConfig();
  if (!kite.accessToken) {
    return res.json({ authenticated: false, reason: 'No access token set' });
  }

  try {
    await axios.get('https://api.kite.trade/user/profile', {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
      },
    });
    res.json({ authenticated: true });
  } catch (err) {
    res.json({ authenticated: false, reason: err.response?.data?.message || err.message });
  }
});

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
