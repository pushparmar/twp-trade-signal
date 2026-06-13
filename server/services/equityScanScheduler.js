/**
 * equityScanScheduler.js
 *
 * Simple daily equity scan scheduler:
 *
 * 1. Daily at 11:55 PM IST → Update candles (fetch latest from Kite, merge FIFO)
 * 2. Then run scan on updated candles → Store results to MongoDB
 *
 * UI requests just read cached results — no live scanning needed.
 */

const equityScanService = require('./equityScanService');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let _scheduledTimeout = null;

/**
 * Schedule the next daily update at 11:55 PM IST.
 */
function _scheduleNext() {
  if (_scheduledTimeout) {
    clearTimeout(_scheduledTimeout);
    _scheduledTimeout = null;
  }

  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const todayIST = new Date(nowIST);
  todayIST.setUTCHours(23, 55, 0, 0); // 11:55 PM IST

  let targetTime = todayIST;

  // If we're already past 11:55 PM today, schedule for tomorrow
  if (nowIST.getTime() >= todayIST.getTime()) {
    targetTime = new Date(todayIST.getTime() + 24 * 60 * 60 * 1000);
  }

  const delayMs = targetTime.getTime() - Date.now();
  const hours = Math.floor(delayMs / (60 * 60 * 1000));
  const mins = Math.floor((delayMs % (60 * 60 * 1000)) / (60 * 1000));

  console.log(`[EquityScanScheduler] Next daily update in ${hours}h ${mins}m (11:55 PM IST)`);

  _scheduledTimeout = setTimeout(async () => {
    console.log('[EquityScanScheduler] ═══════════════════════════════════════════════════════════════');
    console.log('[EquityScanScheduler] Starting daily equity update at 11:55 PM IST');
    try {
      // Step 1: Update candles (fetch latest from Kite, merge FIFO into MongoDB)
      console.log('[EquityScanScheduler] Step 1: Updating candle cache...');
      await equityScanService.updateCandles();

      // Step 2: Run scan on updated candles + store results
      console.log('[EquityScanScheduler] Step 2: Running pattern scan...');
      await equityScanService.runAndStore();

      console.log('[EquityScanScheduler] Daily update complete');
    } catch (err) {
      console.error('[EquityScanScheduler] Daily update failed:', err.message);
    }
    console.log('[EquityScanScheduler] ═══════════════════════════════════════════════════════════════');
    // Schedule the next run (tomorrow at 11:55 PM)
    _scheduleNext();
  }, delayMs);
}

/**
 * Initialize the scheduler on server start.
 */
function init() {
  console.log('[EquityScanScheduler] Initializing daily equity scan scheduler');
  _scheduleNext();
}

/**
 * Stop the scheduler (cleanup on server shutdown).
 */
function stop() {
  if (_scheduledTimeout) {
    clearTimeout(_scheduledTimeout);
    _scheduledTimeout = null;
    console.log('[EquityScanScheduler] Scheduler stopped');
  }
}

module.exports = { init, stop };
