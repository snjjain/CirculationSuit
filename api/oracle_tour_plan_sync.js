'use strict';
/**
 * oracle_tour_plan_sync.js — Sync submitted Tour Plans from Oracle → MySQL
 *
 * Source: RPERPDATA.CIR_TOUR_PLAN_DTL — the PLANNED itinerary an executive,
 * Edition Incharge, Circulation Incharge or Zonal Head creates (distinct from
 * cir_tour_callplan / dcr_agency_visit, which records actual completed visits
 * and already has its own sync in oracle_dcr_sync.js).
 *
 * District/Station/Agency/Unit names are resolved Oracle-side (same helper
 * functions and CIR_DIST_MAST/CIR_APPS_CALL_TYPE join pattern already proven
 * in oracle_dcr_sync.js) so the MySQL mirror never needs a cross-collation
 * JOIN against these lookup tables. APPROVED_BY stays a raw code — it's
 * resolved to a name via exec_hierarchy_mapping in the app layer, same as
 * every other incharge-code lookup in this codebase.
 *
 * Usage:
 *   node api/oracle_tour_plan_sync.js                    # yesterday → +8 days (today's cron window)
 *   node api/oracle_tour_plan_sync.js --backfill          # Jan 2025 → today (reverse)
 *   node api/oracle_tour_plan_sync.js --from 2026-07-01 --to 2026-07-31
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

// ── helpers (same as oracle_dcr_sync.js) ────────────────────────────────────

const SQLPLUS_TIMEOUT_MS = 25 * 60 * 1000;

const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
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
    // Drain stdout even though the data goes to the spool. An unread pipe fills at ~64KB
    // and blocks sqlplus mid-query; this is the belt to TERMOUT OFF's braces, and keeps
    // any SP2-/ORA- message sqlplus prints on stdout available for the error below.
    let stdout = '';
    proc.stdout.on('data', d => { if (stdout.length < 65536) stdout += d.toString(); });
    proc.stdin.write(`CONNECT ${connectStr}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve(-1);
    }, SQLPLUS_TIMEOUT_MS);

    proc.on('close', code => { clearTimeout(timer); resolve(code); });
    proc.on('error', err  => { clearTimeout(timer); reject(err); });
  });
}

function parseCreator(raw) {
  if (!raw || !raw.trim()) return null;
  const tilde = raw.indexOf('~');
  return (tilde < 0 ? raw : raw.slice(0, tilde)).trim() || null;
}

const n  = v => (v && v.trim()) ? v.trim() : null;
const dt = v => (v && v.trim()) ? v.trim() : null;
const nm = v => { const x = parseFloat(v); return isNaN(x) ? null : x; };

// ── CREATE TABLE ─────────────────────────────────────────────────────────────

async function ensureTable(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS cir_tour_plan_dtl (
      id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
      created_by_name        VARCHAR(200),
      unit_name              VARCHAR(200),
      comp_code              VARCHAR(8),
      unit_code              VARCHAR(8),
      tour_id                VARCHAR(10),
      visit_id               BIGINT,
      visit_date              DATE,
      visit_type              VARCHAR(10),
      dist_code               VARCHAR(10),
      dist_name                VARCHAR(50),
      station_code             VARCHAR(10),
      station_name             VARCHAR(100),
      visit_to_main_code       VARCHAR(10),
      visit_to_sub_code        VARCHAR(10),
      agency_name              VARCHAR(300),
      from_time                VARCHAR(10),
      till_time                VARCHAR(10),
      visit_purpose            VARCHAR(500),
      visit_remarks            VARCHAR(1000),
      created_by               VARCHAR(8),
      created_dt               DATETIME,
      updated_by                VARCHAR(8),
      updated_dt                 DATETIME,
      call_type                   VARCHAR(20),
      call_type_name               VARCHAR(50),
      contect_person                VARCHAR(50),
      contact_email                  VARCHAR(50),
      contact_mob_no                  VARCHAR(15),
      approved_flag                    VARCHAR(1),
      approved_by                       VARCHAR(20),
      approved_date                      DATE,
      resch_cancel_reason                  VARCHAR(100),
      cancel_status                          VARCHAR(1),
      prev_visit_id                            BIGINT,
      flag_cir_advt_d                            VARCHAR(10),
      approval_remark                              VARCHAR(1000),
      agency_unitcode                                VARCHAR(8),
      current_outstanding                              DECIMAL(15,2),
      current_growth_target                              INT,
      current_rp_supply                                    INT,
      current_db_supply                                      INT,
      remark                                                   VARCHAR(1000),
      station_lat            DECIMAL(10,6),
      station_lng             DECIMAL(10,6),
      synced_at              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_visit_date (visit_date),
      INDEX idx_unit_date (unit_code, visit_date),
      INDEX idx_created_by (created_by, visit_date),
      INDEX idx_approved_by (approved_by),
      INDEX idx_visit_agency (visit_to_main_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ── TOUR PLAN SYNC ────────────────────────────────────────────────────────────
// 44 CHR(28)-separated fields per row

const PLAN_COLS = 44;

function buildPlanSql(from, to, spoolFile) {
  const T = v => `REPLACE(REPLACE(${v},CHR(28),' '),CHR(10),' ')`;
  return [
    // TERMOUT OFF is load-bearing, not tidiness: without it sqlplus writes every row to
    // stdout as well as the spool. Nothing drains that pipe, so past the ~64KB OS buffer
    // sqlplus blocks on write and never finishes — the spool freezes mid-result.
    'SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET FEEDBACK OFF',
    'SET TRIMSPOOL ON', 'SET WRAP OFF', 'SET HEADING OFF', 'SET TERMOUT OFF',
    `SPOOL "${spoolFile}"`,
    // col 0  created_by_name_raw ("NAME ~ EMP_CODE" — only the name half is kept)
    // col 1  unit_name … col 41 remark … col 42 station_lat, col 43 station_lng
    `SELECT`,
    `  NVL(app_tour_login_name(d.comp_code,d.unit_code,NULL,d.created_by,'dd/mm/yyyy','N',NULL,NULL,NULL,NULL,NULL),'')||CHR(28)||`,
    `  NVL(cir_get_unitname(d.unit_code),'')||CHR(28)||`,
    `  NVL(d.comp_code,'')||CHR(28)||`,
    `  NVL(d.unit_code,'')||CHR(28)||`,
    `  NVL(d.tour_id,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.visit_id),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.visit_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(d.visit_type,'')||CHR(28)||`,
    `  NVL(d.dist,'')||CHR(28)||`,
    `  NVL(dm.dist_name,'')||CHR(28)||`,
    `  NVL(d.station,'')||CHR(28)||`,
    `  NVL(cir_get_drop_point_name(d.comp_code,d.unit_code,d.station,'1'),'')||CHR(28)||`,
    `  NVL(d.visit_to_main_code,'')||CHR(28)||`,
    `  NVL(d.visit_to_sub_code,'')||CHR(28)||`,
    `  NVL(cir_get_agency(d.comp_code,d.unit_code,d.visit_to_main_code,d.visit_to_sub_code),'')||CHR(28)||`,
    `  NVL(d.from_time,'')||CHR(28)||`,
    `  NVL(d.till_time,'')||CHR(28)||`,
    `  NVL(${T('d.visit_purpose')},'')||CHR(28)||`,
    `  NVL(${T('d.visit_remarks')},'')||CHR(28)||`,
    `  NVL(d.created_by,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.created_dt,'YYYY-MM-DD HH24:MI:SS'),'')||CHR(28)||`,
    `  NVL(d.updated_by,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.updated_dt,'YYYY-MM-DD HH24:MI:SS'),'')||CHR(28)||`,
    `  NVL(d.call_type,'')||CHR(28)||`,
    `  NVL(ct.call_type_name,'')||CHR(28)||`,
    `  NVL(${T('d.contect_person')},'')||CHR(28)||`,
    `  NVL(d.contact_email,'')||CHR(28)||`,
    `  NVL(d.contact_mob_no,'')||CHR(28)||`,
    `  NVL(d.approved_flag,'')||CHR(28)||`,
    `  NVL(d.approved_by,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.approved_date,'YYYY-MM-DD'),'')||CHR(28)||`,
    `  NVL(${T('d.resch_cancel_reason')},'')||CHR(28)||`,
    `  NVL(d.cancel_status,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.prev_visit_id),'')||CHR(28)||`,
    `  NVL(d.flag_cir_advt_d,'')||CHR(28)||`,
    `  NVL(${T('d.approval_remark')},'')||CHR(28)||`,
    `  NVL(d.agency_unitcode,'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.current_outstanding),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.current_growth_target),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.current_rp_supply),'')||CHR(28)||`,
    `  NVL(TO_CHAR(d.current_db_supply),'')||CHR(28)||`,
    `  NVL(${T('d.remark')},'')||CHR(28)||`,
    // Drop-point GPS — lets agencies be plotted on the map by their tour-plan
    // station, same LATITUDE/LOGNITUDE columns CIR_DROP_POINT_MAST already
    // carries for the DCR agency-map (dcr_analytics.js reads visit-time GPS;
    // this is the station's registered GPS, useful when no visit GPS exists yet).
    `  NVL(dp.latitude,'')||CHR(28)||`,
    `  NVL(dp.lognitude,'')||CHR(28)||`,
    // trailing sentinel so split count is reliable
    `  CHR(28)`,
    `FROM cir_tour_plan_dtl d`,
    `LEFT JOIN cir_dist_mast dm ON dm.comp_code = d.comp_code AND dm.dist_code = d.dist`,
    `LEFT JOIN cir_apps_call_type ct ON ct.comp_code = d.comp_code AND ct.call_type_code = d.call_type`,
    `LEFT JOIN cir_drop_point_mast dp ON dp.comp_code = d.comp_code AND dp.unit_code = d.unit_code AND dp.drop_point = d.station`,
    `WHERE d.visit_date BETWEEN TO_DATE('${from}','YYYY-MM-DD') AND TO_DATE('${to}','YYYY-MM-DD')`,
    `ORDER BY d.visit_date, d.unit_code;`,
    'SPOOL OFF', 'EXIT',
  ].join('\n');
}

async function syncPlan(conn, from, to, onLog) {
  const spoolFile = path.join(os.tmpdir(), 'tour_plan_spool.txt');
  const sqlFile   = path.join(os.tmpdir(), 'tour_plan.sql');
  fs.writeFileSync(sqlFile, buildPlanSql(from, to, spoolFile));
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

  onLog(`  [tour-plan] Oracle ${from}→${to}…`);
  const rc = await runSqlplus(sqlFile);

  /* A killed or failed sqlplus still leaves the rows it managed to spool. Reading that
     partial file and then deleting the whole date range wipes real data and reports
     success — which is exactly how 2026-08-04→31 was lost. Refuse to touch MySQL
     unless Oracle actually finished. */
  if (rc !== 0) {
    throw new Error(`sqlplus did not complete for ${from}→${to} (exit ${rc}` +
      `${rc === -1 ? ' — timed out and was killed' : ''}). MySQL left untouched.`);
  }
  if (!fs.existsSync(spoolFile)) {
    onLog(`  [tour-plan] WARNING: no spool file, skipping`);
    return 0;
  }
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const rows = raw.split('\n').filter(l => l.includes(SEP));
  onLog(`  [tour-plan] ${rows.length} rows from Oracle`);

  /* Second guard for the failure sqlplus does not report: a clean exit over a
     truncated result. Oracle is the source of truth so a genuine drop is possible
     (plans cancelled, a month purged), but losing most of a range silently is not
     something to do on a schedule — make the operator confirm with --force. */
  const [[prior]] = await conn.query(
    `SELECT COUNT(*) n FROM cir_tour_plan_dtl WHERE visit_date BETWEEN ? AND ?`, [from, to]);
  const had = Number(prior.n) || 0;
  if (had >= 50 && rows.length < had * 0.5 && !process.argv.includes('--force')) {
    throw new Error(`Refusing to overwrite ${from}→${to}: MySQL has ${had} rows but Oracle ` +
      `returned only ${rows.length}. Re-run to confirm it is real, or pass --force to accept.`);
  }

  const [del] = await conn.execute(
    `DELETE FROM cir_tour_plan_dtl WHERE visit_date BETWEEN ? AND ?`, [from, to]);
  onLog(`  [tour-plan] deleted ${del.affectedRows} old rows`);

  let inserted = 0;
  const BATCH = 100;
  const COLS = `(created_by_name,unit_name,comp_code,unit_code,tour_id,visit_id,visit_date,visit_type,` +
    `dist_code,dist_name,station_code,station_name,visit_to_main_code,visit_to_sub_code,agency_name,` +
    `from_time,till_time,visit_purpose,visit_remarks,created_by,created_dt,updated_by,updated_dt,` +
    `call_type,call_type_name,contect_person,contact_email,contact_mob_no,approved_flag,approved_by,` +
    `approved_date,resch_cancel_reason,cancel_status,prev_visit_id,flag_cir_advt_d,approval_remark,` +
    `agency_unitcode,current_outstanding,current_growth_target,current_rp_supply,current_db_supply,` +
    `remark,station_lat,station_lng,synced_at)`;
  const PH = '(' + Array(44).fill('?').join(',') + ',NOW())'; // 44 ? + NOW()

  for (let i = 0; i < rows.length; i += BATCH) {
    const vals = [], params = [];
    for (const row of rows.slice(i, i + BATCH)) {
      const f = row.split(SEP);
      if (f.length < PLAN_COLS) continue;
      vals.push(PH);
      params.push(
        parseCreator(f[0]), n(f[1]),  n(f[2]),  n(f[3]),
        n(f[4]),  nm(f[5]), dt(f[6]), n(f[7]),
        n(f[8]),  n(f[9]),  n(f[10]), n(f[11]),
        n(f[12]), n(f[13]), n(f[14]),
        n(f[15]), n(f[16]), n(f[17]), n(f[18]),
        n(f[19]), dt(f[20]), n(f[21]), dt(f[22]),
        n(f[23]), n(f[24]), n(f[25]), n(f[26]), n(f[27]),
        n(f[28]), n(f[29]), dt(f[30]),
        n(f[31]), n(f[32]), nm(f[33]), n(f[34]), n(f[35]),
        n(f[36]), nm(f[37]), nm(f[38]), nm(f[39]), nm(f[40]),
        n(f[41]), nm(f[42]), nm(f[43]),
      );
      inserted++;
    }
    if (vals.length) {
      await conn.execute(`INSERT INTO cir_tour_plan_dtl ${COLS} VALUES ${vals.join(',')}`, params);
    }
  }
  onLog(`  [tour-plan] inserted ${inserted} rows`);
  return inserted;
}

