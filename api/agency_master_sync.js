'use strict';

/**
 * agency_master_sync.js — Oracle CIR_AGMAST → MySQL agency_master
 *
 * Modes:
 *   node agency_master_sync.js           # incremental: only UPDATED_DT >= last sync date
 *   node agency_master_sync.js --full    # full: TRUNCATE + bulk INSERT (use weekly)
 *
 * Daily 06:30  → incremental  (typically <300 rows, completes in seconds)
 * Weekly Sun 02:00 → --full   (catches deletions, ~5–6 min)
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

const FULL_MODE = process.argv.includes('--full');

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/agency_master_sync.log');

const SEP = '\x1c';   // ASCII-28 — field separator, never appears in data
const D   = 'CHR(28)';

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}

function dateVal(v) {
  const t = str(v);
  if (!t) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

// Format Date → 'YYYY-MM-DD' for Oracle queries
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Oracle SQL builder ────────────────────────────────────────────────────────
// 38 fields separated by CHR(28). Order MUST match lineToParams() below.
// Each field on its own line — sqlplus silently ignores lines > 2499 chars.
function buildSqlScript(spoolFile, { sinceDate } = {}) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');
  const S = f =>
    `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

  const cols = [
    S('x.comp_code'),
    S('x.unit_state_nm'),
    S('x.unit'),
    S('x.unit_name'),
    S('x.executive_code'),
    S('x.executive_name'),
    S('x.ag_type'),
    S('x.ag_type_name'),
    S('x.ag_class'),
    S('x.ag_class_name'),
    S('x.agcd'),
    S('x.dpcd'),
    S('x.ag_name'),
    S('x.Address'),
    S('x.city_code'),
    S('x.city_name'),
    S('x.dist_code'),
    S('x.dist_name'),
    S('x.state_code'),
    S('x.state_name'),
    S('x.station_code'),
    S('x.area_code'),
    S('x.mobile_no1'),
    S('x.pan_no'),
    S('x.adhar_no'),
    `NVL(TO_CHAR(x.supply_start_dt,'YYYY-MM-DD'),'')`,
    S('x.EMAIL_ID'),
    S('x.FIELD_OFFICER'),
    S('x.FIELD_OFFICER_Name'),
    S('x.HO_COORDINATOR'),
    S('x.HO_COORDINATOR_Name'),
    `NVL(TO_CHAR(x.SUSPEND_DATE,'YYYY-MM-DD'),'')`,
    S('x.SUSPEND_TYPE'),
    S('x.SUPPLY_STOP_FLAG'),
    S('x.IS_CORROSPONDENT'),
    S('x.ISCENTER'),
    S('x.NEW_REPLACE_AGENCY'),
    S('x.AGENT_NAME'),
  ].join(`\n  || ${D} ||\n  `);

  // Incremental adds a date filter on UPDATED_DT (day-level granularity in Oracle)
  const whereExtra = sinceDate
    ? `\n  AND (m.UPDATED_DT >= TO_DATE('${sinceDate}','YYYY-MM-DD') OR m.CREATION_DATE >= TO_DATE('${sinceDate}','YYYY-MM-DD'))`
    : '';

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
  select m.comp_code,
    CASE WHEN get_unit_group_name(m.comp_code,m.unit,NULL,NULL,NULL) = 'RPPL' THEN 'RAJASTHAN'
         ELSE get_unit_group_name(m.comp_code,m.unit,NULL,NULL,NULL)
    END unit_state_nm,
    m.unit, get_unit_name(m.comp_code,m.unit) unit_name,
    m.executive_code,
    (select EXECUTIVE_DESC from cir_executive_mast
     where comp_code=m.comp_code and EXECUTIVE_CODE=m.executive_code) executive_name,
    m.AG_TYPE,
    (select AGENCY_TYPE_DESC from cir_agency_typ_mast
     where comp_code=m.comp_code and AGENCY_TYPE_CODE=m.AG_TYPE) ag_type_name,
    m.AG_class,
    (select CLASS_DESC from cir_agency_class_mast
     where comp_code=m.comp_code and CLASS_CODE=m.AG_class) ag_class_name,
    m.agcd, m.dpcd, m.ag_name,
    (m.ADDR1||m.ADDR2||m.ADDR3) as Address,
    m.city_code,
    (select city_name from cir_city_mast
     where comp_code=m.comp_code and city_code=m.city_code) city_name,
    m.dist_code,
    (select dist_name from cir_dist_mast
     where comp_code=m.comp_code and dist_code=m.dist_code) dist_name,
    m.state_code,
    (select "State_Name" from state_mst
     where "Comp_Code"=m.comp_code and "State_Code"=m.state_code) state_name,
    m.STATION_CODE, m.AREA_CODE,
    m.MOBILE_NO1, m.PAN_NO, m.ADHAR_NO, m.SUPPLY_START_DT,
    m.EMAIL_ID, m.FIELD_OFFICER,
    (select EXECUTIVE_DESC from cir_executive_mast
     where comp_code=m.comp_code and EXECUTIVE_CODE=m.FIELD_OFFICER) FIELD_OFFICER_Name,
    m.HO_COORDINATOR,
    (select EXECUTIVE_DESC from cir_executive_mast
     where comp_code=m.comp_code and EXECUTIVE_CODE=m.HO_COORDINATOR) HO_COORDINATOR_Name,
    m.SUSPEND_DATE, m.SUSPEND_TYPE, m.SUPPLY_STOP_FLAG,
    m.IS_CORROSPONDENT, m.ISCENTER, m.NEW_REPLACE_AGENCY, m.AGENT_NAME
  from cir_agmast m
  where m.comp_code = 'RP001'${whereExtra}
) x
ORDER BY x.unit, x.agcd;
SPOOL OFF
EXIT
`;
}

// ── sqlplus runner ────────────────────────────────────────────────────────────
const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  // node-oracledb driver (server, no sqlplus binary) — else spawn sqlplus
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

// ── Field mapping ─────────────────────────────────────────────────────────────
function lineToParams(f) {
  return [
    str(f[0]),  str(f[1]),  str(f[2]),  str(f[3]),
    str(f[4]),  str(f[5]),  str(f[6]),  str(f[7]),
    str(f[8]),  str(f[9]),  str(f[10]), str(f[11]),
    str(f[12]), str(f[13]), str(f[14]), str(f[15]),
    str(f[16]), str(f[17]), str(f[18]), str(f[19]),
    str(f[20]), str(f[21]), str(f[22]), str(f[23]),
    str(f[24]), dateVal(f[25]),
    str(f[26]), str(f[27]), str(f[28]), str(f[29]),
    str(f[30]), dateVal(f[31]),
    str(f[32]), str(f[33]), str(f[34]), str(f[35]),
    str(f[36]), str(f[37]),
  ];
}

const COL_LIST = `comp_code, unit_state_nm, unit, unit_name, executive_code, executive_name,
     ag_type, ag_type_name, ag_class, ag_class_name,
     agcd, dpcd, ag_name, address,
     city_code, city_name, dist_code, dist_name, state_code, state_name,
     station_code, area_code, mobile_no1, pan_no, adhar_no,
     supply_start_dt, email_id, field_officer, field_officer_name,
     ho_coordinator, ho_coordinator_name,
     suspend_date, suspend_type, supply_stop_flag,
     is_corrospondent, iscenter, new_replace_agency, agent_name`;

// For incremental UPSERT — update every non-key column on duplicate
const UPDATE_CLAUSE = `
     comp_code=VALUES(comp_code), unit_state_nm=VALUES(unit_state_nm),
     unit_name=VALUES(unit_name), executive_code=VALUES(executive_code),
     executive_name=VALUES(executive_name), ag_type=VALUES(ag_type),
     ag_type_name=VALUES(ag_type_name), ag_class=VALUES(ag_class),
     ag_class_name=VALUES(ag_class_name), ag_name=VALUES(ag_name),
     address=VALUES(address), city_code=VALUES(city_code), city_name=VALUES(city_name),
     dist_code=VALUES(dist_code), dist_name=VALUES(dist_name),
     state_code=VALUES(state_code), state_name=VALUES(state_name),
     station_code=VALUES(station_code), area_code=VALUES(area_code),
     mobile_no1=VALUES(mobile_no1), pan_no=VALUES(pan_no), adhar_no=VALUES(adhar_no),
     supply_start_dt=VALUES(supply_start_dt), email_id=VALUES(email_id),
     field_officer=VALUES(field_officer), field_officer_name=VALUES(field_officer_name),
     ho_coordinator=VALUES(ho_coordinator), ho_coordinator_name=VALUES(ho_coordinator_name),
     suspend_date=VALUES(suspend_date), suspend_type=VALUES(suspend_type),
     supply_stop_flag=VALUES(supply_stop_flag), is_corrospondent=VALUES(is_corrospondent),
     iscenter=VALUES(iscenter), new_replace_agency=VALUES(new_replace_agency),
     agent_name=VALUES(agent_name), synced_at=NOW()`;

// ── Schema setup ──────────────────────────────────────────────────────────────
async function ensureSchema(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS agency_master (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    comp_code           VARCHAR(10),
    unit_state_nm       VARCHAR(100),
    unit                VARCHAR(20),
    unit_name           VARCHAR(200),
    executive_code      VARCHAR(20),
    executive_name      VARCHAR(200),
    ag_type             VARCHAR(10),
    ag_type_name        VARCHAR(200),
    ag_class            VARCHAR(10),
    ag_class_name       VARCHAR(200),
    agcd                VARCHAR(20),
    dpcd                VARCHAR(20),
    ag_name             VARCHAR(300),
    address             TEXT,
    city_code           VARCHAR(20),
    city_name           VARCHAR(200),
    dist_code           VARCHAR(20),
    dist_name           VARCHAR(200),
    state_code          VARCHAR(20),
    state_name          VARCHAR(200),
    station_code        VARCHAR(20),
    area_code           VARCHAR(20),
    mobile_no1          VARCHAR(20),
    pan_no              VARCHAR(20),
    adhar_no            VARCHAR(20),
    supply_start_dt     DATE,
    email_id            VARCHAR(200),
    field_officer       VARCHAR(20),
    field_officer_name  VARCHAR(200),
    ho_coordinator      VARCHAR(20),
    ho_coordinator_name VARCHAR(200),
    suspend_date        DATE,
    suspend_type        VARCHAR(20),
    supply_stop_flag    VARCHAR(5),
    is_corrospondent    VARCHAR(5),
    iscenter            VARCHAR(5),
    new_replace_agency  VARCHAR(20),
    agent_name          VARCHAR(300),
    synced_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_am_agcd  (agcd),
    INDEX idx_am_dpcd  (dpcd),
    INDEX idx_am_unit  (unit),
    INDEX idx_am_state (state_code),
    INDEX idx_am_exec  (executive_code)
  ) CHARACTER SET utf8mb4`);

  // Add unique key for UPSERT (idempotent — skip if already present)
  const [[ukRow]] = await conn.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agency_master'
      AND INDEX_NAME = 'uq_am_natural'`);
  if (Number(ukRow.cnt) === 0) {
    log('Adding unique key uq_am_natural (unit, agcd, dpcd)...');
    // Deduplicate existing rows first (keep lowest id per natural key)
    await conn.execute(`
      DELETE a FROM agency_master a
      INNER JOIN agency_master b
        ON a.unit = b.unit AND a.agcd = b.agcd AND a.dpcd = b.dpcd AND a.id > b.id`);
    await conn.execute(
      'ALTER TABLE agency_master ADD UNIQUE KEY uq_am_natural (unit, agcd, dpcd)'
    );
    log('Unique key added.');
  }

  await conn.execute(`CREATE TABLE IF NOT EXISTS sync_state (
    name       VARCHAR(50) PRIMARY KEY,
    sync_dt    DATE        NOT NULL,
    synced_at  DATETIME    NOT NULL
  )`);
}

// ── Get last successful sync date from MySQL ──────────────────────────────────
async function getLastSyncDate(conn) {
  const [[row]] = await conn.query(
    "SELECT sync_dt FROM sync_state WHERE name = 'agency_master'"
  );
  return row ? row.sync_dt : null;   // null → first incremental run
}

async function setLastSyncDate(conn, dt) {
  await conn.execute(
    `INSERT INTO sync_state (name, sync_dt, synced_at) VALUES ('agency_master', ?, NOW())
     ON DUPLICATE KEY UPDATE sync_dt = VALUES(sync_dt), synced_at = NOW()`,
    [dt]
  );
}

// ── Parse spool output ────────────────────────────────────────────────────────
function parseSpoolFile(spoolFile) {
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const NCOLS = 38;
  const parsed = [], malformed = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes(SEP)) continue;
    const f = line.split(SEP);
    if (f.length === NCOLS) parsed.push(f);
    else malformed.push(line);
  }
  return { parsed, malformed };
}

// ── Full sync (TRUNCATE + bulk INSERT) ────────────────────────────────────────
async function fullSync(conn, parsed) {
  log(`Full sync: ${parsed.length} rows → TRUNCATE + bulk INSERT`);

  await conn.beginTransaction();
  await conn.execute('TRUNCATE TABLE agency_master');

  const NCOLS  = 38;
  const BATCH  = 500;   // rows per INSERT statement
  const PH     = '(' + Array(NCOLS).fill('?').join(',') + ')';

  let inserted = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk  = parsed.slice(i, i + BATCH);
    const values = chunk.map(lineToParams);
    // mysql2: INSERT INTO t (cols) VALUES ? with nested array → multi-row
    await conn.query(
      `INSERT INTO agency_master (${COL_LIST}) VALUES ?`,
      [values]
    );
    inserted += chunk.length;
    process.stdout.write(`\r  Inserted ${inserted}/${parsed.length}...`);
  }
  console.log('');

  await conn.commit();
  return inserted;
}

// ── Incremental sync (UPSERT changed rows) ────────────────────────────────────
async function incrementalSync(conn, parsed) {
  log(`Incremental sync: ${parsed.length} changed rows → UPSERT`);

  if (!parsed.length) return 0;

  // Process in batches using INSERT ... ON DUPLICATE KEY UPDATE
  const BATCH = 200;
  let upserted = 0, errors = 0;

  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk  = parsed.slice(i, i + BATCH);
    const values = chunk.map(lineToParams);
    const NCOLS  = 38;
    const PH     = Array(NCOLS).fill('?').join(',');
    const placeholders = chunk.map(() => `(${PH})`).join(',\n');
    const flatParams   = values.flat();

    try {
      const [result] = await conn.execute(
        `INSERT INTO agency_master (${COL_LIST}) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE${UPDATE_CLAUSE}`,
        flatParams
      );
      // affected_rows = 1 (insert) + 2 (update) per row
      upserted += chunk.length;
    } catch (err) {
      errors++;
      log(`  Batch error at row ${i}: ${err.message}`);
      // Fall back to one-by-one for this chunk
      for (const f of chunk) {
        try {
          await conn.execute(
            `INSERT INTO agency_master (${COL_LIST}) VALUES (${Array(NCOLS).fill('?').join(',')})
             ON DUPLICATE KEY UPDATE${UPDATE_CLAUSE}`,
            lineToParams(f)
          );
          upserted++;
        } catch (e2) {
          log(`  Row error agcd=${str(f[10])} dpcd=${str(f[11])}: ${e2.message}`);
        }
      }
    }
    process.stdout.write(`\r  Upserted ${upserted}/${parsed.length}...`);
  }
  console.log('');
  return upserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const mode = FULL_MODE ? 'FULL' : 'INCREMENTAL';
  log(`=== Agency Master sync started [${mode}] ===`);

  for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
    if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exit(1); }
  }
  if ((!_ora.driverAvailable() && !fs.existsSync(SQLPLUS))) {
    log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exit(1);
  }

  const conn = await mysql.createConnection(MYSQL_CONFIG);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-agmast-'));

  try {
    await ensureSchema(conn);

    // Determine Oracle WHERE filter for incremental
    let sinceDate = null;
    if (!FULL_MODE) {
      const lastSync = await getLastSyncDate(conn);
      if (lastSync) {
        // Query 1 day earlier than last sync for safety (UPDATED_DT is day-level)
        const d = new Date(lastSync);
        d.setDate(d.getDate() - 1);
        sinceDate = fmtDate(d);
        log(`Incremental since: ${sinceDate} (last sync: ${fmtDate(new Date(lastSync))})`);
      } else {
        // First ever incremental run — treat as full
        log('No previous sync recorded — running as full sync this time');
      }
    }

    const sqlFile   = path.join(tmpDir, 'query.sql');
    const spoolFile = path.join(tmpDir, 'data.txt');

    fs.writeFileSync(sqlFile, buildSqlScript(spoolFile, { sinceDate }), 'utf8');
    log('Running Oracle query...');
    const t0 = Date.now();
    await runSqlplus(sqlFile);
    log(`Oracle query completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (!fs.existsSync(spoolFile)) {
      log('ERROR: No spool file produced'); process.exit(1);
    }

    const { parsed, malformed } = parseSpoolFile(spoolFile);
    if (malformed.length) log(`WARNING: ${malformed.length} malformed lines skipped`);
    log(`Oracle returned ${parsed.length} rows`);

    if (!parsed.length && !FULL_MODE) {
      log('No changes since last sync — nothing to update');
      await setLastSyncDate(conn, fmtDate(new Date()));
      return;
    }

    const t1 = Date.now();
    let count;
    if (FULL_MODE || !sinceDate) {
      count = await fullSync(conn, parsed);
    } else {
      count = await incrementalSync(conn, parsed);
    }
    log(`${FULL_MODE || !sinceDate ? 'Inserted' : 'Upserted'} ${count} rows in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    await setLastSyncDate(conn, fmtDate(new Date()));

    // Spot-check
    const [sample] = await conn.query(
      'SELECT unit_name, agcd, ag_name, city_name FROM agency_master ORDER BY synced_at DESC LIMIT 3'
    );
    sample.forEach(r => log(`  ${r.unit_name} | ${r.agcd} | ${r.ag_name} | ${r.city_name}`));

    log(`=== Agency Master sync complete [${mode}] ===`);
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    log(`ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await conn.end();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
