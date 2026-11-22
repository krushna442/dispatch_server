import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { pool, testConnection, closePool, execute } from './config/db.js';
import { initSocket } from './utils/socket.js';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import planRoutes from './routes/planRoutes.js';
import scanRoutes from './routes/scanRoutes.js';
import gatepassRoutes from './routes/gatepassRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import backupRoutes from './routes/backupRoutes.js';
import mailRoutes from './routes/mailRoutes.js';
import { initReportScheduler } from './services/reportScheduler.js';

const app = express();
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://dispatch-server-wcdx.onrender.com',
  'https://rsblko.in',
  'http://rsblko.in',
  'https://www.rsblko.in',
  'http://www.rsblko.in',
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (
      !origin ||
      ALLOWED_ORIGINS.includes(origin) ||
      origin.includes('rsblko.in') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('http://192.168.') ||
      origin.startsWith('http://10.') ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.onrender.com')
    ) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const io = new Server(httpServer, {
  cors: corsOptions
});
initSocket(io);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/gatepass', gatepassRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/mail', mailRoutes);

app.use(express.static(path.join(__dirname, "/dist")));

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "./dist", "index.html"));
});


async function bootstrap() {
  try {
    const isConnected = await testConnection();
    if (!isConnected) {
      console.error('Could not connect to database. Exiting...');
      process.exit(1);
    }

    await execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin','sales','operator') DEFAULT 'operator',
        vendor_code VARCHAR(100),
        customer_name VARCHAR(255),
        receive_despatch_mail BOOLEAN DEFAULT FALSE,
        reset_token VARCHAR(255) DEFAULT NULL,
        reset_token_expiry TIMESTAMP NULL DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Run schema migrations for existing database
    try {
      await execute(`ALTER TABLE users MODIFY COLUMN role ENUM('admin','user','sales','operator') DEFAULT 'operator'`);
      await execute(`UPDATE users SET role = 'operator' WHERE role = 'user'`);
      await execute(`ALTER TABLE users MODIFY COLUMN role ENUM('admin','sales','operator') DEFAULT 'operator'`);
    } catch (err) {
      console.log('Role migration notice:', err.message);
    }

    try {
      await execute(`ALTER TABLE users ADD COLUMN receive_despatch_mail BOOLEAN DEFAULT FALSE`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE users ADD COLUMN reset_token VARCHAR(255) DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE users ADD COLUMN reset_token_expiry TIMESTAMP NULL DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE scan_logs ADD COLUMN status VARCHAR(50) DEFAULT 'success'`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE scan_logs ADD COLUMN remark VARCHAR(255) DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE scan_logs MODIFY COLUMN plan_id INT NULL`);
    } catch (err) {
      // Column modification ignore
    }

    try {
      await execute(`ALTER TABLE scan_logs ADD COLUMN scanned_label TEXT`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE scan_logs ADD COLUMN gate_pass_number VARCHAR(255) DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE scan_logs ADD COLUMN gate_pass_id INT DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE despatch_plans ADD COLUMN customer_name VARCHAR(255) DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`ALTER TABLE despatch_plans ADD COLUMN vendor_code VARCHAR(100) DEFAULT NULL`);
    } catch (err) {
      // Column may already exist
    }

    try {
      await execute(`
        UPDATE despatch_plans dp 
        JOIN users u ON dp.user_id = u.id 
        SET dp.customer_name = u.customer_name, dp.vendor_code = u.vendor_code 
        WHERE (dp.customer_name IS NULL OR dp.customer_name = '') 
          AND (u.customer_name IS NOT NULL AND u.customer_name != '')
      `);
    } catch (err) {
      // Backfill ignore
    }

    try {
      await execute(`
        UPDATE users u 
        JOIN (SELECT user_id, MAX(vendor_code) as vc FROM scan_logs WHERE vendor_code IS NOT NULL AND vendor_code != '' GROUP BY user_id) s 
        ON u.id = s.user_id 
        SET u.vendor_code = s.vc 
        WHERE (u.vendor_code IS NULL OR u.vendor_code = '')
      `);
    } catch (err) {
      // Backfill ignore
    }

    try {
      await execute(`
        UPDATE users u 
        JOIN (SELECT vendor_code, MAX(customer_name) as cn FROM users WHERE customer_name IS NOT NULL AND customer_name != '' GROUP BY vendor_code) ref 
        ON u.vendor_code = ref.vendor_code 
        SET u.customer_name = ref.cn 
        WHERE (u.customer_name IS NULL OR u.customer_name = '')
      `);
    } catch (err) {
      // Backfill ignore
    }

    try {
      await execute(`UPDATE scan_logs SET scanned_label = raw_scan_text WHERE scanned_label IS NULL`);
    } catch (err) {
      // Backfill ignore
    }

    await execute(`
      CREATE TABLE IF NOT EXISTS despatch_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        customer_name VARCHAR(255) DEFAULT NULL,
        vendor_code VARCHAR(100) DEFAULT NULL,
        part_number VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        balance_quantity INT NOT NULL,
        scanned_quantity INT DEFAULT 0,
        status ENUM('pending','completed') DEFAULT 'pending',
        plan_date DATE NOT NULL,
        schedule_date DATE NULL,
        gate_pass_number VARCHAR(255),
        dispatched_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await execute(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        plan_id INT NULL,
        part_number VARCHAR(255) NOT NULL,
        vendor_code VARCHAR(100),
        serial_number VARCHAR(255) NOT NULL,
        scan_date TIMESTAMP NOT NULL,
        scan_month INT NOT NULL,
        scan_year INT NOT NULL,
        rev_no VARCHAR(50),
        format VARCHAR(50),
        raw_scan_text TEXT,
        scanned_label TEXT,
        gate_pass_number VARCHAR(255) DEFAULT NULL,
        gate_pass_id INT DEFAULT NULL,
        unique_key VARCHAR(200) NOT NULL,
        status VARCHAR(50) DEFAULT 'success',
        remark VARCHAR(255) DEFAULT NULL,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (plan_id) REFERENCES despatch_plans(id)
      )
    `);

    await execute(`
      CREATE TABLE IF NOT EXISTS gate_passes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        gate_pass_number VARCHAR(255) NOT NULL,
        plan_date DATE NOT NULL,
        total_parts INT NOT NULL,
        total_quantity INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await execute(`
      CREATE TABLE IF NOT EXISTS despatch_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        gate_pass_id INT NOT NULL,
        plan_id INT NOT NULL,
        part_number VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (gate_pass_id) REFERENCES gate_passes(id),
        FOREIGN KEY (plan_id) REFERENCES despatch_plans(id)
      )
    `);

    await execute(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        username VARCHAR(255) NULL,
        user_name VARCHAR(255) NULL,
        role VARCHAR(50) NULL,
        action VARCHAR(100) NOT NULL,
        action_type ENUM('auth', 'plan', 'scan', 'user', 'gatepass', 'system') NOT NULL DEFAULT 'system',
        description TEXT NOT NULL,
        details JSON NULL,
        ip_address VARCHAR(100) NULL,
        user_agent TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_action_type (action_type),
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at)
      )
    `);

    // Add mail subscription columns to users table
    try { await execute('ALTER TABLE users ADD COLUMN mail_each_scan BOOLEAN DEFAULT FALSE'); } catch (err) {}
    try { await execute('ALTER TABLE users ADD COLUMN mail_plan_add BOOLEAN DEFAULT FALSE'); } catch (err) {}
    try { await execute('ALTER TABLE users ADD COLUMN mail_gate_pass BOOLEAN DEFAULT TRUE'); } catch (err) {}
    try { await execute('ALTER TABLE users ADD COLUMN mail_daily_report BOOLEAN DEFAULT FALSE'); } catch (err) {}
    try { await execute('ALTER TABLE users ADD COLUMN mail_monthly_report BOOLEAN DEFAULT FALSE'); } catch (err) {}
    try { await execute('UPDATE users SET mail_gate_pass = 1 WHERE receive_despatch_mail = 1'); } catch (err) {}

    // Unify all customer names and vendor codes according to official mapping:
    // WHEREVER customer code is 7201012, update customer name to 'ASL PNR MBP'
    try {
      await execute(`
        UPDATE despatch_plans 
        SET customer_name = 'ASL PNR MBP', vendor_code = '7201012' 
        WHERE vendor_code = '7201012' 
           OR customer_name IN ('MBP', 'MBP (7201012)', 'ASL & Switch Mobility', 'ASL & Switch Mobility (7201012)')
           OR customer_name LIKE '%7201012%'
      `);
      await execute(`
        UPDATE users 
        SET customer_name = 'ASL PNR MBP', vendor_code = '7201012' 
        WHERE vendor_code = '7201012' 
           OR customer_name IN ('MBP', 'MBP (7201012)', 'ASL & Switch Mobility', 'ASL & Switch Mobility (7201012)')
           OR customer_name LIKE '%7201012%'
      `);
      await execute("UPDATE despatch_plans SET customer_name = 'ASL ALW MBP', vendor_code = '7205761' WHERE vendor_code = '7205761' OR customer_name LIKE '%7205761%'");
      await execute("UPDATE users SET customer_name = 'ASL ALW MBP', vendor_code = '7205761' WHERE vendor_code = '7205761' OR customer_name LIKE '%7205761%'");
      await execute("UPDATE despatch_plans SET customer_name = 'ASL ALH MBP', vendor_code = '7200868' WHERE vendor_code = '7200868' OR customer_name LIKE '%7200868%'");
      await execute("UPDATE users SET customer_name = 'ASL ALH MBP', vendor_code = '7200868' WHERE vendor_code = '7200868' OR customer_name LIKE '%7200868%'");
      await execute("UPDATE despatch_plans SET customer_name = 'Switch Mobility', vendor_code = '7207001' WHERE (vendor_code = '7207001' OR customer_name LIKE '%7207001%') AND vendor_code != '7201012' AND customer_name NOT LIKE '%7201012%'");
      await execute("UPDATE users SET customer_name = 'Switch Mobility', vendor_code = '7207001' WHERE (vendor_code = '7207001' OR customer_name LIKE '%7207001%') AND vendor_code != '7201012' AND customer_name NOT LIKE '%7201012%'");
      await execute("UPDATE despatch_plans SET customer_name = 'Tata Motors (TML)', vendor_code = 'R64535' WHERE vendor_code = 'R64535' OR customer_name LIKE '%R64535%'");
      await execute("UPDATE users SET customer_name = 'Tata Motors (TML)', vendor_code = 'R64535' WHERE vendor_code = 'R64535' OR customer_name LIKE '%R64535%'");
      await execute("UPDATE despatch_plans SET customer_name = 'IPLT', vendor_code = '10830-6' WHERE vendor_code = '10830-6' OR customer_name LIKE '%10830-6%'");
      await execute("UPDATE users SET customer_name = 'IPLT', vendor_code = '10830-6' WHERE vendor_code = '10830-6' OR customer_name LIKE '%10830-6%'");
      await execute("UPDATE despatch_plans SET customer_name = 'VE Commercial Vehicles (VECV)', vendor_code = 'V113072' WHERE vendor_code IN ('V113072', '113072') OR customer_name LIKE '%V113072%'");
      await execute("UPDATE users SET customer_name = 'VE Commercial Vehicles (VECV)', vendor_code = 'V113072' WHERE vendor_code IN ('V113072', '113072') OR customer_name LIKE '%V113072%'");
    } catch (err) {
      console.log('Customer name unification notice:', err.message);
    }

    // Insert admin if not exists
    await execute(`
      INSERT IGNORE INTO users (name, username, password, role) 
      VALUES ('Admin', 'admin', 'admin123', 'admin')
    `);

    console.log('Database tables bootstrapped successfully');

    const PORT = process.env.PORT || 5555;
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      initReportScheduler();
    });

  } catch (error) {
    console.error('Bootstrap error:', error);
    process.exit(1);
  }
}

bootstrap();

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await closePool();
  process.exit(0);
});
