/**
 * signalOutcomeTracker.js
 *
 * Phase 2 data collection — tracks every fired signal candle-by-candle for
 * 20 bars, recording the price path, MFE/MAE, and outcome (target_hit /
 * sl_hit / expired).
 *
 * Two responsibilities:
 *
 * 1. **At signal time** (alertBus 'alert' event):
 *    - Reads the enriched alert payload (Ichimoku snapshot, ATR, RSI, context
 *      fields already attached by backgroundScanner / patternAlertWatcher).
 *    - Inserts a pending `signal_outcomes` document in MongoDB.
 *    - Registers an in-memory observation for candle-by-candle tracking.
 *
 * 2. **Per candle close** (called from kiteTicker.js candle-close callback):
 *    - For each active observation matching (token, interval):
 *      a. Reads the latest closed candle from candleStore.
 *      b. Computes R-multiples (rClose, rHigh, rLow) relative to entry.
 *      c. Updates running MFE/MAE and milestone bars.
 *      d. Checks for target_hit, sl_hit, or expiry at 20 bars.
 *      e. Resolves the outcome or saves progress every 5 bars.
 *
 * On boot, pending observations are recovered from MongoDB so 1h/4h/day
 * signals that span multiple trading sessions are not lost on server restart.
 *
 * Zero impact on trading logic — this service is a passive observer.
 */

const alertBus   = require('./alertBus');
const candleStore = require('./candleStore');
const db         = require('../db');

// ── In-memory observation state ──────────────────────────────────────────────
// Key: `${token}:${interval}:${mongoId}`
// Value: { id, token, interval, signal, entry, sl, target, riskPerUnit,
//          barCount, mfeR, maeR, pricePath, breakEvenBar, firstR1Bar, firstR2Bar }
const _observations = new Map();

// ── Path shape classification ────────────────────────────────────────────────

function _classifyPath(maeR, mfeR, outcome) {
  if (maeR < -0.3 && outcome === 'target_hit') return 'dip_then_run';
  if (mfeR > 0.8  && outcome === 'sl_hit')     return 'run_then_reverse';
  if (mfeR > 1.5  && outcome === 'target_hit') return 'straight_run';
  return 'choppy';
}

// ── Boot: recover pending observations from MongoDB ──────────────────────────

async function _recoverPending() {
  try {
    const pending = await db.signalOutcomeRepo.findPending();
    let recovered = 0;
    for (const doc of pending) {
      const entry       = doc.closeAtSignal;
      const sl          = doc.sl;
      const target      = doc.target;
      if (!entry || !sl || !target) continue;

      const riskPerUnit = Math.abs(entry - sl);
      if (riskPerUnit < 0.01) continue;

      const key = `${doc.token}:${doc.interval}:${doc._id}`;
      _observations.set(key, {
        id:           doc._id.toString(),
        token:        doc.token,
        interval:     doc.interval,
        signal:       doc.signal,
        entry,
        sl,
        target,
        riskPerUnit,
        barCount:     doc.pricePath?.length ?? 0,
        mfeR:         doc.mfeR  ?? 0,
        maeR:         doc.maeR  ?? 0,
        pricePath:    doc.pricePath ?? [],
        breakEvenBar: doc.breakEvenBar ?? null,
        firstR1Bar:   doc.firstR1Bar   ?? null,
        firstR2Bar:   doc.firstR2Bar   ?? null,
      });
      recovered++;
    }
    if (recovered > 0) {
      console.log(`[SignalOutcomeTracker] ♻️  Recovered ${recovered} pending observation(s) from MongoDB`);
    }
  } catch (err) {
    console.warn('[SignalOutcomeTracker] Recovery from MongoDB failed:', err.message);
  }
}

// ── Alert listener — inserts pending document at signal time ─────────────────

