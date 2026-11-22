/**
 * mailService.js
 * Comprehensive notification and automated reporting engine for RSB Despatch.
 * Handles:
 *  1. Each Scan (Instant notification via async MailQueue)
 *  2. Plan Add (Notification + Excel sheet of newly added plans)
 *  3. Gate Pass (Vehicle Gate Pass + 2-sheet verification spreadsheet)
 *  4. Daily Report (Day's part qty + Month cumulative sorted by last scan first, in body & 2-sheet Excel)
 *  5. Monthly Report (Full monthly performance, fulfillment %, Gate Pass summary on 1st of month)
 */

import { query, queryOne } from '../config/db.js';
import { enqueueMail } from '../utils/mailQueue.js';
import { CUSTOMERS, getCustomerInfo, formatSubject } from '../utils/customerConfig.js';
import XLSX from 'xlsx-js-style';

/**
 * Fetch subscribed recipient emails for a given event and customer
 * @param {'each_scan'|'plan_add'|'gate_pass'|'daily_report'|'monthly_report'} eventType 
 * @param {string|null} customerName 
 * @param {string|null} vendorCode 
 * @returns {Promise<string[]>}
 */
export async function getSubscribedRecipients(eventType, customerName = null, vendorCode = null) {
  const colMap = {
    each_scan: 'mail_each_scan',
    plan_add: 'mail_plan_add',
    gate_pass: 'mail_gate_pass',
    daily_report: 'mail_daily_report',
    monthly_report: 'mail_monthly_report',
  };

  const colName = colMap[eventType] || 'mail_gate_pass';

  const users = await query(`
    SELECT id, name, username, email, role, customer_name, vendor_code 
    FROM users 
    WHERE ${colName} = 1 
      AND is_active = 1 
      AND email IS NOT NULL 
      AND TRIM(email) != ''
  `);

  if (!users || users.length === 0) return [];

  const targetInfo = getCustomerInfo(customerName, vendorCode);

  const matched = users.filter((u) => {
    // Admin or users with no customer restriction receive all
    if (u.role === 'admin' || (!u.customer_name && !u.vendor_code)) {
      return true;
    }

    if (!targetInfo) return true;

    const userCustInfo = getCustomerInfo(u.customer_name, u.vendor_code);
    if (!userCustInfo) {
      if (u.customer_name && customerName && u.customer_name.toLowerCase().trim() === customerName.toLowerCase().trim()) return true;
      if (u.vendor_code && vendorCode && u.vendor_code.trim() === vendorCode.trim()) return true;
      return false;
    }

    return userCustInfo.code === targetInfo.code;
  }).map((u) => u.email.trim());

  return [...new Set(matched)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NOTIFY SCAN (Each Successful Scan)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyScan(scanData) {
  try {
    const {
      part_number,
      serial_number,
      vendor_code,
      customer_name,
      scanned_label,
      scanner_name,
      scanner_username,
      plan_id,
      balance_quantity,
      plan_quantity
    } = scanData;

    const recipients = await getSubscribedRecipients('each_scan', customer_name, vendor_code);
    if (recipients.length === 0) return;

    const subject = formatSubject(
      `Part Scanned: ${part_number} (SN: ${serial_number || 'N/A'})`,
      customer_name,
      vendor_code
    );

    const custInfo = getCustomerInfo(customer_name, vendor_code);
    const customerDisplay = custInfo ? custInfo.displayName : (customer_name || 'RSB Plant');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #0d9488 0%, #059669 100%); padding: 18px 24px; color: #ffffff;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 700;">RSB TRANSMISSIONS (I) LTD.</h2>
          <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">Barcode Scan Notification &bull; ${customerDisplay}</p>
        </div>

        <div style="padding: 22px;">
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px;">
            <div style="color: #15803d; font-size: 15px; font-weight: 700; margin-bottom: 4px;">
              ✓ Part Successfully Verified & Logged
            </div>
            <div style="color: #166534; font-size: 13px;">
              Part <strong>${part_number}</strong> was scanned and validated against dispatch plan #${plan_id || 'N/A'}.
            </div>
          </div>

          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b; width: 40%;"><strong>Customer:</strong></td>
              <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${customerDisplay}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b;"><strong>Part Number:</strong></td>
              <td style="padding: 8px 0; color: #0f172a; font-family: monospace; font-size: 14px; font-weight: 700;">${part_number}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b;"><strong>Serial Number:</strong></td>
              <td style="padding: 8px 0; color: #0f172a; font-family: monospace;">${serial_number || '—'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b;"><strong>Vendor Code:</strong></td>
              <td style="padding: 8px 0; color: #0f172a; font-family: monospace;">${vendor_code || '—'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b;"><strong>Scanned Label Text:</strong></td>
              <td style="padding: 8px 0; color: #334155; font-family: monospace; font-size: 12px;">${scanned_label || '—'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 8px 0; color: #64748b;"><strong>Scanned By:</strong></td>
              <td style="padding: 8px 0; color: #0f172a;">${scanner_name || scanner_username || 'Operator'} (@${scanner_username || 'N/A'})</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b;"><strong>Plan Remaining Balance:</strong></td>
              <td style="padding: 8px 0; color: #0d9488; font-weight: 700;">
                ${balance_quantity !== undefined ? `${balance_quantity} parts remaining` : 'Updated'} 
                ${plan_quantity ? `(Target: ${plan_quantity})` : ''}
              </td>
            </tr>
          </table>

          <div style="font-size: 11px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 14px;">
            Timestamp: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST &bull; Automated Scan Notification
          </div>
        </div>
      </div>
    `;

    enqueueMail({
      to: recipients,
      subject,
      html
    });
  } catch (err) {
    console.error('[MailService] notifyScan error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. NOTIFY PLAN ADD (Dispatch Plan Uploaded / Created)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyPlanAdd({ uploader, plans, customerName, vendorCode, source = 'Manual' }) {
  try {
    if (!plans || plans.length === 0) return;

    const recipients = await getSubscribedRecipients('plan_add', customerName, vendorCode);
    if (recipients.length === 0) return;

    const totalQuantity = plans.reduce((acc, p) => acc + (Number(p.quantity) || 0), 0);
    const totalParts = plans.length;

    const custInfo = getCustomerInfo(customerName, vendorCode);
    const customerDisplay = custInfo ? custInfo.displayName : (customerName || 'Multiple Customers');

    const subject = formatSubject(
      `Dispatch Plan Added (${totalParts} Parts, ${totalQuantity} Total Qty) by ${uploader?.name || uploader?.username || 'Admin'}`,
      customerName,
      vendorCode
    );

    // Build Excel attachment containing the added dispatch plan(s)
    const excelRows = [
      ['SR No', 'Customer Name', 'Vendor Code', 'Part Number', 'Quantity', 'Schedule Date', 'Plan Date', 'Added By']
    ];

    plans.forEach((p, idx) => {
      excelRows.push([
        idx + 1,
        p.customer_name || customerDisplay,
        p.vendor_code || vendorCode || '—',
        p.part_number,
        Number(p.quantity) || 0,
        p.schedule_date || p.plan_date || new Date().toISOString().split('T')[0],
        p.plan_date || new Date().toISOString().split('T')[0],
        uploader?.name || uploader?.username || 'Admin'
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(excelRows);
    ws['!cols'] = [
      { wch: 8 },  // SR No
      { wch: 25 }, // Customer Name
      { wch: 14 }, // Vendor Code
      { wch: 18 }, // Part Number
      { wch: 12 }, // Quantity
      { wch: 16 }, // Schedule Date
      { wch: 16 }, // Plan Date
      { wch: 20 }, // Added By
    ];

    // Header styling
    for (let c = 0; c < 8; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) {
        ws[addr].s = {
          fill: { fgColor: { rgb: '0F766E' } },
          font: { color: { rgb: 'FFFFFF' }, bold: true },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dispatch_Plan');
    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // HTML Table Preview (Top 10 parts)
    const previewRows = plans.slice(0, 10).map((p, i) => `
      <tr style="border-bottom: 1px solid #e2e8f0; font-size: 12px;">
        <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${i + 1}</td>
        <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; border: 1px solid #cbd5e1; color: #0f172a;">${p.part_number}</td>
        <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${p.customer_name || customerDisplay}</td>
        <td style="padding: 8px 10px; text-align: right; font-weight: 700; color: #0d9488; border: 1px solid #cbd5e1;">${p.quantity}</td>
        <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${p.schedule_date || p.plan_date || '—'}</td>
      </tr>
    `).join('');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #0284c7 0%, #0f766e 100%); padding: 20px 24px; color: #ffffff;">
          <h2 style="margin: 0; font-size: 19px; font-weight: 700;">RSB TRANSMISSIONS (I) LTD.</h2>
          <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">New Dispatch Plan Added &bull; ${customerDisplay}</p>
        </div>

        <div style="padding: 24px;">
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 22px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Customer:</strong></td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: 700;">${customerDisplay}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;"><strong>Uploaded By:</strong></td>
                <td style="padding: 6px 0; color: #0f172a;">${uploader?.name || uploader?.username || 'Admin'} (@${uploader?.username || 'N/A'}) [${(uploader?.role || 'admin').toUpperCase()}]</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;"><strong>Source:</strong></td>
                <td style="padding: 6px 0; color: #0f172a;">${source} Upload</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;"><strong>Total Planned Targets:</strong></td>
                <td style="padding: 6px 0; color: #0284c7; font-weight: 700; font-size: 14px;">${totalParts} Part Numbers &bull; ${totalQuantity} Total Quantity</td>
              </tr>
            </table>
          </div>

          <h3 style="font-size: 14px; color: #1e293b; margin: 0 0 10px 0; border-bottom: 2px solid #0284c7; padding-bottom: 6px;">
            Dispatch Plan Summary Preview ${plans.length > 10 ? `(First 10 of ${plans.length} items)` : ''}
          </h3>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; border: 1px solid #cbd5e1;">
            <thead>
              <tr style="background-color: #0284c7; color: #ffffff;">
                <th style="padding: 8px; text-align: center; border: 1px solid #0284c7; width: 50px;">#</th>
                <th style="padding: 8px 12px; text-align: left; border: 1px solid #0284c7;">Part Number</th>
                <th style="padding: 8px; text-align: center; border: 1px solid #0284c7;">Customer</th>
                <th style="padding: 8px; text-align: right; border: 1px solid #0284c7; width: 80px;">Qty</th>
                <th style="padding: 8px; text-align: center; border: 1px solid #0284c7; width: 100px;">Plan Date</th>
              </tr>
            </thead>
            <tbody>
              ${previewRows}
            </tbody>
          </table>

          <div style="background-color: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 12px 16px; margin-top: 16px;">
            <p style="margin: 0; color: #0369a1; font-size: 13px; font-weight: 600;">
              📎 Attached Excel File: <span style="font-family: monospace;">Dispatch_Plan_${new Date().toISOString().split('T')[0]}.xlsx</span>
            </p>
            <p style="margin: 4px 0 0 0; color: #0284c7; font-size: 12px;">
              The full spreadsheet with all ${totalParts} line items, schedule dates, and quantities is attached.
            </p>
          </div>

          <p style="color: #94a3b8; font-size: 11px; margin: 20px 0 0 0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 14px;">
            Automated Notification &bull; RSB Despatch Management System
          </p>
        </div>
      </div>
    `;

    enqueueMail({
      to: recipients,
      subject,
      html,
      attachments: [
        {
          filename: `Dispatch_Plan_${new Date().toISOString().split('T')[0]}.xlsx`,
          content: excelBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      ]
    });
  } catch (err) {
    console.error('[MailService] notifyPlanAdd error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SEND DAILY DISPATCH REPORT (Fires Daily at 6:00 AM IST)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Generates and sends Day-wise scan & Month cumulative report per customer.
 * - Sheet 1: Day's report (each part number and quantity)
 * - Sheet 2: Cumulative of month sorted by last scan shows first order
 */
export async function sendDailyReport({ targetDate = null, testRecipient = null, customerCode = null } = {}) {
  try {
    // If targetDate not specified, default to yesterday's completed 24h
    let reportDateStr = targetDate;
    if (!reportDateStr) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      reportDateStr = d.toISOString().split('T')[0];
    }

    const [yearStr, monthStr] = reportDateStr.split('-');
    const yearNum = Number(yearStr);
    const monthNum = Number(monthStr);

    console.log(`[MailService] Preparing Daily Report for date: ${reportDateStr} (Month: ${monthNum}/${yearNum})`);

    // Target customers to process
    const customersToProcess = customerCode
      ? CUSTOMERS.filter((c) => c.code === customerCode)
      : CUSTOMERS;

    let emailsQueued = 0;

    for (const cust of customersToProcess) {
      // 1. Fetch Day's scans for this customer
      const dayScans = await query(`
        SELECT 
          s.part_number,
          COUNT(*) as quantity,
          MAX(s.scan_date) as last_scan_time,
          MIN(s.scan_date) as first_scan_time,
          MAX(s.vendor_code) as vendor_code
        FROM scan_logs s
        LEFT JOIN despatch_plans dp ON s.plan_id = dp.id
        WHERE DATE(s.scan_date) = ?
          AND (s.status IS NULL OR s.status = 'success')
          AND (
            s.vendor_code = ? 
            OR dp.vendor_code = ? 
            OR dp.customer_name LIKE ? 
            OR s.unique_key LIKE ?
          )
        GROUP BY s.part_number
        ORDER BY quantity DESC, s.part_number ASC
      `, [reportDateStr, cust.code, cust.code, `%${cust.presetName}%`, `${cust.code}%`]);

      // 2. Fetch Month's cumulative scans up to reportDateStr sorted by LAST SCAN FIRST (as requested!)
      const monthCumulative = await query(`
        SELECT 
          s.part_number,
          COUNT(*) as cumulative_quantity,
          MAX(s.scan_date) as last_scan_time,
          MIN(s.scan_date) as first_scan_time,
          MAX(s.vendor_code) as vendor_code
        FROM scan_logs s
        LEFT JOIN despatch_plans dp ON s.plan_id = dp.id
        WHERE s.scan_year = ? AND s.scan_month = ?
          AND DATE(s.scan_date) <= ?
          AND (s.status IS NULL OR s.status = 'success')
          AND (
            s.vendor_code = ? 
            OR dp.vendor_code = ? 
            OR dp.customer_name LIKE ? 
            OR s.unique_key LIKE ?
          )
        GROUP BY s.part_number
        ORDER BY MAX(s.scan_date) DESC
      `, [yearNum, monthNum, reportDateStr, cust.code, cust.code, `%${cust.presetName}%`, `${cust.code}%`]);

      // If no activity for this customer on this day AND month, skip unless test
      if (dayScans.length === 0 && monthCumulative.length === 0 && !testRecipient) {
        continue;
      }

      // Determine recipients
      let recipients = [];
      if (testRecipient) {
        recipients = [testRecipient];
      } else {
        recipients = await getSubscribedRecipients('daily_report', cust.presetName, cust.code);
      }

      if (recipients.length === 0) continue;

      const totalDayQty = dayScans.reduce((acc, r) => acc + Number(r.quantity), 0);
      const totalMonthQty = monthCumulative.reduce((acc, r) => acc + Number(r.cumulative_quantity), 0);

      // Build 2-sheet Excel file
      // Sheet 1: Day's Report
      const sheet1Rows = [
        ['SR No', 'Part Number', 'Customer', 'Vendor Code', "Day's Scanned Qty", 'Last Scan Time (IST)']
      ];
      dayScans.forEach((r, idx) => {
        sheet1Rows.push([
          idx + 1,
          r.part_number,
          cust.displayName,
          r.vendor_code || cust.code,
          Number(r.quantity),
          r.last_scan_time ? new Date(r.last_scan_time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '—'
        ]);
      });
      sheet1Rows.push(['', 'TOTAL', '', '', totalDayQty, '']);

      // Sheet 2: Month Cumulative (Sorted by last scan shows first order)
      const sheet2Rows = [
        ['SR No', 'Part Number', 'Customer', 'Vendor Code', 'Month Cumulative Qty', 'Last Scan Time (IST)', 'First Scan Time (IST)']
      ];
      monthCumulative.forEach((r, idx) => {
        sheet2Rows.push([
          idx + 1,
          r.part_number,
          cust.displayName,
          r.vendor_code || cust.code,
          Number(r.cumulative_quantity),
          r.last_scan_time ? new Date(r.last_scan_time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '—',
          r.first_scan_time ? new Date(r.first_scan_time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '—'
        ]);
      });
      sheet2Rows.push(['', 'TOTAL CUMULATIVE', '', '', totalMonthQty, '', '']);

      const wsDay = XLSX.utils.aoa_to_sheet(sheet1Rows);
      const wsMonth = XLSX.utils.aoa_to_sheet(sheet2Rows);

      wsDay['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 26 }, { wch: 14 }, { wch: 18 }, { wch: 22 }];
      wsMonth['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 26 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];

      // Styles
      const applyHeaderStyle = (ws, colCount, colorHex) => {
        for (let c = 0; c < colCount; c++) {
          const addr = XLSX.utils.encode_cell({ r: 0, c });
          if (ws[addr]) {
            ws[addr].s = {
              fill: { fgColor: { rgb: colorHex } },
              font: { color: { rgb: 'FFFFFF' }, bold: true },
              alignment: { horizontal: 'center', vertical: 'center' }
            };
          }
        }
      };
      applyHeaderStyle(wsDay, 6, '0F766E');
      applyHeaderStyle(wsMonth, 7, '0369A1');

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsDay, `Day_Report_${reportDateStr}`);
      XLSX.utils.book_append_sheet(wb, wsMonth, 'Month_Cumulative');
      const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      // Build HTML tables
      const dayTableHtml = dayScans.length === 0
        ? `<tr><td colspan="4" style="padding: 12px; text-align: center; color: #94a3b8; font-style: italic;">No scans recorded on this date</td></tr>`
        : dayScans.map((r, i) => `
            <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
              <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${i + 1}</td>
              <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: #0f172a; border: 1px solid #cbd5e1;">${r.part_number}</td>
              <td style="padding: 8px 12px; text-align: right; font-weight: 700; color: #0d9488; border: 1px solid #cbd5e1;">${r.quantity}</td>
              <td style="padding: 8px 12px; text-align: center; color: #64748b; font-size: 11px; border: 1px solid #cbd5e1;">${r.last_scan_time ? new Date(r.last_scan_time).toLocaleTimeString('en-GB') : '—'}</td>
            </tr>
          `).join('');

      const monthTableHtml = monthCumulative.slice(0, 15).map((r, i) => `
        <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
          <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${i + 1}</td>
          <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: #0f172a; border: 1px solid #cbd5e1;">${r.part_number}</td>
          <td style="padding: 8px 12px; text-align: right; font-weight: 700; color: #0284c7; border: 1px solid #cbd5e1;">${r.cumulative_quantity}</td>
          <td style="padding: 8px 12px; text-align: center; color: #64748b; font-size: 11px; border: 1px solid #cbd5e1;">
            ${r.last_scan_time ? new Date(r.last_scan_time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '—'}
          </td>
        </tr>
      `).join('');

      const subject = formatSubject(
        `Daily Dispatch & Scan Report - ${reportDateStr}`,
        cust.presetName,
        cust.code
      );

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 750px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #0d9488 0%, #0369a1 100%); padding: 20px 24px; color: #ffffff;">
            <h2 style="margin: 0; font-size: 20px; font-weight: 700;">RSB TRANSMISSIONS (I) LTD.</h2>
            <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.95;">Daily Shift Dispatch & Cumulative Report &bull; ${cust.displayName}</p>
          </div>

          <div style="padding: 24px;">
            {/* KPI Badges */}
            <div style="display: flex; gap: 12px; margin-bottom: 24px;">
              <div style="flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; text-align: center;">
                <div style="color: #166534; font-size: 11px; font-weight: 700; text-transform: uppercase;">Day Scans (${reportDateStr})</div>
                <div style="color: #15803d; font-size: 24px; font-weight: 800; margin-top: 4px;">${totalDayQty}</div>
                <div style="color: #166534; font-size: 11px;">${dayScans.length} active parts</div>
              </div>
              <div style="flex: 1; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 14px; text-align: center;">
                <div style="color: #0369a1; font-size: 11px; font-weight: 700; text-transform: uppercase;">Month Cumulative (${monthNum}/${yearNum})</div>
                <div style="color: #0284c7; font-size: 24px; font-weight: 800; margin-top: 4px;">${totalMonthQty}</div>
                <div style="color: #0369a1; font-size: 11px;">${monthCumulative.length} cumulative parts</div>
              </div>
            </div>

            {/* Section 1: Day Scans */}
            <h3 style="font-size: 15px; color: #0f172a; margin: 0 0 10px 0; border-bottom: 2px solid #0d9488; padding-bottom: 6px;">
              1. Day's Dispatch & Scanned Parts (${reportDateStr})
            </h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; border: 1px solid #cbd5e1;">
              <thead>
                <tr style="background-color: #0f766e; color: #ffffff;">
                  <th style="padding: 9px; text-align: center; border: 1px solid #0f766e; width: 50px;">SR No</th>
                  <th style="padding: 9px 12px; text-align: left; border: 1px solid #0f766e;">Part Number</th>
                  <th style="padding: 9px 12px; text-align: right; border: 1px solid #0f766e; width: 100px;">Day's Qty</th>
                  <th style="padding: 9px 12px; text-align: center; border: 1px solid #0f766e; width: 120px;">Last Scan</th>
                </tr>
              </thead>
              <tbody>
                ${dayTableHtml}
                ${dayScans.length > 0 ? `
                  <tr style="background-color: #f8fafc; font-weight: 700;">
                    <td colspan="2" style="padding: 10px 12px; text-align: right; border: 1px solid #cbd5e1;">TOTAL DAY QUANTITY:</td>
                    <td style="padding: 10px 12px; text-align: right; color: #0d9488; font-size: 15px; border: 1px solid #cbd5e1;">${totalDayQty}</td>
                    <td style="border: 1px solid #cbd5e1;"></td>
                  </tr>
                ` : ''}
              </tbody>
            </table>

            {/* Section 2: Month Cumulative (Sorted by last scan first) */}
            <h3 style="font-size: 15px; color: #0f172a; margin: 0 0 10px 0; border-bottom: 2px solid #0369a1; padding-bottom: 6px;">
              2. Month-to-Date Cumulative (Sorted by Most Recent Scan First)
            </h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; border: 1px solid #cbd5e1;">
              <thead>
                <tr style="background-color: #0369a1; color: #ffffff;">
                  <th style="padding: 9px; text-align: center; border: 1px solid #0369a1; width: 50px;">SR No</th>
                  <th style="padding: 9px 12px; text-align: left; border: 1px solid #0369a1;">Part Number</th>
                  <th style="padding: 9px 12px; text-align: right; border: 1px solid #0369a1; width: 110px;">Month Qty</th>
                  <th style="padding: 9px 12px; text-align: center; border: 1px solid #0369a1; width: 160px;">Last Scan Date & Time</th>
                </tr>
              </thead>
              <tbody>
                ${monthTableHtml}
                ${monthCumulative.length > 15 ? `
                  <tr>
                    <td colspan="4" style="padding: 8px; text-align: center; background: #f1f5f9; color: #64748b; font-size: 12px;">
                      + ${monthCumulative.length - 15} more parts included in attached Excel sheet
                    </td>
                  </tr>
                ` : ''}
              </tbody>
            </table>

            <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 14px 16px;">
              <p style="margin: 0; color: #065f46; font-size: 13px; font-weight: 700;">
                📎 2-Sheet Excel Attached: <span style="font-family: monospace;">Daily_Report_${cust.shortName}_${reportDateStr}.xlsx</span>
              </p>
              <ul style="margin: 6px 0 0 0; padding-left: 20px; color: #047857; font-size: 12px;">
                <li><strong>Sheet 1 (Day's Report):</strong> Day's scanned parts and verified quantities.</li>
                <li><strong>Sheet 2 (Month Cumulative):</strong> Complete month-to-date scan logs sorted by latest scan first.</li>
              </ul>
            </div>

            <p style="color: #94a3b8; font-size: 11px; margin: 20px 0 0 0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 14px;">
              Automated Shift Report (Fired Daily at 6:00 AM IST) &bull; RSB Despatch Management System
            </p>
          </div>
        </div>
      `;

      enqueueMail({
        to: recipients,
        subject,
        html,
        attachments: [
          {
            filename: `Daily_Report_${cust.shortName}_${reportDateStr}.xlsx`,
            content: excelBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ]
      });

      emailsQueued++;
    }

    return { success: true, emailsQueued, date: reportDateStr };
  } catch (err) {
    console.error('[MailService] sendDailyReport error:', err);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SEND MONTHLY REPORT (Fires on 1st of Each Month at 6:00 AM IST)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Monthly consolidated report on 1st of every month at 6:00 AM.
 */
export async function sendMonthlyReport({ year = null, month = null, testRecipient = null, customerCode = null } = {}) {
  try {
    const now = new Date();
    // Default to the previous month
    let targetYear = year;
    let targetMonth = month;
    if (!targetYear || !targetMonth) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      targetYear = prev.getFullYear();
      targetMonth = prev.getMonth() + 1;
    }

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthLabel = `${monthNames[targetMonth - 1]} ${targetYear}`;

    console.log(`[MailService] Preparing Monthly Report for: ${monthLabel}`);

    const customersToProcess = customerCode
      ? CUSTOMERS.filter((c) => c.code === customerCode)
      : CUSTOMERS;

    let emailsQueued = 0;

    for (const cust of customersToProcess) {
      // 1. Month part summary
      const partSummary = await query(`
        SELECT 
          s.part_number,
          COUNT(*) as total_scans,
          COUNT(DISTINCT s.serial_number) as unique_parts,
          MIN(s.scan_date) as first_scan,
          MAX(s.scan_date) as last_scan
        FROM scan_logs s
        LEFT JOIN despatch_plans dp ON s.plan_id = dp.id
        WHERE s.scan_year = ? AND s.scan_month = ?
          AND (s.status IS NULL OR s.status = 'success')
          AND (
            s.vendor_code = ? 
            OR dp.vendor_code = ? 
            OR dp.customer_name LIKE ? 
            OR s.unique_key LIKE ?
          )
        GROUP BY s.part_number
        ORDER BY total_scans DESC, s.part_number ASC
      `, [targetYear, targetMonth, cust.code, cust.code, `%${cust.presetName}%`, `${cust.code}%`]);

      // 2. Month Gate Passes
      const gatePasses = await query(`
        SELECT gp.*, u.name as user_name, u.username
        FROM gate_passes gp
        LEFT JOIN users u ON gp.user_id = u.id
        WHERE YEAR(gp.plan_date) = ? AND MONTH(gp.plan_date) = ?
        ORDER BY gp.created_at ASC
      `, [targetYear, targetMonth]);

      if (partSummary.length === 0 && !testRecipient) {
        continue;
      }

      let recipients = [];
      if (testRecipient) {
        recipients = [testRecipient];
      } else {
        recipients = await getSubscribedRecipients('monthly_report', cust.presetName, cust.code);
      }

      if (recipients.length === 0) continue;

      const totalMonthlyQty = partSummary.reduce((acc, r) => acc + Number(r.total_scans), 0);

      // Build Excel
      const sheet1Rows = [
        ['SR No', 'Part Number', 'Customer', 'Vendor Code', 'Total Month Scans', 'First Scan Date', 'Last Scan Date']
      ];
      partSummary.forEach((r, idx) => {
        sheet1Rows.push([
          idx + 1,
          r.part_number,
          cust.displayName,
          cust.code,
          Number(r.total_scans),
          r.first_scan ? new Date(r.first_scan).toLocaleDateString('en-GB') : '—',
          r.last_scan ? new Date(r.last_scan).toLocaleDateString('en-GB') : '—'
        ]);
      });
      sheet1Rows.push(['', 'TOTAL', '', '', totalMonthlyQty, '', '']);

      const sheet2Rows = [
        ['SR No', 'Gate Pass Number', 'Plan Date', 'Total Parts', 'Total Quantity', 'Generated By', 'Created At']
      ];
      gatePasses.forEach((g, idx) => {
        sheet2Rows.push([
          idx + 1,
          `#${g.gate_pass_number}`,
          g.plan_date ? String(g.plan_date).slice(0, 10) : '—',
          g.total_parts,
          g.total_quantity,
          g.user_name || g.username || 'Admin',
          g.created_at ? new Date(g.created_at).toLocaleString('en-GB') : '—'
        ]);
      });

      const wsParts = XLSX.utils.aoa_to_sheet(sheet1Rows);
      const wsGP = XLSX.utils.aoa_to_sheet(sheet2Rows);

      wsParts['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 28 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 16 }];
      wsGP['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 22 }, { wch: 22 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsParts, 'Monthly_Part_Summary');
      XLSX.utils.book_append_sheet(wb, wsGP, 'Monthly_Gate_Passes');
      const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const partsTableHtml = partSummary.slice(0, 20).map((r, i) => `
        <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
          <td style="padding: 8px 10px; text-align: center; border: 1px solid #cbd5e1;">${i + 1}</td>
          <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: #0f172a; border: 1px solid #cbd5e1;">${r.part_number}</td>
          <td style="padding: 8px 12px; text-align: right; font-weight: 700; color: #7c3aed; border: 1px solid #cbd5e1;">${r.total_scans}</td>
          <td style="padding: 8px 12px; text-align: center; color: #64748b; font-size: 12px; border: 1px solid #cbd5e1;">${r.last_scan ? new Date(r.last_scan).toLocaleDateString('en-GB') : '—'}</td>
        </tr>
      `).join('');

      const subject = formatSubject(
        `Monthly Dispatch Report - ${monthLabel}`,
        cust.presetName,
        cust.code
      );

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 750px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #7c3aed 0%, #0d9488 100%); padding: 20px 24px; color: #ffffff;">
            <h2 style="margin: 0; font-size: 20px; font-weight: 700;">RSB TRANSMISSIONS (I) LTD.</h2>
            <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.95;">Monthly Consolidated Dispatch Report &bull; ${cust.displayName} &bull; ${monthLabel}</p>
          </div>

          <div style="padding: 24px;">
            <div style="display: flex; gap: 12px; margin-bottom: 24px;">
              <div style="flex: 1; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 14px; text-align: center;">
                <div style="color: #6b21a8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Total Month Dispatched</div>
                <div style="color: #7c3aed; font-size: 26px; font-weight: 800; margin-top: 4px;">${totalMonthlyQty}</div>
                <div style="color: #6b21a8; font-size: 11px;">${partSummary.length} distinct parts</div>
              </div>
              <div style="flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; text-align: center;">
                <div style="color: #166534; font-size: 11px; font-weight: 700; text-transform: uppercase;">Gate Passes Issued</div>
                <div style="color: #15803d; font-size: 26px; font-weight: 800; margin-top: 4px;">${gatePasses.length}</div>
                <div style="color: #166534; font-size: 11px;">Completed vehicle shipments</div>
              </div>
            </div>

            <h3 style="font-size: 15px; color: #0f172a; margin: 0 0 10px 0; border-bottom: 2px solid #7c3aed; padding-bottom: 6px;">
              Part Number Monthly Breakdown
            </h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; border: 1px solid #cbd5e1;">
              <thead>
                <tr style="background-color: #6b21a8; color: #ffffff;">
                  <th style="padding: 9px; text-align: center; border: 1px solid #6b21a8; width: 50px;">SR No</th>
                  <th style="padding: 9px 12px; text-align: left; border: 1px solid #6b21a8;">Part Number</th>
                  <th style="padding: 9px 12px; text-align: right; border: 1px solid #6b21a8; width: 110px;">Total Scanned</th>
                  <th style="padding: 9px 12px; text-align: center; border: 1px solid #6b21a8; width: 130px;">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                ${partsTableHtml}
                <tr style="background-color: #f8fafc; font-weight: 700;">
                  <td colspan="2" style="padding: 10px 12px; text-align: right; border: 1px solid #cbd5e1;">TOTAL MONTH QUANTITY:</td>
                  <td style="padding: 10px 12px; text-align: right; color: #7c3aed; font-size: 15px; border: 1px solid #cbd5e1;">${totalMonthlyQty}</td>
                  <td style="border: 1px solid #cbd5e1;"></td>
                </tr>
              </tbody>
            </table>

            <div style="background-color: #faf5ff; border: 1px solid #e9d5ff; border-radius: 6px; padding: 14px 16px;">
              <p style="margin: 0; color: #6b21a8; font-size: 13px; font-weight: 700;">
                📎 Attached Spreadsheet: <span style="font-family: monospace;">Monthly_Report_${cust.shortName}_${targetMonth}_${targetYear}.xlsx</span>
              </p>
              <p style="margin: 4px 0 0 0; color: #7c3aed; font-size: 12px;">
                Contains full part counts and complete Gate Pass vehicle shipment logs for the entire month.
              </p>
            </div>

            <p style="color: #94a3b8; font-size: 11px; margin: 20px 0 0 0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 14px;">
              Automated Monthly Report (Fires on 1st of Every Month at 6:00 AM IST) &bull; RSB Despatch Management System
            </p>
          </div>
        </div>
      `;

      enqueueMail({
        to: recipients,
        subject,
        html,
        attachments: [
          {
            filename: `Monthly_Report_${cust.shortName}_${targetMonth}_${targetYear}.xlsx`,
            content: excelBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ]
      });

      emailsQueued++;
    }

    return { success: true, emailsQueued, month: monthLabel };
  } catch (err) {
    console.error('[MailService] sendMonthlyReport error:', err);
    throw err;
  }
}