// ── MONTH RANGE GENERATOR (same as oracle_dcr_sync.js) ───────────────────────

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

  const setupConn = await mysql.createConnection(MYSQL_CFG);
  try { await ensureTable(setupConn); } finally { await setupConn.end(); }

  let periods;
  if (opts.backfill) {
    const today = new Date();
    const toYM  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const twoYrsAgo = new Date(today.getFullYear() - 2, today.getMonth(), 1);
    const fromYM = `${twoYrsAgo.getFullYear()}-${String(twoYrsAgo.getMonth() + 1).padStart(2, '0')}`;
    periods = monthRanges(fromYM, toYM).reverse();
    onLog(`[tour-plan-sync] Backfill: ${periods.length} months (newest first) from ${fromYM}`);
  } else if (opts.from && opts.to) {
    const fromYM = opts.from.slice(0, 7);
    const toYM   = opts.to.slice(0, 7);
    periods = monthRanges(fromYM, toYM);
    onLog(`[tour-plan-sync] Range ${opts.from}→${opts.to}: ${periods.length} month(s)`);
  } else {
    // Default window: yesterday → +8 days ahead. Tour plans are dated for the
    // NEAR FUTURE (unlike DCR actuals, which look backward) — this window
    // covers "plans submitted for today" (what the 10am validation job reads)
    // plus enough lookahead for the 7-day-tour-plan comparison horizon.
    const fmt = d => d.toISOString().slice(0, 10);
    const today = new Date();
    const from = new Date(today); from.setDate(today.getDate() - 1);
    const to   = new Date(today); to.setDate(today.getDate() + 8);
    periods = [{ from: fmt(from), to: fmt(to) }];
  }

  let total = 0;
  for (const { from, to } of periods) {
    onLog(`[tour-plan-sync] Period ${from} → ${to}`);
    const conn = await mysql.createConnection(MYSQL_CFG);
    try {
      total += await syncPlan(conn, from, to, onLog);
    } finally {
      await conn.end();
    }
  }

  onLog(`[tour-plan-sync] Complete — rows: ${total}`);
  return { total, periods: periods.length };
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

module.exports = { runSync, ensureTable };
