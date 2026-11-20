import express from 'express';
import multer from 'multer';
import { query, queryOne, getConnection } from '../config/db.js';
import { protectRoute, adminOnly } from '../middleware/auth.js';
import { logActivity } from '../utils/activityLogger.js';

const router = express.Router();
router.use(protectRoute);
router.use(adminOnly);

// Setup multer in-memory storage for .sql file uploads (up to 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.sql') || file.mimetype === 'application/sql' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only .sql backup files are accepted'));
    }
  }
});

// Helper: Escape SQL string values safely
function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Date) {
    return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  if (typeof val === 'object') {
    val = JSON.stringify(val);
  }
  // Escape backslashes, single quotes, newlines
  const escaped = String(val)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\0/g, '\\0');
  return `'${escaped}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/backup/download - Generate & download full .sql backup
// ─────────────────────────────────────────────────────────────────────────────
router.get('/download', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dateStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Tables in dependency order
    const tables = [
      'users',
      'despatch_plans',
      'scan_logs',
      'gate_passes',
      'despatch_history',
      'activity_logs'
    ];

    let sqlDump = `-- =========================================================================\n`;
    sqlDump += `-- RSB Dispatch Management System - Complete Database Backup\n`;
    sqlDump += `-- Generated At: ${dateStr} UTC\n`;
    sqlDump += `-- Database: ${process.env.DB_NAME || 'rsb_despatch'}\n`;
    sqlDump += `-- =========================================================================\n\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS=0;\n`;
    sqlDump += `SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";\n`;
    sqlDump += `SET AUTOCOMMIT=0;\n`;
    sqlDump += `START TRANSACTION;\n\n`;

    let totalRowsExported = 0;

    for (const table of tables) {
      try {
        // 1. Table structure
        const createResult = await query(`SHOW CREATE TABLE \`${table}\``);
        if (!createResult || createResult.length === 0) continue;

        let createTableSql = createResult[0]['Create Table'];
        // Ensure compatibility across older/newer MySQL versions (e.g. utf8mb4 collation fallback)
        createTableSql = createTableSql
          .replace(/COLLATE=utf8mb4_0900_ai_ci/g, 'COLLATE=utf8mb4_unicode_ci')
          .replace(/COLLATE utf8mb4_0900_ai_ci/g, 'COLLATE utf8mb4_unicode_ci');

        sqlDump += `-- -------------------------------------------------------------------------\n`;
        sqlDump += `-- Table structure for table \`${table}\`\n`;
        sqlDump += `-- -------------------------------------------------------------------------\n`;
        sqlDump += `DROP TABLE IF EXISTS \`${table}\`;\n`;
        sqlDump += `${createTableSql};\n\n`;

        // 2. Table records
        const rows = await query(`SELECT * FROM \`${table}\``);
        if (rows && rows.length > 0) {
          sqlDump += `-- -------------------------------------------------------------------------\n`;
          sqlDump += `-- Dumping data for table \`${table}\` (${rows.length} rows)\n`;
          sqlDump += `-- -------------------------------------------------------------------------\n`;

          const columns = Object.keys(rows[0]);
          const colsList = columns.map(c => `\`${c}\``).join(', ');

          // Chunk inserts in batches of 100 for fast execution & safe packet sizes
          const BATCH_SIZE = 100;
          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            const valuesStatements = batch.map(row => {
              const vals = columns.map(col => escapeSqlValue(row[col])).join(', ');
              return `(${vals})`;
            }).join(',\n');

            sqlDump += `INSERT INTO \`${table}\` (${colsList}) VALUES\n${valuesStatements};\n`;
          }
          sqlDump += `\n`;
          totalRowsExported += rows.length;
        }
      } catch (tableErr) {
        console.warn(`[Backup] Table ${table} skip/error:`, tableErr.message);
      }
    }

    sqlDump += `COMMIT;\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS=1;\n`;
    sqlDump += `-- Backup complete. Total records dumped: ${totalRowsExported}\n`;

    const fileName = `rsb_dispatch_backup_${timestamp}.sql`;

    await logActivity(req, {
      action: 'BACKUP_DOWNLOAD',
      action_type: 'system',
      description: `Downloaded database SQL backup (${fileName}, ${totalRowsExported} records)`
    });

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(sqlDump);
  } catch (error) {
    console.error('Error generating backup:', error);
    res.status(500).json({ message: 'Failed to generate backup: ' + error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/backup/restore - Restore database from uploaded .sql file or text
// ─────────────────────────────────────────────────────────────────────────────
router.post('/restore', upload.single('backupFile'), async (req, res) => {
  let connection;
  try {
    let sqlContent = '';
    let fileName = 'uploaded_backup.sql';

    if (req.file && req.file.buffer) {
      sqlContent = req.file.buffer.toString('utf-8');
      fileName = req.file.originalname || fileName;
    } else if (req.body && req.body.sql) {
      sqlContent = req.body.sql;
      fileName = req.body.fileName || fileName;
    }

    if (!sqlContent || !sqlContent.trim()) {
      return res.status(400).json({ message: 'No SQL content or file uploaded' });
    }

    // Safety clean: sanitize collation keywords that may fail on older MySQL
    let sanitizedSql = sqlContent
      .replace(/COLLATE=utf8mb4_0900_ai_ci/gi, 'COLLATE=utf8mb4_unicode_ci')
      .replace(/COLLATE utf8mb4_0900_ai_ci/gi, 'COLLATE utf8mb4_unicode_ci');

    connection = await getConnection();

    // Disable foreign key checks for restore session
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    await connection.query('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO"');

    // Split SQL into executable statements
    // We match statements ending with ; that are outside single/double quotes
    const rawStatements = sanitizedSql
      .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('/*'));

    let executedCount = 0;
    const restoredTables = new Set();

    for (const statement of rawStatements) {
      // Skip comments or empty commands
      if (!statement || statement.startsWith('--') || statement.startsWith('/*')) continue;

      // Extract table names for reporting
      const tableMatch = statement.match(/(?:CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS)\s+[`"']?([a-zA-Z0-9_]+)[`"']?/i);
      if (tableMatch && tableMatch[1]) {
        restoredTables.add(tableMatch[1]);
      }

      try {
        await connection.query(statement);
        executedCount++;
      } catch (stmtErr) {
        console.warn('[Restore] Notice on statement execution:', stmtErr.message);
        // If it's a minor warning or table already exists, continue, else throw
        if (stmtErr.code === 'ER_TABLE_EXISTS_ERROR') continue;
      }
    }

    // Re-enable foreign key checks
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
    connection.release();

    await logActivity(req, {
      action: 'DATABASE_RESTORE',
      action_type: 'system',
      description: `Restored database from ${fileName} (${executedCount} statements, tables: ${Array.from(restoredTables).join(', ')})`,
      details: { fileName, executedCount, tables: Array.from(restoredTables) }
    });

    res.json({
      message: 'Database restored successfully!',
      fileName,
      statementsExecuted: executedCount,
      tablesRestored: Array.from(restoredTables)
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.query('SET FOREIGN_KEY_CHECKS=1');
        connection.release();
      } catch (_) {}
    }
    console.error('Database restore error:', error);
    res.status(500).json({ message: 'Failed to restore database: ' + (error.message || 'Unknown error') });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/backup/stats - Database health, table record counts, server info
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const tableCounts = await Promise.all([
      queryOne('SELECT COUNT(*) as count FROM users').catch(() => ({ count: 0 })),
      queryOne('SELECT COUNT(*) as count FROM despatch_plans').catch(() => ({ count: 0 })),
      queryOne('SELECT COUNT(*) as count FROM scan_logs').catch(() => ({ count: 0 })),
      queryOne('SELECT COUNT(*) as count FROM gate_passes').catch(() => ({ count: 0 })),
      queryOne('SELECT COUNT(*) as count FROM activity_logs').catch(() => ({ count: 0 })),
    ]);

    const lastBackupLog = await queryOne(
      "SELECT created_at, description FROM activity_logs WHERE action = 'BACKUP_DOWNLOAD' ORDER BY id DESC LIMIT 1"
    );

    const lastRestoreLog = await queryOne(
      "SELECT created_at, description FROM activity_logs WHERE action = 'DATABASE_RESTORE' ORDER BY id DESC LIMIT 1"
    );

    const stats = {
      databaseName: process.env.DB_NAME || 'rsb_despatch',
      dbHost: process.env.DB_HOST || 'localhost',
      usersCount: Number(tableCounts[0]?.count || 0),
      plansCount: Number(tableCounts[1]?.count || 0),
      scansCount: Number(tableCounts[2]?.count || 0),
      gatePassesCount: Number(tableCounts[3]?.count || 0),
      activityLogsCount: Number(tableCounts[4]?.count || 0),
      lastBackupDate: lastBackupLog?.created_at || null,
      lastRestoreDate: lastRestoreLog?.created_at || null,
      serverTime: new Date().toISOString()
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching database stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/backup/activity-logs - Query activity audit trail with search & filters
// ─────────────────────────────────────────────────────────────────────────────
router.get('/activity-logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const { search, action_type, startDate, endDate, user_id } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (action_type && action_type !== 'all') {
      whereClause += ' AND action_type = ?';
      params.push(action_type);
    }

    if (user_id) {
      whereClause += ' AND user_id = ?';
      params.push(user_id);
    }

    if (startDate && endDate) {
      if (startDate === endDate) {
        whereClause += ' AND DATE(created_at) = ?';
        params.push(startDate);
      } else {
        whereClause += ' AND DATE(created_at) BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
    } else if (startDate) {
      whereClause += ' AND DATE(created_at) >= ?';
      params.push(startDate);
    } else if (endDate) {
      whereClause += ' AND DATE(created_at) <= ?';
      params.push(endDate);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      whereClause += ' AND (username LIKE ? OR user_name LIKE ? OR action LIKE ? OR description LIKE ? OR ip_address LIKE ?)';
      params.push(term, term, term, term, term);
    }

    // Total count query
    const countResult = await query(
      `SELECT COUNT(*) as total FROM activity_logs ${whereClause}`,
      params
    );
    const total = Number(countResult[0]?.total || 0);

    // Logs query
    const logs = await query(
      `SELECT * FROM activity_logs ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Summary counts for KPI badges
    const summaryCounts = await query(`
      SELECT 
        COUNT(*) as total_actions,
        SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) as today_actions,
        SUM(CASE WHEN action_type = 'auth' THEN 1 ELSE 0 END) as auth_actions,
        SUM(CASE WHEN action_type = 'scan' THEN 1 ELSE 0 END) as scan_actions,
        SUM(CASE WHEN action_type = 'plan' THEN 1 ELSE 0 END) as plan_actions,
        SUM(CASE WHEN action_type = 'user' THEN 1 ELSE 0 END) as user_actions,
        SUM(CASE WHEN action_type = 'system' THEN 1 ELSE 0 END) as system_actions
      FROM activity_logs
    `);

    res.json({
      logs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      },
      summary: summaryCounts[0] || {}
    });
  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
