import express from 'express';
import { queryOne, execute, getConnection, query } from '../config/db.js';
import { protectRoute } from '../middleware/auth.js';
import { parseScanText } from '../utils/parseScanText.js';
import { emitToAll } from '../utils/socket.js';

const router = express.Router();
router.use(protectRoute);

router.post('/', async (req, res) => {
  const { raw_scan_text } = req.body;
  if (!raw_scan_text) return res.status(400).json({ message: 'Scan text required' });

  let connection;
  try {
    const parsed = parseScanText(raw_scan_text);
    if (!parsed) {
      return res.status(400).json({ message: 'Could not parse scan text' });
    }

    const { format, partNo, vendorCode, partSlNo, dispatchDate, revNo } = parsed;
    
    if (req.user.vendor_code && vendorCode && vendorCode !== req.user.vendor_code) {
      return res.status(400).json({ message: `Vendor code mismatch. Expected: ${req.user.vendor_code}, Got: ${vendorCode}` });
    }

    const unique_key = `${partSlNo}_${dispatchDate || 'ND'}`;

    // Check if this part has already been successfully scanned
    const existingScan = await queryOne(
      "SELECT id, plan_id FROM scan_logs WHERE unique_key = ? AND (status IS NULL OR status = 'success')",
      [unique_key]
    );

    if (existingScan) {
      // Record duplicate scan attempt with status 'reject' and remark 'duplicate scan'
      const scanDateObj = new Date();
      const scanMonth = scanDateObj.getMonth() + 1;
      const scanYear = scanDateObj.getFullYear();
      const rejectUniqueKey = `${unique_key}_REJECT_${Date.now()}`;

      try {
        await execute(
          `INSERT INTO scan_logs 
           (user_id, plan_id, part_number, vendor_code, serial_number, scan_date, scan_month, scan_year, rev_no, format, raw_scan_text, scanned_label, unique_key, status, remark)
           VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, 'reject', 'duplicate scan')`,
          [
            req.user.id,
            existingScan.plan_id || null,
            partNo,
            vendorCode,
            partSlNo,
            scanMonth,
            scanYear,
            revNo,
            format,
            raw_scan_text,
            raw_scan_text,
            rejectUniqueKey
          ]
        );
      } catch (insertErr) {
        console.error('Error recording rejected scan:', insertErr);
      }

      const rejectDetails = {
        partNo,
        vendorCode,
        partSlNo,
        plan_id: existingScan.plan_id,
        raw_scan_text,
        scanned_label: raw_scan_text,
        status: 'reject',
        remark: 'duplicate scan',
        user_id: req.user.id,
        username: req.user.username,
        user_name: req.user.name,
        scanned_at: scanDateObj
      };
      emitToAll('despatch:scan', rejectDetails);

      return res.status(400).json({
        message: 'Duplicate scan detected',
        status: 'reject',
        remark: 'duplicate scan',
        raw_scan_text,
        scanned_label: raw_scan_text,
        user: req.user.username
      });
    }

    const plan = await queryOne(
      "SELECT * FROM despatch_plans WHERE part_number = ? AND balance_quantity > 0 AND status = 'pending' ORDER BY plan_date ASC LIMIT 1",
      [partNo]
    );

    if (!plan) {
      return res.status(400).json({ message: 'Part number not found in despatch plan or already completed' });
    }

    connection = await getConnection();
    await connection.beginTransaction();

    const scanDateObj = new Date();
    const scanMonth = scanDateObj.getMonth() + 1;
    const scanYear = scanDateObj.getFullYear();

    await connection.execute(
      `INSERT INTO scan_logs 
       (user_id, plan_id, part_number, vendor_code, serial_number, scan_date, scan_month, scan_year, rev_no, format, raw_scan_text, scanned_label, unique_key, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', 'verified')`,
      [req.user.id, plan.id, partNo, vendorCode, partSlNo, scanDateObj, scanMonth, scanYear, revNo, format, raw_scan_text, raw_scan_text, unique_key]
    );

    const newBalance = plan.balance_quantity - 1;
    const newStatus = newBalance === 0 ? 'completed' : 'pending';

    await connection.execute(
      'UPDATE despatch_plans SET balance_quantity = ?, scanned_quantity = scanned_quantity + 1, status = ?, updated_at = NOW() WHERE id = ?',
      [newBalance, newStatus, plan.id]
    );

    await connection.commit();
    connection.release();

    const scanDetails = {
      partNo,
      vendorCode,
      partSlNo,
      plan_id: plan.id,
      raw_scan_text,
      scanned_label: raw_scan_text,
      status: 'success',
      remark: 'verified',
      user_id: req.user.id,
      username: req.user.username,
      user_name: req.user.name,
      scanned_at: scanDateObj
    };
    emitToAll('despatch:scan', scanDetails);

    res.json({ message: 'Scan successful', parsed, plan_id: plan.id, raw_scan_text, scanned_label: raw_scan_text, status: 'success' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); connection.release(); } catch(e) {}
    }
    console.error('Scan error:', error);
    res.status(500).json({ message: 'Server error processing scan' });
  }
});

router.get('/logs', async (req, res) => {
  try {
    let sql = `
      SELECT s.*, u.username, u.name as user_name 
      FROM scan_logs s 
      LEFT JOIN users u ON s.user_id = u.id 
      WHERE 1=1
    `;
    let params = [];
    
    if (req.user.role !== 'admin') {
      sql += ' AND s.user_id = ?';
      params.push(req.user.id);
    }
    
    if (req.query.date) {
      sql += ' AND DATE(s.scan_date) = ?';
      params.push(req.query.date);
    }
    
    if (req.query.part_number) {
      sql += ' AND s.part_number = ?';
      params.push(req.query.part_number);
    }

    if (req.query.status) {
      sql += ' AND s.status = ?';
      params.push(req.query.status);
    }

    if (req.query.plan_id) {
      sql += ' AND s.plan_id = ?';
      params.push(req.query.plan_id);
    }

    if (req.query.gate_pass_number) {
      sql += ' AND s.gate_pass_number = ?';
      params.push(req.query.gate_pass_number);
    }
    
    sql += ' ORDER BY s.scanned_at DESC LIMIT 1000';
    
    const logs = await query(sql, params);
    res.json(logs);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/export', async (req, res) => {
  try {
    let sql = `
      SELECT s.*, u.username, u.name as user_name 
      FROM scan_logs s 
      LEFT JOIN users u ON s.user_id = u.id 
      WHERE 1=1
    `;
    let params = [];
    
    if (req.user.role !== 'admin') {
      sql += ' AND s.user_id = ?';
      params.push(req.user.id);
    }

    if (req.query.date) {
      sql += ' AND DATE(s.scan_date) = ?';
      params.push(req.query.date);
    }
    
    sql += ' ORDER BY s.scanned_at DESC';
    
    const logs = await query(sql, params);
    res.json(logs);
  } catch (error) {
    console.error('Error exporting logs:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
