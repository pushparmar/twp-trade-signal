/**
 * tradeStore.js — Index Trade module
 *
 * In-memory trade state with fire-and-forget MongoDB persistence.
 * Completely independent from the main app's store.js / tradeRepo.
 *
 * MongoDB collection: index_trades (separate from paper_trades)
 */

const { v4: uuidv4 } = require('uuid');
const mongo = require('../services/mongoClient');

const COLLECTION = 'index_trades';
const CONFIG_COLLECTION = 'settings'; // reuse existing settings collection

// ── In-memory state ─────────────────────────────────────────────────────────

let _trades = [];
let _config = {
  enabled: true,
  lotQuantity: 1,        // number of lots per trade
  tslEnabled: true,
  tslTriggerR: 1.0,      // activate TSL at 1× risk profit
  tslDistanceR: 0.5,     // trail 0.5× risk behind peak
  minRR: 1.5,            // minimum reward:risk ratio

  // ── RSI Filter ───────────────────────────────────────────────────────────────
  // When enabled, signals/trades whose RSI falls outside the configured window
  // are skipped at the chosen gate(s).
  //   rsiFilterScan  — blocks the signal from appearing in the feed & alert history
  //   rsiFilterOrder — blocks order placement (pattern trades + LP entries)
  rsiFilterEnabled:  false,
  rsiFilterScan:     true,   // gate: scan history + SSE broadcast
  rsiFilterOrder:    true,   // gate: order execution
  rsiBullishMin:     50,     // BUY: RSI must be ≥ this
  rsiBullishMax:     65,     // BUY: RSI must be ≤ this
  rsiBearishMin:     35,     // SELL (future): RSI must be ≥ this
  rsiBearishMax:     50,     // SELL (future): RSI must be ≤ this

  // ── Trading time window (IST) ────────────────────────────────────────────────
  // No new entries (pattern OR LP) are placed outside this window.
  // Format: 'HH:MM' in 24-hour IST.
  tradeStartHHMM: '09:20',   // earliest entry — first 5 min of session skipped
  tradeEndHHMM:   '15:15',   // last entry cutoff — 15 min before close
  eodCloseHHMM:   '15:25',   // force-close ALL open positions at this time (EOD)

  // ── Low Premium Scalper strategy ────────────────────────────────────────────
  // Buys any subscribed option in the lpEntryMin–lpEntryMax range.
  // Averages down once when price drops lpAvgDownPct from entry.
  // Max lpMaxPositions concurrent LP trades at any time.
  lowPremiumEnabled: false,  // off by default; enable via UI config panel
  lpEntryMin: 5,             // BUY only if LTP ≥ this (₹) — avoid dead options
  lpEntryMax: 10,            // BUY only if LTP ≤ this (₹)
  lpTarget: 15,              // hard exit target (₹)
  lpTslTrigger: 12,          // activate TSL when LTP reaches this price (₹)
  lpTslInitialSl: 8,         // SL jumps to this value when TSL first activates (₹)
  lpTslTrailPct: 0.70,       // SL trails at 70% of peak (30% max drawdown from peak)
  lpAvgDownPct: 0.60,        // avg-down when price drops this % from entry (0.60 = 60%)
  lpAvgDownSlPct: 0.50,      // after avg-down: SL = avgDownPrice × this (e.g. 0.50 = 50% of avg-down price)
  lpMaxPositions: 4,         // max concurrent LP trades (initial + avg-down slots)
};

// ── MongoDB helpers (fire-and-forget) ────────────────────────────────────────

function _col() {
  return mongo.isReady() ? mongo.db().collection(COLLECTION) : null;
}

function _upsertToMongo(trade) {
  const col = _col();
  if (!col) return;
  col.updateOne(
    { tradeId: trade.id },
    { $set: { ...trade, tradeId: trade.id, updatedAt: new Date() } },
    { upsert: true },
  ).catch(err => console.warn('[IdxTradeStore] upsert failed:', err.message));
}

