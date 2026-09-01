'use strict';

/**
 * oracle_cash_depot_sync.js — Oracle CIR_CASH_DEPOT_MAST → MySQL cash_depot_master
 *
 * The cash-sale centre master: unit-wise, centre-wise, WITH latitude/longitude — the
 * authoritative anchor the DCR M-Site needs for 50 m attendance geofencing. It also
 * carries the attendance window (ATTENDANCE_FROM_TIME / TILL_TIME), which lets the app
 * say whether someone is marking inside their expected hours.
 *
 * Coordinates flow on into dcr_location with source='registered', which outranks the
 * 'observed' medians the M-Site seeded from historical attendance GPS. Depots without
 * coordinates keep whatever observed anchor they already had rather than losing it.
 *
 * Usage:
 *   node api/oracle_cash_depot_sync.js
 *   node api/oracle_cash_depot_sync.js --dry-run
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
const SQLPLUS_TIMEOUT_MS = 10 * 60 * 1000;

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const SEP = '\x1c', D = 'CHR(28)';
const NCOLS = 16;

function log(m) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${m}`);
  try {
    const f = path.resolve(__dirname, '../logs/oracle_cash_depot_sync.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `[${ts}] ${m}\n`);
  } catch (_) {}
}

function buildSql(spoolFile) {
  const S = f => `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;
  const cols = [
    S('d.COMP_CODE'), S('d.UNIT_CODE'), S('d.DEPOT_CODE'), S('d.DEPOT_SUBCODE'),
    S('d.DEPOT_NAME'), S('d.DEPOT_ALIAS'), S('d.DEPOT_ADDR'), S('d.DEPOT_INCHARGE'),
    S('d.LATITUDE'), S('d.LONGITUDE'),
    S('d.ATTENDANCE_FROM_TIME'), S('d.ATTENDANCE_TILL_TIME'),
    S('d.DEPOT_TYPE'), S('d.MAIN_DEPOT_CODE'), S('d.FREEZE_FLAG'),
    S('cir_get_unitname(d.UNIT_CODE)'),
  ].join(`\n  || ${D} ||\n  `);

  // TERMOUT OFF is load-bearing: without it sqlplus writes every row to stdout as well
  // as the spool, and an undrained pipe blocks the query past ~64KB.
  return `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SET TRIMOUT ON
SET TERMOUT OFF
SET WRAP OFF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile.replace(/\\/g, '/')}
SELECT ${cols}
FROM CIR_CASH_DEPOT_MAST d
ORDER BY d.UNIT_CODE, d.DEPOT_CODE;
SPOOL OFF
EXIT
`;
}

function runSqlplus(sqlFile) {
  return new Promise((resolve, reject) => {
    const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
      `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    const p = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true,
    });
    let out = '';
    // Drain both pipes — an unread stdout fills and stalls sqlplus mid-query.
    p.stdout.on('data', d => { if (out.length < 65536) out += d.toString(); });
    p.stderr.on('data', d => { if (out.length < 65536) out += d.toString(); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(-1); }, SQLPLUS_TIMEOUT_MS);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', c => { clearTimeout(timer); resolve(c); });
    p.stdin.write(`CONNECT ${cs}\n`);
    p.stdin.write(`@"${sqlFile}"\n`);
    p.stdin.write('EXIT\n');
    p.stdin.end();
  });
}

const str = v => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
// Oracle stores coordinates as free text, so anything that is not a plausible Indian
// coordinate is dropped rather than written as a number that would fail a fence check.
const coord = (v, lo, hi) => {
  const s = str(v); if (s === null) return null;
  const n = Number(s);
  return (Number.isFinite(n) && n >= lo && n <= hi) ? n : null;
};

async function ensureSchema(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS cash_depot_master (
    id INT AUTO_INCREMENT PRIMARY KEY,
    comp_code VARCHAR(10), unit_code VARCHAR(10) NOT NULL, unit_name VARCHAR(200),
    depot_code VARCHAR(20) NOT NULL, depot_subcode VARCHAR(20),
    depot_name VARCHAR(120), depot_alias VARCHAR(120), depot_addr VARCHAR(300),
    depot_incharge VARCHAR(150),
    latitude DECIMAL(10,6), longitude DECIMAL(10,6),
    attn_from_time VARCHAR(12), attn_till_time VARCHAR(12),
    depot_type VARCHAR(20), main_depot_code VARCHAR(30),
    freeze_flag VARCHAR(2),
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_depot (unit_code, depot_code),
    INDEX idx_cd_unit (unit_code), INDEX idx_cd_geo (latitude, longitude)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
}

async function sync() {
  log(`=== Cash Depot Master sync START${DRY_RUN ? ' (DRY RUN)' : ''} ===`);
  const tmp = os.tmpdir();
  const sqlFile = path.join(tmp, `cash_depot_${Date.now()}.sql`);
  const spool   = path.join(tmp, `cash_depot_${Date.now()}.spool`);
  fs.writeFileSync(sqlFile, buildSql(spool), 'utf8');

  log('Running Oracle query…');
  const rc = await runSqlplus(sqlFile);
  if (rc !== 0) throw new Error(`sqlplus exit ${rc}${rc === -1 ? ' (timed out)' : ''} — MySQL left untouched`);
  if (!fs.existsSync(spool)) throw new Error('No spool file produced');

  const raw = fs.readFileSync(spool, 'utf8');
  const rows = raw.split(/\r?\n/).map(l => l.split(SEP)).filter(f => f.length >= NCOLS);
  log(`Oracle returned ${rows.length} depots`);
  try { fs.unlinkSync(sqlFile); fs.unlinkSync(spool); } catch (_) {}

  const parsed = rows.map(f => ({
    comp_code: str(f[0]), unit_code: str(f[1]), depot_code: str(f[2]), depot_subcode: str(f[3]),
    depot_name: str(f[4]), depot_alias: str(f[5]), depot_addr: str(f[6]), depot_incharge: str(f[7]),
    latitude: coord(f[8], 8, 38), longitude: coord(f[9], 68, 98),
    attn_from: str(f[10]), attn_till: str(f[11]),
    depot_type: str(f[12]), main_depot: str(f[13]), freeze: str(f[14]), unit_name: str(f[15]),
  })).filter(r => r.unit_code && r.depot_code);

  const withGeo = parsed.filter(r => r.latitude != null && r.longitude != null);
  log(`Parsed ${parsed.length} · with usable coordinates: ${withGeo.length}`);

  if (DRY_RUN) { log('Dry run — nothing written.'); return { rows: parsed.length, geo: withGeo.length }; }

  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    await ensureSchema(conn);
    let n = 0;
    for (let i = 0; i < parsed.length; i += 300) {
      const chunk = parsed.slice(i, i + 300);
      const ph = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      const vals = chunk.flatMap(r => [r.comp_code, r.unit_code, r.unit_name, r.depot_code,
        r.depot_subcode, r.depot_name, r.depot_alias, r.depot_addr, r.depot_incharge,
        r.latitude, r.longitude, r.attn_from, r.attn_till, r.depot_type, r.main_depot, r.freeze]);
      await conn.execute(
        `INSERT INTO cash_depot_master (comp_code, unit_code, unit_name, depot_code, depot_subcode,
           depot_name, depot_alias, depot_addr, depot_incharge, latitude, longitude,
           attn_from_time, attn_till_time, depot_type, main_depot_code, freeze_flag)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE unit_name=VALUES(unit_name), depot_name=VALUES(depot_name),
           depot_alias=VALUES(depot_alias), depot_addr=VALUES(depot_addr),
           depot_incharge=VALUES(depot_incharge), latitude=VALUES(latitude),
           longitude=VALUES(longitude), attn_from_time=VALUES(attn_from_time),
           attn_till_time=VALUES(attn_till_time), depot_type=VALUES(depot_type),
           main_depot_code=VALUES(main_depot_code), freeze_flag=VALUES(freeze_flag)`, vals);
      n += chunk.length;
    }
    log(`Upserted ${n} rows into cash_depot_master`);

    /* Push coordinates into dcr_location as the authoritative anchor. ERP-held
       coordinates outrank the medians the M-Site derived from past attendance GPS, so
       these overwrite 'observed' rows — but a depot with no coordinates leaves the
       observed anchor alone rather than replacing it with nothing. */
    let geo = 0;
    for (const r of withGeo) {
      await conn.execute(
        `INSERT INTO dcr_location (target_type, unit_code, target_code, target_name, lat, lng, source, samples)
         VALUES ('centre',?,?,?,?,?, 'registered', 1)
         ON DUPLICATE KEY UPDATE lat=VALUES(lat), lng=VALUES(lng),
           target_name=VALUES(target_name), source='registered'`,
        [r.unit_code, r.depot_code, r.depot_name || r.depot_alias, r.latitude, r.longitude]);
      // The centres already seeded from attendance are keyed by NAME, not depot code,
      // so key on the name too — otherwise the ERP coordinate never reaches them.
      if (r.depot_name) {
        await conn.execute(
          `UPDATE dcr_location SET lat=?, lng=?, source='registered'
           WHERE target_type='centre' AND unit_code=? AND target_code=?`,
          [r.latitude, r.longitude, r.unit_code, String(r.depot_name).trim().toUpperCase()]);
      }
      geo++;
    }
    log(`Registered ${geo} centre locations for geofencing`);
    return { rows: n, geo };
  } finally { await conn.end(); }
}

if (require.main === module) {
  sync().then(r => { log(`=== Done: ${r.rows} depots, ${r.geo} geo-located ===`); process.exit(0); })
        .catch(e => { log(`ERROR: ${e.message}`); process.exit(1); });
}
module.exports = { sync };
