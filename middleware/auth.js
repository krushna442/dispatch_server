import jwt from 'jsonwebtoken';
import { queryOne } from '../config/db.js';

export async function protectRoute(req, res, next) {
  try {
    let token = req.cookies?.token;

    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [decoded.userId]);

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    if (!user.is_active) {
      return res.status(401).json({ message: 'User is inactive' });
    }

    // Remove password from user object
    delete user.password;
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ message: 'Not authorized, token failed' });
  }
}

export function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) {
      next();
    } else {
      res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
    }
  };
}

export function adminOnly(req, res, next) {
  return authorizeRoles('admin')(req, res, next);
}
