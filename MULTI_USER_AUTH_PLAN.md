# Multi-User Auth Platform — Implementation Plan

## Context

The app is currently single-user — all paper trades, settings, and watchlists are stored
in a shared `config.json` / in-memory store. The goal is to open the app to 50+ public
users while:
- Using the owner's single Kite WebSocket to broadcast live prices to everyone (SSE fan-out)
- Giving each user isolated paper trades, settings, and watchlist
- Keeping the owner's Kite credentials and admin routes private
- NOT hitting Kite historical API rate limits with many concurrent users

**User decisions:**
- Database: **MongoDB Atlas** (free tier)
- JWT storage: **httpOnly Cookie** (no JS access → XSS-safe)
- Scope: Paper trading for all + optional own Kite for real orders
- Scale: **50+ users (fully public)**

**Key insight on rate limits:** `historicalCache.js` already has a 3 req/s rate-limited
queue. The real fix is extending cache TTLs per-interval so 50 users viewing the same
chart = 1 Kite API call, not 50.

---

## What Already Exists (reuse as-is)

| File | What it does | Change needed? |
|---|---|---|
| `server/middleware/auth.js` | API-key check (`requireApiKey`) | Keep; add new `requireJwt` alongside |
| `server/services/historicalCache.js` | Rate-limited 3 req/s queue | Extend TTLs per interval only |
| `server/routes/paperTrades.js` | CRUD for paper trades | Scope all ops to `req.userId` |
| `server/routes/settings.js` | Trading defaults | Scope user settings to `req.userId` |
| `client/src/api.js` | Axios instance | Add `withCredentials: true` |
| `server/store.js` | In-memory + config.json | Keep for Kite/Telegram config only |

---

## Phase 1 — Auth Backend + Login UI (~1 day)

### New npm packages needed

**Server:**
```
mongoose       ^8.x   — MongoDB ODM
bcryptjs       ^2.x   — password hashing (pure JS, no native binding needed)
jsonwebtoken   ^9.x   — JWT sign/verify
cookie-parser  ^1.x   — parse httpOnly cookies in Express
```

**Client:** No new packages (axios already present).

### New environment variables

```env
MONGODB_URI=mongodb+srv://...        # MongoDB Atlas connection string
JWT_SECRET=<long random string>      # At least 32 chars, keep secret
ADMIN_EMAIL=you@example.com          # Auto-grants admin role on first register
```

---

### New server files

#### `server/db.js`
```js
const mongoose = require('mongoose');
let _connected = false;

async function connect() {
  if (_connected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  _connected = true;
  console.log('[MongoDB] Connected');
}

module.exports = { connect };
```

#### `server/models/User.js`
```js
const { Schema, model } = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt:    { type: Date, default: Date.now },
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = model('User', userSchema);
```

#### `server/models/PaperTrade.js`
```js
const { Schema, model } = require('mongoose');

const schema = new Schema({
  userId:     { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol:     String,
  action:     { type: String, enum: ['BUY', 'SELL'] },
  entryPrice: Number,
  exitPrice:  Number,
  quantity:   Number,
  sl:         Number,
  target:     Number,
  token:      Number,
  status:     { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  pnl:        Number,
  source:     String,   // 'scan' | 'telegram' | 'manual'
  ts:         { type: Date, default: Date.now },
  closedTs:   Date,
});

module.exports = model('PaperTrade', schema);
```

#### `server/models/UserSettings.js`
```js
const { Schema, model } = require('mongoose');

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true },
  tradingDefaults: {
    quantity: { type: Number, default: 1 },
    exchange: { type: String, default: 'NSE' },
    product:  { type: String, default: 'MIS' },
  },
  paperBalance: {
    initial:     { type: Number, default: 100000 },
    available:   { type: Number, default: 100000 },
    invested:    { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
  },
  watchlist: [{
    token:    Number,
    symbol:   String,
    exchange: String,
  }],
});

module.exports = model('UserSettings', schema);
```

