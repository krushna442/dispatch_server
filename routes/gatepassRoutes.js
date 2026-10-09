import express from 'express';
import { query, execute, getConnection } from '../config/db.js';
import { protectRoute } from '../middleware/auth.js';
import { emitToAll } from '../utils/socket.js';
import { sendMail } from '../utils/mailer.js';
import XLSX from 'xlsx-js-style';

const router = express.Router();
router.use(protectRoute);

router.post('/', async (req, res) => {
  const { gate_pass_number } = req.body;
  if (!gate_pass_number) return res.status(400).json({ message: 'Gate pass number is required' });

  let connection;
  try {
    const plans = await query(
      "SELECT * FROM despatch_plans WHERE status = 'completed' AND gate_pass_number IS NULL"
    );

    if (plans.length === 0) {
      return res.status(400).json({ message: 'No completed parts to dispatch' });
    }

    const totalParts = plans.length;
    const totalQuantity = plans.reduce((sum, p) => sum + p.quantity, 0);
    const today = new Date().toISOString().split('T')[0];
    const planIds = plans.map(p => p.id);

    connection = await getConnection();
    await connection.beginTransaction();

    const [gpResult] = await connection.execute(
      'INSERT INTO gate_passes (user_id, gate_pass_number, plan_date, total_parts, total_quantity) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, gate_pass_number, today, totalParts, totalQuantity]
    );
    const gpId = gpResult.insertId;

    for (const plan of plans) {
      await connection.execute(
        'INSERT INTO despatch_history (gate_pass_id, plan_id, part_number, quantity) VALUES (?, ?, ?, ?)',
        [gpId, plan.id, plan.part_number, plan.quantity]
      );
      
      await connection.execute(
        'UPDATE despatch_plans SET gate_pass_number = ?, dispatched_at = NOW(), updated_at = NOW() WHERE id = ?',
        [gate_pass_number, plan.id]
      );
    }

    // Link all scan logs from these plans to the generated gate pass
    if (planIds.length > 0) {
      const placeholders = planIds.map(() => '?').join(',');
      await connection.execute(
        `UPDATE scan_logs SET gate_pass_number = ?, gate_pass_id = ? WHERE plan_id IN (${placeholders})`,
        [gate_pass_number, gpId, ...planIds]
      );
    }

    await connection.commit();
    connection.release();

    emitToAll('despatch:gatepass', { gate_pass_number, user_id: req.user.id });

    // Send email with attached Excel file containing Scanned Labels & Gate Pass Summary
    try {
      const emailUsers = await query(
        "SELECT email FROM users WHERE receive_despatch_mail = 1 AND is_active = 1 AND email IS NOT NULL AND TRIM(email) != ''"
      );
      const recipientEmails = emailUsers.map(u => u.email.trim()).filter(Boolean);

      if (recipientEmails.length > 0) {
        // Query all scan logs associated with this gate pass
        let scanLogs = [];
        try {
          const placeholders = planIds.map(() => '?').join(',');
          scanLogs = await query(`
            SELECT s.*, u.username, u.name as user_name
            FROM scan_logs s
            LEFT JOIN users u ON s.user_id = u.id
            WHERE s.gate_pass_id = ? OR s.plan_id IN (${placeholders})
            ORDER BY s.scanned_at ASC
          `, [gpId, ...planIds]);
        } catch (fetchScanErr) {
          console.error('[GatePass] Error fetching scan logs for Excel attachment:', fetchScanErr);
        }

        // Build Excel Workbook: Sheet 1 = Scanned_Labels, Sheet 2 = Gate_Pass_Summary
        const scanRows = scanLogs.map((s, idx) => ({
          'SR No': idx + 1,
          'Scanned Label (Barcode Text)': s.scanned_label || s.raw_scan_text || s.serial_number || '—',
          'Part Number': s.part_number,
          'Serial Number': s.serial_number,
          'Vendor Code': s.vendor_code || '—',
          'Scanned By': s.username ? `@${s.username} (${s.user_name || ''})` : (s.user_id ? `User #${s.user_id}` : '—'),
          'Status': (s.status || 'success').toUpperCase(),
          'Remark': s.remark || (s.status === 'reject' ? 'duplicate scan' : 'verified'),
          'Scan Date & Time': s.scanned_at ? new Date(s.scanned_at).toLocaleString('en-GB') : ''
        }));

        if (scanRows.length === 0) {
          scanRows.push({
            'SR No': 1,
            'Scanned Label (Barcode Text)': 'No scans recorded',
            'Part Number': '—',
            'Serial Number': '—',
            'Vendor Code': '—',
            'Scanned By': '—',
            'Status': '—',
            'Remark': '—',
            'Scan Date & Time': '—'
          });
        }

        const wsScans = XLSX.utils.json_to_sheet(scanRows);
        const scanCols = Object.keys(scanRows[0] || {}).length;

        // Set column widths for readability
        wsScans['!cols'] = [
          { wch: 8 },  // SR No
          { wch: 38 }, // Scanned Label
          { wch: 18 }, // Part Number
          { wch: 18 }, // Serial Number
          { wch: 14 }, // Vendor Code
          { wch: 24 }, // Scanned By
          { wch: 14 }, // Status
          { wch: 20 }, // Remark
          { wch: 22 }, // Scan Date & Time
        ];

        // Header style (Dark teal fill with bold white text)
        for (let c = 0; c < scanCols; c++) {
          const addr = XLSX.utils.encode_cell({ r: 0, c });
          if (wsScans[addr]) {
            wsScans[addr].s = {
              fill: { fgColor: { rgb: '0F766E' } },
              font: { color: { rgb: 'FFFFFF' }, bold: true },
              alignment: { horizontal: 'center', vertical: 'center' },
            };
          }
        }

        // Highlight duplicate / reject scans with RED BACKGROUND
        scanRows.forEach((row, rIdx) => {
          const isDup = row.Status === 'REJECT' || row.Remark?.toLowerCase().includes('duplicate');
          if (isDup) {
            for (let c = 0; c < scanCols; c++) {
              const addr = XLSX.utils.encode_cell({ r: rIdx + 1, c });
              if (wsScans[addr]) {
                wsScans[addr].s = {
                  fill: { fgColor: { rgb: 'FFC7CE' } }, // Soft red fill
                  font: { color: { rgb: '9C0006' }, bold: true }, // Dark red bold text
                  border: {
                    top: { style: 'thin', color: { rgb: 'E0B4B4' } },
                    bottom: { style: 'thin', color: { rgb: 'E0B4B4' } },
                    left: { style: 'thin', color: { rgb: 'E0B4B4' } },
                    right: { style: 'thin', color: { rgb: 'E0B4B4' } },
                  },
                };
              }
            }
          }
        });

        // Sheet 2: Gate_Pass_Summary
        const summaryRows = plans.map((p, idx) => ({
          'SR No': idx + 1,
          'Gate Pass Number': `#${gate_pass_number}`,
          'Part Number': p.part_number,
          'Quantity Dispatched': p.quantity,
          'Plan Date': p.plan_date ? String(p.plan_date).slice(0, 10) : today,
          'Dispatched By': req.user.name || req.user.username,
          'Dispatched Date & Time': new Date().toLocaleString('en-GB')
        }));

        summaryRows.push({
          'SR No': '',
          'Gate Pass Number': '',
          'Part Number': 'GRAND TOTAL',
          'Quantity Dispatched': totalQuantity,
          'Plan Date': '',
          'Dispatched By': '',
          'Dispatched Date & Time': ''
        });

        const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
        const sumCols = Object.keys(summaryRows[0] || {}).length;
        wsSummary['!cols'] = [
          { wch: 8 },
          { wch: 20 },
          { wch: 18 },
          { wch: 20 },
          { wch: 14 },
          { wch: 22 },
          { wch: 22 },
        ];

        for (let c = 0; c < sumCols; c++) {
          const addr = XLSX.utils.encode_cell({ r: 0, c });
          if (wsSummary[addr]) {
            wsSummary[addr].s = {
              fill: { fgColor: { rgb: '0F766E' } },
              font: { color: { rgb: 'FFFFFF' }, bold: true },
              alignment: { horizontal: 'center', vertical: 'center' },
            };
          }
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, wsScans, 'Scanned_Labels');
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Gate_Pass_Summary');
        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const rowsHtml = plans.map((p, idx) => `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 10px 14px; text-align: center; color: #64748b; font-size: 13px;">${idx + 1}</td>
            <td style="padding: 10px 14px; font-weight: 600; color: #0f172a; font-family: monospace; font-size: 14px;">${p.part_number}</td>
            <td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #0f172a; font-size: 14px;">${p.quantity}</td>
          </tr>
        `).join('');

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #0d9488 0%, #059669 100%); padding: 20px 24px; color: #ffffff;">
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">RSB TRANSMISSIONS (I) LTD.</h1>
              <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.9;">Vehicle Despatch Gate Pass Notification</p>
            </div>
            
            <div style="padding: 24px;">
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Gate Pass Number:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 700; font-size: 15px;">#${gate_pass_number}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Plan Date:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a;">${today}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Generated By:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a;">${req.user.name || req.user.username} (@${req.user.username})</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Total Parts / Total Qty:</strong></td>
                    <td style="padding: 6px 0; color: #0d9488; font-weight: 700;">${totalParts} parts &bull; ${totalQuantity} total qty</td>
                  </tr>
                </table>
              </div>

              <h3 style="font-size: 15px; color: #1e293b; margin: 0 0 12px 0; border-bottom: 2px solid #0d9488; padding-bottom: 6px;">
                Despatched Parts Details
              </h3>

              <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
                <thead>
                  <tr style="background-color: #f1f5f9; color: #475569; font-size: 12px; text-transform: uppercase;">
                    <th style="padding: 10px 14px; text-align: center; border-bottom: 2px solid #cbd5e1; width: 60px;">SR No</th>
                    <th style="padding: 10px 14px; text-align: left; border-bottom: 2px solid #cbd5e1;">Part Number</th>
                    <th style="padding: 10px 14px; text-align: right; border-bottom: 2px solid #cbd5e1; width: 120px;">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                  <tr style="background-color: #f8fafc; font-weight: 700;">
                    <td colspan="2" style="padding: 12px 14px; text-align: right; border-top: 2px solid #cbd5e1; color: #0f172a;">GRAND TOTAL:</td>
                    <td style="padding: 12px 14px; text-align: right; border-top: 2px solid #cbd5e1; color: #0d9488; font-size: 15px;">${totalQuantity}</td>
                  </tr>
                </tbody>
              </table>

              <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 14px 16px; margin-top: 20px;">
                <p style="margin: 0; color: #065f46; font-size: 13px; font-weight: 600;">
                  📎 Excel Sheet Attached: <span style="font-family: monospace;">GatePass_${gate_pass_number}_Scanned_Labels.xlsx</span>
                </p>
                <p style="margin: 4px 0 0 0; color: #047857; font-size: 12px;">
                  The attached spreadsheet includes complete scanned barcode labels, serial numbers, operator timestamps, and verification status. Any duplicate scan attempts are highlighted in red.
                </p>
              </div>

              <p style="color: #94a3b8; font-size: 12px; margin: 24px 0 0 0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                This is an automated notification sent by the RSB Despatch Management System.
              </p>
            </div>
          </div>
        `;

        sendMail({
          to: recipientEmails,
          subject: `Gate Pass Generated - #${gate_pass_number} - RSB Despatch`,
          html: emailHtml,
          attachments: [
            {
              filename: `GatePass_${gate_pass_number}_Scanned_Labels.xlsx`,
              content: excelBuffer,
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }
          ]
        }).catch(mailErr => {
          console.error('[GatePass] Error sending notification email with attachment:', mailErr?.message || mailErr);
        });
      }
    } catch (emailErr) {
      console.error('[GatePass] Error querying recipients for notification:', emailErr?.message || emailErr);
    }

    res.json({ message: 'Gate pass generated successfully', gate_pass_id: gpId });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); connection.release(); } catch(e) {}
    }
    console.error('Gate pass error:', error);
    res.status(500).json({ message: 'Server error generating gate pass' });
  }
});

router.get('/', async (req, res) => {
  try {
    const passes = await query('SELECT * FROM gate_passes ORDER BY created_at DESC LIMIT 100');
    
    for (let pass of passes) {
      const history = await query('SELECT * FROM despatch_history WHERE gate_pass_id = ?', [pass.id]);
      pass.history = history;
    }
    
    res.json(passes);
  } catch (error) {
    console.error('Error fetching gate passes:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/scans', async (req, res) => {
  try {
    const scans = await query(`
      SELECT s.*, u.username, u.name as user_name
      FROM scan_logs s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.gate_pass_id = ? OR s.plan_id IN (
        SELECT plan_id FROM despatch_history WHERE gate_pass_id = ?
      )
      ORDER BY s.scanned_at ASC
    `, [req.params.id, req.params.id]);
    res.json(scans);
  } catch (error) {
    console.error('Error fetching gate pass scans:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
