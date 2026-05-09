const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_TRADING = { quantity: 1, exchange: 'NFO', product: 'MIS' };

let _runtimeAccessToken = '';

function _loadPersistedToken() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    _runtimeAccessToken = data.kiteAccessToken || process.env.KITE_ACCESS_TOKEN || '';
  } catch {
    _runtimeAccessToken = process.env.KITE_ACCESS_TOKEN || '';
  }
}
_loadPersistedToken();

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getConfig() {
  return {
    kite: {
      apiKey: process.env.KITE_API_KEY || '',
      apiSecret: process.env.KITE_API_SECRET || '',
      accessToken: _runtimeAccessToken,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    },
  };
}

function setAccessToken(token) {
  _runtimeAccessToken = token;
  const config = readConfig();
  config.kiteAccessToken = token;
  writeConfig(config);
}

// ── Trading defaults (persisted) ─────────────────────
function getTradingDefaults() {
  const config = readConfig();
  return { ...DEFAULT_TRADING, ...(config.tradingDefaults || {}) };
}

function setTradingDefaults(updates) {
  const config = readConfig();
  config.tradingDefaults = { ...getTradingDefaults(), ...updates };
  writeConfig(config);
  return config.tradingDefaults;
}

// ── Test / Paper trading ─────────────────────────────
let _testMode = false;
let _paperTrades = [];
let _paperInitialBalance = 100000;

function getTestMode() { return _testMode; }
function setTestMode(enabled) { _testMode = enabled; }

function getPaperInitialBalance() { return _paperInitialBalance; }
function setPaperInitialBalance(amount) { _paperInitialBalance = amount; }

function getPaperBalance() {
  const invested = _paperTrades
    .filter((t) => t.status === 'OPEN')
    .reduce((sum, t) => sum + t.entryPrice * t.quantity, 0);
  const realizedPnl = _paperTrades
    .filter((t) => t.status === 'CLOSED')
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  return {
    initial: _paperInitialBalance,
    available: Math.round((_paperInitialBalance - invested + realizedPnl) * 100) / 100,
    invested: Math.round(invested * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
  };
}

function addPaperTrade(trade) {
  _paperTrades.unshift(trade);
  if (_paperTrades.length > 200) _paperTrades.pop();
}

function closePaperTrade(id, exitPrice) {
  const trade = _paperTrades.find((t) => t.id === id);
  if (!trade || trade.status !== 'OPEN') return null;
  const pnl = trade.action === 'BUY'
    ? (exitPrice - trade.entryPrice) * trade.quantity
    : (trade.entryPrice - exitPrice) * trade.quantity;
  trade.status = 'CLOSED';
  trade.exitPrice = exitPrice;
  trade.pnl = Math.round(pnl * 100) / 100;
  trade.closedTs = Date.now();
  return trade;
}

function autoClosePaperTrades(symbol, exitPrice, exitAction) {
  const entryAction = exitAction === 'SELL' ? 'BUY' : 'SELL';
  return _paperTrades
    .filter((t) => t.status === 'OPEN' && t.symbol === symbol && t.action === entryAction)
    .map((t) => closePaperTrade(t.id, exitPrice))
    .filter(Boolean);
}

function getPaperTrades() { return _paperTrades; }
function clearPaperTrades() { _paperTrades = []; }

// ── Watchlist (persisted) ────────────────────────────
function getWatchlist() {
  const config = readConfig();
  return config.watchlist || [];
}

function setWatchlist(items) {
  const config = readConfig();
  config.watchlist = items;
  writeConfig(config);
}

function addToWatchlist(item) {
  const list = getWatchlist();
  if (list.find((i) => i.instrumentToken === item.instrumentToken)) return list;
  const updated = [...list, item];
  setWatchlist(updated);
  return updated;
}

function removeFromWatchlist(instrumentToken) {
  const updated = getWatchlist().filter((i) => i.instrumentToken !== Number(instrumentToken));
  setWatchlist(updated);
  return updated;
}

module.exports = {
  getConfig, setAccessToken,
  getTradingDefaults, setTradingDefaults,
  getTestMode, setTestMode,
  addPaperTrade, closePaperTrade, autoClosePaperTrades, getPaperTrades, clearPaperTrades,
  getPaperBalance, setPaperInitialBalance, getPaperInitialBalance,
  getWatchlist, setWatchlist, addToWatchlist, removeFromWatchlist,
};
