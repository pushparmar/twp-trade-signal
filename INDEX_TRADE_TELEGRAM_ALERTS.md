# Index Trade Telegram Alerts - Implementation

## Overview

Added Telegram notification support for index option trades. Now you'll receive alerts on Telegram when:
- ✅ Pattern-based trades are executed
- ✅ Low-Premium (LP) trades are executed
- ✅ Trades are closed (SL/TSL/Target/EOD)

## Changes Made

### File Modified: `server/index-trade/orderManager.js`

#### 1. Added Dependencies
```javascript
const telegramNotifier  = require('../services/telegramNotifier');
const store             = require('../store');
```

#### 2. New Functions

##### `_sendTelegramAlert(trade)` - Entry Notifications
Sends alert when a new index trade is opened.

**Message Format:**
```
🟢 INDEX ORDER EXECUTED

Symbol: NIFTY24604CE24000
Action: BUY
Strategy: 5m / LP
Pattern: Kumo Breakout / Low Premium Scalper
Entry: ₹150
SL: ₹130
Target: ₹200
R:R: 2.5
Lots: 1 (50 per lot)
Avg-Down At: ₹8 (LP only)
```

##### `_sendTelegramExitAlert(trade)` - Exit Notifications
Sends alert when a trade is closed.

**Message Format:**
```
🎯 INDEX TRADE CLOSED

Symbol: NIFTY24604CE24000
Strategy: 5m / LP
Entry: ₹150
Exit: ₹200
Reason: TARGET
Lots: 1
💚 PnL: +₹2500
```

**Exit Emojis:**
- 🎯 Target hit
- 🛑 Stop Loss hit
- 📉 Trailing Stop Loss hit
- 🕐 EOD force close

**PnL Colors:**
- 💚 Profit (PnL > 0)
- ❤️ Loss (PnL < 0)
- ⚪ Breakeven (PnL = 0)

#### 3. Integration Points

**Entry Alerts:**
- ✅ Pattern-based trades: After `tradeStore.addTrade()` in `onSignal()`
- ✅ LP trades: After `tradeStore.addTrade()` in `_checkLowPremiumEntry()`

**Exit Alerts:**
- ✅ LP exit: After `tradeStore.closeTrade()` in `_handleLowPremiumTSL()`
- ✅ Pattern exit: After `tradeStore.closeTrade()` in `_handlePatternTSL()`
- ✅ EOD close: After `tradeStore.closeTrade()` in `_checkEodClose()`

## Configuration

### Required Settings

The Telegram bot must be configured in `config.json` (or via UI):

```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  }
}
```

### How to Get These Values

1. **Bot Token:**
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow instructions
   - Copy the bot token

2. **Chat ID:**
   - Send a message to your bot
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find your `chat.id` in the response

## Behavior

### Fire-and-Forget
- Telegram alerts are **non-blocking**
- If Telegram fails, trades still execute normally
- Errors are logged but don't affect trading

### Silent When Not Configured
- If `chatId` is not set → no alerts sent (silently skipped)
- If `botToken` is missing → error logged, trades continue

### Retry Logic
- No automatic retry (fire-and-forget)
- If a message fails, it's logged and skipped
- Check server logs for failures

## Testing

### Manual Test
1. Ensure Telegram is configured in `config.json`
2. Enable index trade module
3. Wait for a pattern signal or LP entry
4. Check Telegram for entry alert
5. Close the trade (manually or wait for exit)
6. Check Telegram for exit alert

### Test Message Format
Example entries to test:

**Pattern Trade:**
```javascript
{
  symbol: 'NIFTY24604CE24000',
  action: 'BUY',
  strategyType: 'pattern',
  tfLabel: '5m',
  patternLabel: 'Kumo Breakout',
  entryPrice: 150,
  sl: 130,
  target: 200,
  rrRatio: 2.5,
  quantity: 1,
  lotSize: 50
}
```

**LP Trade:**
```javascript
{
  symbol: 'BANKNIFTY24604PE50000',
  action: 'BUY',
  strategyType: 'low-premium',
  tfLabel: 'LP',
  patternLabel: 'Low Premium Scalper',
  entryPrice: 8,
  avgDownAt: 4.8,
  sl: 0.5,
  target: 15,
  quantity: 1,
  lotSize: 15
}
```

## Comparison with Equity Trades

| Feature | Equity Trades | Index Trades |
|---------|---------------|--------------|
| Entry Alert | ❌ (only pattern scan alerts) | ✅ Order execution alert |
| Exit Alert | ❌ | ✅ SL/Target/TSL/EOD |
| Strategy Label | Pattern only | Pattern / LP |
| PnL Display | - | ✅ On exit |
| Avg-Down Info | - | ✅ LP only |

## Message Throttling

**None implemented** - Every trade generates alerts:
- Entry alert on open
- Exit alert on close

If you want to reduce noise:
- Set higher quality score threshold
- Reduce LP max positions
- Filter by R:R ratio

## Error Handling

### Common Issues

1. **"Telegram bot token not configured"**
   - Solution: Add `telegram.botToken` to config.json

2. **"Chat ID is required"**
   - Solution: Add `telegram.chatId` to config.json

3. **"Failed to send message"**
   - Check bot token is valid
   - Check chat ID is correct
   - Ensure bot is not blocked
   - Check network connectivity

### Debug Logs

Check server console for:
```
[IdxOrder] Telegram notification failed: <error message>
[IdxOrder] Telegram exit alert failed: <error message>
```

## Future Enhancements

Possible additions:
- [ ] Daily P&L summary at EOD
- [ ] Win rate stats per pattern
- [ ] Alert throttling (max N per hour)
- [ ] Message formatting options (markdown/HTML toggle)
- [ ] Silent mode hours (no alerts during specific times)
- [ ] Alert filters (only target hits, only >₹1000 PnL, etc.)

## Summary

Index option trades now have **full Telegram notification support**:
- ✅ Entry alerts with all trade details
- ✅ Exit alerts with PnL
- ✅ Works for both pattern and LP strategies
- ✅ Fire-and-forget (never blocks trading)
- ✅ Silent when not configured
- ✅ Detailed error logging

No more missing index trade alerts! 🎉