function _onAlert(alert, source) {
  const entry = alert.close;
  const sl    = alert.sl;
  const target = alert.target;
  if (!entry || !sl || !target) return;

  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit < 0.01) return;

  const riskPct   = +(Math.abs(entry - sl) / entry * 100).toFixed(2);
  const rewardPct = +(Math.abs(target - entry) / entry * 100).toFixed(2);
  const rrRatio   = +(Math.abs(target - entry) / riskPerUnit).toFixed(2);

  const doc = {
    // ── Link
    token:             Number(alert.token),
    symbol:            alert.tradingsymbol ?? alert.label ?? null,
    exchange:          alert.exchange      ?? null,
    patternId:         alert.patternId     ?? null,
    signal:            alert.signal        ?? null,
    interval:          alert.interval      ?? null,
    tfLabel:           alert.tfLabel       ?? null,
    score:             alert.score         ?? null,
    firedAt:           new Date(alert.ts || Date.now()),

    // ── Entry levels
    closeAtSignal:     entry,
    sl,
    target,
    riskPct,
    rewardPct,
    rrRatio,

    // ── Ichimoku snapshot (enriched at source — no recompute)
    tenkan:            alert.tenkan            ?? null,
    kijun:             alert.kijun             ?? null,
    senkouA:           alert.senkouA           ?? null,
    senkouB:           alert.senkouB           ?? null,
    cloudTop:          alert.cloudTop          ?? null,
    cloudBottom:       alert.cloudBottom       ?? null,
    cloudThicknessPct: alert.cloudThicknessPct ?? null,
    futureCloudColor:  alert.futureCloudColor  ?? null,
    priceVsCloud:      alert.priceVsCloud      ?? null,
    tkCross:           alert.tkCross           ?? null,

    // ── Market context
    dayOfWeek:         alert.dayOfWeek         ?? null,
    hourIST:           alert.hourIST           ?? null,
    sessionSlot:       alert.sessionSlot       ?? null,
    niftyBias:         alert.niftyBias         ?? null,

    // ── Volume + momentum
    volumeRatio:       alert.volumeRatio       ?? null,
    volumeConfirmed:   alert.volumeConfirmed   ?? null,
    atr14:             alert.atr14             ?? null,
    atr14Pct:          alert.atr14Pct          ?? null,
    rsi14:             alert.rsi14             ?? null,

    // ── MTF alignment
    mtfAligned:        alert.mtfAligned        ?? false,
    alignedTfs:        alert.alignedTfs        ?? [],
    alignedTfCount:    alert.alignedTfCount    ?? 0,

    // ── Tracking state (filled candle-by-candle)
    pricePath:         [],
    outcome:           null,
    mfeR:              0,
    maeR:              0,
    returnFromMfeR:    null,
    breakEvenBar:      null,
    firstR1Bar:        null,
    firstR2Bar:        null,
    pathShape:         null,
    exitPrice:         null,
    exitAt:            null,
    barsToExit:        null,
    resolvedAt:        null,
    source:            source ?? 'background',
  };

  db.signalOutcomeRepo.insert(doc).then((insertedId) => {
    if (!insertedId) return; // DB insert failed — skip tracking

    const key = `${alert.token}:${alert.interval}:${insertedId}`;
    _observations.set(key, {
      id:           insertedId,
      token:        Number(alert.token),
      interval:     alert.interval,
      signal:       alert.signal,
      entry,
      sl,
      target,
      riskPerUnit,
      barCount:     0,
      mfeR:         0,
      maeR:         0,
      pricePath:    [],
      breakEvenBar: null,
      firstR1Bar:   null,
      firstR2Bar:   null,
    });
  }).catch((err) => {
    console.warn('[SignalOutcomeTracker] insert failed:', err.message);
  });
}

// ── Candle close handler — appends bar, checks outcome ───────────────────────

