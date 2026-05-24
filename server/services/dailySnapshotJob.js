/**
 * dailySnapshotJob.js
 *
 * Writes one document per trading day to `daily_market_snapshots` at 15:31 IST.
 * Captures NIFTY close, signal count, and resolved outcome count for the day.
 *
 * Runs on a 1-minute setInterval — no cron dependency needed. The guard
 * `_lastWrittenDate` prevents duplicate writes if the server stays up.
 */

const candleStore = require('./candleStore');
const { getFutureCloudColor } = require('./ichimoku');
const mongo       = require('./mongoClient');
const db          = require('../db');

const COLLECTION   = 'daily_market_snapshots';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// NIFTY 50 instrument token on NSE
const NIFTY_TOKEN = 256265;

let _interval     = null;
let _lastWrittenDate = null; // 'YYYY-MM-DD' — prevents duplicate writes

// ── Core logic ───────────────────────────────────────────────────────────────

async function _maybeWrite() {
  if (!mongo.isReady()) return;

  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const hour   = nowIST.getHours();
  const minute = nowIST.getMinutes();
  const day    = nowIST.getDay(); // 0=Sun … 6=Sat

  // Only fire at 15:31 IST on weekdays (Mon–Fri)
  if (day === 0 || day === 6) return;
  if (hour !== 15 || minute !== 31) return;

  const dateIST = nowIST.toISOString().slice(0, 10);
  if (_lastWrittenDate === dateIST) return; // already written today
  _lastWrittenDate = dateIST;

  try {
    // NIFTY close from daily candle store
    const niftyCandles = candleStore.getCandlesSync(NIFTY_TOKEN, 'day');
    let niftyClose     = null;
    let niftyChangePct = null;
    let niftyBias      = null;

    if (niftyCandles && niftyCandles.length >= 2) {
      const today     = niftyCandles[niftyCandles.length - 1];
      const yesterday = niftyCandles[niftyCandles.length - 2];
      niftyClose     = today.close;
      niftyChangePct = yesterday.close
        ? +((today.close - yesterday.close) / yesterday.close * 100).toFixed(2)
        : null;
    }

    if (niftyCandles && niftyCandles.length >= 52) {
      niftyBias = getFutureCloudColor(niftyCandles); // 'bullish' | 'bearish' | 'neutral'
    }

    // Count today's signals from scan_alerts
    let totalSignals = 0;
    try {
      const dayStart = new Date(`${dateIST}T00:00:00+05:30`);
      const dayEnd   = new Date(`${dateIST}T23:59:59+05:30`);
      totalSignals = await mongo.db().collection('scan_alerts').countDocuments({
        firedAt: { $gte: dayStart, $lte: dayEnd },
      });
    } catch { /* count unavailable — leave as 0 */ }

    // Count today's resolved signal outcomes
    const resolvedOutcomes = await db.signalOutcomeRepo.countResolvedOnDate(dateIST);

    const doc = {
      dateIST,
      niftyClose,
      niftyChangePct,
      niftyBias,
      totalSignals,
      resolvedOutcomes,
      createdAt: new Date(),
    };

    await mongo.db().collection(COLLECTION).insertOne(doc);
    console.log(
      `[DailySnapshot] 📊 ${dateIST} — NIFTY ₹${niftyClose ?? '?'} ` +
      `(${niftyChangePct ?? '?'}%) | ${totalSignals} signals | ${resolvedOutcomes} resolved`,
    );
  } catch (err) {
    console.warn('[DailySnapshot] Write failed:', err.message);
    // Reset so it retries next minute
    _lastWrittenDate = null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function start() {
  if (_interval) return; // already running
  _interval = setInterval(_maybeWrite, 60_000); // check every minute
  console.log('[DailySnapshot] ✅ Started — writes at 15:31 IST on weekdays');
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop };
