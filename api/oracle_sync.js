'use strict';

/**
 * oracle_sync.js — Pulls daily taxi drop-point data from Oracle ERP → MySQL
 *
 * The Oracle server is 11g (11.2.0.3), which node-oracledb thin mode does not
 * support, and no Oracle client install is wanted on this machine. So this
 * script uses the existing 32-bit sqlplus.exe from the local Oracle XE install
 * to run the query and spool delimited output, then parses it and loads it
 * into MySQL.
 *
 * Usage:
 *   node api/oracle_sync.js               # syncs yesterday
 *   node api/oracle_sync.js --date 2026-07-16
 *
 * Scheduled daily at 06:00 via Windows Task Scheduler (see scripts/register_oracle_sync_task.ps1)
 */

const { spawn } = require('child_process');
const https = require('https');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_sync.log');

// Field separator in spooled output: ASCII 28 (file separator) — never appears in data
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

// ── Parse --date arg (YYYY-MM-DD), default yesterday ─────────────────────────
function getSyncDate() {
  const idx = process.argv.indexOf('--date');
  const val = idx !== -1 ? process.argv[idx + 1] : null;
  if (val) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      log(`ERROR: invalid --date "${val}" (expected YYYY-MM-DD)`);
      process.exit(1);
    }
    return val;
  }
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
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

function toInt(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
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

// 'HH:MM' or 'HH:MM:SS' → 'HH:MM:SS'
function toTime(v) {
  const t = str(v);
  if (!t) return null;
  let m = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}`;
  m = t.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:00`;
  return null;
}

