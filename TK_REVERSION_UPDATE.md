# TK Reversion Pattern - Updated Logic

## Overview

The TK Reversion pattern has been updated to use a **wick rejection confirmation** strategy instead of a simple Tenkan cross. This provides higher-conviction entry signals with more precise stop-loss placement.

## Changes Summary

### Old Logic (Before)
1. Price crosses Tenkan line moving toward Kijun
2. Entry = current candle close
3. SL = recent swing high/low beyond Tenkan
4. Pattern fires on the cross event itself

### New Logic (After)
1. **Setup:** Latest candle closes inside the Tenkan-Kijun gap
2. **Confirmation:** Within the next 2 candles, find a wick rejection:
   - **Bullish:** Low wicks below Tenkan, close stays above Tenkan
   - **Bearish:** High wicks above Tenkan, close stays below Tenkan
3. **Entry:** Tenkan line value (not candle close)
4. **SL:** Below wick low (bullish) / Above wick high (bearish)
5. **Target:** Kijun (unchanged)

## Detailed Logic

### Bullish Setup (Kijun > Tenkan)
```
Step 1: Latest candle closes between Tenkan and Kijun
        Tenkan < close < Kijun ✓

Step 2: Check current candle + 1 past candle for rejection:
        - Candle LOW goes below Tenkan (wick down)
        - Candle CLOSE stays above Tenkan (rejection)

Step 3: Entry = Tenkan line value

Step 4: SL = wick low - buffer

Step 5: Target = closer of Kijun or cloud bottom
```

### Bearish Setup (Tenkan > Kijun)
```
Step 1: Latest candle closes between Kijun and Tenkan
        Kijun < close < Tenkan ✓

Step 2: Check current candle + 1 past candle for rejection:
        - Candle HIGH goes above Tenkan (wick up)
        - Candle CLOSE stays below Tenkan (rejection)

Step 3: Entry = Tenkan line value

Step 4: SL = wick high + buffer

Step 5: Target = closer of Kijun or cloud top
```

## Implementation Changes

### 1. `ichimoku.js` - `getTKReversion()` function

**Changed:**
- Removed old lookback loop (was scanning past 3 bars)
- Now checks only the latest candle for "inside TK gap" setup
- Searches current + 1 past candle for wick rejection confirmation
- Returns entry at Tenkan line instead of candle close
- Returns SL at wick extreme instead of recent swing

**New Return Fields:**
```javascript
{
  matched: true,
  signal: 'bullish' | 'bearish',
  close: tenkan,              // Entry at Tenkan (not candle close)
  slPrice: wickLow | wickHigh, // SL at wick extreme
  wickLow: number,             // Bullish wick low
  wickHigh: number,            // Bearish wick high
  wickCandleIdx: number,       // Index of wick rejection candle
  tenkan: number,
  kijun: number,
  score: 0-5,
  // ... other fields
}
```

### 2. `patternRegistry.js` - TK Reversion pattern entry

**Changed:**
- Removed complex SL calculation (recent swing + ATR floor/ceiling)
- Now uses `result.slPrice` directly (wick extreme)
- Entry uses `result.close` (which is now Tenkan, not candle close)
- Added small buffer to SL for safety (0.3% or 0.15×ATR)
- Target calculation unchanged (closer of Kijun or cloud edge)

**Simplified Logic:**
```javascript
const close = result.close;        // Entry at Tenkan line
const sl = result.slPrice;         // SL at wick extreme

// Apply small buffer
const slWithBuffer = signal === 'bullish'
  ? sl - Math.max(pctBuf, atrBuf)
  : sl + Math.max(pctBuf, atrBuf);
```

## Scoring Changes

**New Scoring (0-5):**
- Base: 3 points (wide spread + wick rejection confirmed)
- +1: Spread ≥ 2× minimum (1.0%)
- +1: Spread ≥ 3× minimum (1.5%)
- +1: Wick size ≥ 0.5% of price (meaningful rejection)
- +1: Cloud agreement (bullish above cloud, bearish below cloud)

**Old Scoring:**
- Base: 2 points
- +1/+1: Wider spread
- +1: Strong body ratio
- +1: Cloud agreement

## Benefits

