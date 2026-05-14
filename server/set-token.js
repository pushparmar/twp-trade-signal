#!/usr/bin/env node
/**
 * Dev helper — update the Kite access token without restarting the server.
 *
 * Usage:
 *   node set-token.js <access_token>
 *
 * What it does:
 *   1. Writes the new token to config.json (so it survives the next restart too)
 *   2. Calls POST /api/kite/auth/dev-token on the running server so the token
 *      is hot-swapped in memory and the ticker reconnects immediately.
 *   3. If the server isn't running, just saves to config.json and reminds you to start it.
 *   4. Calls GET /api/kite/auth/status and prints the result so you can confirm it worked.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Parse args ────────────────────────────────────────────────────────────────

const token = (process.argv[2] || '').trim();

if (!token || token.startsWith('-')) {
  console.error('Usage: node set-token.js <access_token>');
  console.error('');
  console.error('Get a fresh token from:');
  console.error('  http://localhost:3001/api/kite/auth/owner-refresh');
  console.error('  (or use the Login button in the dashboard Settings page)');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: urlPath, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Step 1: Write to config.json ──────────────────────────────────────────────

const configPath = path.join(__dirname, 'config.json');
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.kiteAccessToken = token;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('✅ config.json updated');
} catch (e) {
  console.warn('⚠️  Could not write config.json:', e.message);
}

// ── Step 2: Hot-swap on running server ────────────────────────────────────────

console.log(`\nPinging server on port ${PORT}…`);

(async () => {
  // Hot-swap token
  try {
    const result = await postJson('/api/kite/auth/dev-token', { token });
    if (result.ok) {
      console.log('✅ Server accepted token:', result.message);
    } else {
      console.error('❌ Server rejected token:', result.error || JSON.stringify(result));
      process.exit(1);
    }
  } catch {
    console.log('ℹ️  Server not running — token saved to config.json.');
    console.log('   Start the server with: npm run dev');
    process.exit(0);
  }

  // Wait 2 s then check auth status
  console.log('\nWaiting 2 s for Kite to confirm token…');
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const status = await getJson('/api/kite/auth/status');
    console.log('\n── Connection Status ───────────────────────────');
    if (status.authenticated) {
      console.log(`✅ Kite authenticated`);
      if (status.profile) {
        console.log(`   User     : ${status.profile.user_name} (${status.profile.user_id})`);
        console.log(`   Email    : ${status.profile.email}`);
      }
    } else {
      console.log(`❌ Kite NOT authenticated: ${status.reason}`);
    }
    console.log(`   Ticker   : ${status.tickerConnected ? '🟢 connected' : '🔴 disconnected'}`);
    console.log(`   Subscribed tokens : ${status.subscribedTokens.length > 0
      ? status.subscribedTokens.join(', ')
      : '(none yet — client will subscribe on connect)'}`);
    console.log('────────────────────────────────────────────────');
  } catch (e) {
    console.warn('Could not fetch status:', e.message);
  }
})();
