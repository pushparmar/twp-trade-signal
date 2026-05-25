const { KiteTicker } = require("kiteconnect");
const { getConfig } = require("../store");
const { broadcast, broadcastTick } = require("../sseHub");
const candleStore = require("./candleStore");
const { getSignals } = require("./ichimoku");
const indexSignalWatcher = require("./indexSignalWatcher");
const macroWatcher = require("./macroWatcher");
const patternAlertWatcher = require("./patternAlertWatcher");
const liveScanner = require("./liveScanner");

let _ticker = null;
let _connected = false;
let _subscribedTokens = new Set();
let _reconnectDelay = 1000;
let _reconnectTimer = null;
let _intentionalDisconnect = false;
let _authFailed = false;
let _tradeWatcherWarned = false;

function _isMarketHours() {
    const now = new Date();
    // IST = UTC + 5:30
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);
    const day = ist.getUTCDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    const hours = ist.getUTCHours();
    const minutes = ist.getUTCMinutes();
    const totalMinutes = hours * 60 + minutes;
    // 9:15 AM = 555 min, 3:30 PM = 930 min (with 5 min buffer either side)
    return totalMinutes >= 550 && totalMinutes <= 935;
}

function connect() {
    const { kite } = getConfig();
    if (!kite.apiKey || !kite.accessToken) {
        console.warn("[KiteTicker] Cannot connect — Kite not authenticated");
        return;
    }

    if (_ticker) {
        disconnect(true);
    }

    _intentionalDisconnect = false;
    _authFailed = false;
    console.log("[KiteTicker] Connecting...");

    _ticker = new KiteTicker({
        api_key: kite.apiKey,
        access_token: kite.accessToken,
        reconnect: false // we handle reconnect ourselves
    });

    _ticker.on("connect", () => {
        _connected = true;
        _reconnectDelay = 1000;
        console.log(`[KiteTicker] Connected — _subscribedTokens has ${_subscribedTokens.size} tokens at this moment`);
        broadcast("ticker_status", { connected: true });

        // Re-subscribe previously tracked tokens after reconnect
        if (_subscribedTokens.size > 0) {
            const tokens = Array.from(_subscribedTokens);
            _ticker.subscribe(tokens);
            _ticker.setMode(_ticker.modeFull, tokens);
            console.log(`[KiteTicker] On-connect re-subscribed tokens: ${tokens.join(", ")}`);
        } else {
            console.warn("[KiteTicker] On-connect: no tokens to subscribe yet (race condition?)");
        }
    });

    // Log the first tick we see per token so we can verify which streams are actually live
    const _firstTickSeen = new Set();
    _ticker.on("ticks", ticks => {
        for (const tick of ticks) {
            if (!_firstTickSeen.has(tick.instrument_token)) {
                _firstTickSeen.add(tick.instrument_token);
                console.log(`[KiteTicker] FIRST tick — token=${tick.instrument_token} price=${tick.last_price}`);
            }
            const payload = {
                instrumentToken: tick.instrument_token,
                lastPrice: tick.last_price,
                ohlc: tick.ohlc || {},
                volume: tick.volume_traded ?? tick.volume ?? 0,
                change: tick.change ?? 0,
                lastTradeTime: tick.last_trade_time ?? null,
                oi: tick.oi ?? 0,
                oiDayHigh: tick.oi_day_high ?? 0,
                oiDayLow: tick.oi_day_low ?? 0,
                buyQuantity: tick.total_buy_quantity ?? 0,
                sellQuantity: tick.total_sell_quantity ?? 0,
                averageTradePrice: tick.average_traded_price ?? 0
            };
            // Throttled broadcast — only the latest price per token is sent every
            // 250 ms. This prevents SSE queue saturation from rapid Kite ticks.
            broadcastTick(payload);

            // Update live macro prices on every tick (debounced inside macroWatcher)
            macroWatcher.onTick(tick.instrument_token, tick.last_price);

            // Feed live price into candle ring buffer.
            // When a candle closes, compute Ichimoku signals immediately and push to clients —
            // no HTTP round-trip needed; everything is already in memory.
            const ltt = tick.last_trade_time;
            const tradeTimeMs = ltt instanceof Date ? ltt.getTime() : ltt ? new Date(ltt).getTime() : Date.now();
            // Pass volume_traded (cumulative day total) so candleStore can derive
            // per-candle volume from the delta — fixes the "volume always 0 during
            // market hours" bug that silently broke the volumeConfirmed badge.
            candleStore.onTick(
                tick.instrument_token,
                tick.last_price,
                tradeTimeMs,
                (token, interval) => {
                    try {
                        const candles = candleStore.getCandlesSync(token, interval);
                        if (candles && candles.length >= 26) {
                            const signals = getSignals(candles);
                            if (signals) broadcast("ichimoku_update", { token, interval, ...signals });
                        }
                    } catch {}

                    // Check index signals immediately on candle close — no polling delay
                    indexSignalWatcher.onCandleClose(token, interval).catch(() => {});
                    // Recompute macro analysis and push to clients on every candle close
                    macroWatcher.onCandleClose(token, interval).catch(() => {});
                    // Run pattern alerts — fires Telegram if a kumo pattern matches
                    patternAlertWatcher.onCandleClose(token, interval).catch(() => {});
                    // Scan user watchlist stocks for patterns — broadcasts scan_alert SSE
                    // and sends Telegram. Async; ignore rejections so Telegram outages don't
                    // leak into the tick handler.
                    liveScanner.onCandleClose(token, interval).catch(() => {});
                },
                tick.volume_traded
            );

            // ── Server-side trade watcher — authoritative SL/Target/TSL handling ──
            // Runs on EVERY tick (not just candle closes) so SL hits don't wait for
            // the next 250 ms client-throttled SSE.  Imported lazily to avoid a circular
            // dependency at boot time.
            try {
                require("./tradeWatcher").onTick(tick.instrument_token, tick.last_price, tick.ohlc);
            } catch (err) {
                // First-load may fail if tradeWatcher hasn't been registered yet — log once
                if (!_tradeWatcherWarned) {
                    console.warn("[KiteTicker] tradeWatcher.onTick failed:", err.message);
                    _tradeWatcherWarned = true;
                }
            }
        }
    });

    _ticker.on("error", err => {
        const msg = err?.message || String(err);
        if (msg.includes("403") || msg.includes("Unexpected server response")) {
            _authFailed = true;
            console.warn("[KiteTicker] Auth error — stopping reconnect. Re-login to Kite to reconnect.");
            return;
        }
        console.error("[KiteTicker] Error:", msg);
    });

    _ticker.on("disconnect", err => {
        _connected = false;
        broadcast("ticker_status", { connected: false });
        if (_intentionalDisconnect || _authFailed) return;
        console.warn("[KiteTicker] Disconnected:", err?.message || "unknown reason");
        _scheduleReconnect();
    });

    _ticker.on("noreconnect", () => {
        console.error("[KiteTicker] Max reconnects reached");
        _connected = false;
        broadcast("ticker_status", { connected: false });
    });

    _ticker.connect();
}

