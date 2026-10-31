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
          CASE 
            WHEN u.customer_name IS NOT NULL AND u.customer_name != '' THEN (
              SELECT COUNT(*) FROM despatch_plans WHERE customer_name = u.customer_name
            )
            WHEN u.vendor_code IS NOT NULL AND u.vendor_code != '' THEN (
              SELECT COUNT(*) FROM despatch_plans WHERE vendor_code = u.vendor_code
            )
            ELSE (
              SELECT GREATEST(
                (SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id),
                (SELECT COUNT(DISTINCT plan_id) FROM scan_logs WHERE user_id = u.id AND plan_id IS NOT NULL)
              )
            )
          END,
          0
        ) as total_plans,
        COALESCE(
          CASE 
            WHEN u.customer_name IS NOT NULL AND u.customer_name != '' THEN (
              SELECT COUNT(*) FROM despatch_plans WHERE customer_name = u.customer_name AND status = 'completed'
            )
            WHEN u.vendor_code IS NOT NULL AND u.vendor_code != '' THEN (
              SELECT COUNT(*) FROM despatch_plans WHERE vendor_code = u.vendor_code AND status = 'completed'
            )
            ELSE (
              SELECT GREATEST(
                (SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id AND status = 'completed'),
                (SELECT COUNT(DISTINCT sl.plan_id) FROM scan_logs sl 
                 JOIN despatch_plans dp ON sl.plan_id = dp.id 
                 WHERE sl.user_id = u.id AND dp.status = 'completed')
              )
            )
          END,
          0
        ) as completed_plans,
        COALESCE((SELECT COUNT(*) FROM scan_logs WHERE user_id = u.id AND (status IS NULL OR status = 'success')), 0) as scans,
        COALESCE((SELECT COUNT(DISTINCT plan_id) FROM scan_logs WHERE user_id = u.id AND plan_id IS NOT NULL AND (status IS NULL OR status = 'success')), 0) as user_scanned_plans,
        (SELECT MAX(scan_date) FROM scan_logs WHERE user_id = u.id) as last_active
      FROM users u
      ${userFilter}
      ORDER BY scans DESC, total_plans DESC
    `, params);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics users error:', error);
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
