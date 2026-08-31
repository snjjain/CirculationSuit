'use strict';
/**
 * oracle_outstanding_sync.js — Sync agency outstanding from Oracle → MySQL
 *
 * Uses sqlplus VARIABLE/PRINT (not DBMS_OUTPUT) to call the REF CURSOR procedure.
 * This avoids TERMOUT/buffer hang issues and matches how the explore script works.
 *
 * Usage:
 *   node api/oracle_outstanding_sync.js              # CURRENT only
 *   node api/oracle_outstanding_sync.js --monthly    # CURRENT + monthly snapshots
 *   node api/oracle_outstanding_sync.js --label 2026-06 --from 01-JAN-2026 --to 30-JUN-2026
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const SEP = '\x1c'; // CHR(28) — field separator, embedded literally in the .sql script

const MYSQL_CFG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/outstanding_sync.log');

function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function hasFlag(n) { return process.argv.includes(n); }
function getArg(n)  { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; }

function oraDate(d) {
  const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${String(d.getDate()).padStart(2,'0')}-${MON[d.getMonth()]}-${d.getFullYear()}`;
}

function monthEnd(yyyy, mm) { return new Date(yyyy, mm, 0); }

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

// DD/MM/YYYY → YYYY-MM-DD  (dates returned inside cursor rows)
function oraToSql(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : null;
}

// DD-MON-YYYY → YYYY-MM-DD  (Oracle-format date strings used as period bounds)
const MON_MAP = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
                  JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
function oraLabelToSql(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i);
  return m ? `${m[3]}-${MON_MAP[m[2].toUpperCase()] || '01'}-${m[1]}` : null;
}

function str(v) { if (v == null) return null; const s = String(v).trim(); return s || null; }

// ── Build the sqlplus script using VARIABLE/PRINT (no DBMS_OUTPUT) ────────────
function buildScript(fromDate, toDate, spoolFile) {
  // CHR(28) embedded literally as the column separator
  return `WHENEVER SQLERROR EXIT SQL.SQLCODE
SET PAGESIZE 0
SET HEADING OFF
SET FEEDBACK OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMOUT ON
SET TRIMSPOOL ON
SET LINESIZE 32767
SET COLSEP "${SEP}"
SET WRAP OFF
VARIABLE A REFCURSOR
EXEC cir_agency_outstanding_rep_new(UPPER('RP001'),'','',UPPER('NM'),'','','','2','','${fromDate}','${toDate}','dd/mm/yyyy','Y',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,:A);
SPOOL "${spoolFile}"
PRINT :A
SPOOL OFF
EXIT
`;
}

// ── Run sqlplus, pass CONNECT via stdin ───────────────────────────────────────
const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  // node-oracledb driver (server, no sqlplus binary) — else spawn sqlplus
  if (_ora.driverAvailable()) return _ora.runViaDriver(sqlFile);
  return _runSqlplusSpawn(sqlFile);
}
function _runSqlplusSpawn(sqlFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      const combined = (out + err).slice(0, 1000);
      // ORA-28002 = password expiry warning — non-fatal
      const m = combined.match(/ORA-(?!28002)\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*|TNS-\d{5}[^\r\n]*/);
      if (code !== 0 || m) reject(new Error(`sqlplus exit ${code}${m ? ': ' + m[0] : ''}\n${combined}`));
      else resolve();
    });
    const conn = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    proc.stdin.write(`CONNECT ${conn}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Parse spool: split on CHR(28), trim whitespace from each field ────────────
function parseSpool(spoolFile) {
  const content = fs.readFileSync(spoolFile, { encoding: 'utf8' });
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes(SEP)) continue;
    const fields = line.split(SEP).map(f => f.trim());
    // Must have exactly 36 fields (the cursor has 36 columns)
    if (fields.length >= 36) rows.push(fields.slice(0, 36));
  }
  return rows;
}

// ── Map 36 Oracle fields → 38 MySQL params ───────────────────────────────────
function rowToParams(f, periodLabel, periodFrom, periodTo) {
  return [
    periodLabel,
    oraLabelToSql(periodFrom),
    oraLabelToSql(periodTo),
    str(f[0]),   // comp_code
    str(f[1]),   // unit_code
    str(f[3]),   // rep_type_name
    str(f[4]),   // ag_code
    str(f[5]),   // dp_code
    str(f[12]),  // ag_name
    str(f[13]),  // ag_name_hi
    str(f[14]),  // city_code
    str(f[15]),  // city_name
    num(f[6]),   // op_amt
    num(f[7]),   // bill_amt
    num(f[8]),   // other_db
    num(f[9]),   // rec_amt
    num(f[10]),  // other_cr
    num(f[11]),  // cl_amt
    str(f[18]),  // ag_status
    str(f[19]),  // unit_name
    str(f[20]),  // mobno
    num(f[16]) != null ? Math.round(num(f[16])) : null,  // total_copies
    num(f[21]) != null ? Math.round(num(f[21])) : null,  // day_copies
    num(f[17]),  // security_bal
    num(f[22]),  // req_security
    num(f[23]),  // sec_diff
    str(f[24]),  // ag_type
    oraToSql(f[25]),  // supply_start
    num(f[26]) != null ? Math.round(num(f[26])) : null,  // supply_days
    str(f[27]),  // exec_code
    str(f[28]),  // exec_name
    oraToSql(f[29]),  // last_supply_date
    num(f[30]) != null ? Math.round(num(f[30])) : null,  // last_supply_copies
    str(f[31]),  // is_correspondent
    num(f[32]),  // net_receipt
    str(f[33]),  // zh_name
    str(f[34]),  // group_unit_name
    str(f[35]),  // block_status
  ];
}

// ── Ensure table exists ───────────────────────────────────────────────────────
async function ensureTable(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS agency_outstanding (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
    period_label       VARCHAR(20)   NOT NULL,
    period_from        DATE,
    period_to          DATE,
    comp_code          VARCHAR(10),
    unit_code          VARCHAR(10),
    rep_type_name      VARCHAR(300),
    ag_code            VARCHAR(30)   NOT NULL,
    dp_code            VARCHAR(30),
    ag_name            VARCHAR(600),
    ag_name_hi         VARCHAR(600),
    city_code          VARCHAR(30),
    city_name          VARCHAR(600),
    op_amt             DECIMAL(15,2) DEFAULT 0,
    bill_amt           DECIMAL(15,2) DEFAULT 0,
    other_db           DECIMAL(15,2) DEFAULT 0,
    rec_amt            DECIMAL(15,2) DEFAULT 0,
    other_cr           DECIMAL(15,2) DEFAULT 0,
    cl_amt             DECIMAL(15,2) DEFAULT 0,
    ag_status          VARCHAR(50),
    unit_name          VARCHAR(300),
    mobno              VARCHAR(30),
    total_copies       INT           DEFAULT 0,
    day_copies         INT           DEFAULT 0,
    security_bal       DECIMAL(15,2) DEFAULT 0,
    req_security       DECIMAL(15,2) DEFAULT 0,
    sec_diff           DECIMAL(15,2) DEFAULT 0,
    ag_type            VARCHAR(100),
    supply_start       DATE,
    supply_days        INT           DEFAULT 0,
    exec_code          VARCHAR(30),
    exec_name          VARCHAR(300),
    last_supply_date   DATE,
    last_supply_copies INT           DEFAULT 0,
    is_correspondent   VARCHAR(20),
    net_receipt        DECIMAL(15,2) DEFAULT 0,
    zh_name            VARCHAR(300),
    group_unit_name    VARCHAR(300),
    block_status       VARCHAR(10),
    synced_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_period_ag (period_label, unit_code, ag_code),
    INDEX idx_unit      (unit_code),
    INDEX idx_ag_status (ag_status),
    INDEX idx_cl_amt    (cl_amt),
    INDEX idx_period    (period_label)
  ) CHARACTER SET utf8mb4`);
}

