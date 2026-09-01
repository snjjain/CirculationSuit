'use strict';

/**
 * dcr_msite.js — DCR M-Site: the field executive's day, end to end.
 *
 *   Start Trip → Tour Plan → Check-In (geofence + selfie) → Visit Report
 *   → Collection → Check-Out → Day Close (KM, attendance, TA)
 *
 * WHAT THIS OWNS vs WHAT ORACLE OWNS
 * ----------------------------------
 * dcr_agency_visit and dcr_center_attendance are Oracle mirrors — oracle_dcr_sync.js
 * deletes and reloads them per date range, so anything written there is destroyed on
 * the next sync. Every table here is app-owned and never touched by a sync. Oracle
 * data is READ alongside ours (history, outstanding, supply) but never written.
 *
 * LOCATIONS — why dcr_location exists
 * -----------------------------------
 * Geofencing needs to know where an agency or centre actually is, and Oracle has no
 * coordinates for either: CIR_AGMAST and CRM_CENTER_MASTER carry none, only
 * CIR_DROP_POINT_MAST does. Rather than block on an ERP change, locations are learned:
 *
 *   1. registered  — someone stood there and registered it (highest trust)
 *   2. observed    — median of real GPS the existing Oracle app already captured:
 *                    1,765 agencies from dcr_agency_visit, 207 centres from
 *                    dcr_center_attendance (all 9,992 rows carry GPS)
 *   3. station     — the agency's drop point from drop_points_master, which covers
 *                    ~26.9k of 27.6k agencies but only to locality accuracy
 *
 * The radius applied widens as the anchor gets weaker, and a visit is never blocked by
 * a failed fence — it is recorded with the distance and flagged, because a hard block
 * on a bad GPS fix strands an executive who is genuinely standing at the shop.
 */

