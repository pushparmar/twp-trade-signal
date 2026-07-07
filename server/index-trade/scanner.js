/**
 * scanner.js — Index Trade module
 *
 * Runs TK Reversion pattern
 * on subscribed option strikes across minute, 5minute, 15minute timeframes.
 *
 * Uses a lightweight polling approach: every 2 seconds, checks if any
 * candle count changed (new candle closed) and runs patterns on it.
 */

const candleStore     = require('../services/candleStore');
const patternRegistry = require('../services/patternRegistry');
const { broadcast }   = require('../sseHub');
const { isNseOpen }   = require('../utils/marketHours');
const { getRSI, calculate: calculateIchimoku } = require('../services/ichimoku');
const telegramNotifier = require('../services/telegramNotifier');
const mainStore       = require('../store');

const strikeManager = require('./strikeManager');
const orderManager  = require('./orderManager');
const tradeStore    = require('./tradeStore');

// ── Config ──────────────────────────────────────────────────────────────────

// TK Reversion and Kumo Breakout enabled for index trades
const PATTERN_IDS = ['tk-reversion', 'kumo-breakout'];
const INTERVALS   = ['minute', '5minute', '15minute', '60minute'];
const POLL_MS     = 2000; // check for new candles every 2 seconds

// Patterns that should only run on specific intervals.
// Patterns not listed here run on ALL intervals.
const PATTERN_INTERVALS = {
  'kijun-bounce': ['15minute', '60minute'],  // Kijun support/resistance — higher TF only
  'kijun-retest': ['15minute', '60minute'],  // Kijun retest — higher TF only
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────────

const _lastCandleCount = new Map(); // "token:interval" → candle count
const _dedup = new Map();           // "token:interval:patternId:signal" → IST date string
const _telegramDedup = new Map();   // "token:patternId" → IST date string (global telegram dedup, ignores TF)
const _bullishSetupDedup = new Map(); // "token:interval" → IST date string (for bullish setup alerts)
const _alertHistory = [];           // last 100 alerts in-memory for page refresh
const MAX_HISTORY = 100;
let _pollTimer = null;
let _bullishScanTimer = null;       // separate timer for bullish setup scan
let _scanCount = 0;
let _matchCount = 0;
let _lastScanAt = null;

// ── Dedup ───────────────────────────────────────────────────────────────────

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function _isDuplicate(token, interval, patternId, signal) {
  const key = `${token}:${interval}:${patternId}:${signal}`;
  const today = _istDateStr();
  return _dedup.get(key) === today;
}

function _markSeen(token, interval, patternId, signal) {
  const key = `${token}:${interval}:${patternId}:${signal}`;
  _dedup.set(key, _istDateStr());
}

// ── TF label helper ─────────────────────────────────────────────────────────

const TF_LABEL = { minute: '1m', '5minute': '5m', '15minute': '15m', '60minute': '1h' };

// ── Telegram notification for pattern alerts ────────────────────────────────

async function _sendPatternTelegram(signalPayload) {
  const chatId = mainStore.getTelegramChatId();
  if (!chatId) return;

  const config = tradeStore.getConfig();
  if (!config.patternAlertTelegramEnabled) return;

  const { token, patternId } = signalPayload;
  const { signal, close, sl, target } = signalPayload;

  // Only send BULLISH alerts — skip bearish (red dot) signals
  if (signal !== 'bullish') {
    return;
  }

  // R:R filter — skip signals with reward:risk below 1:2
  if (close && sl && target) {
    const risk = Math.abs(close - sl);
    const reward = Math.abs(target - close);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < 2) {
      console.log(
        `[IdxScanner] ⏭ Telegram skipped (R:R < 1:2): ${signalPayload.symbol} ` +
        `entry=₹${close.toFixed(2)} target=₹${target.toFixed(2)} sl=₹${sl.toFixed(2)} R:R=1:${rr.toFixed(1)}`
      );
      return;
    }
  }

  // Global telegram dedup — same token + pattern only sends ONE telegram per day
  const telegramKey = `${token}:${patternId}`;
  const today = _istDateStr();
  if (_telegramDedup.get(telegramKey) === today) {
    return;
  }
  _telegramDedup.set(telegramKey, today);

  const {
    symbol, index, strike, optionType, patternLabel,
    tfLabel, score, rsi14, rrRatio,
    volumeRatio, volumeConfirmed
  } = signalPayload;

  const emoji = signal === 'bullish' ? '🟢' : '🔴';
  const signalText = signal === 'bullish' ? 'BULLISH' : 'BEARISH';

  // Calculate R:R if not provided
  const rr = rrRatio ?? (close && sl && target
    ? (Math.abs(target - close) / Math.abs(close - sl)).toFixed(2)
    : '—');

  // Volume info
  const volText = volumeRatio != null
    ? `Volume: ${volumeRatio.toFixed(1)}× avg ${volumeConfirmed ? '✅' : ''}`
    : null;

  const msg = [
    `${emoji} <b>${patternLabel}</b> — ${signalText}`,
    ``,
    `<b>${symbol}</b> (${index})`,
    `Strike: ${strike} ${optionType}`,
    ``,
    `📊 <b>Trade Setup</b>`,
    `Entry: ₹${close?.toFixed(2) ?? '—'}`,
    `SL: ₹${sl?.toFixed(2) ?? '—'}`,
    `Target: ₹${target?.toFixed(2) ?? '—'}`,
    `R:R: 1:${rr}`,
    ``,
    `Score: ${score ?? '—'}/5`,
    rsi14 != null ? `RSI: ${rsi14}` : null,
    volText,
    `TF: ${tfLabel}`,
  ].filter(Boolean).join('\n');

  try {
    await telegramNotifier.sendMessage(chatId, msg);
    console.log(`[IdxScanner] 📱 Pattern alert sent: ${symbol} ${patternLabel}`);
  } catch (err) {
    console.warn(`[IdxScanner] Telegram pattern alert failed:`, err.message);
  }
}

