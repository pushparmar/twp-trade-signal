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
const { getRSI }      = require('../services/ichimoku');

const strikeManager = require('./strikeManager');
const orderManager  = require('./orderManager');
const tradeStore    = require('./tradeStore');

// ── Config ──────────────────────────────────────────────────────────────────

const PATTERN_IDS = ['tk-reversion', 'kumo-breakout'];
const INTERVALS   = ['minute', '5minute', '15minute'];
const POLL_MS     = 2000; // check for new candles every 2 seconds

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────────

const _lastCandleCount = new Map(); // "token:interval" → candle count
const _dedup = new Map();           // "token:interval:patternId:signal" → IST date string
const _alertHistory = [];           // last 100 alerts in-memory for page refresh
const MAX_HISTORY = 100;
let _pollTimer = null;
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

const TF_LABEL = { minute: '1m', '5minute': '5m', '15minute': '15m' };

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

      const signalPayload = {
        token,
        index: inst.index,
        symbol: inst.tradingsymbol,
        strike: inst.strike,
        optionType: inst.optionType,
        exchange: inst.exchange,
        lotSize: inst.lotSize,
        patternId,
        patternLabel: pattern.label,
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

      // Trigger order
      orderManager.onSignal(signalPayload);
    } catch (err) {
      // Pattern errors should never crash the scanner
      console.warn(`[IdxScanner] ${patternId} error on ${token}/${interval}:`, err.message);
    }
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
  console.log(
    `[IdxScanner] Started — patterns=[${PATTERN_IDS.join(',')}] ` +
    `intervals=[${INTERVALS.join(',')}] poll=${POLL_MS}ms`,
  );
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
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
  _lastCandleCount.clear();
}

function getAlertHistory() {
  return _alertHistory;
}

module.exports = { start, stop, getStats, clearDedup, getAlertHistory };