async function createIndexes() {
  const col = _col();
  if (!col) return;
  try {
    await col.createIndex({ tradeId: 1 }, { unique: true });
    await col.createIndex({ status: 1 });
    await col.createIndex({ index: 1 });
    await col.createIndex({ ts: -1 });
    console.log(`[IdxTradeStore] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[IdxTradeStore] createIndexes failed:', err.message);
  }
}

// ── Boot: restore from MongoDB ──────────────────────────────────────────────

async function restore() {
  const col = _col();
  if (!col) return;
  try {
    // Restore OPEN trades so they resume SL/Target monitoring
    const openTrades = await col.find({ status: 'OPEN' }).toArray();
    if (openTrades.length > 0) {
      for (const doc of openTrades) {
        // Avoid duplicates if already in memory
        if (!_trades.find(t => t.id === doc.tradeId)) {
          _trades.push({ ...doc, id: doc.tradeId });
        }
      }
      console.log(`[IdxTradeStore] Restored ${openTrades.length} open trade(s) from MongoDB`);
    }

    // Load config
    const settingsCol = mongo.db().collection(CONFIG_COLLECTION);
    const configDoc = await settingsCol.findOne({ key: 'indexTradeConfig' });
    if (configDoc?.value && typeof configDoc.value === 'object') {
      _config = { ..._config, ...configDoc.value };
      console.log('[IdxTradeStore] Loaded config from MongoDB');
    }
  } catch (err) {
    console.warn('[IdxTradeStore] restore failed:', err.message);
  }
}

// ── Trade CRUD ──────────────────────────────────────────────────────────────

function addTrade(tradeData) {
  const trade = {
    id: uuidv4(),
    ts: Date.now(),
    status: 'OPEN',
    pnl: null,
    exitPrice: null,
    exitReason: null,
    closedTs: null,
    tslActivated: false,
    peakPrice: tradeData.entryPrice,
    ...tradeData,
  };
  _trades.unshift(trade);
  if (_trades.length > 500) _trades.pop();
  _upsertToMongo(trade);
  return trade;
}

function closeTrade(id, exitPrice, exitReason = 'manual') {
  const trade = _trades.find(t => t.id === id);
  if (!trade || trade.status !== 'OPEN') return null;

  const lotSize = trade.lotSize || 1;
  const qty     = trade.quantity || 1;

  // For LP avg-down trades: use lotCount (total lots after averaging) and
  // avgPrice (weighted average entry) so PnL is accurate.
  const totalLots    = trade.lotCount ?? qty;
  const effectiveEntry = trade.avgPrice ?? trade.entryPrice;

  const pnl = trade.action === 'BUY'
    ? (exitPrice - effectiveEntry) * totalLots * lotSize
    : (effectiveEntry - exitPrice) * totalLots * lotSize;

  trade.status = 'CLOSED';
  trade.exitPrice = exitPrice;
  trade.pnl = Math.round(pnl * 100) / 100;
  trade.exitReason = exitReason;
  trade.closedTs = Date.now();

  _upsertToMongo(trade);
  return trade;
}

function updateTrade(id, fields) {
  const trade = _trades.find(t => t.id === id);
  if (!trade || trade.status !== 'OPEN') return null;
  // avgPrice / lotCount / avgDownCount / avgDownAt — updated on LP avg-down
  const allowed = ['sl', 'peakPrice', 'tslActivated', 'avgPrice', 'lotCount', 'avgDownCount', 'avgDownAt'];
  for (const k of allowed) {
    if (fields[k] !== undefined) trade[k] = fields[k];
  }
  _upsertToMongo(trade);
  return trade;
}

// ── Queries ─────────────────────────────────────────────────────────────────

function getOpenTrades()   { return _trades.filter(t => t.status === 'OPEN'); }
function getClosedTrades() { return _trades.filter(t => t.status === 'CLOSED'); }
function getAllTrades()     { return _trades; }
function getTrade(id)      { return _trades.find(t => t.id === id) || null; }

function getPnlSummary() {
  // All stats are scoped to today (IST) so the summary resets each trading day.
  // Historical trades remain in MongoDB for reporting; in-memory is today-only.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

  const todayClosed = getClosedTrades().filter(t => {
    if (!t.closedTs) return false;
    return new Date(t.closedTs + IST_OFFSET_MS).toISOString().slice(0, 10) === todayIST;
  });

  const wins      = todayClosed.filter(t => t.pnl > 0);
  const losses    = todayClosed.filter(t => t.pnl <= 0);
  const totalPnl  = todayClosed.reduce((sum, t) => sum + (t.pnl || 0), 0);

  return {
    totalPnl:    Math.round(totalPnl * 100) / 100,
    todayPnl:    Math.round(totalPnl * 100) / 100,  // same — kept for UI compat
    winCount:    wins.length,
    lossCount:   losses.length,
    winRate:     todayClosed.length > 0 ? Math.round((wins.length / todayClosed.length) * 100) : 0,
    openCount:   getOpenTrades().length,
    totalTrades: todayClosed.length,
  };
}

/**
 * Drop closed trades from previous days out of the in-memory _trades array.
 * Open trades are always retained. Called each morning so memory stays lean
 * and getPnlSummary() starts fresh without waiting for a server restart.
 */
function purgePreviousDayTrades() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

  const before = _trades.length;
  _trades = _trades.filter(t => {
    if (t.status !== 'CLOSED') return true; // keep open trades
    if (!t.closedTs) return false;
    return new Date(t.closedTs + IST_OFFSET_MS).toISOString().slice(0, 10) === todayIST;
  });

  const purged = before - _trades.length;
  if (purged > 0) {
    console.log(`[IdxTradeStore] Morning reset: purged ${purged} previous-day closed trade(s) from memory`);
  }
}

function clearTrades() {
  _trades = [];
  const col = _col();
  if (col) col.deleteMany({}).catch(() => {});
}

// ── Config ──────────────────────────────────────────────────────────────────

function getConfig() { return { ..._config }; }

function setConfig(updates) {
  _config = { ..._config, ...updates };
  // Persist to MongoDB
  if (mongo.isReady()) {
    mongo.db().collection(CONFIG_COLLECTION).updateOne(
      { key: 'indexTradeConfig' },
      { $set: { key: 'indexTradeConfig', value: _config, updatedAt: new Date() } },
      { upsert: true },
    ).catch(() => {});
  }
  return _config;
}

module.exports = {
  createIndexes, restore,
  addTrade, closeTrade, updateTrade,
  getOpenTrades, getClosedTrades, getAllTrades, getTrade,
  getPnlSummary, clearTrades, purgePreviousDayTrades,
  getConfig, setConfig,
};
