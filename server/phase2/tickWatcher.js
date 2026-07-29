/**
 * phase2/tickWatcher.js
 *
 * Real-time level watcher for the Phase-2 index-option strikes.
 *
 * Why: the scheduled scans (5m/15m/1h) compute setups and their levels
 * (entry / SL / target), but a level can be hit BETWEEN scans. This watcher
 * subscribes every strike in the universe to the live ticker each morning
 * and fires an instant Telegram + SSE alert the moment price crosses a
 * known level — no waiting for the next candle close.
 *
 * Flow:
 *   1. Morning (09:16 IST, weekdays): build strike universe → subscribe all
 *      tokens to kiteTicker (also runs immediately on start if market open).
 *   2. Each scan cycle calls updateLevels(interval, matches) — levels are
 *      kept per token (bullish setups only — option-buyer rule).
 *   3. kiteTicker's tick loop calls onTick(token, ltp) for every tick.
 *      Upward cross of entry/target, downward cross of SL → instant alert.
 *      Each level alerts once per IST day (dedup).
 */

const kiteTicker = require('../services/kiteTicker');
const telegramNotifier = require('../services/telegramNotifier');
const mainStore = require('../store');
const { broadcast } = require('../sseHub');
const { isNseOpen } = require('../utils/marketHours');
const strikeUniverse = require('./strikeUniverse');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MIN_RR = 2; // only watch setups worth alerting (1:2 minimum)

// ── State ────────────────────────────────────────────────────────────────────

let _running = false;
let _morningTimer = null;
const _subscribed = new Set();          // tokens we've subscribed this session
const _levels = new Map();              // token → Map<levelKey, levelObj>
const _lastTick = new Map();            // token → last seen ltp
const _alertDedup = new Map();          // levelKey:levelType → IST date

function _istDate() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Morning subscription ─────────────────────────────────────────────────────

async function subscribeUniverse() {
  try {
    const { instruments } = await strikeUniverse.getUniverse(true);
    if (!instruments.length) {
      console.warn('[Phase2Ticks] Universe empty — skipping subscribe');
      return 0;
    }

    const fresh = instruments.map((i) => i.token).filter((t) => !_subscribed.has(t));
    if (fresh.length) {
      kiteTicker.subscribe(fresh);
      fresh.forEach((t) => _subscribed.add(t));
    }
    console.log(`[Phase2Ticks] Subscribed ${fresh.length} new strike tokens (${_subscribed.size} total)`);
    return fresh.length;
  } catch (err) {
    console.warn('[Phase2Ticks] subscribeUniverse failed:', err.message);
    return 0;
  }
}

/** ms until the next weekday 09:16 IST */
function _msUntilMorning() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const target = new Date(nowIst);
  target.setUTCHours(9, 16, 0, 0); // treat as IST wall-clock (we're in shifted space)

  if (target.getTime() <= nowIst.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Skip Sat(6)/Sun(0)
  while ([0, 6].includes(target.getUTCDay())) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - nowIst.getTime();
}

function _armMorningTimer() {
  const ms = _msUntilMorning();
  _morningTimer = setTimeout(async () => {
    await subscribeUniverse();
    _armMorningTimer(); // re-arm for the next trading day
  }, ms);
  console.log(`[Phase2Ticks] Morning subscribe armed — fires in ${Math.round(ms / 60000)} min`);
}

// ── Levels ───────────────────────────────────────────────────────────────────

/**
 * Replace the levels for one interval from a scan's matches.
 * Bullish setups with R:R ≥ MIN_RR only. Levels persist until the same
 * pattern+interval produces a new result for that token.
 */
function updateLevels(interval, matches) {
  // Drop existing levels for this interval first (fresh scan supersedes)
  for (const levelMap of _levels.values()) {
    for (const key of levelMap.keys()) {
      if (key.endsWith(`:${interval}`)) levelMap.delete(key);
    }
  }

  let count = 0;
  for (const m of matches || []) {
    if (m.signal !== 'bullish') continue;
    if (!m.rr || m.rr < MIN_RR) continue;
    if (m.entry == null) continue;

    const key = `${m.pattern}:${interval}`;
    let levelMap = _levels.get(m.token);
    if (!levelMap) {
      levelMap = new Map();
      _levels.set(m.token, levelMap);
    }
    levelMap.set(key, {
      token: m.token,
      tradingsymbol: m.tradingsymbol,
      index: m.index,
      strike: m.strike,
      optionType: m.optionType,
      expiryBucket: m.expiryBucket,
      pattern: m.pattern,
      interval,
      tfLabel: m.tfLabel,
      entry: m.entry,
      sl: m.sl,
      target: m.target,
      rr: m.rr,
    });
    count++;
  }
  if (count) console.log(`[Phase2Ticks] Watching ${count} level sets for ${interval}`);
}

