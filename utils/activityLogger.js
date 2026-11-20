import { execute } from '../config/db.js';

/**
 * Log user activity into activity_logs table
 * @param {import('express').Request} req
 * @param {Object} options
 * @param {string} options.action Action identifier e.g. USER_LOGIN, PLAN_IMPORT, SCAN_SUCCESS
 * @param {'auth'|'plan'|'scan'|'user'|'gatepass'|'system'} [options.action_type='system']
 * @param {string} options.description Human readable description of the action
 * @param {Object} [options.details=null] Optional metadata object
 * @param {number} [options.userId=null] Override user ID if not on req.user
 * @param {string} [options.username=null] Override username if not on req.user
 * @param {string} [options.userName=null] Override user full name if not on req.user
 * @param {string} [options.role=null] Override user role if not on req.user
 */
export async function logActivity(req, {
  action,
  action_type = 'system',
  description,
  details = null,
  userId = null,
  username = null,
  userName = null,
  role = null
}) {
  try {
    const effectiveUserId = userId || req?.user?.id || null;
    const effectiveUsername = username || req?.user?.username || null;
    const effectiveUserName = userName || req?.user?.name || null;
    const effectiveRole = role || req?.user?.role || null;

    // Extract real client IP behind proxies, Cloudflare, or local dev
    let rawIp = req?.headers?.['x-forwarded-for'] || 
                 req?.headers?.['x-real-ip'] || 
                 req?.socket?.remoteAddress || 
                 req?.ip || 
                 '127.0.0.1';

    if (typeof rawIp === 'string') {
      rawIp = rawIp.split(',')[0].trim();
    } else if (Array.isArray(rawIp)) {
      rawIp = rawIp[0];
    }

    // Clean IPv6 loopback to readable IPv4
    if (rawIp === '::1' || rawIp === '::ffff:127.0.0.1') {
      rawIp = '127.0.0.1';
    }

    const userAgent = req?.headers?.['user-agent'] || 'Unknown Device';
    const detailsJson = details ? JSON.stringify(details) : null;

    await execute(
      `INSERT INTO activity_logs 
       (user_id, username, user_name, role, action, action_type, description, details, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        effectiveUserId,
        effectiveUsername,
        effectiveUserName,
        effectiveRole,
        action,
        action_type,
        description,
        detailsJson,
        rawIp || '127.0.0.1',
        userAgent
      ]
    );
  } catch (err) {
    console.error('[ActivityLogger] Error logging activity:', err.message);
  }
}
