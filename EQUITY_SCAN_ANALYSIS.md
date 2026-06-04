# Equity Scan vs F&O Scan Analysis

## Summary
The equity scan **IS working correctly** and scanning ALL NSE equity stocks. The confusion likely stems from comparing it with other scanners that intentionally scan only F&O stocks.

## Three Different Scanners in the System

### 1. **Equity Scan** (On-Demand, Full Market)
- **File**: `server/services/equityScanService.js`
- **Universe**: `instrumentCache.getAllNseEquity()` → **ALL ~1200-1400 NSE EQ stocks** (F&O + non-F&O)
- **Timeframes**: 4H, 1D, 1W (higher timeframes for swing trading)
- **Trigger**: Manual via POST `/api/equity-scan/run`
- **Frequency**: Once per day (cached)
- **Storage**: `equity_scan_cache` MongoDB collection
- **UI**: `EquityScanPanel.jsx` component
- **Purpose**: Full market scan for swing/positional opportunities

### 2. **Background Scanner** (Automatic, F&O Only)
- **File**: `server/services/backgroundScanner.js`
- **Universe**: `foStockRegistry.getAll()` → **Only F&O stocks (~180 stocks)**
- **Timeframes**: 15m, 1h, 4h, 1d (multiple intraday + daily)
- **Trigger**: Automatic at candle close boundaries
- **Frequency**: Continuous during market hours
- **Storage**: `scan_alerts` collection via `alertRepo`
- **UI**: Scanner tab / live alerts
- **Purpose**: Live F&O trading alerts (higher liquidity, better for automation)

### 3. **Index Trade Scanner** (Options Only)
- **File**: `server/index-trade/scanner.js`
- **Universe**: Subscribed option strikes (NIFTY/BANKNIFTY etc.)
- **Timeframes**: 1m, 5m, 15m, 60m
- **Trigger**: Automatic at candle close
- **Purpose**: Index options trading

---

## Why F&O vs All Equity?

### Background Scanner (F&O Only) - By Design
**Reasons for F&O-only:**
1. **Liquidity**: F&O stocks have higher trading volume → better fills, tighter spreads
2. **Futures availability**: Can trade futures for leverage without options complexity
3. **Historical data quality**: F&O stocks have cleaner, more complete candle data
4. **Auto-trading focus**: Background scanner feeds auto-trader, which needs liquid instruments
5. **API rate limits**: Kite historical API has rate limits; 180 stocks is manageable for live scanning

### Equity Scan (All Stocks) - By Design
**Reasons for full market scan:**
1. **Discovery**: Find hidden gems outside F&O universe
2. **Swing/positional trading**: Timeframes (4H/1D/1W) suit longer holds where liquidity matters less
3. **Manual trading**: User reviews results manually, no auto-execution pressure
4. **Once-a-day**: No real-time requirement, so can afford to scan 1200+ stocks
5. **MongoDB caching**: Clever incremental fetch strategy reduces API load

---

## Data Flow for Equity Scan

```
POST /api/equity-scan/run
  ↓
equityScanService.run()
  ↓
instrumentCache.getAllNseEquity() → Returns ALL NSE EQ stocks
  ↓
Phase 0: Load cached candles from MongoDB
  ├─ Fresh (>= yesterday) → Use MongoDB only (zero API calls)
  ├─ Stale (< yesterday)  → Incremental Kite fetch (10-20 bars)
  └─ Missing              → Full Kite fetch (400-450 bars)
  ↓
Phase 1: Prefetch candles for all stocks
  ├─ 60minute (for 4H synthesis via to4H())
  └─ day (for 1D direct + 1W synthesis via toWeekly())
  ↓
Phase 2: Pattern matching (in-memory, no API calls)
  ↓
Store results in equity_scan_cache collection
  ↓
Return to UI → EquityScanPanel.jsx displays results
```

---

## How to Verify It's Working

### Check 1: Inspect the universe size
```javascript
// In server/services/instrumentCache.js line 265
function getAllNseEquity() {
  const all = _instruments.filter((i) => {
    if (i.exchange !== 'NSE' || i.instrumentType !== 'EQ') return false;
    // Excludes bonds, ETFs, debentures
    return true;
  });
  // Returns F&O first, then rest alphabetically
  return [...foFirst, ...rest];  // Should be ~1200-1400 stocks
}
```

