import express from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../config/db.js';
import { protectRoute } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Please provide username and password' });
    }

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);

    if (!user || user.password !== password) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(401).json({ message: 'User account is disabled' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: '30d'
    });

    const isProduction = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';

    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    const userToReturn = { ...user };
    delete userToReturn.password;

    res.json({ user: userToReturn, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('token', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    expires: new Date(0)
  });
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', protectRoute, (req, res) => {
  res.json({ user: req.user });
});

export default router;
