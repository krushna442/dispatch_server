import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { pool, testConnection, closePool, execute } from './config/db.js';
import { initSocket } from './utils/socket.js';

import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import planRoutes from './routes/planRoutes.js';
import scanRoutes from './routes/scanRoutes.js';
import gatepassRoutes from './routes/gatepassRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';

const app = express();
app.set('trust proxy', 1);
const httpServer = http.createServer(app);

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://dispatch-server-wcdx.onrender.com',
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (
      !origin ||
      ALLOWED_ORIGINS.includes(origin) ||
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
      callback(new Error('Not allowed by CORS'));
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

    await execute(`
      CREATE TABLE IF NOT EXISTS despatch_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
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
        plan_id INT NOT NULL,
        part_number VARCHAR(255) NOT NULL,
        vendor_code VARCHAR(100),
        serial_number VARCHAR(255) NOT NULL,
        scan_date TIMESTAMP NOT NULL,
        scan_month INT NOT NULL,
        scan_year INT NOT NULL,
        rev_no VARCHAR(50),
        format VARCHAR(50),
        raw_scan_text TEXT,
        unique_key VARCHAR(200) UNIQUE NOT NULL,
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

    // Insert admin if not exists
    await execute(`
      INSERT IGNORE INTO users (name, username, password, role) 
      VALUES ('Admin', 'admin', 'admin123', 'admin')
    `);

    console.log('Database tables bootstrapped successfully');

    const PORT = process.env.PORT || 5555;
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
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
