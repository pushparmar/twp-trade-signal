/**
 * Pattern Alert Watcher
 *
 * Runs every registered pattern on each 15m / 1h / 4h / 1d candle close
 * for index and macro instruments. Fires a Telegram message on first match.
 *
 * Deduplication:
 *   Each (token, interval, patternId, signal) is allowed to fire at most ONCE
 *   per trading day. It resets at midnight IST, so the same setup can alert
 *   again on the next session.
 *
 * 4h handling:
 *   Kite has no native 4h interval. When a '60minute' candle closes we
 *   synthesise 4h candles from the 1h buffer and run patterns on those too.
 */

const candleStore      = require('./candleStore');
const patternRegistry  = require('./patternRegistry');
const telegramNotifier = require('./telegramNotifier');
const store            = require('../store');

// Lazy-required to keep the same circular-dep pattern used in macroWatcher.
const { VIX_TOKEN, getFrontMonthFutures } = require('./macroAnalysis');

// ── Constants ────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Native intervals we care about — '60minute' also triggers the synthetic 4h check.
const WATCHED_INTERVALS = new Set(['15minute', '60minute', 'day']);

// Human-readable TF labels for Telegram messages
const TF_LABEL = {
  '15minute': '15m',
  '60minute': '1h',
  '4h':       '4h',
  'day':      '1d',
};

// ── State ────────────────────────────────────────────────────────────────────

// token (number) → display label, e.g. 256265 → 'NIFTY 50'
const _tokenLabel = new Map();

// Dedup: "token:interval:patternId:signal" → { fired: bool, date: string (IST) }
const _dedup = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Returns true if this combination has NOT yet fired today and marks it as fired.
 * Returns false if it already fired today (suppress duplicate alert).
 */
function _claimFire(key) {
  const today = _istDateStr();
  const entry = _dedup.get(key);
  if (entry && entry.date === today && entry.fired) return false;
  _dedup.set(key, { fired: true, date: today });
  return true;
}

/**
 * If the signal has cleared (matched → false), reset the dedup flag so the
 * NEXT time the same pattern fires on a fresh setup it can alert again.
 */
function _resetFire(key) {
  const today = _istDateStr();
  _dedup.set(key, { fired: false, date: today });
}

