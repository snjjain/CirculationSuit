'use strict';

/**
 * oracle_survey_sync.js — Pull CRM survey data from Oracle → MySQL survey_data
 *
 * Inlines the crm_rep_survey_detail procedure's query via sqlplus spool
 * (Oracle 11g thin mode not supported, so we use the local sqlplus.exe).
 *
 * Usage:
 *   node api/oracle_survey_sync.js                     # last 6 months to yesterday
 *   node api/oracle_survey_sync.js --from 2026-01-01   # from date to yesterday
 *   node api/oracle_survey_sync.js --from 2026-01-01 --to 2026-07-30
 *   node api/oracle_survey_sync.js --from-last         # day after MAX(bookdate) to yesterday
 *   node api/oracle_survey_sync.js --date 2026-07-30   # single date
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
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_sync.log');
const SEP = '\x1c'; // ASCII 28 — field separator
const FIELD_COUNT = 34;

// All branches to sync (plocid list)
const SURVEY_LOC_IDS = [
  'AJ0','AL0','BA1','BA0','BA2','BH2','BH0','BH1','BI0','BI1',
  'CH0','SE0','DE0','GW0','IN0','JA1','JA8','JA0','JH1','JO0',
  'KH0','KO1','KO0','MA0','PA0','RA1','RA0','SA1','SA0','SI0',
  'SR0','SU0','UD0','UJ0','BH3',
];

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

// ── CLI helpers ───────────────────────────────────────────────────────────────
function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

function hasFlag(name) { return process.argv.includes(name); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

function yesterday() {
  return addDays(new Date().toISOString().substring(0, 10), -1);
}

function sixMonthsAgo() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().substring(0, 10);
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

// Accept YYYY-MM-DD (Oracle TO_CHAR output)
function toDate(v) {
  const t = str(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.substring(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

// ── Build Oracle SQL script ───────────────────────────────────────────────────
function buildSqlScript(fromDate, toDate, spoolFile) {
  const D   = 'CHR(28)';
  const loc = SURVEY_LOC_IDS.map(l => `'${l}'`).join(',');

  // Field order must match FIELD_COUNT and lineToParams indices.
  // We avoid slow per-row function calls (crm_get_hawker_name, app_reader_fetch_newspaper)
  // to keep the query fast; raw codes are stored and can be resolved separately.
  const fields = [
    `a.loc_id`,                                                        //  0 unit_code
    `NVL(REPLACE(p."Pub_Cent_name",CHR(28),' '),'')`,                 //  1 unit_name
    `NVL(p.state,'')`,                                                 //  2 state_name
    `NVL(TO_CHAR(NVL(a.bookdate,a.subdate),'YYYY-MM-DD'),'')`,       //  3 bookdate
    `NVL(TO_CHAR(a.created_dt,'hh24:mi:ss'),'')`,                     //  4 createtime
    `NVL(TO_CHAR(a.sch_opt),'')`,                                      //  5 sch_opt
    `NVL(REPLACE(b.scheme_name,CHR(28),' '),'')`,                     //  6 scheme_name
    `NVL(TO_CHAR(a.r_id),'')`,                                        //  7 r_id
    `NVL(REPLACE(a.r_name,CHR(28),' '),'')`,                          //  8 r_name
    `CASE WHEN a.gender IN ('2','F') THEN 'FEMALE' ELSE 'MALE' END`,  //  9 gender
    `NVL(a.r_mobile,'')`,                                             // 10 mobile
    `NVL(a.r_phone_resi,'')`,                                         // 11 alternate_mobile
    `NVL(a.email,'')`,                                                 // 12 email
    `NVL(a.r_hno,'')`,                                                 // 13 house_no
    `NVL(REPLACE(a.r_block_street,CHR(28),' '),'')`,                  // 14 r_block_street
    `NVL(TO_CHAR(a.r_locality),'')`,                                   // 15 locality_code
    `NVL(a.r_pin,'')`,                                                 // 16 pin
    `NVL(TO_CHAR(a.cent_id),'')`,                                      // 17 cent_id
    `NVL(TO_CHAR(a.created_by),'')`,                                   // 18 created_by
    `NVL(a.form_no,'')`,                                               // 19 form_no
    `NVL(TO_CHAR(a.pro_id),'')`,                                       // 20 pro_id
    `NVL(TO_CHAR(a.tl_id),'')`,                                        // 21 tl_id
    `NVL(a.agcd,'')`,                                                  // 22 agcd
    `NVL(a.dpcd,'')`,                                                  // 23 dpcd
    `NVL(TO_CHAR(a.hawker_id),'')`,                                    // 24 hawker_id
    `CASE NVL(TO_CHAR(a.wa_type),'0') WHEN '1' THEN 'FOLLOW_UP' WHEN '0' THEN 'WITH_OTHER' WHEN '2' THEN 'NOT_INTERESTED' WHEN '3' THEN 'NOT_INTERESTED' WHEN '6' THEN 'NEW' WHEN '7' THEN 'REPLACE' WHEN '999' THEN 'RP_READER' ELSE 'N/A' END`, // 25 unprod_reason
    `NVL(TO_CHAR(a.followup_date,'YYYY-MM-DD'),'')`,                   // 26 followup_date
    `NVL(a.followup_time,'')`,                                         // 27 followup_time
    `NVL(TO_CHAR(a.latitude),'')`,                                     // 28 latitude
    `NVL(TO_CHAR(a.longitude),'')`,                                    // 29 longitude
    `NVL(a.CATEGORY,'')`,                                              // 30 category
    `NVL(TO_CHAR(a.order_id),'')`,                                     // 31 order_id
    `NVL(SUBSTR(a.capture_image,1,500),'')`,                           // 32 capture_image
    `NVL(SUBSTR(a.record_audio,1,500),'')`,                            // 33 record_audio
  ].join(` || ${D} || `);

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
SPOOL ${spoolFile}
SELECT REPLACE(REPLACE(${fields}, CHR(10), ' '), CHR(13), ' ')
FROM reader_detail1 a
JOIN pub_cent_mast p ON p."Pub_cent_Code" = a.loc_id
-- a.sch_id is a scheme TYPE code (e.g. 'AU') shared by every scheme of a unit —
-- joining on it multiplies each survey by the unit's scheme count. The reader's
-- actual scheme is a.sch_opt -> b.scheme_id, unique per (loc_id, scheme_id).
LEFT JOIN crm_scheme_master b
  ON b.loc_id = a.loc_id
 AND TO_CHAR(b.scheme_id) = TO_CHAR(a.sch_opt)
WHERE a.loc_id IN (${loc})
  AND NVL(a.bookdate, a.subdate) BETWEEN TO_DATE('${fromDate}','YYYY-MM-DD') AND TO_DATE('${toDate}','YYYY-MM-DD')
ORDER BY NVL(a.bookdate, a.subdate), a.loc_id, a.r_id;
SPOOL OFF
EXIT
`;
}

// ── Run sqlplus (credentials via stdin, never on command line) ────────────────
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

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      const errMatch = (stdout + stderr).match(/ORA-\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*|TNS-\d{5}[^\r\n]*/);
      if (code === 0 && !errMatch) resolve({ stdout, stderr });
      else reject(new Error(`sqlplus failed (exit ${code})${errMatch ? ': ' + errMatch[0] : ''}\n${stdout.slice(0,500)}\n${stderr.slice(0,500)}`));
    });

    const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
               `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    proc.stdin.write(`CONNECT ${cs}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Map one parsed spool line → MySQL INSERT params ───────────────────────────
