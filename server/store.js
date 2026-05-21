const fs = require("fs");
const path = require("path");

// Use Railway persistent volume if available, otherwise fall back to local file.
// On Railway: add a Volume mounted at /data in the dashboard.
const CONFIG_PATH = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "config.json")
    : path.join(__dirname, "config.json");

const DEFAULT_TRADING = { quantity: 1, exchange: "NFO", product: "MIS" };

// ── MCX commodity lot sizes ────────────────────────────────────────────────
// PnL for MCX futures = (exitPrice - entryPrice) × quantity × lotSize.
// Symbols are matched by prefix (e.g. "CRUDEOIL24JUNFUT" → "CRUDEOIL").
// Listed longest-first so shorter prefixes (GOLD/SILVER) don't shadow longer ones.
//
// How each multiplier is derived (standard MCX contracts):
//   NATURALGAS — 1250 MMBtu contract, price quoted per MMBtu      → ×1250
//   CRUDEOIL   — 100 barrel contract, price quoted per barrel      → ×100
//   SILVER     — 30 kg contract, price quoted per kg               → ×30
//   SILVERM    — 5 kg mini contract, price quoted per kg            → ×5
//   GOLD       — 1 kg contract, price quoted per 10g (100×10g=1kg) → ×100
//   GOLDM      — 100g mini contract, price quoted per 10g          → ×10
// MCX mini contract lot sizes.
// Longer prefixes MUST come before shorter ones because the lookup does
// startsWith() and returns on first match — SILVERM before SILVER, etc.
// All entries use the mini-contract multiplier so position sizing stays
// manageable on paper trades (e.g. GOLD = 10 units of 10g = 100g total,
// instead of the full 1 kg contract at 100 units).
const MCX_LOT_SIZES = {
    NATGASMINI: 1250, // Natural Gas Mini  — 250 mmBtu
    NATURALGAS: 1250, // Natural Gas (map full symbol → mini size)
    CRUDEOILM: 10, // Crude Oil Mini    — 10 barrels
    CRUDEOIL: 10, // Crude Oil (map full symbol → mini size)
    SILVERM: 5, // Silver Mini       — 5 kg
    SILVER: 5, // Silver (map full symbol → mini size)
    GOLDM: 10, // Gold Mini         — 10 units of 10g = 100g
    GOLD: 10 // Gold (map full symbol → mini size)
};

/**
 * Returns the per-unit lot multiplier for a paper trade.
 * Priority: trade.lotSize (if set by auto-trader) → MCX symbol map → 1.
 *
 * @param {{ exchange?: string, symbol?: string, lotSize?: number }} trade
 * @returns {number}
 */
function getLotMultiplier(trade) {
    // Prefer an explicitly stored lotSize (set by derivatives/auto-trader logic).
    if (trade.lotSize && trade.lotSize > 1) return trade.lotSize;

    // For MCX paper trades, derive lot size from the commodity name prefix.
    if (trade.exchange === "MCX" && trade.symbol) {
        const sym = trade.symbol.toUpperCase();
        for (const [name, size] of Object.entries(MCX_LOT_SIZES)) {
            if (sym.startsWith(name)) return size;
        }
    }
    return 1;
}

let _runtimeAccessToken = "";

function _loadPersistedToken() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf8");
        const data = JSON.parse(raw);
        _runtimeAccessToken = data.kiteAccessToken || process.env.KITE_ACCESS_TOKEN || "";
    } catch {
        _runtimeAccessToken = process.env.KITE_ACCESS_TOKEN || "";
    }
}
_loadPersistedToken();

function readConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function getConfig() {
    // Read persisted config so the bot token saved via the UI (config.json) works
    // even when TELEGRAM_BOT_TOKEN env var is not set (typical local/dev usage).
    const persisted = readConfig();
    return {
        kite: {
            apiKey: process.env.KITE_API_KEY || "",
            apiSecret: process.env.KITE_API_SECRET || "",
            accessToken: _runtimeAccessToken
        },
        telegram: {
            botToken: process.env.TELEGRAM_BOT_TOKEN || persisted.telegram?.botToken || ""
        }
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
    return process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || "";
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
    return config.telegramChatId || process.env.TELEGRAM_CHAT_ID || "";
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
    ? path.join(process.env.DATA_DIR, "trades-current.json")
    : path.join(__dirname, "data", "trades-current.json");

let _testMode = false;
let _paperTrades = [];
// Default starting balance: ₹1 crore (1,00,00,000)
let _paperInitialBalance = 10_000_000;
// Cumulative realized PnL — persists in config.json across restarts and "Clear All".
// Incremented whenever a paper trade closes so the running balance is always correct.
let _cumulativePnl = 0;

// Persist current trades to disk after every mutation.
function _saveTrades() {
    try {
        fs.writeFileSync(TRADES_PATH, JSON.stringify(_paperTrades, null, 2), "utf8");
    } catch (err) {
        console.warn("[store] Failed to persist trades:", err.message);
    }
}

function _saveCumulativePnl() {
    const config = readConfig();
    config.cumulativePnl = _cumulativePnl;
    writeConfig(config);
}

// Load trades from the previous session on module boot.
(function _loadTrades() {
    try {
        if (fs.existsSync(TRADES_PATH)) {
            const loaded = JSON.parse(fs.readFileSync(TRADES_PATH, "utf8"));
            if (Array.isArray(loaded)) {
                _paperTrades = loaded;
                console.log(`[store] Loaded ${_paperTrades.length} paper trades from disk`);
            }
        }
    } catch (err) {
        console.warn("[store] Could not load trades from disk:", err.message);
    }

    // Load cumulative PnL from config. On first run, bootstrap it from any closed
    // trades already on disk so the migration from the old per-trade derivation is
    // seamless.
    try {
        const config = readConfig();
        if (typeof config.cumulativePnl === "number") {
            _cumulativePnl = config.cumulativePnl;
        } else {
            // First run: seed from existing closed trades so nothing is lost
            _cumulativePnl = _paperTrades.filter(t => t.status === "CLOSED").reduce((sum, t) => sum + (t.pnl || 0), 0);
            _cumulativePnl = Math.round(_cumulativePnl * 100) / 100;
            _saveCumulativePnl();
        }
    } catch {
        _cumulativePnl = 0;
    }
})();

function getTestMode() {
    return _testMode;
}
function setTestMode(enabled) {
    _testMode = enabled;
}

function getPaperInitialBalance() {
    return _paperInitialBalance;
}
function setPaperInitialBalance(amount) {
    _paperInitialBalance = amount;
}

function getPaperBalance() {
    const invested = _paperTrades
        .filter(t => t.status === "OPEN")
        .reduce((sum, t) => sum + t.entryPrice * t.quantity, 0);
    return {
        initial: _paperInitialBalance,
        available: Math.round((_paperInitialBalance + _cumulativePnl - invested) * 100) / 100,
        invested: Math.round(invested * 100) / 100,
        realizedPnl: Math.round(_cumulativePnl * 100) / 100
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
    const trade = _paperTrades.find(t => t.id === id);
    if (!trade || trade.status !== "OPEN") return null;

    const allowed = ["sl", "peakPrice", "tslActivated"];
    for (const k of allowed) {
        if (fields[k] !== undefined) trade[k] = fields[k];
    }
    _saveTrades();
    return trade;
}

/**
 * Transition a PENDING order to OPEN when its trigger price is hit.
 * Mutates in-place and persists to disk.
 */
function activatePendingTrade(id) {
    const trade = _paperTrades.find(t => t.id === id);
    if (!trade || trade.status !== "PENDING") return null;
    trade.status = "OPEN";
    trade.activatedTs = Date.now();
    _saveTrades();
    return trade;
}

/**
 * Remove a PENDING order without generating any PnL.
 * Returns true when cancelled, false when not found or not PENDING.
 */
function cancelPendingTrade(id) {
    const idx = _paperTrades.findIndex(t => t.id === id && t.status === "PENDING");
    if (idx === -1) return false;
    _paperTrades.splice(idx, 1);
    _saveTrades();
    return true;
}

function closePaperTrade(id, exitPrice) {
    const trade = _paperTrades.find(t => t.id === id);
    if (!trade || trade.status !== "OPEN") return null;
    // For MCX commodities multiply by the contract lot size so PnL is in rupees.
    const lotMult = getLotMultiplier(trade);
    const pnl =
        trade.action === "BUY"
            ? (exitPrice - trade.entryPrice) * trade.quantity * lotMult
            : (trade.entryPrice - exitPrice) * trade.quantity * lotMult;
    trade.status = "CLOSED";
    trade.exitPrice = exitPrice;
    trade.pnl = Math.round(pnl * 100) / 100;
    trade.closedTs = Date.now();
    // Persist realized PnL so balance survives restarts and "Clear All"
    _cumulativePnl = Math.round((_cumulativePnl + trade.pnl) * 100) / 100;
    _saveCumulativePnl();
    _saveTrades();
    return trade;
}

function autoClosePaperTrades(symbol, exitPrice, exitAction) {
    const entryAction = exitAction === "SELL" ? "BUY" : "SELL";
    return _paperTrades
        .filter(t => t.status === "OPEN" && t.symbol === symbol && t.action === entryAction)
        .map(t => closePaperTrade(t.id, exitPrice))
        .filter(Boolean);
}

function getPaperTrades() {
    return _paperTrades;
}

// Overwrite cumulative PnL — used on startup to load the authoritative value
// from MongoDB so the balance survives Railway redeploys and config.json loss.
function setCumulativePnl(amount) {
    _cumulativePnl = Math.round(amount * 100) / 100;
    _saveCumulativePnl();
}

// Reset cumulative PnL to zero (keeps initial balance, wipes running score)
function resetPaperBalance() {
    _cumulativePnl = 0;
    _saveCumulativePnl();
}

function clearPaperTrades() {
    _paperTrades = [];
    // Remove the current-session file so it doesn't reload on next boot
    try {
        fs.unlinkSync(TRADES_PATH);
    } catch {
        /* file may not exist — ignore */
    }
    // NOTE: _cumulativePnl is intentionally NOT reset here — realized PnL
    // persists across Clear All so the running balance is always accurate.
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
    if (list.find(i => i.instrumentToken === item.instrumentToken)) return list;
    const updated = [...list, item];
    setWatchlist(updated);
    return updated;
}

function removeFromWatchlist(instrumentToken) {
    const updated = getWatchlist().filter(i => i.instrumentToken !== Number(instrumentToken));
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
        enabled: config.autoTrader?.enabled ?? true,
        // NSE: ₹10k risk → ≥₹20k profit (R:R 1:2 minimum)
        // MCX: lot-based, R:R enforced; profit threshold informational only
        riskPerTrade: config.autoTrader?.riskPerTrade ?? 10_000,
        minProfit: config.autoTrader?.minProfit ?? 20_000,
        minRR: config.autoTrader?.minRR ?? 2.0,
        // Trailing Stop Loss — moves SL up (BUY) or down (SELL) as price moves
        // favourably.  Activated once unrealised profit ≥ tslTriggerR × initial risk.
        // After activation, SL trails tslDistanceR × initial-risk behind the peak.
        tslEnabled: config.autoTrader?.tslEnabled ?? true,
        tslTriggerR: config.autoTrader?.tslTriggerR ?? 1.0,
        tslDistanceR: config.autoTrader?.tslDistanceR ?? 0.5
    };
}

function setAutoTraderSettings(updates) {
    const config = readConfig();
    config.autoTrader = { ...getAutoTraderSettings(), ...updates };
    writeConfig(config);
    return config.autoTrader;
}

module.exports = {
    getConfig,
    setAccessToken,
    getTradingDefaults,
    setTradingDefaults,
    getTelegramBotToken,
    setTelegramBotToken,
    getTelegramChatId,
    setTelegramChatId,
    getTestMode,
    setTestMode,
    addPaperTrade,
    closePaperTrade,
    updatePaperTrade,
    activatePendingTrade,
    cancelPendingTrade,
    autoClosePaperTrades,
    getPaperTrades,
    clearPaperTrades,
    getPaperBalance,
    setPaperInitialBalance,
    getPaperInitialBalance,
    setCumulativePnl,
    resetPaperBalance,
    getWatchlist,
    setWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    getAutoTraderSettings,
    setAutoTraderSettings,
    getLotMultiplier
};