### 1. Higher Conviction Entry
- Wick rejection shows that Tenkan is acting as support/resistance
- Buyers/sellers stepped in at the Tenkan level (proven demand/supply)
- False breakouts are filtered out

### 2. Tighter Stop Loss
- SL at the wick extreme is more precise
- Closer stop = better risk:reward ratio
- No need for arbitrary "recent swing" lookback

### 3. Cleaner Entry Price
- Entry at Tenkan (structural level) instead of arbitrary candle close
- Easier to manage and explain
- Aligns with Ichimoku philosophy (Tenkan as dynamic S/R)

### 4. Fewer False Signals
- Requires actual rejection, not just a cross
- Two-candle confirmation window prevents noise
- Must close inside gap first (setup phase)

## Example

### Bullish Scenario

```
Price Action:
Bar -3: Close = 105 (outside TK gap)
Bar -2: Close = 103 (inside TK gap) ← SETUP
        Tenkan = 100
        Kijun = 110
        
Bar -1: High = 104, Low = 98, Close = 102 ← WICK REJECTION
        Tenkan = 100
        Low wicked to 98 (below Tenkan 100) ✓
        Close stayed at 102 (above Tenkan 100) ✓

Signal: BULLISH
Entry: 100 (Tenkan)
SL: 98 - buffer = 97.5
Target: 110 (Kijun)
Risk: 2.5 points
Reward: 10 points
R:R = 4:1 ✓
```

### Bearish Scenario

```
Price Action:
Bar -3: Close = 95 (outside TK gap)
Bar -2: Close = 102 (inside TK gap) ← SETUP
        Tenkan = 105
        Kijun = 100
        
Bar -1: High = 107, Low = 101, Close = 103 ← WICK REJECTION
        Tenkan = 105
        High wicked to 107 (above Tenkan 105) ✓
        Close stayed at 103 (below Tenkan 105) ✓

Signal: BEARISH
Entry: 105 (Tenkan)
SL: 107 + buffer = 107.5
Target: 100 (Kijun)
Risk: 2.5 points
Reward: 5 points
R:R = 2:1 ✓
```

## Testing Checklist

- [ ] Pattern fires only when latest candle closes inside TK gap
- [ ] Wick rejection is found within 2 candles
- [ ] Entry price = Tenkan line
- [ ] SL = wick extreme (+ buffer)
- [ ] Target = Kijun or cloud edge (closer one)
- [ ] Score reflects wick size and cloud position
- [ ] No false signals on simple Tenkan crosses
- [ ] Works on all timeframes (15m, 1h, 4h, daily)

## Backward Compatibility

### Breaking Changes
- ❌ Old trades using "recent swing" SL will not match new logic
- ❌ Entry prices will differ (Tenkan vs candle close)

### Migration
- New logic applies immediately on deployment
- No database migration needed
- Old pattern history in MongoDB remains unchanged
- New signals will use updated logic from deployment time forward

## Performance Impact

- **Computation:** Slightly faster (no 10-bar swing search)
- **Signal Frequency:** Lower (wick confirmation is stricter)
- **Win Rate:** Expected to improve (higher conviction entries)
- **Average R:R:** Expected to improve (tighter SL)

## Related Patterns

The wick rejection logic is unique to TK Reversion and does NOT affect:
- Kumo Breakout
- Kijun Bounce
- Cloud Support
- Senkou Cross
- Other Ichimoku patterns

## Configuration

Pattern remains configurable via `defaultOpts`:
```javascript
{
  lookback: 3,           // Not used in new logic (kept for compatibility)
  minSpreadPct: 0.5,     // Minimum TK spread % required (unchanged)
  spreadLookback: 10,    // Verify spread is near peak (unchanged)
}
```

## Summary

The updated TK Reversion pattern provides:
- ✅ Higher conviction entries (wick rejection confirmation)
- ✅ Tighter stop losses (wick extreme, not recent swing)
- ✅ Cleaner entry price (Tenkan line, not candle close)
- ✅ Better R:R ratios (tighter SL = more reward per unit risk)
- ✅ Fewer false signals (requires actual rejection proof)

The changes align with classic support/resistance trading principles while maintaining the Ichimoku framework's structural logic.
