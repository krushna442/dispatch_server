import express from 'express';
import { query, execute } from '../config/db.js';
import { protectRoute, authorizeRoles } from '../middleware/auth.js';
import { emitToAll } from '../utils/socket.js';

const router = express.Router();
router.use(protectRoute);

router.get('/', async (req, res) => {
  try {
    const dateFilter = req.query.date || new Date().toISOString().split('T')[0];
    const isToday = dateFilter === new Date().toISOString().split('T')[0];
    
    let sql = 'SELECT * FROM despatch_plans WHERE 1=1';
    let params = [];
    
    if (isToday) {
      // Include today's plans + pending carryovers
      sql += " AND (plan_date = ? OR (plan_date < ? AND status = 'pending' AND balance_quantity > 0))";
      params.push(dateFilter, dateFilter);
    } else {
      sql += ' AND plan_date = ?';
      params.push(dateFilter);
    }
    
    sql += ' ORDER BY plan_date DESC';
    
    const plans = await query(sql, params);
    res.json(plans);
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/import', authorizeRoles('admin', 'sales'), async (req, res) => {
  try {
    const plans = req.body;
    if (!Array.isArray(plans)) {
      return res.status(400).json({ message: 'Invalid format. Expected array of plans.' });
    }
    
    const today = new Date().toISOString().split('T')[0];
    
    for (const plan of plans) {
      const { part_number, quantity, user_id } = plan;
      const targetUserId = user_id || req.user.id;
      
      const existing = await query('SELECT * FROM despatch_plans WHERE user_id = ? AND part_number = ? AND plan_date = ?', [targetUserId, part_number, today]);
      
      if (existing.length > 0) {
        const e = existing[0];
        const newBalance = e.balance_quantity + quantity;
        await execute(
          'UPDATE despatch_plans SET quantity = quantity + ?, balance_quantity = ?, updated_at = NOW() WHERE id = ?',
          [quantity, newBalance, e.id]
        );
      } else {
        await execute(
          "INSERT INTO despatch_plans (user_id, part_number, quantity, balance_quantity, scanned_quantity, status, plan_date) VALUES (?, ?, ?, ?, 0, 'pending', ?)",
          [targetUserId, part_number, quantity, quantity, today]
        );
      }
    }
    
    emitToAll('despatch:plans-changed', { action: 'import' });
    res.json({ message: 'Plans imported successfully' });
  } catch (error) {
    console.error('Error importing plans:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authorizeRoles('admin', 'sales'), async (req, res) => {
  try {
    const { part_number, quantity, user_id, plan_date } = req.body;
    const targetUserId = user_id || req.user.id;
    const date = plan_date || new Date().toISOString().split('T')[0];
    
    await execute(
      "INSERT INTO despatch_plans (user_id, part_number, quantity, balance_quantity, scanned_quantity, status, plan_date) VALUES (?, ?, ?, ?, 0, 'pending', ?)",
      [targetUserId, part_number, quantity, quantity, date]
    );
    
    emitToAll('despatch:plans-changed', { action: 'create' });
    res.status(201).json({ message: 'Plan created successfully' });
  } catch (error) {
    console.error('Error creating plan:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', authorizeRoles('admin', 'sales'), async (req, res) => {
  try {
    const { quantity, schedule_date } = req.body;
    const planId = req.params.id;
    
    const plan = await query('SELECT * FROM despatch_plans WHERE id = ?', [planId]);
    if (!plan.length) return res.status(404).json({ message: 'Plan not found' });
    
    const p = plan[0];
    const scanned = p.scanned_quantity;
    
    if (quantity < scanned) {
      return res.status(400).json({ message: 'Quantity cannot be less than scanned amount' });
    }
    
    const newBalance = quantity - scanned;
    const newStatus = newBalance === 0 ? 'completed' : 'pending';
    
    await execute(
      'UPDATE despatch_plans SET quantity = ?, balance_quantity = ?, status = ?, schedule_date = ?, updated_at = NOW() WHERE id = ?',
      [quantity, newBalance, newStatus, schedule_date || p.schedule_date, planId]
    );
    
    emitToAll('despatch:plans-changed', { action: 'update', id: planId });
    res.json({ message: 'Plan updated successfully' });
  } catch (error) {
    console.error('Error updating plan:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', authorizeRoles('admin', 'sales'), async (req, res) => {
  try {
    const plan = await query('SELECT * FROM despatch_plans WHERE id = ?', [req.params.id]);
    if (!plan.length) return res.status(404).json({ message: 'Plan not found' });
    
    if (plan[0].scanned_quantity > 0) {
      return res.status(400).json({ message: 'Cannot delete plan with existing scans' });
    }
    
    await execute('DELETE FROM despatch_plans WHERE id = ?', [req.params.id]);
    
    emitToAll('despatch:plans-changed', { action: 'delete', id: req.params.id });
    res.json({ message: 'Plan deleted successfully' });
  } catch (error) {
    console.error('Error deleting plan:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
