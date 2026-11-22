/**
 * reportScheduler.js
 * Lightweight, zero-dependency cron scheduler for RSB Despatch automated email reports.
 * 
 * Scheduled Jobs:
 *  1. Shift Daily Report: Fires every day at 06:00 AM IST (covering previous 24h)
 *  2. Monthly Consolidated Report: Fires on the 1st of every month at 06:00 AM IST
 */

import { sendDailyReport, sendMonthlyReport } from './mailService.js';

let schedulerInterval = null;
let lastDailyRunDate = null;
let lastMonthlyRunKey = null;

export function initReportScheduler() {
  if (schedulerInterval) return;

  console.log('[Scheduler] Initializing automated daily & monthly email report scheduler (IST timezone)...');

  // Check every 60 seconds
  schedulerInterval = setInterval(async () => {
    try {
      // Get current date/time in Asia/Kolkata (IST, UTC+5:30)
      const istString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const istDate = new Date(istString);

      const hours = istDate.getHours();
      const minutes = istDate.getMinutes();
      const dayOfMonth = istDate.getDate();
      const month = istDate.getMonth() + 1;
      const year = istDate.getFullYear();

      const todayDateKey = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
      const thisMonthKey = `${year}-${String(month).padStart(2, '0')}`;

      // ─── 1. DAILY SHIFT REPORT (06:00 AM IST every day) ─────────────────────────
      if (hours === 6 && minutes === 0 && lastDailyRunDate !== todayDateKey) {
        lastDailyRunDate = todayDateKey;
        console.log(`[Scheduler] ⏰ Triggering Daily Shift Report for ${todayDateKey} at 6:00 AM IST...`);
        try {
          await sendDailyReport();
          console.log(`[Scheduler] ✓ Daily Shift Report successfully enqueued for ${todayDateKey}`);
        } catch (err) {
          console.error('[Scheduler] Error running scheduled daily report:', err.message);
        }
      }

      // ─── 2. MONTHLY REPORT (06:00 AM IST on 1st of every month) ────────────────
      if (dayOfMonth === 1 && hours === 6 && minutes === 0 && lastMonthlyRunKey !== thisMonthKey) {
        lastMonthlyRunKey = thisMonthKey;
        console.log(`[Scheduler] ⏰ Triggering Monthly Report on 1st of month at 6:00 AM IST (${thisMonthKey})...`);
        try {
          await sendMonthlyReport();
          console.log(`[Scheduler] ✓ Monthly Report successfully enqueued for ${thisMonthKey}`);
        } catch (err) {
          console.error('[Scheduler] Error running scheduled monthly report:', err.message);
        }
      }
    } catch (loopErr) {
      console.error('[Scheduler] Cron tick error:', loopErr.message);
    }
  }, 60000); // 60s tick
}

export function stopReportScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped automated report scheduler.');
  }
}
