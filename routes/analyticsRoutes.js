import express from 'express';
import { query, queryOne } from '../config/db.js';
import { protectRoute, adminOnly } from '../middleware/auth.js';

const router = express.Router();
router.use(protectRoute);

router.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const plansStats = await queryOne(`
      SELECT 
        COUNT(*) as total_plans,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_plans,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_plans
      FROM despatch_plans WHERE 1=1
    `);

    const scanStats = await queryOne(`
      SELECT 
        COUNT(*) as total_scans,
        SUM(CASE WHEN DATE(scan_date) = '${today}' THEN 1 ELSE 0 END) as today_scans
      FROM scan_logs WHERE 1=1
    `);

    const total = Number(plansStats.total_plans || 0);
    const completed = Number(plansStats.completed_plans || 0);
    const completion_rate = total > 0 ? ((completed / total) * 100).toFixed(2) : 0;

    res.json({
      total_plans: total,
      completed_plans: completed,
      pending_plans: Number(plansStats.pending_plans || 0),
      today_scans: Number(scanStats.today_scans || 0),
      total_scans: Number(scanStats.total_scans || 0),
      completion_rate: Number(completion_rate)
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/daily', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userIdFilter = isAdmin ? '' : `AND user_id = ${req.user.id}`;
    
    const stats = await query(`
      SELECT DATE(scan_date) as date, COUNT(*) as count 
      FROM scan_logs 
      WHERE scan_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${userIdFilter}
      GROUP BY DATE(scan_date)
      ORDER BY date ASC
    `);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics daily error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users', adminOnly, async (req, res) => {
  try {
    const stats = await query(`
      SELECT 
        u.id, u.name, u.username,
        (SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id) as total_plans,
        (SELECT COUNT(*) FROM despatch_plans WHERE user_id = u.id AND status = 'completed') as completed_plans,
        (SELECT COUNT(*) FROM scan_logs WHERE user_id = u.id) as scans,
        (SELECT MAX(scan_date) FROM scan_logs WHERE user_id = u.id) as last_active
      FROM users u
      ORDER BY scans DESC
    `);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/parts', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userIdFilter = isAdmin ? '' : `AND user_id = ${req.user.id}`;
    
    const stats = await query(`
      SELECT part_number, COUNT(*) as scan_count 
      FROM scan_logs 
      WHERE 1=1 ${userIdFilter}
      GROUP BY part_number
      ORDER BY scan_count DESC
      LIMIT 20
    `);
    
    res.json(stats);
  } catch (error) {
    console.error('Analytics parts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
