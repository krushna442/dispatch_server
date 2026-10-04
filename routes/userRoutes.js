import express from 'express';
import { query, execute } from '../config/db.js';
import { protectRoute, adminOnly } from '../middleware/auth.js';

const router = express.Router();

router.use(protectRoute);
router.use(adminOnly);

router.get('/', async (req, res) => {
  try {
    const users = await query('SELECT id, name, username, email, role, vendor_code, customer_name, receive_despatch_mail, is_active, created_at FROM users');
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, username, password, email, role, vendor_code, customer_name, receive_despatch_mail } = req.body;
    
    if (!username || !password || !name) {
      return res.status(400).json({ message: 'Please provide name, username and password' });
    }

    const validRoles = ['admin', 'sales', 'operator'];
    const userRole = validRoles.includes(role) ? role : 'operator';

    const result = await execute(
      'INSERT INTO users (name, username, password, email, role, vendor_code, customer_name, receive_despatch_mail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, username, password, email || null, userRole, vendor_code || null, customer_name || null, receive_despatch_mail ? 1 : 0]
    );

    res.status(201).json({ id: result.insertId, message: 'User created successfully' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Username already exists' });
    }
    console.error('Error creating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, email, role, vendor_code, customer_name, is_active, password, receive_despatch_mail } = req.body;
    
    const validRoles = ['admin', 'sales', 'operator'];
    const userRole = validRoles.includes(role) ? role : 'operator';

    let sql = 'UPDATE users SET name = ?, email = ?, role = ?, vendor_code = ?, customer_name = ?, is_active = ?, receive_despatch_mail = ?';
    let params = [name, email || null, userRole, vendor_code || null, customer_name || null, is_active ? 1 : 0, receive_despatch_mail ? 1 : 0];
    
    if (password) {
      sql += ', password = ?';
      params.push(password);
    }
    
    sql += ' WHERE id = ?';
    params.push(req.params.id);

    await execute(sql, params);
    
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await execute('UPDATE users SET is_active = false WHERE id = ?', [req.params.id]);
    res.json({ message: 'User deactivated successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
