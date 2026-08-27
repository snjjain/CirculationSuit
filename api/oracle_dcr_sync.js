'use strict';
/**
 * oracle_dcr_sync.js — Sync DCR data from Oracle → MySQL
 *
 * Tables synced:
 *   employee_attendance  → dcr_center_attendance  (center visits by FO/center incharge)
 *   cir_tour_callplan    → dcr_agency_visit        (agency visits by executives/ZHs)
 *
 * Executive names from Oracle arrive as "NAME ~ EMP_CODE"; split on sync.
 * Remarks may be Hindi or English — tables use utf8mb4.
 *
 * Usage:
 *   node api/oracle_dcr_sync.js                          # last 2 days
 *   node api/oracle_dcr_sync.js --backfill               # 2 years back → today (newest-first)
 *   node api/oracle_dcr_sync.js --from 2026-07-01 --to 2026-07-31
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const SEP = '\x1c'; // CHR(28) field separator

const MYSQL_CFG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  charset:  'utf8mb4',
  multipleStatements: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
};

// ── helpers ──────────────────────────────────────────────────────────────────

const SQLPLUS_TIMEOUT_MS = 25 * 60 * 1000; // 25 min per query — kills hung Oracle calls

const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  // node-oracledb driver (server, no sqlplus binary) — else spawn sqlplus
  if (_ora.driverAvailable()) return _ora.runViaDriver(sqlFile);
  return _runSqlplusSpawn(sqlFile);
}
function _runSqlplusSpawn(sqlFile) {
  return new Promise((resolve, reject) => {
    const connectStr = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}` +
      `@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.write(`CONNECT ${connectStr}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve(-1); // treat timeout as empty result — caller checks for spool file
    }, SQLPLUS_TIMEOUT_MS);

    proc.on('close', code => { clearTimeout(timer); resolve(code); });
    proc.on('error', err  => { clearTimeout(timer); reject(err); });
  });
}

function parseExecutive(raw) {
  if (!raw || !raw.trim()) return { executive_name: null, emp_code: null };
  const tilde = raw.indexOf('~');
  if (tilde < 0) return { executive_name: raw.trim() || null, emp_code: null };
  return {
    executive_name: raw.slice(0, tilde).trim() || null,
    emp_code:       raw.slice(tilde + 1).trim() || null,
  };
}

const n  = v => (v && v.trim()) ? v.trim() : null;        // varchar → null if empty
const dt = v => (v && v.trim()) ? v.trim() : null;         // date/datetime strings
const nm = v => { const x = parseFloat(v); return isNaN(x) ? null : x; }; // number

// ── CREATE TABLES ─────────────────────────────────────────────────────────────

async function ensureTables(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS dcr_center_attendance (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      executive_name VARCHAR(200),
      emp_code       VARCHAR(50),
      center_name    VARCHAR(500),
      unit_name      VARCHAR(200),
      comp_code      VARCHAR(8),
      unit_code      VARCHAR(8),
      branch_code    VARCHAR(8),
      attn_date      DATE,
      user_id        VARCHAR(20),
      user_name      VARCHAR(200),
      created_by     VARCHAR(20),
      created_dt     DATETIME,
      latitude       VARCHAR(20),
      longitude      VARCHAR(20),
      location_id    VARCHAR(20),
      center_closed  DATETIME,
      present_rmrk   TEXT,
      closed_rmrk    TEXT,
      attn_type      VARCHAR(1),
      location_type  VARCHAR(1),
      event_id       BIGINT,
      visit_location TEXT,
      location_name  TEXT,
      synced_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_attn_date (attn_date),
      INDEX idx_unit_date (unit_code, attn_date),
      INDEX idx_emp (emp_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS dcr_agency_visit (
      id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
      executive_name      VARCHAR(200),
      emp_code            VARCHAR(50),
      center_name         TEXT,
      unit_name           VARCHAR(200),
      comp_code           VARCHAR(8),
      unit_code           VARCHAR(8),
      bran_code           VARCHAR(8),
      call_id             VARCHAR(10),
      call_date           DATE,
      tour_id             VARCHAR(10),
      visit_id            BIGINT,
      visit_date          DATE,
      visit_type          VARCHAR(10),
      dist                VARCHAR(10),
      station             VARCHAR(10),
      visit_to_main_code  VARCHAR(10),
      visit_to_sub_code   VARCHAR(10),
      from_time           VARCHAR(10),
      till_time           VARCHAR(10),
      visit_purpose       VARCHAR(200),
      visit_remarks       TEXT,
      call_type           VARCHAR(20),
      contect_person      VARCHAR(100),
      contact_email       VARCHAR(100),
      contact_mob_no      VARCHAR(15),
      call_status         VARCHAR(20),
      created_by          VARCHAR(30),
      created_dt          DATETIME,
      emp_id              VARCHAR(8),
      latitude            VARCHAR(20),
      longitude           VARCHAR(20),
      no_of_days_hold     INT,
      hold_remarks        VARCHAR(200),
      next_visit_date     DATE,
      flag_cir_advt       VARCHAR(10),
      mark_attn_date      DATE,
      followup_amount     DECIMAL(15,2),
      followup_date       DATE,
      corres_type         VARCHAR(20),
      selfie_file         VARCHAR(500),
      lat_long_addr       TEXT,
      synced_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_mark_date (mark_attn_date),
      INDEX idx_unit_date (unit_code, mark_attn_date),
      INDEX idx_emp (emp_code),
      INDEX idx_call (call_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ── CENTER ATTENDANCE SYNC ────────────────────────────────────────────────────
// 22 CHR(28)-separated fields per row (see column order below)

const ATTN_COLS = 22;

function buildAttendanceSql(from, to, spoolFile) {
  const T = v => `REPLACE(REPLACE(${v},CHR(28),' '),CHR(10),' ')`;
  return [
    'SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET FEEDBACK OFF',
    'SET TRIMSPOOL ON', 'SET WRAP OFF', 'SET HEADING OFF',
    `SPOOL "${spoolFile}"`,
    // col 0  executive_name_raw (split later into name + emp_code)
    // col 1  center_name
    // col 2  unit_name
    // col 3  comp_code  … col 21 location_name
    `SELECT`,
    `  NVL(app_tour_login_name(d.comp_code,d.unit_code,NULL,d.created_by,'dd/mm/yyyy','N',NULL,NULL,NULL,NULL,NULL),'')||CHR(28)||`,
    `  NVL(NVL(CIR_GET_CENTERNAME(d.unit_code,d.LOCATION_ID,d.comp_code),CIR_GET_UNITNAME(d.unit_code)),'')||CHR(28)||`,
    `  NVL(CIR_GET_UNITNAME(d.unit_code),'')||CHR(28)||`,
    `  NVL(d.comp_code,'')||CHR(28)||`,
    `  NVL(d.unit_code,'')||CHR(28)||`,
    `  NVL(d.branch_code,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.attn_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.user_id,'')||CHR(28)||`,
    `  NVL(${T('d.user_name')},'')||CHR(28)||`,
    `  NVL(d.created_by,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.created_dt,'YYYY-MM-DD HH24:MI:SS'),'')||CHR(28)||`,
    `  NVL(d.latitude,'')||CHR(28)||`,
    `  NVL(d.longitude,'')||CHR(28)||`,
    `  NVL(d.location_id,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.center_closed,'YYYY-MM-DD HH24:MI:SS'),'')||CHR(28)||`,
    `  NVL(${T('d.present_rmrk')},'')||CHR(28)||`,
    `  NVL(${T('d.closed_rmrk')},'')||CHR(28)||`,
    `  NVL(d.attn_type,'')||CHR(28)||`,
    `  NVL(d.location_type,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.event_id),'')||CHR(28)||`,
    `  NVL(${T('SUBSTR(d.visit_location,1,500)')},'')||CHR(28)||`,
    `  NVL(${T('SUBSTR(d.location_name,1,500)')},'')||CHR(28)||`,
    // trailing CHR(28) sentinel so split count is reliable
    `  CHR(28)`,
    `FROM employee_attendance d`,
    `WHERE d.attn_date BETWEEN TO_DATE('${from}','YYYY-MM-DD') AND TO_DATE('${to}','YYYY-MM-DD')`,
    `ORDER BY d.attn_date, d.unit_code;`,
    'SPOOL OFF', 'EXIT',
  ].join('\n');
}

async function syncAttendance(conn, from, to, onLog) {
  const spoolFile = path.join(os.tmpdir(), `dcr_attn_spool_${process.pid}.txt`);
  const sqlFile   = path.join(os.tmpdir(), `dcr_attn_${process.pid}.sql`);
  fs.writeFileSync(sqlFile, buildAttendanceSql(from, to, spoolFile));
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

  onLog(`  [attendance] Oracle ${from}→${to}…`);
  await runSqlplus(sqlFile);

  if (!fs.existsSync(spoolFile)) {
    onLog(`  [attendance] WARNING: no spool file, skipping`);
    return 0;
  }
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const rows = raw.split('\n').filter(l => l.includes(SEP));
  onLog(`  [attendance] ${rows.length} rows from Oracle`);

  const [del] = await conn.execute(
    `DELETE FROM dcr_center_attendance WHERE attn_date BETWEEN ? AND ?`, [from, to]);
  onLog(`  [attendance] deleted ${del.affectedRows} old rows`);

  let inserted = 0;
  const BATCH = 150;
  const COLS = `(executive_name,emp_code,center_name,unit_name,comp_code,unit_code,branch_code,` +
    `attn_date,user_id,user_name,created_by,created_dt,latitude,longitude,location_id,` +
    `center_closed,present_rmrk,closed_rmrk,attn_type,location_type,event_id,` +
    `visit_location,location_name,synced_at)`;
  const PH = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())'; // 23 ? + NOW()

  for (let i = 0; i < rows.length; i += BATCH) {
    const vals = [], params = [];
    for (const row of rows.slice(i, i + BATCH)) {
      const f = row.split(SEP);
      if (f.length < ATTN_COLS) continue;
      const ex = parseExecutive(f[0]);
      vals.push(PH);
      params.push(
        ex.executive_name, ex.emp_code,
        n(f[1]),  n(f[2]),  n(f[3]),  n(f[4]),  n(f[5]),
        dt(f[6]), n(f[7]),  n(f[8]),  n(f[9]),  dt(f[10]),
        n(f[11]), n(f[12]), n(f[13]), dt(f[14]),
        n(f[15]), n(f[16]), n(f[17]), n(f[18]), nm(f[19]),
        n(f[20]), n(f[21]),
      );
      inserted++;
    }
    if (vals.length) {
      await conn.execute(`INSERT INTO dcr_center_attendance ${COLS} VALUES ${vals.join(',')}`, params);
    }
  }
  onLog(`  [attendance] inserted ${inserted} rows`);
  return inserted;
}

// ── AGENCY VISIT SYNC ─────────────────────────────────────────────────────────
// 40 CHR(28)-separated fields per row

const VISIT_COLS = 40;

function buildVisitSql(from, to, spoolFile) {
  const T = v => `REPLACE(REPLACE(${v},CHR(28),' '),CHR(10),' ')`;
  return [
    'SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET FEEDBACK OFF',
    'SET TRIMSPOOL ON', 'SET WRAP OFF', 'SET HEADING OFF',
    `SPOOL "${spoolFile}"`,
    // col 0  executive_name_raw
    // col 1  center_name (agency+drop_point)
    // col 2  unit_name  … col 39 lat_long_addr
    `SELECT`,
    `  NVL(app_tour_login_name(d.comp_code,d.unit_code,NULL,d.created_by,'dd/mm/yyyy','N',NULL,NULL,NULL,NULL,NULL),'')||CHR(28)||`,
    `  NVL(cir_get_agency(d.comp_code,d.unit_code,d.visit_to_main_code,d.visit_to_sub_code)||','||cir_get_drop_point_name(d.comp_code,d.unit_code,d.station,'1'),'')||CHR(28)||`,
    `  NVL(cir_get_unitname(d.unit_code),'')||CHR(28)||`,
    `  NVL(d.comp_code,'')||CHR(28)||`,
    `  NVL(d.unit_code,'')||CHR(28)||`,
    `  NVL(d.bran_code,'')||CHR(28)||`,
    `  NVL(d.call_id,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.call_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.tour_id,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.visit_id),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.visit_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.visit_type,'')||CHR(28)||`,
    `  NVL(d.dist,'')||CHR(28)||`,
    `  NVL(d.station,'')||CHR(28)||`,
    `  NVL(d.visit_to_main_code,'')||CHR(28)||`,
    `  NVL(d.visit_to_sub_code,'')||CHR(28)||`,
    `  NVL(d.from_time,'')||CHR(28)||`,
    `  NVL(d.till_time,'')||CHR(28)||`,
    `  NVL(${T('d.visit_purpose')},'')||CHR(28)||`,
    `  NVL(${T('d.visit_remarks')},'')||CHR(28)||`,
    `  NVL(d.call_type,'')||CHR(28)||`,
    `  NVL(${T('d.contect_person')},'')||CHR(28)||`,
    `  NVL(d.contact_email,'')||CHR(28)||`,
    `  NVL(d.contact_mob_no,'')||CHR(28)||`,
    `  NVL(d.call_status,'')||CHR(28)||`,
    `  NVL(d.created_by,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.created_dt,'YYYY-MM-DD HH24:MI:SS'),'')||CHR(28)||`,
    `  NVL(d.emp_id,'')||CHR(28)||`,
    `  NVL(d.latitude,'')||CHR(28)||`,
    `  NVL(d.longitude,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.no_of_days_hold),'')||CHR(28)||`,
    `  NVL(${T('d.hold_remarks')},'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.next_visit_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.flag_cir_advt,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.mark_attn_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.followup_amount),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.followup_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.corres_type,'')||CHR(28)||`,
    `  NVL(SUBSTR(d.selfie_file,1,500),'')||CHR(28)||`,
    `  NVL(${T('SUBSTR(d.lat_long_addr,1,500)')},'')||CHR(28)||`,
    // trailing sentinel
    `  CHR(28)`,
    `FROM cir_tour_callplan d`,
    `WHERE TRUNC(d.mark_attn_date) BETWEEN TO_DATE('${from}','YYYY-MM-DD') AND TO_DATE('${to}','YYYY-MM-DD')`,
    `AND NVL(d.call_status,'0') IN ('A','C')`,
    `ORDER BY d.mark_attn_date, d.unit_code;`,
    'SPOOL OFF', 'EXIT',
  ].join('\n');
}

async function syncVisit(conn, from, to, onLog) {
  const spoolFile = path.join(os.tmpdir(), `dcr_visit_spool_${process.pid}.txt`);
  const sqlFile   = path.join(os.tmpdir(), `dcr_visit_${process.pid}.sql`);
  fs.writeFileSync(sqlFile, buildVisitSql(from, to, spoolFile));
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

  onLog(`  [agency-visit] Oracle ${from}→${to}…`);
  await runSqlplus(sqlFile);

  if (!fs.existsSync(spoolFile)) {
    onLog(`  [agency-visit] WARNING: no spool file, skipping`);
    return 0;
  }
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const rows = raw.split('\n').filter(l => l.includes(SEP));
  onLog(`  [agency-visit] ${rows.length} rows from Oracle`);

  const [del] = await conn.execute(
    `DELETE FROM dcr_agency_visit WHERE mark_attn_date BETWEEN ? AND ?`, [from, to]);
  onLog(`  [agency-visit] deleted ${del.affectedRows} old rows`);

  let inserted = 0;
  const BATCH = 100;
  const COLS = `(executive_name,emp_code,center_name,unit_name,comp_code,unit_code,bran_code,` +
    `call_id,call_date,tour_id,visit_id,visit_date,visit_type,dist,station,` +
    `visit_to_main_code,visit_to_sub_code,from_time,till_time,visit_purpose,visit_remarks,` +
    `call_type,contect_person,contact_email,contact_mob_no,call_status,created_by,created_dt,` +
    `emp_id,latitude,longitude,no_of_days_hold,hold_remarks,next_visit_date,flag_cir_advt,` +
    `mark_attn_date,followup_amount,followup_date,corres_type,selfie_file,lat_long_addr,synced_at)`;
  const PH = '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())'; // 41?+NOW()

  for (let i = 0; i < rows.length; i += BATCH) {
    const vals = [], params = [];
    for (const row of rows.slice(i, i + BATCH)) {
      const f = row.split(SEP);
      if (f.length < VISIT_COLS) continue;
      const ex = parseExecutive(f[0]);
      vals.push(PH);
      params.push(
        ex.executive_name, ex.emp_code,
        n(f[1]),  n(f[2]),  n(f[3]),  n(f[4]),  n(f[5]),
        n(f[6]),  dt(f[7]), n(f[8]),  nm(f[9]), dt(f[10]),
        n(f[11]), n(f[12]), n(f[13]), n(f[14]), n(f[15]),
        n(f[16]), n(f[17]), n(f[18]), n(f[19]), n(f[20]),
        n(f[21]), n(f[22]), n(f[23]), n(f[24]), n(f[25]),
        dt(f[26]), n(f[27]), n(f[28]), n(f[29]), nm(f[30]),
        n(f[31]), dt(f[32]), n(f[33]), dt(f[34]),
        nm(f[35]), dt(f[36]), n(f[37]), n(f[38]), n(f[39]),
      );
      inserted++;
    }
    if (vals.length) {
      await conn.execute(`INSERT INTO dcr_agency_visit ${COLS} VALUES ${vals.join(',')}`, params);
    }
  }
  onLog(`  [agency-visit] inserted ${inserted} rows`);
  return inserted;
}

// ── MONTH RANGE GENERATOR ─────────────────────────────────────────────────────

function monthRanges(fromYM, toYM) {
  const ranges = [];
  let [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  while (fy < ty || (fy === ty && fm <= tm)) {
    const last = new Date(fy, fm, 0).getDate();
    ranges.push({
      from: `${fy}-${String(fm).padStart(2, '0')}-01`,
      to:   `${fy}-${String(fm).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
    });
    if (++fm > 12) { fm = 1; fy++; }
  }
  return ranges;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

async function runSync(opts = {}) {
  const onLog = opts.onLog || (s => console.log(s));

  // Ensure tables exist once; use an isolated connection so DDL doesn't taint sync connections
  const setupConn = await mysql.createConnection(MYSQL_CFG);
  try { await ensureTables(setupConn); } finally { await setupConn.end(); }

  let periods;
  if (opts.backfill) {
    const today = new Date();
    const toYM  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const twoYrsAgo = new Date(today.getFullYear() - 2, today.getMonth(), 1);
    const fromYM = `${twoYrsAgo.getFullYear()}-${String(twoYrsAgo.getMonth() + 1).padStart(2, '0')}`;
    periods = monthRanges(fromYM, toYM).reverse(); // newest first
    onLog(`[dcr-sync] Backfill: ${periods.length} months (newest first) from ${fromYM}`);
  } else if (opts.from && opts.to) {
    const fromYM = opts.from.slice(0, 7);
    const toYM   = opts.to.slice(0, 7);
    periods = monthRanges(fromYM, toYM);
    onLog(`[dcr-sync] Range ${opts.from}→${opts.to}: ${periods.length} month(s)`);
  } else {
    // Live sync (manual button): today only. Yesterday is handled by the 6 AM scheduled sync.
    const fmt = d => d.toISOString().slice(0, 10);
    const today = new Date();
    periods = [{ from: fmt(today), to: fmt(today) }];
  }

  let totalAttn = 0, totalVisit = 0;
  for (const { from, to } of periods) {
    onLog(`[dcr-sync] Period ${from} → ${to}`);
    // Fresh connection per period: Oracle sqlplus fetch can take 1-2 min, leaving MySQL idle;
    // a per-period connection avoids wait_timeout drops poisoning the entire backfill run.
    const conn = await mysql.createConnection(MYSQL_CFG);
    try {
      totalAttn  += await syncAttendance(conn, from, to, onLog);
      totalVisit += await syncVisit(conn, from, to, onLog);
    } finally {
      await conn.end();
    }
  }

  onLog(`[dcr-sync] Complete — attendance: ${totalAttn}, agency-visits: ${totalVisit}`);
  return { totalAttn, totalVisit, periods: periods.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  if (args.includes('--backfill')) opts.backfill = true;
  const fi = args.indexOf('--from'); if (fi >= 0) opts.from = args[fi + 1];
  const ti = args.indexOf('--to');   if (ti >= 0) opts.to   = args[ti + 1];
  runSync(opts)
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { runSync };
