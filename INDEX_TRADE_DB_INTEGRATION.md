# Index Trade Database Integration

## Overview

This document describes the MongoDB integration for index option trades, matching the existing equity trade persistence pattern. All index trades are now persisted to the `index_trades` collection with full analytics support.

## Implementation Summary

### 1. New Repository: `indexTradeRepo.js`

**Location:** `server/db/repositories/indexTradeRepo.js`

A dedicated repository for index option trades following the same design as `tradeRepo.js`:

#### Key Features:
- **Fire-and-forget writes** — Never blocks trade execution
- **Upsert on tradeId** — Safe for retries and server restarts
- **Collection:** `index_trades` (separate from equity `paper_trades`)
- **Indexes created:**
  - `tradeId` (unique)
  - `status` (OPEN/CLOSED)
  - `patternId` (pattern correlation)
  - `strategyType` ('pattern' vs 'low-premium')
  - `index` (NIFTY vs BANKNIFTY)
  - `openedAt` (chronological)

#### Functions:

**Write Operations:**
- `upsertTrade(trade)` — Insert/update on entry
- `closeTrade(trade)` — Mark as CLOSED with exit price + PnL
- `updateTrade(trade)` — Update live fields (SL, TSL, avg-down)

**Read Operations:**
- `getOpenTrades()` — Restore on server boot
- `getRecentTrades(limit)` — Recent history (default 200)
- `getCumulativePnl()` — Total realized PnL

**Analytics:**
- `dailyPnl(opts)` — Daily P&L grouped by IST date
  - Filters: `fromDate`, `toDate`, `index`, `strategyType`
- `patternWinRate(opts)` — Win rate per pattern
  - Filters: `index`, `strategyType`
- `strategyPerformance(opts)` — Compare pattern vs low-premium
  - Filters: `index`, `fromDate`, `toDate`
- `getByDate(dateStr)` — All trades for specific IST date
- `getTradingDates()` — List of dates with trades

### 2. Updated: `tradeStore.js`

**Changes:**
- Removed inline MongoDB code
- Delegated persistence to `db.indexTradeRepo`
- Maintained existing in-memory API (no breaking changes)

**Integration Points:**
```javascript
// On trade open
db.indexTradeRepo.upsertTrade(trade);

// On trade close
db.indexTradeRepo.closeTrade(trade);

// On live updates (SL, TSL, avg-down)
db.indexTradeRepo.updateTrade(trade);

// On boot (restore from MongoDB)
const openTrades = await db.indexTradeRepo.getOpenTrades();
```

### 3. Updated: `db/index.js`

Added `indexTradeRepo` to the database initialization:

```javascript
const indexTradeRepo = require('./repositories/indexTradeRepo');

async function init() {
  await Promise.all([
    // ... existing repos
    indexTradeRepo.createIndexes(),
  ]);
}

module.exports = { ..., indexTradeRepo };
```

### 4. New Analytics Routes

**Location:** `server/index-trade/routes.js`

Added 7 new analytics endpoints:

#### `GET /api/index-trade/analytics/daily-pnl`
Daily P&L aggregation
```
Query params:
  - fromDate: YYYY-MM-DD
  - toDate: YYYY-MM-DD
  - index: NIFTY | BANKNIFTY
  - strategyType: pattern | low-premium
```

#### `GET /api/index-trade/analytics/pattern-win-rate`
Win rate per pattern ID
```
Query params:
  - index: NIFTY | BANKNIFTY
  - strategyType: pattern | low-premium
```

#### `GET /api/index-trade/analytics/strategy-performance`
Compare pattern vs low-premium strategy
```
Query params:
  - index: NIFTY | BANKNIFTY
  - fromDate: YYYY-MM-DD
  - toDate: YYYY-MM-DD
```

#### `GET /api/index-trade/analytics/cumulative-pnl`
Total realized PnL across all time

#### `GET /api/index-trade/analytics/trading-dates`
List of IST dates with at least one trade

#### `GET /api/index-trade/analytics/by-date/:date`
All trades for specific IST date (YYYY-MM-DD)

#### `GET /api/index-trade/analytics/recent-trades`
Recent trades from MongoDB
```
Query params:
  - limit: number (default 200)
```

## Data Flow

### Trade Lifecycle

```
1. Entry Signal
   ↓
2. orderManager.onSignal() or _checkLowPremiumEntry()
   ↓
3. tradeStore.addTrade()
   ↓
4. db.indexTradeRepo.upsertTrade() → MongoDB
   ↓
5. Per-tick monitoring (_handlePatternTSL / _handleLowPremiumTSL)
   ↓
6. tradeStore.updateTrade() on SL/TSL/avg-down changes
   ↓
7. db.indexTradeRepo.updateTrade() → MongoDB
   ↓
8. Exit (SL/Target/TSL/EOD/Manual)
   ↓
9. tradeStore.closeTrade()
   ↓
10. db.indexTradeRepo.closeTrade() → MongoDB
```

### Server Restart Flow

```
1. Server boots
   ↓
2. db.init() — creates indexes
   ↓
3. indexTrade.start()
   ↓
4. tradeStore.restore()
   ↓
5. db.indexTradeRepo.getOpenTrades() ← MongoDB
   ↓
6. OPEN trades resume monitoring
```

## Comparison: Equity vs Index Trade Persistence

| Feature | Equity Trades | Index Trades |
|---------|---------------|--------------|
| Collection | `paper_trades` | `index_trades` |
| Repository | `tradeRepo.js` | `indexTradeRepo.js` |
| In-memory store | `store.js` | `tradeStore.js` |
| Index-specific fields | — | `index`, `optionType`, `strike`, `strategyType` |
| Avg-down support | No | Yes (LP strategy) |
| Analytics routes | `/api/paper/*` | `/api/index-trade/analytics/*` |

