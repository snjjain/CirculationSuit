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

  async function ensureSchema() {
    await q(`CREATE TABLE IF NOT EXISTS dcr_visit (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      visit_date        DATE NOT NULL,
      staff_person_code VARCHAR(20),
      staff_name        VARCHAR(200),
      staff_emp_code    VARCHAR(30),
      unit_code         VARCHAR(10),
      target_type       VARCHAR(10) NOT NULL,   -- 'agent' | 'hawker'
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

  // POST /api/dcr/visit  — record a visit (writes to MySQL only)
  app.post('/api/dcr/visit', async (req, res) => {
    try {
      const { staff, units } = await staffContext(req);
      const b = req.body || {};
      const type = String(b.target_type || '').toLowerCase() === 'hawker' ? 'hawker' : 'agent';
      const unit = String(b.unit_code || '').trim();
      const code = String(b.target_code || '').trim();
      if (!code) return res.status(400).json({ detail: 'A visit target is required.' });
      if (!unit) return res.status(400).json({ detail: 'Target unit is required.' });
      if (units && !units.includes(unit)) return res.status(403).json({ detail: 'Target is outside your branch scope.' });

      const today = new Date().toISOString().slice(0, 10);
      const visitDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.visit_date || '')) ? b.visit_date : today;
      const lat = b.lat != null && b.lat !== '' ? Number(b.lat) : null;
      const lng = b.lng != null && b.lng !== '' ? Number(b.lng) : null;

      await q(
        `INSERT INTO dcr_visit
           (visit_date, staff_person_code, staff_name, staff_emp_code, unit_code,
            target_type, target_code, target_name, target_extra, purpose, remarks, outcome, lat, lng)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [visitDate, staff.person_code, staff.name, staff.employee_code, unit,
         type, code, (b.target_name || '').slice(0, 300) || null, (b.target_extra || '').slice(0, 300) || null,
         (b.purpose || '').slice(0, 60) || null, (b.remarks || '').slice(0, 2000) || null,
         (b.outcome || '').slice(0, 40) || null,
         Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/dcr/visits?date=YYYY-MM-DD — this staff's visits for a day
  app.get('/api/dcr/visits', async (req, res) => {
    try {
      const { staff } = await staffContext(req);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : new Date().toISOString().slice(0, 10);
      const { rows } = await q(
        `SELECT id, visit_date, target_type, target_code, target_name, target_extra,
                purpose, remarks, outcome, lat, lng, created_at
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