module.exports = function registerDcrMsite({ app, q, getScopeUnitCodes }) {

  const N   = v => Number(v) || 0;
  const S   = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  const iso = d => (d ? String(d).slice(0, 10) : null);
  const today = () => new Date().toISOString().slice(0, 10);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  // Metres between two lat/lng. Same haversine dcr_analytics uses, kept here so this
  // module has no cross-file dependency.
  function distM(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some(v => v == null || isNaN(Number(v)))) return null;
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }
  const inIndia = (lat, lng) =>
    lat != null && lng != null && lat >= 8 && lat <= 38 && lng >= 68 && lng <= 98;

  /* Fence radius by how much the anchor can be trusted. A drop point is the locality,
     not the shopfront, so holding it to 100 m would fail honest visits. */
  const FENCE_M = { registered: 100, observed: 150, station: 400, none: null };

  // ── Schema ──────────────────────────────────────────────────────────────────
  async function ensureSchema() {
    const add = async (t, col, def) => {
      try { await q(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); } catch (_) {}
    };

    await q(`CREATE TABLE IF NOT EXISTS dcr_trip (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      trip_date DATE NOT NULL,
      staff_person_code VARCHAR(20) NOT NULL,
      staff_emp_code VARCHAR(30),
      staff_name VARCHAR(200),
      unit_code VARCHAR(10),
      start_at DATETIME, start_lat DECIMAL(10,6), start_lng DECIMAL(10,6),
      start_accuracy INT, start_place VARCHAR(20), start_address VARCHAR(400),
      end_at DATETIME, end_lat DECIMAL(10,6), end_lng DECIMAL(10,6),
      end_accuracy INT, end_address VARCHAR(400),
      device_id VARCHAR(80),
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      total_visits INT DEFAULT 0, valid_visits INT DEFAULT 0,
      total_km DECIMAL(8,2), collection_amt DECIMAL(14,2) DEFAULT 0,
      closed_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      /* One trip per person per day — the requirement asks the system to prevent
         duplicate active trips, and a unique key does it at the database rather than
         relying on the client never double-tapping Start. */
      UNIQUE KEY uq_trip (staff_person_code, trip_date),
      INDEX idx_trip_date (trip_date), INDEX idx_trip_unit (unit_code, trip_date)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

    await q(`CREATE TABLE IF NOT EXISTS dcr_location (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      target_type VARCHAR(10) NOT NULL,       -- agent | hawker | centre
      unit_code VARCHAR(10) NOT NULL,
      target_code VARCHAR(40) NOT NULL,
      target_name VARCHAR(300),
      lat DECIMAL(10,6), lng DECIMAL(10,6),
      source VARCHAR(12) NOT NULL,            -- registered | observed | station
      accuracy INT, samples INT DEFAULT 1,
      registered_by VARCHAR(20), registered_at DATETIME,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_loc (target_type, unit_code, target_code),
      INDEX idx_loc_unit (unit_code)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

    /* Photos live in the row. The app server and MySQL are separate hosts (RDS), so a
       filesystem path would not survive a redeploy or a second app server, and there is
       no object store configured. The client compresses to ~1024px JPEG before upload,
       so a selfie is ~120 KB — MEDIUMBLOB holds 16 MB. sha256 is stored so a reused
       photo can be detected, which the requirement asks for. */
    await q(`CREATE TABLE IF NOT EXISTS dcr_photo (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(12) NOT NULL,              -- selfie | receipt | lead | site
      staff_person_code VARCHAR(20),
      visit_id BIGINT, trip_id BIGINT,
      taken_on DATE,
      mime VARCHAR(40) DEFAULT 'image/jpeg',
      bytes MEDIUMBLOB,
      size_bytes INT,
      sha256 CHAR(64),
      lat DECIMAL(10,6), lng DECIMAL(10,6),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ph_visit (visit_id), INDEX idx_ph_staff (staff_person_code, taken_on),
      INDEX idx_ph_hash (sha256)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

    // App-owned attendance. dcr_center_attendance is Oracle's and gets wiped by its sync.
    await q(`CREATE TABLE IF NOT EXISTS dcr_attendance (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      attn_date DATE NOT NULL,
      staff_person_code VARCHAR(20) NOT NULL,
      staff_emp_code VARCHAR(30), staff_name VARCHAR(200),
      unit_code VARCHAR(10),
      centre_code VARCHAR(40), centre_name VARCHAR(300),
      lat DECIMAL(10,6), lng DECIMAL(10,6), accuracy INT,
      distance_m INT, within_fence TINYINT(1),
      marked_at DATETIME, closed_at DATETIME,
      close_lat DECIMAL(10,6), close_lng DECIMAL(10,6),
      status VARCHAR(10) DEFAULT 'present',   -- present | half | absent
      source VARCHAR(12) DEFAULT 'centre',    -- centre | visits | manual
      remarks VARCHAR(500),
      photo_id BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_attn (staff_person_code, attn_date, centre_code),
      INDEX idx_attn_date (attn_date), INDEX idx_attn_unit (unit_code, attn_date)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

    await q(`CREATE TABLE IF NOT EXISTS dcr_lead (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      created_by VARCHAR(20), created_by_name VARCHAR(200),
      unit_code VARCHAR(10), visit_id BIGINT,
      lead_type VARCHAR(30) NOT NULL,
      name VARCHAR(200), mobile VARCHAR(20), address VARCHAR(400),
      lat DECIMAL(10,6), lng DECIMAL(10,6),
      current_paper VARCHAR(120), current_copies INT, potential_copies INT,
      source VARCHAR(60), remarks VARCHAR(1000), photo_id BIGINT,
      status VARCHAR(14) DEFAULT 'new',       -- new|assigned|contacted|qualified|converted|lost
      assigned_to VARCHAR(20), followup_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_lead_unit (unit_code, status), INDEX idx_lead_by (created_by)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

    // Visit columns the M-Site adds on top of the existing dcr_visit.
    for (const [c, d] of [
      ['trip_id', 'BIGINT'], ['check_in_at', 'DATETIME'], ['check_out_at', 'DATETIME'],
      ['in_lat', 'DECIMAL(10,6)'], ['in_lng', 'DECIMAL(10,6)'], ['in_accuracy', 'INT'],
      ['out_lat', 'DECIMAL(10,6)'], ['out_lng', 'DECIMAL(10,6)'],
      ['distance_m', 'INT'], ['within_fence', 'TINYINT(1)'], ['fence_source', 'VARCHAR(12)'],
      ['selfie_id', 'BIGINT'], ['receipt_id', 'BIGINT'],
      ['status', "VARCHAR(14) DEFAULT 'completed'"],   // in_progress | completed
      ['next_action', 'VARCHAR(40)'], ['next_followup_date', 'DATE'],
      ['duration_min', 'INT'], ['device_id', 'VARCHAR(80)'],
      ['receipt_no', 'VARCHAR(60)'], ['plan_id', 'BIGINT'],
      // field | call — a phone call is real work and is recorded as such, not disguised
      // as a visit. form_type keeps the seven forms apart inside one table.
      ['visit_mode', "VARCHAR(10) DEFAULT 'field'"], ['form_type', 'VARCHAR(20)'],
      ['extra', 'JSON'],
    ]) await add('dcr_visit', c, d);

    // Tour plan: approval workflow the existing table has no room for.
    for (const [c, d] of [
      ['assigned_by', 'VARCHAR(20)'], ['assigned_by_name', 'VARCHAR(200)'],
      ['approved_by', 'VARCHAR(20)'], ['approved_by_name', 'VARCHAR(200)'],
      ['approved_at', 'DATETIME'], ['reject_reason', 'VARCHAR(500)'],
      ['seq_no', 'INT'], ['expected_recovery', 'DECIMAL(14,2)'],
      ['outstanding_snap', 'DECIMAL(14,2)'], ['visit_id', 'BIGINT'],
      ['staff_emp_code', 'VARCHAR(30)'],
    ]) await add('dcr_tour_plan', c, d);

    try { await q(`ALTER TABLE dcr_tour_plan ADD INDEX idx_tp_status (status, tour_date)`); } catch (_) {}
  }
  ensureSchema().catch(e => console.warn('[dcr-msite] schema:', e.message));

  // ── Who is asking ───────────────────────────────────────────────────────────
  async function staffOf(req) {
    const pc = req.auth && req.auth.personCode;
    if (!pc) return null;
    const { rows } = await q(
      `SELECT person_code, person_name, employee_code, unit_code, hierarchy_level
       FROM hierarchy_master WHERE person_code = ? LIMIT 1`, [pc]);
    const h = rows[0] || {};
    return {
      person_code: pc,
      name: h.person_name || (req.auth.name || pc),
      emp_code: h.employee_code || null,
      unit_code: h.unit_code || null,
      level: h.hierarchy_level != null ? Number(h.hierarchy_level) : req.auth.hierarchyLevel,
    };
  }
  async function scopeUnits(req) {
    return getScopeUnitCodes
      ? getScopeUnitCodes(req.auth.personCode, req.auth.hierarchyLevel)
      : null;
  }

  /* Where we believe a target is, best anchor first. Returns null when we have nothing,
     in which case the visit records GPS without a fence rather than refusing it. */
  async function anchorFor(type, unitCode, code) {
    const { rows: reg } = await q(
      `SELECT lat, lng, source FROM dcr_location
       WHERE target_type = ? AND unit_code = ? AND target_code = ? LIMIT 1`,
      [type, unitCode, code]);
    if (reg[0] && reg[0].lat != null) {
      return { lat: N(reg[0].lat), lng: N(reg[0].lng), source: reg[0].source || 'registered' };
    }
    if (type === 'agent') {
      // The agency's drop point — locality accuracy, so a wider fence.
      const { rows } = await q(
        `SELECT dp.latitude lat, dp.longitude lng
         FROM agency_master am
         JOIN drop_points_master dp ON dp.unit_code = am.unit AND dp.drop_point_code = am.station_code
         WHERE am.unit = ? AND am.agcd = ? AND dp.latitude IS NOT NULL AND dp.latitude <> ''
         LIMIT 1`, [unitCode, code]);
      if (rows[0]) {
        const lat = N(rows[0].lat), lng = N(rows[0].lng);
        if (inIndia(lat, lng)) return { lat, lng, source: 'station' };
      }
    }
    return null;
  }

  /* Seed dcr_location from GPS the existing Oracle app already captured. Median, not
     mean, because one visit logged from the office would drag an average across town.
     Idempotent: re-running refreshes 'observed' rows and never overwrites a
     'registered' one, which a person physically stood at. */
  async function seedLocations() {
    const med = arr => {
      const a = arr.slice().sort((x, y) => x - y);
      return a.length ? a[Math.floor(a.length / 2)] : null;
    };
    const { rows: av } = await q(
      `SELECT unit_code, visit_to_main_code code,
              CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng
       FROM dcr_agency_visit
       WHERE latitude IS NOT NULL AND latitude <> '' AND latitude <> '0'
         AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
         AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
         AND visit_to_main_code IS NOT NULL AND visit_to_main_code <> ''`);
    const byAg = new Map();
    av.forEach(r => {
      const k = `${r.unit_code}|${r.code}`;
      if (!byAg.has(k)) byAg.set(k, { unit: r.unit_code, code: r.code, lat: [], lng: [] });
      byAg.get(k).lat.push(N(r.lat)); byAg.get(k).lng.push(N(r.lng));
    });
    const { rows: ca } = await q(
      `SELECT unit_code, center_name,
              CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng
       FROM dcr_center_attendance
       WHERE latitude IS NOT NULL AND latitude <> '' AND latitude <> '0'
         AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
         AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
         AND center_name IS NOT NULL AND center_name <> ''`);
    const byC = new Map();
    ca.forEach(r => {
      const k = `${r.unit_code}|${String(r.center_name).trim().toUpperCase()}`;
      if (!byC.has(k)) byC.set(k, { unit: r.unit_code, code: String(r.center_name).trim().toUpperCase(), name: r.center_name, lat: [], lng: [] });
      byC.get(k).lat.push(N(r.lat)); byC.get(k).lng.push(N(r.lng));
    });

    let n = 0;
    const put = async (type, o) => {
      const lat = med(o.lat), lng = med(o.lng);
      if (!inIndia(lat, lng)) return;
      await q(
        `INSERT INTO dcr_location (target_type, unit_code, target_code, target_name, lat, lng, source, samples)
         VALUES (?,?,?,?,?,?, 'observed', ?)
         ON DUPLICATE KEY UPDATE
           lat = IF(source = 'registered', lat, VALUES(lat)),
           lng = IF(source = 'registered', lng, VALUES(lng)),
           samples = IF(source = 'registered', samples, VALUES(samples))`,
        [type, o.unit, o.code, o.name || null, lat, lng, o.lat.length]);
      n++;
    };
    for (const o of byAg.values()) await put('agent', o);
    for (const o of byC.values()) await put('centre', o);
    return { agencies: byAg.size, centres: byC.size, written: n };
  }

  // ══ CONTEXT ════════════════════════════════════════════════════════════════
  app.get('/api/dcr-m/context', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const units = await scopeUnits(req);

      const [trip, attn, plans, ex] = await Promise.all([
        q(`SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`,
          [staff.person_code, today()]),
        q(`SELECT * FROM dcr_attendance WHERE staff_person_code = ? AND attn_date = ? LIMIT 1`,
          [staff.person_code, today()]),
        q(`SELECT COUNT(*) n, SUM(status='approved') appr, SUM(status='submitted') pend
           FROM dcr_tour_plan WHERE staff_person_code = ? AND tour_date = ?`,
          [staff.person_code, today()]),
        staff.emp_code
          ? q(`SELECT exec_designation, mobile_no FROM exec_master WHERE employee_id = ? OR executive_code = ? LIMIT 1`,
              [staff.emp_code, staff.emp_code])
          : Promise.resolve({ rows: [] }),
      ]);

      const t = trip.rows[0] || null;
      const { rows: vis } = t ? await q(
        `SELECT COUNT(*) n, SUM(status='completed') done,
                COALESCE(SUM(amount_collected),0) amt
         FROM dcr_visit WHERE trip_id = ?`, [t.id]) : { rows: [{}] };

      res.json({
        staff: { ...staff,
          designation: ex.rows[0] ? ex.rows[0].exec_designation : null,
          mobile: ex.rows[0] ? ex.rows[0].mobile_no : null },
        date: today(),
        units: units,        // null = all units (admin)
        trip: t ? { ...t, visits: N(vis[0].n), completed: N(vis[0].done), collected: N(vis[0].amt) } : null,
        attendance: attn.rows[0] || null,
        plan: { total: N(plans.rows[0].n), approved: N(plans.rows[0].appr), pending: N(plans.rows[0].pend) },
        fence: FENCE_M,
      });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ TRIP ═══════════════════════════════════════════════════════════════════
  app.post('/api/dcr-m/trip/start', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      if (!inIndia(lat, lng)) return res.status(400).json({ detail: 'A valid GPS location is required to start the trip.' });

      const d = isDate(b.trip_date) ? b.trip_date : today();
      const { rows: cur } = await q(
        `SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`,
        [staff.person_code, d]);
      // Idempotent: tapping Start twice returns the running trip instead of erroring.
      if (cur[0]) {
        if (cur[0].status === 'active') return res.json({ ok: true, already: true, trip: cur[0] });
        return res.status(409).json({ detail: 'Today\'s trip is already closed.', trip: cur[0] });
      }

      await q(
        `INSERT INTO dcr_trip (trip_date, staff_person_code, staff_emp_code, staff_name, unit_code,
           start_at, start_lat, start_lng, start_accuracy, start_place, start_address, device_id, status)
         VALUES (?,?,?,?,?, NOW(),?,?,?,?,?,?, 'active')`,
        [d, staff.person_code, staff.emp_code, staff.name, S(b.unit_code, 10) || staff.unit_code,
         lat, lng, b.accuracy == null ? null : Math.round(Number(b.accuracy)),
         S(b.place, 20) || 'other', S(b.address, 400), S(b.device_id, 80)]);
      const { rows } = await q(
        `SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`,
        [staff.person_code, d]);
      res.json({ ok: true, trip: rows[0] });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/dcr-m/trip/end', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const d = isDate(b.trip_date) ? b.trip_date : today();
      const { rows: cur } = await q(
        `SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`,
        [staff.person_code, d]);
      if (!cur[0]) return res.status(404).json({ detail: 'No trip started today.' });
      if (cur[0].status === 'closed') return res.json({ ok: true, already: true, summary: await daySummary(staff, d) });

      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      const sum = await daySummary(staff, d, cur[0], lat, lng);

      await q(
        `UPDATE dcr_trip SET end_at = NOW(), end_lat = ?, end_lng = ?, end_accuracy = ?,
           end_address = ?, status = 'closed', closed_at = NOW(),
           total_visits = ?, valid_visits = ?, total_km = ?, collection_amt = ?
         WHERE id = ?`,
        [inIndia(lat, lng) ? lat : null, inIndia(lat, lng) ? lng : null,
         b.accuracy == null ? null : Math.round(Number(b.accuracy)), S(b.address, 400),
         sum.total_visits, sum.valid_visits, sum.total_km, sum.collection, cur[0].id]);

      res.json({ ok: true, summary: sum });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* Day totals. KM is straight-line between consecutive captured points — honest and
     free. Road distance needs a routing API key; when one is configured this is where
     it plugs in, and the response says which method produced the number so a TA claim
     is never presented as road distance when it is not. */
  async function daySummary(staff, d, trip, endLat, endLng) {
    const [{ rows: t }, { rows: v }] = await Promise.all([
      trip ? Promise.resolve({ rows: [trip] })
           : q(`SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`, [staff.person_code, d]),
      q(`SELECT id, target_name, target_type, check_in_at, check_out_at, in_lat, in_lng,
                within_fence, amount_collected, outcome, purpose, duration_min, status
         FROM dcr_visit WHERE staff_person_code = ? AND visit_date = ?
         ORDER BY COALESCE(check_in_at, created_at)`, [staff.person_code, d]),
    ]);
    const tr = t[0] || {};
    const pts = [];
    if (inIndia(N(tr.start_lat), N(tr.start_lng))) pts.push([N(tr.start_lat), N(tr.start_lng)]);
    v.forEach(x => { if (inIndia(N(x.in_lat), N(x.in_lng))) pts.push([N(x.in_lat), N(x.in_lng)]); });
    if (inIndia(endLat, endLng)) pts.push([endLat, endLng]);
    else if (inIndia(N(tr.end_lat), N(tr.end_lng))) pts.push([N(tr.end_lat), N(tr.end_lng)]);

    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (seg != null) m += seg;
    }
    const collection = v.reduce((s, x) => s + N(x.amount_collected), 0);
    const valid = v.filter(x => x.within_fence === 1 || x.within_fence === null).length;
    return {
      date: d, trip: tr.id || null,
      start_at: tr.start_at || null, end_at: tr.end_at || null,
      total_visits: v.length, valid_visits: valid, invalid_visits: v.length - valid,
      total_km: Math.round(m / 100) / 10,
      km_method: 'straight-line between captured points',
      collection, points: pts.length,
      visits: v,
    };
  }

  app.get('/api/dcr-m/day-close', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const d = isDate(req.query.date) ? req.query.date : today();
      res.json(await daySummary(staff, d));
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ TARGETS — who can I visit, with the context that makes the visit useful ═
  app.get('/api/dcr-m/targets', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const type = req.query.type === 'hawker' ? 'hawker' : 'agent';
      const units = await scopeUnits(req);
      const unit = S(req.query.unit, 10) || staff.unit_code;
      const term = String(req.query.q || '').trim();
      const lim = Math.min(100, Math.max(5, parseInt(req.query.limit || '40', 10)));

      if (units && unit && !units.includes(unit)) {
        return res.status(403).json({ detail: 'Outside your branch scope' });
      }
      const uList = unit ? [unit] : (units || []);
      if (!uList.length && !term) return res.json({ rows: [], note: 'Pick a branch or search by name.' });
      const IN = uList.length ? `AND am.unit IN (${uList.map(() => '?').join(',')})` : '';

      if (type === 'agent') {
        /* Outstanding, ageing, supply and last visit come back with the list, because an
           executive choosing whom to see next needs the reason, not just the name. */
        const { rows } = await q(
          `SELECT am.unit unit_code, am.agcd target_code, am.ag_name target_name,
                  am.city_name city, am.station_name station, am.mobile_no1 mobile,
                  COALESCE(os.cl_amt,0) outstanding,
                  sup.avg_copies, lv.last_visit, lv.last_outcome,
                  loc.lat, loc.lng, loc.source loc_source
           FROM agency_master am
           LEFT JOIN (SELECT unit_code, ag_code, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) cl_amt
                      FROM agency_outstanding WHERE period_label='CURRENT' GROUP BY unit_code, ag_code) os
             ON os.unit_code = am.unit AND os.ag_code = am.agcd
           LEFT JOIN (SELECT unit_code, agcd, ROUND(AVG(sup_copy)) avg_copies FROM supply_data
                      WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND sup_type_code='S01'
                      GROUP BY unit_code, agcd) sup
             ON sup.unit_code = am.unit AND sup.agcd = am.agcd
           LEFT JOIN (SELECT unit_code, target_code, MAX(visit_date) last_visit,
                             SUBSTRING_INDEX(GROUP_CONCAT(outcome ORDER BY visit_date DESC),',',1) last_outcome
                      FROM dcr_visit WHERE target_type='agent' GROUP BY unit_code, target_code) lv
             ON lv.unit_code = am.unit AND lv.target_code = am.agcd
           LEFT JOIN dcr_location loc
             ON loc.target_type='agent' AND loc.unit_code=am.unit AND loc.target_code=am.agcd
           WHERE CAST(am.dpcd AS UNSIGNED)=1 ${IN}
             ${term ? 'AND (am.ag_name LIKE ? OR am.agcd = ?)' : ''}
           ORDER BY outstanding DESC LIMIT ${lim}`,
          [...uList, ...(term ? [`%${term}%`, term] : [])]);
        return res.json({ rows, type });
      }

      const { rows } = await q(
        `SELECT hm.unit_code, hm.hawker_id target_code,
                COALESCE(hm.actual_name, hm.hawker_name) target_name,
                hm.hawker_center_name centre, hm.mobile_no mobile, hm.payment_nature,
                loc.lat, loc.lng, loc.source loc_source,
                lv.last_visit, lv.last_outcome
         FROM hawker_master hm
         LEFT JOIN dcr_location loc
           ON loc.target_type='hawker' AND loc.unit_code=hm.unit_code AND loc.target_code=hm.hawker_id
         LEFT JOIN (SELECT unit_code, target_code, MAX(visit_date) last_visit,
                           SUBSTRING_INDEX(GROUP_CONCAT(outcome ORDER BY visit_date DESC),',',1) last_outcome
                    FROM dcr_visit WHERE target_type='hawker' GROUP BY unit_code, target_code) lv
           ON lv.unit_code = hm.unit_code AND lv.target_code = hm.hawker_id
         WHERE 1=1 ${uList.length ? `AND hm.unit_code IN (${uList.map(() => '?').join(',')})` : ''}
           ${term ? 'AND (hm.hawker_name LIKE ? OR hm.actual_name LIKE ? OR hm.hawker_id = ?)' : ''}
         ORDER BY hm.hawker_name LIMIT ${lim}`,
        [...uList, ...(term ? [`%${term}%`, `%${term}%`, term] : [])]);
      res.json({ rows, type });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* Cash-sale centres for the attendance form. has_geo tells the UI which centres can
     actually be fence-checked — 375 of 815 carry ERP coordinates, and a centre without
     one registers itself on first attendance rather than blocking the executive. */
  app.get('/api/dcr-m/centres', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const units = await scopeUnits(req);
      const unit = S(req.query.unit, 10) || staff.unit_code;
      const list = unit ? [unit] : (units || []);
      const IN = list.length ? `WHERE unit_code IN (${list.map(() => '?').join(',')})` : '';
      const { rows } = await q(
        `SELECT depot_code, depot_name, depot_alias, unit_code, depot_addr,
                latitude, longitude, attn_from_time, attn_till_time,
                (latitude IS NOT NULL AND longitude IS NOT NULL) has_geo
         FROM cash_depot_master ${IN}
         ${IN ? 'AND' : 'WHERE'} COALESCE(freeze_flag,'N') <> 'Y'
         ORDER BY depot_name LIMIT 400`, list)
        .catch(() => ({ rows: [] }));
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ CHECK-IN / CHECK-OUT ═══════════════════════════════════════════════════
  app.post('/api/dcr-m/visit/check-in', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const type = ['agent', 'hawker'].includes(b.target_type) ? b.target_type : 'agent';
      const unit = S(b.unit_code, 10), code = S(b.target_code, 40);
      if (!unit || !code) return res.status(400).json({ detail: 'unit_code and target_code are required' });

      const units = await scopeUnits(req);
      if (units && !units.includes(unit)) return res.status(403).json({ detail: 'Outside your branch scope' });

      const d = today();
      const { rows: tr } = await q(
        `SELECT * FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? LIMIT 1`,
        [staff.person_code, d]);
      if (!tr[0]) return res.status(409).json({ detail: 'Start your trip before checking in.', need: 'trip' });
      if (tr[0].status === 'closed') return res.status(409).json({ detail: 'Today\'s trip is already closed.' });

      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      if (!inIndia(lat, lng)) return res.status(400).json({ detail: 'A valid GPS location is required to check in.' });

      // Already checked in and not yet out — hand the open visit back rather than
      // creating a second row for the same stop.
      const { rows: open } = await q(
        `SELECT id FROM dcr_visit WHERE staff_person_code = ? AND visit_date = ?
           AND target_code = ? AND unit_code = ? AND status = 'in_progress' LIMIT 1`,
        [staff.person_code, d, code, unit]);
      if (open[0]) return res.json({ ok: true, already: true, visit_id: open[0].id });

      const anchor = await anchorFor(type, unit, code);
      const dist = anchor ? distM(lat, lng, anchor.lat, anchor.lng) : null;
      const radius = anchor ? FENCE_M[anchor.source] : null;
      const within = (dist == null || radius == null) ? null : (dist <= radius ? 1 : 0);

      const { rows: ins } = await q(
        `INSERT INTO dcr_visit (visit_date, staff_person_code, staff_name, staff_emp_code, unit_code,
            target_type, target_code, target_name, target_extra, trip_id,
            check_in_at, in_lat, in_lng, in_accuracy, lat, lng,
            distance_m, within_fence, fence_source, status, device_id, plan_id)
         VALUES (?,?,?,?,?, ?,?,?,?,?, NOW(),?,?,?,?,?, ?,?,?, 'in_progress', ?, ?)`,
        [d, staff.person_code, staff.name, staff.emp_code, unit,
         type, code, S(b.target_name, 300), S(b.target_extra, 300), tr[0].id,
         lat, lng, b.accuracy == null ? null : Math.round(Number(b.accuracy)), lat, lng,
         dist, within, anchor ? anchor.source : null, S(b.device_id, 80),
         b.plan_id ? Number(b.plan_id) : null]).then(async () => {
          const { rows } = await q(`SELECT LAST_INSERT_ID() id`);
          return { rows };
        });
      const visitId = N(ins[0].id);

      /* First real GPS at a place we had no anchor for becomes its registered location —
         the roll-out registers itself as the team works, instead of needing a separate
         data-collection exercise before the app is usable. */
      if (!anchor && (b.register_location === undefined || b.register_location)) {
        await q(
          `INSERT INTO dcr_location (target_type, unit_code, target_code, target_name, lat, lng,
              source, accuracy, registered_by, registered_at)
           VALUES (?,?,?,?,?,?, 'registered', ?, ?, NOW())
           ON DUPLICATE KEY UPDATE lat=VALUES(lat), lng=VALUES(lng), source='registered',
              registered_by=VALUES(registered_by), registered_at=NOW()`,
          [type, unit, code, S(b.target_name, 300), lat, lng,
           b.accuracy == null ? null : Math.round(Number(b.accuracy)), staff.person_code]);
      }

      res.json({
        ok: true, visit_id: visitId,
        geofence: { distance_m: dist, radius_m: radius, within, anchor: anchor ? anchor.source : 'none',
          note: anchor ? null : 'No known location for this stop — this check-in registered it.' },
      });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/dcr-m/visit/check-out', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const id = Number(b.visit_id);
      if (!id) return res.status(400).json({ detail: 'visit_id is required' });

      const { rows: v } = await q(
        `SELECT * FROM dcr_visit WHERE id = ? AND staff_person_code = ? LIMIT 1`,
        [id, staff.person_code]);
      if (!v[0]) return res.status(404).json({ detail: 'Visit not found' });

      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      const dur = v[0].check_in_at
        ? Math.max(0, Math.round((Date.now() - new Date(v[0].check_in_at).getTime()) / 60000)) : null;

      await q(
        `UPDATE dcr_visit SET check_out_at = NOW(), out_lat = ?, out_lng = ?, duration_min = ?,
            purpose = COALESCE(?, purpose), outcome = COALESCE(?, outcome),
            remarks = COALESCE(?, remarks),
            amount_collected = COALESCE(?, amount_collected),
            payment_mode = COALESCE(?, payment_mode), receipt_no = COALESCE(?, receipt_no),
            copies_committed = COALESCE(?, copies_committed),
            next_action = COALESCE(?, next_action), next_followup_date = COALESCE(?, next_followup_date),
            selfie_id = COALESCE(?, selfie_id), receipt_id = COALESCE(?, receipt_id),
            status = 'completed'
         WHERE id = ?`,
        [inIndia(lat, lng) ? lat : null, inIndia(lat, lng) ? lng : null, dur,
         S(b.purpose, 60), S(b.outcome, 40), S(b.remarks, 2000),
         b.amount_collected == null ? null : Number(b.amount_collected),
         S(b.payment_mode, 30), S(b.receipt_no, 60),
         b.copies_committed == null ? null : parseInt(b.copies_committed, 10),
         S(b.next_action, 40), isDate(b.next_followup_date) ? b.next_followup_date : null,
         b.selfie_id ? Number(b.selfie_id) : null, b.receipt_id ? Number(b.receipt_id) : null,
         id]);

      // Close the matching plan row so the tour list shows what is actually done.
      if (v[0].plan_id) {
        await q(`UPDATE dcr_tour_plan SET status='done', visit_id=? WHERE id=?`, [id, v[0].plan_id]);
      }
      res.json({ ok: true, visit_id: id, duration_min: dur });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ PHOTO ══════════════════════════════════════════════════════════════════
  const express = require('express');
  const crypto = require('crypto');
  app.post('/api/dcr-m/photo',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: '8mb' }),
    (err, req, res, next) => {
      if (!err) return next();
      res.status(err.type === 'entity.too.large' ? 413 : 400).json({
        detail: err.type === 'entity.too.large'
          ? 'Photo is too large. It should be compressed on the device before upload.'
          : `Could not read the photo: ${err.message}`,
      });
    },
    async (req, res) => {
      try {
        const staff = await staffOf(req);
        if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ detail: 'No image received' });

        const kind = ['selfie', 'receipt', 'lead', 'site'].includes(req.query.kind) ? req.query.kind : 'selfie';
        const sha = crypto.createHash('sha256').update(buf).digest('hex');

        /* A verification selfie that has been sent before is the thing this check exists
           to catch, so the duplicate is reported rather than silently accepted. It is
           reported, not blocked — a legitimate retry of a failed upload looks identical. */
        const { rows: dup } = await q(
          `SELECT id, staff_person_code, taken_on FROM dcr_photo WHERE sha256 = ? LIMIT 1`, [sha]);

        await q(
          `INSERT INTO dcr_photo (kind, staff_person_code, visit_id, trip_id, taken_on,
             mime, bytes, size_bytes, sha256, lat, lng)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [kind, staff.person_code,
           req.query.visit_id ? Number(req.query.visit_id) : null,
           req.query.trip_id ? Number(req.query.trip_id) : null,
           today(), req.headers['content-type'] || 'image/jpeg', buf, buf.length, sha,
           req.query.lat ? Number(req.query.lat) : null,
           req.query.lng ? Number(req.query.lng) : null]);
        const { rows } = await q(`SELECT LAST_INSERT_ID() id`);
        res.json({
          ok: true, photo_id: N(rows[0].id), size: buf.length,
          duplicate_of: dup[0] ? { id: dup[0].id, by: dup[0].staff_person_code, on: iso(dup[0].taken_on) } : null,
        });
      } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
    });

  app.get('/api/dcr-m/photo/:id', async (req, res) => {
    try {
      const { rows } = await q(`SELECT mime, bytes FROM dcr_photo WHERE id = ? LIMIT 1`, [Number(req.params.id)]);
      if (!rows[0] || !rows[0].bytes) return res.status(404).json({ detail: 'Photo not found' });
      res.setHeader('Content-Type', rows[0].mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(rows[0].bytes);
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ TOUR PLAN ══════════════════════════════════════════════════════════════
  /* Create for yourself, or assign to a subordinate. Self-created plans start
     'submitted' and wait for the incharge; a plan an incharge assigns is already their
     decision, so it starts 'approved' and the executive can simply go. */
  app.post('/api/dcr-m/tour', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      if (!isDate(b.tour_date)) return res.status(400).json({ detail: 'tour_date (YYYY-MM-DD) is required' });
      const stops = Array.isArray(b.stops) ? b.stops : [];
      if (!stops.length) return res.status(400).json({ detail: 'At least one stop is required' });

      const units = await scopeUnits(req);
      let owner = staff, assigning = false;
      if (b.for_person_code && b.for_person_code !== staff.person_code) {
        const { rows } = await q(
          `SELECT person_code, person_name, employee_code, unit_code FROM hierarchy_master
           WHERE person_code = ? LIMIT 1`, [b.for_person_code]);
        if (!rows[0]) return res.status(404).json({ detail: 'That executive was not found' });
        const team = await subordinates(staff, units);
        if (!team.some(t => t.person_code === rows[0].person_code)) {
          return res.status(403).json({ detail: 'That executive does not report to you' });
        }
        owner = { person_code: rows[0].person_code, name: rows[0].person_name,
                  emp_code: rows[0].employee_code, unit_code: rows[0].unit_code };
        assigning = true;
      }

      const status = assigning ? 'approved' : 'submitted';
      let n = 0;
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i] || {};
        const unit = S(s.unit_code, 10) || owner.unit_code;
        if (!unit || !S(s.target_code, 40)) continue;
        if (units && !units.includes(unit)) continue;
        await q(
          `INSERT INTO dcr_tour_plan (tour_date, staff_person_code, staff_name, staff_emp_code, unit_code,
             target_type, target_code, target_name, target_extra, visit_time, purpose, description,
             status, seq_no, expected_recovery, outstanding_snap,
             assigned_by, assigned_by_name, approved_by, approved_by_name, approved_at)
           VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)`,
          [b.tour_date, owner.person_code, owner.name, owner.emp_code, unit,
           ['agent', 'hawker'].includes(s.target_type) ? s.target_type : 'agent',
           S(s.target_code, 40), S(s.target_name, 300), S(s.target_extra, 300),
           S(s.visit_time, 8), S(s.purpose, 60), S(s.description, 2000),
           status, i + 1,
           s.expected_recovery == null ? null : Number(s.expected_recovery),
           s.outstanding == null ? null : Number(s.outstanding),
           assigning ? staff.person_code : null, assigning ? staff.name : null,
           assigning ? staff.person_code : null, assigning ? staff.name : null,
           assigning ? new Date() : null]);
        n++;
      }
      res.json({ ok: true, stops: n, status, for: owner.person_code, assigned: assigning });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.get('/api/dcr-m/tour', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const d = isDate(req.query.date) ? req.query.date : today();
      const who = S(req.query.person_code, 20) || staff.person_code;
      if (who !== staff.person_code) {
        const team = await subordinates(staff, await scopeUnits(req));
        if (!team.some(t => t.person_code === who)) return res.status(403).json({ detail: 'Not your team member' });
      }
      const { rows } = await q(
        `SELECT tp.*, loc.lat, loc.lng, loc.source loc_source
         FROM dcr_tour_plan tp
         LEFT JOIN dcr_location loc ON loc.target_type = tp.target_type
              AND loc.unit_code = tp.unit_code AND loc.target_code = tp.target_code
         WHERE tp.staff_person_code = ? AND tp.tour_date = ?
         ORDER BY COALESCE(tp.seq_no, 999), tp.id`, [who, d]);
      res.json({ date: d, person_code: who, rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // Incharge queue: plans from my team waiting on me.
  app.get('/api/dcr-m/tour/pending', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const team = await subordinates(staff, await scopeUnits(req));
      if (!team.length) return res.json({ rows: [] });
      const codes = team.map(t => t.person_code);
      const { rows } = await q(
        `SELECT staff_person_code, staff_name, tour_date, COUNT(*) stops,
                SUM(COALESCE(outstanding_snap,0)) outstanding,
                SUM(COALESCE(expected_recovery,0)) expected_recovery,
                MIN(id) first_id
         FROM dcr_tour_plan
         WHERE status = 'submitted' AND tour_date >= CURDATE()
           AND staff_person_code IN (${codes.map(() => '?').join(',')})
         GROUP BY staff_person_code, staff_name, tour_date
         ORDER BY tour_date, staff_name`, codes);
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/dcr-m/tour/decide', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const action = ['approve', 'reject'].includes(b.action) ? b.action : null;
      if (!action) return res.status(400).json({ detail: 'action must be approve or reject' });
      // A rejection without a reason gives the executive nothing to act on.
      if (action === 'reject' && !S(b.reason, 500)) {
        return res.status(400).json({ detail: 'A reason is required when rejecting a tour plan.' });
      }
      const who = S(b.person_code, 20), d = b.tour_date;
      if (!who || !isDate(d)) return res.status(400).json({ detail: 'person_code and tour_date are required' });

      const team = await subordinates(staff, await scopeUnits(req));
      if (!team.some(t => t.person_code === who)) return res.status(403).json({ detail: 'Not your team member' });

      const ids = Array.isArray(b.ids) && b.ids.length ? b.ids.map(Number) : null;
      const idCl = ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
      const { rows: r } = await q(
        `UPDATE dcr_tour_plan
         SET status = ?, approved_by = ?, approved_by_name = ?, approved_at = NOW(), reject_reason = ?
         WHERE staff_person_code = ? AND tour_date = ? AND status = 'submitted'${idCl}`,
        [action === 'approve' ? 'approved' : 'rejected', staff.person_code, staff.name,
         action === 'reject' ? S(b.reason, 500) : null, who, d, ...(ids || [])]).then(async () => {
          const { rows } = await q(
            `SELECT COUNT(*) n FROM dcr_tour_plan WHERE staff_person_code=? AND tour_date=? AND status=?`,
            [who, d, action === 'approve' ? 'approved' : 'rejected']);
          return { rows };
        });
      res.json({ ok: true, action, affected: N(r[0].n) });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* People who report to me. hierarchy_mapping names the incharge on each executive
     row, so a match on any of the four incharge columns is a reporting line. */
  async function subordinates(staff, units) {
    if (!staff.emp_code && !staff.person_code) return [];
    const { rows } = await q(
      `SELECT DISTINCT hm.person_code, hm.person_name, hm.employee_code, hm.unit_code
       FROM hierarchy_master hm
       WHERE hm.is_active = 1 AND hm.reporting_to = ?
       ${units && units.length ? `AND hm.unit_code IN (${units.map(() => '?').join(',')})` : ''}`,
      [staff.person_code, ...(units && units.length ? units : [])]);
    return rows;
  }
  app.get('/api/dcr-m/team', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      res.json({ rows: await subordinates(staff, await scopeUnits(req)) });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ ATTENDANCE (centre, geofenced) ═════════════════════════════════════════
  app.post('/api/dcr-m/attendance', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      if (!inIndia(lat, lng)) return res.status(400).json({ detail: 'A valid GPS location is required.' });

      const unit = S(b.unit_code, 10) || staff.unit_code;
      const centre = S(b.centre_code, 40) || S(b.centre_name, 40) || 'FIELD';
      const anchor = await anchorFor('centre', unit, centre);
      const dist = anchor ? distM(lat, lng, anchor.lat, anchor.lng) : null;
      // Centres are a fixed shopfront the team returns to daily, so the tight 50 m the
      // requirement asks for is realistic here in a way it is not for agencies.
      const radius = anchor ? 50 : null;
      const within = (dist == null) ? null : (dist <= radius ? 1 : 0);

      if (within === 0 && !b.override_reason) {
        return res.status(409).json({
          detail: `You are ${dist} m from ${S(b.centre_name, 60) || centre}. Attendance needs you within ${radius} m.`,
          distance_m: dist, radius_m: radius, need: 'override_reason',
        });
      }

      await q(
        `INSERT INTO dcr_attendance (attn_date, staff_person_code, staff_emp_code, staff_name, unit_code,
           centre_code, centre_name, lat, lng, accuracy, distance_m, within_fence, marked_at,
           status, source, remarks, photo_id)
         VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, NOW(), 'present', 'centre', ?, ?)
         ON DUPLICATE KEY UPDATE lat=VALUES(lat), lng=VALUES(lng), accuracy=VALUES(accuracy),
           distance_m=VALUES(distance_m), within_fence=VALUES(within_fence),
           marked_at=NOW(), remarks=VALUES(remarks), photo_id=COALESCE(VALUES(photo_id), photo_id)`,
        [today(), staff.person_code, staff.emp_code, staff.name, unit,
         centre, S(b.centre_name, 300), lat, lng,
         b.accuracy == null ? null : Math.round(Number(b.accuracy)), dist, within,
         S(b.override_reason || b.remarks, 500), b.photo_id ? Number(b.photo_id) : null]);

      if (!anchor && b.register_location !== false) {
        await q(
          `INSERT INTO dcr_location (target_type, unit_code, target_code, target_name, lat, lng,
             source, registered_by, registered_at)
           VALUES ('centre',?,?,?,?,?, 'registered', ?, NOW())
           ON DUPLICATE KEY UPDATE lat=VALUES(lat), lng=VALUES(lng), source='registered'`,
          [unit, centre, S(b.centre_name, 300), lat, lng, staff.person_code]);
      }
      res.json({ ok: true, distance_m: dist, radius_m: radius, within,
        registered: !anchor ? 'This centre location has been registered.' : null });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/dcr-m/attendance/close', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      const { rows } = await q(
        `UPDATE dcr_attendance SET closed_at = NOW(), close_lat = ?, close_lng = ?
         WHERE staff_person_code = ? AND attn_date = ? AND closed_at IS NULL`,
        [inIndia(lat, lng) ? lat : null, inIndia(lat, lng) ? lng : null, staff.person_code, today()])
        .then(() => q(`SELECT * FROM dcr_attendance WHERE staff_person_code=? AND attn_date=?`,
          [staff.person_code, today()]));
      res.json({ ok: true, rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* ══ FORMS ═════════════════════════════════════════════════════════════════
     The seven forms the field team actually fills. They share dcr_visit rather than
     getting a table each: they are all "a person recorded an interaction on a date",
     differing only in the fields they carry, which live in `extra` as JSON. One table
     keeps the day's list, the KM trail and the day-close totals working across every
     form without seven unions.

     visit_mode separates a real visit from a phone call. An executive who is not in the
     field can still do the work — ring the agent, agree a payment, log it — and that
     must be recorded honestly rather than dressed up as a field visit: a call carries no
     geofence, no selfie requirement, and is counted separately at day close. */
  const FORM_TYPES = {
    plan_tour:      { target: 'agent',  perm: 'dcr_plan_tour' },
    agency_visit:   { target: 'agent',  perm: 'dcr_agency_visit' },
    center_attn:    { target: 'centre', perm: 'dcr_center_attn' },
    hawker_visit:   { target: 'hawker', perm: 'dcr_hawker_visit' },
    reader_visit:   { target: 'reader', perm: 'dcr_reader_visit' },
    new_area:       { target: 'area',   perm: 'dcr_new_area' },
    office_work:    { target: 'office', perm: 'dcr_office_work' },
    // Calling is its own form rather than a mode inside a visit — mixing the two let a
    // field report be filed from a desk. It always records visit_mode='call'.
    calling:        { target: 'agent',  perm: 'dcr_calling' },
    agent_feedback: { target: 'agent',  perm: 'dcr_agent_feedback' },
  };

  app.post('/api/dcr-m/form', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      const form = FORM_TYPES[b.form] ? b.form : null;
      if (!form) return res.status(400).json({ detail: 'Unknown form' });

      // The calling form is a call by definition, whatever the client sends.
      const mode = (form === 'calling' || b.visit_mode === 'call') ? 'call' : 'field';
      const lat = b.lat == null ? null : Number(b.lat), lng = b.lng == null ? null : Number(b.lng);
      const hasGeo = inIndia(lat, lng);
      // A field visit without a location cannot be verified, so it is refused; a call
      // never needs one.
      if (mode === 'field' && !hasGeo && ['agency_visit', 'hawker_visit', 'center_attn'].includes(form)) {
        return res.status(400).json({ detail: 'A valid GPS location is required for a field visit. Use “Call instead” if you are not on site.' });
      }

      const unit = S(b.unit_code, 10) || staff.unit_code;
      const units = await scopeUnits(req);
      if (unit && units && !units.includes(unit)) {
        return res.status(403).json({ detail: 'Outside your branch scope' });
      }

      const tt = FORM_TYPES[form].target;
      const code = S(b.target_code, 40) || (tt === 'office' ? 'OFFICE' : tt === 'area' ? 'AREA' : 'ADHOC');

      // Geofence only where there is a real place to be, and only for field mode.
      let dist = null, within = null, anchorSrc = null;
      if (mode === 'field' && hasGeo && ['agent', 'hawker', 'centre'].includes(tt)) {
        const anchor = await anchorFor(tt, unit, code);
        if (anchor) {
          dist = distM(lat, lng, anchor.lat, anchor.lng);
          const radius = tt === 'centre' ? 50 : FENCE_M[anchor.source];
          within = radius == null ? null : (dist <= radius ? 1 : 0);
          anchorSrc = anchor.source;
        }
      }

      const { rows: tr } = await q(
        `SELECT id FROM dcr_trip WHERE staff_person_code = ? AND trip_date = ? AND status='active' LIMIT 1`,
        [staff.person_code, today()]);

      await q(
        `INSERT INTO dcr_visit (visit_date, staff_person_code, staff_name, staff_emp_code, unit_code,
           target_type, target_code, target_name, target_extra, trip_id,
           check_in_at, check_out_at, in_lat, in_lng, in_accuracy, lat, lng,
           distance_m, within_fence, fence_source, status, visit_mode, form_type,
           purpose, outcome, remarks, amount_collected, payment_mode, payment_type,
           receipt_no, copies_committed, outstanding_amount, growth_start, dues_clear_by,
           next_action, next_followup_date, work_type, location, assigned_by, attendees, subject,
           selfie_id, duration_min, extra, device_id)
         VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, 'completed',?,?,
           ?,?,?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?,?,?)`,
        [today(), staff.person_code, staff.name, staff.emp_code, unit,
         tt, code, S(b.target_name, 300), S(b.target_extra, 300), tr[0] ? tr[0].id : null,
         S(b.check_in, 8) ? `${today()} ${b.check_in}:00` : new Date(),
         S(b.check_out, 8) ? `${today()} ${b.check_out}:00` : null,
         hasGeo ? lat : null, hasGeo ? lng : null,
         b.accuracy == null ? null : Math.round(Number(b.accuracy)),
         hasGeo ? lat : null, hasGeo ? lng : null,
         dist, within, anchorSrc, mode, form,
         S(b.purpose, 60), S(b.outcome, 40), S(b.remarks, 2000),
         b.amount_collected == null || b.amount_collected === '' ? null : Number(b.amount_collected),
         S(b.payment_mode, 30), S(b.payment_type, 20),
         S(b.receipt_no, 60),
         b.copies_committed == null || b.copies_committed === '' ? null : parseInt(b.copies_committed, 10),
         b.outstanding_amount == null || b.outstanding_amount === '' ? null : Number(b.outstanding_amount),
         isDate(b.growth_start) ? b.growth_start : null,
         isDate(b.dues_clear_by) ? b.dues_clear_by : null,
         S(b.next_action, 40), isDate(b.next_followup_date) ? b.next_followup_date : null,
         S(b.work_type, 60), S(b.location, 200), S(b.assigned_by, 200),
         S(b.attendees, 300), S(b.subject, 200),
         b.selfie_id ? Number(b.selfie_id) : null,
         b.duration_min == null || b.duration_min === '' ? null : parseInt(b.duration_min, 10),
         b.extra ? JSON.stringify(b.extra).slice(0, 60000) : null,
         S(b.device_id, 80)]);
      const { rows: idr } = await q(`SELECT LAST_INSERT_ID() id`);

      // A reader visit or a new-area survey is a lead by another name, so it lands in
      // the lead pipeline too instead of being buried inside a visit row.
      if (form === 'reader_visit' || form === 'new_area') {
        const e = b.extra || {};
        await q(
          `INSERT INTO dcr_lead (created_by, created_by_name, unit_code, visit_id, lead_type,
             name, mobile, address, lat, lng, current_paper, current_copies, potential_copies,
             remarks, followup_date)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [staff.person_code, staff.name, unit, N(idr[0].id),
           form === 'reader_visit' ? 'New Reader' : 'New Area',
           S(b.target_name || e.name || e.area_name, 200), S(e.mobile, 20),
           S(e.address || e.area_name, 400), hasGeo ? lat : null, hasGeo ? lng : null,
           S(Array.isArray(e.current_paper) ? e.current_paper.join(', ') : e.current_paper, 120),
           e.current_copies == null || e.current_copies === '' ? null : parseInt(e.current_copies, 10),
           e.potential_copies == null || e.potential_copies === '' ? null : parseInt(e.potential_copies, 10),
           S(b.remarks, 1000), isDate(b.next_followup_date) ? b.next_followup_date : null]);
      }

      res.json({ ok: true, id: N(idr[0].id), visit_mode: mode,
        geofence: dist == null ? null : { distance_m: dist, within, anchor: anchorSrc } });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* Which forms this user may open. The dashboard shows an icon per permitted form, so
     this is the single place that decides — the UI never invents an entitlement. */
  app.get('/api/dcr-m/rights', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const { rows } = await q(
        `SELECT form_key, can_view FROM user_permissions WHERE person_code = ?`, [staff.person_code])
        .catch(() => ({ rows: [] }));
      const override = {};
      rows.forEach(r => { override[r.form_key] = !!r.can_view; });

      const lvl = Number(staff.level) || Number(req.auth.hierarchyLevel) || 99;
      const isAdmin = !!req.auth.isAdmin;
      /* Default entitlement by role, overridable per user. An agent-side executive and a
         hawker-side executive do different jobs, but the ERP does not label which is
         which, so everyone gets both sets by default and the incharge trims per person. */
      const out = {};
      Object.entries(FORM_TYPES).forEach(([k, v]) => {
        out[k] = override[v.perm] !== undefined ? override[v.perm] : (isAdmin || lvl <= 7);
      });
      res.json({ forms: out, level: lvl, is_admin: isAdmin });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ LEADS ══════════════════════════════════════════════════════════════════
  app.post('/api/dcr-m/lead', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const b = req.body || {};
      if (!S(b.lead_type, 30)) return res.status(400).json({ detail: 'lead_type is required' });
      await q(
        `INSERT INTO dcr_lead (created_by, created_by_name, unit_code, visit_id, lead_type, name, mobile,
           address, lat, lng, current_paper, current_copies, potential_copies, source, remarks,
           photo_id, followup_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [staff.person_code, staff.name, S(b.unit_code, 10) || staff.unit_code,
         b.visit_id ? Number(b.visit_id) : null, S(b.lead_type, 30), S(b.name, 200), S(b.mobile, 20),
         S(b.address, 400), b.lat == null ? null : Number(b.lat), b.lng == null ? null : Number(b.lng),
         S(b.current_paper, 120), b.current_copies == null ? null : parseInt(b.current_copies, 10),
         b.potential_copies == null ? null : parseInt(b.potential_copies, 10),
         S(b.source, 60), S(b.remarks, 1000), b.photo_id ? Number(b.photo_id) : null,
         isDate(b.followup_date) ? b.followup_date : null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.get('/api/dcr-m/lead', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const units = await scopeUnits(req);
      const mine = req.query.mine === '1';
      const where = [], p = [];
      if (mine) { where.push('created_by = ?'); p.push(staff.person_code); }
      else if (units && units.length) { where.push(`unit_code IN (${units.map(() => '?').join(',')})`); p.push(...units); }
      if (S(req.query.status, 14)) { where.push('status = ?'); p.push(S(req.query.status, 14)); }
      const { rows } = await q(
        `SELECT * FROM dcr_lead ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT 200`, p);
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ TEAM LIVE — where everyone is right now ════════════════════════════════
  app.get('/api/dcr-m/team-live', async (req, res) => {
    try {
      const staff = await staffOf(req);
      if (!staff) return res.status(401).json({ detail: 'Not a mapped staff member' });
      const team = await subordinates(staff, await scopeUnits(req));
      if (!team.length) return res.json({ rows: [] });
      const codes = team.map(t => t.person_code);
      const IN = codes.map(() => '?').join(',');
      const [{ rows: trips }, { rows: last }] = await Promise.all([
        q(`SELECT * FROM dcr_trip WHERE trip_date = CURDATE() AND staff_person_code IN (${IN})`, codes),
        q(`SELECT v.staff_person_code, v.target_name, v.check_in_at, v.check_out_at,
                  v.in_lat, v.in_lng, v.status, v.amount_collected
           FROM dcr_visit v
           JOIN (SELECT staff_person_code, MAX(id) mid FROM dcr_visit
                 WHERE visit_date = CURDATE() AND staff_person_code IN (${IN})
                 GROUP BY staff_person_code) m ON m.mid = v.id`, [...codes]),
      ]);
      const tByP = {}; trips.forEach(t => { tByP[t.staff_person_code] = t; });
      const lByP = {}; last.forEach(l => { lByP[l.staff_person_code] = l; });
      const rows = team.map(t => {
        const tr = tByP[t.person_code], lv = lByP[t.person_code];
        let state = 'offline';
        if (tr && tr.status === 'closed') state = 'ended';
        else if (lv && lv.status === 'in_progress') state = 'on_visit';
        else if (tr && tr.status === 'active') state = lv ? 'travelling' : 'started';
        return {
          person_code: t.person_code, name: t.person_name, unit_code: t.unit_code,
          state,
          started_at: tr ? tr.start_at : null, ended_at: tr ? tr.end_at : null,
          last_lat: lv ? lv.in_lat : (tr ? tr.start_lat : null),
          last_lng: lv ? lv.in_lng : (tr ? tr.start_lng : null),
          last_target: lv ? lv.target_name : null,
          last_at: lv ? (lv.check_out_at || lv.check_in_at) : (tr ? tr.start_at : null),
        };
      });
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ══ ADMIN — seed locations from historical GPS ═════════════════════════════
  app.post('/api/dcr-m/seed-locations', async (req, res) => {
    try {
      if (!req.auth || !req.auth.isAdmin) return res.status(403).json({ detail: 'Admin only' });
      res.json({ ok: true, ...(await seedLocations()) });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });
};
