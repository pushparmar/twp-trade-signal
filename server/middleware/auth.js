/**
 * API key middleware — protects all /api/* routes.
 *
 * Clients must send:  X-API-Key: <DASHBOARD_API_KEY>
 *
 * Set DASHBOARD_API_KEY as an environment variable (Railway secret).
 * If not set the server refuses to start (see index.js startup check).
 *
 * Public routes that bypass this middleware:
 *   GET  /api/kite/auth/login-url   — frontend needs this before auth
 *   GET  /api/kite/auth/callback    — Kite OAuth redirect
 *   GET  /api/kite/auth/status      — frontend polls this on load
 *   GET  /api/stream                — SSE; protected separately by origin allowlist
 */

const PUBLIC_PATHS = new Set([
  '/api/kite/auth/login-url',
  '/api/kite/auth/callback',
  '/api/kite/auth/status',
  '/api/stream',
]);

function apiKeyMiddleware(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const key = process.env.DASHBOARD_API_KEY;
  const provided = req.headers['x-api-key'];

  if (!key || provided !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { apiKeyMiddleware };
