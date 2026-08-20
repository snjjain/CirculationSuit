'use strict';

/**
 * oracle_emp_mobile_sync.js — seed/refresh app_users from hierarchy_master,
 * pulling each person's login mobile from Oracle HR (hr_emp_mst.MOBILE by EMP_CODE).
 *
 *   node api/oracle_emp_mobile_sync.js --dry-run     # query Oracle, print mapping, write nothing
 *   node api/oracle_emp_mobile_sync.js               # upsert app_users (default temp pwd, must-change)
 *   node api/oracle_emp_mobile_sync.js --default-password "Patrika@123"
 *   node api/oracle_emp_mobile_sync.js --no-password  # create without a password (admin sets later)
 *
 * - Creates one app_users row per ACTIVE hierarchy_master person (idempotent, keyed on person_code).
 * - Fills mobile where Oracle has one; leaves it NULL otherwise (admin can set it in User Management).
 * - New users get a default temp password with must_change_password=1 unless --no-password.
 * - Never overwrites an existing password or an already-set mobile.
 *
 * Security: Oracle credentials passed via sqlplus stdin only (same pattern as supply_sync.js).
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_PASSWORD = args.includes('--no-password');
const DEFAULT_PASSWORD = (() => { const i = args.indexOf('--default-password'); return i >= 0 && args[i + 1] ? args[i + 1] : 'Patrika@123'; })();
const EMP_TABLE = (() => { const i = args.indexOf('--table'); return i >= 0 && args[i + 1] ? args[i + 1] : 'hr_emp_mst'; })();

const SQLPLUS = process.env.SQLPLUS_PATH || 'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';
const SEP = '\x1c';
const D = 'CHR(28)';

const MYSQL = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB || 'patrika_vitran',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

function log(m) { console.log(`[emp-mobile-sync] ${m}`); }

const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  // node-oracledb driver (server, no sqlplus binary) — else spawn sqlplus
  if (_ora.driverAvailable()) return _ora.runViaDriver(sqlFile);
  return _runSqlplusSpawn(sqlFile);
}
function _runSqlplusSpawn(sqlFile) {
  return new Promise((resolve, reject) => {
    const connectStr = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], { env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`sqlplus exited ${code}\n${stdout}\n${stderr}`)));
    proc.stdin.write(`CONNECT ${connectStr}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

/** Query Oracle HR for MOBILE by a list of EMP_CODEs. Returns Map(empCode -> mobile). */
async function fetchMobiles(empCodes) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-emp-'));
  const sqlFile = path.join(tmpDir, 'q.sql');
  const spoolFile = path.join(tmpDir, 'data.txt');
  // Chunk the IN-list (Oracle limit 1000) — we have ~90 so one chunk is fine
  const inList = empCodes.map(c => `'${String(c).replace(/'/g, "''")}'`).join(',');
  const sql = `SET PAGESIZE 0
SET LINESIZE 400
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SET TERMOUT OFF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile.replace(/\\/g, '/')}
SELECT emp_code || ${D} || NVL(TO_CHAR(mobile),'')
FROM ${EMP_TABLE}
WHERE emp_code IN (${inList});
SPOOL OFF
EXIT
`;
  fs.writeFileSync(sqlFile, sql, 'utf8');
  await runSqlplus(sqlFile);
  const map = new Map();
  if (fs.existsSync(spoolFile)) {
    for (const line of fs.readFileSync(spoolFile, 'utf8').split(/\r?\n/)) {
      if (!line.includes(SEP)) continue;
      const [emp, mob] = line.split(SEP);
      const digits = String(mob || '').replace(/\D/g, '');
      const mobile = digits.length >= 10 ? digits.slice(-10) : null; // keep last 10 digits
      if (emp && mobile) map.set(emp.trim(), mobile);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return map;
}

(async () => {
  for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
    if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exit(1); }
  }
  if ((!_ora.driverAvailable() && !fs.existsSync(SQLPLUS))) { log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exit(1); }

  const c = await mysql.createConnection(MYSQL);
  try {
    // Make mobile nullable so people without an Oracle mobile can still be listed (admin fills later).
    try { await c.query(`ALTER TABLE app_users MODIFY mobile VARCHAR(15) NULL`); } catch (_) {}

    const [people] = await c.query(
      `SELECT person_code, person_name, employee_code, hierarchy_level
       FROM hierarchy_master WHERE is_active = 1 ORDER BY hierarchy_level, person_name`);
    log(`${people.length} active hierarchy_master people`);

    const empCodes = [...new Set(people.map(p => p.employee_code).filter(e => e && e !== '0'))];
    log(`Querying Oracle ${EMP_TABLE} for ${empCodes.length} employee codes...`);
    let mobileMap = new Map();
    try {
      mobileMap = await fetchMobiles(empCodes);
      log(`Oracle returned ${mobileMap.size} mobile numbers`);
    } catch (e) {
      log(`ERROR querying Oracle: ${e.message}`);
      log(`Check the table name (--table) / column (MOBILE, EMP_CODE) / that Oracle is reachable.`);
      process.exit(2);
    }

    const defHash = (!NO_PASSWORD && !DRY_RUN) ? await bcrypt.hash(DEFAULT_PASSWORD, 10) : null;
    let created = 0, updated = 0, withMobile = 0, noMobile = 0, errors = 0;

    for (const p of people) {
      const mobile = mobileMap.get(String(p.employee_code)) || null;
      if (mobile) withMobile++; else noMobile++;
      const userType = p.hierarchy_level === 9 ? 'agent' : 'circulation';

      if (DRY_RUN) continue;
      try {
        const [r] = await c.query(
          `INSERT INTO app_users (person_code, name, mobile, hierarchy_level, user_type, password_hash, is_active, must_change_password)
           VALUES (?,?,?,?,?,?,1,?)
           ON DUPLICATE KEY UPDATE
             name=VALUES(name), hierarchy_level=VALUES(hierarchy_level), user_type=VALUES(user_type),
             mobile=COALESCE(app_users.mobile, VALUES(mobile)),
             password_hash=COALESCE(app_users.password_hash, VALUES(password_hash))`,
          [p.person_code, p.person_name, mobile, p.hierarchy_level, userType, defHash, defHash ? 1 : 0]
        );
        if (r.affectedRows === 1) created++; else if (r.affectedRows === 2) updated++;
      } catch (e) {
        errors++;
        log(`  skip ${p.person_code} ${p.person_name}: ${e.code || e.message}`);
      }
    }

    if (DRY_RUN) {
      log(`DRY RUN — would seed ${people.length} users; ${withMobile} with mobile, ${noMobile} without.`);
      const sample = people.slice(0, 8).map(p => `${p.person_code} ${p.person_name} L${p.hierarchy_level} → ${mobileMap.get(String(p.employee_code)) || '(no mobile)'}`);
      log('Sample:\n  ' + sample.join('\n  '));
    } else {
      log(`Done. created=${created} updated=${updated} | with mobile=${withMobile} without=${noMobile} errors=${errors}`);
      if (!NO_PASSWORD) log(`New users' initial password: "${DEFAULT_PASSWORD}" (must be changed on first login). Users without a mobile cannot log in until an admin sets one.`);
    }
  } catch (e) {
    log('FATAL: ' + e.message); process.exit(1);
  } finally {
    await c.end();
  }
})();
