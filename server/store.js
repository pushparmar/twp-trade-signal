const fs = require('fs');
const path = require('path');

// Use Railway persistent volume if available, otherwise fall back to local file.
// On Railway: add a Volume mounted at /data in the dashboard.
const CONFIG_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'config.json')
  : path.join(__dirname, 'config.json');

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
  // Read persisted config so the bot token saved via the UI (config.json) works
  // even when TELEGRAM_BOT_TOKEN env var is not set (typical local/dev usage).
  const persisted = readConfig();
  return {
    kite: {
      apiKey: process.env.KITE_API_KEY || '',
      apiSecret: process.env.KITE_API_SECRET || '',
      accessToken: _runtimeAccessToken,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || persisted.telegram?.botToken || '',
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

// ── Telegram bot token (persisted) ───────────────────
function getTelegramBotToken() {
  const config = readConfig();
  return process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '';
}

function setTelegramBotToken(token) {
  const config = readConfig();
  config.telegram = { ...(config.telegram || {}), botToken: String(token).trim() };
  writeConfig(config);
  return config.telegram.botToken;
}

// ── Telegram alert target chat ID (persisted) ────────
function getTelegramChatId() {
  const config = readConfig();
  return config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '';
}

function setTelegramChatId(chatId) {
  const config = readConfig();
  config.telegramChatId = String(chatId).trim();
  writeConfig(config);
  return config.telegramChatId;
}

// ── Test / Paper trading ─────────────────────────────

// Write-through path for paper trades — survives server restarts.
// On Railway: stored under DATA_DIR persistent volume.
const TRADES_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'trades-current.json')
  : path.join(__dirname, 'data', 'trades-current.json');

let _testMode = false;
let _paperTrades = [];
// Default starting balance: ₹1 crore (1,00,00,000)
let _paperInitialBalance = 10_000_000;

// Persist current trades to disk after every mutation.
function _saveTrades() {
  try {
    fs.writeFileSync(TRADES_PATH, JSON.stringify(_paperTrades, null, 2), 'utf8');
  } catch (err) {
    console.warn('[store] Failed to persist trades:', err.message);
  }
}

// Load trades from the previous session on module boot.
;(function _loadTrades() {
  try {
    if (fs.existsSync(TRADES_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
      if (Array.isArray(loaded)) {
        _paperTrades = loaded;
        console.log(`[store] Loaded ${_paperTrades.length} paper trades from disk`);
      }
    }
  } catch (err) {
    console.warn('[store] Could not load trades from disk:', err.message);
  }
}());

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
  _saveTrades();
}

/**
 * Update fields on an OPEN paper trade — used for trailing-stop SL updates.
 * Only allows mutation of SL-related fields and trade tracking metadata so
 * we never accidentally rewrite entry price / quantity from a buggy caller.
 *
 * @param {string} id     trade.id
 * @param {object} fields { sl?, peakPrice?, tslActivated? }
 * @returns {object|null} the updated trade, or null if not found / closed
 */
function updatePaperTrade(id, fields) {
  const trade = _paperTrades.find((t) => t.id === id);
  if (!trade || trade.status !== 'OPEN') return null;

  const allowed = ['sl', 'peakPrice', 'tslActivated'];
  for (const k of allowed) {
    if (fields[k] !== undefined) trade[k] = fields[k];
  }
  _saveTrades();
  return trade;
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
  _saveTrades();
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
function clearPaperTrades() {
  _paperTrades = [];
  // Remove the current-session file so it doesn't reload on next boot
  try { fs.unlinkSync(TRADES_PATH); } catch { /* file may not exist — ignore */ }
}

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

// ── Auto-trader settings (persisted) ────────────────────────────────────────

/**
 * Returns the current auto-trader configuration.
 * enabled is true by default — user can opt out via the Dashboard toggle.
 */
function getAutoTraderSettings() {
  const config = readConfig();
  return {
    enabled:      config.autoTrader?.enabled      ?? true,
    // Testing mode — quantity is hard-coded to 1; risk/profit kept for future
    // when we re-enable rupee-risk sizing.
    riskPerTrade: config.autoTrader?.riskPerTrade  ?? 5_000,
    minProfit:    config.autoTrader?.minProfit     ?? 10_000,
    // Minimum reward:risk ratio.  2.0 = at least 2:1 R:R required.
    // Max R:R is uncapped — pattern's natural target is used as-is.
    minRR:        config.autoTrader?.minRR         ?? 2.0,
    // Trailing Stop Loss — moves SL up (BUY) or down (SELL) as price moves
    // favourably.  Activated once unrealised profit ≥ tslTriggerR × initial risk.
    // After activation, SL trails tslDistanceR × initial-risk behind the peak.
    tslEnabled:   config.autoTrader?.tslEnabled    ?? false,
    tslTriggerR:  config.autoTrader?.tslTriggerR   ?? 1.0,
    tslDistanceR: config.autoTrader?.tslDistanceR  ?? 0.5,
  };
}

function setAutoTraderSettings(updates) {
  const config = readConfig();
  config.autoTrader = { ...getAutoTraderSettings(), ...updates };
  writeConfig(config);
  return config.autoTrader;
}

module.exports = {
  getConfig, setAccessToken,
  getTradingDefaults, setTradingDefaults,
  getTelegramBotToken, setTelegramBotToken,
  getTelegramChatId, setTelegramChatId,
  getTestMode, setTestMode,
  addPaperTrade, closePaperTrade, updatePaperTrade, autoClosePaperTrades, getPaperTrades, clearPaperTrades,
  getPaperBalance, setPaperInitialBalance, getPaperInitialBalance,
  getWatchlist, setWatchlist, addToWatchlist, removeFromWatchlist,
  getAutoTraderSettings, setAutoTraderSettings,
};