// Convert 'HH:MM' or 'HH:MM:SS' (with optional leading '-') → signed integer seconds
// MySQL stores time_diff as INT NULL (positive = late, negative = early)
function toIntervalSecs(v) {
  const t = str(v);
  if (!t) return null;
  const m = t.match(/^(-?)(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  const neg = m[1] === '-';
  const totalSec = parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60 + (m[4] ? parseInt(m[4], 10) : 0);
  return neg ? -totalSec : totalSec;
}

// ── Build the Oracle SQL script for sqlplus ───────────────────────────────────
// Selects 29 delimiter-joined fields per row (order matters — parsed by index).
function buildSqlScript(syncDate, spoolFile) {
  const D = `CHR(28)`;
  const fields = [
    'q.unit_name',                       //  0
    'q.supdate',                         //  1  DD/MM/YYYY
    'q.driver_code',                     //  2
    'q.vehicle_no',                      //  3
    'q.taxi_stat',                       //  4  MAIN / LINK
    'q.route_code',                      //  5
    'q.rtnm',                            //  6
    'q.subrt_code',                      //  7
    'q.sub_route_name',                  //  8
    'q.drop_point_name',                 //  9
    'q.no_of_packets',                   // 10
    'q.packet_drop_date',                // 11  DD/MM/YYYY
    'q.reg_drop_time',                   // 12
    'q.packet_drop_time',                // 13
    'q.time_diff',                       // 14
    'q.taxi_id',                         // 15
    'q.registered_latitude',             // 16
    'q.registered_longitude',            // 17
    'q.drop_lattitude',                  // 18
    'q.drop_longitude',                  // 19
    'q.diff_distance',                   // 20
    'q.route_master_km',                 // 21
    'q.return_km',                       // 22
    'q.actual_km',                       // 23
    'q.tot_dist',                        // 24
    'SUBSTR(q.lat_long_addr,1,500)',     // 25
    'q.vehicle_sharing_flag',            // 26
    'q.droping_latlong',                 // 27
    'q.distance_prev_dp',               // 28  Google Maps road km from previous drop
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
FROM (
  select x.comp_code, x.unit_code, x.unit_name, to_char(x.supdate,'dd/mm/yyyy') supdate,
      x.driver_code, x.driver_name, x.route_code, x.rtnm, x.drop_point_code, x.drop_point_name,
      x.no_of_packets, x.app_time reg_drop_time, x.packet_drop_time,
      time_diff(x.app_time, x.packet_drop_time) TIME_DIFF,
      case when x.subrt_code is not null then
          (select SUBRT_DIST from cir_sub_route_mast where comp_code = x.comp_code and unit = x.unit_code and route_code = x.route_code and subrt_code = x.subrt_code)
      else
          (select ROUTE_DIST from cir_route_mast where comp_code = x.comp_code and unit = x.unit_code and route_code = x.route_code)
      end Route_Master_Km,
      case when (x.lattitude != 0 or x.lattitude != '') then
          app_driver_calc_drop_distance (x.comp_code, x.unit_code, x.taxi_id, x.supdate, x.driver_code, x.route_code, x.subrt_code, x.unq_id)
      else 0 end as Actual_Km,
      x.taxi_id, x.packet_drop_date,
      x.registered_latitude, x.registered_longitude, x.lattitude drop_lattitude, x.longitude drop_longitude,
      case when (x.lattitude != '0' and x.lattitude != '' and nvl(x.registered_latitude,'0')<>'0' and nvl(x.registered_longitude,'0')<>'0') then
        case when round(nvl(x.registered_latitude,'0'),6) = round(nvl(x.lattitude,'0'),6) and round(nvl(x.registered_longitude,'0'),6) = round(nvl(x.longitude,'0'),6) then 0
        else round(calc_distance (round(nvl(x.registered_latitude,0),6), round(nvl(x.registered_longitude,0),6), round(nvl(x.lattitude,0),6), round(nvl(x.longitude,0),6)),2)
        end
      else 0 end as diff_distance,
      x.unq_id, x.vehicle_no, x.LAT_LONG_ADDR, x.RETURN_KM, x.taxi_stat, x.SUBRT_CODE, x.SUB_ROUTE_NAME,
      app_driver_calc_route_distance (x.comp_code, x.unit_code, x.taxi_id, x.supdate, x.driver_code, x.route_code, x.SUBRT_CODE) TOT_DIST,
      app_driver_prev_dp_latlong (x.comp_code, x.unit_code, x.taxi_id, x.supdate, x.driver_code, x.route_code, x.SUBRT_CODE, x.unq_id, 'BOTH', ';') droping_latlong,
      x.MAPS_ROUTE_ZONE, x.VEHICLE_SHARING_FLAG, x.DISTANCE_PREV_DP
  from
  (select a.comp_code, a.unit_code, get_unit_name(a.comp_code, a.unit_code) unit_name, a.supdate,
      a.driver_code, a.driver_name, a.route_code, a.rtnm, a.drop_point_code, a.drop_point drop_point_name,
      nvl(sum(a.packet),0) no_of_packets, a.APP_TIME, a.dep_time packet_drop_time, a.taxi_id, a.trans_code,
      a.lattitude, a.longitude,
      (select latitude from cir_drop_point_mast where comp_code = a.comp_code and unit_code = a.unit_code
          and drop_point = a.drop_point_code) registered_latitude,
      (select lognitude from cir_drop_point_mast where comp_code = a.comp_code and unit_code = a.unit_code
          and drop_point = a.drop_point_code) registered_longitude,
      to_char(created_date,'dd/mm/yyyy') packet_drop_date, min(a.unq_id) unq_id,
      (select vehicle_no from cir_taxi_mast where comp_code = a.comp_code and
          unit_code = a.unit_code and rt_code = a.route_code and taxi_id = a.taxi_id) vehicle_no,
      trunc(created_date) created_date,
      sum(a.DISTANCE_PREV_DP) DISTANCE_PREV_DP, LAT_LONG_ADDR,
      (select RETURN_KM from cir_taxi_mast where comp_code = a.comp_code and
          unit_code = a.unit_code and taxi_id = a.taxi_id) RETURN_KM,
      case when (select nvl(SUBRT_CODE,'#') from cir_taxi_mast where comp_code = a.comp_code and
          unit_code = a.unit_code and rt_code = a.route_code and taxi_id = a.taxi_id) != '#' then 'LINK'
      else 'MAIN' end as TAXI_STAT,
      a.SUBRT_CODE,
      cir_get_subroute_name (a.comp_code, a.unit_code, a.route_code, a.SUBRT_CODE) as SUB_ROUTE_NAME,
      nvl((select MAPS_ROUTE_ZONE from cir_route_mast where comp_code = a.comp_code and unit = a.unit_code and route_code = a.route_code),'N') MAPS_ROUTE_ZONE,
      (select VEHICLE_SHARING_FLAG from cir_taxi_mast where comp_code = a.comp_code and unit_code = a.unit_code and rt_code = a.route_code and
          taxi_id = a.taxi_id) VEHICLE_SHARING_FLAG
  from app_driver_daily a
  where a.comp_code = 'RP001'
    and a.supdate = TO_DATE('${syncDate}','YYYY-MM-DD')
  group by a.comp_code, a.unit_code, a.supdate,
      a.driver_code, a.driver_name, a.route_code, a.rtnm, a.drop_point_code, a.drop_point,
      a.APP_TIME, a.dep_time, a.taxi_id, a.trans_code, a.LATTITUDE, a.LONGITUDE,
      to_char(created_date,'dd/mm/yyyy'), trunc(created_date), LAT_LONG_ADDR, a.SUBRT_CODE
  ) x
) q;
SPOOL OFF
EXIT
`;
}

// ── Run sqlplus: credentials sent via stdin (never on command line / disk) ───
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
      else reject(new Error(`sqlplus exited with code ${code}\n${stdout}\n${stderr}`));
    });

    proc.stdin.write(`CONNECT ${connectString}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Map one parsed line → MySQL INSERT params (31 columns) ───────────────────
function lineToParams(f) {
  let schedTime  = toTime(f[12]);
  const actualTime = toTime(f[13]);

  // Recompute time_diff from Oracle times. Handles both:
  //   early-next-day: actual < sched by > 12h (diff + 86400)
  //   early-previous-night: actual > sched by > 12h, e.g. sched=01:00 actual=23:56 → −64 min (diff - 86400)
  let timeDiff;
  if (schedTime && actualTime) {
    const [sh, sm] = schedTime.split(':').map(Number);
    const [ah, am] = actualTime.split(':').map(Number);
    let diff = (ah * 3600 + am * 60) - (sh * 3600 + sm * 60);
    if (diff < -43200) diff += 86400; // actual is next day (early morning run)
    if (diff > 43200)  diff -= 86400; // actual was previous night (early departure)
    timeDiff = diff;
  } else {
    timeDiff = toIntervalSecs(f[14]);
  }

  return [
    str(f[0]),                         //  1. unit_name
    toDate(f[1]),                      //  2. sup_date
    str(f[2]),                         //  3. driver_mobile (driver code from ERP)
    str(f[3]),                         //  4. vehicle_no
    str(f[4]),                         //  5. taxi_route_type (MAIN / LINK)
    str(f[5]),                         //  6. route_code
    str(f[6]),                         //  7. route_name
    str(f[7]),                         //  8. sub_route_code
    str(f[8]),                         //  9. sub_route_name
    str(f[9]),                         // 10. drop_point_name
    toInt(f[10]),                      // 11. no_of_packets
    toDate(f[11]),                     // 12. packet_drop_date
    schedTime,                         // 13. scheduled_arrival (AM/PM corrected)
    actualTime,                        // 14. actual_arrival
    timeDiff,                          // 15. time_diff (recomputed from corrected sched)
    str(f[15]),                        // 16. taxi_id
    num(f[16]),                        // 17. reg_lat
    num(f[17]),                        // 18. reg_long
    num(f[18]),                        // 19. actual_lat
    num(f[19]),                        // 20. actual_long
    num(f[20]),                        // 21. dist_diff
    num(f[21]),                        // 22. route_master_km
    num(f[22]),                        // 23. return_km
    num(f[23]),                        // 24. actual_km
    num(f[24]),                        // 25. total_distance
    null,                              // 26. duration (not provided by ERP query)
    str(f[25]),                        // 27. lat_long_addr
    (v => v != null ? Math.round(v / 10) / 100 : null)(num(f[28])), // 28. api_distance (DISTANCE_PREV_DP in metres → km, 2dp)
    str(f[26]) === 'Y' ? 1 : 0,       // 29. vehicle_sharing (TINYINT)
    null,                              // 30. last_drop_point (not provided)
    str(f[27]),                        // 31. dropping_lat_long
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const syncDate = getSyncDate();
  log(`=== Oracle → MySQL sync started | date: ${syncDate} ===`);

  for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
    if (!process.env[k]) {
      log(`ERROR: ${k} not set in .env`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(SQLPLUS)) {
    log(`ERROR: sqlplus not found at ${SQLPLUS} (set SQLPLUS_PATH in .env)`);
    process.exit(1);
  }

  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-sync-'));
  const sqlFile   = path.join(tmpDir, 'query.sql');
  const spoolFile = path.join(tmpDir, 'data.txt');
  const conn      = await mysql.createConnection(MYSQL_CONFIG);

  try {
    // ── Run Oracle query via sqlplus ─────────────────────────────────────────
    fs.writeFileSync(sqlFile, buildSqlScript(syncDate, spoolFile), 'utf8');
    log(`Running Oracle query via sqlplus (${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}) ...`);
    await runSqlplus(sqlFile);

    if (!fs.existsSync(spoolFile)) {
      throw new Error('sqlplus produced no spool file — check Oracle connection/query');
    }

    const raw = fs.readFileSync(spoolFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.includes(SEP));
    log(`Oracle returned ${lines.length} rows`);

    if (lines.length === 0) {
      log('No data for this date — nothing to import');
      return;
    }

    // ── Parse rows ───────────────────────────────────────────────────────────
    const parsed = [];
    let badLines = 0;
    for (const line of lines) {
      const f = line.split(SEP);
      if (f.length !== 29) { badLines++; continue; }
      parsed.push(f);
    }
    if (badLines > 0) log(`WARNING: skipped ${badLines} malformed lines`);

    // ── Load into MySQL ──────────────────────────────────────────────────────
    await conn.beginTransaction();

    const [delRes] = await conn.execute(
      'DELETE FROM taxi_drop_point_log WHERE sup_date = ?', [syncDate]);
    log(`Deleted ${delRes.affectedRows} existing rows for ${syncDate}`);

    // Upsert routes
    const routeMap = new Map();
    for (const f of parsed) {
      const rc = str(f[5]), rn = str(f[6]);
      if (rc && rn) routeMap.set(rc, rn);
    }
    for (const [rc, rn] of routeMap) {
      await conn.execute(
        `INSERT INTO routes (route_code, route_name)
         VALUES (?,?)
         ON DUPLICATE KEY UPDATE route_name = VALUES(route_name)`,
        [rc, rn]);
    }
    log(`Upserted ${routeMap.size} routes`);

    const insertSQL = `
      INSERT INTO taxi_drop_point_log
        (unit_name, sup_date, driver_mobile, vehicle_no, taxi_route_type,
         route_code, route_name, sub_route_code, sub_route_name,
         drop_point_name, no_of_packets, packet_drop_date,
         scheduled_arrival, actual_arrival, time_diff,
         taxi_id, reg_lat, reg_long, actual_lat, actual_long,
         dist_diff, route_master_km, return_km, actual_km,
         total_distance, duration, lat_long_addr, api_distance,
         vehicle_sharing, last_drop_point, dropping_lat_long)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    let inserted = 0, errors = 0;
    for (const f of parsed) {
      try {
        await conn.execute(insertSQL, lineToParams(f));
        inserted++;
      } catch (err) {
        errors++;
        if (errors <= 5) log(`  Row error (${err.message}) — route:${f[5]} dp:${f[9]}`);
      }
    }

    await conn.commit();
    log(`Inserted ${inserted} rows${errors > 0 ? `, skipped ${errors} with errors` : ''}`);

    // ── Compute api_distance using OSRM road routing (falls back to Haversine) ─
    // OSRM uses OpenStreetMap data — no API key required.
    // Uses Oracle's dropping_lat_long for correct route sequence.
    function _osrmKm(pLon, pLat, cLon, cLat) {
      return new Promise(resolve => {
        const url = `https://router.project-osrm.org/route/v1/driving/${pLon},${pLat};${cLon},${cLat}?overview=false`;
        const req = https.get(url, { timeout: 8000 }, res => {
          let buf = '';
          res.on('data', d => { buf += d; });
          res.on('end', () => {
            try {
              const j = JSON.parse(buf);
              resolve(j.code === 'Ok' && j.routes && j.routes[0]
                ? Math.round(j.routes[0].distance / 10) / 100
                : null);
            } catch (_) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    }
    function _hvKm(la1, lo1, la2, lo2) {
      if (!la1 || !lo1 || !la2 || !lo2) return 0;
      const R = 6371, r = x => x * Math.PI / 180;
      const dLa = r(la2 - la1), dLo = r(lo2 - lo1);
      const a = Math.sin(dLa / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    function _validGps(lat, lon) {
      return lat >= 8 && lat <= 37 && lon >= 68 && lon <= 97;
    }
    function _parsePrevLatLon(droppingLatLong) {
      if (!droppingLatLong) return null;
      const first = droppingLatLong.split(';')[0];
      if (!first) return null;
      const [lon, lat] = first.split(',').map(parseFloat);
      if (!_validGps(lat, lon)) return null;
      return { lat, lon };
    }

    const [dpRows] = await conn.execute(`
      SELECT id,
        COALESCE(actual_lat, 0)  AS alat, COALESCE(actual_long, 0) AS alon,
        COALESCE(reg_lat, 0)     AS rlat, COALESCE(reg_long, 0)    AS rlon,
        dropping_lat_long,
        CONCAT(unit_name,'|',route_code,'|',COALESCE(sub_route_code,'')) AS rkey
      FROM taxi_drop_point_log
      WHERE sup_date = ?
      ORDER BY unit_name, route_code, COALESCE(sub_route_code,''),
               CASE WHEN actual_arrival IS NULL THEN 1 ELSE 0 END,
               CASE WHEN HOUR(actual_arrival) < 12
                    THEN TIME_TO_SEC(actual_arrival) + 86400
                    ELSE TIME_TO_SEC(actual_arrival) END,
               CASE WHEN scheduled_arrival IS NULL THEN 1 ELSE 0 END,
               CASE WHEN HOUR(scheduled_arrival) < 12
                    THEN TIME_TO_SEC(scheduled_arrival) + 86400
                    ELSE TIME_TO_SEC(scheduled_arrival) END
    `, [syncDate]);

    // Phase 1: parallel OSRM calls (concurrency 10, 50 ms inter-batch gap)
    const OSRM_CONCURRENCY = 10;
    const roadMap = new Map();
    log(`Calling OSRM road routing for ${dpRows.length} drop points...`);
    for (let i = 0; i < dpRows.length; i += OSRM_CONCURRENCY) {
      await Promise.all(dpRows.slice(i, i + OSRM_CONCURRENCY).map(async row => {
        const alat = parseFloat(row.alat) || 0, alon = parseFloat(row.alon) || 0;
        const rlat = parseFloat(row.rlat) || 0, rlon = parseFloat(row.rlon) || 0;
        const lat = _validGps(alat, alon) ? alat : (_validGps(rlat, rlon) ? rlat : 0);
        const lon = _validGps(alat, alon) ? alon : (_validGps(rlat, rlon) ? rlon : 0);
        const prev = _parsePrevLatLon(row.dropping_lat_long);
        roadMap.set(row.id,
          (prev && _validGps(lat, lon)) ? await _osrmKm(prev.lon, prev.lat, lon, lat) : null);
      }));
      if (i + OSRM_CONCURRENCY < dpRows.length) await new Promise(r => setTimeout(r, 50));
    }

    // Phase 2: sequential pass — collect updates, Haversine fallback for OSRM failures
    let prevKey = null, prevLat = 0, prevLon = 0;
    const apiUpdates = [];
    let osrmCount = 0, hvCount = 0;
    for (const row of dpRows) {
      const alat = parseFloat(row.alat) || 0, alon = parseFloat(row.alon) || 0;
      const rlat = parseFloat(row.rlat) || 0, rlon = parseFloat(row.rlon) || 0;
      const aOk = _validGps(alat, alon), rOk = _validGps(rlat, rlon);
      const lat = aOk ? alat : (rOk ? rlat : 0);
      const lon = aOk ? alon : (rOk ? rlon : 0);
      if (row.rkey !== prevKey) { prevLat = 0; prevLon = 0; }

      const roadKm = roadMap.get(row.id);
      if (roadKm != null) {
        apiUpdates.push([roadKm, row.id, false]); // unconditional — OSRM road distance wins
        osrmCount++;
      } else {
        const prev = _parsePrevLatLon(row.dropping_lat_long);
        const hv = prev
          ? Math.round(_hvKm(prev.lat, prev.lon, lat, lon) * 100) / 100
          : (prevLat ? Math.round(_hvKm(prevLat, prevLon, lat, lon) * 100) / 100 : 0);
        apiUpdates.push([hv, row.id, true]); // only fill NULL — keeps Oracle value if present
        if (hv > 0) hvCount++;
      }

      if (lat !== 0 && lon !== 0) { prevLat = lat; prevLon = lon; }
      prevKey = row.rkey;
    }

    // Phase 3: batch-write results
    const BATCH = 200;
    for (let i = 0; i < apiUpdates.length; i += BATCH) {
      await Promise.all(apiUpdates.slice(i, i + BATCH).map(([d, id, nullOnly]) =>
        conn.execute(
          nullOnly
            ? 'UPDATE taxi_drop_point_log SET api_distance = ? WHERE id = ? AND api_distance IS NULL'
            : 'UPDATE taxi_drop_point_log SET api_distance = ? WHERE id = ?',
          [d, id]
        )
      ));
    }
    log(`api_distance: ${osrmCount} OSRM road, ${hvCount} Haversine fallback, ${dpRows.length - osrmCount - hvCount} from Oracle`);

    // ── Derive route-level taxi_delay_log from drop point arrivals ───────────
    await conn.execute('SET SESSION group_concat_max_len = 65536');
    const [delDL] = await conn.execute(
      'DELETE FROM taxi_delay_log WHERE report_date = ?', [syncDate]);
    log(`Cleared ${delDL.affectedRows} existing taxi_delay_log rows for ${syncDate}`);

    const [dlRes] = await conn.execute(`
      INSERT INTO taxi_delay_log
        (report_date, unit_name, route_name, sub_route_name, taxi_type, supply, vehicle_no,
         scheduled_departure, actual_departure, taxi_delayed, route_master_km, total_app_km,
         start_location, last_location, reached_time)
      SELECT
        sup_date,
        unit_name,
        route_name,
        COALESCE(sub_route_name, '-'),
        COALESCE(taxi_route_type, 'MAIN'),
        SUM(no_of_packets),
        MAX(vehicle_no),
        MIN(scheduled_arrival),
        MIN(actual_arrival),
        CASE
          WHEN MIN(actual_arrival) IS NULL OR MIN(scheduled_arrival) IS NULL THEN NULL
          WHEN TIME_TO_SEC(MIN(actual_arrival)) < TIME_TO_SEC(MIN(scheduled_arrival))
               AND (TIME_TO_SEC(MIN(scheduled_arrival)) - TIME_TO_SEC(MIN(actual_arrival))) > 43200
          THEN TIME_TO_SEC(MIN(actual_arrival)) + 86400 - TIME_TO_SEC(MIN(scheduled_arrival))
          ELSE TIME_TO_SEC(MIN(actual_arrival)) - TIME_TO_SEC(MIN(scheduled_arrival))
        END,
        MAX(route_master_km),
        ROUND(SUM(CASE WHEN actual_arrival IS NOT NULL OR scheduled_arrival IS NOT NULL
                       THEN COALESCE(api_distance, 0) ELSE 0 END), 2),
        SUBSTRING_INDEX(GROUP_CONCAT(
          drop_point_name
          ORDER BY CASE WHEN actual_arrival IS NULL THEN 999999
                        WHEN HOUR(actual_arrival) < 12 THEN TIME_TO_SEC(actual_arrival) + 86400
                        ELSE TIME_TO_SEC(actual_arrival) END ASC
          SEPARATOR '\x01'
        ), '\x01', 1),
        SUBSTRING_INDEX(GROUP_CONCAT(
          CASE WHEN actual_lat IS NOT NULL AND actual_long IS NOT NULL THEN drop_point_name ELSE NULL END
          ORDER BY CASE WHEN HOUR(actual_arrival) < 12 THEN TIME_TO_SEC(actual_arrival) + 86400
                        ELSE TIME_TO_SEC(actual_arrival) END DESC
          SEPARATOR '\x01'
        ), '\x01', 1),
        SEC_TO_TIME(COALESCE(MAX(
          CASE WHEN actual_lat IS NOT NULL AND actual_long IS NOT NULL AND actual_arrival IS NOT NULL
               THEN CASE WHEN HOUR(actual_arrival) < 12
                         THEN TIME_TO_SEC(actual_arrival) + 86400
                         ELSE TIME_TO_SEC(actual_arrival) END
               ELSE NULL END
        ), 0) % 86400)
      FROM taxi_drop_point_log
      WHERE sup_date = ?
      GROUP BY sup_date, unit_name, route_code, route_name, sub_route_code, sub_route_name, taxi_route_type
    `, [syncDate]);
    log(`Derived ${dlRes.affectedRows} taxi_delay_log rows for ${syncDate}`);
    log(`=== Sync complete for ${syncDate} ===`);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    try { await conn.rollback(); } catch (_) {}
    process.exitCode = 1;
  } finally {
    try { await conn.end(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