## Low-Premium Strategy Fields

The following fields are specific to the Low Premium Scalper strategy and persist to MongoDB:

- `avgPrice` — Weighted average entry (after avg-down)
- `lotCount` — Total lots held (incremented on avg-down)
- `avgDownCount` — Number of times averaged (max 1)
- `avgDownAt` — Trigger price for avg-down (disarmed after use)

## Benefits

1. **Survives server restarts** — OPEN trades restore automatically
2. **Historical analysis** — Daily P&L, pattern win rates, strategy comparison
3. **Cross-device sync** — All clients see the same trade history
4. **No data loss** — Fire-and-forget writes prevent blocking on DB issues
5. **Pattern correlation** — Measure which Ichimoku patterns work best
6. **Strategy optimization** — Compare pattern vs low-premium performance

## Migration Notes

### Existing Trades
- Old in-memory-only trades are NOT migrated
- MongoDB persistence starts from the moment this code deploys
- Historical data begins accumulating immediately after deployment

### No Breaking Changes
- All existing UI code continues to work
- In-memory APIs (`tradeStore.*`) remain unchanged
- New analytics routes are opt-in additions

## Future Enhancements

Possible future additions:

1. **Trade journal notes** — User annotations per trade
2. **Risk metrics** — Sharpe ratio, max drawdown, win streak
3. **Intraday patterns** — Hourly P&L distribution
4. **Option Greeks tracking** — Delta, Theta, IV at entry
5. **Multi-leg strategies** — Spreads, straddles (requires schema extension)

## Testing

### Verify Persistence

```bash
# 1. Place a pattern trade (wait for a scan signal)
# 2. Check MongoDB
db.index_trades.findOne({ status: 'OPEN' })

# 3. Close the trade
# 4. Verify CLOSED status + PnL
db.index_trades.findOne({ status: 'CLOSED' })
```

### Test Analytics

```bash
# Daily P&L (all time)
curl http://localhost:3001/api/index-trade/analytics/daily-pnl

# Pattern win rate (NIFTY only)
curl http://localhost:3001/api/index-trade/analytics/pattern-win-rate?index=NIFTY

# Strategy comparison
curl http://localhost:3001/api/index-trade/analytics/strategy-performance

# Cumulative PnL
curl http://localhost:3001/api/index-trade/analytics/cumulative-pnl
```

### Test Server Restart

```bash
# 1. Place an OPEN trade
# 2. Restart server: npm start
# 3. Check logs for: "[IdxTradeStore] Restored X open trade(s) from MongoDB"
# 4. Verify trade resumes monitoring (SL/Target still active)
```

## MongoDB Schema

### Collection: `index_trades`

```javascript
{
  _id: ObjectId,
  tradeId: String (unique),        // UUID from trade.id
  createdAt: Date,
  updatedAt: Date,
  openedAt: Date,                   // IST entry time
  closedAt: Date | null,            // IST exit time

  // Classification
  source: 'index-trade',
  strategyType: 'pattern' | 'low-premium',

  // Index option details
  index: 'NIFTY' | 'BANKNIFTY' | 'SENSEX',
  symbol: String,                   // e.g. 'NIFTY24604CE24000'
  token: Number,                    // Kite instrument token
  optionType: 'CE' | 'PE',
  strike: Number,
  exchange: 'NFO',

  // Trade execution
  action: 'BUY',                    // Always BUY (never SELL)
  quantity: Number,                 // Number of lots
  lotSize: Number,                  // Contract lot size
  entryPrice: Number,
  exitPrice: Number | null,
  exitReason: 'sl' | 'tsl' | 'target' | 'eod' | 'manual' | null,
  sl: Number,
  initialSl: Number,
  target: Number,
  status: 'OPEN' | 'CLOSED',
  pnl: Number | null,

  // Low-premium fields (null for pattern trades)
  avgPrice: Number | null,          // Weighted avg after avg-down
  lotCount: Number | null,          // Total lots held
  avgDownCount: Number | null,      // 0 or 1
  avgDownAt: Number | null,         // Avg-down trigger price

  // TSL state
  tslActivated: Boolean,
  peakPrice: Number | null,

  // Pattern context
  patternId: String | null,         // 'kumo-breakout', 'kijun-bounce', etc.
  patternLabel: String | null,
  signalDirection: 'bullish' | 'bearish' | null,
  interval: String | null,          // '5minute', '15minute', '60minute'
  tfLabel: String | null,           // '5m', '15m', '1h', 'LP'
  score: Number | null,             // Pattern quality score
  rrRatio: Number | null,           // Reward:risk ratio
}
```

## Indexes

```javascript
db.index_trades.createIndex({ tradeId: 1 }, { unique: true });
db.index_trades.createIndex({ status: 1 });
db.index_trades.createIndex({ patternId: 1 });
db.index_trades.createIndex({ strategyType: 1 });
db.index_trades.createIndex({ index: 1 });
db.index_trades.createIndex({ openedAt: -1 });
```

## Summary

Index option trades now have full MongoDB persistence with:
- ✅ Fire-and-forget writes (never blocks execution)
- ✅ Server restart recovery (OPEN trades restore)
- ✅ Historical analytics (daily P&L, pattern win rates)
- ✅ Strategy comparison (pattern vs low-premium)
- ✅ No breaking changes (existing code unaffected)

The implementation mirrors the proven `tradeRepo.js` pattern for equity trades, ensuring consistency across the codebase.