#### `server/middleware/authJwt.js`
```js
const jwt = require('jsonwebtoken');

function requireJwt(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

module.exports = { requireJwt };
```

#### `server/middleware/requireAdmin.js`
```js
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = requireAdmin;
```

#### `server/middleware/rateLimit.js`
```js
// Simple in-memory token bucket — 30 historical API requests per user per minute
const counts = new Map();

function historicalRateLimit(req, res, next) {
  const uid = req.user?.id ?? req.ip;
  const now = Date.now();
  const entry = counts.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60_000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  counts.set(uid, entry);
  if (entry.count > 30) {
    return res.status(429).json({ error: 'Too many requests — slow down' });
  }
  next();
}

module.exports = { historicalRateLimit };
```

#### `server/routes/auth.js`
```js
// POST /api/auth/register  — create account, set JWT cookie
// POST /api/auth/login     — verify password, set JWT cookie
// POST /api/auth/logout    — clear cookie
// GET  /api/auth/me        — return { id, email, role } or 401

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
};

router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) required' });
  }
  if (await User.findOne({ email })) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const role         = email === process.env.ADMIN_EMAIL ? 'admin' : 'user';
  const passwordHash = await bcrypt.hash(password, 12);
  const user         = await User.create({ email, passwordHash, role });
  const token        = jwt.sign({ id: user._id, email, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, COOKIE_OPTS).status(201).json({ id: user._id, email, role });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await user.comparePassword(password))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user._id, email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, COOKIE_OPTS).json({ id: user._id, email, role: user.role });
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token').json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    res.json({ id: payload.id, email: payload.email, role: payload.role });
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
});

module.exports = router;
```

---

### Modified server files

#### `server/index.js` changes
1. `const cookieParser = require('cookie-parser')`
2. `app.use(cookieParser())`
3. `const { connect: connectDb } = require('./db')` → call `await connectDb()` at startup
4. `const authRouter = require('./routes/auth')`
5. `app.use('/api/auth', authRouter)` — public (before JWT middleware)
6. Apply `requireJwt` to all `/api/*` routes except `/api/auth` and `/api/stream`
7. Admin routes (`/api/kite/auth`, `POST /api/telegram`, `POST /api/scan/refresh-fo-registry`) get `requireAdmin` too

#### `client/src/api.js` changes
```js
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,   // ← adds this line; sends cookie on every request
});

export default api;
```

---

### New client files

#### `client/src/store/authStore.js`
```js
import { create } from 'zustand';

const useAuthStore = create((set) => ({
  user:    null,   // { id, email, role } or null
  loading: true,   // true until /api/auth/me resolves on boot
  setUser:   (user)  => set({ user, loading: false }),
  clearUser: ()      => set({ user: null, loading: false }),
}));

export default useAuthStore;
```

#### `client/src/pages/Auth.jsx`
Single page with tab toggle between **Log In** and **Sign Up**:
- Email + Password fields
- Validates: email format, password ≥ 8 chars
- Calls `POST /api/auth/login` or `POST /api/auth/register`
- On success: `authStore.setUser(data)` → main app renders
- Shows inline error on failure (wrong password, email taken, etc.)
- Minimal styling using existing CSS variables from App.css

---

### Modified client files

#### `client/src/App.jsx` changes
- On mount: `GET /api/auth/me` → `setUser(data)` if 200, `clearUser()` if 401
- While `loading === true`: show centered spinner
- If `user === null && !loading`: render `<Auth />` instead of main shell
- Add logout button somewhere in the Sidebar (calls `POST /api/auth/logout` → `clearUser()`)

---

## Phase 2 — Per-User Data in MongoDB (~1 day)

### Modified routes

#### `server/routes/paperTrades.js`
Replace all `store.*` calls with MongoDB:
```
GET /              → PaperTrade.find({ userId: req.user.id })
POST /:id/close    → PaperTrade.findOneAndUpdate({ _id: id, userId: req.user.id }, ...)
DELETE /           → PaperTrade.deleteMany({ userId: req.user.id })
GET /balance       → UserSettings.findOne({ userId: req.user.id }) → .paperBalance
POST /balance      → UserSettings.findOneAndUpdate({ userId: req.user.id }, { paperBalance.initial: amount }, { upsert: true })
```

