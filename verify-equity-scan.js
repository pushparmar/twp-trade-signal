#!/usr/bin/env node
/**
 * verify-equity-scan.js
 *
 * Quick verification script to check if equity scan universe includes non-F&O stocks.
 * Run this to diagnose the issue without starting the full server.
 *
 * Usage:
 *   cd server
 *   node ../verify-equity-scan.js
 */

const path = require('path');
process.chdir(path.join(__dirname, 'server'));

const instrumentCache = require('./services/instrumentCache');
const foStockRegistry = require('./services/foStockRegistry');

async function verify() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Equity Scan Universe Verification');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    console.log('1. Loading instrument cache (this may take a few seconds)...');
    await instrumentCache.load();
    console.log('   ✓ Instrument cache loaded\n');

    console.log('2. Getting equity scan universe (getAllNseEquity)...');
    const allEquity = instrumentCache.getAllNseEquity();
    console.log(`   ✓ Found ${allEquity.length} NSE EQ instruments\n`);

    console.log('3. Getting F&O stock registry...');
    const foStocks = foStockRegistry.getAll();
    const foTokens = new Set(foStocks.map(s => Number(s.instrumentToken)));
    console.log(`   ✓ Found ${foStocks.length} F&O stocks\n`);

    console.log('4. Analyzing universe breakdown...');
    const foInUniverse = allEquity.filter(i => foTokens.has(Number(i.instrumentToken)));
    const nonFOInUniverse = allEquity.filter(i => !foTokens.has(Number(i.instrumentToken)));

    console.log('   ┌─────────────────────────────────────────────────────┐');
    console.log(`   │ Total NSE EQ stocks:       ${String(allEquity.length).padStart(6)} stocks │`);
    console.log(`   │ F&O stocks in universe:    ${String(foInUniverse.length).padStart(6)} stocks │`);
    console.log(`   │ Non-F&O stocks in universe: ${String(nonFOInUniverse.length).padStart(6)} stocks │`);
    console.log('   └─────────────────────────────────────────────────────┘\n');

    if (nonFOInUniverse.length === 0) {
      console.log('❌ ISSUE FOUND: No non-F&O stocks in equity scan universe!');
      console.log('   This means getAllNseEquity() is not working as expected.\n');
      console.log('   Possible causes:');
      console.log('   - instrumentCache.load() failed or loaded incomplete data');
      console.log('   - _EQUITY_EXCLUDE patterns are too aggressive');
      console.log('   - Kite instruments CSV is missing non-F&O stocks\n');
    } else {
      console.log('✅ VERIFIED: Non-F&O stocks ARE included in equity scan universe!\n');
      console.log('   Sample non-F&O stocks that will be scanned:');
      nonFOInUniverse.slice(0, 10).forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.tradingsymbol.padEnd(20)} (${s.name || 'N/A'})`);
      });
      console.log(`   ... and ${nonFOInUniverse.length - 10} more non-F&O stocks\n`);

      console.log('   If you\'re not seeing non-F&O results in the UI:');
      console.log('   1. Check that the scan actually runs to completion');
      console.log('   2. Look for non-F&O matches in server logs (search for "✅ Non-F&O match")');
      console.log('   3. Verify UI filters aren\'t hiding non-F&O results');
      console.log('   4. Scroll down in results (F&O stocks sort first by design)\n');
    }

    console.log('5. Checking a few known non-F&O stocks...');
    const testSymbols = ['3MINDIA', 'AARTIIND', 'AARTIDRUGS', 'AAVAS', 'ABBOTINDIA'];
    for (const sym of testSymbols) {
      const found = allEquity.find(i => i.tradingsymbol === sym);
      const isFO = foTokens.has(Number(found?.instrumentToken));
      if (found && !isFO) {
        console.log(`   ✓ ${sym.padEnd(15)} - Found in equity scan universe (non-F&O)`);
      } else if (found && isFO) {
        console.log(`   ℹ ${sym.padEnd(15)} - Found, but it's an F&O stock`);
      } else {
        console.log(`   ✗ ${sym.padEnd(15)} - NOT found (may have been filtered out)`);
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Verification Complete');
    console.log('═══════════════════════════════════════════════════════════\n');

    if (nonFOInUniverse.length > 0) {
      console.log('✅ Equity scan universe is CORRECT - includes both F&O and non-F&O stocks.');
      console.log('   If you\'re not seeing non-F&O results, it\'s a scan execution or UI issue,');
      console.log('   not a universe definition problem.\n');
      process.exit(0);
    } else {
      console.log('❌ Equity scan universe is INCORRECT - only F&O stocks included.');
      console.log('   This needs to be fixed before the scan will work properly.\n');
      process.exit(1);
    }

  } catch (err) {
    console.error('\n❌ Error during verification:', err.message);
    console.error('   Stack trace:', err.stack);
    process.exit(1);
  }
}

verify();
