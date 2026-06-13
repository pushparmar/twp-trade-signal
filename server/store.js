const fs = require("fs");
const path = require("path");
const { getLotMultiplier } = require('./utils/lotSizeResolver');

// Use Railway persistent volume if available, otherwise fall back to local file.
// On Railway: add a Volume mounted at /data in the dashboard.
const CONFIG_PATH = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "config.json")
    : path.join(__dirname, "config.json");

const DEFAULT_TRADING = { quantity: 1, exchange: "NFO", product: "MIS" };

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

// ── Pattern Config ──────────────────────────────────────
// Controls which patterns run on which timeframes for scan, telegram alerts, and auto orders.
// Shape: { "pattern-id:interval": { scan: bool, alert: bool, order: bool } }
// Missing keys default to { scan: true, alert: true, order: true } (everything enabled).

function getPatternConfig() {
    const config = readConfig();
    return config.patternConfig ?? {};
}

function setPatternConfig(updates) {
    const config = readConfig();
    config.patternConfig = { ...(config.patternConfig ?? {}), ...updates };
    writeConfig(config);
    // Persist to MongoDB so config survives Railway redeploys
    try {
        const db = require('./db');
        if (db.settingsRepo) {
            db.settingsRepo.set('patternConfig', config.patternConfig).catch(() => {});
        }
    } catch { /* DB not initialized yet — skip */ }
    return config.patternConfig;
}

/**
 * Load pattern config from MongoDB on boot.
 * MongoDB is the source of truth — overrides whatever is in config.json.
 * Call this once after db.init() completes.
 */
async function loadPatternConfigFromMongo() {
    try {
        const db = require('./db');
        const mongoConfig = await db.settingsRepo.get('patternConfig');
        if (mongoConfig && typeof mongoConfig === 'object') {
            const config = readConfig();
            config.patternConfig = mongoConfig;
            writeConfig(config);
            const keyCount = Object.keys(mongoConfig).length;
            console.log(`[store] Loaded patternConfig from MongoDB (${keyCount} entries)`);
            return true;
        }
        console.log('[store] No patternConfig in MongoDB — using config.json / defaults');
        return false;
    } catch (err) {
        console.warn('[store] loadPatternConfigFromMongo failed:', err.message);
        return false;
    }
}

/**
 * Check if a specific pattern+interval+channel is enabled.
 * Returns true by default if no config exists for the combination.
 * @param {string} patternId  e.g. 'kumo-breakout'
 * @param {string} interval   e.g. '15minute', '60minute', '4h', 'day'
 * @param {'scan'|'alert'|'order'} channel
 * @returns {boolean}
 */
function isPatternEnabled(patternId, interval, channel) {
    const pc = getPatternConfig();
    const key = `${patternId}:${interval}`;
    const entry = pc[key];
    if (!entry) return true;  // default: enabled
    return entry[channel] !== false;  // only disabled if explicitly set to false
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

function closePaperTrade(id, exitPrice, reason) {
    const trade = _paperTrades.find(t => t.id === id);
    if (!trade || trade.status !== "OPEN") return null;
    // For MCX commodities multiply by the contract lot size so PnL is in rupees.
    const lotMult = getLotMultiplier(trade);
    const pnl =
        trade.action === "BUY"
            ? (exitPrice - trade.entryPrice) * trade.quantity * lotMult
            : (trade.entryPrice - exitPrice) * trade.quantity * lotMult;
    trade.status     = "CLOSED";
    trade.exitPrice  = exitPrice;
    trade.exitReason = reason ?? null;   // 'TARGET' | 'TSL' | 'SL' | 'MANUAL' | null
    trade.pnl        = Math.round(pnl * 100) / 100;
    trade.closedTs   = Date.now();
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
        tslDistanceR: config.autoTrader?.tslDistanceR ?? 0.5,
        // When true, SL exits wait for a 15-minute candle close beyond the SL
        // level before closing the position — avoids wick-triggered false exits.
        slViaCandleClose: config.autoTrader?.slViaCandleClose ?? false,
        // Trading time window (IST). No NEW entries placed outside this range.
        // Open trades continue to be monitored and exited at any time.
        tradeStartHHMM: config.autoTrader?.tradeStartHHMM ?? '09:20',
        tradeEndHHMM:   config.autoTrader?.tradeEndHHMM   ?? '15:15',
    };
}