function lineToParams(f) {
  return [
    str(f[0]),    //  1 unit_code
    str(f[1]),    //  2 unit_name
    str(f[2]),    //  3 state_name
    toDate(f[3]), //  4 bookdate
    str(f[4]),    //  5 createtime
    str(f[5]),    //  6 sch_opt
    str(f[6]),    //  7 scheme_name
    str(f[7]),    //  8 r_id
    str(f[8]),    //  9 r_name
    str(f[9]),    // 10 gender
    str(f[10]),   // 11 mobile
    str(f[11]),   // 12 alternate_mobile
    str(f[12]),   // 13 email
    str(f[13]),   // 14 house_no
    str(f[14]),   // 15 r_block_street
    str(f[15]),   // 16 locality_code
    str(f[16]),   // 17 pin
    str(f[17]),   // 18 cent_id
    str(f[18]),   // 19 created_by
    str(f[19]),   // 20 form_no
    str(f[20]),   // 21 pro_id
    str(f[21]),   // 22 tl_id
    str(f[22]),   // 23 agcd
    str(f[23]),   // 24 dpcd
    str(f[24]),   // 25 hawker_id
    str(f[25]),   // 26 unprod_reason
    toDate(f[26]),// 27 followup_date
    str(f[27]),   // 28 followup_time
    num(f[28]),   // 29 latitude
    num(f[29]),   // 30 longitude
    str(f[30]),   // 31 category
    str(f[31]),   // 32 order_id
    str(f[32]),   // 33 capture_image
    str(f[33]),   // 34 record_audio
  ];
}

// ── Date chunk helpers ────────────────────────────────────────────────────────
function buildChunks(from, to, chunkDays) {
  const chunks = [];
  let start = from;
  while (start <= to) {
    let end = addDays(start, chunkDays - 1);
    if (end > to) end = to;
    chunks.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return chunks;
}

// ── Sync one chunk: Oracle → parse → overwrite MySQL ─────────────────────────
async function syncChunk(conn, chunk, tmpDir, chunkNo, total) {
  const sqlFile   = path.join(tmpDir, `survey_query_${chunkNo}.sql`);
  const spoolFile = path.join(tmpDir, `survey_data_${chunkNo}.txt`);

  fs.writeFileSync(sqlFile, buildSqlScript(chunk.from, chunk.to, spoolFile), 'utf8');
  log(`[chunk ${chunkNo}/${total}] Oracle query: ${chunk.from} → ${chunk.to} ...`);

  const t0 = Date.now();
  await runSqlplus(sqlFile);
  log(`[chunk ${chunkNo}/${total}] Oracle responded in ${Math.round((Date.now()-t0)/1000)}s`);

  if (!fs.existsSync(spoolFile)) throw new Error('sqlplus produced no spool file');

  const raw = fs.readFileSync(spoolFile, 'utf8');
  const spoolErr = raw.match(/ORA-\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*/);
  if (spoolErr) throw new Error(`Oracle error in spool: ${spoolErr[0]}`);

  const lines = raw.split(/\r?\n/).filter(l => l.includes(SEP));
  log(`[chunk ${chunkNo}/${total}] ${lines.length} rows returned`);

  if (lines.length === 0) {
    log(`[chunk ${chunkNo}/${total}] 0 rows — keeping existing data (no delete)`);
    return { inserted: 0, errors: 0 };
  }

  const parsed = [];
  const seen = new Set(); // guard against join fan-out re-emerging: drop exact duplicate lines
  let bad = 0, dupes = 0;
  for (const line of lines) {
    const f = line.split(SEP);
    if (f.length !== FIELD_COUNT) { bad++; continue; }
    if (seen.has(line)) { dupes++; continue; }
    seen.add(line);
    parsed.push(f);
  }
  if (bad > 0) log(`[chunk ${chunkNo}/${total}] WARNING: skipped ${bad} malformed lines`);
  if (dupes > 0) log(`[chunk ${chunkNo}/${total}] WARNING: dropped ${dupes} exact duplicate rows from Oracle result`);

  await conn.beginTransaction();
  try {
    const [delRes] = await conn.execute(
      'DELETE FROM survey_data WHERE bookdate BETWEEN ? AND ?',
      [chunk.from, chunk.to]
    );

    const insertSQL = `
      INSERT INTO survey_data
        (unit_code, unit_name, state_name, bookdate, createtime,
         sch_opt, scheme_name, r_id, r_name, gender,
         mobile, alternate_mobile, email, house_no, r_block_street,
         locality_code, pin, cent_id, created_by, form_no,
         pro_id, tl_id, agcd, dpcd, hawker_id,
         unprod_reason, followup_date, followup_time,
         latitude, longitude, category, order_id,
         capture_image, record_audio)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    let inserted = 0, errors = 0;
    for (const f of parsed) {
      try {
        await conn.execute(insertSQL, lineToParams(f));
        inserted++;
      } catch (err) {
        errors++;
        if (errors <= 5) log(`  Row error: ${err.message} — r_id:${f[7]} date:${f[3]}`);
      }
    }

    await conn.commit();
    log(`[chunk ${chunkNo}/${total}] Replaced ${delRes.affectedRows} old → ${inserted} new rows` +
        (errors > 0 ? ` (${errors} errors)` : ''));
    return { inserted, errors };
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    try { fs.unlinkSync(sqlFile); } catch (_) {}
    try { fs.unlinkSync(spoolFile); } catch (_) {}
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const CHUNK_DAYS = parseInt(getArg('--chunk-days') || '30', 10);

  const conn = await mysql.createConnection(MYSQL_CONFIG);

  let fromDate, toDate;
  try {
    if (hasFlag('--from-last')) {
      const [rows] = await conn.execute(
        "SELECT DATE_FORMAT(MAX(bookdate),'%Y-%m-%d') AS mx FROM survey_data"
      );
      const last = rows[0]?.mx;
      if (!last) {
        log('No survey_data yet — syncing from last 6 months');
        fromDate = sixMonthsAgo();
      } else {
        fromDate = addDays(last, 1);
        log(`Auto-detected: last bookdate = ${last}. Syncing from ${fromDate}`);
      }
      toDate = getArg('--to') || yesterday();
    } else if (getArg('--date')) {
      fromDate = toDate = getArg('--date');
    } else {
      fromDate = getArg('--from') || sixMonthsAgo();
      toDate   = getArg('--to')   || yesterday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
        console.error('Usage: node api/oracle_survey_sync.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
        console.error('       node api/oracle_survey_sync.js --from-last');
        console.error('       node api/oracle_survey_sync.js --date YYYY-MM-DD');
        process.exitCode = 1;
        return;
      }
    }

    if (fromDate > toDate) {
      log(`Nothing to sync: ${fromDate} > ${toDate} — already up to date`);
      return;
    }

    for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
      if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exitCode = 1; return; }
    }
    if ((!_ora.driverAvailable() && !fs.existsSync(SQLPLUS))) {
      log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exitCode = 1; return;
    }

    const chunks = buildChunks(fromDate, toDate, CHUNK_DAYS);
    const days   = chunks.reduce((n, c) =>
      n + Math.round((new Date(c.to) - new Date(c.from)) / 86400000) + 1, 0);

    log(`=== Survey sync started | ${fromDate} → ${toDate} (${days} days, ${chunks.length} chunks of ≤${CHUNK_DAYS} days) ===`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-survey-'));
    let totalInserted = 0, totalErrors = 0;
    const failedChunks = [];

    try {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      for (let i = 0; i < chunks.length; i++) {
        let done = false;
        for (let attempt = 1; attempt <= 3 && !done; attempt++) {
          try {
            // Fresh connection per attempt — the Oracle spool can outlive MySQL
            // wait_timeout, so a connection held across chunks arrives dead and
            // poisons every retry ("Can't add new command when connection is in
            // closed state"). Same fix as supply/DCR syncs.
            const cconn = await mysql.createConnection(MYSQL_CONFIG);
            try {
              const r = await syncChunk(cconn, chunks[i], tmpDir, i + 1, chunks.length);
              totalInserted += r.inserted;
              totalErrors   += r.errors;
              done = true;
            } finally { try { await cconn.end(); } catch (_) {} }
          } catch (err) {
            log(`[chunk ${i+1}/${chunks.length}] attempt ${attempt} FAILED: ${err.message.split('\n')[0]}`);
            if (attempt === 3) failedChunks.push(chunks[i]);
            else { const w = attempt * 60; log(`  retrying in ${w}s...`); await sleep(w * 1000); }
          }
        }
      }

      if (failedChunks.length > 0) {
        log(`=== Survey sync FINISHED WITH FAILURES: ${totalInserted} rows; failed: ` +
            failedChunks.map(c => `${c.from}→${c.to}`).join(', ') + ' ===');
        process.exitCode = 1;
      } else {
        log(`=== Survey sync complete: ${fromDate} → ${toDate} | ${totalInserted} rows` +
            (totalErrors > 0 ? ` (${totalErrors} row errors)` : '') + ' ===');
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try { await conn.end(); } catch (_) {}
  }
}

main();