#### `server/routes/settings.js`
```
GET /trading       → UserSettings.findOne({ userId: req.user.id }) → .tradingDefaults
POST /trading      → UserSettings.findOneAndUpdate({ userId: req.user.id }, { tradingDefaults: body }, { upsert: true })
```
Telegram settings remain in `store.js` (admin-only, not per-user).

### Watchlist strategy
The KiteTicker needs a **union of all users' watchlists**:
- On boot: `UserSettings.find({}, 'watchlist')` → merge all tokens → `kiteTicker.subscribe(mergedSet)`
- On user watchlist change: diff the merged set, call subscribe/unsubscribe
- Keep `store.setWatchlist()` as the runtime union; DB is source of truth on boot

---

## Phase 3 — Hardening + Rate Limiting (~half day)

### Historical cache TTL extension (`server/services/historicalCache.js`)

Replace the single `5 * 60 * 1000` TTL constant with a per-interval map:
```js
const CACHE_TTL = {
  'minute':   2  * 60 * 1000,
  '3minute':  3  * 60 * 1000,
  '5minute':  5  * 60 * 1000,
  '15minute': 15 * 60 * 1000,
  '30minute': 30 * 60 * 1000,
  '60minute': 60 * 60 * 1000,
  'day':      24 * 60 * 60 * 1000,
  'week':     7  * 24 * 60 * 60 * 1000,
};
```
Effect: 50 users loading NIFTY daily chart → 1 Kite API call per day (not 50).

### Apply rate limiter
Add `historicalRateLimit` middleware to `GET /api/historical/*` routes (30 req/user/min).

### Admin protection
Apply `requireAdmin` to:
- All of `/api/kite/auth/*`
- `POST /api/telegram`
- `POST /api/scan/refresh-fo-registry`
- `DELETE /api/scan/*` (if any)

---

## Files Summary

| File | Action | Phase |
|---|---|---|
| `server/db.js` | CREATE | 1 |
| `server/models/User.js` | CREATE | 1 |
| `server/models/PaperTrade.js` | CREATE | 2 |
| `server/models/UserSettings.js` | CREATE | 2 |
| `server/middleware/authJwt.js` | CREATE | 1 |
| `server/middleware/requireAdmin.js` | CREATE | 3 |
| `server/middleware/rateLimit.js` | CREATE | 3 |
| `server/routes/auth.js` | CREATE | 1 |
| `client/src/pages/Auth.jsx` | CREATE | 1 |
| `client/src/store/authStore.js` | CREATE | 1 |
| `server/index.js` | MODIFY — db.connect, cookieParser, authRouter, requireJwt | 1 |
| `server/routes/paperTrades.js` | MODIFY — MongoDB + userId scoping | 2 |
| `server/routes/settings.js` | MODIFY — MongoDB + userId scoping | 2 |
| `server/services/historicalCache.js` | MODIFY — per-interval TTLs | 3 |
| `client/src/api.js` | MODIFY — withCredentials: true | 1 |
| `client/src/App.jsx` | MODIFY — auth guard + /me check on mount | 1 |

---

## Verification Checklist

1. `POST /api/auth/register { email, password }` → 201, `Set-Cookie: token=...`
2. `GET /api/auth/me` with cookie → `{ id, email, role }`
3. `GET /api/paper` without cookie → 401
4. Two users register → each sees only their own paper trades in MongoDB
5. 50 users loading NIFTY daily chart → only 1 Kite historical API call (TTL cache)
6. Register with `ADMIN_EMAIL` → `role: 'admin'`; `POST /api/kite/auth/login` works; non-admin gets 403
7. Logout → cookie cleared → subsequent `/api/auth/me` returns 401 → app shows login page
