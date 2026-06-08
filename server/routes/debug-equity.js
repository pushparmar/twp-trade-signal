/**
 * debug-equity.js
 *
 * Debug endpoint to verify equity scan is getting all NSE + BSE stocks
 */

const express = require('express');
const instrumentCache = require('../services/instrumentCache');
const foStockRegistry = require('../services/foStockRegistry');

const router = express.Router();

// Get full equity universe breakdown
router.get('/equity-universe', (req, res) => {
  try {
    const allEquity = instrumentCache.getAllEquity();
    const foStocks = foStockRegistry.getAll();
    const foTokens = new Set(foStocks.map(s => Number(s.instrumentToken)));

    const nseStocks = allEquity.filter(i => i.exchange === 'NSE');
    const bseStocks = allEquity.filter(i => i.exchange === 'BSE');
    const foList = allEquity.filter(i => foTokens.has(Number(i.instrumentToken)));
    const nonFoList = allEquity.filter(i => !foTokens.has(Number(i.instrumentToken)));

    // Sample stocks from different categories
    const foSample = foList.slice(0, 10).map(i => ({
      token: i.instrumentToken,
      symbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange
    }));

    const nonFoNseSample = nonFoList.filter(i => i.exchange === 'NSE').slice(0, 10).map(i => ({
      token: i.instrumentToken,
      symbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange
    }));

    const bseSample = bseStocks.slice(0, 10).map(i => ({
      token: i.instrumentToken,
      symbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange
    }));

    res.json({
      total: allEquity.length,
      breakdown: {
        'NSE stocks': nseStocks.length,
        'BSE stocks': bseStocks.length,
        'F&O stocks': foList.length,
        'Non-F&O stocks': nonFoList.length,
        'Total': allEquity.length
      },
      samples: {
        foStocks: foSample,
        nonFoNseStocks: nonFoNseSample,
        bseStocks: bseSample
      },
      message: allEquity.length > 500
        ? `✅ All ${allEquity.length} equity stocks included (${nseStocks.length} NSE + ${bseStocks.length} BSE)`
        : `⚠️ Only ${allEquity.length} stocks found - check instrumentCache`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full list of all equity instruments (for verification)
router.get('/equity-list', (req, res) => {
  try {
    const allEquity = instrumentCache.getAllEquity();
    const foStocks = foStockRegistry.getAll();
    const foTokens = new Set(foStocks.map(s => Number(s.instrumentToken)));

    const list = allEquity.map(i => ({
      token: i.instrumentToken,
      symbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange,
      isFO: foTokens.has(Number(i.instrumentToken))
    }));

    res.json({
      count: list.length,
      instruments: list
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