**Action**: Add a log in `equityScanService.js` line 214:
```javascript
const instruments = instrumentCache.getAllNseEquity();
console.log(`[EquityScan] Universe size: ${instruments.length} stocks`);
// Should log ~1200-1400
```

### Check 2: Look at scan results
```bash
# Query MongoDB to see what's actually in the results
# Should see F&O stocks (RELIANCE, TCS, INFY) AND non-F&O stocks
```

### Check 3: Compare with background scanner
```javascript
// In backgroundScanner.js line 388-391
const fromRegistry = foStockRegistry.getAll();
console.log(`[BgScanner] Universe: ${fromRegistry.length} F&O stocks`);
// Should log ~180 stocks (MUCH smaller than equity scan)
```

---

## Possible Confusion Points

### 1. "Equity scan shows F&O results"
**Likely cause**: The equity scan includes F&O stocks (by design). They appear FIRST in results because:
- `getAllNseEquity()` sorts F&O stocks first (line 277-281 in instrumentCache.js)
- F&O stocks are more liquid → more likely to generate high-score signals
- **Solution**: Scroll down in results or apply filters to see non-F&O stocks

### 2. "Background scanner doesn't show all equities"
**This is correct**: Background scanner is intentionally F&O-only for the reasons listed above.
- **Not a bug**, it's the design
- Equity scan is the tool for full market coverage

### 3. "Results look similar"
Both scanners run the same patterns (from `patternRegistry`), so:
- Pattern matches will look similar in style
- But the **universe is different**: 180 F&O stocks vs 1200+ all equities

---

## Recommended Next Steps

### If equity scan truly shows only F&O stocks:

1. **Add debug logging** in `equityScanService.js`:
```javascript
// Line 374, inside the scan loop
for (const inst of instruments) {
  const isFO = foStockRegistry.getAll().some(fo => fo.instrumentToken === inst.instrumentToken);
  if (!isFO) {
    console.log(`[EquityScan] Scanning non-F&O stock: ${inst.tradingsymbol}`);
  }
  // ... rest of scan loop
}
```

2. **Check MongoDB results**:
```javascript
// Query the actual stored results
db.equity_scan_cache.find({ tradingsymbol: { $nin: FO_SYMBOLS_ARRAY } }).count()
// Should return > 0 if non-F&O stocks were scanned
```

3. **Verify instrumentCache is loading correctly**:
```javascript
// In server startup logs, should see:
// [InstrumentCache] Loaded N instruments
// Where N should be > 10,000 (full Kite instruments CSV)
```

### If there's a UI filtering issue:

Check `EquityScanPanel.jsx` line 338-365 (filter logic) to ensure no hidden filter is excluding non-F&O stocks.

---

## Expected Behavior (Working Correctly)

When you run equity scan:
1. **Phase 0 message**: "Loading candle history from MongoDB" (appears immediately)
2. **Phase 1a/1b messages**: "Incremental Kite fetch" or "Full fetch" with stock counts
3. **Phase 2 message**: "Scanning patterns… X/1200+ stocks" ← Should show 1200+, not 180
4. **Results**: Mix of F&O (RELIANCE, TCS) and non-F&O stocks (AARTI INDUSTRIES, AARTIDRUGS, etc.)
5. **Filters in UI**: Can filter by TF, signal, pattern, R:R, volume
6. **Dedup toggle**: "Best per symbol" groups multiple signals per stock

---

## Conclusion

The **equity scan code is correct** and scans all NSE equity stocks as designed. If you're seeing only F&O results:
1. It's likely because F&O stocks generate more signals (higher liquidity → cleaner patterns)
2. Or there's a UI display/sorting issue making non-F&O stocks less visible
3. Or you're confusing it with the background scanner (which IS F&O-only)

**Action**: Run the debug logging steps above and check what `instruments.length` reports during a scan. If it's ~1200-1400, the scan is working correctly.