function setAutoTraderSettings(updates) {
    const config = readConfig();
    config.autoTrader = { ...getAutoTraderSettings(), ...updates };
    writeConfig(config);
    return config.autoTrader;
}

// ── Live order flag (config-file only, no UI) ─────────────────────────────────
/**
 * Returns true ONLY when `"liveOrderEnabled": true` is present in config.json.
 * Strict equality — string "true", 1, or any other truthy value returns false.
 * This flag has no UI toggle; it must be set manually in config.json.
 */
function getLiveOrderEnabled() {
    const config = readConfig();
    return config.liveOrderEnabled === true;
}

/**
 * Write Kite order IDs back onto a paper trade for cross-referencing.
 * Works on trades of any status (including CLOSED).
 * Only the kiteEntryOrderId / kiteExitOrderId fields are written.
 *
 * @param {string} id
 * @param {{ kiteEntryOrderId?: string, kiteExitOrderId?: string }} fields
 */
function setTradeKiteOrderIds(id, fields) {
    const trade = _paperTrades.find(t => t.id === id);
    if (!trade) return;
    if (fields.kiteEntryOrderId != null) trade.kiteEntryOrderId = fields.kiteEntryOrderId;
    if (fields.kiteExitOrderId  != null) trade.kiteExitOrderId  = fields.kiteExitOrderId;
    _saveTrades();
}

// ── Quality Score Config (persisted) ─────────────────────────────────────────
// Controls the 0–10 quality score gate for scan/alert/order channels.

const QUALITY_SCORE_DEFAULTS = {
    enabled:          false,   // master toggle
    minQualityScore:  5,       // <5 = skip (C setup)
    aSetupMinScore:   7,       // ≥7 = A setup
    scanGateEnabled:  true,    // gate SSE scan feed
    alertGateEnabled: true,    // gate Telegram alerts
    orderGateEnabled: true,    // gate auto-trader orders
    // RSI ideal zone ranges (reused by signalScorer factor 5)
    rsiBullishMin:    50,
    rsiBullishMax:    65,
    rsiBearishMin:    35,
    rsiBearishMax:    50,
};

function getQualityScoreConfig() {
    const config = readConfig();
    return { ...QUALITY_SCORE_DEFAULTS, ...(config.qualityScore ?? {}) };
}

function setQualityScoreConfig(updates) {
    const config = readConfig();
    config.qualityScore = { ...getQualityScoreConfig(), ...updates };
    writeConfig(config);
    // Persist to MongoDB so config survives Railway redeploys
    try {
        const db = require('./db');
        if (db.settingsRepo) {
            db.settingsRepo.set('qualityScore', config.qualityScore).catch(() => {});
        }
    } catch { /* DB not initialized yet — skip */ }
    return config.qualityScore;
}

async function loadQualityScoreConfigFromMongo() {
    try {
        const db = require('./db');
        const mongoConfig = await db.settingsRepo.get('qualityScore');
        if (mongoConfig && typeof mongoConfig === 'object') {
            const config = readConfig();
            config.qualityScore = mongoConfig;
            writeConfig(config);
            console.log('[store] Loaded qualityScore config from MongoDB');
            return true;
        }
        return false;
    } catch (err) {
        console.warn('[store] loadQualityScoreConfigFromMongo failed:', err.message);
        return false;
    }
}

// ── Module Config ───────────────────────────────────────────────────────────────
// Controls which modules/features are enabled at both server and UI level.
// Each module can be independently toggled ON/OFF.

