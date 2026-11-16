import express from 'express';
import { query, queryOne } from '../config/db.js';
import { protectRoute, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
router.use(protectRoute);

router.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    let plansWhere = 'WHERE 1=1';
    let plansParams = [];
    let scansWhere = "WHERE (status IS NULL OR status = 'success')";
    let scansParams = [];

    if (req.user.role !== 'admin') {
      if (req.user.customer_name || req.user.vendor_code) {
        plansWhere += ' AND (customer_name = ? OR vendor_code = ?)';
        plansParams.push(req.user.customer_name || '', req.user.vendor_code || '');
        if (req.user.role === 'sales') {
          scansWhere += ' AND (vendor_code = ? OR user_id = ?)';
          scansParams.push(req.user.vendor_code || '', req.user.id);
        } else {
          // operator: count this user's scans
          scansWhere += ' AND user_id = ?';
          scansParams.push(req.user.id);
        }
      } else {
        plansWhere += ' AND user_id = ?';
        plansParams.push(req.user.id);
        scansWhere += ' AND user_id = ?';
        scansParams.push(req.user.id);
      }
    }

    const plansStats = await queryOne(`
      SELECT 
        COUNT(*) as total_plans,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_plans,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_plans
      FROM despatch_plans ${plansWhere}
    `, plansParams);

    const scanStats = await queryOne(`
      SELECT 
        COUNT(*) as total_scans,
        SUM(CASE WHEN DATE(scan_date) = ? THEN 1 ELSE 0 END) as today_scans
      FROM scan_logs ${scansWhere}
    `, [today, ...scansParams]);

    const total = Number(plansStats?.total_plans || 0);
    const completed = Number(plansStats?.completed_plans || 0);
    const completion_rate = total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0;

    res.json({
      total_plans: total,
      completed_plans: completed,
      pending_plans: Number(plansStats?.pending_plans || 0),
      today_scans: Number(scanStats?.today_scans || 0),
      total_scans: Number(scanStats?.total_scans || 0),
      completion_rate
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/daily', async (req, res) => {
  try {
    let whereFilter = '';
    let params = [];
    if (req.user.role !== 'admin') {
      if (req.user.role === 'sales' && (req.user.vendor_code || req.user.customer_name)) {
        whereFilter = 'AND (vendor_code = ? OR user_id = ?)';
        params.push(req.user.vendor_code || '', req.user.id);
      } else {
        whereFilter = 'AND user_id = ?';
        params.push(req.user.id);
      }
    }
    
    const stats = await query(`
      SELECT DATE(scan_date) as date, COUNT(*) as count 
      FROM scan_logs 
      WHERE scan_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
        AND (status IS NULL OR status = 'success') ${whereFilter}
      GROUP BY DATE(scan_date)
      ORDER BY date ASC
    `, params);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics daily error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users', authorizeRoles('admin', 'sales'), async (req, res) => {
  try {
    let userFilter = '';
    let params = [];
    if (req.user.role === 'sales' && (req.user.customer_name || req.user.vendor_code)) {
      userFilter = 'WHERE u.customer_name = ? OR u.vendor_code = ?';
      params.push(req.user.customer_name || '', req.user.vendor_code || '');
    }

    const stats = await query(`
      SELECT 
        u.id, 
        u.name, 
        u.username,
        u.role,
        u.customer_name,
        u.vendor_code,
        COALESCE(
          GREATEST(
            CASE 
              WHEN u.customer_name IS NOT NULL AND u.customer_name != '' THEN (
                SELECT COUNT(*) FROM despatch_plans WHERE customer_name = u.customer_name
              )
              WHEN u.vendor_code IS NOT NULL AND u.vendor_code != '' THEN (
                SELECT COUNT(*) FROM despatch_plans WHERE vendor_code = u.vendor_code
              )
              ELSE (
                SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id
              )
            END,
            (SELECT COUNT(DISTINCT plan_id) FROM scan_logs WHERE user_id = u.id AND plan_id IS NOT NULL AND (status IS NULL OR status = 'success'))
          ),
          0
        ) as total_plans,
        COALESCE(
          GREATEST(
            CASE 
              WHEN u.customer_name IS NOT NULL AND u.customer_name != '' THEN (
                SELECT COUNT(*) FROM despatch_plans WHERE customer_name = u.customer_name AND status = 'completed'
              )
              WHEN u.vendor_code IS NOT NULL AND u.vendor_code != '' THEN (
                SELECT COUNT(*) FROM despatch_plans WHERE vendor_code = u.vendor_code AND status = 'completed'
              )
              ELSE (
                SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id AND status = 'completed'
              )
            END,
            (SELECT COUNT(DISTINCT sl.plan_id) FROM scan_logs sl 
             JOIN despatch_plans dp ON sl.plan_id = dp.id 
             WHERE sl.user_id = u.id AND dp.status = 'completed' AND (sl.status IS NULL OR sl.status = 'success'))
          ),
          0
        ) as completed_plans,
        COALESCE((SELECT COUNT(*) FROM scan_logs WHERE user_id = u.id AND (status IS NULL OR status = 'success')), 0) as scans,
        COALESCE((SELECT COUNT(DISTINCT plan_id) FROM scan_logs WHERE user_id = u.id AND plan_id IS NOT NULL AND (status IS NULL OR status = 'success')), 0) as user_scanned_plans,
        (SELECT MAX(scan_date) FROM scan_logs WHERE user_id = u.id) as last_active
      FROM users u
      ${userFilter}
      ORDER BY scans DESC, total_plans DESC
    `, params);

    // Fetch breakdown of who scanned plans uploaded by each user
    const scannedByRows = await query(`
      SELECT 
        dp.user_id as uploader_id,
        sl.user_id as scanner_id,
        su.name as scanner_name,
        su.username as scanner_username,
        su.role as scanner_role,
        COUNT(*) as scan_count
      FROM scan_logs sl
      JOIN despatch_plans dp ON sl.plan_id = dp.id
      JOIN users su ON sl.user_id = su.id
      WHERE (sl.status IS NULL OR sl.status = 'success')
      GROUP BY dp.user_id, sl.user_id, su.name, su.username, su.role
      ORDER BY scan_count DESC
    `);

    // Fetch breakdown of whose plans each user scanned
    const scannedForRows = await query(`
      SELECT 
        sl.user_id as scanner_id,
        dp.user_id as uploader_id,
        uu.name as uploader_name,
        uu.username as uploader_username,
        uu.role as uploader_role,
        COUNT(*) as scan_count,
        COUNT(DISTINCT dp.id) as plans_count
      FROM scan_logs sl
      JOIN despatch_plans dp ON sl.plan_id = dp.id
      JOIN users uu ON dp.user_id = uu.id
      WHERE (sl.status IS NULL OR sl.status = 'success')
      GROUP BY sl.user_id, dp.user_id, uu.name, uu.username, uu.role
      ORDER BY scan_count DESC
    `);

    const scannedByMap = {};
    for (const r of scannedByRows) {
      if (!scannedByMap[r.uploader_id]) scannedByMap[r.uploader_id] = [];
      scannedByMap[r.uploader_id].push({
        scanner_id: r.scanner_id,
        scanner_name: r.scanner_name || r.scanner_username || 'Unknown',
        scanner_username: r.scanner_username,
        scanner_role: r.scanner_role,
        scan_count: Number(r.scan_count)
      });
    }

    const scannedForMap = {};
    for (const r of scannedForRows) {
      if (!scannedForMap[r.scanner_id]) scannedForMap[r.scanner_id] = [];
      scannedForMap[r.scanner_id].push({
        uploader_id: r.uploader_id,
        uploader_name: r.uploader_name || r.uploader_username || 'Unknown',
        uploader_username: r.uploader_username,
        uploader_role: r.uploader_role,
        scan_count: Number(r.scan_count),
        plans_count: Number(r.plans_count)
      });
    }

    const enrichedStats = stats.map(u => ({
      ...u,
      total_plans: Number(u.total_plans) || 0,
      completed_plans: Number(u.completed_plans) || 0,
      scans: Number(u.scans) || 0,
      user_scanned_plans: Number(u.user_scanned_plans) || 0,
      scanned_by: scannedByMap[u.id] || [],
      scanned_for: scannedForMap[u.id] || []
    }));
    
    res.json(enrichedStats);
  } catch (error) {
    console.error('Analytics users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/analytics/plans - Detailed audit of plans: uploaded by whom, scanned by whom, target vs actual
router.get('/plans', async (req, res) => {
  try {
    const { startDate, endDate, customer_name, status, search, user_id } = req.query;
    let sql = `
      SELECT 
        dp.id,
        dp.user_id,
        dp.part_number,
        dp.quantity,
        dp.scanned_quantity,
        dp.balance_quantity,
        dp.status,
        dp.plan_date,
        dp.schedule_date,
        dp.customer_name,
        dp.vendor_code,
        dp.gate_pass_number,
        dp.created_at,
        dp.updated_at,
        u.name as uploader_name,
        u.username as uploader_username,
        u.role as uploader_role
      FROM despatch_plans dp
      LEFT JOIN users u ON dp.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'operator') {
      if (req.user.customer_name || req.user.vendor_code) {
        sql += ' AND (dp.customer_name = ? OR dp.vendor_code = ? OR dp.user_id = ?)';
        params.push(req.user.customer_name || '', req.user.vendor_code || '', req.user.id);
      }
    } else if (req.user.role === 'sales' && req.user.customer_name) {
      sql += ' AND (dp.customer_name = ? OR dp.vendor_code = ? OR dp.user_id = ?)';
      params.push(req.user.customer_name, req.user.vendor_code || '', req.user.id);
    }

    if (customer_name && customer_name !== 'all') {
      sql += ' AND dp.customer_name = ?';
      params.push(customer_name);
    }

    if (status && status !== 'all') {
      sql += ' AND dp.status = ?';
      params.push(status);
    }

    if (user_id) {
      sql += ' AND dp.user_id = ?';
      params.push(user_id);
    }

    if (startDate && endDate) {
      if (startDate === endDate) {
        sql += ' AND dp.plan_date = ?';
        params.push(startDate);
      } else {
        sql += ' AND dp.plan_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
    } else if (startDate) {
      sql += ' AND dp.plan_date >= ?';
      params.push(startDate);
    } else if (endDate) {
      sql += ' AND dp.plan_date <= ?';
      params.push(endDate);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      sql += ' AND (dp.part_number LIKE ? OR dp.customer_name LIKE ? OR dp.vendor_code LIKE ? OR u.name LIKE ? OR u.username LIKE ?)';
      params.push(term, term, term, term, term);
    }

    sql += ' ORDER BY dp.plan_date DESC, dp.id DESC LIMIT 500';

    const plans = await query(sql, params);

    if (plans.length === 0) {
      return res.json([]);
    }

    const planIds = plans.map(p => p.id);
    const placeholders = planIds.map(() => '?').join(',');
    const scanRows = await query(`
      SELECT 
        sl.plan_id,
        sl.user_id as scanner_id,
        su.name as scanner_name,
        su.username as scanner_username,
        su.role as scanner_role,
        COUNT(*) as scan_count,
        MAX(sl.scan_date) as last_scanned_at
      FROM scan_logs sl
      LEFT JOIN users su ON sl.user_id = su.id
      WHERE sl.plan_id IN (${placeholders}) AND (sl.status IS NULL OR sl.status = 'success')
      GROUP BY sl.plan_id, sl.user_id, su.name, su.username, su.role
      ORDER BY scan_count DESC
    `, planIds);

    const scannerMap = {};
    for (const r of scanRows) {
      if (!scannerMap[r.plan_id]) scannerMap[r.plan_id] = [];
      scannerMap[r.plan_id].push({
        scanner_id: r.scanner_id,
        scanner_name: r.scanner_name || r.scanner_username || 'Unknown',
        scanner_username: r.scanner_username,
        scanner_role: r.scanner_role,
        scan_count: Number(r.scan_count),
        last_scanned_at: r.last_scanned_at
      });
    }

    const result = plans.map(p => {
      const scanners = scannerMap[p.id] || [];
      const totalActualScanned = scanners.reduce((sum, s) => sum + s.scan_count, 0);
      const effectiveScanned = Math.max(p.scanned_quantity || 0, totalActualScanned);
      const targetQty = Number(p.quantity) || 0;
      const balanceQty = Math.max(0, targetQty - effectiveScanned);
      const fulfillment_pct = targetQty > 0 
        ? Math.min(100, Math.round((effectiveScanned / targetQty) * 100))
        : 0;

      return {
        id: p.id,
        part_number: p.part_number,
        quantity: targetQty,
        scanned_quantity: effectiveScanned,
        balance_quantity: balanceQty,
        fulfillment_pct,
        status: (targetQty > 0 && effectiveScanned >= targetQty) ? 'completed' : p.status,
        plan_date: p.plan_date,
        schedule_date: p.schedule_date,
        customer_name: p.customer_name,
        vendor_code: p.vendor_code,
        gate_pass_number: p.gate_pass_number,
        created_at: p.created_at,
        uploader: {
          id: p.user_id,
          name: p.uploader_name || 'System / Unassigned',
          username: p.uploader_username,
          role: p.uploader_role
        },
        scanners
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Analytics plans error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/parts', async (req, res) => {
  try {
    let whereFilter = '';
    let params = [];
    if (req.user.role !== 'admin') {
      if (req.user.role === 'sales' && (req.user.vendor_code || req.user.customer_name)) {
        whereFilter = 'AND (vendor_code = ? OR user_id = ?)';
        params.push(req.user.vendor_code || '', req.user.id);
      } else {
        whereFilter = 'AND user_id = ?';
        params.push(req.user.id);
      }
    }
    
    const stats = await query(`
      SELECT part_number, COUNT(*) as scan_count 
      FROM scan_logs 
      WHERE (status IS NULL OR status = 'success') ${whereFilter}
      GROUP BY part_number
      ORDER BY scan_count DESC
      LIMIT 20
    `, params);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics parts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
