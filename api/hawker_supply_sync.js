'use strict';

/**
 * hawker_supply_sync.js — Oracle CRM_HAWKER_DATEWISE_SUPPLY → MySQL hawker_supply
 *
 * Modes:
 *   node hawker_supply_sync.js                          # daily: load yesterday
 *   node hawker_supply_sync.js --date 2026-08-05        # specific single date
 *   node hawker_supply_sync.js --from-last              # auto-detect last date, sync forward
 *   node hawker_supply_sync.js --historical             # 2020-03-18 → today (monthly chunks)
 *   node hawker_supply_sync.js --from 2020-03-18 [--to 2026-08-07]  # custom range
 *
 * Historical load breakdown:
 *   2020-03-18         → single-day COVID reference for special comparisons
 *   2021-01-01 → today → last 5 years, one month at a time
 * Resumable: hawker_supply_sync_log tracks completed chunks; re-run skips done chunks.
 * Security: Oracle credentials passed via sqlplus stdin ONLY, never on CLI or disk.
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ── CLI args ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const HISTORICAL = args.includes('--historical');
const REVERSE    = args.includes('--reverse');  // process monthly chunks newest → oldest
const FROM_LAST  = args.includes('--from-last');
const ARG_DATE   = args.find((_, i) => args[i - 1] === '--date');
const ARG_FROM   = args.find((_, i) => args[i - 1] === '--from');
const ARG_TO     = args.find((_, i) => args[i - 1] === '--to');

const COVID_BASE = '2020-03-18';

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/hawker_supply_sync.log');
const SEP   = '\x1c';   // ASCII 28 — field separator, never appears in data
const D     = 'CHR(28)';
const NCOLS = 23;       // must match cols array in buildSqlScript

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

// ── Date helpers ──────────────────────────────────────────────────────────────
function fmtDate(d) { return d.toISOString().slice(0, 10); }

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

// Generate inclusive monthly chunks from fromStr to toStr.
// Each chunk covers from the given start day through the last day of the same month,
// then the 1st through the last of each subsequent month.
function monthlyChunks(fromStr, toStr) {
  const chunks = [];
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm]     = toStr.split('-').map(Number);

  let y = fy, m = fm, d = fd;

  while (y < ty || (y === ty && m <= tm)) {
    const lastDay    = new Date(y, m, 0).getDate(); // new Date(y,m,0) = last day of month m (1-based)
    const chunkFrom  = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isLastMonth = (y === ty && m === tm);
    const chunkTo    = isLastMonth
      ? toStr
      : `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    chunks.push({ from: chunkFrom, to: chunkTo });

    m++;
    if (m > 12) { m = 1; y++; }
    d = 1;
  }
  return chunks;
}

// ── Oracle SQL builder ────────────────────────────────────────────────────────
// 23 fields; fromDate and toDate are INCLUSIVE (Oracle BETWEEN).
// Each column is on its own line to stay within sqlplus 2499-char line limit.
function buildSqlScript(spoolFile, fromDate, toDate) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');

  // Strip CHR(28) / newlines from any string field, and NVL(TO_CHAR()) for null safety.
  const S = f =>
    `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

  const cols = [
    S('x.loc_id'),                   //  0 loc_id
    S('x.unit_name'),                //  1 unit_name
    S('x.hwk_cent_code'),            //  2 hwk_cent_code
    S('x.hawker_center'),            //  3 hawker_center
    S('x.hawker_id'),                //  4 hawker_id
    S('x.hawker_name'),              //  5 hawker_name
    S('x.center_incharge'),          //  6 center_incharge (code)
    S('x.center_incharge_name'),     //  7 center_incharge_name
    S('x.field_officer'),            //  8 field_officer (code)
    S('x.field_officer_name'),       //  9 field_officer_name
    S('x.publ_code'),                // 10 publ_code
    S('x.pub_name'),                 // 11 pub_name
    S('x.edition_code'),             // 12 edition_code
    S('x.edtn_name'),                // 13 edtn_name
    S('x.gate_pass_no'),             // 14 gate_pass_no
    S('x.supply_date'),              // 15 supply_date   (pre-formatted YYYY-MM-DD)
    S('x.creation_date'),            // 16 creation_date (pre-formatted YYYY-MM-DD HH24:MI:SS)
    S('x.sup_copies'),               // 17 sup_copies
    S('x.copy_rate'),                // 18 copy_rate
    S('x.copy_amount'),              // 19 copy_amount
    S('x.net_amount'),               // 20 net_amount
    S('x.bill_no'),                  // 21 bill_no
    S('x.bill_dt'),                  // 22 bill_dt       (pre-formatted YYYY-MM-DD)
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
FROM (
  SELECT
    B.LOC_ID                                                                      loc_id,
    NVL(REPLACE(cir_get_unitname(B.LOC_ID),CHR(28),' '),'')                      unit_name,
    A.HWK_CENT_CODE                                                               hwk_cent_code,
    (SELECT NVL(REPLACE(CENT_NAME,CHR(28),' '),'')
       FROM CRM_CENTER_MASTER
      WHERE CENT_ID=A.HWK_CENT_CODE AND LOC_ID=A.UNIT_CODE)                      hawker_center,
    B.HAWKER_ID                                                                   hawker_id,
    NVL(REPLACE(B.HAWKER_NAME,CHR(28),' '),'')                                    hawker_name,
    B.center_incharge                                                              center_incharge,
    NVL(REPLACE(cir_get_executive(B.compcode,B.center_incharge),CHR(28),' '),'')  center_incharge_name,
    B.field_officer                                                                field_officer,
    NVL(REPLACE(cir_get_executive(B.compcode,B.field_officer),CHR(28),' '),'')    field_officer_name,
    A.PUBL_CODE                                                                   publ_code,
    NVL(REPLACE(CIR_GET_PUBL_NAME(A.COMPCODE,A.PUBL_CODE),CHR(28),' '),'')       pub_name,
    A.EDITION_CODE                                                                edition_code,
    NVL(REPLACE(CIR_GET_EDTN_NAME(A.COMPCODE,A.EDITION_CODE,'1'),CHR(28),' '),'') edtn_name,
    A.GATE_PASS_NO                                                                gate_pass_no,
    NVL(TO_CHAR(A.SUPPLY_DATE,'YYYY-MM-DD'),'')                                   supply_date,
    NVL(TO_CHAR(A.CREATION_DATE,'YYYY-MM-DD HH24:MI:SS'),'')                      creation_date,
    NVL(A.SUP_COPIES,0)                                                           sup_copies,
    NVL(A.COPY_RATE,0)                                                            copy_rate,
    NVL(A.COPY_AMOUNT,0)                                                          copy_amount,
    NVL(A.NET_AMOUNT,0)                                                           net_amount,
    A.BILL_NO                                                                     bill_no,
    NVL(TO_CHAR(A.BILL_DT,'YYYY-MM-DD'),'')                                       bill_dt
  FROM CRM_HAWKER_DATEWISE_SUPPLY A, CRM_HAWKER_MASTER B
  WHERE A.HAWKER_ID = B.HAWKER_ID
    AND A.SUPPLY_DATE BETWEEN TO_DATE('${fromDate}','YYYY-MM-DD')
                          AND TO_DATE('${toDate}','YYYY-MM-DD')
) x;
SPOOL OFF
EXIT
`;
}

// ── sqlplus runner — credentials via stdin ONLY ───────────────────────────────
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
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
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

// ── Field coercers ────────────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}

function num(v) {
  const n = parseFloat(String(v).trim().replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function dateVal(v) {
  const t = str(v);
  if (!t) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.substring(0, 10) : null;
}

function dtVal(v) {
  const t = str(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t)) return t.substring(0, 19);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.substring(0, 10);
  return null;
}

// Maps a 23-field parsed line to MySQL INSERT params (order matches COL_LIST)
function lineToParams(f) {
  return [
    str(f[0]),       //  0 loc_id
    str(f[1]),       //  1 unit_name
    str(f[2]),       //  2 hwk_cent_code
    str(f[3]),       //  3 hawker_center
    str(f[4]),       //  4 hawker_id
    str(f[5]),       //  5 hawker_name
    str(f[6]),       //  6 center_incharge
    str(f[7]),       //  7 center_incharge_name
    str(f[8]),       //  8 field_officer
    str(f[9]),       //  9 field_officer_name
    str(f[10]),      // 10 publ_code
    str(f[11]),      // 11 pub_name
    str(f[12]),      // 12 edition_code
    str(f[13]),      // 13 edtn_name
    str(f[14]),      // 14 gate_pass_no
    dateVal(f[15]),  // 15 supply_date
    dtVal(f[16]),    // 16 creation_date
    num(f[17]),      // 17 sup_copies
    num(f[18]),      // 18 copy_rate
    num(f[19]),      // 19 copy_amount
    num(f[20]),      // 20 net_amount
    str(f[21]),      // 21 bill_no
    dateVal(f[22]),  // 22 bill_dt
  ];
}

const COL_LIST = `loc_id, unit_name, hwk_cent_code, hawker_center,
     hawker_id, hawker_name, center_incharge, center_incharge_name,
     field_officer, field_officer_name,
     publ_code, pub_name, edition_code, edtn_name,
     gate_pass_no, supply_date, creation_date,
     sup_copies, copy_rate, copy_amount, net_amount,
     bill_no, bill_dt`;

// ── MySQL schema ──────────────────────────────────────────────────────────────
async function ensureSchema(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS hawker_supply (
    id                   BIGINT        AUTO_INCREMENT PRIMARY KEY,
    loc_id               VARCHAR(10)   NOT NULL,
    unit_name            VARCHAR(200),
    hwk_cent_code        VARCHAR(20),
    hawker_center        VARCHAR(200),
    hawker_id            VARCHAR(20)   NOT NULL,
    hawker_name          VARCHAR(300),
    center_incharge      VARCHAR(20),
    center_incharge_name VARCHAR(200),
    field_officer        VARCHAR(20),
    field_officer_name   VARCHAR(200),
    publ_code            VARCHAR(10)   NOT NULL,
    pub_name             VARCHAR(200),
    edition_code         VARCHAR(10)   NOT NULL,
    edtn_name            VARCHAR(200),
    gate_pass_no         VARCHAR(30),
    supply_date          DATE          NOT NULL,
    creation_date        DATETIME,
    sup_copies           INT           DEFAULT 0,
    copy_rate            DECIMAL(12,4) DEFAULT 0,
    copy_amount          DECIMAL(14,2) DEFAULT 0,
    net_amount           DECIMAL(14,2) DEFAULT 0,
    bill_no              VARCHAR(30),
    bill_dt              DATE,
    synced_at            DATETIME      DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_hwk (hawker_id, supply_date, publ_code, edition_code),
    INDEX idx_hs_date    (supply_date),
    INDEX idx_hs_unit    (loc_id, supply_date),
    INDEX idx_hs_hawker  (hawker_id, supply_date),
    INDEX idx_hs_center  (hwk_cent_code, supply_date)
  ) CHARACTER SET utf8mb4`);

  await conn.execute(`CREATE TABLE IF NOT EXISTS hawker_supply_sync_log (
    from_date    DATE     NOT NULL,
    to_date      DATE     NOT NULL,
    rows_loaded  INT      DEFAULT 0,
    completed_at DATETIME NOT NULL,
    PRIMARY KEY  (from_date, to_date)
  )`);
}

// ── Oracle → spool → parsed rows ─────────────────────────────────────────────
async function oracleQuery(fromDate, toDate) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-hwk-'));
  const sqlFile   = path.join(tmpDir, 'q.sql');
  const spoolFile = path.join(tmpDir, 'data.txt');

  fs.writeFileSync(sqlFile, buildSqlScript(spoolFile, fromDate, toDate), 'utf8');
  const t0 = Date.now();
  await runSqlplus(sqlFile);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!fs.existsSync(spoolFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('No spool file produced — sqlplus may have errored');
  }

  const raw    = fs.readFileSync(spoolFile, 'utf8');
  const parsed = [], bad = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes(SEP)) continue;
    const f = line.split(SEP);
    if (f.length === NCOLS) parsed.push(f);
    else bad.push(line);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { parsed, bad, elapsed };
}

// ── Bulk INSERT IGNORE (idempotent — safe for historical backfills) ────────────
async function bulkInsert(conn, parsed, label) {
  if (!parsed.length) return 0;
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const values = parsed.slice(i, i + BATCH).map(lineToParams);
    await conn.query(
      `INSERT IGNORE INTO hawker_supply (${COL_LIST}) VALUES ?`,
      [values]
    );
    total += values.length;
    process.stdout.write(`\r  ${label} ${total}/${parsed.length}...`);
  }
  console.log('');
  return total;
}

// ── Load one date-range chunk (resumable via sync log) ────────────────────────
async function loadChunk(conn, fromDate, toDate, { skipIfDone = true } = {}) {
  if (skipIfDone) {
    const [[row]] = await conn.query(
      'SELECT completed_at FROM hawker_supply_sync_log WHERE from_date=? AND to_date=?',
      [fromDate, toDate]
    );
    if (row) {
      log(`  SKIP ${fromDate}→${toDate} (done at ${row.completed_at.toISOString().slice(0,19)})`);
      return 0;
    }
  }

  log(`  Loading ${fromDate} → ${toDate}...`);
  const { parsed, bad, elapsed } = await oracleQuery(fromDate, toDate);
  if (bad.length) log(`  WARNING: ${bad.length} malformed lines (wrong field count)`);
  log(`  Oracle: ${parsed.length} rows in ${elapsed}s`);

  if (!parsed.length) {
    // 0 rows may be an Oracle hiccup — do not mark done so the next run retries
    log(`  WARNING: 0 rows — not marking complete, will retry on next run`);
    return 0;
  }

  const t1 = Date.now();
  const inserted = await bulkInsert(conn, parsed, 'Inserted');
  log(`  MySQL: ${inserted} rows in ${((Date.now()-t1)/1000).toFixed(1)}s`);

  await conn.execute(
    `INSERT INTO hawker_supply_sync_log (from_date,to_date,rows_loaded,completed_at)
     VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE rows_loaded=?,completed_at=NOW()`,
    [fromDate, toDate, inserted, inserted]
  );
  return inserted;
}

// ── Daily sync — DELETE + re-INSERT to pick up corrections ───────────────────
async function dailySync(conn, dateStr) {
  log(`Daily sync for ${dateStr}`);
  const { parsed, bad, elapsed } = await oracleQuery(dateStr, dateStr);
  if (bad.length) log(`WARNING: ${bad.length} malformed lines skipped`);
  log(`Oracle: ${parsed.length} rows in ${elapsed}s`);

  if (!parsed.length) {
    log('No hawker supply data for this date — nothing inserted');
    return;
  }

  const [del] = await conn.execute(
    'DELETE FROM hawker_supply WHERE supply_date = ?', [dateStr]
  );
  if (del.affectedRows > 0) log(`Deleted ${del.affectedRows} existing rows for ${dateStr}`);

  const t1 = Date.now();
  const inserted = await bulkInsert(conn, parsed, 'Inserted');
  log(`Inserted ${inserted} rows in ${((Date.now()-t1)/1000).toFixed(1)}s`);
}

// ── From-last sync — detect max date, sync forward in monthly chunks ──────────
async function fromLastSync(conn) {
  const [[maxRow]] = await conn.query(
    'SELECT MAX(supply_date) AS maxd FROM hawker_supply'
  );
  const maxDate  = maxRow?.maxd ? fmtDate(new Date(maxRow.maxd)) : COVID_BASE;
  const fromDate = addDays(maxDate, 1);
  const toDate   = yesterday();

  if (fromDate > toDate) {
    log(`Already up to date (max supply_date = ${maxDate})`);
    return;
  }

  log(`Auto-detected: last supply_date = ${maxDate}. Syncing from ${fromDate}`);
  const chunks = monthlyChunks(fromDate, toDate);
  log(`${chunks.length} monthly chunk(s): ${fromDate} → ${toDate}`);

  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { from, to } = chunks[i];
    log(`[${i+1}/${chunks.length}] Chunk ${from} → ${to}`);
    try {
      total += await loadChunk(conn, from, to);
    } catch (err) {
      log(`  ERROR in chunk ${from}→${to}: ${err.message} — skipping`);
    }
  }
  log(`From-last sync complete. Total: ${total} rows`);
}

// ── Historical / custom-range sync ───────────────────────────────────────────
async function rangeSync(conn, fromStr, toStr) {
  const chunks = monthlyChunks(fromStr, toStr);
  if (REVERSE) chunks.reverse();  // newest month first
  log(`${chunks.length} monthly chunks: ${fromStr} → ${toStr}${REVERSE ? ' (REVERSE: newest first)' : ''}`);

  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { from, to } = chunks[i];
    log(`[${i+1}/${chunks.length}] Chunk ${from} → ${to}`);
    try {
      total += await loadChunk(conn, from, to);
    } catch (err) {
      log(`  ERROR in chunk ${from}→${to}: ${err.message} — skipping, will retry next run`);
    }
  }
  return total;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Hawker supply sync started ===');

  for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
    if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exit(1); }
  }
  if (!fs.existsSync(SQLPLUS)) {
    log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exit(1);
  }

  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    await ensureSchema(conn);

    if (HISTORICAL) {
      log('=== HISTORICAL MODE ===');

      // 1 — Single-day COVID reference
      log(`--- COVID reference: ${COVID_BASE} ---`);
      await loadChunk(conn, COVID_BASE, COVID_BASE);

      // 2 — Last 5 years: 2021-01-01 → today (monthly chunks)
      const recentFrom = ARG_FROM || '2021-01-01';
      const recentTo   = ARG_TO   || yesterday();
      log(`--- Recent period: ${recentFrom} → ${recentTo} ---`);
      const total = await rangeSync(conn, recentFrom, recentTo);
      log(`Historical load complete. Total rows this run: ${total}`);

    } else if (FROM_LAST) {
      await fromLastSync(conn);

    } else if (ARG_FROM) {
      const toStr = ARG_TO || yesterday();
      log(`Custom range: ${ARG_FROM} → ${toStr}`);
      const total = await rangeSync(conn, ARG_FROM, toStr);
      log(`Custom range complete. Total: ${total} rows`);

    } else {
      const dateStr = ARG_DATE || yesterday();
      await dailySync(conn, dateStr);
    }

    log('=== Hawker supply sync complete ===');
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