// ── Sync one period ───────────────────────────────────────────────────────────
async function syncPeriod(conn, periodLabel, periodFrom, periodTo) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'ou_sync_'));
  const sqlFile  = path.join(tmpDir, 'out.sql');
  // Use forward slashes for the spool path (sqlplus handles both on Windows)
  const spoolFile = path.join(tmpDir, 'out.txt');
  const spoolPath = spoolFile.replace(/\\/g, '/');

  log(`[${periodLabel}] Oracle query: ${periodFrom} → ${periodTo} ...`);
  const t0 = Date.now();

  fs.writeFileSync(sqlFile, buildScript(periodFrom, periodTo, spoolPath), 'utf8');
  const rc = await runSqlplus(sqlFile);

  // A timeout SIGKILLs sqlplus and resolves -1, leaving a PARTIALLY written spool.
  // Parsing it would delete the whole period snapshot and re-insert only the rows that
  // made it — silent data loss. Abort and keep the snapshot MySQL already holds.
  if (typeof rc === 'number' && rc !== 0) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    throw new Error(`sqlplus exit ${rc}${rc === -1 ? ' (timed out and was killed)' : ''} ` +
      `for ${periodLabel} — MySQL left untouched`);
  }

  const rows = parseSpool(spoolFile);
  log(`[${periodLabel}] Oracle returned ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}

  if (!rows.length) return 0;

  await conn.execute('DELETE FROM agency_outstanding WHERE period_label = ?', [periodLabel]);

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch  = rows.slice(i, i + BATCH);
    const params = batch.map(f => rowToParams(f, periodLabel, periodFrom, periodTo));
    const ph     = params.map(() =>
      '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).join(',');
    await conn.execute(
      `INSERT INTO agency_outstanding (
         period_label,period_from,period_to,comp_code,unit_code,rep_type_name,
         ag_code,dp_code,ag_name,ag_name_hi,city_code,city_name,
         op_amt,bill_amt,other_db,rec_amt,other_cr,cl_amt,
         ag_status,unit_name,mobno,total_copies,day_copies,
         security_bal,req_security,sec_diff,ag_type,
         supply_start,supply_days,exec_code,exec_name,
         last_supply_date,last_supply_copies,is_correspondent,
         net_receipt,zh_name,group_unit_name,block_status
       ) VALUES ${ph}`,
      params.flat()
    );
    inserted += batch.length;
  }

  log(`[${periodLabel}] Inserted ${inserted} rows`);
  return inserted;
}

// ── Exported function (used by server.js scheduler + API) ────────────────────
async function runSync(opts = {}) {
  const emit     = opts.onLog || (() => {});
  const localLog = m => { log(m); emit(m); };

  localLog('=== Agency Outstanding sync started ===');

  const conn = await mysql.createConnection(MYSQL_CFG);
  try {
    await ensureTable(conn);

    const today       = new Date();
    const PERIOD_FROM = '01-JAN-2026';
    const periods     = [{ label: 'CURRENT', from: PERIOD_FROM, to: oraDate(today) }];

    if (opts.monthly) {
      const sy = 2026, sm = 1;
      const cy = today.getFullYear(), cm = today.getMonth() + 1;
      for (let y = sy, m = sm; y < cy || (y === cy && m < cm); ) {
        periods.push({ label: `${y}-${String(m).padStart(2,'0')}`, from: PERIOD_FROM, to: oraDate(monthEnd(y, m)) });
        m++; if (m > 12) { m = 1; y++; }
      }
    }

    if (opts.label && opts.from && opts.to) {
      periods.length = 0;
      periods.push({ label: opts.label, from: opts.from, to: opts.to });
    }

    localLog(`Periods to sync: ${periods.map(p => p.label).join(', ')}`);

    let totalRows = 0;
    const results = [];
    for (const p of periods) {
      const r = await syncPeriod(conn, p.label, p.from, p.to);
      results.push({ label: p.label, rows: r });
      totalRows += r;
    }

    localLog(`=== Agency Outstanding sync complete — ${totalRows} total rows ===`);
    return { periods: results, totalRows };
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { runSync };

// ── CLI entry-point ───────────────────────────────────────────────────────────
if (require.main === module) {
  runSync({
    monthly: hasFlag('--monthly'),
    label:   getArg('--label'),
    from:    getArg('--from'),
    to:      getArg('--to'),
  }).catch(e => { log('FATAL: ' + e.message); process.exit(1); });
}
