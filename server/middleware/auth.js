/**
 * Protects destructive Kite routes (order placement, GTT).
 * Set API_SECRET in Railway env vars and VITE_API_SECRET in Vercel env vars.
 */

function requireApiKey(req, res, next) {
  const expected = process.env.API_SECRET;
  if (!expected) {
    console.error('[Auth] API_SECRET not set — order/GTT routes are blocked until configured');
    return res.status(500).json({ error: 'Server misconfigured: API_SECRET not set' });
  }
  const provided = req.header('x-api-key');
  if (provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireApiKey };
