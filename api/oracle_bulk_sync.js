'use strict';

/**
 * oracle_bulk_sync.js — Bulk-import a date range from Oracle ERP → MySQL
 *
 * Runs a single Oracle query for the full range (avoids per-date sqlplus overhead),
 * overwrites any existing records for those dates.
 *
 * Usage:
 *   node api/oracle_bulk_sync.js --from 2026-04-01 --to 2026-07-17
 *   node api/oracle_bulk_sync.js --from 2026-04-01          # to = yesterday
 *   node api/oracle_bulk_sync.js --from-last               # from day after MAX(sup_date) to yesterday
 *   node api/oracle_bulk_sync.js --rederive --from 2026-04-01 --to 2026-07-28  # recompute api_distance + taxi_delay_log only (no Oracle query)
 */

const { spawn } = require('child_process');
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
const SEP = '\x1c'; // ASCII 28 — field separator (never appears in data)

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

function hasFlag(name) {
  return process.argv.includes(name);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

function yesterday() {
  return addDays(new Date().toISOString().substring(0, 10), -1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function toDate(v) {
  const t = str(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.substring(0, 10);
  return null;
}

function toTime(v) {
  const t = str(v);
  if (!t) return null;
  let m = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}`;
  m = t.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:00`;
  return null;
}

function toIntervalSecs(v) {
  const t = str(v);
  if (!t) return null;
  const m = t.match(/^(-?)(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  const neg = m[1] === '-';
  const totalSec = parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60 + (m[4] ? parseInt(m[4], 10) : 0);
  return neg ? -totalSec : totalSec;
}

// ── GPS / api_distance helpers ─────────────────────────────────────────────────
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

// ── Build Oracle SQL for the date range ───────────────────────────────────────
function buildSqlScript(fromDate, toDate, spoolFile) {
  const D = `CHR(28)`;
  const fields = [
    'q.unit_name',
    'q.supdate',
    'q.driver_code',
    'q.vehicle_no',
    'q.taxi_stat',
    'q.route_code',
    'q.rtnm',
    'q.subrt_code',
    'q.sub_route_name',
    'q.drop_point_name',
    'q.no_of_packets',
    'q.packet_drop_date',
    'q.reg_drop_time',
    'q.packet_drop_time',
    'q.time_diff',
    'q.taxi_id',
    'q.registered_latitude',
    'q.registered_longitude',
    'q.drop_lattitude',
    'q.drop_longitude',
    'q.diff_distance',
    'q.route_master_km',
    'q.return_km',
    'q.actual_km',
    'q.tot_dist',
    'SUBSTR(q.lat_long_addr,1,500)',
    'q.vehicle_sharing_flag',
    'q.droping_latlong',
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
      x.MAPS_ROUTE_ZONE, x.VEHICLE_SHARING_FLAG
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
    and a.supdate BETWEEN TO_DATE('${fromDate}','YYYY-MM-DD') AND TO_DATE('${toDate}','YYYY-MM-DD')
  group by a.comp_code, a.unit_code, a.supdate,
      a.driver_code, a.driver_name, a.route_code, a.rtnm, a.drop_point_code, a.drop_point,
      a.APP_TIME, a.dep_time, a.taxi_id, a.trans_code, a.LATTITUDE, a.LONGITUDE,
      to_char(created_date,'dd/mm/yyyy'), trunc(created_date), LAT_LONG_ADDR, a.SUBRT_CODE
  ) x
) q
ORDER BY q.supdate;
SPOOL OFF
EXIT
`;
}

// ── Run sqlplus via /nolog + CONNECT (credentials never written to disk) ─────
function runSqlplus(sqlFile) {
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
      const allOut = stdout + stderr;
      // ORA-28002 = password expiry warning — non-fatal, query still succeeds
      const errMatch = allOut.match(/ORA-(?!28002)\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*|TNS-\d{5}[^\r\n]*/);
      if (code === 0 && !errMatch) resolve({ stdout, stderr });
      else reject(new Error(`sqlplus failed (exit ${code})${errMatch ? ': ' + errMatch[0] : ''}\n${stdout.slice(0, 500)}\n${stderr.slice(0, 500)}`));
    });

    const connectString =
      `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
      `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;

    proc.stdin.write(`CONNECT ${connectString}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Map parsed fields → 31 MySQL parameters (with AM/PM correction) ──────────
function lineToParams(f) {
  let schedTime = toTime(f[12]);
  const actualTime = toTime(f[13]);

  // Oracle's APP_TIME can be in 12-hour format without AM/PM marker.
  // Newspaper routes always dispatch at night: if scheduled looks like morning
  // (01–11h) but actual is evening/night (13–23h), add 12 hours.
  if (schedTime && actualTime) {
    const sh = parseInt(schedTime.substring(0, 2), 10);
    const ah = parseInt(actualTime.substring(0, 2), 10);
    if (sh >= 1 && sh <= 11 && ah >= 13) {
      schedTime = `${sh + 12}${schedTime.substring(2)}`;
    }
  }

  // Recompute time_diff from corrected times instead of trusting Oracle's value.
  let timeDiff;
  if (schedTime && actualTime) {
    const [sh, sm] = schedTime.split(':').map(Number);
    const [ah, am] = actualTime.split(':').map(Number);
    let diff = (ah * 3600 + am * 60) - (sh * 3600 + sm * 60);
    if (diff < -43200) diff += 86400; // cross-midnight correction
    timeDiff = diff;
  } else {
    timeDiff = toIntervalSecs(f[14]);
  }

  return [
    str(f[0]),                       //  1. unit_name
    toDate(f[1]),                    //  2. sup_date       (DD/MM/YYYY → YYYY-MM-DD)
    str(f[2]),                       //  3. driver_mobile  (driver code from ERP)
    str(f[3]),                       //  4. vehicle_no
    str(f[4]),                       //  5. taxi_route_type (MAIN / LINK)
    str(f[5]),                       //  6. route_code
    str(f[6]),                       //  7. route_name
    str(f[7]),                       //  8. sub_route_code
    str(f[8]),                       //  9. sub_route_name
    str(f[9]),                       // 10. drop_point_name
    toInt(f[10]),                    // 11. no_of_packets
    toDate(f[11]),                   // 12. packet_drop_date
    schedTime,                       // 13. scheduled_arrival (AM/PM corrected)
    actualTime,                      // 14. actual_arrival
    timeDiff,                        // 15. time_diff (recomputed from corrected sched)
    str(f[15]),                      // 16. taxi_id
    num(f[16]),                      // 17. reg_lat
    num(f[17]),                      // 18. reg_long
    num(f[18]),                      // 19. actual_lat
    num(f[19]),                      // 20. actual_long
    num(f[20]),                      // 21. dist_diff
    num(f[21]),                      // 22. route_master_km
    num(f[22]),                      // 23. return_km
    num(f[23]),                      // 24. actual_km
    num(f[24]),                      // 25. total_distance
    null,                            // 26. duration       (not in ERP query)
    str(f[25]),                      // 27. lat_long_addr
    null,                            // 28. api_distance   (computed in postProcess)
    str(f[26]) === 'Y' ? 1 : 0,     // 29. vehicle_sharing (TINYINT)
    null,                            // 30. last_drop_point (not in ERP query)
    str(f[27]),                      // 31. dropping_lat_long
  ];
}

// ── Date helpers ─────────────────────────────────────────────────────────────
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

// ── Post-process a date range: api_distance + taxi_delay_log ─────────────────
// Uses GPS data already in taxi_drop_point_log (no Oracle query needed).
async function postProcessChunk(conn, fromDate, toDate, label) {
  // 1. Compute api_distance using Oracle's dropping_lat_long (previous GPS coords)
  const [dpRows] = await conn.execute(`
    SELECT id,
      COALESCE(actual_lat, 0)  AS alat, COALESCE(actual_long, 0) AS alon,
      COALESCE(reg_lat, 0)     AS rlat, COALESCE(reg_long, 0)    AS rlon,
      dropping_lat_long,
      CONCAT(unit_name,'|',route_code,'|',COALESCE(sub_route_code,'')) AS rkey
    FROM taxi_drop_point_log
    WHERE sup_date BETWEEN ? AND ?
    ORDER BY unit_name, route_code, COALESCE(sub_route_code,''),
             CASE WHEN actual_arrival IS NULL THEN 1 ELSE 0 END,
             CASE WHEN HOUR(actual_arrival) < 12
                  THEN TIME_TO_SEC(actual_arrival) + 86400
                  ELSE TIME_TO_SEC(actual_arrival) END,
             CASE WHEN scheduled_arrival IS NULL THEN 1 ELSE 0 END,
             CASE WHEN HOUR(scheduled_arrival) < 12
                  THEN TIME_TO_SEC(scheduled_arrival) + 86400
                  ELSE TIME_TO_SEC(scheduled_arrival) END
  `, [fromDate, toDate]);

  let prevKey = null, prevLat = 0, prevLon = 0;
  const apiUpdates = [];
  for (const row of dpRows) {
    const alat = parseFloat(row.alat) || 0, alon = parseFloat(row.alon) || 0;
    const rlat = parseFloat(row.rlat) || 0, rlon = parseFloat(row.rlon) || 0;
    const aOk = _validGps(alat, alon), rOk = _validGps(rlat, rlon);
    const lat = aOk ? alat : (rOk ? rlat : 0);
    const lon = aOk ? alon : (rOk ? rlon : 0);
    if (row.rkey !== prevKey) { prevLat = 0; prevLon = 0; }

    const prev = _parsePrevLatLon(row.dropping_lat_long);
    let dist;
    if (prev) {
      dist = Math.round(_hvKm(prev.lat, prev.lon, lat, lon) * 100) / 100;
    } else {
      dist = prevLat ? Math.round(_hvKm(prevLat, prevLon, lat, lon) * 100) / 100 : 0;
    }

    apiUpdates.push([dist, row.id]);
    if (lat !== 0 && lon !== 0) { prevLat = lat; prevLon = lon; }
    prevKey = row.rkey;
  }

  const BATCH = 200;
  for (let i = 0; i < apiUpdates.length; i += BATCH) {
    await Promise.all(apiUpdates.slice(i, i + BATCH).map(([d, id]) =>
      conn.execute('UPDATE taxi_drop_point_log SET api_distance = ? WHERE id = ?', [d, id])
    ));
  }
  log(`${label} api_distance computed for ${apiUpdates.length} drop points`);

  // 2. Rebuild taxi_delay_log for this date range
  const [delDL] = await conn.execute(
    'DELETE FROM taxi_delay_log WHERE report_date BETWEEN ? AND ?', [fromDate, toDate]);

  const [dlRes] = await conn.execute(`
    INSERT INTO taxi_delay_log
      (report_date, unit_name, route_name, sub_route_name, taxi_type, supply, vehicle_no,
       scheduled_departure, actual_departure, taxi_delayed, route_master_km, total_app_km)
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
      ROUND(SUM(COALESCE(api_distance, 0)), 2)
    FROM taxi_drop_point_log
    WHERE sup_date BETWEEN ? AND ?
    GROUP BY sup_date, unit_name, route_code, route_name, sub_route_code, sub_route_name, taxi_route_type
  `, [fromDate, toDate]);
  log(`${label} Derived ${dlRes.affectedRows} taxi_delay_log rows (${fromDate} → ${toDate})`);
}

// ── Sync one chunk: Oracle query → parse → overwrite in MySQL ─────────────────
async function syncChunk(conn, chunk, tmpDir, chunkNo, totalChunks) {
  const sqlFile   = path.join(tmpDir, `query_${chunkNo}.sql`);
  const spoolFile = path.join(tmpDir, `data_${chunkNo}.txt`);

  fs.writeFileSync(sqlFile, buildSqlScript(chunk.from, chunk.to, spoolFile), 'utf8');
  log(`[chunk ${chunkNo}/${totalChunks}] Querying Oracle: ${chunk.from} → ${chunk.to} ...`);

  const startOracle = Date.now();
  const rc = await runSqlplus(sqlFile);
  const oracleSecs = Math.round((Date.now() - startOracle) / 1000);

  // A timeout SIGKILLs sqlplus and resolves -1, leaving a PARTIALLY written spool that
  // still passes the existsSync guard below. Falling through would delete the chunk's
  // date range and re-insert only what made it — silent data loss.
  if (typeof rc === 'number' && rc !== 0) {
    throw new Error(`sqlplus exit ${rc}${rc === -1 ? ' (timed out and was killed)' : ''} ` +
      `for ${chunk.from}→${chunk.to} — MySQL left untouched`);
  }

  if (!fs.existsSync(spoolFile)) {
    throw new Error('sqlplus produced no spool file');
  }

  const raw = fs.readFileSync(spoolFile, 'utf8');

  // ORA-28002 = password expiry warning — non-fatal
  const spoolErr = raw.match(/ORA-(?!28002)\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*/);
  if (spoolErr) throw new Error(`Oracle error in output: ${spoolErr[0]}`);

  const lines = raw.split(/\r?\n/).filter(l => l.includes(SEP));
  log(`[chunk ${chunkNo}/${totalChunks}] Oracle returned ${lines.length} rows in ${oracleSecs}s`);

  if (lines.length === 0) {
    log(`[chunk ${chunkNo}/${totalChunks}] 0 rows — keeping existing data for this range (no delete)`);
    return { inserted: 0, errors: 0 };
  }

  const parsed   = [];
  const routeMap = new Map();
  let badLines = 0;
  for (const line of lines) {
    const f = line.split(SEP);
    if (f.length !== 28) { badLines++; continue; }
    parsed.push(f);
    const rc = str(f[5]), rn = str(f[6]);
    if (rc && rn) routeMap.set(rc, rn);
  }
  if (badLines > 0) log(`[chunk ${chunkNo}/${totalChunks}] WARNING: skipped ${badLines} malformed lines`);

  await conn.beginTransaction();
  try {
    const [delRes] = await conn.execute(
      'DELETE FROM taxi_drop_point_log WHERE sup_date BETWEEN ? AND ?',
      [chunk.from, chunk.to]
    );

    for (const [rc, rn] of routeMap) {
      await conn.execute(
        `INSERT INTO routes (route_code, route_name)
         VALUES (?,?)
         ON DUPLICATE KEY UPDATE route_name = VALUES(route_name)`,
        [rc, rn]
      );
    }

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
        if (errors <= 5) log(`  Row error: ${err.message} — date:${f[1]} route:${f[5]}`);
      }
    }

    await conn.commit();
    log(`[chunk ${chunkNo}/${totalChunks}] Replaced ${delRes.affectedRows} old rows with ${inserted} new rows` +
        (errors > 0 ? ` (${errors} row errors)` : ''));
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
  const REDERIVE = hasFlag('--rederive');
  const FROM_LAST = hasFlag('--from-last');
  const CHUNK_DAYS = parseInt(getArg('--chunk-days') || '10', 10);

  const conn = await mysql.createConnection(MYSQL_CONFIG);

  let fromDate, toDate;

  try {
    if (FROM_LAST) {
      const [rows] = await conn.execute(
        "SELECT DATE_FORMAT(MAX(sup_date),'%Y-%m-%d') AS mx FROM taxi_drop_point_log"
      );
      const lastDate = rows[0]?.mx;
      if (!lastDate) {
        log('ERROR: No data in taxi_drop_point_log — use --from to specify start date');
        process.exitCode = 1;
        return;
      }
      fromDate = addDays(lastDate, 1);
      toDate = getArg('--to') || yesterday();
      log(`Auto-detected: last synced date = ${lastDate}. Syncing ${fromDate} → ${toDate}`);
    } else {
      const fromArg = getArg('--from');
      const toArg   = getArg('--to');
      if (!fromArg || !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
        console.error('Usage: node api/oracle_bulk_sync.js --from YYYY-MM-DD [--to YYYY-MM-DD]');
        console.error('       node api/oracle_bulk_sync.js --from-last [--to YYYY-MM-DD]');
        console.error('       node api/oracle_bulk_sync.js --rederive --from YYYY-MM-DD [--to YYYY-MM-DD]');
        process.exitCode = 1;
        return;
      }
      fromDate = fromArg;
      toDate   = toArg || yesterday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
        console.error('--to must be YYYY-MM-DD');
        process.exitCode = 1;
        return;
      }
    }

    if (fromDate > toDate) {
      log(`Nothing to sync: ${fromDate} > ${toDate} — already up to date`);
      return;
    }

    const chunks = buildChunks(fromDate, toDate, CHUNK_DAYS);
    const days = chunks.reduce((n, c) =>
      n + Math.round((new Date(c.to) - new Date(c.from)) / 86400000) + 1, 0);

    if (REDERIVE) {
      // Recompute api_distance + taxi_delay_log from existing MySQL data (no Oracle query)
      log(`=== Rederive mode: api_distance + taxi_delay_log for ${fromDate} → ${toDate} (${days} days, ${chunks.length} chunks) ===`);
      for (let i = 0; i < chunks.length; i++) {
        await postProcessChunk(conn, chunks[i].from, chunks[i].to, `[chunk ${i + 1}/${chunks.length}]`);
      }
      log(`=== Rederive complete ===`);
      return;
    }

    // Full sync: Oracle → MySQL → postProcess
    log(`=== Oracle bulk sync started | ${fromDate} → ${toDate} (${days} days, ${chunks.length} chunks of ≤${CHUNK_DAYS} days) ===`);

    for (const k of ['ORA_HOST', 'ORA_SERVICE', 'ORA_USER', 'ORA_PASSWORD']) {
      if (!process.env[k]) { log(`ERROR: ${k} not set in .env`); process.exitCode = 1; return; }
    }
    if (!fs.existsSync(SQLPLUS)) {
      log(`ERROR: sqlplus not found at ${SQLPLUS}`); process.exitCode = 1; return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrika-bulk-'));
    let totalInserted = 0, totalErrors = 0;
    const failedChunks = [];

    try {
      const MAX_ATTEMPTS = 3;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let done = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
          try {
            const r = await syncChunk(conn, chunk, tmpDir, i + 1, chunks.length);
            totalInserted += r.inserted;
            totalErrors   += r.errors;
            if (r.inserted > 0) {
              await postProcessChunk(conn, chunk.from, chunk.to, `[chunk ${i + 1}/${chunks.length}]`);
            }
            done = true;
          } catch (err) {
            log(`[chunk ${i + 1}/${chunks.length}] attempt ${attempt} FAILED: ${err.message.split('\n')[0]}`);
            if (attempt === MAX_ATTEMPTS) {
              failedChunks.push(chunk);
            } else {
              const waitSec = attempt * 60;
              log(`  waiting ${waitSec}s before retry ...`);
              await sleep(waitSec * 1000);
            }
          }
        }
      }

      if (failedChunks.length > 0) {
        log(`=== Bulk sync finished WITH FAILURES: ${totalInserted} rows inserted; failed ranges: ` +
            failedChunks.map(c => `${c.from}→${c.to}`).join(', ') + ' ===');
        process.exitCode = 1;
      } else {
        log(`=== Bulk sync complete: ${fromDate} → ${toDate} | ${totalInserted} rows inserted` +
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