// ── Scan logic ──────────────────────────────────────────────────────────────

function _scan(token, interval) {
  const config = tradeStore.getConfig();
  if (!config.enabled) return;

  const candles = candleStore.getCandlesSync(token, interval);
  if (!candles || candles.length < 78) return; // need 78 for Ichimoku + cloud

  const inst = strikeManager.getInstrumentByToken(token);
  if (!inst) return;

  // ── RSI — computed once per token:interval, shared across all patterns ───
  const rsi14Raw = getRSI(candles, 14);
  const rsi14    = rsi14Raw != null ? +rsi14Raw.toFixed(1) : null;

  for (const patternId of PATTERN_IDS) {
    // Skip patterns that are restricted to specific intervals
    const allowedIntervals = PATTERN_INTERVALS[patternId];
    if (allowedIntervals && !allowedIntervals.includes(interval)) continue;

    const pattern = patternRegistry.get(patternId);
    if (!pattern) continue;

    try {
      const result = pattern.run(candles);
      if (!result || !result.matched) continue;
      if (!result.sl || !result.target || !result.close) continue;

      // ── RSI scan/alert gate ────────────────────────────────────────────────
      // Applied BEFORE dedup so a signal that fails RSI is not marked as seen —
      // it will be reconsidered next candle if RSI moves into range.
      const cfg = tradeStore.getConfig();
      if (cfg.rsiFilterEnabled && cfg.rsiFilterScan && rsi14 != null) {
        const isBullish = result.signal === 'bullish';
        const rsiMin    = isBullish ? cfg.rsiBullishMin : cfg.rsiBearishMin;
        const rsiMax    = isBullish ? cfg.rsiBullishMax : cfg.rsiBearishMax;
        if (rsi14 < rsiMin || rsi14 > rsiMax) {
          console.log(
            `[IdxScanner] ⏭ RSI filter (scan): ${inst.tradingsymbol} ${interval} ` +
            `RSI=${rsi14} outside [${rsiMin}–${rsiMax}] for ${result.signal} — skipped`,
          );
          continue;
        }
      }

      // Dedup — same pattern/signal/token/interval once per day
      if (_isDuplicate(token, interval, patternId, result.signal)) continue;
      _markSeen(token, interval, patternId, result.signal);

      _matchCount++;
      const tfLabel = TF_LABEL[interval] || interval;

      // Get masked label if config.maskPatternNames is true
      const maskedLabel = tradeStore.getMaskedPatternLabel(patternId, pattern.label);

      const signalPayload = {
        token,
        index: inst.index,
        symbol: inst.tradingsymbol,
        strike: inst.strike,
        optionType: inst.optionType,
        exchange: inst.exchange,
        lotSize: inst.lotSize,
        patternId,
        patternLabel: maskedLabel,
        signal: result.signal,
        interval,
        tfLabel,
        score: result.score,
        strength: result.strength,
        close: result.close,
        sl: result.sl,
        target: result.target,
        atr: result.atr,
        targetSource: result.targetSource,
        rsi14,   // included so order gate can read it without recomputing
        volumeRatio: result.volumeRatio ?? null,
        volumeConfirmed: result.volumeConfirmed ?? null,
        ts: Date.now(),
      };

      console.log(
        `[IdxScanner] ✅ ${inst.index} ${inst.tradingsymbol} ${tfLabel} ` +
        `${patternId} ${result.signal} score=${result.score} RSI=${rsi14 ?? '—'} ` +
        `entry=${result.close} sl=${result.sl} target=${result.target}`,
      );

      // Store in history so page refresh can fetch missed alerts
      _alertHistory.unshift(signalPayload);
      if (_alertHistory.length > MAX_HISTORY) _alertHistory.length = MAX_HISTORY;

      // Broadcast to UI
      broadcast('idx_scan_alert', signalPayload);

      // Send Telegram notification (fire-and-forget)
      _sendPatternTelegram(signalPayload).catch(() => {});

      // Trigger order
      orderManager.onSignal(signalPayload);
    } catch (err) {
      // Pattern errors should never crash the scanner
      console.warn(`[IdxScanner] ${patternId} error on ${token}/${interval}:`, err.message);
    }
  }
}

