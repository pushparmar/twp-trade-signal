/**
 * test-index-trade-db.js
 *
 * Quick verification script for index trade database integration.
 * Run this after deploying to verify MongoDB persistence is working.
 *
 * Usage:
 *   node test-index-trade-db.js
 */

require('dotenv').config({ path: '.env' });

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

async function test() {
  console.log('\n🧪 Testing Index Trade Database Integration\n');

  // 1. Connect to MongoDB
  console.log('1️⃣  Connecting to MongoDB...');
  const connected = await db.init();
  if (!connected) {
    console.error('❌ MongoDB connection failed — check MONGODB_URI in .env');
    process.exit(1);
  }
  console.log('✅ Connected\n');

  // 2. Create indexes
  console.log('2️⃣  Creating indexes...');
  await db.indexTradeRepo.createIndexes();
  console.log('✅ Indexes created\n');

  // 3. Insert a test trade
  console.log('3️⃣  Inserting test pattern trade...');
  const testTrade = {
    id: uuidv4(),
    ts: Date.now(),
    source: 'index-trade',
    strategyType: 'pattern',
    index: 'NIFTY',
    symbol: 'NIFTY24604CE24000',
    token: 123456,
    optionType: 'CE',
    strike: 24000,
    exchange: 'NFO',
    action: 'BUY',
    quantity: 1,
    lotSize: 50,
    entryPrice: 150,
    sl: 130,
    initialSl: 130,
    target: 200,
    status: 'OPEN',
    tslActivated: false,
    peakPrice: 150,
    patternId: 'kumo-breakout',
    patternLabel: 'Kumo Breakout',
    signalDirection: 'bullish',
    interval: '5minute',
    tfLabel: '5m',
    score: 4,
    rrRatio: 2.5,
  };

  db.indexTradeRepo.upsertTrade(testTrade);
  console.log(`✅ Inserted trade ${testTrade.id.slice(0, 8)}...\n`);

  // Wait 2s for async write to complete
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 4. Fetch open trades
  console.log('4️⃣  Fetching open trades...');
  const openTrades = await db.indexTradeRepo.getOpenTrades();
  console.log(`✅ Found ${openTrades.length} open trade(s)\n`);

  if (openTrades.length === 0) {
    console.error('❌ Expected at least 1 open trade, got 0');
    await db.close();
    process.exit(1);
  }

  const retrieved = openTrades.find(t => t.id === testTrade.id);
  if (!retrieved) {
    console.error('❌ Test trade not found in open trades');
    await db.close();
    process.exit(1);
  }

  console.log(`   Trade details:`);
  console.log(`   - Symbol: ${retrieved.symbol}`);
  console.log(`   - Pattern: ${retrieved.patternId}`);
  console.log(`   - Entry: ₹${retrieved.entryPrice}`);
  console.log(`   - Status: ${retrieved.status}\n`);

  // 5. Update the trade (simulate TSL activation)
  console.log('5️⃣  Updating trade (TSL activation)...');
  testTrade.tslActivated = true;
  testTrade.peakPrice = 180;
  testTrade.sl = 170;
  db.indexTradeRepo.updateTrade(testTrade);
  console.log('✅ Trade updated\n');

  await new Promise(resolve => setTimeout(resolve, 2000));

  // 6. Close the trade
  console.log('6️⃣  Closing trade...');
  testTrade.exitPrice = 200;
  testTrade.exitReason = 'target';
  testTrade.pnl = (200 - 150) * 1 * 50; // (exitPrice - entryPrice) × quantity × lotSize
  testTrade.status = 'CLOSED';
  testTrade.closedTs = Date.now();

  db.indexTradeRepo.closeTrade(testTrade);
  console.log(`✅ Trade closed with PnL: ₹${testTrade.pnl}\n`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  // 7. Verify trade is closed
  console.log('7️⃣  Verifying closed trades...');
  const recentTrades = await db.indexTradeRepo.getRecentTrades(10);
  const closedTrade = recentTrades.find(t => t.id === testTrade.id);

  if (!closedTrade) {
    console.error('❌ Closed trade not found in recent trades');
    await db.close();
    process.exit(1);
  }

  if (closedTrade.status !== 'CLOSED') {
    console.error(`❌ Expected status CLOSED, got ${closedTrade.status}`);
    await db.close();
    process.exit(1);
  }

  console.log(`✅ Trade successfully closed:`);
  console.log(`   - Status: ${closedTrade.status}`);
  console.log(`   - Exit: ₹${closedTrade.exitPrice}`);
  console.log(`   - PnL: ₹${closedTrade.pnl}`);
  console.log(`   - Reason: ${closedTrade.exitReason}\n`);

  // 8. Test analytics
  console.log('8️⃣  Testing analytics...');

  const cumulativePnl = await db.indexTradeRepo.getCumulativePnl();
  console.log(`✅ Cumulative PnL: ₹${cumulativePnl}`);

  const tradingDates = await db.indexTradeRepo.getTradingDates();
  console.log(`✅ Trading dates: ${tradingDates.length} day(s) with trades`);

  const patternWinRate = await db.indexTradeRepo.patternWinRate();
  console.log(`✅ Pattern analysis: ${patternWinRate.length} pattern(s) tracked\n`);

  // 9. Insert a low-premium test trade
  console.log('9️⃣  Inserting low-premium test trade...');
  const lpTrade = {
    id: uuidv4(),
    ts: Date.now(),
    source: 'index-trade',
    strategyType: 'low-premium',
    index: 'BANKNIFTY',
    symbol: 'BANKNIFTY24604PE50000',
    token: 789012,
    optionType: 'PE',
    strike: 50000,
    exchange: 'NFO',
    action: 'BUY',
    quantity: 1,
    lotSize: 15,
    entryPrice: 8,
    avgPrice: 8,
    lotCount: 1,
    avgDownCount: 0,
    avgDownAt: 4.8,
    sl: 0.5,
    initialSl: 0.5,
    target: 15,
    status: 'OPEN',
    tslActivated: false,
    peakPrice: 8,
    patternId: 'low-premium',
    patternLabel: 'Low Premium Scalper',
    signalDirection: 'bullish',
    interval: 'tick',
    tfLabel: 'LP',
    score: 0,
    rrRatio: 0.93,
  };

  db.indexTradeRepo.upsertTrade(lpTrade);
  console.log(`✅ Inserted LP trade ${lpTrade.id.slice(0, 8)}...\n`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  // 10. Test strategy performance
  console.log('🔟 Testing strategy performance analytics...');
  const strategyPerf = await db.indexTradeRepo.strategyPerformance();
  console.log(`✅ Strategy comparison:`);
  for (const s of strategyPerf) {
    console.log(`   - ${s._id}: ${s.count} trade(s), win rate ${(s.winRate * 100).toFixed(1)}%, total PnL ₹${s.totalPnl?.toFixed(2) ?? 0}`);
  }
  console.log();

  // Cleanup: Close MongoDB connection
  console.log('✅ All tests passed! 🎉\n');
  console.log('Note: Test trades are left in the database for inspection.');
  console.log('To clean up, run: db.index_trades.deleteMany({ symbol: /TEST/ })\n');

  await db.close();
  process.exit(0);
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
