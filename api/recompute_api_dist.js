// One-time script: recompute api_distance + re-derive taxi_delay_log
// Usage: node api/recompute_api_dist.js [YYYY-MM-DD]
const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const syncDate = process.argv[2] || '2026-07-26';
const CFG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || 'Patrika@2026',
  database: process.env.DB_NAME     || 'patrika_vitran',
};

function hv(la1, lo1, la2, lo2) {
  if (!la1 || !lo1 || !la2 || !lo2) return 0;
  const R = 6371, r = x => x * Math.PI / 180;
  const dLa = r(la2 - la1), dLo = r(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function validGps(lat, lon) {
  return lat >= 8 && lat <= 37 && lon >= 68 && lon <= 97;
}

(async () => {
  const conn = await mysql.createConnection(CFG);
  try {
    // 1. Fetch drops — include dropping_lat_long (Oracle's prev-point coords)
    const [dpRows] = await conn.execute(`
      SELECT id,
        COALESCE(actual_lat,  0) AS alat, COALESCE(actual_long, 0) AS alon,
        COALESCE(reg_lat,     0) AS rlat, COALESCE(reg_long,    0) AS rlon,
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
    console.log(`Fetched ${dpRows.length} drop points for ${syncDate}`);

    // 2. Compute haversine using Oracle's previous-point coordinates when available.
    // dropping_lat_long = "prev_lon,prev_lat;curr_lon,curr_lat" — Oracle's route sequence.
    // Falls back to sequential time-ordered haversine when dropping_lat_long is null.
    function parsePrev(droppingLatLong) {
      if (!droppingLatLong) return null;
      const first = droppingLatLong.split(';')[0];
      if (!first) return null;
      const [lon, lat] = first.split(',').map(parseFloat);
      if (!validGps(lat, lon)) return null;
      return { lat, lon };
    }
    let pk = null, pl = 0, po = 0;
    const upd = [];
    for (const row of dpRows) {
      const alat = parseFloat(row.alat) || 0, alon = parseFloat(row.alon) || 0;
      const rlat = parseFloat(row.rlat) || 0, rlon = parseFloat(row.rlon) || 0;
      const aOk = validGps(alat, alon), rOk = validGps(rlat, rlon);
      const lat = aOk ? alat : (rOk ? rlat : 0);
      const lon = aOk ? alon : (rOk ? rlon : 0);
      if (row.rkey !== pk) { pl = 0; po = 0; }
      const prev = parsePrev(row.dropping_lat_long);
      let d;
      if (prev) {
        d = Math.round(hv(prev.lat, prev.lon, lat, lon) * 100) / 100;
      } else {
        d = pl ? Math.round(hv(pl, po, lat, lon) * 100) / 100 : 0;
      }
      upd.push([d, row.id]);
      if (lat !== 0 && lon !== 0) { pl = lat; po = lon; }
      pk = row.rkey;
    }

    // 3. Batch UPDATE api_distance
    const B = 200;
    for (let i = 0; i < upd.length; i += B) {
      await Promise.all(upd.slice(i, i + B).map(([d, id]) =>
        conn.execute('UPDATE taxi_drop_point_log SET api_distance = ? WHERE id = ?', [d, id])
      ));
    }
    console.log(`Updated api_distance for ${upd.length} rows`);

    // 4. Fix AM/PM confused scheduled times (Oracle stores some night times as 12-hour AM).
    // If scheduled is morning (01-11h) but actual is evening (13-23h), add 12 hours.
    const [ampmRes] = await conn.execute(`
      UPDATE taxi_drop_point_log
      SET time_diff = (
            CASE
              WHEN actual_arrival IS NULL THEN NULL
              WHEN TIME_TO_SEC(actual_arrival) - (TIME_TO_SEC(scheduled_arrival) + 43200) < -43200
              THEN TIME_TO_SEC(actual_arrival) + 86400 - (TIME_TO_SEC(scheduled_arrival) + 43200)
              ELSE TIME_TO_SEC(actual_arrival) - (TIME_TO_SEC(scheduled_arrival) + 43200)
            END
          ),
          scheduled_arrival = ADDTIME(scheduled_arrival, '12:00:00')
      WHERE sup_date = ?
        AND HOUR(scheduled_arrival) BETWEEN 1 AND 11
        AND actual_arrival IS NOT NULL
        AND HOUR(actual_arrival) >= 13
    `, [syncDate]);
    console.log(`Fixed ${ampmRes.affectedRows} AM/PM confused scheduled times`);

    // 5. Verify WAIR route
    const [wair] = await conn.execute(`
      SELECT route_name,
             ROUND(SUM(actual_km),2) AS oracle_km,
             MAX(route_master_km) AS plan_km
      FROM taxi_drop_point_log WHERE sup_date = ? AND route_name LIKE '%WAIR%'
      GROUP BY route_name
    `, [syncDate]);
    console.log('WAIR drop-point sum:', JSON.stringify(wair));

    // 6. Re-derive taxi_delay_log
    const [del1] = await conn.execute('DELETE FROM taxi_delay_log WHERE report_date = ?', [syncDate]);
    console.log(`Cleared ${del1.affectedRows} taxi_delay_log rows`);

    const [ins] = await conn.execute(`
      INSERT INTO taxi_delay_log
        (report_date, unit_name, route_name, sub_route_name, taxi_type, supply, vehicle_no,
         scheduled_departure, actual_departure, taxi_delayed, route_master_km, total_app_km)
      SELECT
        sup_date, unit_name, route_name,
        COALESCE(sub_route_name, '-'),
        COALESCE(taxi_route_type, 'MAIN'),
        SUM(no_of_packets), MAX(vehicle_no),
        MIN(scheduled_arrival), MIN(actual_arrival),
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
      WHERE sup_date = ?
      GROUP BY sup_date, unit_name, route_code, route_name, sub_route_code, sub_route_name, taxi_route_type
    `, [syncDate]);
    console.log(`Derived ${ins.affectedRows} taxi_delay_log rows`);

    // 7. Verify key routes
    const [rv] = await conn.execute(`
      SELECT route_name,
             TIME_FORMAT(scheduled_departure,'%H:%i') AS sched,
             TIME_FORMAT(actual_departure,'%H:%i') AS actual,
             ROUND(taxi_delayed/60,0) AS delay_min,
             route_master_km AS plan_km, total_app_km AS app_km
      FROM taxi_delay_log
      WHERE report_date = ?
        AND (route_name LIKE '%WAIR%' OR route_name LIKE '%ASHOK NAGAR%')
      LIMIT 10
    `, [syncDate]);
    console.log('Routes view:', JSON.stringify(rv, null, 2));

  } finally {
    await conn.end();
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
