'use strict';

/**
 * supply_sync.js — Oracle cir_dbksup → MySQL supply_data
 *
 * Modes:
 *   node supply_sync.js                          # daily: load yesterday's supply
 *   node supply_sync.js --date 2026-08-05        # specific single date
 *   node supply_sync.js --historical             # one-time: 2020-03-18 + 2021-01-01→today (monthly)
 *   node supply_sync.js --from 2021-01-01 --to 2021-06-30  # custom range (monthly chunks)
 *
 * Historical load breakdown:
 *   2020-03-18         → pre-COVID reference baseline (~305K rows, 1 Oracle query)
 *   2021-01-01 → today → last 5 years, loaded 1 month at a time (~3M rows/year)
 *
 * Resumable: supply_sync_log tracks completed chunks; re-running skips them.
 *
 * Security: Oracle credentials passed via sqlplus stdin ONLY.
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const HISTORICAL = args.includes('--historical');
const REVERSE    = args.includes('--reverse');  // process monthly chunks newest → oldest
const ARG_DATE   = args.find((_, i) => args[i - 1] === '--date');
const ARG_FROM   = args.find((_, i) => args[i - 1] === '--from');
const ARG_TO     = args.find((_, i) => args[i - 1] === '--to');

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/supply_sync.log');
const SEP = '\x1c';
const D   = 'CHR(28)';
const NCOLS = 28;

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

// Add one month to a YYYY-MM-DD string
function addMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return fmtDate(d);
}

// Generate monthly chunks: [{from, to}, ...] where to is exclusive
function monthlyChunks(fromStr, toStr) {
  const chunks = [];
  let cur = fromStr;
  while (cur < toStr) {
    const next = addMonth(cur) < toStr ? addMonth(cur) : toStr;
    chunks.push({ from: cur, to: next <= toStr ? next : toStr });
    cur = next;
    if (cur >= toStr) break;
  }
  return chunks;
}

// ── Oracle SQL builder ────────────────────────────────────────────────────────
// 28 fields, each on its own line (sqlplus 2499-char line limit)
function buildSqlScript(spoolFile, fromDate, toDate) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');
  const S = f =>
    `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

  const cols = [
    S('x.comp_code'),                       //  0
    S('x.unit_code'),                       //  1
    S('x.unit_name'),                       //  2
    S('x.publ'),                            //  3
    S('x.publ_name'),                       //  4
    S('x.edtn'),                            //  5
    S('x.edtn_name'),                       //  6
    S('x.sup_type_code'),                   //  7
    S('x.supply_type_name'),                //  8
    S('x.agcd'),                            //  9
    S('x.dpcd'),                            // 10
    S('x.ag_name'),                         // 11
    S('x.city_code'),                       // 12
    S('x.city_name'),                       // 13
    S('x.dist_code'),                       // 14
    S('x.dist_name'),                       // 15
    S('x.state_code'),                      // 16
    S('x.state_name'),                      // 17
    `NVL(TO_CHAR(x.supdate,'YYYY-MM-DD'),'')`, // 18  supply_date
    `NVL(TO_CHAR(x.sup_copy),'0')`,         // 19  sup_copy
    `NVL(TO_CHAR(x.sup_rate),'0')`,         // 20  sup_rate
    S('x.comm_fix_auto_spl'),               // 21
    S('x.comm_code'),                       // 22
    S('SUBSTR(x.comm_rate,1,1)'),           // 23  comm_type
    S('SUBSTR(x.comm_rate,2,10)'),          // 24  comm_rate (numeric part)
    S('x.route_code'),                      // 25
    S('x.subroute_code'),                   // 26
    S('x.subsubroute_code'),                // 27
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
  select d.comp_code, d.unit_code,
    get_unit_name(d.comp_code, d.unit_code) unit_name,
    d.publ, p.publ_name, d.edtn, e.edtn_name,
    d.sup_type_code,
    (select SUP_TY_NAME from cir_supply_type_mast
     where comp_code=d.comp_code and SUP_TY_CODE=d.sup_type_code) supply_type_name,
    d.agcd, d.dpcd, m.ag_name, m.city_code,
    (select city_name from cir_city_mast
     where comp_code=d.comp_code and city_code=m.city_code) city_name,
    m.dist_code,
    (select dist_name from cir_dist_mast
     where comp_code=d.comp_code and dist_code=m.dist_code) dist_name,
    m.state_code,
    (select "State_Name" from state_mst
     where "Comp_Code"=d.comp_code and "State_Code"=m.state_code) state_name,
    d.supdate, d.sup_copy, d.sup_rate,
    d.comm_fix_auto_spl, d.comm_code,
    CIR_GET_COMMISSION(d.comp_code,d.unit_code,d.publ,d.edtn,
      d.comm_fix_auto_spl,d.comm_code,
      TO_CHAR(d.supdate,'DD/MM/YYYY'),'DD/MM/YYYY',0,null,null) comm_rate,
    d.route_code, d.subroute_code, d.subsubroute_code
  from cir_dbksup d, cir_agmast m, cir_publ_mast p, cir_edtn_mast e
  where d.comp_code = m.comp_code
    and d.comp_code = p.comp_code
    and d.comp_code = e.comp_code
    and d.unit_code = m.unit
    and d.publ = p.publ
    and d.edtn = e.edtn
    and d.agcd = m.agcd
    and d.dpcd = m.dpcd
    and d.comp_code = 'RP001'
    and d.supdate >= TO_DATE('${fromDate}','YYYY-MM-DD')
    and d.supdate <  TO_DATE('${toDate}','YYYY-MM-DD')
    and NVL(d.sup_copy,0) > 0
) x;
SPOOL OFF
EXIT
`;
}

// ── sqlplus runner ────────────────────────────────────────────────────────────
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

// ── Field mapping ─────────────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}
function num(v) {
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? 0 : n;
}
function dateVal(v) {
  const t = str(v);
  if (!t) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function lineToParams(f) {
  return [
    str(f[0]),    // comp_code
    str(f[1]),    // unit_code
    str(f[2]),    // unit_name
    str(f[3]),    // publ
    str(f[4]),    // publ_name
    str(f[5]),    // edtn
    str(f[6]),    // edtn_name
    str(f[7]),    // sup_type_code
    str(f[8]),    // supply_type_name
    str(f[9]),    // agcd
    str(f[10]),   // dpcd
    str(f[11]),   // ag_name
    str(f[12]),   // city_code
    str(f[13]),   // city_name
    str(f[14]),   // dist_code
    str(f[15]),   // dist_name
    str(f[16]),   // state_code
    str(f[17]),   // state_name
    dateVal(f[18]), // supply_date
    num(f[19]),   // sup_copy
    num(f[20]),   // sup_rate
    str(f[21]),   // comm_fix_auto_spl
    str(f[22]),   // comm_code
    str(f[23]),   // comm_type
    str(f[24]),   // comm_rate
    str(f[25]),   // route_code
    str(f[26]),   // subroute_code
    str(f[27]),   // subsubroute_code
  ];
}

const COL_LIST = `comp_code, unit_code, unit_name, publ, publ_name, edtn, edtn_name,
     sup_type_code, supply_type_name, agcd, dpcd, ag_name,
     city_code, city_name, dist_code, dist_name, state_code, state_name,
     supply_date, sup_copy, sup_rate,
     comm_fix_auto_spl, comm_code, comm_type, comm_rate,
     route_code, subroute_code, subsubroute_code`;

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS supply_data (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    comp_code         VARCHAR(10),
    unit_code         VARCHAR(20)   NOT NULL,
    unit_name         VARCHAR(200),
    publ              VARCHAR(10)   NOT NULL,
    publ_name         VARCHAR(200),
    edtn              VARCHAR(10)   NOT NULL,
    edtn_name         VARCHAR(200),
    sup_type_code     VARCHAR(10)   NOT NULL,
    supply_type_name  VARCHAR(200),
    agcd              VARCHAR(20)   NOT NULL,
    dpcd              VARCHAR(20)   NOT NULL,
    ag_name           VARCHAR(300),
    city_code         VARCHAR(20),
    city_name         VARCHAR(200),
    dist_code         VARCHAR(20),
    dist_name         VARCHAR(200),
    state_code        VARCHAR(20),
    state_name        VARCHAR(200),
    supply_date       DATE          NOT NULL,
    sup_copy          INT           DEFAULT 0,
    sup_rate          DECIMAL(12,4) DEFAULT 0,
    comm_fix_auto_spl VARCHAR(5),
    comm_code         VARCHAR(20),
    comm_type         CHAR(1),
    comm_rate         VARCHAR(20),
    route_code        VARCHAR(20),
    subroute_code     VARCHAR(20),
    subsubroute_code  VARCHAR(20),
    synced_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_supply (unit_code, publ, edtn, agcd, dpcd, sup_type_code, supply_date),
    INDEX idx_sd_date      (supply_date),
    INDEX idx_sd_unit      (unit_code, supply_date),
    INDEX idx_sd_dateunit  (supply_date, unit_code),
    INDEX idx_sd_state     (state_code, supply_date),
    INDEX idx_sd_statename (state_name, unit_code),
    INDEX idx_sd_agcd      (agcd)
  ) CHARACTER SET utf8mb4`);

  // Sync-log for historical chunks
  await conn.execute(`CREATE TABLE IF NOT EXISTS supply_sync_log (
    from_date    DATE     NOT NULL,
    to_date      DATE     NOT NULL,
    rows_loaded  INT      DEFAULT 0,
    completed_at DATETIME NOT NULL,
    PRIMARY KEY  (from_date, to_date)
  )`);
}

// ── Oracle → spool → parsed rows ─────────────────────────────────────────────
async function oracleQuery(fromDate, toDate) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-sup-'));
  const sqlFile   = path.join(tmpDir, 'q.sql');
  const spoolFile = path.join(tmpDir, 'data.txt');

  fs.writeFileSync(sqlFile, buildSqlScript(spoolFile, fromDate, toDate), 'utf8');
  const t0 = Date.now();
  await runSqlplus(sqlFile);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!fs.existsSync(spoolFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('No spool file produced');
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

// ── Bulk INSERT IGNORE (idempotent, used for all modes) ───────────────────────
async function bulkInsert(conn, parsed, label) {
  if (!parsed.length) return 0;

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk  = parsed.slice(i, i + BATCH);
    const values = chunk.map(lineToParams);
    await conn.query(
      `INSERT IGNORE INTO supply_data (${COL_LIST}) VALUES ?`,
      [values]
    );
    inserted += chunk.length;
    process.stdout.write(`\r  ${label} ${inserted}/${parsed.length}...`);
  }
  console.log('');
  return inserted;
}

// ── Load a single date range chunk ────────────────────────────────────────────
async function loadChunk(conn, fromDate, toDate, { skipIfDone = true } = {}) {
  if (skipIfDone) {
    const [[row]] = await conn.query(
      'SELECT completed_at FROM supply_sync_log WHERE from_date=? AND to_date=?',
      [fromDate, toDate]
    );
    if (row) {
      log(`  SKIP ${fromDate}→${toDate} (done at ${row.completed_at.toISOString().slice(0,19)})`);
      return 0;
    }
  }

  log(`  Loading ${fromDate} → ${toDate}...`);
  const { parsed, bad, elapsed } = await oracleQuery(fromDate, toDate);
  if (bad.length) log(`  WARNING: ${bad.length} malformed lines skipped`);
  log(`  Oracle: ${parsed.length} rows in ${elapsed}s`);

  if (!parsed.length) {
    // 0 rows for a historical month is almost certainly an Oracle hiccup —
    // do NOT mark done, so the next run retries this chunk.
    log(`  WARNING: 0 rows for ${fromDate}→${toDate} — not marking complete, will retry next run`);
    return 0;
  }

  const t1 = Date.now();
  const inserted = await bulkInsert(conn, parsed, `Inserted`);
  log(`  MySQL: ${inserted} rows in ${((Date.now()-t1)/1000).toFixed(1)}s`);

  await conn.execute(
    `INSERT INTO supply_sync_log (from_date,to_date,rows_loaded,completed_at)
     VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE rows_loaded=?,completed_at=NOW()`,
    [fromDate, toDate, inserted, inserted]
  );
  return inserted;
}

// ── Daily sync ────────────────────────────────────────────────────────────────
async function dailySync(conn, dateStr) {
  const d2 = new Date(dateStr + 'T00:00:00Z');
  d2.setUTCDate(d2.getUTCDate() + 1);
  const exclusiveEnd = fmtDate(d2);

  log(`Daily sync for ${dateStr}`);
  const { parsed, bad, elapsed } = await oracleQuery(dateStr, exclusiveEnd);
  if (bad.length) log(`WARNING: ${bad.length} malformed lines skipped`);
  log(`Oracle: ${parsed.length} rows in ${elapsed}s`);

  if (!parsed.length) {
    log('No supply data for this date — nothing inserted');
    return;
  }

  // DELETE existing for this date, then re-INSERT (handles corrections)
  const [del] = await conn.execute(
    'DELETE FROM supply_data WHERE supply_date = ?', [dateStr]
  );
  if (del.affectedRows > 0) log(`Deleted ${del.affectedRows} existing rows for ${dateStr}`);

  const t1 = Date.now();
  const inserted = await bulkInsert(conn, parsed, 'Inserted');
  log(`Inserted ${inserted} rows in ${((Date.now()-t1)/1000).toFixed(1)}s`);
}

// ── Historical sync ───────────────────────────────────────────────────────────
async function historicalSync(conn, fromStr, toStr) {
  const chunks = monthlyChunks(fromStr, toStr);
  if (REVERSE) chunks.reverse();  // newest month first
  log(`Historical: ${chunks.length} monthly chunks from ${fromStr} to ${toStr}${REVERSE ? ' (REVERSE: newest first)' : ''}`);

  let totalInserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { from, to } = chunks[i];
    log(`[${i+1}/${chunks.length}] Chunk ${from} → ${to}`);
    try {
      totalInserted += await loadChunk(conn, from, to);
    } catch (err) {
      log(`  ERROR in chunk ${from}→${to}: ${err.message} — skipping, will retry on next run`);
    }
  }
  return totalInserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Supply sync started ===');

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

      // 1 — Pre-COVID reference: 18 March 2020 only
      const COVID_DATE     = '2020-03-18';
      const COVID_DATE_END = '2020-03-19';  // exclusive
      log(`--- Pre-COVID reference: ${COVID_DATE} ---`);
      await loadChunk(conn, COVID_DATE, COVID_DATE_END);

      // 2 — Last 5 years: 2021-01-01 → today
      const recentFrom = ARG_FROM || '2021-01-01';
      const recentTo   = ARG_TO   || fmtDate(new Date());
      log(`--- Recent period: ${recentFrom} → ${recentTo} ---`);
      const total = await historicalSync(conn, recentFrom, recentTo);
      log(`Historical load complete. Total rows this run: ${total}`);

    } else if (ARG_FROM && ARG_TO) {
      // Custom range (monthly chunks)
      log(`Custom range: ${ARG_FROM} → ${ARG_TO}`);
      const total = await historicalSync(conn, ARG_FROM, ARG_TO);
      log(`Custom range complete. Total: ${total} rows`);

    } else {
      // Daily mode
      const dateStr = ARG_DATE || yesterday();
      await dailySync(conn, dateStr);
    }

    log('=== Supply sync complete ===');
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
