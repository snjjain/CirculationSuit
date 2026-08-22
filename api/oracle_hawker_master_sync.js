'use strict';

/**
 * oracle_hawker_master_sync.js — Oracle CRM_HAWKER_MASTER → MySQL hawker_master
 *
 * Full sync daily: TRUNCATE + INSERT all active hawkers.
 * The table is moderate in size (typically < 50k rows) so a full reload
 * is faster and simpler than tracking incremental changes without a
 * reliable UPDATED_DT filter.
 *
 * Usage:
 *   node api/oracle_hawker_master_sync.js          # full sync
 *   node api/oracle_hawker_master_sync.js --dry-run # count rows, no write
 *
 * Source query based on:
 *   SELECT H.FIELD_OFFICER, CIR_GET_EXECUTIVE(H.COMPCODE, H.FIELD_OFFICER),
 *          H.LOC_ID, CIR_GET_UNITNAME(H.LOC_ID),
 *          H.CENTER_INCHARGE, CIR_GET_EXECUTIVE(H.COMPCODE, H.CENTER_INCHARGE),
 *          H.CENT_ID, (SELECT CENT_NAME FROM CRM_CENTER_MASTER ...),
 *          H.CATAGORY, H.*
 *   FROM CRM_HAWKER_MASTER H
 *
 * Security: Oracle credentials passed via sqlplus stdin ONLY — never on
 * command line or written to any persistent file.
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_hawker_master_sync.log');
const SEP   = '\x1c';   // ASCII 28 — field separator, never appears in data
const D     = 'CHR(28)';
const NCOLS = 13;       // must match cols array in buildSqlScript (13 fields, 12 separators)

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── Field sanitiser (matches S() in other sync scripts) ──────────────────────
// Strips field separator + newlines; null-safe via NVL(TO_CHAR(...)).
const S = f =>
  `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

// ── Oracle SQL ────────────────────────────────────────────────────────────────
// 12 fields, each on its own line (sqlplus line limit = 2499 chars).
// Field order MUST match lineToParams() below.
function buildSqlScript(spoolFile) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');

  const cols = [
    S('H.COMPCODE'),                                                          //  0 compcode
    S('H.LOC_ID'),                                                            //  1 unit_code
    S('CIR_GET_UNITNAME(H.LOC_ID)'),                                          //  2 unit_name
    S('H.CENT_ID'),                                                           //  3 hawker_center_code
    S('(SELECT CENT_NAME FROM CRM_CENTER_MASTER WHERE CENT_ID=H.CENT_ID AND LOC_ID=H.LOC_ID)'), //  4 hawker_center_name
    S('H.HAWKER_ID'),                                                         //  5 hawker_id
    S('H.HAWKER_NAME'),                                                       //  6 hawker_name
    S('H.MOBILE'),                                                            //  7 mobile_no
    S('H.FIELD_OFFICER'),                                                     //  8 field_officer_code
    S('CIR_GET_EXECUTIVE(H.COMPCODE,H.FIELD_OFFICER)'),                       //  9 field_officer_name
    S('H.CENTER_INCHARGE'),                                                   // 10 center_incharge_code
    S('CIR_GET_EXECUTIVE(H.COMPCODE,H.CENTER_INCHARGE)'),                     // 11 center_incharge_name
    S('H.CATAGORY'),                                                          // 12 catagory (note: Oracle spelling)
  ].join(`\n  || ${D} ||\n  `);

  return `SET PAGESIZE 0
SET LINESIZE 32767
SET LONG 100000
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SET TRIMOUT ON
SET TERMOUT OFF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolEsc}
SELECT ${cols}
FROM CRM_HAWKER_MASTER H
ORDER BY H.LOC_ID, H.HAWKER_ID;
SPOOL OFF
EXIT
`;
}

// ── sqlplus runner (same dual-driver pattern as all other sync scripts) ───────
const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  if (_ora.driverAvailable()) return _ora.runViaDriver(sqlFile);
  return _runSqlplusSpawn(sqlFile);
}
function _runSqlplusSpawn(sqlFile) {
  return new Promise((resolve, reject) => {
    const connectStr =
      `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
      `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`sqlplus exited ${code}\n${stdout}\n${stderr}`));
    });
    proc.stdin.write(`CONNECT ${connectStr}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Field mapping (index matches cols array above) ────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}

function lineToParams(f) {
  return [
    str(f[0]),   // compcode
    str(f[1]),   // unit_code
    str(f[2]),   // unit_name
    str(f[3]),   // hawker_center_code
    str(f[4]),   // hawker_center_name
    str(f[5]),   // hawker_id
    str(f[6]),   // hawker_name
    str(f[7]),   // mobile_no
    str(f[8]),   // field_officer_code
    str(f[9]),   // field_officer_name
    str(f[10]),  // center_incharge_code
    str(f[11]),  // center_incharge_name
    str(f[12]),  // catagory
  ];
}

const COL_LIST = `compcode, unit_code, unit_name,
     hawker_center_code, hawker_center_name,
     hawker_id, hawker_name, mobile_no,
     field_officer_code, field_officer_name,
     center_incharge_code, center_incharge_name,
     catagory`;

// ── Schema setup ──────────────────────────────────────────────────────────────
async function ensureSchema(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS hawker_master (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    compcode             VARCHAR(10),
    unit_code            VARCHAR(20),
    unit_name            VARCHAR(200),
    hawker_center_code   VARCHAR(20),
    hawker_center_name   VARCHAR(200),
    hawker_id            VARCHAR(30)   NOT NULL,
    hawker_name          VARCHAR(300),
    mobile_no            VARCHAR(20),
    field_officer_code   VARCHAR(20),
    field_officer_name   VARCHAR(200),
    center_incharge_code VARCHAR(20),
    center_incharge_name VARCHAR(200),
    catagory             VARCHAR(30),
    synced_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_hm_hawker (hawker_id),
    INDEX idx_hm_unit    (unit_code),
    INDEX idx_hm_center  (hawker_center_code),
    INDEX idx_hm_fo      (field_officer_code),
    INDEX idx_hm_ci      (center_incharge_code)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

// ── Parse spool output ────────────────────────────────────────────────────────
function parseSpoolFile(spoolFile) {
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(SEP);
    if (f.length !== NCOLS) continue;
    rows.push(f);
  }
  return rows;
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync() {
  log(`=== Hawker Master Sync START${DRY_RUN ? ' (DRY RUN)' : ''} ===`);

  // ── Oracle extract ──────────────────────────────────────────────────────────
  const tmpDir   = os.tmpdir();
  const sqlFile  = path.join(tmpDir, `hawker_master_${Date.now()}.sql`);
  const spoolFile= path.join(tmpDir, `hawker_master_${Date.now()}.spool`);

  fs.writeFileSync(sqlFile, buildSqlScript(spoolFile), 'utf8');
  log('Running Oracle query…');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile);
  log(`Oracle returned ${rows.length} rows`);

  try { fs.unlinkSync(sqlFile); } catch (_) {}
  try { fs.unlinkSync(spoolFile); } catch (_) {}

  if (DRY_RUN) {
    log('Dry run — no DB writes. Done.');
    return { rows: rows.length };
  }

  // ── MySQL load ──────────────────────────────────────────────────────────────
  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    await conn.execute("SET time_zone = '+05:30'");
    await ensureSchema(conn);

    await conn.execute('START TRANSACTION');
    await conn.execute('TRUNCATE TABLE hawker_master');

    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const ph    = chunk.map(() => `(${',?'.repeat(13).slice(1)})`).join(',');
      const vals  = chunk.flatMap(f => lineToParams(f));
      await conn.execute(
        `INSERT INTO hawker_master (${COL_LIST}) VALUES ${ph}`, vals);
      inserted += chunk.length;
    }

    await conn.execute('COMMIT');
    log(`Inserted ${inserted} rows into hawker_master`);
    return { rows: inserted };
  } catch (e) {
    try { await conn.execute('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    await conn.end();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────
if (require.main === module) {
  sync()
    .then(r => { log(`=== Done: ${r.rows} rows ===`); process.exit(0); })
    .catch(e => { log(`ERROR: ${e.message}`); process.exit(1); });
}

module.exports = { sync };