// ── Bullish Setup Scanner ───────────────────────────────────────────────────
// Scans ALL subscribed tokens for: price above cloud + tenkan > kijun
// Sends Telegram alert when conditions are met (once per token per day)

const BULLISH_SCAN_INTERVAL = '5minute'; // Use 5m candles for this scan
const BULLISH_SCAN_POLL_MS = 30_000;     // Check every 30 seconds

function _isBullishSetupDuplicate(token) {
  const key = `${token}:${BULLISH_SCAN_INTERVAL}:bullish-setup`;
  const today = _istDateStr();
  return _bullishSetupDedup.get(key) === today;
}

function _markBullishSetupSeen(token) {
  const key = `${token}:${BULLISH_SCAN_INTERVAL}:bullish-setup`;
  _bullishSetupDedup.set(key, _istDateStr());
}

async function _sendBullishSetupTelegram(inst, ichimokuData) {
  const chatId = mainStore.getTelegramChatId();
  if (!chatId) return;

  const { close, tenkan, kijun, cloudTop, cloudBottom } = ichimokuData;

  // Safe formatting with null checks
  const fmt = (v) => v != null ? `₹${v.toFixed(2)}` : '—';

  const msg = [
    `🟢 <b>BULLISH SETUP</b>`,
    ``,
    `<b>${inst.tradingsymbol}</b> (${inst.index})`,
    `Strike: ${inst.strike} ${inst.optionType}`,
    ``,
    `📊 <b>Ichimoku Status</b>`,
    `Close: ${fmt(close)}`,
    `Cloud Top: ${fmt(cloudTop)}`,
    `Tenkan: ${fmt(tenkan)}`,
    `Kijun: ${fmt(kijun)}`,
    ``,
    `✅ Price above cloud`,
    `✅ Tenkan > Kijun (momentum up)`,
    ``,
    `TF: ${BULLISH_SCAN_INTERVAL}`,
  ].join('\n');

  try {
    await telegramNotifier.sendMessage(chatId, msg);
    console.log(`[IdxScanner] 📱 Bullish setup alert sent: ${inst.tradingsymbol}`);
  } catch (err) {
    console.warn(`[IdxScanner] Telegram failed:`, err.message);
  }
}

