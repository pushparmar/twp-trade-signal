/**
 * equityScanScheduler.js
 *
 * Schedules the equity scan to run once daily at 11:55 PM IST.
 *
 * The scan runs on:
 * - Manual trigger via API endpoint
 * - Scheduled at 23:55 IST (11:55 PM) every night
 */

const equityScanService = require('./equityScanService');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let _scheduledTimeout = null;

/**
 * Schedule the next scan run at 11:55 PM IST.
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

  console.log(`[EquityScanScheduler] Next scan scheduled in ${hours}h ${mins}m (11:55 PM IST)`);

  _scheduledTimeout = setTimeout(async () => {
    console.log('[EquityScanScheduler] Running scheduled equity scan at 11:55 PM IST');
    try {
      await equityScanService.run();
      console.log('[EquityScanScheduler] Scheduled scan started successfully');
    } catch (err) {
      console.error('[EquityScanScheduler] Scheduled scan failed:', err.message);
    }
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
