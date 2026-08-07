'use strict';

/**
 * seed_admin.js — bootstrap (or reset) the ADMIN (L1) login for Patrika Vitran Suite.
 *
 * The admin signs in with a User ID (default "admin"), not a mobile number.
 *
 * Usage:
 *   node api/seed_admin.js                                   # User ID "admin" / Admin@123
 *   node api/seed_admin.js --username admin --password "MyPass@1"
 *   node api/seed_admin.js --username admin --mobile 9812345678   # also allow a mobile
 *
 * Idempotent (keyed on person_code = ADMIN). After first login the admin can create real
 * users and promote any account to L1 from Admin → User Management.
 */

const path   = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const arg  = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const USERNAME    = arg('username', 'admin');
const MOBILE      = String(arg('mobile', '')).replace(/\D/g, '') || null;
const NAME        = arg('name', 'Administrator');
const PERSON_CODE = arg('person-code', 'ADMIN');
const LEVEL       = parseInt(arg('level', '1'), 10);
const USER_TYPE   = arg('user-type', 'admin');
const PASSWORD    = arg('password', 'Admin@123');
const FORCE_CHANGE = !args.includes('--no-force-change');

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
    await c.query(`CREATE TABLE IF NOT EXISTS app_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      person_code VARCHAR(20) DEFAULT NULL,
      name VARCHAR(200) NOT NULL,
      username VARCHAR(50) DEFAULT NULL,
      mobile VARCHAR(15) DEFAULT NULL,
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
      UNIQUE KEY uq_username (username),
      UNIQUE KEY uq_person (person_code),
      INDEX idx_active (is_active)
    ) CHARACTER SET utf8mb4`);
    // Migrations for older installs
    try { await c.query(`ALTER TABLE app_users ADD COLUMN username VARCHAR(50) DEFAULT NULL AFTER name`); } catch (_) {}
    try { await c.query(`ALTER TABLE app_users ADD UNIQUE KEY uq_username (username)`); } catch (_) {}
    try { await c.query(`ALTER TABLE app_users MODIFY mobile VARCHAR(15) DEFAULT NULL`); } catch (_) {}

    const hash = await bcrypt.hash(PASSWORD, 10);
    await c.query(
      `INSERT INTO app_users (person_code, name, username, mobile, hierarchy_level, user_type, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), username=VALUES(username), mobile=VALUES(mobile),
         hierarchy_level=VALUES(hierarchy_level), user_type=VALUES(user_type),
         password_hash=VALUES(password_hash), is_active=1,
         must_change_password=VALUES(must_change_password), failed_attempts=0, locked_until=NULL`,
      [PERSON_CODE, NAME, USERNAME, MOBILE, LEVEL, USER_TYPE, hash, FORCE_CHANGE ? 1 : 0]
    );

    const [[row]] = await c.query('SELECT id, person_code, name, username, mobile, hierarchy_level, user_type, is_active, must_change_password FROM app_users WHERE person_code=?', [PERSON_CODE]);
    console.log('✅ Admin account ready:');
    console.log(JSON.stringify(row, null, 2));
    console.log(`\n   Login User ID : ${USERNAME}${MOBILE ? ` (or mobile ${MOBILE})` : ''}`);
    console.log(`   Password      : ${PASSWORD}${FORCE_CHANGE ? '  (must be changed on first login)' : ''}`);
  } catch (e) {
    console.error('❌ seed failed:', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