function onCandleClose(token, interval) {
  const numToken = Number(token);

  for (const [key, obs] of _observations) {
    if (obs.token !== numToken || obs.interval !== interval) continue;

    const candles = candleStore.getCandlesSync(token, interval);
    if (!candles || candles.length === 0) continue;

    // Latest closed candle — candleStore returns historical + current;
    // the last entry is the just-closed candle.
    const c = candles[candles.length - 1];
    if (!c || c.close == null) continue;

    obs.barCount++;

    const isBullish = obs.signal === 'bullish';

    // R-multiples: positive = favorable direction, negative = adverse
    const rClose = isBullish
      ? (c.close - obs.entry) / obs.riskPerUnit
      : (obs.entry - c.close) / obs.riskPerUnit;
    const rHigh = isBullish
      ? (c.high - obs.entry) / obs.riskPerUnit
      : (obs.entry - c.low) / obs.riskPerUnit;
    const rLow = isBullish
      ? (c.low - obs.entry) / obs.riskPerUnit
      : (obs.entry - c.high) / obs.riskPerUnit;

    // Update running extremes
    obs.mfeR = Math.max(obs.mfeR, rHigh);
    obs.maeR = Math.min(obs.maeR, rLow);

    // Milestone bars — set on first occurrence only
    if (obs.breakEvenBar == null && rClose > 0)  obs.breakEvenBar = obs.barCount;
    if (obs.firstR1Bar   == null && rHigh >= 1.0) obs.firstR1Bar  = obs.barCount;
    if (obs.firstR2Bar   == null && rHigh >= 2.0) obs.firstR2Bar  = obs.barCount;

    obs.pricePath.push({
      bar:       obs.barCount,
      open:      c.open,
      high:      c.high,
      low:       c.low,
      close:     c.close,
      rMultiple: +rClose.toFixed(3),
      highR:     +rHigh.toFixed(3),
      lowR:      +rLow.toFixed(3),
    });

    // ── Check outcome ──────────────────────────────────────────────────────
    let outcome   = null;
    let exitPrice = null;

    if (isBullish) {
      if (c.high >= obs.target) { outcome = 'target_hit'; exitPrice = obs.target; }
      else if (c.low <= obs.sl) { outcome = 'sl_hit';     exitPrice = obs.sl; }
    } else {
      if (c.low <= obs.target)  { outcome = 'target_hit'; exitPrice = obs.target; }
      else if (c.high >= obs.sl) { outcome = 'sl_hit';    exitPrice = obs.sl; }
    }

    if (!outcome && obs.barCount >= 20) {
      outcome   = 'expired';
      exitPrice = c.close;
    }

    if (outcome) {
      // Compute exit R and returnFromMfeR
      const exitR = isBullish
        ? (exitPrice - obs.entry) / obs.riskPerUnit
        : (obs.entry - exitPrice) / obs.riskPerUnit;
      const returnFromMfeR = +(obs.mfeR - exitR).toFixed(3);
      const pathShape = _classifyPath(obs.maeR, obs.mfeR, outcome);

      db.signalOutcomeRepo.resolve(obs.id, {
        outcome,
        exitPrice,
        exitAt:         new Date(),
        barsToExit:     obs.barCount,
        mfeR:           +obs.mfeR.toFixed(3),
        maeR:           +obs.maeR.toFixed(3),
        returnFromMfeR,
        breakEvenBar:   obs.breakEvenBar,
        firstR1Bar:     obs.firstR1Bar,
        firstR2Bar:     obs.firstR2Bar,
        pathShape,
        pricePath:      obs.pricePath,
        resolvedAt:     new Date(),
      });

      _observations.delete(key);

      const emoji = outcome === 'target_hit' ? '🎯'
        : outcome === 'sl_hit' ? '🛑' : '⏰';
      console.log(
        `[SignalOutcomeTracker] ${emoji} ${outcome} — ${obs.signal} ` +
        `${interval} bar ${obs.barCount} | MFE ${obs.mfeR.toFixed(2)}R ` +
        `MAE ${obs.maeR.toFixed(2)}R | returnFromMFE ${returnFromMfeR}R | ${pathShape}`,
      );
    } else if (obs.barCount % 5 === 0) {
      // Progress save every 5 bars — prevents data loss on server restart
      db.signalOutcomeRepo.updateProgress(obs.id, {
        pricePath: obs.pricePath,
        mfeR:      +obs.mfeR.toFixed(3),
        maeR:      +obs.maeR.toFixed(3),
        breakEvenBar: obs.breakEvenBar,
        firstR1Bar:   obs.firstR1Bar,
        firstR2Bar:   obs.firstR2Bar,
      });
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the tracker — recover pending observations from MongoDB, then
 * subscribe to alertBus for new signals.
 */
async function start() {
  await _recoverPending();
  alertBus.on('alert', _onAlert);
  console.log('[SignalOutcomeTracker] ✅ Started — listening on alertBus');
}

/**
 * Current count of active (pending) observations in memory.
 * Useful for diagnostics.
 */
function pendingCount() {
  return _observations.size;
}

module.exports = { start, onCandleClose, pendingCount };
