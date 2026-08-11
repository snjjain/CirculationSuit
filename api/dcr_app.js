'use strict';
/**
 * dcr_app.js — DCR (Daily Collection Register) app for circulation staff.
 *
 * Staff record agent & hawker visits and submit their day. Visit targets are scoped to
 * the staff member's branch/unit(s) — the ERP does not assign specific agencies to
 * specific staff, so any agency/hawker in their unit scope is visitable.
 *
 * WRITES go to our own MySQL table `dcr_visit` only — never Oracle (read-only ERP).
 * Reads for target lists come from agency_master (agents) and hawker_supply (hawkers).
 *
 * Installed from server.js:  require('./dcr_app')({ app, q, getScopeUnitCodes });
 */
module.exports = function installDcrApp({ app, q, getScopeUnitCodes }) {

  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const iso = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

  async function ensureSchema() {
    await q(`CREATE TABLE IF NOT EXISTS dcr_visit (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      visit_date        DATE NOT NULL,
      staff_person_code VARCHAR(20),
      staff_name        VARCHAR(200),
      staff_emp_code    VARCHAR(30),
      unit_code         VARCHAR(10),
      target_type       VARCHAR(10) NOT NULL,   -- 'agent' | 'hawker' | 'office'
      target_code       VARCHAR(30) NOT NULL,
      target_name       VARCHAR(300),
      target_extra      VARCHAR(300),           -- agent: city ; hawker: center
      purpose           VARCHAR(60),
      remarks           TEXT,
      outcome           VARCHAR(40),
      lat               DECIMAL(10,6),
      lng               DECIMAL(10,6),
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_staff_date (staff_person_code, visit_date),
      INDEX idx_unit_date  (unit_code, visit_date)
    ) CHARACTER SET utf8mb4`);
    // Rich fields matching the DCR prototype forms (idempotent migrations)
    const add = async (col, def) => { try { await q(`ALTER TABLE dcr_visit ADD COLUMN ${col} ${def}`); } catch (_) {} };
    await add('check_in', 'VARCHAR(8)');            // HH:MM
    await add('check_out', 'VARCHAR(8)');
    await add('payment_mode', 'VARCHAR(30)');       // Cash/Cheque/UPI/NEFT/None
    await add('payment_type', 'VARCHAR(20)');       // Full/Partial/Advance
    await add('amount_collected', 'DECIMAL(12,2)');
    await add('outstanding_amount', 'DECIMAL(12,2)');
    await add('copies_committed', 'INT');
    await add('growth_start', 'DATE');
    await add('dues_clear_by', 'DATE');
    // Office-work fields (target_type='office')
    await add('work_type', 'VARCHAR(60)');
    await add('location', 'VARCHAR(200)');
    await add('assigned_by', 'VARCHAR(200)');
    await add('attendees', 'VARCHAR(300)');
    await add('subject', 'VARCHAR(200)');

    // Tour planning — visits planned ahead of the day
    await q(`CREATE TABLE IF NOT EXISTS dcr_tour_plan (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      tour_date         DATE NOT NULL,
      staff_person_code VARCHAR(20),
      staff_name        VARCHAR(200),
      unit_code         VARCHAR(10),
      target_type       VARCHAR(10) NOT NULL,
      target_code       VARCHAR(30) NOT NULL,
      target_name       VARCHAR(300),
      target_extra      VARCHAR(300),
      visit_time        VARCHAR(8),
      purpose           VARCHAR(60),
      description       TEXT,
      status            VARCHAR(20) DEFAULT 'planned',   -- planned | done | skipped
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_staff_tour (staff_person_code, tour_date)
    ) CHARACTER SET utf8mb4`);
  }
  ensureSchema().catch(e => console.warn('[dcr] schema init:', e.message));

  function auth(req) {
    const a = req.auth || {};
    return {
      personCode: a.personCode || req.headers['x-person-code'] || null,
      hl: a.hierarchyLevel != null ? a.hierarchyLevel
        : (req.headers['x-hierarchy-level'] ? parseInt(req.headers['x-hierarchy-level'], 10) : null),
    };
  }

  // Staff profile + the unit codes they may act within (null = all, for admin).
  async function staffContext(req) {
    const { personCode, hl } = auth(req);
    let staff = { person_code: personCode, name: null, employee_code: null, unit_code: null, hierarchy_level: hl };
    if (personCode) {
      const { rows } = await q(
        `SELECT person_code, person_name, employee_code, unit_code, hierarchy_level
           FROM hierarchy_master WHERE person_code=? LIMIT 1`, [personCode]);
      if (rows[0]) staff = {
        person_code: rows[0].person_code, name: rows[0].person_name,
        employee_code: rows[0].employee_code, unit_code: rows[0].unit_code,
        hierarchy_level: rows[0].hierarchy_level,
      };
    }
    const units = await getScopeUnitCodes(personCode, hl); // null = all units
    return { staff, units };
  }

  // GET /api/dcr/context
  app.get('/api/dcr/context', async (req, res) => {
    try {
      const { staff, units } = await staffContext(req);
      res.json({ staff, unit_codes: units, scope: units ? 'unit' : 'all' });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/dcr/targets?type=agent|hawker&unit=&q=&limit=
  app.get('/api/dcr/targets', async (req, res) => {
    try {
      const type = String(req.query.type || 'agent').toLowerCase() === 'hawker' ? 'hawker' : 'agent';
      const search = String(req.query.q || '').trim();
      const wantUnit = String(req.query.unit || '').trim();
      const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '40', 10)));
      const { units } = await staffContext(req);

      // Resolve unit filter within the staff's scope
      let unitList = units; // null = all
      if (wantUnit) {
        if (units && !units.includes(wantUnit)) return res.status(403).json({ detail: 'Unit outside your scope.' });
        unitList = [wantUnit];
      }
      if (unitList && !unitList.length) return res.json({ type, targets: [] });
      // Admin with no unit selected must narrow down (avoid scanning everything)
      if (!unitList && !search) return res.json({ type, targets: [], note: 'Enter a search term or pick a unit.' });

      const unitCls = unitList ? ` AND ${type === 'agent' ? 'unit' : 'loc_id'} IN (${unitList.map(() => '?').join(',')})` : '';
      const like = `%${search}%`;

      let rows;
      if (type === 'agent') {
        const params = [];
        if (unitList) params.push(...unitList);
        let sql = `SELECT unit AS unit_code, agcd AS code, ag_name AS name, city_name AS extra, ag_class_name AS cls
                     FROM agency_master
                    WHERE COALESCE(supply_stop_flag,'N') <> 'Y'
                      AND (suspend_date IS NULL OR suspend_date > CURDATE())${unitCls}`;
        if (search) { sql += ` AND (ag_name LIKE ? OR agcd LIKE ?)`; params.push(like, like); }
        sql += ` ORDER BY ag_name LIMIT ${limit}`;
        ({ rows } = await q(sql, params));
      } else {
        const params = [];
        if (unitList) params.push(...unitList);
        let sql = `SELECT loc_id AS unit_code, hawker_id AS code,
                          ANY_VALUE(hawker_name) AS name, ANY_VALUE(hawker_center) AS extra,
                          ANY_VALUE(center_incharge_name) AS cls
                     FROM hawker_supply
                    WHERE 1=1${unitCls}`;
        if (search) { sql += ` AND (hawker_name LIKE ? OR hawker_id LIKE ?)`; params.push(like, like); }
        sql += ` GROUP BY loc_id, hawker_id ORDER BY name LIMIT ${limit}`;
        ({ rows } = await q(sql, params));
      }
      res.json({ type, targets: rows });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  const numv = v => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null);
  const s = (v, n) => (v ? String(v).slice(0, n) : null);

  // POST /api/dcr/visit  — record an agent/hawker/office visit (writes to MySQL only)
  app.post('/api/dcr/visit', async (req, res) => {
    try {
      const { staff, units } = await staffContext(req);
      const b = req.body || {};
      let type = String(b.target_type || 'agent').toLowerCase();
      if (!['agent', 'hawker', 'office'].includes(type)) type = 'agent';
      const visitDate = isDate(b.visit_date) ? b.visit_date : new Date().toISOString().slice(0, 10);

      let unit = String(b.unit_code || '').trim();
      let code = String(b.target_code || '').trim();
      if (type === 'office') {
        unit = unit || staff.unit_code || (units && units[0]) || '';
        code = code || 'OFFICE';
      } else {
        if (!code) return res.status(400).json({ detail: 'A visit target is required.' });
        if (!unit) return res.status(400).json({ detail: 'Target unit is required.' });
      }
      if (unit && units && !units.includes(unit)) return res.status(403).json({ detail: 'Target is outside your branch scope.' });

      await q(
        `INSERT INTO dcr_visit
           (visit_date, staff_person_code, staff_name, staff_emp_code, unit_code,
            target_type, target_code, target_name, target_extra, purpose, remarks, outcome, lat, lng,
            check_in, check_out, payment_mode, payment_type, amount_collected, outstanding_amount,
            copies_committed, growth_start, dues_clear_by, work_type, location, assigned_by, attendees, subject)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [visitDate, staff.person_code, staff.name, staff.employee_code, unit,
         type, code, s(b.target_name, 300), s(b.target_extra, 300), s(b.purpose, 60), s(b.remarks, 2000), s(b.outcome, 40),
         numv(b.lat), numv(b.lng),
         s(b.check_in, 8), s(b.check_out, 8), s(b.payment_mode, 30), s(b.payment_type, 20), numv(b.amount_collected), numv(b.outstanding_amount),
         b.copies_committed != null && b.copies_committed !== '' ? (parseInt(b.copies_committed, 10) || 0) : null,
         isDate(b.growth_start) ? b.growth_start : null, isDate(b.dues_clear_by) ? b.dues_clear_by : null,
         s(b.work_type, 60), s(b.location, 200), s(b.assigned_by, 200), s(b.attendees, 300), s(b.subject, 200)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // POST /api/dcr/tour — plan a visit ahead
  app.post('/api/dcr/tour', async (req, res) => {
    try {
      const { staff, units } = await staffContext(req);
      const b = req.body || {};
      const type = String(b.target_type || 'agent').toLowerCase() === 'hawker' ? 'hawker' : 'agent';
      const unit = String(b.unit_code || '').trim();
      const code = String(b.target_code || '').trim();
      const tourDate = isDate(b.tour_date) ? b.tour_date : null;
      if (!tourDate) return res.status(400).json({ detail: 'Tour date is required.' });
      if (!code || !unit) return res.status(400).json({ detail: 'Select an agency/hawker to plan.' });
      if (units && !units.includes(unit)) return res.status(403).json({ detail: 'Target is outside your branch scope.' });
      await q(
        `INSERT INTO dcr_tour_plan (tour_date, staff_person_code, staff_name, unit_code, target_type, target_code, target_name, target_extra, visit_time, purpose, description)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [tourDate, staff.person_code, staff.name, unit, type, code, s(b.target_name, 300), s(b.target_extra, 300), s(b.visit_time, 8), s(b.purpose, 60), s(b.description, 2000)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/dcr/tours?from=&to= — planned visits (default today onward)
  app.get('/api/dcr/tours', async (req, res) => {
    try {
      const { staff } = await staffContext(req);
      const from = isDate(req.query.from) ? req.query.from : new Date().toISOString().slice(0, 10);
      const to = isDate(req.query.to) ? req.query.to : null;
      const params = [staff.person_code, from];
      let cls = 'staff_person_code=? AND tour_date>=?';
      if (to) { cls += ' AND tour_date<=?'; params.push(to); }
      const { rows } = await q(`SELECT id, tour_date, target_type, target_code, target_name, target_extra, visit_time, purpose, description, status FROM dcr_tour_plan WHERE ${cls} ORDER BY tour_date, visit_time`, params);
      res.json({ tours: rows.map(r => ({ ...r, tour_date: iso(r.tour_date) })) });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/dcr/visits?date=YYYY-MM-DD — this staff's visits for a day
  app.get('/api/dcr/visits', async (req, res) => {
    try {
      const { staff } = await staffContext(req);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : new Date().toISOString().slice(0, 10);
      const { rows } = await q(
        `SELECT id, visit_date, target_type, target_code, target_name, target_extra,
                purpose, remarks, outcome, lat, lng, created_at,
                check_in, check_out, payment_mode, payment_type, amount_collected, outstanding_amount,
                copies_committed, growth_start, dues_clear_by, work_type, location, assigned_by, subject
           FROM dcr_visit
          WHERE staff_person_code = ? AND visit_date = ?
          ORDER BY created_at DESC`, [staff.person_code, date]);
      res.json({ date, visits: rows });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/dcr/day-report?date= — summary counts for the day
  app.get('/api/dcr/day-report', async (req, res) => {
    try {
      const { staff } = await staffContext(req);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : new Date().toISOString().slice(0, 10);
      const { rows } = await q(
        `SELECT target_type, COUNT(*) n FROM dcr_visit
          WHERE staff_person_code=? AND visit_date=? GROUP BY target_type`, [staff.person_code, date]);
      const by = { agent: 0, hawker: 0 };
      rows.forEach(r => { by[r.target_type] = Number(r.n) || 0; });
      res.json({ date, agent_visits: by.agent, hawker_visits: by.hawker, total: by.agent + by.hawker });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });
};