function disconnect(intentional = true) {
    _intentionalDisconnect = intentional;
    if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }
    if (_ticker) {
        try {
            _ticker.disconnect();
        } catch {}
        _ticker = null;
    }
    _connected = false;
}

function _scheduleReconnect() {
    if (_reconnectTimer) return;
    console.log(`[KiteTicker] Reconnecting in ${_reconnectDelay / 1000}s...`);
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000);
        connect();
    }, _reconnectDelay);
}

function subscribe(tokens) {
    if (!tokens || tokens.length === 0) return;
    const nums = tokens.map(Number);
    nums.forEach(t => _subscribedTokens.add(t));

    if (_connected && _ticker) {
        _ticker.subscribe(nums);
        _ticker.setMode(_ticker.modeFull, nums);
        console.log(`[KiteTicker] Live subscribe (connected): ${nums.join(", ")}`);
    } else {
        console.log(`[KiteTicker] Deferred subscribe (not connected yet): ${nums.join(", ")}`);
    }
}

function unsubscribe(tokens) {
    if (!tokens || tokens.length === 0) return;
    const nums = tokens.map(Number);
    nums.forEach(t => _subscribedTokens.delete(t));

    if (_connected && _ticker) {
        _ticker.unsubscribe(nums);
        console.log(`[KiteTicker] Unsubscribed tokens: ${nums.join(", ")}`);
    }
}

function getSubscribed() {
    return Array.from(_subscribedTokens);
}

function isConnected() {
    return _connected;
}

module.exports = { connect, disconnect, subscribe, unsubscribe, getSubscribed, isConnected };
