/**
 * mailRoutes.js
 * Endpoints for managing per-user email subscription settings and manual report triggers.
 */

import express from 'express';
import { query, execute } from '../config/db.js';
import { protectRoute, adminOnly } from '../middleware/auth.js';
import { logActivity } from '../utils/activityLogger.js';
import { mailQueue } from '../utils/mailQueue.js';
import { sendDailyReport, sendMonthlyReport } from '../services/mailService.js';
import { sendMail } from '../utils/mailer.js';
import { formatSubject } from '../utils/customerConfig.js';

const router = express.Router();
router.use(protectRoute);
router.use(adminOnly);

// ─── GET /api/mail/subscriptions ─────────────────────────────────────────────
// Returns list of users and their 5 mail notification toggle states
router.get('/subscriptions', async (req, res) => {
  try {
    const users = await query(`
      SELECT 
        id, 
        name, 
        username, 
        email, 
        role, 
        customer_name, 
        vendor_code, 
        is_active,
        COALESCE(mail_each_scan, 0) as mail_each_scan,
        COALESCE(mail_plan_add, 0) as mail_plan_add,
        COALESCE(mail_gate_pass, 1) as mail_gate_pass,
        COALESCE(mail_daily_report, 0) as mail_daily_report,
        COALESCE(mail_monthly_report, 0) as mail_monthly_report
      FROM users
      ORDER BY role ASC, name ASC
    `);

    const queueStats = mailQueue.getStats();

    res.json({
      users: users.map((u) => ({
        ...u,
        mail_each_scan: Boolean(u.mail_each_scan),
        mail_plan_add: Boolean(u.mail_plan_add),
        mail_gate_pass: Boolean(u.mail_gate_pass),
        mail_daily_report: Boolean(u.mail_daily_report),
        mail_monthly_report: Boolean(u.mail_monthly_report),
      })),
      queueStats
    });
  } catch (error) {
    console.error('Error fetching mail subscriptions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PUT /api/mail/subscriptions/:userId ────────────────────────────────────
// Update mail notification preferences for a specific user
router.put('/subscriptions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      mail_each_scan,
      mail_plan_add,
      mail_gate_pass,
      mail_daily_report,
      mail_monthly_report
    } = req.body;

    await execute(`
      UPDATE users SET
        mail_each_scan = ?,
        mail_plan_add = ?,
        mail_gate_pass = ?,
        mail_daily_report = ?,
        mail_monthly_report = ?
      WHERE id = ?
    `, [
      mail_each_scan ? 1 : 0,
      mail_plan_add ? 1 : 0,
      mail_gate_pass ? 1 : 0,
      mail_daily_report ? 1 : 0,
      mail_monthly_report ? 1 : 0,
      userId
    ]);

    await logActivity(req, {
      action: 'USER_UPDATE',
      action_type: 'user',
      description: `Updated email subscription preferences for user #${userId}`
    });

    res.json({ message: 'Email preferences updated successfully' });
  } catch (error) {
    console.error('Error updating mail subscriptions:', error);
    res.status(500).json({ message: 'Failed to update email preferences' });
  }
});

// ─── POST /api/mail/subscriptions/batch ─────────────────────────────────────
// Batch update all users for a specific toggle column (e.g. enable all gatepass)
router.put('/subscriptions/batch/:columnName', async (req, res) => {
  try {
    const { columnName } = req.params;
    const { enable } = req.body;

    const allowedCols = [
      'mail_each_scan',
      'mail_plan_add',
      'mail_gate_pass',
      'mail_daily_report',
      'mail_monthly_report'
    ];

    if (!allowedCols.includes(columnName)) {
      return res.status(400).json({ message: 'Invalid subscription column' });
    }

    await execute(`UPDATE users SET ${columnName} = ? WHERE is_active = 1`, [enable ? 1 : 0]);

    await logActivity(req, {
      action: 'SYSTEM_CONFIG',
      action_type: 'system',
      description: `Batch ${enable ? 'enabled' : 'disabled'} "${columnName}" email notifications for all active users`
    });

    res.json({ message: `Batch updated ${columnName} successfully` });
  } catch (error) {
    console.error('Error batch updating subscriptions:', error);
    res.status(500).json({ message: 'Failed to batch update email preferences' });
  }
});

// ─── POST /api/mail/send-daily-now ──────────────────────────────────────────
// Trigger daily report manually
router.post('/send-daily-now', async (req, res) => {
  try {
    const { targetDate, testRecipient, customerCode } = req.body;
    const result = await sendDailyReport({
      targetDate,
      testRecipient: testRecipient || (req.body.sendToMe ? req.user.email : null),
      customerCode
    });

    await logActivity(req, {
      action: 'REPORT_DISPATCH',
      action_type: 'system',
      description: `Manually triggered Daily Shift Report for date ${result.date}`
    });

    res.json({
      message: `Daily report triggered successfully. ${result.emailsQueued} customer email(s) queued.`,
      result
    });
  } catch (error) {
    console.error('Error triggering daily report:', error);
    res.status(500).json({ message: error.message || 'Failed to trigger daily report' });
  }
});

// ─── POST /api/mail/send-monthly-now ────────────────────────────────────────
// Trigger monthly report manually
router.post('/send-monthly-now', async (req, res) => {
  try {
    const { year, month, testRecipient, customerCode } = req.body;
    const result = await sendMonthlyReport({
      year,
      month,
      testRecipient: testRecipient || (req.body.sendToMe ? req.user.email : null),
      customerCode
    });

    await logActivity(req, {
      action: 'REPORT_DISPATCH',
      action_type: 'system',
      description: `Manually triggered Monthly Consolidated Report for ${result.month}`
    });

    res.json({
      message: `Monthly report triggered successfully. ${result.emailsQueued} customer email(s) queued.`,
      result
    });
  } catch (error) {
    console.error('Error triggering monthly report:', error);
    res.status(500).json({ message: error.message || 'Failed to trigger monthly report' });
  }
});

// ─── POST /api/mail/send-test ───────────────────────────────────────────────
// Quick test to verify SMTP delivery
router.post('/send-test', async (req, res) => {
  try {
    const toEmail = req.body.email || req.user.email;
    if (!toEmail) {
      return res.status(400).json({ message: 'Recipient email address is required' });
    }

    const subject = formatSubject('SMTP Delivery Test & Verification', 'Ashok Leyland Pantnagar', '7201012');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0d9488; margin-top: 0;">RSB TRANSMISSIONS (I) LTD.</h2>
        <p>This is a test notification confirming that the RSB Despatch email subsystem is configured and delivering messages properly.</p>
        <div style="background: #f8fafc; padding: 12px; border-radius: 6px; font-size: 13px;">
          <strong>Server Time:</strong> ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST<br/>
          <strong>Triggered By:</strong> ${req.user.name} (@${req.user.username})<br/>
          <strong>Recipient:</strong> ${toEmail}
        </div>
      </div>
    `;

    await sendMail({
      to: toEmail,
      subject,
      html
    });

    res.json({ message: `Test email sent successfully to ${toEmail}` });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ message: `SMTP Error: ${error.message}` });
  }
});

export default router;