// Synthesise 4h candles from consecutive 1h candles (same as macroAnalysis.js)
function _to4H(candles1h) {
  const out = [];
  for (let i = 0; i + 3 < candles1h.length; i += 4) {
    const slice = candles1h.slice(i, i + 4);
    out.push({
      date:  slice[0].date,
      open:  slice[0].open,
      high:  Math.max(...slice.map((c) => c.high)),
      low:   Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return out;
}

// ── Alert builder ────────────────────────────────────────────────────────────

async function _runAndAlert(token, interval, candles) {
  const chatId = store.getTelegramChatId();
  if (!chatId) return; // Telegram not configured — nothing to do

  const label   = _tokenLabel.get(Number(token)) || `Token ${token}`;
  const tfLabel = TF_LABEL[interval] || interval;

  for (const { id: patternId, label: patternLabel } of patternRegistry.list()) {
    const pattern = patternRegistry.get(patternId);

    let result;
    try {
      result = pattern.run(candles, pattern.defaultOpts);
    } catch {
      continue; // bad candle data — skip silently
    }

    if (!result?.matched || !result.signal) {
      // Pattern no longer active — reset dedup so next trigger can fire
      _resetFire(`${token}:${interval}:${patternId}:bullish`);
      _resetFire(`${token}:${interval}:${patternId}:bearish`);
      continue;
    }

    const dedupKey = `${token}:${interval}:${patternId}:${result.signal}`;
    if (!_claimFire(dedupKey)) continue; // already sent today

    // ── Build Telegram message ───────────────────────────────────────────
    const emoji   = result.signal === 'bullish' ? '🟢' : '🔴';
    const sigText = result.signal.toUpperCase();

    const lines = [
      `${emoji} <b>${patternLabel}</b>`,
      ``,
      `📊 <b>${label}</b>  ·  ${tfLabel}`,
      `Signal : <b>${sigText}</b>`,
    ];

    if (result.score != null)        lines.push(`Score  : ${result.score}/5`);
    if (result.close != null)        lines.push(`Price  : ${result.close}`);
    if (result.barsAgo != null)      lines.push(`Breakout : ${result.barsAgo} bar${result.barsAgo !== 1 ? 's' : ''} ago`);
    if (result.twistBarsAgo != null) lines.push(`Twist  : ${result.twistBarsAgo} bar${result.twistBarsAgo !== 1 ? 's' : ''} ago`);

    // Individual check summary — tick/cross per check
    if (result.checks) {
      const CHECK_SHORT = {
        kumoBreakout: 'Breakout',
        cloudColor:   'Cloud',
        kumoTwist:    'Twist',
        chikou:       'Chikou',
        kijun:        'Kijun',
      };
      const checkParts = Object.entries(result.checks).map(([k, v]) => {
        const name = CHECK_SHORT[k] || k;
        return `${v === result.signal ? '✅' : '❌'} ${name}`;
      });
      lines.push(``, checkParts.join('  '));
    }

    try {
      await telegramNotifier.sendMessage(chatId, lines.join('\n'));
      console.log(`[PatternAlert] ✅ ${patternId} ${result.signal} — ${label} (${tfLabel})`);
    } catch (err) {
      console.warn(`[PatternAlert] Telegram send failed for ${label}:`, err.message);
    }

    // Broadcast to SSE clients so the Scanner tab updates in real time,
    // regardless of whether Telegram succeeded.
    broadcast('scan_alert', {
      token:        Number(token),
      label,
      interval,
      tfLabel,
      patternId,
      patternLabel,
      signal:       result.signal,
      score:        result.score  ?? null,
      close:        result.close  ?? null,
      ts:           Date.now(),
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by kiteTicker on every candle close.
 * Returns immediately for intervals / tokens we don't watch.
 */
async function onCandleClose(token, interval) {
  if (!WATCHED_INTERVALS.has(interval)) return;
  if (!_tokenLabel.has(Number(token)))   return;

  try {
    // ── Native interval (15m / 1h / 1d) ───────────────────────────────────
    const candles = candleStore.getCandlesSync(token, interval);
    if (candles && candles.length >= 52) {
      await _runAndAlert(token, interval, candles);
    }

    // ── Synthetic 4h: run whenever a 1h candle closes ─────────────────────
    if (interval === '60minute') {
      const c1h = candleStore.getCandlesSync(token, '60minute');
      if (c1h && c1h.length >= 8) {
        const c4h = _to4H(c1h);
        if (c4h.length >= 52) {
          await _runAndAlert(token, '4h', c4h);
        }
      }
    }
  } catch (err) {
    console.warn(`[PatternAlert] Unhandled error on ${token}:${interval} —`, err.message);
  }
}

/**
 * Register index and macro tokens to watch, then pre-seed their candle buffers.
 * Must be called AFTER instrumentCache has loaded so getFrontMonthFutures works.
 */
function start() {
  // ── Index instruments ──────────────────────────────────────────────────
  _tokenLabel.set(256265, 'NIFTY 50');
  _tokenLabel.set(260105, 'NIFTY BANK');

  // ── Macro instruments ──────────────────────────────────────────────────
  _tokenLabel.set(VIX_TOKEN, 'India VIX');

  const crudeInst  = getFrontMonthFutures('CRUDEOIL', 'MCX');
  const goldInst   = getFrontMonthFutures('GOLD',     'MCX');
  const silverInst = getFrontMonthFutures('SILVER',   'MCX');
  const usdinrInst = getFrontMonthFutures('USDINR',   'CDS');

  if (crudeInst)  _tokenLabel.set(crudeInst.instrumentToken,  `Crude Oil (${crudeInst.tradingsymbol})`);
  if (goldInst)   _tokenLabel.set(goldInst.instrumentToken,   `Gold (${goldInst.tradingsymbol})`);
  if (silverInst) _tokenLabel.set(silverInst.instrumentToken, `Silver (${silverInst.tradingsymbol})`);
  if (usdinrInst) _tokenLabel.set(usdinrInst.instrumentToken, `USD/INR (${usdinrInst.tradingsymbol})`);

  // ── Pre-seed candle buffers for every watched token × interval ─────────
  // Without this, getCandlesSync() always returns null for macro tokens and
  // pattern alerts for those instruments never fire.
  // Index tokens (NIFTY/BANKNIFTY) are already seeded by indexSignalWatcher,
  // but seeding them here is safe — getCandles() deduplicates concurrent requests.
  const seedIntervals = ['15minute', '60minute', 'day'];
  for (const [token] of _tokenLabel) {
    for (const interval of seedIntervals) {
      candleStore.getCandles(token, interval).catch((err) => {
        console.warn(`[PatternAlert] Seed failed ${token}:${interval} —`, err.message);
      });
    }
  }

  const patterns = patternRegistry.list().map((p) => p.label).join(', ');
  console.log(`[PatternAlert] Ready — watching ${_tokenLabel.size} instruments on 15m / 1h / 4h / 1d`);
  console.log(`[PatternAlert] Patterns: ${patterns}`);
}

module.exports = { start, onCandleClose };
