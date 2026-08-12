'use strict';

/**
 * oracle_exec_hierarchy_sync.js — Syncs 4 Oracle circulation executive/hierarchy
 * tables into MySQL (full daily replace — tables are small, no update timestamps).
 *
 * Tables synced:
 *   CIR_EXECUTIVE_MAST        → exec_master           (~1047 rows)
 *   CIR_PLI_HIERARCHY_MAPPING → exec_hierarchy_mapping (~1047 rows)
 *   CIR_PLI_HIERARCHY_MAST    → exec_hierarchy_mast   (~381 rows)
 *   CIR_PLI_HIERARCHY         → exec_hierarchy_level   (~7 rows)
 *
 * After sync, exec_performance.js can filter by exec_master.is_active_pli = 'Y'
 * and join exec_hierarchy_mapping to get the full reporting chain per executive.
 *
 * Usage:
 *   node api/oracle_exec_hierarchy_sync.js
 *
 * Schedule: daily — after agency_master_sync (Windows Task Scheduler / cron)
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_exec_hierarchy_sync.log');

const SEP = '\x1c';    // ASCII-28 — field separator, never appears in data
const D   = 'CHR(28)'; // Oracle expression for the same char

function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

const str = v => { if (v == null) return null; const r = String(v).trim(); return r || null; };

// Wrap Oracle column: handle NULL, strip SEP/CR/LF
const S = col =>
  `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${col}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

// Build a complete sqlplus script: SPOOL to file, SELECT, EXIT
function buildScript(spoolFile, selectSql) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');
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
${selectSql}
SPOOL OFF
EXIT
`;
}

// Write SQL file, run sqlplus, return stdout+stderr
function runSqlplus(sqlFile) {
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

// Parse spool file: only lines containing SEP, split into fields
function parseSpoolFile(spoolFile, expectedCols) {
  const raw = fs.readFileSync(spoolFile, 'utf8');
  const parsed = [], malformed = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes(SEP)) continue;
    const f = line.split(SEP);
    if (f.length === expectedCols) parsed.push(f);
    else malformed.push(line);
  }
  if (malformed.length) log(`  WARNING: ${malformed.length} malformed lines skipped`);
  return parsed;
}

// ── Ensure MySQL tables exist ─────────────────────────────────────────────────
async function ensureTables(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS exec_master (
      executive_code    VARCHAR(8)    NOT NULL,
      comp_code         VARCHAR(8),
      executive_desc    VARCHAR(100),
      exec_designation  VARCHAR(50),
      unit_code         VARCHAR(8),
      area_code         VARCHAR(8),
      city_code         VARCHAR(8),
      dist_code         VARCHAR(8),
      hr_code           VARCHAR(10),
      employee_id       VARCHAR(30),
      mobile_no         VARCHAR(20),
      email_id          VARCHAR(100),
      freeze_flag       VARCHAR(1),
      is_active_pli     VARCHAR(1),
      synced_at         DATETIME,
      PRIMARY KEY (executive_code),
      INDEX idx_em_active (is_active_pli),
      INDEX idx_em_unit   (unit_code)
    ) CHARACTER SET utf8mb4`);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS exec_hierarchy_mapping (
      unit_code              VARCHAR(50)   NOT NULL,
      exec_code              VARCHAR(50)   NOT NULL,
      comp_code              VARCHAR(10),
      exec_desc              VARCHAR(200),
      exec_desig             VARCHAR(50),
      edtn_incharge          VARCHAR(50),
      edtn_incharge_name     VARCHAR(200),
      circ_incharge          VARCHAR(50),
      circ_incharge_name     VARCHAR(200),
      zonal_head             VARCHAR(50),
      zonal_head_name        VARCHAR(200),
      vp_circulation         VARCHAR(50),
      vp_circulation_name    VARCHAR(200),
      synced_at              DATETIME,
      PRIMARY KEY (unit_code, exec_code),
      INDEX idx_ehm_exec  (exec_code),
      INDEX idx_ehm_zonal (zonal_head),
      INDEX idx_ehm_circ  (circ_incharge)
    ) CHARACTER SET utf8mb4`);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS exec_hierarchy_mast (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      unit_code         VARCHAR(30),
      code              VARCHAR(30),
      comp_code         VARCHAR(20),
      name              VARCHAR(100),
      hierarchy_code    VARCHAR(30),
      hierarchy_level   TINYINT,
      employee_id       VARCHAR(50),
      reporting_to      VARCHAR(50),
      is_active_pli     VARCHAR(1),
      synced_at         DATETIME,
      UNIQUE KEY uq_ehm (unit_code, code),
      INDEX idx_ehma_active (is_active_pli)
    ) CHARACTER SET utf8mb4`);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS exec_hierarchy_level (
      comp_code         VARCHAR(20)   NOT NULL,
      code              VARCHAR(20)   NOT NULL,
      name              VARCHAR(50),
      hierarchy_level   TINYINT,
      sf_name           VARCHAR(100),
      sf_level          VARCHAR(50),
      synced_at         DATETIME,
      PRIMARY KEY (comp_code, code)
    ) CHARACTER SET utf8mb4`);

  log('Tables verified / created');
}

// ── Generic full-replace loader ───────────────────────────────────────────────
async function fullReplace(conn, tableName, rows, insertSql, mapRow) {
  await conn.execute(`TRUNCATE TABLE ${tableName}`);
  let count = 0;
  for (let i = 0; i < rows.length; i += 200) {
    for (const row of rows.slice(i, i + 200)) {
      await conn.execute(insertSql, mapRow(row));
      count++;
    }
  }
  log(`  ${tableName}: ${count} rows loaded`);
  return count;
}

// ── Sync CIR_EXECUTIVE_MAST (14 fields) ──────────────────────────────────────
// COMP_CODE|EXECUTIVE_CODE|EXECUTIVE_DESC|EXEC_DESIGNATION|UNIT_CODE|AREA_CODE|
// CITY_CODE|DIST_CODE|HR_CODE|EMPLOYEE_ID|MOBILE_NO|EMAIL_ID|FREEZE_FLAG|ISACTIVEFORPLI
async function syncExecMaster(conn, tmpDir) {
  const spoolFile = path.join(tmpDir, 'exec_master.txt');
  const sqlFile   = path.join(tmpDir, 'exec_master.sql');

  const selectSql = `SELECT
  ${S('COMP_CODE')}         ||${D}||
  ${S('EXECUTIVE_CODE')}    ||${D}||
  ${S('EXECUTIVE_DESC')}    ||${D}||
  ${S('EXEC_DESIGNATION')}  ||${D}||
  ${S('UNIT_CODE')}         ||${D}||
  ${S('AREA_CODE')}         ||${D}||
  ${S('CITY_CODE')}         ||${D}||
  ${S('DIST_CODE')}         ||${D}||
  ${S('HR_CODE')}           ||${D}||
  ${S('EMPLOYEE_ID')}       ||${D}||
  ${S('MOBILE_NO')}         ||${D}||
  ${S('EMAIL_ID')}          ||${D}||
  ${S('FREEZE_FLAG')}       ||${D}||
  ${S('ISACTIVEFORPLI')}
FROM CIR_EXECUTIVE_MAST
ORDER BY EXECUTIVE_CODE;`;

  fs.writeFileSync(sqlFile, buildScript(spoolFile, selectSql), 'utf8');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile, 14).filter(r => str(r[1]));
  return fullReplace(conn, 'exec_master',
    rows,
    `INSERT INTO exec_master
       (comp_code, executive_code, executive_desc, exec_designation,
        unit_code, area_code, city_code, dist_code,
        hr_code, employee_id, mobile_no, email_id,
        freeze_flag, is_active_pli, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    r => [str(r[0]),str(r[1]),str(r[2]),str(r[3]),str(r[4]),str(r[5]),str(r[6]),str(r[7]),
          str(r[8]),str(r[9]),str(r[10]),str(r[11]),str(r[12]),str(r[13])==='Y'?'Y':'N']
  );
}

// ── Sync CIR_PLI_HIERARCHY_MAPPING (13 fields) ───────────────────────────────
// COMP_CODE|UNIT_CODE|EXEC_CODE|EXEC_DESC|EXEC_DESIG|
// EDTN_INCHARGE|EDTN_INCHARGE_NAME|CIRC_INCHARGE|CIRC_INCHARGE_NAME|
// ZONAL_HEAD|ZONAL_HEAD_NAME|VP_CIRCULATION|VP_CIRCULATION_NAME
async function syncHierarchyMapping(conn, tmpDir) {
  const spoolFile = path.join(tmpDir, 'exec_mapping.txt');
  const sqlFile   = path.join(tmpDir, 'exec_mapping.sql');

  const selectSql = `SELECT
  ${S('COMP_CODE')}              ||${D}||
  ${S('UNIT_CODE')}              ||${D}||
  ${S('EXEC_CODE')}              ||${D}||
  ${S('EXEC_DESC')}              ||${D}||
  ${S('EXEC_DESIG')}             ||${D}||
  ${S('EDTN_INCHARGE')}          ||${D}||
  ${S('EDTN_INCHARGE_NAME')}     ||${D}||
  ${S('CIRC_INCHARGE')}          ||${D}||
  ${S('CIRC_INCHARGE_NAME')}     ||${D}||
  ${S('ZONAL_HEAD')}             ||${D}||
  ${S('ZONAL_HEAD_NAME')}        ||${D}||
  ${S('VP_CIRCULATION')}         ||${D}||
  ${S('VP_CIRCULATION_NAME')}
FROM CIR_PLI_HIERARCHY_MAPPING
ORDER BY UNIT_CODE, EXEC_CODE;`;

  fs.writeFileSync(sqlFile, buildScript(spoolFile, selectSql), 'utf8');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile, 13).filter(r => str(r[2]));
  return fullReplace(conn, 'exec_hierarchy_mapping',
    rows,
    `INSERT INTO exec_hierarchy_mapping
       (comp_code, unit_code, exec_code, exec_desc, exec_desig,
        edtn_incharge, edtn_incharge_name,
        circ_incharge, circ_incharge_name,
        zonal_head, zonal_head_name,
        vp_circulation, vp_circulation_name, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    r => [str(r[0]),str(r[1]),str(r[2]),str(r[3]),str(r[4]),
          str(r[5]),str(r[6]),str(r[7]),str(r[8]),str(r[9]),str(r[10]),str(r[11]),str(r[12])]
  );
}

// ── Sync CIR_PLI_HIERARCHY_MAST (9 fields) ────────────────────────────────────
// COMP_CODE|UNIT_CODE|CODE|NAME|HIERARCHY_CODE|HIERARCHY_LEVEL|EMPLOYEE_ID|REPORTING_TO|ISACTIVEFORPLI
async function syncHierarchyMast(conn, tmpDir) {
  const spoolFile = path.join(tmpDir, 'exec_hmast.txt');
  const sqlFile   = path.join(tmpDir, 'exec_hmast.sql');

  const selectSql = `SELECT
  ${S('COMP_CODE')}              ||${D}||
  ${S('UNIT_CODE')}              ||${D}||
  ${S('CODE')}                   ||${D}||
  ${S('NAME')}                   ||${D}||
  ${S('HIERARCHY_CODE')}         ||${D}||
  NVL(TO_CHAR(HIERARCHY_LEVEL),'') ||${D}||
  ${S('EMPLOYEE_ID')}            ||${D}||
  ${S('REPORTING_TO')}           ||${D}||
  ${S('ISACTIVEFORPLI')}
FROM CIR_PLI_HIERARCHY_MAST
ORDER BY UNIT_CODE, CODE;`;

  fs.writeFileSync(sqlFile, buildScript(spoolFile, selectSql), 'utf8');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile, 9).filter(r => str(r[2])); // CODE must exist
  return fullReplace(conn, 'exec_hierarchy_mast',
    rows,
    `INSERT IGNORE INTO exec_hierarchy_mast
       (comp_code, unit_code, code, name, hierarchy_code,
        hierarchy_level, employee_id, reporting_to, is_active_pli, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
    r => [str(r[0]),str(r[1]),str(r[2]),str(r[3]),str(r[4]),
          r[5]?parseInt(r[5],10):null, str(r[6]),str(r[7]),str(r[8])==='Y'?'Y':'N']
  );
}

// ── Sync CIR_PLI_HIERARCHY (6 fields) ────────────────────────────────────────
// COMP_CODE|CODE|NAME|HIERARCHY_LEVEL|SF_NAME|SF_LEVEL
async function syncHierarchyLevel(conn, tmpDir) {
  const spoolFile = path.join(tmpDir, 'exec_hlevel.txt');
  const sqlFile   = path.join(tmpDir, 'exec_hlevel.sql');

  const selectSql = `SELECT
  ${S('COMP_CODE')}                  ||${D}||
  ${S('CODE')}                       ||${D}||
  ${S('NAME')}                       ||${D}||
  NVL(TO_CHAR(HIERARCHY_LEVEL),'')   ||${D}||
  ${S('SF_NAME')}                    ||${D}||
  ${S('SF_LEVEL')}
FROM CIR_PLI_HIERARCHY
ORDER BY HIERARCHY_LEVEL;`;

  fs.writeFileSync(sqlFile, buildScript(spoolFile, selectSql), 'utf8');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile, 6).filter(r => str(r[1]));
  return fullReplace(conn, 'exec_hierarchy_level',
    rows,
    `INSERT INTO exec_hierarchy_level
       (comp_code, code, name, hierarchy_level, sf_name, sf_level, synced_at)
     VALUES (?,?,?,?,?,?,NOW())`,
    r => [str(r[0]),str(r[1]),str(r[2]),r[3]?parseInt(r[3],10):null,str(r[4]),str(r[5])]
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== oracle_exec_hierarchy_sync start ===');

  for (const k of ['ORA_HOST','ORA_SERVICE','ORA_USER','ORA_PASSWORD']) {
    if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exit(1); }
  }
  if (!fs.existsSync(SQLPLUS)) {
    log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exit(1);
  }

  const conn   = await mysql.createConnection(MYSQL_CONFIG);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-exec-hier-'));

  try {
    await ensureTables(conn);

    log('Syncing CIR_EXECUTIVE_MAST...');
    await syncExecMaster(conn, tmpDir);

    log('Syncing CIR_PLI_HIERARCHY_MAPPING...');
    await syncHierarchyMapping(conn, tmpDir);

    log('Syncing CIR_PLI_HIERARCHY_MAST...');
    await syncHierarchyMast(conn, tmpDir);

    log('Syncing CIR_PLI_HIERARCHY...');
    await syncHierarchyLevel(conn, tmpDir);

    log('=== sync complete ===');
  } catch (e) {
    log(`ERROR: ${e.message}`);
    process.exit(1);
  } finally {
    await conn.end();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