const MODULE_DEFAULTS = {
    // Server-side features
    backgroundScan:      { enabled: true,  label: 'Background Scanner',    category: 'server', description: 'Auto-scan F&O stocks at candle close (15m/1h/4h/day)' },
    telegramAlerts:      { enabled: true,  label: 'Telegram Alerts',       category: 'server', description: 'Send pattern alerts to Telegram' },
    signalTracking:      { enabled: true,  label: 'Signal Outcome Tracking', category: 'server', description: 'Track signal outcomes (MFE/MAE) for 20 bars' },
    indexTrade:          { enabled: true,  label: 'Index Trade Auto',      category: 'server', description: 'Auto-trade NIFTY/SENSEX options' },
    telegramPolling:     { enabled: true,  label: 'Telegram Polling',      category: 'server', description: 'Poll Telegram for incoming signals' },
    // UI pages/tabs
    uiDashboard:         { enabled: true,  label: 'Dashboard',             category: 'ui',     description: 'Paper trading dashboard' },
    uiMarketWatch:       { enabled: false, label: 'Market Watch',          category: 'ui',     description: 'Real-time market watch with Ichimoku signals' },
    uiScanner:           { enabled: true,  label: 'Scanner',               category: 'ui',     description: 'Live scan alerts from background scanner' },
    uiAnalytics:         { enabled: false, label: 'Analytics',             category: 'ui',     description: 'Trade and signal analytics' },
    uiBacktest:          { enabled: false, label: 'Backtest',              category: 'ui',     description: 'Pattern backtesting' },
    uiIndexTrade:        { enabled: true,  label: 'Index Trade',           category: 'ui',     description: 'Index options trading panel' },
    uiEquityScan:        { enabled: true,  label: 'Equity Scan',           category: 'ui',     description: 'Manual equity scan panel' },
};

function getModuleConfig() {
    const config = readConfig();
    const stored = config.moduleConfig ?? {};
    // Merge with defaults so new modules get default values
    const merged = {};
    for (const [moduleId, defaults] of Object.entries(MODULE_DEFAULTS)) {
        merged[moduleId] = {
            ...defaults,
            enabled: stored[moduleId]?.enabled ?? defaults.enabled,
        };
    }
    return merged;
}

function setModuleConfig(updates) {
    const config = readConfig();
    const current = config.moduleConfig ?? {};
    // Only store enabled state, not the full metadata
    for (const [moduleId, val] of Object.entries(updates)) {
        if (MODULE_DEFAULTS[moduleId]) {
            current[moduleId] = { enabled: !!val.enabled };
        }
    }
    config.moduleConfig = current;
    writeConfig(config);
    // Persist to MongoDB so config survives Railway redeploys
    try {
        const db = require('./db');
        if (db.settingsRepo) {
            db.settingsRepo.set('moduleConfig', current).catch(() => {});
        }
    } catch { /* DB not initialized yet — skip */ }
    return getModuleConfig();
}

/**
 * Check if a specific module is enabled.
 * @param {string} moduleId
 * @returns {boolean}
 */
function isModuleEnabled(moduleId) {
    const mc = getModuleConfig();
    return mc[moduleId]?.enabled !== false;
}

/**
 * Load module config from MongoDB on boot.
 * MongoDB is source of truth — overrides config.json.
 */
async function loadModuleConfigFromMongo() {
    try {
        const db = require('./db');
        const mongoConfig = await db.settingsRepo.get('moduleConfig');
        if (mongoConfig && typeof mongoConfig === 'object') {
            const config = readConfig();
            config.moduleConfig = mongoConfig;
            writeConfig(config);
            const enabledCount = Object.values(mongoConfig).filter(m => m.enabled).length;
            console.log(`[store] Loaded moduleConfig from MongoDB (${enabledCount}/${Object.keys(mongoConfig).length} enabled)`);
            return true;
        }
        console.log('[store] No moduleConfig in MongoDB — using defaults');
        return false;
    } catch (err) {
        console.warn('[store] loadModuleConfigFromMongo failed:', err.message);
        return false;
    }
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
    getLiveOrderEnabled,
    setTradeKiteOrderIds,
    getLotMultiplier,
    getPatternConfig,
    setPatternConfig,
    isPatternEnabled,
    loadPatternConfigFromMongo,
    getQualityScoreConfig,
    setQualityScoreConfig,
    loadQualityScoreConfigFromMongo,
    getModuleConfig,
    setModuleConfig,
    isModuleEnabled,
    loadModuleConfigFromMongo,
};
