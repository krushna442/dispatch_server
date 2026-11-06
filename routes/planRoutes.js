import express from 'express';
import { query, queryOne, execute } from '../config/db.js';
import { protectRoute, authorizeRoles } from '../middleware/auth.js';
import { emitToAll } from '../utils/socket.js';

const router = express.Router();
router.use(protectRoute);

// Standard customer presets with their respective vendor codes
const PRESET_CUSTOMERS = [
  { customer_name: 'ASL & Switch Mobility', vendor_code: '7205761' },
  { customer_name: 'Tata Motors (TML)', vendor_code: '7205761' },
  { customer_name: 'VE Commercial Vehicles (VECB)', vendor_code: '113072' },
  { customer_name: 'IPLT', vendor_code: '10830-6' },
  { customer_name: 'MBP (R64535)', vendor_code: 'R64535' },
];

// Helper to find vendor code by customer name
function getPresetVendorCode(customerName) {
  if (!customerName) return null;
  const match = PRESET_CUSTOMERS.find(
    (c) => c.customer_name.toLowerCase().trim() === customerName.toLowerCase().trim()
  );
  return match ? match.vendor_code : null;
}

// GET /api/plans/customers - Unique customers list merged with standard presets
router.get('/customers', async (req, res) => {
  try {
    const dbCustomers = await query(`
      SELECT DISTINCT customer_name, vendor_code 
      FROM (
        SELECT customer_name, vendor_code FROM despatch_plans WHERE customer_name IS NOT NULL AND customer_name != ''
        UNION
        SELECT customer_name, vendor_code FROM users WHERE customer_name IS NOT NULL AND customer_name != ''
      ) AS combined
      ORDER BY customer_name ASC
    `);

    const customerMap = new Map();
    // 1. Add standard presets
    for (const p of PRESET_CUSTOMERS) {
      customerMap.set(p.customer_name.toLowerCase().trim(), {
        customer_name: p.customer_name,
        vendor_code: p.vendor_code,
      });
    }
    // 2. Add or update with database entries
    for (const row of dbCustomers) {
      if (row.customer_name) {
        const key = row.customer_name.toLowerCase().trim();
        if (customerMap.has(key)) {
          if (row.vendor_code) {
            customerMap.get(key).vendor_code = row.vendor_code;
          }
        } else {
          customerMap.set(key, {
            customer_name: row.customer_name,
            vendor_code: row.vendor_code || '',
          });
        }
      }
    }

    res.json(Array.from(customerMap.values()));
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const startDate = req.query.startDate || req.query.fromDate;
    const endDate = req.query.endDate || req.query.toDate;
    const singleDate = req.query.date;
    const customerFilter = req.query.customer_name || req.query.customer;
    
    let sql = 'SELECT * FROM despatch_plans WHERE 1=1';
    let params = [];

    // Filter by customer if requested (or 'all' for all customers)
    if (customerFilter && customerFilter !== 'all') {
      sql += ' AND customer_name = ?';
      params.push(customerFilter);
    }

    // Role-based visibility:
    // Operator is constrained to their assigned customer group / vendor code
    // Sales users with a dedicated customer see plans matching their customer OR any plan they uploaded
    // Admins see all plans across all customers
    if (req.user.role === 'operator') {
      if (req.user.customer_name || req.user.vendor_code) {
        sql += ' AND (customer_name = ? OR vendor_code = ? OR user_id = ?)';
        params.push(req.user.customer_name || '', req.user.vendor_code || '', req.user.id);
      } else {
        sql += ' AND user_id = ?';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'sales' && req.user.customer_name) {
      sql += ' AND (customer_name = ? OR vendor_code = ? OR user_id = ?)';
      params.push(req.user.customer_name, req.user.vendor_code || '', req.user.id);
    }
    
    if (startDate && endDate) {
      if (startDate === endDate) {
        if (startDate === today) {
          sql += " AND (plan_date = ? OR (plan_date < ? AND status = 'pending' AND balance_quantity > 0))";
          params.push(startDate, startDate);
        } else {
          sql += ' AND plan_date = ?';
          params.push(startDate);
        }
      } else {
        if (endDate >= today) {
          sql += " AND ((plan_date BETWEEN ? AND ?) OR (plan_date < ? AND status = 'pending' AND balance_quantity > 0))";
          params.push(startDate, endDate, startDate);
        } else {
          sql += ' AND plan_date BETWEEN ? AND ?';
          params.push(startDate, endDate);
        }
      }
    } else {
      const dateFilter = singleDate || today;
      const isToday = dateFilter === today;
      if (isToday) {
        // Include today's plans + pending carryovers
        sql += " AND (plan_date = ? OR (plan_date < ? AND status = 'pending' AND balance_quantity > 0))";
        params.push(dateFilter, dateFilter);
      } else {
        sql += ' AND plan_date = ?';
        params.push(dateFilter);
      }
    }
    
    sql += ' ORDER BY plan_date DESC, id DESC';
    
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
      const { part_number, quantity, user_id, customer_name, vendor_code, schedule_date, plan_date } = plan;
      const targetUserId = user_id || req.user.id;
      const customer = (customer_name && customer_name.trim()) || req.user.customer_name || null;
      let vendor = (vendor_code && vendor_code.trim()) || req.user.vendor_code || null;
      const targetDate = plan_date || schedule_date || today;

      // Auto-lookup vendor_code if customer name is known but vendor_code is missing
      if (customer && !vendor) {
        vendor = getPresetVendorCode(customer);
        if (!vendor) {
          const known = await queryOne(
            'SELECT vendor_code FROM despatch_plans WHERE customer_name = ? AND vendor_code IS NOT NULL AND vendor_code != "" LIMIT 1',
            [customer]
          ) || await queryOne(
            'SELECT vendor_code FROM users WHERE customer_name = ? AND vendor_code IS NOT NULL AND vendor_code != "" LIMIT 1',
            [customer]
          );
          if (known && known.vendor_code) {
            vendor = known.vendor_code;
          }
        }
      }
      
      let existing;
      if (customer) {
        existing = await query(
          'SELECT * FROM despatch_plans WHERE customer_name = ? AND part_number = ? AND plan_date = ?',
          [customer, part_number, targetDate]
        );
      } else {
        existing = await query(
          'SELECT * FROM despatch_plans WHERE user_id = ? AND part_number = ? AND plan_date = ?',
          [targetUserId, part_number, targetDate]
        );
      }
      
      if (existing.length > 0) {
        const e = existing[0];
        const newBalance = e.balance_quantity + quantity;
        await execute(
          'UPDATE despatch_plans SET quantity = quantity + ?, balance_quantity = ?, vendor_code = COALESCE(?, vendor_code), updated_at = NOW() WHERE id = ?',
          [quantity, newBalance, vendor, e.id]
        );
      } else {
        await execute(
          "INSERT INTO despatch_plans (user_id, part_number, quantity, balance_quantity, scanned_quantity, status, plan_date, schedule_date, customer_name, vendor_code) VALUES (?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)",
          [targetUserId, part_number, quantity, quantity, targetDate, schedule_date || targetDate, customer, vendor]
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
    const { part_number, quantity, user_id, plan_date, schedule_date, customer_name, vendor_code } = req.body;
    const targetUserId = user_id || req.user.id;
    const date = plan_date || new Date().toISOString().split('T')[0];
    const customer = (customer_name && customer_name.trim()) || req.user.customer_name || null;
    let vendor = (vendor_code && vendor_code.trim()) || req.user.vendor_code || null;
    
    if (customer && !vendor) {
      vendor = getPresetVendorCode(customer);
      if (!vendor) {
        const known = await queryOne(
          'SELECT vendor_code FROM despatch_plans WHERE customer_name = ? AND vendor_code IS NOT NULL AND vendor_code != "" LIMIT 1',
          [customer]
        ) || await queryOne(
          'SELECT vendor_code FROM users WHERE customer_name = ? AND vendor_code IS NOT NULL AND vendor_code != "" LIMIT 1',
          [customer]
        );
        if (known && known.vendor_code) {
          vendor = known.vendor_code;
        }
      }
    }

    await execute(
      "INSERT INTO despatch_plans (user_id, part_number, quantity, balance_quantity, scanned_quantity, status, plan_date, schedule_date, customer_name, vendor_code) VALUES (?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)",
      [targetUserId, part_number, quantity, quantity, date, schedule_date || date, customer, vendor]
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
    const { quantity, schedule_date, customer_name, vendor_code } = req.body;
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
    const updatedCustomer = customer_name !== undefined ? (customer_name ? customer_name.trim() : null) : p.customer_name;
    let updatedVendor = vendor_code !== undefined ? (vendor_code ? vendor_code.trim() : null) : p.vendor_code;
    
    if (updatedCustomer && !updatedVendor) {
      updatedVendor = getPresetVendorCode(updatedCustomer) || p.vendor_code;
    }

    await execute(
      'UPDATE despatch_plans SET quantity = ?, balance_quantity = ?, status = ?, schedule_date = ?, customer_name = ?, vendor_code = ?, updated_at = NOW() WHERE id = ?',
      [quantity, newBalance, newStatus, schedule_date || p.schedule_date, updatedCustomer, updatedVendor, planId]
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