// ── Tick handling ────────────────────────────────────────────────────────────

async function _alert(level, type, price, ltp) {
  // Group-level dedup: adjacent strikes hit their levels together, so only
  // the FIRST strike of an (index + optionType + pattern + interval) group
  // alerts per level type per day — the rest are near-duplicates.
  const dedupKey = `${level.index}:${level.optionType}:${level.pattern}:${level.interval}:${type}`;
  if (_alertDedup.get(dedupKey) === _istDate()) return;
  _alertDedup.set(dedupKey, _istDate());

  const patternName = level.pattern === 'kumo-breakout' ? 'Kumo Breakout' : 'TK Reversion';
  const emoji = type === 'ENTRY' ? '🎯' : type === 'TARGET' ? '🏁' : '🛑';

  broadcast('phase2_level_hit', { ...level, levelType: type, levelPrice: price, ltp, ts: Date.now() });

  const chatId = mainStore.getTelegramChatId();
  if (!chatId) return;

  const msg = [
    `${emoji} <b>${type} HIT</b> — ${patternName} (Phase-2)`,
    ``,
    `<b>${level.tradingsymbol}</b>`,
    `${level.index} ${level.strike} ${level.optionType} · ${level.expiryBucket}`,
    ``,
    `Level: ₹${price.toFixed(2)}  |  LTP: ₹${ltp.toFixed(2)}`,
    `Entry: ₹${level.entry.toFixed(2)} · SL: ₹${level.sl?.toFixed(2) ?? '—'} · Target: ₹${level.target?.toFixed(2) ?? '—'}`,
    `R:R: 1:${level.rr?.toFixed(1) ?? '—'} · TF: ${level.tfLabel}`,
  ].join('\n');

  try {
    await telegramNotifier.sendMessage(chatId, msg);
    console.log(`[Phase2Ticks] ${emoji} ${type} hit alert: ${level.tradingsymbol} @ ${ltp}`);
  } catch (err) {
    console.warn('[Phase2Ticks] Telegram failed:', err.message);
  }
}

/**
 * Called from kiteTicker's tick loop for every tick.
 * Cheap early-outs keep this safe on the hot path.
 */
function onTick(token, ltp) {
  if (!_running || ltp == null) return;
  const levelMap = _levels.get(token);
  if (!levelMap || levelMap.size === 0) {
    _lastTick.set(token, ltp);
    return;
  }

  const prev = _lastTick.get(token);
  _lastTick.set(token, ltp);
  if (prev == null) return; // need a previous tick to detect a cross

  for (const level of levelMap.values()) {
    // Upward cross of entry — the setup has triggered
    if (prev < level.entry && ltp >= level.entry) {
      _alert(level, 'ENTRY', level.entry, ltp).catch(() => {});
    }
    // Upward cross of target
    if (level.target != null && prev < level.target && ltp >= level.target) {
      _alert(level, 'TARGET', level.target, ltp).catch(() => {});
    }
    // Downward cross of SL
    if (level.sl != null && prev > level.sl && ltp <= level.sl) {
      _alert(level, 'SL', level.sl, ltp).catch(() => {});
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function start() {
  if (_running) return;
  _running = true;

  _armMorningTimer();
  if (isNseOpen()) {
    subscribeUniverse().catch(() => {});
  }
  console.log('[Phase2Ticks] Level watcher started');
}

function stop() {
  _running = false;
  if (_morningTimer) {
    clearTimeout(_morningTimer);
    _morningTimer = null;
  }
  console.log('[Phase2Ticks] Level watcher stopped');
}

function getStatus() {
  let levelCount = 0;
  for (const m of _levels.values()) levelCount += m.size;
  return {
    running: _running,
    subscribedTokens: _subscribed.size,
    watchedLevelSets: levelCount,
  };
}

module.exports = { start, stop, onTick, updateLevels, subscribeUniverse, getStatus };
