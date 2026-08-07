'use strict';

/**
 * seed_admin.js — bootstrap (or reset) the first ADMIN (L1) login for Patrika Vitran Suite.
 *
 * Usage:
 *   node api/seed_admin.js                                  # generic ADMIN, mobile 9999999999
 *   node api/seed_admin.js --mobile 9812345678 --password "MyPass@1"
 *   node api/seed_admin.js --name "IT Admin" --person-code ADMIN --level 1
 *
 * Idempotent: upserts by mobile. After first login the admin can create real users and
 * promote any account to L1 from the Admin → User Management screen.
 */

const path   = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const arg  = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const MOBILE      = String(arg('mobile', '9999999999')).replace(/\D/g, '');
const NAME        = arg('name', 'Administrator');
const PERSON_CODE = arg('person-code', 'ADMIN');
const LEVEL       = parseInt(arg('level', '1'), 10);
const USER_TYPE   = arg('user-type', 'admin');
const PASSWORD    = arg('password', 'Admin@123');
const FORCE_CHANGE = !args.includes('--no-force-change'); // force password change on first login

const DB = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'patrika_vitran',
};

(async () => {
  const c = await mysql.createConnection(DB);
  try {
    // Ensure table exists (matches auth.js schema) so seeding works before the server has run.
    await c.query(`CREATE TABLE IF NOT EXISTS app_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      person_code VARCHAR(20) DEFAULT NULL,
      name VARCHAR(200) NOT NULL,
      mobile VARCHAR(15) NOT NULL,
      password_hash VARCHAR(100) DEFAULT NULL,
      email VARCHAR(150) DEFAULT NULL,
      hierarchy_level INT DEFAULT NULL,
      user_type VARCHAR(30) DEFAULT 'circulation',
      is_active TINYINT(1) DEFAULT 1,
      must_change_password TINYINT(1) DEFAULT 1,
      failed_attempts INT DEFAULT 0,
      locked_until DATETIME DEFAULT NULL,
      last_login_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mobile (mobile),
      UNIQUE KEY uq_person (person_code),
      INDEX idx_active (is_active)
    ) CHARACTER SET utf8mb4`);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await c.query(
      `INSERT INTO app_users (person_code, name, mobile, hierarchy_level, user_type, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), hierarchy_level=VALUES(hierarchy_level), user_type=VALUES(user_type),
         password_hash=VALUES(password_hash), is_active=1, must_change_password=VALUES(must_change_password),
         failed_attempts=0, locked_until=NULL`,
      [PERSON_CODE, NAME, MOBILE, LEVEL, USER_TYPE, hash, FORCE_CHANGE ? 1 : 0]
    );

    const [[row]] = await c.query('SELECT id, person_code, name, mobile, hierarchy_level, user_type, is_active, must_change_password FROM app_users WHERE mobile=?', [MOBILE]);
    console.log('✅ Admin account ready:');
    console.log(JSON.stringify(row, null, 2));
    console.log(`\n   Login mobile : ${MOBILE}`);
    console.log(`   Password     : ${PASSWORD}${FORCE_CHANGE ? '  (must be changed on first login)' : ''}`);
  } catch (e) {
    console.error('❌ seed failed:', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