function _scanBullishSetups() {
  if (!isNseOpen()) return;

  const config = tradeStore.getConfig();
  if (!config.enabled) return;
  if (!config.bullishSetupAlertEnabled) return; // New config flag

  const allTokens = strikeManager.getAllTokens();
  if (allTokens.length === 0) return;

  for (const token of allTokens) {
    // Skip if already alerted today
    if (_isBullishSetupDuplicate(token)) continue;

    const candles = candleStore.getCandlesSync(token, BULLISH_SCAN_INTERVAL);
    if (!candles || candles.length < 52) continue;

    const inst = strikeManager.getInstrumentByToken(token);
    if (!inst) continue;

    // Calculate Ichimoku
    const results = calculateIchimoku(candles);
    if (!results || results.length === 0) continue;

    const last = results[results.length - 1];
    if (!last) continue;

    const { close, tenkan, kijun, cloudTop, cloudBottom, aboveCloud } = last;

    // Check conditions: price above cloud AND tenkan > kijun
    if (!aboveCloud) continue;
    if (tenkan == null || kijun == null) continue;
    if (cloudTop == null || close == null) continue;
    if (tenkan <= kijun) continue;

    // Proximity filter: price must be within 20% of cloud top
    // If price has moved too far above the cloud, it's not a fresh setup
    const distanceFromCloud = (close - cloudTop) / cloudTop;
    if (distanceFromCloud > 0.20) continue; // Skip if > 20% above cloud

    // All conditions met — mark as seen and send alert
    _markBullishSetupSeen(token);

    console.log(
      `[IdxScanner] 🟢 Bullish setup: ${inst.tradingsymbol} ` +
      `close=${close.toFixed(2)} T=${tenkan.toFixed(2)} K=${kijun.toFixed(2)} ` +
      `cloudTop=${cloudTop.toFixed(2)}`
    );

    // Send Telegram alert (fire-and-forget)
    _sendBullishSetupTelegram(inst, last).catch(() => {});

    // Also broadcast to UI
    broadcast('idx_bullish_setup', {
      token,
      symbol: inst.tradingsymbol,
      index: inst.index,
      strike: inst.strike,
      optionType: inst.optionType,
      close,
      tenkan,
      kijun,
      cloudTop,
      cloudBottom,
      ts: Date.now(),
    });
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

function _poll() {
  if (!isNseOpen()) return;

  const config = tradeStore.getConfig();
  if (!config.enabled) return;

  const allTokens = strikeManager.getAllTokens();
  if (allTokens.length === 0) return;

  _lastScanAt = Date.now();

  for (const token of allTokens) {
    for (const interval of INTERVALS) {
      const key = `${token}:${interval}`;
      const candles = candleStore.getCandlesSync(token, interval);
      if (!candles) continue;

      const count = candles.length;
      const prev = _lastCandleCount.get(key) || 0;

      if (count > prev && prev > 0) {
        // A new candle just closed — run scan
        _scanCount++;
        _scan(token, interval);
      }

      _lastCandleCount.set(key, count);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function start() {
  _pollTimer = setInterval(_poll, POLL_MS);
  _bullishScanTimer = setInterval(_scanBullishSetups, BULLISH_SCAN_POLL_MS);
  console.log(
    `[IdxScanner] Started — patterns=[${PATTERN_IDS.join(',')}] ` +
    `intervals=[${INTERVALS.join(',')}] poll=${POLL_MS}ms ` +
    `bullishScan=${BULLISH_SCAN_POLL_MS}ms`,
  );
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_bullishScanTimer) {
    clearInterval(_bullishScanTimer);
    _bullishScanTimer = null;
  }
}

function getStats() {
  return {
    scanning: !!_pollTimer,
    scanCount: _scanCount,
    matchCount: _matchCount,
    lastScanAt: _lastScanAt,
    patterns: PATTERN_IDS,
    intervals: INTERVALS,
    tokenCount: strikeManager.getAllTokens().length,
    dedupSize: _dedup.size,
  };
}

function clearDedup() {
  _dedup.clear();
  _telegramDedup.clear();
  _bullishSetupDedup.clear();
  _lastCandleCount.clear();
}

function getAlertHistory() {
  return _alertHistory;
}

module.exports = { start, stop, getStats, clearDedup, getAlertHistory };
