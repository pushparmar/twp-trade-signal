# How to Debug and Verify Equity Scan

## Summary

I've added debug logging to verify that the equity scan is working correctly and scanning **ALL NSE equity stocks**, not just F&O stocks.

---

## What I Found

After deep analysis of your codebase, I discovered:

### ✅ **The Code is Correct**

The equity scan (`server/services/equityScanService.js`) **IS designed to scan ALL NSE equity stocks**:
- Line 214: `instrumentCache.getAllNseEquity()` returns ~1200-1400 stocks
- This includes both F&O stocks (~180) AND non-F&O stocks (~1000-1200)

### 🤔 **Why You Might Think It's Only F&O**

There are **3 different scanners** in your system, and you may be confusing them:

1. **Equity Scan** (Full Market, On-Demand)
   - File: `server/services/equityScanService.js`
   - Universe: **ALL ~1200-1400 NSE EQ stocks** ✅
   - Timeframes: 4H, 1D, 1W
   - Trigger: Manual button click
   - UI: "Equity Scan" panel in Manage Stocks tab

2. **Background Scanner** (F&O Only, Automatic)
   - File: `server/services/backgroundScanner.js`
   - Universe: **Only ~180 F&O stocks** (by design)
   - Timeframes: 15m, 1h, 4h, 1d
   - Trigger: Automatic at candle close
   - UI: Scanner tab, live alerts

3. **Index Trade Scanner** (Options Only)
   - File: `server/index-trade/scanner.js`
   - Universe: NIFTY/BANKNIFTY option strikes
   - Timeframes: 1m, 5m, 15m, 60m

### 💡 **Why F&O Stocks Appear First**

