import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rsb_despatch',

  ssl: {
    rejectUnauthorized: false
  },

  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: '+00:00'
});

export async function query(sql, params) {
  const [results] = await pool.query(sql, params);
  return results;
}

export async function queryOne(sql, params) {
  const [results] = await pool.query(sql, params);
  return results[0] || null;
}

export async function execute(sql, params) {
  const [result] = await pool.execute(sql, params);
  return result;
}

export async function getConnection() {
  return await pool.getConnection();
}

export async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('Database connection successful');
    connection.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export async function closePool() {
  await pool.end();
}

export { pool };
