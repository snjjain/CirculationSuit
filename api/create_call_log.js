'use strict';
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    database: process.env.MYSQL_DB || 'patrika_vitran',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || ''
  });

  await db.query(`
    CREATE TABLE IF NOT EXISTS call_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      r_id VARCHAR(50) NOT NULL,
      unit_code VARCHAR(20),
      called_by VARCHAR(50),
      called_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      outcome VARCHAR(30) NOT NULL,
      notes TEXT,
      follow_up_date DATE,
      INDEX idx_cl_rid (r_id),
      INDEX idx_cl_unit_date (unit_code, called_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('call_log table created (or already exists).');

  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
