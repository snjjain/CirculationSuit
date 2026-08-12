'use strict';

/**
 * collection_sync.js — Pulls collection receipt data from Oracle ERP → MySQL (agency_collection)
 *
 * Usage:
 *   node api/collection_sync.js                              # syncs yesterday
 *   node api/collection_sync.js --date 2026-07-16           # syncs one date
 *   node api/collection_sync.js --from 2026-01-01           # Jan 1 to yesterday
 *   node api/collection_sync.js --from 2026-01-01 --to 2026-08-05
 *
 * Initial backfill (run once):
 *   node api/collection_sync.js --from 2026-01-01
 *
 * Scheduled daily at 06:10 via Windows Task Scheduler (scripts/register_collection_sync_task.ps1)
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

const LOG_FILE = path.resolve(__dirname, '../logs/collection_sync.log');

// ASCII 28 (file separator) — never appears in data
const SEP = '\x1c';

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── Parse args ────────────────────────────────────────────────────────────────
function getDateRange() {
  const argv = process.argv;

  function yesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().substring(0, 10);
  }

  function validate(val, flag) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      log(`ERROR: invalid ${flag} "${val}" (expected YYYY-MM-DD)`);
      process.exit(1);
    }
    return val;
  }

  const dateIdx = argv.indexOf('--date');
  if (dateIdx !== -1) {
    const d = validate(argv[dateIdx + 1], '--date');
    return { fromDate: d, toDate: d };
  }

  const fromIdx = argv.indexOf('--from');
  const toIdx   = argv.indexOf('--to');

  if (fromIdx !== -1) {
    const fromDate = validate(argv[fromIdx + 1], '--from');
    const toDate   = toIdx !== -1 ? validate(argv[toIdx + 1], '--to') : yesterday();
    return { fromDate, toDate };
  }

  const yd = yesterday();
  return { fromDate: yd, toDate: yd };
}

// ── Parse helpers ─────────────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

// 'DD/MM/YYYY' → 'YYYY-MM-DD'
function toDate(v) {
  const t = str(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.substring(0, 10);
  return null;
}

// ── Month batches (for range syncs) ──────────────────────────────────────────
// Use local-date arithmetic; avoid toISOString() which shifts to UTC on IST machines.
function localDate(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function monthBatches(fromDate, toDate) {
  const batches = [];
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);

  let y = fy, m = fm, d = fd;

  while (y < ty || (y === ty && m <= tm)) {
    // last day of current month
    const lastDay = new Date(y, m, 0).getDate(); // new Date(y, m, 0) = last day of month m
    const batchFrom = localDate(y, m, d);
    const isLastBatch = (y === ty && m === tm);
    const batchTo = isLastBatch ? toDate : localDate(y, m, lastDay);
    batches.push({ from: batchFrom, to: batchTo });
    // advance to first of next month
    m++;
    if (m > 12) { m = 1; y++; }
    d = 1; // subsequent months always start on 1st
  }
  return batches;
}

// ── Build Oracle SQL for sqlplus ──────────────────────────────────────────────
function buildSqlScript(fromDate, toDate, spoolFile) {
  const D = 'CHR(28)';

  // 22 fields — order matches lineToParams() below
  const fields = [
    'outr.comp_code',                              //  0
    'outr.unit_code',                              //  1
    'outr.unit_name',                              //  2
    'outr.doctype',                                //  3
    'outr.reason',                                 //  4
    'outr.reason_name',                            //  5
    'outr.agcd',                                   //  6
    'outr.dpcd',                                   //  7
    'outr.ag_name',                                //  8
    'outr.city_code',                              //  9
    'outr.city_name',                              // 10
    'outr.dist_code',                              // 11
    'outr.dist_name',                              // 12
    'outr.state_code',                             // 13
    'outr.state_name',                             // 14
    'outr.recptno',                                // 15
    "TO_CHAR(outr.recptdt,'DD/MM/YYYY')",          // 16
    'outr.amount',                                 // 17
    'outr.ACHD',                                   // 18
    'outr.RCDP',                                   // 19
    'outr.CCDP',                                   // 20
    'outr.CLEARANCE_TYPE',                         // 21
  ].join(` || ${D} || `);

  // Spoolfile path must use forward slashes or escaped backslashes for sqlplus
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
SELECT REPLACE(REPLACE(${fields}, CHR(10), ' '), CHR(13), ' ')
FROM (
  select x.comp_code, x.unit_code, x.unit_name, x.doctype, x.reason, x.reason_name,
      x.agcd, x.dpcd, x.ag_name, x.city_code, x.city_name,
      x.dist_code, x.dist_name, x.state_code, x.state_name, x.recptno,
      x.recptdt, x.amount, x.ACHD, x.RCDP, x.CCDP,
      NVL((SELECT C.CLR_TYPE_DESC FROM CLEARANCE_TYPE_MAST C WHERE C.CLR_TYPE_CODE = x.CLEARANCE_TYPE),'OTHER') CLEARANCE_TYPE
  from
  (select d.comp_code, d.unit_code, get_unit_name(d.comp_code, d.unit_code) unit_name, d.doctype, d.reason,
      nvl(GET_PAYMODE_NAME(d.reason,d.comp_code),cir_get_reason_name(d.comp_code, d.reason)) reason_name,
      d.agcd, d.dpcd, m.ag_name, m.city_code,
      (select city_name from cir_city_mast where comp_code = d.comp_code and city_code = m.city_code) city_name,
      m.dist_code,
      (select dist_name from cir_dist_mast where comp_code = d.comp_code and dist_code = m.dist_code) dist_name,
      m.state_code,
      (select "State_Name" from state_mst where "Comp_Code" = d.comp_code and "State_Code" = m.state_code) state_name,
      d.recptno, d.recptdt, d.amount, d.ACHD, D.RCDP, D.CCDP, D.CLEARANCE_TYPE
  from cir_rcphdr d, cir_agmast m
  where d.comp_code = m.comp_code
      and d.unit_code = m.unit
      and d.agcd = m.agcd
      and d.dpcd = m.dpcd
      and d.comp_code = 'RP001'
      and d.recptdt between TO_DATE('${fromDate}','YYYY-MM-DD') and TO_DATE('${toDate}','YYYY-MM-DD')
      order by unit_code, recptdt
  ) x
) outr;
SPOOL OFF
EXIT
`;
}

// ── Run sqlplus: credentials via stdin only, never on command line ────────────
function runSqlplus(sqlFile) {
  return new Promise((resolve, reject) => {
    const connectString =
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

    proc.stdin.write(`CONNECT ${connectString}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Map parsed line (22 fields) → MySQL INSERT params ────────────────────────
function lineToParams(f) {
  return [
    str(f[0]),     // comp_code
    str(f[1]),     // unit_code
    str(f[2]),     // branch_name  (unit_name from get_unit_name)
    str(f[3]),     // doc_type     (doctype: BIL, TC, TD, RCR, DN, CN, ...)
    str(f[4]),     // reason       (reason code)
    str(f[5]),     // payment_mode (reason_name: NVL GET_PAYMODE_NAME / cir_get_reason_name)
    str(f[6]),     // ag_code      (agcd)
    str(f[7]),     // dp_code      (dpcd)
    str(f[8]),     // ag_name
    str(f[9]),     // city_code
    str(f[10]),    // city_name
    str(f[11]),    // dist_code
    str(f[12]),    // district_name (dist_name)
    str(f[13]),    // state_code
    str(f[14]),    // state_name
    str(f[15]),    // doc_no       (recptno)
    toDate(f[16]), // coll_date    (recptdt DD/MM/YYYY)
    num(f[17]),    // amount
    str(f[18]),    // debit_head   (ACHD: NM=Normal, SC=Security)
    str(f[19]),    // rcdp
    str(f[20]),    // ccdp
    str(f[21]),    // payment_cat  (CLEARANCE_TYPE description)
  ];
}

const INSERT_SQL = `
  INSERT INTO agency_collection
    (comp_code, unit_code, branch_name, doc_type, reason,
     payment_mode, ag_code, dp_code, ag_name,
     city_code, city_name, dist_code, district_name, state_code, state_name,
     doc_no, coll_date, amount, debit_head, rcdp, ccdp, payment_cat)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

// ── Ensure schema has Oracle-sync columns ─────────────────────────────────────
async function ensureSchema(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agency_collection'`
  );
  const existing = new Set(cols.map(r => r.COLUMN_NAME));

  const additions = [
    { name: 'comp_code',  sql: 'VARCHAR(20) DEFAULT NULL' },
    { name: 'unit_code',  sql: 'VARCHAR(20) DEFAULT NULL' },
    { name: 'reason',     sql: 'VARCHAR(50) DEFAULT NULL' },
    { name: 'city_code',  sql: 'VARCHAR(30) DEFAULT NULL' },
    { name: 'city_name',  sql: 'VARCHAR(100) DEFAULT NULL' },
    { name: 'dist_code',  sql: 'VARCHAR(30) DEFAULT NULL' },
    { name: 'state_code', sql: 'VARCHAR(30) DEFAULT NULL' },
    { name: 'rcdp',       sql: 'VARCHAR(50) DEFAULT NULL' },
    { name: 'ccdp',       sql: 'VARCHAR(50) DEFAULT NULL' },
    { name: 'synced_at',  sql: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
  ];

  for (const col of additions) {
    if (!existing.has(col.name)) {
      await conn.execute(`ALTER TABLE agency_collection ADD COLUMN ${col.name} ${col.sql}`);
      log(`  Schema: added column ${col.name}`);
    }
  }
}

// ── Sync one date range batch ─────────────────────────────────────────────────
async function syncBatch(conn, fromDate, toDate) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-coll-'));
  const sqlFile   = path.join(tmpDir, 'query.sql');
  const spoolFile = path.join(tmpDir, 'data.txt');

  try {
    fs.writeFileSync(sqlFile, buildSqlScript(fromDate, toDate, spoolFile), 'utf8');
    log(`  [${fromDate} → ${toDate}] Running Oracle query...`);
    await runSqlplus(sqlFile);

    if (!fs.existsSync(spoolFile)) {
      log(`  [${fromDate} → ${toDate}] No spool file produced — skipping`);
      return { fetched: 0, deleted: 0, inserted: 0 };
    }

    const raw   = fs.readFileSync(spoolFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.includes(SEP));
    log(`  [${fromDate} → ${toDate}] Oracle returned ${lines.length} rows`);

    if (lines.length === 0) {
      log(`  [${fromDate} → ${toDate}] No collection data — nothing to import`);
      return { fetched: 0, deleted: 0, inserted: 0 };
    }

    // Parse rows — each must have exactly 22 delimited fields
    const parsed = [];
    let bad = 0;
    for (const line of lines) {
      const f = line.split(SEP);
      if (f.length !== 22) { bad++; continue; }
      parsed.push(f);
    }
    if (bad > 0) log(`  WARNING: skipped ${bad} malformed lines (wrong field count)`);

    await conn.beginTransaction();

    const [delRes] = await conn.execute(
      'DELETE FROM agency_collection WHERE coll_date BETWEEN ? AND ?',
      [fromDate, toDate]
    );
    log(`  Deleted ${delRes.affectedRows} existing rows for range`);

    let inserted = 0, errors = 0;
    for (const f of parsed) {
      try {
        await conn.execute(INSERT_SQL, lineToParams(f));
        inserted++;
      } catch (err) {
        errors++;
        if (errors <= 5) log(`  Row error: ${err.message} — recptno:${str(f[15])} date:${str(f[16])}`);
      }
    }

    await conn.commit();
    log(`  Inserted ${inserted} rows${errors > 0 ? `, skipped ${errors} with errors` : ''}`);
    return { fetched: lines.length, deleted: delRes.affectedRows, inserted };

  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── runSync — programmatic entry point (used by server.js API endpoint) ───────
async function runSync(opts = {}) {
  const onLog = opts.onLog || log;

  function yesterday() {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  const fromDate = opts.from || yesterday();
  const toDate   = opts.to   || today();

  onLog(`=== Collection sync | ${fromDate} → ${toDate} ===`);

  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    await ensureSchema(conn);
    const batches = monthBatches(fromDate, toDate);
    onLog(`Processing ${batches.length} batch(es)…`);
    let totalInserted = 0, totalFetched = 0;
    for (const b of batches) {
      const r = await syncBatch(conn, b.from, b.to);
      totalInserted += r.inserted;
      totalFetched  += r.fetched;
    }
    onLog(`=== Collection sync complete — fetched: ${totalFetched}, inserted: ${totalInserted} ===`);
    return { totalFetched, totalInserted, batches: batches.length };
  } catch (err) {
    onLog(`FATAL: ${err.message}`);
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    try { await conn.end(); } catch (_) {}
  }
}

// ── Main (CLI) ────────────────────────────────────────────────────────────────
async function main() {
  const { fromDate, toDate } = getDateRange();
  log(`=== Collection sync started | range: ${fromDate} → ${toDate} ===`);

  for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
    if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exit(1); }
  }
  if (!fs.existsSync(SQLPLUS)) {
    log(`ERROR: sqlplus not found at ${SQLPLUS} (set SQLPLUS_PATH in .env)`);
    process.exit(1);
  }

  await runSync({ from: fromDate, to: toDate }).catch(err => {
    log(`FATAL: ${err.message}`);
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = { runSync };
