import express from 'express';
import jwt from 'jsonwebtoken';
import { queryOne, execute } from '../config/db.js';
import { protectRoute } from '../middleware/auth.js';
import { sendMail } from '../utils/mailer.js';

const router = express.Router();

function maskEmail(email) {
  if (!email) return '';
  const parts = email.split('@');
  if (parts.length !== 2) return email;
  const [local, domain] = parts;
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  const maskedLocal = local.slice(0, 2) + '*'.repeat(Math.max(local.length - 3, 3)) + local.slice(-1);
  return `${maskedLocal}@${domain}`;
}

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

// Request 6-digit OTP code to reset password
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ message: 'Please provide your username or registered email address.' });
    }

    const cleanIdentifier = identifier.trim();
    const user = await queryOne(
      'SELECT id, name, username, email, is_active FROM users WHERE (username = ? OR email = ?) LIMIT 1',
      [cleanIdentifier, cleanIdentifier]
    );

    if (!user) {
      return res.status(404).json({ message: 'No account found matching the provided username or email.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'This user account is currently deactivated. Please contact an administrator.' });
    }

    if (!user.email || !user.email.trim()) {
      return res.status(400).json({
        message: 'No registered email found for this user account. Please contact an administrator to reset your password.'
      });
    }

    // Generate random 6-digit verification code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP with 15-minute expiration
    await execute(
      'UPDATE users SET reset_token = ?, reset_token_expiry = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?',
      [otp, user.id]
    );

    // RSB Branded Email Template
    const emailHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: linear-gradient(135deg, #0d9488 0%, #059669 100%); padding: 24px 28px; color: #ffffff;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.5px;">RSB TRANSMISSIONS (I) LTD.</h1>
          <p style="margin: 6px 0 0 0; font-size: 13px; opacity: 0.95; letter-spacing: 0.2px;">Dispatch Management System &bull; Password Reset Request</p>
        </div>
        
        <div style="padding: 28px 32px;">
          <p style="font-size: 15px; color: #1e293b; margin: 0 0 16px 0;">
            Dear <strong>${user.name || user.username}</strong>,
          </p>
          <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0 0 20px 0;">
            We received a request to reset the password for your RSB Dispatch account (<strong>@${user.username}</strong>). Please use the 6-digit verification code below to proceed:
          </p>

          <div style="text-align: center; margin: 28px 0; padding: 24px; background-color: #f0fdfa; border: 2px dashed #0d9488; border-radius: 10px;">
            <p style="margin: 0 0 8px 0; font-size: 12px; color: #0f766e; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;">
              Verification Code (OTP)
            </p>
            <div style="font-family: 'Courier New', Courier, monospace; font-size: 40px; font-weight: 800; color: #0f766e; letter-spacing: 10px; margin: 8px 0;">
              ${otp}
            </div>
            <p style="margin: 8px 0 0 0; font-size: 12px; color: #64748b; font-weight: 500;">
              ⏱️ Valid for 15 minutes only
            </p>
          </div>

          <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 14px 16px; margin: 24px 0;">
            <p style="margin: 0; color: #92400e; font-size: 12px; line-height: 1.6;">
              <strong>Security Notice:</strong> If you did not request a password reset, please ignore this email or notify your system administrator immediately. RSB will never ask you to share this code.
            </p>
          </div>

          <p style="color: #94a3b8; font-size: 12px; margin: 28px 0 0 0; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 16px;">
            RSB Group &bull; Automotive Components & Transmissions &bull; Automated Notification
          </p>
        </div>
      </div>
    `;

    try {
      await sendMail({
        to: user.email,
        subject: `Password Reset Code: ${otp} - RSB Dispatch`,
        html: emailHtml
      });
    } catch (mailErr) {
      console.error('Failed to send reset code email:', mailErr);
      return res.status(500).json({
        message: 'Failed to send verification email. Please check SMTP settings or try again later.'
      });
    }

    res.json({
      success: true,
      message: 'A 6-digit verification code has been sent to your registered email address.',
      maskedEmail: maskEmail(user.email),
      username: user.username
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Internal server error while processing password reset request.' });
  }
});

// Verify 6-digit OTP code
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { username, code } = req.body;
    if (!username || !code) {
      return res.status(400).json({ message: 'Username and verification code are required.' });
    }

    const cleanUsername = username.trim();
    const cleanCode = code.toString().trim();

    const user = await queryOne(
      'SELECT id, username, reset_token, reset_token_expiry FROM users WHERE username = ? LIMIT 1',
      [cleanUsername]
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.reset_token || user.reset_token !== cleanCode) {
      return res.status(400).json({ message: 'Invalid verification code. Please check and try again.' });
    }

    if (!user.reset_token_expiry || new Date(user.reset_token_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'Verification code has expired. Please request a new code.' });
    }

    res.json({
      valid: true,
      message: 'Verification code confirmed successfully.'
    });
  } catch (error) {
    console.error('Verify reset code error:', error);
    res.status(500).json({ message: 'Internal server error while verifying code.' });
  }
});

// Update password with verified code
router.post('/reset-password', async (req, res) => {
  try {
    const { username, code, newPassword } = req.body;
    if (!username || !code || !newPassword) {
      return res.status(400).json({ message: 'Username, verification code, and new password are required.' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 4) {
      return res.status(400).json({ message: 'New password must be at least 4 characters long.' });
    }

    const cleanUsername = username.trim();
    const cleanCode = code.toString().trim();

    const user = await queryOne(
      'SELECT id, username, reset_token, reset_token_expiry FROM users WHERE username = ? LIMIT 1',
      [cleanUsername]
    );

    if (!user) {
      return res.status(404).json({ message: 'User account not found.' });
    }

    if (!user.reset_token || user.reset_token !== cleanCode) {
      return res.status(400).json({ message: 'Invalid verification code.' });
    }

    if (!user.reset_token_expiry || new Date(user.reset_token_expiry).getTime() < Date.now()) {
      return res.status(400).json({ message: 'Verification code has expired. Please request a new code.' });
    }

    // Update password and clear reset token
    await execute(
      'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [newPassword, user.id]
    );

    res.json({
      success: true,
      message: 'Your password has been successfully reset. You can now sign in with your new password.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Internal server error while resetting password.' });
  }
});

export default router;