In equity scan results, F&O stocks appear first because:
1. `getAllNseEquity()` sorts F&O stocks first (they're more liquid)
2. F&O stocks generate higher-quality signals (better candle data)
3. Your UI might be filtering or only showing top results

**This doesn't mean non-F&O stocks aren't scanned** — they are! They just appear later in the list or score lower.

---

## Debug Changes I Made

I added comprehensive logging to `equityScanService.js`:

### 1. Universe Breakdown (at scan start)
```javascript
// Now logs:
[EquityScan] Universe breakdown:
  - Total stocks: 1234
  - F&O stocks: 180
  - Non-F&O stocks: 1054
  - Scanning 8 patterns across 3 timeframes
```

### 2. Non-F&O Match Logging (during scan)
```javascript
// Logs every time a non-F&O stock generates a signal:
[EquityScan] ✅ Non-F&O match: AARTIIND (4H) bullish tk-reversion
[EquityScan] ✅ Non-F&O match: AARTIDRUGS (1D) bearish kijun-bounce
```

### 3. Signal Breakdown (at scan end)
```javascript
// Now logs:
[EquityScan] Signal breakdown: 45 F&O signals, 23 non-F&O signals
```

---

## How to Verify

### Step 1: Restart the server
```bash
cd server
npm run dev  # or however you start the server
```

### Step 2: Trigger an equity scan
1. Open the app in browser
2. Go to "Manage Stocks" or "Equity Scan" tab
3. Click "▶ Run Full Equity Scan" button

### Step 3: Watch the server logs
You should see output like:
```
[EquityScan] Starting full equity scan for 2026-06-02
[EquityScan] Universe breakdown:
  - Total stocks: 1234      ← Should be ~1200-1400, NOT 180
  - F&O stocks: 180
  - Non-F&O stocks: 1054    ← This proves non-F&O are included
  - Scanning 8 patterns across 3 timeframes
[EquityScan] Phase 0: loading candle history from MongoDB…
[EquityScan] Phase 0: 523 fresh (MongoDB), 234 stale (incremental), 477 missing (full fetch)
[EquityScan] Phase 1a: incremental Kite fetch for 234 stale instruments…
[EquityScan] Phase 1b: full Kite fetch for 477 instruments…
[EquityScan] Starting pattern scan on 1234 instruments…
[EquityScan] ✅ Non-F&O match: AARTIIND (4H) bullish tk-reversion
[EquityScan] ✅ Non-F&O match: AARTIDRUGS (1D) bearish kijun-bounce
…
[EquityScan] Done — scanned 3702 instrument×intervals, found 68 signals
[EquityScan] Signal breakdown: 45 F&O signals, 23 non-F&O signals
```

---

## Expected Results

### ✅ If Working Correctly:
- **Total stocks**: ~1200-1400 (shown at scan start)
- **Non-F&O count**: > 0 (should be ~1000+)
- **Non-F&O matches logged**: You'll see some non-F&O stock names in logs
- **Results in UI**: Mix of F&O and non-F&O stocks (scroll down or filter)

### ❌ If Actually Broken:
- **Total stocks**: 180 (only F&O count)
- **Non-F&O count**: 0
- **No non-F&O match logs**: Zero `✅ Non-F&O match` lines
- **Signal breakdown**: "45 F&O signals, 0 non-F&O signals"

---

## If It Shows Only F&O Stocks

If the logs show `Total stocks: 180` or `Non-F&O stocks: 0`, then there's an actual bug. Possible causes:

### 1. InstrumentCache not loaded properly
Check server startup logs for:
```
[InstrumentCache] Loaded N instruments
```
If N < 10,000, the full instruments CSV didn't load.

**Fix**: Ensure Kite API credentials are valid and `instruments.csv` downloads on startup.

### 2. Filter regex too aggressive
Check `instrumentCache.js` lines 251-254:
```javascript
const _EQUITY_EXCLUDE_NAME = /GOI|LOAN|BOND|DEBENTURE|NCD|SERIES[- ]|REIT|INVIT|SGB/i;
const _EQUITY_EXCLUDE_SYM  = /^(NIFTY|SGB|LIQUIDBEES|…)/i;
```
If these regexes are too broad, they might exclude valid stocks.

**Fix**: Test with a known non-F&O stock symbol (e.g., "3MINDIA") to see if it passes filters.

### 3. getAllNseEquity() logic bug
Inspect the function manually:
```bash
cd server
node -e "
const ic = require('./services/instrumentCache');
(async () => {
  await ic.load();
  const all = ic.getAllNseEquity();
  console.log('Total:', all.length);
  console.log('Sample non-F&O:', all.find(i => i.tradingsymbol === '3MINDIA'));
})();
"
```

---

## Possible UI Filtering Issues

Even if the scan works, the **UI might not show** non-F&O results if:

1. **Only showing top N results** (e.g., top 100 by score)
   - F&O stocks score higher → fill the top slots
   - **Fix**: Remove result limits or add pagination

2. **Hidden filter active** (e.g., "F&O only" checkbox)
   - Check `EquityScanPanel.jsx` filter logic (lines 338-365)
   - **Fix**: Verify no `exchange` or `isFO` filter is active

3. **Sorting by score** (F&O first)
   - Line 363: `list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))`
   - Non-F&O stocks might have lower scores and appear at the bottom
   - **Fix**: Scroll down in results or sort by symbol instead

---

## Next Steps

1. **Run the scan** with the new debug logging
2. **Check the logs** for the universe breakdown
3. **Share the logs** with me if you still see only F&O stocks

If the logs show `Total stocks: 1200+` but you only see F&O results in the UI, then it's a **display/filtering issue**, not a scan issue.

---

## Comparison: Equity Scan vs Background Scanner

| Feature | Equity Scan | Background Scanner |
|---------|-------------|-------------------|
| **File** | `equityScanService.js` | `backgroundScanner.js` |
| **Universe** | ALL ~1200 NSE EQ | Only ~180 F&O stocks |
| **Purpose** | Full market discovery | Live F&O trading alerts |
| **Trigger** | Manual button | Auto at candle close |
| **Timeframes** | 4H, 1D, 1W | 15m, 1h, 4h, 1d |
| **Frequency** | Once per day | Continuous |
| **Storage** | `equity_scan_cache` | `scan_alerts` |
| **UI** | Equity Scan panel | Scanner tab |

**Important**: Don't confuse the two! Background scanner is **intentionally F&O-only** for liquidity and auto-trading reasons.

---

## Conclusion

Based on my code analysis, the equity scan **should be working correctly** and scanning all NSE equity stocks. The debug logging I added will prove this when you run it.

If you're still seeing only F&O results after checking the logs, share the log output and I'll investigate further.
