'use strict';
/**
 * dcr_analytics.js — DCR Field Visit Analytics (manager/admin view)
 *
 * Reads from:  dcr_agency_visit   (Oracle-synced agency visits — primary source)
 *              dcr_center_attendance  (Oracle-synced center attendance)
 *              dcr_visit              (new-app agent/hawker visits)
 *              agency_master          (agency metadata)
 *              hierarchy_master       (executive directory)
 *              supply_data            (current copies for map tooltip)
 *              agency_outstanding     (balance for map tooltip)
 *
 * Installed from server.js:  require('./dcr_analytics')({ app, q, getScopeUnitCodes });
 */
module.exports = function installDcrAnalytics({ app, q, getScopeUnitCodes }) {

  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

  // Cache the DISTINCT agcd set from supply_data (8M+ rows, ~60s cold scan).
  // Valid for 30 min — active-agency membership changes slowly.
  let _activeAgcdCache = null;
  let _activeAgcdAt    = 0;
  async function getActiveAgcds() {
    const AGE = 30 * 60 * 1000; // 30 minutes
    if (_activeAgcdCache && Date.now() - _activeAgcdAt < AGE) return _activeAgcdCache;
    const { rows } = await q(
      "SELECT DISTINCT agcd FROM supply_data WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY) AND sup_copy > 0"
    );
    _activeAgcdCache = new Set(rows.map(r => r.agcd));
    _activeAgcdAt    = Date.now();
    return _activeAgcdCache;
  }

  // Warm up the active-agency cache immediately on module load (background).
  // This means the first API request finds the cache ready instead of waiting 60s.
  setTimeout(() => getActiveAgcds().catch(() => {}), 500);

  // Ensure unit_locations table exists (stores lat/lng for each unit's office/start-point)
  q(`CREATE TABLE IF NOT EXISTS unit_locations (
      unit_code  VARCHAR(8) PRIMARY KEY,
      unit_name  VARCHAR(200),
      lat        DECIMAL(10,6),
      lng        DECIMAL(10,6),
      address    VARCHAR(500),
      updated_by VARCHAR(100),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => console.error('[dcr] unit_locations init:', e.message));

  // Per-executive start-point: remote-based executives start km calculation from
  // their own base location instead of the unit office (falls back to unit_locations)
  q(`CREATE TABLE IF NOT EXISTS exec_locations (
      emp_code   VARCHAR(20) PRIMARY KEY,
      exec_name  VARCHAR(150),
      unit_code  VARCHAR(8),
      lat        DECIMAL(10,6),
      lng        DECIMAL(10,6),
      address    VARCHAR(500),
      updated_by VARCHAR(100),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => console.error('[dcr] exec_locations init:', e.message));

  const XLSX = require('xlsx');

  // Separate query to get unit_code → unit_name (avoids cross-table collation JOIN issues)
  async function getUnitNameMap() {
    const { rows } = await q('SELECT unit_code, unit_name FROM pub_unit_master');
    const map = {};
    rows.forEach(r => { map[r.unit_code] = r.unit_name; });
    return map;
  }

  // Scope helper: resolve unit_codes array from query params
  async function resolveScope(req) {
    const { unit_code, state } = req.query;
    const auth = req.auth;
    if (!auth) return { clause: ' AND 1=0', params: [], unitCodes: [] };

    // Admin/manager: use getScopeUnitCodes; else user's own scope
    let unitCodes = await getScopeUnitCodes(auth.personCode, auth.hierarchyLevel);

    // Further filter by explicit unit_code or state from query
    if (unit_code) {
      const asked = String(unit_code).split(',').map(s => s.trim()).filter(Boolean);
      unitCodes = unitCodes ? unitCodes.filter(u => asked.includes(u)) : asked;
    }
    // State filter: map state → unit_codes (simple name matching, reuse RC_STATE_LABEL logic)
    if (state && !unit_code) {
      const stateUpper = String(state).toUpperCase();
      const CG  = ['BHILAI','BILASPUR','JAGDALPUR','RAIPUR'];
      const MP  = ['BHOPAL','CHHINDWARA','GWALIOR','INDORE','JABALPUR','KHANDWA','MANDSAUR','RATLAM','SAGAR','SATNA','UJJAIN'];
      const RAJ = stateUpper.startsWith('RAJ') || stateUpper === 'RJ';
      const isMp = stateUpper.startsWith('MADHYA') || stateUpper === 'MP';
      const isCg = stateUpper.startsWith('CHHATTIS') || stateUpper === 'CG';
      const isNat = stateUpper === 'NATIONAL' || stateUpper === 'NAT';

      const { rows: ums } = await q('SELECT unit_code, unit_name FROM pub_unit_master');
      const matchFn = n => {
        const u = (n || '').toUpperCase();
        if (isCg)  return CG.some(k => u.includes(k));
        if (isMp)  return MP.some(k => u.includes(k));
        if (isNat) return ['AHMEDABAD','BANGLORE','BANGALORE','CHENNAI','COIMBATORE','DELHI','HUBLI','KOLKATA','MUMBAI','SURAT'].some(k => u.includes(k));
        if (RAJ)   return !CG.some(k=>u.includes(k)) && !MP.some(k=>u.includes(k)) && !['AHMEDABAD','BANGLORE','BANGALORE','CHENNAI','COIMBATORE','DELHI','HUBLI','KOLKATA','MUMBAI','SURAT'].some(k=>u.includes(k));
        return false;
      };
      const stateUnits = ums.filter(r => matchFn(r.unit_name)).map(r => r.unit_code);
      unitCodes = unitCodes ? unitCodes.filter(u => stateUnits.includes(u)) : stateUnits;
    }

    if (!unitCodes) return { clause: '', params: [], unitCodes: null }; // L1 = all
    if (!unitCodes.length) return { clause: ' AND 1=0', params: [], unitCodes: [] };
    const ph = unitCodes.map(() => '?').join(',');
    return { clause: ` AND unit_code IN (${ph})`, params: unitCodes, unitCodes };
  }

  // ── GET /api/dcr-analytics/units ────────────────────────────────────────────
  // Full unit list with state classification — used by frontend filter dropdown
  app.get('/api/dcr-analytics/units', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { rows } = await q('SELECT unit_code, unit_name FROM pub_unit_master ORDER BY unit_name');
      const CG  = ['BHILAI','BILASPUR','JAGDALPUR','RAIPUR'];
      const MP  = ['BHOPAL','CHHINDWARA','GWALIOR','INDORE','JABALPUR','KHANDWA','MANDSAUR','RATLAM','SAGAR','SATNA','UJJAIN'];
      const NAT = ['AHMEDABAD','BANGLORE','BANGALORE','CHENNAI','COIMBATORE','DELHI','HUBLI','KOLKATA','MUMBAI','SURAT'];
      const getState = name => {
        const u = (name||'').toUpperCase();
        if (CG.some(k=>u.includes(k)))  return 'Chhattisgarh';
        if (MP.some(k=>u.includes(k)))  return 'Madhya Pradesh';
        if (NAT.some(k=>u.includes(k))) return 'National';
        return 'Rajasthan';
      };
      res.json({ units: rows.map(r => ({ unit_code: r.unit_code, unit_name: r.unit_name, state: getState(r.unit_name) })) });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/summary ──────────────────────────────────────────
  // Returns KPI groups: visits, executives, agencies, outcomes
  app.get('/api/dcr-analytics/summary', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      // ─ Agency visits (Oracle DCR) ─
      const { rows: avRows } = await q(
        `SELECT COUNT(*) cnt, COUNT(DISTINCT visit_to_main_code) uniq_agencies,
                COUNT(DISTINCT emp_code) exec_count
         FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc}`,
        [from, to, ...sp]
      );
      const av = avRows[0] || {};

      // ─ Center attendance (Oracle) ─
      const { rows: caRows } = await q(
        `SELECT COUNT(*) cnt, COUNT(DISTINCT emp_code) exec_count
         FROM dcr_center_attendance
         WHERE attn_date BETWEEN ? AND ?${sc}`,
        [from, to, ...sp]
      );
      const ca = caRows[0] || {};

      // ─ New-app visits (dcr_visit) ─
      const { rows: nvRows } = await q(
        `SELECT target_type, COUNT(*) cnt, COUNT(DISTINCT staff_person_code) exec_count
         FROM dcr_visit
         WHERE visit_date BETWEEN ? AND ?${sc}`,
        [from, to, ...sp]
      );
      const nvByType = {};
      nvRows.forEach(r => { nvByType[r.target_type] = { cnt: Number(r.cnt), execs: Number(r.exec_count) }; });

      // ─ Outcomes breakdown (from Oracle agency visits) ─
      const { rows: outcomeRows } = await q(
        `SELECT visit_purpose, COUNT(*) cnt
         FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc}
         GROUP BY visit_purpose ORDER BY cnt DESC LIMIT 20`,
        [from, to, ...sp]
      );

      // ─ Collection data from dcr_visit ─
      const { rows: collRows } = await q(
        `SELECT SUM(amount_collected) total_collected, COUNT(*) payment_visits
         FROM dcr_visit
         WHERE visit_date BETWEEN ? AND ?${sc} AND amount_collected > 0`,
        [from, to, ...sp]
      );
      const coll = collRows[0] || {};

      // ─ Executives active vs inactive ─
      const scopeForExec = sc.replace(/unit_code/g, 'hm.unit_code');
      const { rows: execTotalRows } = await q(
        `SELECT COUNT(DISTINCT hm.person_code) total
         FROM hierarchy_master hm
         WHERE hm.hierarchy_level IN (3,4,5,7) AND hm.is_active = 1${scopeForExec}`,
        sp
      );
      const execTotal = Number(execTotalRows[0]?.total || 0);

      // Execs with DCR (either source)
      const { rows: execWithRows } = await q(
        `SELECT COUNT(DISTINCT emp_code) cnt FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc}
         UNION ALL
         SELECT COUNT(DISTINCT staff_person_code) FROM dcr_visit
         WHERE visit_date BETWEEN ? AND ?${sc}`,
        [from, to, ...sp, from, to, ...sp]
      );
      const execWith = Math.min(execTotal, (execWithRows[0]?.cnt || 0) + (execWithRows[1]?.cnt || 0));

      // ─ Agencies coverage ─
      // Use cached active-agency set (avoids 60s supply_data full-scan on every request).
      // agency_master and agency_outstanding are queried separately; counts computed in JS.
      const amSc = sc.replace(/AND unit_code/g, 'AND am.unit').replace(/unit_code IN/g, 'am.unit IN');
      const activeAgcds = await getActiveAgcds();
      const [{ rows: amIdRows }, { rows: osRows }] = await Promise.all([
        q(`SELECT agcd FROM agency_master am WHERE 1=1${amSc}`, sp),
        q(`SELECT ag_code, MAX(cl_amt) AS cl_amt FROM agency_outstanding WHERE period_label='CURRENT' GROUP BY ag_code`),
      ]);
      const osMap = new Map(osRows.map(r => [String(r.ag_code), Number(r.cl_amt) || 0]));
      let _total=0, _active=0, _closed=0, _activeOs=0, _closedOs=0;
      for (const { agcd } of amIdRows) {
        const isAct = activeAgcds.has(String(agcd));
        const os    = osMap.get(String(agcd)) || 0;
        if (!isAct && !os) continue;
        _total++;
        if (isAct) { _active++; if (os) _activeOs++; }
        else        { _closed++; if (os) _closedOs++; }
      }
      const agRow = { total: _total, active: _active, closed: _closed, active_with_os: _activeOs, closed_with_os: _closedOs };
      const agVisited = Number(av.uniq_agencies || 0);
      const agActive  = Number(agRow.active || 0);

      res.json({
        period: { from, to },
        visits: {
          agency_oracle: Number(av.cnt || 0),
          center_attendance: Number(ca.cnt || 0),
          app_agent:  nvByType.agent?.cnt   || 0,
          app_hawker: nvByType.hawker?.cnt  || 0,
          app_office: nvByType.office?.cnt  || 0,
          total: Number(av.cnt||0) + Number(ca.cnt||0) + Object.values(nvByType).reduce((s,v)=>s+v.cnt,0),
        },
        executives: {
          total: execTotal,
          with_dcr: execWith,
          without_dcr: Math.max(0, execTotal - execWith),
          active_in_period: Number(av.exec_count || 0),
        },
        agencies: {
          total:          Number(agRow.total         || 0),
          active:         Number(agRow.active        || 0),
          closed:         Number(agRow.closed        || 0),
          active_with_os: Number(agRow.active_with_os|| 0),
          closed_with_os: Number(agRow.closed_with_os|| 0),
          visited:        agVisited,
          not_visited:    Math.max(0, agActive - agVisited),
        },
        collection: {
          total: Number(coll.total_collected || 0),
          payment_visits: Number(coll.payment_visits || 0),
        },
        outcomes: outcomeRows.map(r => ({ purpose: r.visit_purpose || 'Not specified', count: Number(r.cnt) })),
      });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/agency-map ───────────────────────────────────────
  // Returns agencies with GPS (derived from visit lat/lng) + metadata for map markers
  app.get('/api/dcr-analytics/agency-map', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { clause: sc, params: sp } = await resolveScope(req);

      // Most recent GPS per agency — two separate queries (avoid UNION collation issues)
      const unitWhere = sc ? sc.replace(/AND unit_code/g, 'AND unit_code').trim() : '';
      const amWhere   = sc ? sc.replace(/AND unit_code/g, 'AND am.unit').replace(/unit_code IN/g, 'am.unit IN').trim() : '';

      // Query 1: GPS from Oracle dcr_agency_visit (include unit_code for composite key)
      const { rows: oracleGps } = await q(
        `SELECT visit_to_main_code AS agcd, unit_code,
                CAST(latitude AS DECIMAL(10,6)) AS lat, CAST(longitude AS DECIMAL(10,6)) AS lng,
                visit_date, executive_name, visit_remarks, visit_purpose, id
         FROM dcr_agency_visit
         WHERE latitude IS NOT NULL AND latitude <> '' AND longitude IS NOT NULL AND longitude <> ''
           AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
           AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
           ${unitWhere}
         ORDER BY visit_date DESC, id DESC`,
        sp
      );
      // Query 2: GPS from new DCR app
      const { rows: appGps } = await q(
        `SELECT target_code AS agcd, unit_code, lat, lng, visit_date, staff_name AS executive_name,
                remarks AS visit_remarks, purpose AS visit_purpose, id
         FROM dcr_visit
         WHERE target_type = 'agent' AND lat IS NOT NULL AND lng IS NOT NULL
           AND lat BETWEEN 8 AND 38 AND lng BETWEEN 68 AND 98
           ${unitWhere}
         ORDER BY visit_date DESC, id DESC`,
        sp
      );

      // Merge: latest GPS per unit_code+agcd (composite key — same agcd can exist in multiple units)
      const gpsMap = {};
      [...appGps, ...oracleGps].forEach(r => {
        const key = (r.unit_code || '') + '|' + (r.agcd || '');
        if (!gpsMap[key] || r.visit_date > gpsMap[key].visit_date)
          gpsMap[key] = { lat: Number(r.lat), lng: Number(r.lng), last_visit_date: r.visit_date,
            last_exec_name: r.executive_name, last_remarks: r.visit_remarks, last_purpose: r.visit_purpose };
      });

      // Collect unique agcds for agency_master lookup
      const agcdList = [...new Set(Object.keys(gpsMap).map(k => k.split('|')[1]).filter(Boolean))];
      if (!agcdList.length) return res.json({ count: 0, agencies: [] });

      const ph2 = agcdList.map(() => '?').join(',');
      const { rows: agencies } = await q(
        `SELECT am.agcd, am.unit AS unit_code, am.unit_name,
                am.ag_name, am.dist_name AS district, am.city_name AS city,
                am.ag_class_name AS ag_class, am.field_officer_name AS field_officer,
                am.executive_name AS assigned_exec,
                CASE WHEN am.supply_stop_flag = 'Y' OR (am.suspend_date IS NOT NULL AND am.suspend_date <= CURDATE())
                THEN 'Inactive' ELSE 'Active' END AS status
         FROM agency_master am
         WHERE am.agcd IN (${ph2})
           AND CAST(am.dpcd AS UNSIGNED) = 1
         ${amWhere ? 'AND ' + amWhere.replace(/^\s*AND\s*/,'') : ''}
         ORDER BY am.unit, am.ag_name`,
        [...agcdList, ...sp]
      );

      // Attach current supply (latest date per unit+agcd) — batch query
      const unitAgcdPairs = agencies.map(a => a.unit_code + '|' + a.agcd);
      let supplyMap = {};
      if (agcdList.length) {
        const ph = agcdList.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT sd.unit_code, sd.agcd, sd.sup_copy, sd.supply_date
           FROM supply_data sd
           JOIN (
             SELECT unit_code, agcd, MAX(supply_date) mxd
             FROM supply_data WHERE agcd IN (${ph}) GROUP BY unit_code, agcd
           ) mx ON mx.unit_code = sd.unit_code AND mx.agcd = sd.agcd AND mx.mxd = sd.supply_date
           WHERE sd.agcd IN (${ph})`,
          [...agcdList, ...agcdList]
        );
        supRows.forEach(r => { supplyMap[r.unit_code + '|' + r.agcd] = { copies: r.sup_copy, date: r.supply_date }; });
      }

      // Use composite key (unit_code|agcd) so each agency only gets GPS from its own unit's visits
      const result = agencies
        .map(a => {
          const key = (a.unit_code || '') + '|' + a.agcd;
          return {
            ...a,
            ...(gpsMap[key] || {}),
            supply: supplyMap[key]?.copies || null,
            supply_date: supplyMap[key]?.date || null,
          };
        })
        .filter(a => a.lat != null);  // only agencies that have GPS from their own unit's visits

      res.json({ count: result.length, agencies: result });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/monthly ──────────────────────────────────────────
  // Monthly breakdown: visits by type, agencies, executives, collection
  app.get('/api/dcr-analytics/monthly', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const months = parseInt(req.query.months || '6', 10);
      const { clause: sc, params: sp } = await resolveScope(req);

      // Agency visits by month (Oracle)
      const { rows: avMonthly } = await q(
        `SELECT DATE_FORMAT(visit_date,'%Y-%m') AS month,
                COUNT(*) visits,
                COUNT(DISTINCT visit_to_main_code) uniq_agencies,
                COUNT(DISTINCT emp_code) exec_count,
                SUM(followup_amount) followup_amt
         FROM dcr_agency_visit
         WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)${sc}
         GROUP BY DATE_FORMAT(visit_date,'%Y-%m')
         ORDER BY month`,
        [months, ...sp]
      );

      // Center attendance by month (Oracle)
      const { rows: caMonthly } = await q(
        `SELECT DATE_FORMAT(attn_date,'%Y-%m') AS month, COUNT(*) attendances, COUNT(DISTINCT emp_code) exec_count
         FROM dcr_center_attendance
         WHERE attn_date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)${sc}
         GROUP BY DATE_FORMAT(attn_date,'%Y-%m')
         ORDER BY month`,
        [months, ...sp]
      );

      // New-app visits by month
      const { rows: nvMonthly } = await q(
        `SELECT DATE_FORMAT(visit_date,'%Y-%m') AS month, target_type,
                COUNT(*) visits, SUM(amount_collected) collected
         FROM dcr_visit
         WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)${sc}
         GROUP BY DATE_FORMAT(visit_date,'%Y-%m'), target_type
         ORDER BY month`,
        [months, ...sp]
      );

      // Merge all into monthly buckets
      const monthMap = {};
      const ensureMonth = m => {
        if (!monthMap[m]) monthMap[m] = {
          month: m,
          agency_visits: 0, center_attendance: 0, app_agent: 0, app_hawker: 0, app_office: 0,
          total: 0, uniq_agencies: 0, exec_count: 0,
          followup_amount: 0, app_collected: 0,
        };
        return monthMap[m];
      };
      avMonthly.forEach(r => {
        const b = ensureMonth(r.month);
        b.agency_visits  = Number(r.visits);
        b.uniq_agencies  = Number(r.uniq_agencies);
        b.exec_count     = Math.max(b.exec_count, Number(r.exec_count));
        b.followup_amount = Number(r.followup_amt || 0);
      });
      caMonthly.forEach(r => {
        const b = ensureMonth(r.month);
        b.center_attendance = Number(r.attendances);
        b.exec_count = Math.max(b.exec_count, Number(r.exec_count));
      });
      nvMonthly.forEach(r => {
        const b = ensureMonth(r.month);
        const t = r.target_type;
        if (t === 'agent')  { b.app_agent  = Number(r.visits); b.app_collected += Number(r.collected||0); }
        if (t === 'hawker') b.app_hawker = Number(r.visits);
        if (t === 'office') b.app_office = Number(r.visits);
      });
      Object.values(monthMap).forEach(b => {
        b.total = b.agency_visits + b.center_attendance + b.app_agent + b.app_hawker + b.app_office;
      });

      res.json({
        months: Object.values(monthMap).sort((a,b) => a.month.localeCompare(b.month)),
      });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/executives ───────────────────────────────────────
  // Per-executive DCR performance summary for a date range
  app.get('/api/dcr-analytics/executives', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      const { rows: execRows } = await q(
        `SELECT
           dav.emp_code,
           dav.executive_name,
           dav.unit_code,
           COUNT(DISTINCT dav.id)                    AS agency_visits,
           COUNT(DISTINCT dav.visit_to_main_code)    AS uniq_agencies,
           COUNT(DISTINCT dav.visit_date)             AS working_days,
           MAX(dav.visit_date)                        AS last_visit_date,
           SUM(dav.followup_amount)                   AS followup_amount,
           ROUND(COUNT(DISTINCT dav.id) / NULLIF(COUNT(DISTINCT dav.visit_date),0),1) AS avg_per_day
         FROM dcr_agency_visit dav
         WHERE dav.visit_date BETWEEN ? AND ?${sc}
         GROUP BY dav.emp_code, dav.executive_name, dav.unit_code
         ORDER BY agency_visits DESC
         LIMIT 100`,
        [from, to, ...sp]
      );

      // Also fetch center attendance per executive
      const { rows: caRows } = await q(
        `SELECT emp_code, COUNT(*) attendances, COUNT(DISTINCT attn_date) days
         FROM dcr_center_attendance
         WHERE attn_date BETWEEN ? AND ?${sc}
         GROUP BY emp_code`,
        [from, to, ...sp]
      );
      const caMap = {};
      caRows.forEach(r => { caMap[r.emp_code] = { attendances: Number(r.attendances), days: Number(r.days) }; });

      const unitMap = await getUnitNameMap();
      const executives = execRows.map(r => ({
        emp_code:      r.emp_code,
        name:          r.executive_name,
        unit_code:     r.unit_code,
        unit_name:     unitMap[r.unit_code] || r.unit_code,
        agency_visits: Number(r.agency_visits),
        uniq_agencies: Number(r.uniq_agencies),
        working_days:  Number(r.working_days),
        avg_per_day:   Number(r.avg_per_day || 0),
        last_visit:    r.last_visit_date,
        followup_amt:  Number(r.followup_amount || 0),
        attendance:    caMap[r.emp_code]?.attendances || 0,
        attn_days:     caMap[r.emp_code]?.days || 0,
      }));

      res.json({ period: { from, to }, executives, count: executives.length });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/executive-list ───────────────────────────────────
  // Executives who made DCR visits in last 6 months — for Tour Route dropdown
  app.get('/api/dcr-analytics/executive-list', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { clause: sc, params: sp } = await resolveScope(req);
      const { rows } = await q(
        `SELECT DISTINCT emp_code, executive_name AS name, unit_code
         FROM dcr_agency_visit
         WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
           AND emp_code IS NOT NULL AND emp_code <> ''${sc}
         ORDER BY unit_code, executive_name`,
        sp
      );
      const unitMap = await getUnitNameMap();
      res.json({ executives: rows.map(r => ({ ...r, unit_name: unitMap[r.unit_code] || r.unit_code })) });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/tour-days ────────────────────────────────────────
  // Days on which an executive made field visits within a date range — lets the
  // UI list clickable tour days instead of blind single-date picking.
  app.get('/api/dcr-analytics/tour-days', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { emp_code } = req.query;
      if (!emp_code) return res.status(400).json({ detail: 'emp_code required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);
      const { rows } = await q(
        `SELECT DATE(mark_attn_date) tour_date,
                COUNT(*) visits,
                COUNT(DISTINCT visit_to_main_code) agencies,
                SUM(latitude IS NOT NULL AND latitude != '' AND latitude != '0') gps_count,
                MIN(from_time) first_time, MAX(till_time) last_time
         FROM dcr_agency_visit
         WHERE emp_code = ? AND mark_attn_date BETWEEN ? AND ?${sc}
         GROUP BY tour_date ORDER BY tour_date DESC`,
        [String(emp_code), from, to, ...sp]
      );
      res.json({ from, to, days: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/dcr-analytics/tour-route ───────────────────────────────────────
  // Single-day GPS tour route analysis for one executive
  // Query params: emp_code (required), date YYYY-MM-DD (required)
  app.get('/api/dcr-analytics/tour-route', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { emp_code, date } = req.query;
      if (!emp_code || !isDate(date)) return res.status(400).json({ detail: 'emp_code and date (YYYY-MM-DD) required' });
      const { clause: sc, params: sp } = await resolveScope(req);

      // Haversine distance in km
      const hav = (lat1, lng1, lat2, lng2) => {
        const R = 6371, d2r = Math.PI / 180;
        const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r) * Math.cos(lat2*d2r) * Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      };
      const validGps = (lat, lng) => {
        const a = Number(lat), o = Number(lng);
        return !isNaN(a) && !isNaN(o) && a >= 8 && a <= 38 && o >= 68 && o <= 98;
      };
      const fmtTime = v => {
        if (!v) return null;
        if (v instanceof Date) return v.toTimeString().slice(0, 5);
        const s = String(v); const m = s.match(/T(\d{2}:\d{2})/) || s.match(/(\d{1,2}:\d{2})/);
        return m ? m[1] : null;
      };
      const parseMin = t => {
        if (!t) return null;
        const m = String(t).match(/(\d{1,2}):(\d{2})/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
      };

      // 1. Oracle agency visits for this exec + date
      const { rows: oracleVisits } = await q(
        `SELECT id, visit_to_main_code AS agcd, executive_name, emp_code,
                visit_date, from_time, till_time, visit_purpose, visit_remarks,
                call_status, followup_amount, next_visit_date,
                CAST(latitude AS DECIMAL(10,6)) AS lat,
                CAST(longitude AS DECIMAL(10,6)) AS lng,
                lat_long_addr, unit_code, center_name
         FROM dcr_agency_visit
         WHERE emp_code = ? AND visit_date = ?${sc}
         ORDER BY from_time, id`,
        [emp_code, date, ...sp]
      );

      // 2. Center attendance GPS for start/end point
      const { rows: attnRows } = await q(
        `SELECT emp_code, center_name, attn_date,
                CAST(latitude AS DECIMAL(10,6)) AS lat,
                CAST(longitude AS DECIMAL(10,6)) AS lng
         FROM dcr_center_attendance WHERE emp_code = ? AND attn_date = ? LIMIT 1`,
        [emp_code, date]
      );
      const centerRaw = attnRows[0] || null;

      // 3. Resolve person_code from employee_code (for DCR app visits)
      const { rows: hmRows } = await q(
        `SELECT person_code, person_name, unit_code FROM hierarchy_master
         WHERE (UPPER(employee_code) = UPPER(?) OR person_code = ?) AND is_active = 1 LIMIT 1`,
        [emp_code, emp_code]
      );
      const hm = hmRows[0] || {};

      // 4. DCR app visits for same exec + date (no JOIN — collation mismatch risk)
      let appVisits = [];
      if (hm.person_code) {
        const { rows: avRows } = await q(
          `SELECT id, target_code AS agcd, visit_date,
                  check_in AS ci, check_out AS co,
                  purpose, remarks, amount_collected, outcome, lat, lng, unit_code
           FROM dcr_visit
           WHERE staff_person_code = ? AND visit_date = ? AND target_type = 'agent'${sc}
           ORDER BY check_in, id`,
          [hm.person_code, date, ...sp]
        );
        appVisits = avRows;
      }

      // 5a. Resolve start-point: executive's own base location first (remote-based
      // execs), then the unit office from unit_locations
      const unitCode = oracleVisits[0]?.unit_code || hm.unit_code || appVisits[0]?.unit_code || '';
      let officeGps = null, officeMissing = false;
      const { rows: elRows } = await q(
        `SELECT lat, lng, exec_name, address FROM exec_locations WHERE emp_code = ? AND lat IS NOT NULL`, [String(emp_code)]
      );
      if (elRows.length) {
        officeGps = {
          lat: Number(elRows[0].lat), lng: Number(elRows[0].lng),
          name: (elRows[0].exec_name || emp_code) + ' — base location', address: elRows[0].address || '',
        };
      } else if (unitCode) {
        const { rows: ulRows } = await q(
          `SELECT lat, lng, unit_name, address FROM unit_locations WHERE unit_code = ? AND lat IS NOT NULL`, [unitCode]
        );
        if (ulRows.length) {
          officeGps = {
            lat: Number(ulRows[0].lat), lng: Number(ulRows[0].lng),
            name: ulRows[0].unit_name || unitCode, address: ulRows[0].address || '',
          };
        } else {
          officeMissing = true; // no exec base and no unit coordinates set yet
        }
      }

      // 5. Agency names for all visit agcds (oracle + app) — single param-based lookup, safe
      const agcds = [...new Set([
        ...oracleVisits.map(r => r.agcd),
        ...appVisits.map(r => r.agcd),
      ].filter(Boolean))];
      let agMap = {};
      if (agcds.length) {
        const ph = agcds.map(() => '?').join(',');
        const { rows: agRows } = await q(
          `SELECT agcd, ag_name, city_name AS city, dist_name AS district FROM agency_master WHERE agcd IN (${ph})`,
          agcds
        );
        agRows.forEach(r => { agMap[r.agcd] = r; });
      }

      // 6. Build unified sorted visit list
      const visits = [
        ...oracleVisits.map(r => ({
          source: 'oracle',
          id: r.id,
          agcd: r.agcd,
          ag_name: agMap[r.agcd]?.ag_name || r.agcd,
          city: agMap[r.agcd]?.city || '',
          district: agMap[r.agcd]?.district || '',
          from_time: r.from_time || null,
          till_time: r.till_time || null,
          lat: validGps(r.lat, r.lng) ? Number(r.lat) : null,
          lng: validGps(r.lat, r.lng) ? Number(r.lng) : null,
          purpose: r.visit_purpose,
          remarks: r.visit_remarks,
          call_status: r.call_status,
          followup_amount: r.followup_amount || 0,
          unit_code: r.unit_code,
        })),
        ...appVisits.map(r => ({
          source: 'app',
          id: r.id,
          agcd: r.agcd,
          ag_name: r.ag_name || r.agcd,
          city: '',
          district: '',
          from_time: fmtTime(r.ci),
          till_time: fmtTime(r.co),
          lat: validGps(r.lat, r.lng) ? Number(r.lat) : null,
          lng: validGps(r.lat, r.lng) ? Number(r.lng) : null,
          purpose: r.purpose,
          remarks: r.remarks,
          amount_collected: r.amount_collected || 0,
          outcome: r.outcome,
          unit_code: r.unit_code,
        })),
      ].sort((a, b) => (a.from_time || '99:99').localeCompare(b.from_time || '99:99'));

      visits.forEach((v, i) => { v.seq = i + 1; });

      // 7. Distance + GPS chain
      const centerGps = centerRaw && validGps(centerRaw.lat, centerRaw.lng)
        ? { lat: Number(centerRaw.lat), lng: Number(centerRaw.lng), name: centerRaw.center_name }
        : null;

      // Office is the canonical start point; fall back to center check-in GPS if office not set
      const startGps = officeGps || centerGps;

      const chain = []; // GPS-tagged points in order (start → visits)
      if (startGps) chain.push({ lat: startGps.lat, lng: startGps.lng, type: officeGps ? 'office' : 'center' });

      let totalDist = 0;
      visits.forEach(v => {
        if (v.lat && v.lng) {
          const prev = chain[chain.length - 1];
          v.distance_from_prev = prev ? Math.round(hav(prev.lat, prev.lng, v.lat, v.lng) * 10) / 10 : 0;
          totalDist += v.distance_from_prev;
          chain.push({ lat: v.lat, lng: v.lng, type: 'visit' });
        } else {
          v.distance_from_prev = null;
        }
      });
      // Return to start (office/center)
      if (startGps && chain.length > 1) {
        const last = chain[chain.length - 1];
        totalDist += hav(last.lat, last.lng, startGps.lat, startGps.lng);
      }

      // 8. Time stats
      let totalTimeMin = 0;
      visits.forEach(v => {
        const s = parseMin(v.from_time), e = parseMin(v.till_time);
        if (s != null && e != null && e > s) totalTimeMin += (e - s);
      });
      const firstTime = visits.find(v => v.from_time)?.from_time || null;
      const lastTime  = [...visits].reverse().find(v => v.till_time)?.till_time || null;
      const fm = parseMin(firstTime), lm = parseMin(lastTime);
      const fieldHours = fm != null && lm != null && lm > fm ? Math.round((lm - fm) / 6) / 10 : null;

      // Geographic spread: bounding box diagonal
      const lats = chain.map(p => p.lat);
      const lngs = chain.map(p => p.lng);
      let spreadKm = null;
      if (lats.length >= 2) {
        const latRange = Math.max(...lats) - Math.min(...lats);
        const lngRange = Math.max(...lngs) - Math.min(...lngs);
        const midLat   = (Math.max(...lats) + Math.min(...lats)) / 2;
        spreadKm = Math.round(Math.sqrt((latRange*111)**2 + (lngRange*111*Math.cos(midLat*Math.PI/180))**2) * 10) / 10;
      }

      // 9. Missed nearby agencies (within 5 km, not visited today, GPS known from prior visits)
      const visitedSet = new Set(visits.map(v => v.agcd).filter(Boolean));
      let missedAgencies = [];
      if (chain.length && unitCode) {
        // Two separate queries to avoid cross-table collation issues
        // Query A: GPS per agency from Oracle visits (most recent first → JS dedup)
        const { rows: gpsRows } = await q(
          `SELECT visit_to_main_code AS agcd,
                  CAST(latitude AS DECIMAL(10,6)) AS lat,
                  CAST(longitude AS DECIMAL(10,6)) AS lng
           FROM dcr_agency_visit
           WHERE unit_code = ? AND latitude IS NOT NULL AND latitude <> ''
             AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
             AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
           ORDER BY visit_date DESC, id DESC`,
          [unitCode]
        );
        const gpsMap2 = {};
        gpsRows.forEach(r => {
          if (!gpsMap2[r.agcd]) gpsMap2[r.agcd] = { lat: Number(r.lat), lng: Number(r.lng) };
        });

        // Query B: agency names for those agcds (param-based, no JOIN)
        const unitAgcds = Object.keys(gpsMap2);
        if (unitAgcds.length) {
          const ph3 = unitAgcds.map(() => '?').join(',');
          const { rows: amRows } = await q(
            `SELECT agcd, ag_name, city_name AS city FROM agency_master WHERE agcd IN (${ph3})`,
            unitAgcds
          );
          const amMap = {};
          amRows.forEach(r => { amMap[r.agcd] = r; });

          const NEARBY = 5; // km
          unitAgcds.forEach(agcd => {
            if (visitedSet.has(agcd)) return;
            const g = gpsMap2[agcd];
            const minDist = Math.min(...chain.map(p => hav(p.lat, p.lng, g.lat, g.lng)));
            if (minDist <= NEARBY) {
              const am = amMap[agcd] || {};
              missedAgencies.push({ agcd, ag_name: am.ag_name || agcd, city: am.city || '', lat: g.lat, lng: g.lng, nearest_dist_km: Math.round(minDist * 10) / 10 });
            }
          });
        }
        missedAgencies.sort((a, b) => a.nearest_dist_km - b.nearest_dist_km);
      }

      res.json({
        executive: { emp_code, name: oracleVisits[0]?.executive_name || hm.person_name || emp_code, unit_code: unitCode },
        date,
        office: officeGps,                    // unit office — canonical start point
        office_missing: officeMissing,         // true if unit has no office coordinates stored
        center: centerGps ? { name: centerRaw?.center_name || 'Center', lat: centerGps.lat, lng: centerGps.lng } : null,
        visits,
        stats: {
          total_visits: visits.length,
          gps_visits: visits.filter(v => v.lat).length,
          total_distance_km: Math.round(totalDist * 10) / 10,
          total_time_in_meetings_min: totalTimeMin,
          field_hours: fieldHours,
          first_visit_time: firstTime,
          last_visit_time: lastTime,
          geographic_spread_km: spreadKm,
          missed_nearby_count: missedAgencies.length,
        },
        missed_agencies: missedAgencies.slice(0, 30),
      });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/visit-list ──────────────────────────────────────
  // Generic filtered list of Oracle DCR agency visits (for exec/outcome drill-down)
  // Query params: emp_code (optional), purpose (optional), from, to, unit_code/state (scope)
  app.get('/api/dcr-analytics/visit-list', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);
      const { emp_code, purpose } = req.query;

      const extra = [];
      const extraParams = [];
      if (emp_code) { extra.push('emp_code = ?'); extraParams.push(emp_code); }
      if (purpose)  { extra.push('visit_purpose = ?'); extraParams.push(purpose); }
      const extraWhere = extra.length ? ' AND ' + extra.join(' AND ') : '';

      const { rows: visits } = await q(
        `SELECT id, visit_date, visit_to_main_code AS agcd, executive_name, emp_code,
                from_time, till_time, visit_purpose, visit_remarks, call_status,
                followup_amount, unit_code,
                CAST(latitude AS DECIMAL(10,6)) AS lat, CAST(longitude AS DECIMAL(10,6)) AS lng
         FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc}${extraWhere}
         ORDER BY visit_date DESC, from_time DESC
         LIMIT 300`,
        [from, to, ...sp, ...extraParams]
      );

      // Get agency names separately (avoid cross-table JOIN collation issue)
      const agcds = [...new Set(visits.map(r => r.agcd).filter(Boolean))];
      let agMap = {};
      if (agcds.length) {
        const ph = agcds.map(() => '?').join(',');
        const { rows: agRows } = await q(
          `SELECT agcd, ag_name, city_name AS city FROM agency_master WHERE agcd IN (${ph})`, agcds
        );
        agRows.forEach(r => { agMap[r.agcd] = r; });
      }

      res.json({
        period: { from, to },
        count: visits.length,
        visits: visits.map(r => ({
          id: r.id,
          visit_date: r.visit_date,
          agcd: r.agcd,
          ag_name: agMap[r.agcd]?.ag_name || r.agcd,
          city: agMap[r.agcd]?.city || '',
          executive_name: r.executive_name,
          emp_code: r.emp_code,
          from_time: r.from_time,
          till_time: r.till_time,
          visit_purpose: r.visit_purpose,
          visit_remarks: r.visit_remarks,
          call_status: r.call_status,
          followup_amount: r.followup_amount,
          unit_code: r.unit_code,
          lat: r.lat && Number(r.lat) >= 8 && Number(r.lat) <= 38 ? Number(r.lat) : null,
          lng: r.lng && Number(r.lng) >= 68 && Number(r.lng) <= 98 ? Number(r.lng) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/unvisited-agencies ───────────────────────────────
  // Active agencies with no DCR visit in the given period
  app.get('/api/dcr-analytics/unvisited-agencies', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      // Step 1: get visited agcds (params only → no cross-table collation issue)
      const { rows: visitedRows } = await q(
        `SELECT DISTINCT visit_to_main_code AS agcd FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc}`,
        [from, to, ...sp]
      );
      const visitedAgcds = visitedRows.map(r => r.agcd).filter(Boolean);

      // Step 2: query agency_master with NOT IN using params
      const amWhere = sc ? sc.replace(/AND unit_code/g, 'AND am.unit').replace(/unit_code IN/g, 'am.unit IN').trim() : '';
      let notInClause = '', notInParams = [];
      if (visitedAgcds.length) {
        notInClause = `AND am.agcd NOT IN (${visitedAgcds.map(() => '?').join(',')})`;
        notInParams = visitedAgcds;
      }

      // Use cached active-agency set instead of slow supply_data subquery
      const activeAgcdsUv = await getActiveAgcds();
      const activeListUv  = [...activeAgcdsUv];
      const uvPh = activeListUv.length ? activeListUv.map(() => '?').join(',') : "'__none__'";
      const { rows: agencies } = await q(
        `SELECT am.agcd, am.ag_name, am.unit AS unit_code, am.unit_name,
                am.city_name AS city, am.dist_name AS district,
                am.ag_class_name AS ag_class, am.executive_name AS assigned_exec,
                ao.cl_amt AS outstanding
         FROM agency_master am
         LEFT JOIN agency_outstanding ao ON ao.ag_code = am.agcd AND ao.period_label = 'CURRENT'
         WHERE am.agcd IN (${uvPh}) ${amWhere} ${notInClause}
         ORDER BY COALESCE(ao.cl_amt,0) DESC, am.unit, am.ag_name
         LIMIT 500`,
        [...activeListUv, ...sp, ...notInParams]
      );

      res.json({ period: { from, to }, count: agencies.length, agencies });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/execs-without-dcr ───────────────────────────────
  // Active executives (hierarchy_master) who made zero agency visits in the period
  app.get('/api/dcr-analytics/execs-without-dcr', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      // All active field execs in scope (exclude placeholder rows with no real emp code)
      const { rows: allExecs } = await q(
        `SELECT person_code, person_name AS name, unit_code, employee_code
         FROM hierarchy_master
         WHERE is_active = 1 AND hierarchy_level IN (3,4,5,7)
           AND employee_code IS NOT NULL AND employee_code <> '' AND employee_code <> '0'${sc}
         ORDER BY unit_code, person_name`, sp
      );

      // Emp codes with any DCR in period
      const { rows: dcrRows } = await q(
        `SELECT DISTINCT emp_code FROM dcr_agency_visit
         WHERE visit_date BETWEEN ? AND ?${sc} AND emp_code IS NOT NULL AND emp_code <> ''`,
        [from, to, ...sp]
      );
      const dcrSet = new Set(dcrRows.map(r => (r.emp_code||'').toUpperCase()));

      const withoutDcr = allExecs.filter(e => !dcrSet.has((e.employee_code||'').toUpperCase()));
      res.json({ period: { from, to }, count: withoutDcr.length, executives: withoutDcr });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/agency-visits/:agcd ──────────────────────────────
  // Drill-down: all visits for one agency (from both Oracle and new app)
  app.get('/api/dcr-analytics/agency-visits/:agcd', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { agcd } = req.params;
      const from = isDate(req.query.from) ? req.query.from : '2020-01-01';
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);

      const [agencyRes, oracleVisits, appVisits] = await Promise.all([
        q(`SELECT am.*, ao.cl_amt AS outstanding
           FROM agency_master am
           LEFT JOIN agency_outstanding ao ON ao.ag_code = am.agcd AND ao.period_label = 'CURRENT'
           WHERE am.agcd = ? LIMIT 1`, [agcd]),
        q(`SELECT visit_date, visit_type, executive_name, emp_code,
                  visit_purpose, visit_remarks, call_status, followup_amount, followup_date,
                  from_time, till_time, lat_long_addr,
                  CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng,
                  next_visit_date, contact_mob_no
           FROM dcr_agency_visit WHERE visit_to_main_code = ?
             AND visit_date BETWEEN ? AND ?
           ORDER BY visit_date DESC, id DESC LIMIT 200`, [agcd, from, to]),
        q(`SELECT visit_date, target_type, staff_name, staff_person_code,
                  purpose, remarks, outcome, payment_mode, payment_type,
                  amount_collected, outstanding_amount, copies_committed,
                  check_in, check_out, lat, lng, created_at
           FROM dcr_visit WHERE target_code = ? AND target_type = 'agent'
             AND visit_date BETWEEN ? AND ?
           ORDER BY visit_date DESC, id DESC LIMIT 200`, [agcd, from, to]),
      ]);

      const agency = agencyRes.rows[0] || {};

      res.json({
        agency,
        oracle_visits: oracleVisits.rows,
        app_visits:    appVisits.rows,
        total_visits:  oracleVisits.rows.length + appVisits.rows.length,
      });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── GET /api/dcr-analytics/visit-analysis ─────────────────────────────────
  app.get('/api/dcr-analytics/visit-analysis', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      const [execRows, purposeRows, dailyRows] = await Promise.all([
        q(`SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_code) unit_code,
                COUNT(*) total_visits, COUNT(DISTINCT visit_to_main_code) agencies_visited,
                COUNT(DISTINCT mark_attn_date) active_days,
                MAX(mark_attn_date) last_visit_date
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ? AND emp_code IS NOT NULL AND emp_code != ''${sc}
           GROUP BY emp_code ORDER BY total_visits DESC LIMIT 30`, [from, to, ...sp]),

        q(`SELECT COALESCE(NULLIF(TRIM(visit_purpose),''), 'UNSPECIFIED') purpose, COUNT(*) cnt
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ?${sc}
           GROUP BY purpose ORDER BY cnt DESC LIMIT 8`, [from, to, ...sp]),

        q(`SELECT DATE(mark_attn_date) visit_day, COUNT(*) cnt,
                COUNT(DISTINCT emp_code) exec_cnt
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ?${sc}
           GROUP BY visit_day ORDER BY visit_day`, [from, to, ...sp]),
      ]);

      res.json({ from, to, executives: execRows.rows, purposes: purposeRows.rows, daily_trend: dailyRows.rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/dcr-analytics/agency-coverage ────────────────────────────────
  app.get('/api/dcr-analytics/agency-coverage', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp, unitCodes } = await resolveScope(req);

      const amCl = unitCodes === null ? '' : (unitCodes.length ? ` AND unit IN (${unitCodes.map(()=>'?').join(',')})` : ' AND 1=0');
      const amP  = unitCodes === null ? [] : (unitCodes.length ? unitCodes : []);
      const osCl = unitCodes === null ? '' : (unitCodes.length ? ` AND unit_code IN (${unitCodes.map(()=>'?').join(',')})` : ' AND 1=0');

      const [agR, visitR, osR, supR] = await Promise.all([
        // dpcd=1 → main agency only (dpcd>1 = sub-agency of same agcd)
        q(`SELECT agcd, ag_name, unit_name, executive_name,
                  COALESCE(city_name, dist_name) city_name
           FROM agency_master
           WHERE CAST(dpcd AS UNSIGNED) = 1
             AND executive_code IS NOT NULL AND executive_code != ''
             AND (supply_stop_flag IS NULL OR supply_stop_flag != 'Y')
             AND suspend_date IS NULL${amCl} LIMIT 5000`, amP),

        q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, COUNT(*) cnt
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ? AND visit_to_main_code IS NOT NULL${sc}
           GROUP BY visit_to_main_code`, [from, to, ...sp]),

        q(`SELECT ag_code, cl_amt FROM agency_outstanding
           WHERE period_label='CURRENT' AND cl_amt > 0${osCl}`, amP),

        // Avg daily supply last 60 days — unit_code+agcd is the unique key
        q(`SELECT unit_code, agcd, ROUND(SUM(sup_copy)/GREATEST(COUNT(DISTINCT supply_date),1),0) avg_daily
           FROM supply_data
           WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)${osCl}
           GROUP BY unit_code, agcd`, amP),
      ]);

      // Key all maps by "unit_code|agcd" so same agcd across different units doesn't collide
      const visitMap = {}, osMap = {}, supMap = {};
      for (const r of visitR.rows) visitMap[r.ag_code] = { last: r.last_visit, cnt: +r.cnt };
      for (const r of osR.rows) osMap[r.ag_code] = +r.cl_amt;
      for (const r of supR.rows) supMap[r.agcd] = +r.avg_daily;

      const fromD = new Date(from), toD = new Date(to);
      const rangeDays = Math.max(1, Math.round((toD - fromD) / 86400000));
      const minCnt = Math.ceil(rangeDays / 14);

      const notVisited = [], rarely = [], covered = [];
      for (const ag of agR.rows) {
        const v = visitMap[ag.agcd] || {};
        const cnt = v.cnt || 0;
        const os  = osMap[ag.agcd] || 0;
        const rec = { agcd: ag.agcd, ag_name: ag.ag_name, unit_name: ag.unit_name,
                      exec: ag.executive_name, city: ag.city_name || '',
                      last_visit: v.last || null, visit_count: cnt,
                      outstanding: os, avg_supply: supMap[ag.agcd] || 0 };
        if (!cnt) notVisited.push(rec);
        else if (cnt < minCnt) rarely.push(rec);
        else covered.push(rec);
      }
      notVisited.sort((a, b) => b.outstanding - a.outstanding);
      rarely.sort((a, b) => b.outstanding - a.outstanding);

      res.json({
        from, to, total: agR.rows.length,
        not_visited: notVisited.slice(0, 200),
        rarely_visited: rarely.slice(0, 100),
        well_covered: covered.length,
        coverage_pct: Math.round(covered.length / Math.max(agR.rows.length, 1) * 100),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/dcr-analytics/visit-remarks ─────────────────────────────────
  app.get('/api/dcr-analytics/visit-remarks', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const from = isDate(req.query.from) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      const to   = isDate(req.query.to)   ? req.query.to   : new Date().toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);
      const emp = req.query.emp_code ? ` AND emp_code = ?` : '';
      const ep  = req.query.emp_code ? [String(req.query.emp_code)] : [];

      const { rows } = await q(
        `SELECT id, DATE(mark_attn_date) visit_date, emp_code, executive_name, unit_code, unit_name,
                visit_to_main_code ag_code, center_name ag_name,
                visit_purpose, visit_remarks, from_time, till_time,
                followup_amount, followup_date
         FROM dcr_agency_visit
         WHERE mark_attn_date BETWEEN ? AND ?
           AND visit_remarks IS NOT NULL AND TRIM(visit_remarks) != '' AND LOWER(TRIM(visit_remarks)) != 'no remarks'
           ${sc}${emp}
         ORDER BY mark_attn_date DESC, id DESC LIMIT 50`,
        [from, to, ...sp, ...ep]
      );
      // Decode Oracle-stored HTML entities (e.g. &#2360; → स) so Hindi renders correctly
      const dec = s => s ? s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)) : s;
      rows.forEach(r => {
        r.visit_remarks   = dec(r.visit_remarks);
        r.visit_purpose   = dec(r.visit_purpose);
        r.ag_name         = dec(r.ag_name);
        r.executive_name  = dec(r.executive_name);
      });
      res.json({ from, to, visits: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── FREE Hinglish remark analyzer (no API key needed) ─────────────────────
  // Extracts payment/commitment/growth/issue/status from Hindi-English-Hinglish
  // field notes with keyword + amount pattern rules. Zero cost, instant, offline.
  // Keywords sourced from AI Keywords.docx (Hindi + Hinglish + English variations).
  function analyzeRemarkFree(remarkRaw, visitDate) {
    const raw = String(remarkRaw || '');
    const t = ' ' + raw.toLowerCase().replace(/[.,;:!()\-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    // has() checks both the lowercased ASCII text AND the original (for Hindi script)
    const has = (...words) => words.some(w => {
      const wl = w.toLowerCase();
      return t.includes(' ' + wl) || t.includes(wl + ' ') || t.includes(wl) || raw.includes(w);
    });

    // ── amounts with positions: "5000", "rs 5000", "₹5,000", "5 hazar", "2k", "1 lakh" ──
    const low = raw.toLowerCase();
    const amounts = [];   // { n, pos }
    const reAmt = /(?:rs\.?\s*|₹\s*)?(\d[\d,]*(?:\.\d+)?)\s*(hazaa?r|hajar|lakh|lac|k\b)?/gi;
    let m;
    while ((m = reAmt.exec(low)) !== null) {
      let n = parseFloat(m[1].replace(/,/g, ''));
      const unit = (m[2] || '').toLowerCase();
      if (unit.startsWith('haza') || unit.startsWith('haja') || unit === 'k') n *= 1000;
      else if (unit === 'lakh' || unit === 'lac') n *= 100000;
      if (!isNaN(n) && n >= 50 && n <= 10000000) amounts.push({ n: Math.round(n), pos: m.index });
    }
    const maxAmt = amounts.length ? Math.max(...amounts.map(a => a.n)) : 0;

    // ── AMOUNT RECEIVED signal ──
    const gotPayment = has(
      // Hinglish
      'mil gay', 'mile', ' mila', ' mili', 'de diya', 'de diye', 'diya h', 'diye h',
      'jama karva', 'jama kiya', 'jama ki ', 'cash liya', 'le liya', 'collect kiya',
      'collect ki ', 'vasuli hui', 'vasuli ki', 'vasool', 'payment aaya', 'payment mila',
      'prapt', 'deposit kiya', 'neft aaya', 'upi aaya', 'cheque mila', 'check mila',
      'nagad prapt', 'prapt kiye', 'app se jama', 'jama kar diya', 'cash prapt',
      'payment aa gaya', 'paisa aa gaya', 'paise aa gaye', 'paise mile', 'paise mili',
      // English
      'received', 'recieved', 'collected', 'cash received', 'cheque received',
      'neft received', 'upi received', 'payment received', 'payment collected',
      'amount received', 'payment done', 'payment cleared', 'amount deposited',
      // Hindi script
      'जमा', 'प्राप्त', 'भुगतान मिला', 'पेमेंट मिला', 'नगद प्राप्त', 'वसूली हुई',
      'पेमेंट मिल गया', 'पैसा मिला', 'पैसे मिले', 'कलेक्शन हो गया',
    );

    // ── AMOUNT COMMITTED / PROMISE signal ──
    const willPay = has(
      // Hinglish
      'dega', 'degi', 'denge', 'de dega', 'de denge', 'bhejega', 'bhej dega', 'kar dega',
      'karega', 'karegi', 'karenge', 'jama karega', 'jama kar dega',
      'kal tak', 'parso tak', 'jaldi de', 'btayege', 'batayege', 'bta dega', 'bata dega',
      'pay karega', 'payment karega', 'payment kre', 'payment karunga', 'payment karenge',
      'paise dega', 'paise denge', 'paisa dega', 'kal payment', 'payment arrange',
      'payment jaldi', 'payment clear karega', 'payment bhejega', 'tak de', 'tak kar',
      'baki dega', 'baaki dega', 'wada kiya', 'kal dega', 'kal bhejega',
      // English
      'promise', 'commitment', 'commit', 'will pay', 'will transfer', 'will deposit',
      'will clear', 'payment by', 'agreed to pay', 'assured to pay', 'payment due',
      'promised', 'payment promised', 'will arrange', 'will send',
      // Hindi script
      'पेमेंट करेगा', 'पेमेंट करेंगे', 'भुगतान करेगा', 'भुगतान करने का वादा',
      'पेमेंट कमिट', 'अमाउंट कमिट', 'भुगतान का आश्वासन', 'रकम देने का वादा',
    );

    // ── COPY GROWTH signal ──
    const growthTalk = has(
      // Hinglish
      'growth', 'gorwth', 'grwth', 'badha', 'badhay', 'badhane', 'badh jaye', 'increase',
      'copy badh', 'copies badh', 'prati badh', 'new copy', 'nayi copy', 'scheme', 'circulation badh',
      'copy badhayega', 'copies badhayega', 'supply badhayega', 'copies increase karega',
      'growth denge', 'extra copies lega', 'aur copies lega', 'additional copies lega',
      'extra supply lega', 'copy badhane', 'copies badhane',
      // Hindi script
      'कॉपी बढ़ाएगा', 'कॉपियां बढ़ाएगा', 'सप्लाई बढ़ाएगा', 'ग्रोथ देगा',
      'अतिरिक्त कॉपियां', 'और कॉपियां', 'कॉपी बढ़ाने',
    );
    let growthNum = 0;
    const gm = raw.match(/(\d{1,4})\s*(?:copy|copies|prati|paper|pepar)/i);
    if (growthTalk && gm) growthNum = +gm[1];

    // ── UNSOLD / EXCESS COPIES signal ──
    const unsoldCopies = has(
      'bach rahi', 'bach rahe', 'bachti hai', 'unsold', 'bik nahi', 'nahi bik',
      'nhi bik', 'wapas ja rahi', 'wapas aa rahi', 'wapas aayi', 'extra copy aa',
      'jyada copy', 'jyada supply', 'copy bac', 'copies bac',
      // Hindi script
      'कॉपी बच', 'कॉपियां बच', 'अनसोल्ड', 'वापस जा', 'सप्लाई ज्यादा',
      'बिक नहीं', 'एक्स्ट्रा कॉपी',
    );

    // ── LATE SUPPLY / DELIVERY signal ──
    const lateSupply = has(
      'supply late', 'late supply', 'paper late', 'copy late', 'der se supply',
      'der se aata', 'der se milta', 'der se milti', 'late milti', 'late milta',
      'late aata', 'late aati', 'taxi late', 'gaadi late', 'gadi late',
      'delivery late', 'late delivery', 'supply mein deri', 'supply me deri',
      // Hindi script
      'सप्लाई लेट', 'लेट सप्लाई', 'टैक्सी लेट', 'गाड़ी लेट', 'डिलीवरी लेट',
      'देर से सप्लाई', 'सप्लाई में देरी',
    );

    // ── PHONE NOT ANSWERING signal ──
    const phoneNoAnswer = has(
      'phone nahi utha', 'phone nhi utha', 'call nahi utha', 'call nhi utha',
      'mobile band', 'phone band', 'number nahi lag', 'number nhi lag',
      'sampark nahi', 'jawab nahi', 'koi response nahi', 'call back nahi',
      'not answering', 'no response', 'phone switched off', 'unreachable',
      // Hindi script
      'फोन नहीं उठा', 'मोबाइल बंद', 'संपर्क नहीं', 'जवाब नहीं',
    );

    // ── OUT OF STATION signal ──
    const outOfStation = has(
      'out of station', 'bahar gaye', 'bahar he', 'bahar hai', 'shehar se bahar',
      'tour par', 'yatra par', 'gaon gaye', 'village gaye', 'chhuti par', 'leave par',
      // Hindi script
      'बाहर गए', 'शहर से बाहर', 'टूर पर', 'यात्रा पर', 'छुट्टी पर', 'गांव गए',
    );

    // ── HEALTH / UNWELL signal ──
    const agentUnwell = has(
      'bimar', 'bimaar', 'bimari', 'aspataal', 'hospital', 'admit', 'tabiyat',
      'ilaaj', 'aaram kar', 'bachcha bimaar', 'bache ki tabiyat', 'family mein koi bimaar',
      // Hindi script
      'बीमार', 'तबीयत', 'अस्पताल', 'हॉस्पिटल', 'इलाज', 'आराम कर',
      'बच्चा बीमार', 'बच्चे की तबीयत',
    );

    // ── commitment date ──
    let cDate = null;
    const d = visitDate ? new Date(visitDate) : new Date();
    const iso = dt => dt.toISOString().slice(0, 10);
    const dm = raw.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    if (has(' kal ', 'kal tak', 'kla tak', 'kl tak')) cDate = iso(new Date(+d + 86400000));
    else if (has('parso', 'parson')) cDate = iso(new Date(+d + 2 * 86400000));
    else if (has('next week', 'agle hafte', 'agle week', 'hafte me')) cDate = 'soon';
    else if (dm && +dm[1] >= 1 && +dm[1] <= 31 && +dm[2] >= 1 && +dm[2] <= 12) {
      const yr = dm[3] ? (+dm[3] < 100 ? 2000 + +dm[3] : +dm[3]) : d.getFullYear();
      cDate = `${yr}-${String(+dm[2]).padStart(2, '0')}-${String(+dm[1]).padStart(2, '0')}`;
    } else if (willPay) cDate = 'soon';

    // ── issues (most specific first) ──
    let issue = null;
    if      (has('death', ' deth ', 'mrityu', 'swargvas', 'dehant'))
                                                                    issue = 'Death in agent family / agent expired';
    else if (has('band ho', 'band kar', 'close ho', 'band krna', 'bnd ho', 'supply band karne', 'copy band karne'))
                                                                    issue = 'Agency closing / wants to stop';
    else if (unsoldCopies)                                          issue = 'Unsold/excess copies — supply too high';
    else if (lateSupply)                                            issue = 'Late supply/delivery reported';
    else if (agentUnwell)                                           issue = 'Agent unwell / hospitalised';
    else if (has('naraz', 'naraaz', 'complaint', 'shikayat', 'dispute', 'jhagda'))
                                                                    issue = 'Agent upset / complaint pending';
    else if (outOfStation)                                          issue = 'Agent out of station';
    else if (has('ghar nahi', 'ghar par nahi', 'nahi mile', 'nahi mila', 'nhi mile', 'nhi mila',
                 'band mila', 'shop band', 'dukaan band', 'agency band', 'office nahi mile',
                 'milne nahi mila', 'visit unsuccessful'))          issue = 'Agent not available at visit';
    else if (phoneNoAnswer)                                         issue = 'No phone response';
    else if (has('paisa nahi', 'paise nahi', 'payment problem', 'market kharab', 'mandi', 'udhari'))
                                                                    issue = 'Payment difficulty / market slow';
    else if (has('bill', 'billing') && has('galat', 'problem', 'issue', 'thik nahi'))
                                                                    issue = 'Billing issue reported';
    else if (has('supply', 'paper', 'pepar') && has('problem', 'nahi aa', 'nahi mili', 'nhi aa'))
                                                                    issue = 'Supply / delivery problem';

    // ── amounts → buckets by proximity to their signal keywords ──
    const RECV_WORDS = [
      'mil gay', 'mile', 'mila', 'mili', 'de diya', 'de diye', 'diya', 'diye',
      'jama karva', 'jama kiya', 'cash liya', 'le liya', 'collect', 'vasuli hui', 'vasool',
      'prapt', 'aaya', 'received', 'collected', 'payment mila', 'payment aa',
    ];
    const PAY_WORDS = [
      'dega', 'degi', 'denge', 'bhejega', 'karega', 'karenge', 'jama karega',
      'promise', 'commitment', 'tak de', 'btayege', 'batayege', 'kal tak', 'kla tak',
      'parso tak', 'baki', 'baaki', 'will pay', 'will transfer', 'agreed to pay',
    ];
    const allPos = words => { const ps = []; for (const w of words) { let i = -1; while ((i = low.indexOf(w, i + 1)) >= 0) ps.push(i); } return ps; };
    const recvPos = gotPayment ? allPos(RECV_WORDS) : [];
    const payPos  = willPay    ? allPos(PAY_WORDS)  : [];
    let paymentReceived = 0, commitAmt = 0;
    for (const a of amounts) {
      const dR = recvPos.length ? Math.min(...recvPos.map(p => Math.abs(p - a.pos))) : Infinity;
      const dP = payPos.length  ? Math.min(...payPos.map(p => Math.abs(p - a.pos)))  : Infinity;
      if (dR === Infinity && dP === Infinity) continue;
      if (dR <= dP) paymentReceived = Math.max(paymentReceived, a.n);
      else          commitAmt       = Math.max(commitAmt, a.n);
    }
    if (gotPayment && !paymentReceived && !willPay) paymentReceived = maxAmt;
    if (willPay && !commitAmt && !gotPayment)       commitAmt = maxAmt;

    // ── status ──
    let status;
    const unavailable = issue === 'Agent not available at visit' ||
                        issue === 'Agent out of station' ||
                        issue === 'No phone response';
    if (paymentReceived > 0)                        status = 'productive';
    else if (gotPayment)                            status = 'productive';
    else if (unavailable)                           status = 'no-response';
    else if (willPay || (growthTalk && growthNum))  status = 'follow-up';
    else if (growthTalk || unsoldCopies || lateSupply ||
             has('bat hui', 'bat ki', 'baat hui', 'baat ki', 'discuss', 'samjhaya', 'mila ', 'mile '))
                                                    status = 'partial';
    else                                            status = 'info-only';

    return {
      payment_received: paymentReceived,
      commitment_amount: commitAmt,
      commitment_date: commitAmt > 0 || willPay ? cDate : null,
      growth_commitment: growthNum,
      issue, status,
    };
  }

  // ── Ollama helper (free local LLM on LAN; OLLAMA_URL + OLLAMA_MODEL in .env) ──
  async function ollamaChat(prompt, timeoutMs = 60000) {
    const url = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
    if (!url) return null;
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ model, stream: false, options: { temperature: 0 },
          messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      return { text: d.message?.content || '', model: 'Ollama ' + model };
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
  }

  // ── POST /api/dcr-analytics/analyze-remarks ───────────────────────────────
  // Engine order: Claude (if ANTHROPIC_API_KEY) → Ollama (if OLLAMA_URL) → free
  // built-in pattern engine. NEVER fails for lack of a paid key.
  app.post('/api/dcr-analytics/analyze-remarks', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { visits } = req.body || {};
      if (!Array.isArray(visits) || !visits.length) return res.status(400).json({ detail: 'visits[] required' });
      const dec = s => s ? s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)) : s;
      const batch = visits.slice(0, 50);

      const API_KEY = process.env.ANTHROPIC_API_KEY;
      if (API_KEY) {
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey: API_KEY });
          const visitList = batch.slice(0, 20).map((v, i) =>
            `[${i+1}] ${v.visit_date||''} | Exec: ${dec(v.executive_name)||'-'} | Agency: ${dec(v.ag_name)||v.ag_code||'-'} | Purpose: ${dec(v.purpose)||'-'}\nRemarks: ${dec(v.remarks)||'(no remarks)'}`
          ).join('\n\n');
          const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 3500,
            messages: [{ role: 'user', content: `Analyze field visit notes from newspaper circulation executives. Remarks are in Hindi, English, or Hinglish (mixed).

KEY RULES:
- "₹50,000 mila / received / prapt / jama karva / vasool" → payment_received=50000
- "kal dega / karega / denge / promise / commitment / wada kiya" → commitment_amount (future)
- "50 copy badhayega / growth / increase / badha" → growth_commitment=50
- "copy bach rahi / unsold / bik nahi / extra copy" → issue=unsold copies
- "supply late / taxi late / der se supply / delivery late" → issue=late supply
- "bimaar / tabiyat / aspataal / hospital" → issue=agent unwell
- "bahar gaye / out of station / tour par / chhuti par" → issue=out of station
- "ghar nahi / nahi mile / dukaan band / agency band" → issue=not available
- "phone nahi utha / mobile band / sampark nahi" → issue=no phone response
- Judge by FULL SENTENCE CONTEXT, not keywords alone.

For each numbered visit extract:
- payment_received: amount received NOW (number, 0 if none)
- commitment_amount: amount promised for future payment (number, 0 if none)
- commitment_date: "YYYY-MM-DD" or "soon" or null
- growth_commitment: copies increase committed (number, 0)
- issue: main problem in 5-8 English words (null if none)
- status: one of "productive"|"partial"|"follow-up"|"no-response"|"info-only"

Return ONLY a valid JSON array, no prose:
[{"idx":1,"payment_received":0,"commitment_amount":0,"commitment_date":null,"growth_commitment":0,"issue":null,"status":"info-only"},...]

Visits:
${visitList}` }]
          });
          const text = resp.content[0]?.text || '[]';
          const jm = text.match(/\[[\s\S]*\]/);
          const results = jm ? JSON.parse(jm[0]) : [];
          if (results.length) return res.json({ results, model: 'Claude Haiku' });
        } catch (_) { /* fall through to free engine */ }
      }

      // Tier 2: Ollama on LAN (free local LLM)
      if (process.env.OLLAMA_URL) {
        const visitList = batch.slice(0, 20).map((v, i) =>
          `[${i+1}] ${v.visit_date||''} | Agency: ${dec(v.ag_name)||v.ag_code||'-'}\nRemarks: ${dec(v.remarks)||'(no remarks)'}`
        ).join('\n\n');
        const o = await ollamaChat(
          // 5-min budget: CPU inference of a 7-9B model on ~20 remarks is slow but accurate
          `Analyze field visit notes from newspaper circulation executives. Remarks are Hindi/English/Hinglish mixed.\n\nFor each numbered visit extract:\n- payment_received: cash received NOW (number, 0 if none)\n- commitment_amount: promised payment (number, 0 if none)\n- commitment_date: "YYYY-MM-DD" or "soon" or null\n- growth_commitment: copies increase promised (number, 0)\n- issue: main problem, max 8 English words (null if none)\n- status: one of "productive"|"partial"|"follow-up"|"no-response"|"info-only"\n\nReturn ONLY a JSON array, no other text:\n[{"idx":1,"payment_received":0,"commitment_amount":0,"commitment_date":null,"growth_commitment":0,"issue":null,"status":"info-only"}]\n\nVisits:\n${visitList}`, 300000);
        if (o) {
          try {
            const jm = o.text.match(/\[[\s\S]*\]/);
            const results = jm ? JSON.parse(jm[0]) : [];
            if (results.length) return res.json({ results, model: o.model });
          } catch (_) { /* fall through */ }
        }
      }

      // FREE engine — always available
      const results = batch.map((v, i) => ({ idx: i + 1, ...analyzeRemarkFree(dec(v.remarks), v.visit_date) }));
      res.json({ results, model: 'Built-in Pattern Engine (free)' });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/dcr-analytics/next-day-plan ────────────────────────────────
  app.post('/api/dcr-analytics/next-day-plan', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { emp_code, plan_date } = req.body || {};
      if (!emp_code) return res.status(400).json({ detail: 'emp_code required' });
      const API_KEY = process.env.ANTHROPIC_API_KEY;

      const tDate = isDate(plan_date) ? plan_date : new Date(Date.now() + 86400000).toISOString().slice(0,10);

      // Resolve exec_name from DCR (emp_code format differs from agency_master.executive_code)
      const execInfoR = await q(
        `SELECT MAX(executive_name) exec_name FROM dcr_agency_visit WHERE emp_code=? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) LIMIT 1`,
        [emp_code]
      );
      const execName = execInfoR.rows[0]?.exec_name || emp_code;

      const [agR, visitR, osR] = await Promise.all([
        // Match by executive_name — dpcd=1 for main agencies only
        q(`SELECT agcd, ag_name, COALESCE(city_name, dist_name) city_name, unit_name
           FROM agency_master
           WHERE executive_name=? AND CAST(dpcd AS UNSIGNED)=1
             AND (supply_stop_flag IS NULL OR supply_stop_flag!='Y') AND suspend_date IS NULL
           LIMIT 150`, [execName]),
        q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, COUNT(*) cnt, MAX(visit_remarks) last_remarks, MAX(followup_amount) fup_amt, MAX(followup_date) fup_date
           FROM dcr_agency_visit WHERE emp_code=? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
           GROUP BY visit_to_main_code`, [emp_code]),
        q(`SELECT ao.ag_code, ao.cl_amt FROM agency_outstanding ao
           JOIN agency_master am ON am.agcd=ao.ag_code AND CAST(am.dpcd AS UNSIGNED)=1
           WHERE am.executive_name=? AND ao.period_label='CURRENT' AND ao.cl_amt>0
           GROUP BY ao.ag_code`, [execName]),
      ]);

      const vMap = {}, osMap = {};
      for (const r of visitR.rows) vMap[r.ag_code] = r;
      for (const r of osR.rows) osMap[r.ag_code] = +r.cl_amt;

      const unitName = agR.rows[0]?.unit_name || '';

      // agency_master can hold multiple rows per agcd (editions) — dedup or the
      // same agency appears twice in the plan
      const seenAg = new Set();
      const agRowsUniq = agR.rows.filter(r => !seenAg.has(r.agcd) && seenAg.add(r.agcd));

      const agList = agRowsUniq.map(ag => {
        const v = vMap[ag.agcd] || {};
        const os = osMap[ag.agcd] || 0;
        const days = v.last_visit ? Math.floor((Date.now() - new Date(v.last_visit)) / 86400000) : 999;
        return { code: ag.agcd, name: ag.ag_name, city: ag.city_name || ag.dist_name, os, days, cnt60: +(v.cnt||0), last_rmk: (v.last_remarks||'').slice(0,80), fup_amt: +(v.fup_amt||0), fup_date: v.fup_date||'' };
      }).sort((a,b) => b.os - a.os || b.days - a.days).slice(0, 40);

      // Per-agency avg supply (last 7 days) → data-driven copy-growth ask
      // (~5% of current copies, rounded to 5, min 5, max 50)
      const supMap = {};
      if (agList.length) {
        const ph = agList.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT agcd, AVG(sup_copy) avg_sup FROM supply_data
           WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND agcd IN (${ph})
           GROUP BY agcd`, agList.map(a => a.code));
        supRows.forEach(r => { supMap[r.agcd] = Math.round(+r.avg_sup || 0); });
      }
      agList.forEach(a => {
        a.avg_sup = supMap[a.code] || 0;
        a.growth_ask = a.avg_sup ? Math.min(50, Math.max(5, Math.round(a.avg_sup * 0.05 / 5) * 5)) : 0;
      });

      const agText = agList.map((a,i) =>
        `${i+1}. ${a.name} (${a.city||'-'}) | OS:Rs${a.os.toLocaleString('en-IN')} | Last visit:${a.days>=999?'Never':a.days+'d ago'} | 60d visits:${a.cnt60} | Followup:Rs${a.fup_amt} by ${a.fup_date||'?'} | Avg supply:${a.avg_sup||'?'} copies/day | Suggested growth ask:+${a.growth_ask||'?'} copies | Note:"${a.last_rmk}"`
      ).join('\n');
      const planPrompt = `You are a circulation manager at Rajasthan Patrika newspaper. Create a smart next-day field visit plan for executive ${execName} working in ${unitName} for the date ${tDate}.\n\nPrioritization logic:\n1. High outstanding balance (OS) = highest priority = needs recovery\n2. Pending followup commitment (fup_amt > 0) = visit to collect what was promised\n3. Not visited in 30+ days = coverage gap\n4. Never visited = must cover\n\nMOST IMPORTANT: Copy Growth is our MAIN GOAL. In EVERY visit's key_point, ask for a specific copy-growth commitment using that agency's "Suggested growth ask" number (e.g. "कम से कम 10 Copies की Growth का Commitment ज़रूर लें").\n\nLimit to top 8 agencies. NEVER repeat the same agency twice. Write brief, actionable instructions.\nLanguage: Hinglish — simple Hindi (Devanagari) mixed with common English business words (Visit, Recovery, Outstanding, Payment, Confirmed Date, Commitment, Copy Growth), the way Indian office teams talk. Keep agency names, amounts and dates as-is.\n\nAgencies available:\n${agText}\n\nReturn ONLY valid JSON (no prose before or after):\n{"exec":"${execName}","unit":"${unitName}","date":"${tDate}","focus_message":"...1 line motivational message in Hindi ending with growth reminder...","total_target":0,"visits":[{"rank":1,"ag_code":"...","ag_name":"...","city":"...","priority":"high|medium|low","action":"...Hindi instruction: वसूली/विज़िट/followup...","target_amount":0,"key_point":"...Hindi: one critical point + growth commitment ask..."}]}`;

      // Tier 1: Claude (if key configured)
      if (API_KEY) {
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey: API_KEY });
          const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 1800,
            messages: [{ role: 'user', content: planPrompt }]
          });
          const text = resp.content[0]?.text || '{}';
          const jm = text.match(/\{[\s\S]*\}/);
          const plan = jm ? JSON.parse(jm[0]) : null;
          if (plan && (plan.visits || []).length)
            return res.json({ plan, exec_name: execName, unit_name: unitName, model: 'Claude Haiku' });
        } catch (_) { /* fall through */ }
      }

      // Tier 2: Ollama on LAN (free local LLM)
      if (process.env.OLLAMA_URL) {
        const o = await ollamaChat(planPrompt, 300000);
        if (o) {
          try {
            const jm = o.text.match(/\{[\s\S]*\}/);
            const plan = jm ? JSON.parse(jm[0]) : null;
            if (plan && (plan.visits || []).length)
              return res.json({ plan, exec_name: execName, unit_name: unitName, model: o.model });
          } catch (_) { /* fall through */ }
        }
      }

      // Tier 3: FREE rule engine — deterministic prioritization, always available.
      // Hinglish output (office style) + data-driven copy-growth ask on EVERY visit.
      const pick = agList.slice(0, 8).map((a, i) => {
        const priority = (a.os > 50000 || a.fup_amt > 0) ? 'high' : (a.os > 10000 || a.days >= 30) ? 'medium' : 'low';
        const gAsk = a.growth_ask > 0
          ? `कम से कम ${a.growth_ask} Copies की Growth का Commitment ज़रूर लें।`
          : `Copy Growth का Commitment ज़रूर लें।`;
        let action, key_point;
        if (a.fup_amt > 0) {
          action = `वादा की गई Payment ₹${a.fup_amt.toLocaleString('en-IN')} वसूल करें${a.fup_date ? ' (due: ' + String(a.fup_date).slice(0,10) + ')' : ''}`;
          key_point = `Agent ने यह राशि देने का वादा किया था — Recovery करें। ${gAsk}`;
        } else if (a.os > 0 && a.days >= 999) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `अब तक कोई Visit नहीं हुई है। पहले Agency से proper contact establish करें, उसके बाद Recovery और Copy Growth पर discussion करें।`;
        } else if (a.os > 0 && a.days >= 30) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `पिछले ${a.days} दिनों से Visit नहीं हुई है। Recovery के साथ ${gAsk}`;
        } else if (a.os > 0) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `Cash Recovery करें या Payment की Confirmed Date लें। Recovery के साथ ${gAsk}`;
        } else if (a.days >= 999) {
          action = `पहली Visit — परिचय करें और Agency की स्थिति देखें`;
          key_point = `Contact establish करें और Copy Growth की संभावना पर discussion करें।`;
        } else {
          action = `Contact Visit — आख़िरी Visit ${a.days} दिन पहले`;
          key_point = `Supply satisfaction पूछें। ${gAsk}`;
        }
        const target_amount = a.fup_amt > 0 ? a.fup_amt : (a.os > 0 ? Math.round(a.os * 0.25) : 0);
        return { rank: i + 1, ag_code: a.code, ag_name: a.name, city: a.city || '', priority, action, target_amount, key_point };
      });
      const totalTarget = pick.reduce((s, v) => s + v.target_amount, 0);
      const plan = {
        exec: execName, unit: unitName, date: tDate,
        focus_message: totalTarget > 0
          ? `Target: ${pick.filter(v => v.target_amount > 0).length} Agencies से ₹${totalTarget.toLocaleString('en-IN')} की Recovery करनी है। हर Visit पर Cash Recovery लेने की कोशिश करें या Payment की Confirmed Date ज़रूर लें। साथ ही, हर Agency से Copy Growth का Commitment लेना अनिवार्य है — यही हमारा मुख्य लक्ष्य है!`
          : `हर Agency पर contact मज़बूत करें और Copy Growth का Commitment लें — यही हमारा मुख्य लक्ष्य है!`,
        total_target: totalTarget, visits: pick,
      };
      res.json({ plan, exec_name: execName, unit_name: unitName, model: 'Rule Engine (free)' });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/dcr-analytics/week-plan ────────────────────────────────────
  // 7-day version of next-day-plan — same data source, same 3-tier engine
  // (Claude Haiku → Ollama → rule engine), same Hinglish style; spreads the
  // top ~21 agencies (3/day) across the week instead of picking 8 for one day.
  app.post('/api/dcr-analytics/week-plan', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { emp_code, start_date } = req.body || {};
      if (!emp_code) return res.status(400).json({ detail: 'emp_code required' });
      const API_KEY = process.env.ANTHROPIC_API_KEY;
      const VISITS_PER_DAY = 3, TOTAL_DAYS = 7;

      const sDate = isDate(start_date) ? start_date : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const dayDates = Array.from({ length: TOTAL_DAYS }, (_, i) => {
        const d = new Date(sDate); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10);
      });

      const execInfoR = await q(
        `SELECT MAX(executive_name) exec_name FROM dcr_agency_visit WHERE emp_code=? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) LIMIT 1`,
        [emp_code]
      );
      const execName = execInfoR.rows[0]?.exec_name || emp_code;

      const [agR, visitR, osR] = await Promise.all([
        q(`SELECT agcd, ag_name, COALESCE(city_name, dist_name) city_name, unit_name
           FROM agency_master
           WHERE executive_name=? AND CAST(dpcd AS UNSIGNED)=1
             AND (supply_stop_flag IS NULL OR supply_stop_flag!='Y') AND suspend_date IS NULL
           LIMIT 150`, [execName]),
        q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, COUNT(*) cnt, MAX(visit_remarks) last_remarks, MAX(followup_amount) fup_amt, MAX(followup_date) fup_date
           FROM dcr_agency_visit WHERE emp_code=? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
           GROUP BY visit_to_main_code`, [emp_code]),
        q(`SELECT ao.ag_code, ao.cl_amt FROM agency_outstanding ao
           JOIN agency_master am ON am.agcd=ao.ag_code AND CAST(am.dpcd AS UNSIGNED)=1
           WHERE am.executive_name=? AND ao.period_label='CURRENT' AND ao.cl_amt>0
           GROUP BY ao.ag_code`, [execName]),
      ]);

      const vMap = {}, osMap = {};
      for (const r of visitR.rows) vMap[r.ag_code] = r;
      for (const r of osR.rows) osMap[r.ag_code] = +r.cl_amt;

      const unitName = agR.rows[0]?.unit_name || '';
      const seenAg = new Set();
      const agRowsUniq = agR.rows.filter(r => !seenAg.has(r.agcd) && seenAg.add(r.agcd));

      const agList = agRowsUniq.map(ag => {
        const v = vMap[ag.agcd] || {};
        const os = osMap[ag.agcd] || 0;
        const days = v.last_visit ? Math.floor((Date.now() - new Date(v.last_visit)) / 86400000) : 999;
        return { code: ag.agcd, name: ag.ag_name, city: ag.city_name || ag.dist_name, os, days, cnt60: +(v.cnt || 0), last_rmk: (v.last_remarks || '').slice(0, 80), fup_amt: +(v.fup_amt || 0), fup_date: v.fup_date || '' };
      }).sort((a, b) => b.os - a.os || b.days - a.days).slice(0, VISITS_PER_DAY * TOTAL_DAYS);

      const supMap = {};
      if (agList.length) {
        const ph = agList.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT agcd, AVG(sup_copy) avg_sup FROM supply_data
           WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND agcd IN (${ph})
           GROUP BY agcd`, agList.map(a => a.code));
        supRows.forEach(r => { supMap[r.agcd] = Math.round(+r.avg_sup || 0); });
      }
      agList.forEach(a => {
        a.avg_sup = supMap[a.code] || 0;
        a.growth_ask = a.avg_sup ? Math.min(50, Math.max(5, Math.round(a.avg_sup * 0.05 / 5) * 5)) : 0;
      });

      const agText = agList.map((a, i) =>
        `${i + 1}. ${a.name} (${a.city || '-'}) | OS:Rs${a.os.toLocaleString('en-IN')} | Last visit:${a.days >= 999 ? 'Never' : a.days + 'd ago'} | 60d visits:${a.cnt60} | Followup:Rs${a.fup_amt} by ${a.fup_date || '?'} | Avg supply:${a.avg_sup || '?'} copies/day | Suggested growth ask:+${a.growth_ask || '?'} copies | Note:"${a.last_rmk}"`
      ).join('\n');
      const weekPrompt = `You are a circulation manager at Rajasthan Patrika newspaper. Create a smart 7-DAY field visit plan (Day 1 to Day 7, starting ${sDate}) for executive ${execName} working in ${unitName}.\n\nPrioritization logic:\n1. High outstanding balance (OS) = highest priority = needs recovery\n2. Pending followup commitment (fup_amt > 0) = visit to collect what was promised\n3. Not visited in 30+ days = coverage gap\n4. Never visited = must cover\n\nMOST IMPORTANT: Copy Growth is our MAIN GOAL. In EVERY visit's key_point, ask for a specific copy-growth commitment using that agency's "Suggested growth ask" number.\n\nSpread ~${VISITS_PER_DAY} visits per day across all 7 days. NEVER repeat the same agency twice across the whole week.\nLanguage: Hinglish — simple Hindi (Devanagari) mixed with common English business words (Visit, Recovery, Outstanding, Payment, Confirmed Date, Commitment, Copy Growth), the way Indian office teams talk. Keep agency names, amounts and dates as-is.\n\nAgencies available:\n${agText}\n\nReturn ONLY valid JSON (no prose before or after):\n{"exec":"${execName}","unit":"${unitName}","start_date":"${sDate}","days":[{"day":1,"date":"${dayDates[0]}","focus_message":"...1 line Hindi motivational message ending with growth reminder...","total_target":0,"visits":[{"rank":1,"ag_code":"...","ag_name":"...","city":"...","priority":"high|medium|low","action":"...Hindi instruction...","target_amount":0,"key_point":"...Hindi: one critical point + growth commitment ask..."}]}, ... repeat for all 7 days ...]}`;

      if (API_KEY) {
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey: API_KEY });
          const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
            messages: [{ role: 'user', content: weekPrompt }]
          });
          const text = resp.content[0]?.text || '{}';
          const jm = text.match(/\{[\s\S]*\}/);
          const plan = jm ? JSON.parse(jm[0]) : null;
          if (plan && (plan.days || []).length)
            return res.json({ plan, exec_name: execName, unit_name: unitName, model: 'Claude Haiku' });
        } catch (_) { /* fall through */ }
      }

      if (process.env.OLLAMA_URL) {
        // Shorter timeout than next-day-plan: a 7-day/21-visit JSON response takes the
        // local model much longer to generate than a single day's 8 visits — cap the
        // wait so a slow model falls through to the instant rule engine below instead
        // of leaving the user staring at a spinner for minutes.
        const o = await ollamaChat(weekPrompt, 60000);
        if (o) {
          try {
            const jm = o.text.match(/\{[\s\S]*\}/);
            const plan = jm ? JSON.parse(jm[0]) : null;
            if (plan && (plan.days || []).length)
              return res.json({ plan, exec_name: execName, unit_name: unitName, model: o.model });
          } catch (_) { /* fall through */ }
        }
      }

      // Tier 3: FREE rule engine — same per-agency Hinglish logic as next-day-plan,
      // bucketed VISITS_PER_DAY agencies per day across the week.
      const buildVisit = (a, rank) => {
        const priority = (a.os > 50000 || a.fup_amt > 0) ? 'high' : (a.os > 10000 || a.days >= 30) ? 'medium' : 'low';
        const gAsk = a.growth_ask > 0
          ? `कम से कम ${a.growth_ask} Copies की Growth का Commitment ज़रूर लें।`
          : `Copy Growth का Commitment ज़रूर लें।`;
        let action, key_point;
        if (a.fup_amt > 0) {
          action = `वादा की गई Payment ₹${a.fup_amt.toLocaleString('en-IN')} वसूल करें${a.fup_date ? ' (due: ' + String(a.fup_date).slice(0, 10) + ')' : ''}`;
          key_point = `Agent ने यह राशि देने का वादा किया था — Recovery करें। ${gAsk}`;
        } else if (a.os > 0 && a.days >= 999) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `अब तक कोई Visit नहीं हुई है। पहले Agency से proper contact establish करें, उसके बाद Recovery और Copy Growth पर discussion करें।`;
        } else if (a.os > 0 && a.days >= 30) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `पिछले ${a.days} दिनों से Visit नहीं हुई है। Recovery के साथ ${gAsk}`;
        } else if (a.os > 0) {
          action = `Outstanding: ₹${a.os.toLocaleString('en-IN')}`;
          key_point = `Cash Recovery करें या Payment की Confirmed Date लें। Recovery के साथ ${gAsk}`;
        } else if (a.days >= 999) {
          action = `पहली Visit — परिचय करें और Agency की स्थिति देखें`;
          key_point = `Contact establish करें और Copy Growth की संभावना पर discussion करें।`;
        } else {
          action = `Contact Visit — आख़िरी Visit ${a.days} दिन पहले`;
          key_point = `Supply satisfaction पूछें। ${gAsk}`;
        }
        const target_amount = a.fup_amt > 0 ? a.fup_amt : (a.os > 0 ? Math.round(a.os * 0.25) : 0);
        return { rank, ag_code: a.code, ag_name: a.name, city: a.city || '', priority, action, target_amount, key_point };
      };

      const days = [];
      for (let d = 0; d < TOTAL_DAYS; d++) {
        const chunk = agList.slice(d * VISITS_PER_DAY, d * VISITS_PER_DAY + VISITS_PER_DAY);
        if (!chunk.length) continue;
        const visits = chunk.map((a, i) => buildVisit(a, i + 1));
        const total_target = visits.reduce((s, v) => s + v.target_amount, 0);
        days.push({
          day: d + 1, date: dayDates[d],
          focus_message: total_target > 0
            ? `Target: ${visits.filter(v => v.target_amount > 0).length} Agencies से ₹${total_target.toLocaleString('en-IN')} की Recovery करनी है। हर Visit पर Copy Growth का Commitment लेना अनिवार्य है!`
            : `हर Agency पर contact मज़बूत करें और Copy Growth का Commitment लें!`,
          total_target, visits,
        });
      }
      const plan = { exec: execName, unit: unitName, start_date: sDate, days };
      res.json({ plan, exec_name: execName, unit_name: unitName, model: 'Rule Engine (free)' });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/dcr-analytics/incharges ────────────────────────────────────────
  // Circulation Incharges with their team size (from PLI hierarchy mapping)
  app.get('/api/dcr-analytics/incharges', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { rows } = await q(
        `SELECT circ_incharge code, MAX(circ_incharge_name) name,
                COUNT(DISTINCT exec_code) exec_count,
                GROUP_CONCAT(DISTINCT unit_code ORDER BY unit_code) units
         FROM exec_hierarchy_mapping
         WHERE circ_incharge IS NOT NULL AND circ_incharge != '' AND circ_incharge_name IS NOT NULL
         GROUP BY circ_incharge ORDER BY MAX(circ_incharge_name)`
      );
      res.json({ incharges: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/dcr-analytics/team-plan ───────────────────────────────────────
  // Combined next-day tour plan for ALL executives reporting to a Circulation
  // Incharge (from PLI hierarchy mapping), or of a unit. Rule engine only
  // (fast, deterministic); top 3 agencies per executive with growth ask.
  app.post('/api/dcr-analytics/team-plan', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { unit_code, circ_incharge, plan_date } = req.body || {};
      if (!unit_code && !circ_incharge) return res.status(400).json({ detail: 'unit_code or circ_incharge required' });
      const tDate = isDate(plan_date) ? plan_date : new Date(Date.now() + 86400000).toISOString().slice(0,10);
      const { clause: sc, params: sp } = await resolveScope(req);

      let execRows, unitName, incharge = null;
      if (circ_incharge) {
        // Team = executives mapped to this incharge in the PLI hierarchy
        const { rows: mapRows } = await q(
          `SELECT exec_code, MAX(exec_desc) exec_name, GROUP_CONCAT(DISTINCT unit_code) units,
                  MAX(circ_incharge_name) ci_name
           FROM exec_hierarchy_mapping
           WHERE circ_incharge = ? AND exec_desc IS NOT NULL AND exec_desc != 'N/A'
           GROUP BY exec_code ORDER BY MAX(exec_desc) LIMIT 20`,
          [String(circ_incharge)]
        );
        // Keep only PLI-active executives when the flag knows them (separate
        // query — no cross-collation JOIN); fall back to all if that empties it
        const { rows: actRows } = await q(
          `SELECT executive_code FROM exec_master WHERE is_active_pli = 'Y'`
        );
        const activeSet = new Set(actRows.map(r => r.executive_code));
        let team = mapRows.filter(r => activeSet.has(r.exec_code));
        if (!team.length) team = mapRows;
        execRows = team.map(r => ({ emp_code: null, exec_name: r.exec_name, unit_name: r.units }));
        incharge = { code: String(circ_incharge), name: mapRows[0]?.ci_name || '' };
        unitName = incharge.name ? `Team of ${incharge.name}` : String(circ_incharge);
      } else {
        // Active executives of the unit (visited in last 60 days)
        const { rows } = await q(
          `SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_name) unit_name
           FROM dcr_agency_visit
           WHERE unit_code = ? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)${sc}
           GROUP BY emp_code ORDER BY MAX(executive_name) LIMIT 15`,
          [String(unit_code), ...sp]
        );
        execRows = rows;
        unitName = rows[0]?.unit_name || String(unit_code);
      }
      if (!execRows.length) return res.json({ date: tDate, unit_code, unit_name: unitName || '', incharge, execs: [], grand_total: 0 });

      const teams = [];
      for (const ex of execRows) {
        const [agR, visitR, osR] = await Promise.all([
          q(`SELECT agcd, ag_name, COALESCE(city_name, dist_name) city_name
             FROM agency_master
             WHERE executive_name=? AND CAST(dpcd AS UNSIGNED)=1
               AND (supply_stop_flag IS NULL OR supply_stop_flag!='Y') AND suspend_date IS NULL
             LIMIT 150`, [ex.exec_name]),
          q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, MAX(followup_amount) fup_amt, MAX(followup_date) fup_date
             FROM dcr_agency_visit WHERE ${ex.emp_code ? 'emp_code=?' : 'executive_name=?'} AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
             GROUP BY visit_to_main_code`, [ex.emp_code || ex.exec_name]),
          q(`SELECT ao.ag_code, ao.cl_amt FROM agency_outstanding ao
             JOIN agency_master am ON am.agcd=ao.ag_code AND CAST(am.dpcd AS UNSIGNED)=1
             WHERE am.executive_name=? AND ao.period_label='CURRENT' AND ao.cl_amt>0
             GROUP BY ao.ag_code`, [ex.exec_name]),
        ]);
        const vMap = {}, osMap = {};
        for (const r of visitR.rows) vMap[r.ag_code] = r;
        for (const r of osR.rows) osMap[r.ag_code] = +r.cl_amt;
        const seen = new Set();
        const top = agR.rows.filter(r => !seen.has(r.agcd) && seen.add(r.agcd))
          .map(ag => {
            const v = vMap[ag.agcd] || {};
            const os = osMap[ag.agcd] || 0;
            const days = v.last_visit ? Math.floor((Date.now() - new Date(v.last_visit)) / 86400000) : 999;
            return { code: ag.agcd, name: ag.ag_name, city: ag.city_name || '', os, days, fup_amt: +(v.fup_amt||0), fup_date: v.fup_date || '' };
          })
          .sort((a, b) => b.os - a.os || b.days - a.days).slice(0, 3);
        teams.push({ emp_code: ex.emp_code, exec_name: ex.exec_name, visits: top });
      }

      // One supply query for ALL selected agencies → growth ask (~5% of avg, min 5, max 50)
      const allCodes = [...new Set(teams.flatMap(t => t.visits.map(v => v.code)))];
      const supMap = {};
      if (allCodes.length) {
        const ph = allCodes.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT agcd, AVG(sup_copy) avg_sup FROM supply_data
           WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND agcd IN (${ph})
           GROUP BY agcd`, allCodes);
        supRows.forEach(r => { supMap[r.agcd] = Math.round(+r.avg_sup || 0); });
      }
      let grandTotal = 0;
      for (const t of teams) {
        let sub = 0;
        t.visits = t.visits.map(v => {
          const avg = supMap[v.code] || 0;
          const growth_ask = avg ? Math.min(50, Math.max(5, Math.round(avg * 0.05 / 5) * 5)) : 0;
          const target_amount = v.fup_amt > 0 ? v.fup_amt : (v.os > 0 ? Math.round(v.os * 0.25) : 0);
          sub += target_amount;
          const note = v.fup_amt > 0
            ? `वादा की गई Payment ₹${v.fup_amt.toLocaleString('en-IN')} due${v.fup_date ? ' ' + String(v.fup_date).slice(0,10) : ''}`
            : v.days >= 999 ? 'अब तक कोई Visit नहीं'
            : v.days >= 30 ? `${v.days} दिन से Visit नहीं`
            : 'Cash Recovery / Confirmed Date लें';
          return { ...v, growth_ask, target_amount, note };
        });
        t.total_target = sub;
        grandTotal += sub;
      }

      res.json({ date: tDate, unit_code, unit_name: unitName, incharge, execs: teams, grand_total: grandTotal, model: 'Rule Engine (free)' });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/dcr-analytics/week-team-plan ──────────────────────────────────
  // 7-day version of team-plan — same Circulation Incharge / Unit picker (this
  // IS the hierarchy's "Unit Wise" level), top 3 agencies/exec spread across the
  // week (~21 total) instead of 3 for one day. Rule engine only, same as team-plan.
  app.post('/api/dcr-analytics/week-team-plan', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { unit_code, circ_incharge, start_date } = req.body || {};
      if (!unit_code && !circ_incharge) return res.status(400).json({ detail: 'unit_code or circ_incharge required' });
      const VISITS_PER_DAY = 3, TOTAL_DAYS = 7;
      const sDate = isDate(start_date) ? start_date : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const dayDates = Array.from({ length: TOTAL_DAYS }, (_, i) => {
        const d = new Date(sDate); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10);
      });
      const { clause: sc, params: sp } = await resolveScope(req);

      let execRows, unitName, incharge = null;
      if (circ_incharge) {
        const { rows: mapRows } = await q(
          `SELECT exec_code, MAX(exec_desc) exec_name, GROUP_CONCAT(DISTINCT unit_code) units,
                  MAX(circ_incharge_name) ci_name
           FROM exec_hierarchy_mapping
           WHERE circ_incharge = ? AND exec_desc IS NOT NULL AND exec_desc != 'N/A'
           GROUP BY exec_code ORDER BY MAX(exec_desc) LIMIT 20`,
          [String(circ_incharge)]
        );
        const { rows: actRows } = await q(`SELECT executive_code FROM exec_master WHERE is_active_pli = 'Y'`);
        const activeSet = new Set(actRows.map(r => r.executive_code));
        let team = mapRows.filter(r => activeSet.has(r.exec_code));
        if (!team.length) team = mapRows;
        execRows = team.map(r => ({ emp_code: null, exec_name: r.exec_name, unit_name: r.units }));
        incharge = { code: String(circ_incharge), name: mapRows[0]?.ci_name || '' };
        unitName = incharge.name ? `Team of ${incharge.name}` : String(circ_incharge);
      } else {
        const { rows } = await q(
          `SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_name) unit_name
           FROM dcr_agency_visit
           WHERE unit_code = ? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)${sc}
           GROUP BY emp_code ORDER BY MAX(executive_name) LIMIT 15`,
          [String(unit_code), ...sp]
        );
        execRows = rows;
        unitName = rows[0]?.unit_name || String(unit_code);
      }
      if (!execRows.length) return res.json({ start_date: sDate, unit_code, unit_name: unitName || '', incharge, execs: [], grand_total: 0 });

      const teams = [];
      for (const ex of execRows) {
        const [agR, visitR, osR] = await Promise.all([
          q(`SELECT agcd, ag_name, COALESCE(city_name, dist_name) city_name
             FROM agency_master
             WHERE executive_name=? AND CAST(dpcd AS UNSIGNED)=1
               AND (supply_stop_flag IS NULL OR supply_stop_flag!='Y') AND suspend_date IS NULL
             LIMIT 150`, [ex.exec_name]),
          q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, MAX(followup_amount) fup_amt, MAX(followup_date) fup_date
             FROM dcr_agency_visit WHERE ${ex.emp_code ? 'emp_code=?' : 'executive_name=?'} AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
             GROUP BY visit_to_main_code`, [ex.emp_code || ex.exec_name]),
          q(`SELECT ao.ag_code, ao.cl_amt FROM agency_outstanding ao
             JOIN agency_master am ON am.agcd=ao.ag_code AND CAST(am.dpcd AS UNSIGNED)=1
             WHERE am.executive_name=? AND ao.period_label='CURRENT' AND ao.cl_amt>0
             GROUP BY ao.ag_code`, [ex.exec_name]),
        ]);
        const vMap = {}, osMap = {};
        for (const r of visitR.rows) vMap[r.ag_code] = r;
        for (const r of osR.rows) osMap[r.ag_code] = +r.cl_amt;
        const seen = new Set();
        const top = agR.rows.filter(r => !seen.has(r.agcd) && seen.add(r.agcd))
          .map(ag => {
            const v = vMap[ag.agcd] || {};
            const os = osMap[ag.agcd] || 0;
            const days = v.last_visit ? Math.floor((Date.now() - new Date(v.last_visit)) / 86400000) : 999;
            return { code: ag.agcd, name: ag.ag_name, city: ag.city_name || '', os, days, fup_amt: +(v.fup_amt || 0), fup_date: v.fup_date || '' };
          })
          .sort((a, b) => b.os - a.os || b.days - a.days).slice(0, VISITS_PER_DAY * TOTAL_DAYS);
        teams.push({ emp_code: ex.emp_code, exec_name: ex.exec_name, agencies: top });
      }

      const allCodes = [...new Set(teams.flatMap(t => t.agencies.map(v => v.code)))];
      const supMap = {};
      if (allCodes.length) {
        const ph = allCodes.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT agcd, AVG(sup_copy) avg_sup FROM supply_data
           WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND agcd IN (${ph})
           GROUP BY agcd`, allCodes);
        supRows.forEach(r => { supMap[r.agcd] = Math.round(+r.avg_sup || 0); });
      }

      const noteFor = v => v.fup_amt > 0
        ? `वादा की गई Payment ₹${v.fup_amt.toLocaleString('en-IN')} due${v.fup_date ? ' ' + String(v.fup_date).slice(0, 10) : ''}`
        : v.days >= 999 ? 'अब तक कोई Visit नहीं'
        : v.days >= 30 ? `${v.days} दिन से Visit नहीं`
        : 'Cash Recovery / Confirmed Date लें';

      let grandTotal = 0;
      for (const t of teams) {
        const days = [];
        for (let d = 0; d < TOTAL_DAYS; d++) {
          const chunk = t.agencies.slice(d * VISITS_PER_DAY, d * VISITS_PER_DAY + VISITS_PER_DAY);
          if (!chunk.length) continue;
          const visits = chunk.map(v => {
            const avg = supMap[v.code] || 0;
            const growth_ask = avg ? Math.min(50, Math.max(5, Math.round(avg * 0.05 / 5) * 5)) : 0;
            const target_amount = v.fup_amt > 0 ? v.fup_amt : (v.os > 0 ? Math.round(v.os * 0.25) : 0);
            grandTotal += target_amount;
            return { ...v, growth_ask, target_amount, note: noteFor(v) };
          });
          days.push({ day: d + 1, date: dayDates[d], total_target: visits.reduce((s, v) => s + v.target_amount, 0), visits });
        }
        t.days = days;
        t.total_target = days.reduce((s, d) => s + d.total_target, 0);
        delete t.agencies;
      }

      res.json({ start_date: sDate, unit_code, unit_name: unitName, incharge, execs: teams, grand_total: grandTotal, model: 'Rule Engine (free)' });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/dcr-analytics/team-live ────────────────────────────────────────
  // Last known GPS punch for every executive in the unit — "where is my team today"
  // Query params: date YYYY-MM-DD (default today), unit_code / state (scope)
  app.get('/api/dcr-analytics/team-live', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const today = new Date().toISOString().slice(0, 10);
      const date  = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today;
      const { clause: sc, params: sp } = await resolveScope(req);

      // Last GPS-tagged visit per executive for the chosen date
      // Also check yesterday (visit_date or mark_attn_date) so we catch late-punched records
      const { rows: visitRows } = await q(
        `SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_code) unit_code, MAX(unit_name) unit_name,
                MAX(visit_date) last_date,
                SUBSTRING_INDEX(GROUP_CONCAT(from_time ORDER BY visit_date DESC, from_time DESC), ',', 1) last_time,
                SUBSTRING_INDEX(GROUP_CONCAT(visit_to_main_code ORDER BY visit_date DESC, from_time DESC), ',', 1) last_agcd,
                SUBSTRING_INDEX(GROUP_CONCAT(visit_purpose ORDER BY visit_date DESC, from_time DESC), ',', 1) last_purpose,
                SUBSTRING_INDEX(GROUP_CONCAT(CAST(latitude AS CHAR) ORDER BY visit_date DESC, from_time DESC), ',', 1) last_lat,
                SUBSTRING_INDEX(GROUP_CONCAT(CAST(longitude AS CHAR) ORDER BY visit_date DESC, from_time DESC), ',', 1) last_lng,
                COUNT(*) visit_count
         FROM dcr_agency_visit
         WHERE visit_date = ?${sc}
           AND latitude IS NOT NULL AND latitude <> ''
           AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
           AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
         GROUP BY emp_code`,
        [date, ...sp]
      );

      // Also get execs with visits but no GPS today (still useful for count)
      const { rows: allExecRows } = await q(
        `SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_code) unit_code, MAX(unit_name) unit_name,
                COUNT(*) visit_count
         FROM dcr_agency_visit WHERE visit_date = ?${sc} GROUP BY emp_code`,
        [date, ...sp]
      );

      // Agency names for last-visited agcds
      const agcds = [...new Set(visitRows.map(r => r.last_agcd).filter(Boolean))];
      const agMap = {};
      if (agcds.length) {
        const ph = agcds.map(() => '?').join(',');
        const { rows: agRows } = await q(`SELECT agcd, ag_name, city_name AS city FROM agency_master WHERE agcd IN (${ph})`, agcds);
        agRows.forEach(r => { agMap[r.agcd] = r; });
      }

      const withGps  = new Set(visitRows.map(r => r.emp_code));
      const noGps    = allExecRows.filter(r => !withGps.has(r.emp_code));

      const execsWithLocation = visitRows.map(r => ({
        emp_code:    r.emp_code,
        exec_name:   r.exec_name,
        unit_code:   r.unit_code,
        unit_name:   r.unit_name || '',
        last_date:   r.last_date,
        last_time:   r.last_time || null,
        last_agcd:   r.last_agcd,
        last_ag_name: agMap[r.last_agcd]?.ag_name || r.last_agcd || '',
        last_city:   agMap[r.last_agcd]?.city || '',
        last_purpose: r.last_purpose || '',
        lat: Number(r.last_lat),
        lng: Number(r.last_lng),
        visit_count: r.visit_count,
      }));

      const execsNoGps = noGps.map(r => ({
        emp_code: r.emp_code, exec_name: r.exec_name, unit_code: r.unit_code, unit_name: r.unit_name,
        visit_count: r.visit_count, lat: null, lng: null,
      }));

      res.json({ date, execs_with_gps: execsWithLocation, execs_no_gps: execsNoGps });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── UNIT LOCATIONS — admin CRUD + Excel import/export ───────────────────────
  // Stores office lat/lng per unit — used as tour-route start/end point.

  // GET /api/admin/unit-locations  — list all units with current coordinates
  app.get('/api/admin/unit-locations', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      // hierarchy_master has no unit_name — resolve names from dcr_agency_visit
      const { rows: allUnits } = await q(
        `SELECT DISTINCT unit_code FROM hierarchy_master
         WHERE unit_code IS NOT NULL AND unit_code != '' ORDER BY unit_code`
      );
      const { rows: nmRows } = await q(
        `SELECT unit_code, MAX(unit_name) unit_name FROM dcr_agency_visit
         WHERE unit_code IS NOT NULL AND unit_code != '' GROUP BY unit_code`
      );
      const nmMap = {};
      nmRows.forEach(r => { nmMap[r.unit_code] = r.unit_name; });
      allUnits.forEach(u => { u.unit_name = nmMap[u.unit_code] || ''; });
      // Get existing coordinates
      const { rows: existing } = await q(`SELECT unit_code, unit_name, lat, lng, address, updated_by, updated_at FROM unit_locations`);
      const locMap = {};
      existing.forEach(r => { locMap[r.unit_code] = r; });

      const units = allUnits.map(u => {
        const loc = locMap[u.unit_code] || {};
        return {
          unit_code: u.unit_code,
          unit_name: u.unit_name || loc.unit_name || '',
          lat: loc.lat ? Number(loc.lat) : null,
          lng: loc.lng ? Number(loc.lng) : null,
          address: loc.address || '',
          updated_by: loc.updated_by || '',
          updated_at: loc.updated_at || null,
          has_location: !!(loc.lat && loc.lng),
        };
      });
      res.json({ units, missing: units.filter(u => !u.has_location).length });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // GET /api/admin/unit-locations/export  — Excel download
  app.get('/api/admin/unit-locations/export', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      // hierarchy_master has no unit_name column — resolve names from dcr_agency_visit
      const { rows: allUnits } = await q(
        `SELECT DISTINCT unit_code FROM hierarchy_master
         WHERE unit_code IS NOT NULL AND unit_code != '' ORDER BY unit_code`
      );
      const { rows: nameRows } = await q(
        `SELECT unit_code, MAX(unit_name) unit_name FROM dcr_agency_visit
         WHERE unit_code IS NOT NULL AND unit_code != '' GROUP BY unit_code`
      );
      const nameMap = {};
      nameRows.forEach(r => { nameMap[r.unit_code] = r.unit_name; });
      const { rows: existing } = await q(`SELECT unit_code, unit_name, lat, lng, address FROM unit_locations`);
      const locMap = {};
      existing.forEach(r => { locMap[r.unit_code] = r; if (!nameMap[r.unit_code] && r.unit_name) nameMap[r.unit_code] = r.unit_name; });
      allUnits.forEach(u => { u.unit_name = nameMap[u.unit_code] || ''; });
      allUnits.sort((a, b) => (a.unit_name || 'zzz').localeCompare(b.unit_name || 'zzz'));

      const rows = allUnits.map(u => {
        const loc = locMap[u.unit_code] || {};
        return {
          'unit_code':  u.unit_code,
          'unit_name':  u.unit_name || '',
          'latitude':   loc.lat ? Number(loc.lat) : '',
          'longitude':  loc.lng ? Number(loc.lng) : '',
          'address':    loc.address || '',
          // instruction column
          'instructions': 'Fill latitude & longitude. Save file, then upload via the app.'
        };
      });

      // Sheet 2: per-executive base locations (for remote-based executives)
      const { rows: execRows } = await q(
        `SELECT emp_code, MAX(executive_name) executive_name,
                MAX(unit_code) unit_code, MAX(unit_name) unit_name
         FROM dcr_agency_visit
         WHERE mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
           AND emp_code IS NOT NULL AND emp_code != ''
         GROUP BY emp_code`
      );
      const { rows: exLoc } = await q(`SELECT emp_code, lat, lng, address FROM exec_locations`);
      const exMap = {};
      exLoc.forEach(r => { exMap[r.emp_code] = r; });
      execRows.sort((a, b) => String(a.unit_name || '').localeCompare(String(b.unit_name || '')) ||
                              String(a.executive_name || '').localeCompare(String(b.executive_name || '')));
      const execSheetRows = execRows.map(e => {
        const l = exMap[e.emp_code] || {};
        return {
          'emp_code':       e.emp_code,
          'executive_name': e.executive_name || '',
          'unit_code':      e.unit_code || '',
          'unit_name':      e.unit_name || '',
          'latitude':       l.lat ? Number(l.lat) : '',
          'longitude':      l.lng ? Number(l.lng) : '',
          'address':        l.address || '',
          'instructions':   'Fill ONLY for executives based at a remote location. Blank = unit office is used as start point.'
        };
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 55 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Unit Locations');
      const wsE = XLSX.utils.json_to_sheet(execSheetRows);
      wsE['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 10 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 62 }];
      XLSX.utils.book_append_sheet(wb, wsE, 'Executive Locations');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="unit_locations.xlsx"',
      });
      res.send(buf);
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // POST /api/admin/unit-locations/upsert  — update a single unit (JSON body)
  app.post('/api/admin/unit-locations/upsert', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { unit_code, unit_name, lat, lng, address } = req.body || {};
      if (!unit_code) return res.status(400).json({ detail: 'unit_code required' });
      const la = parseFloat(lat), lo = parseFloat(lng);
      if (isNaN(la) || isNaN(lo) || la < 8 || la > 38 || lo < 68 || lo > 98)
        return res.status(400).json({ detail: 'Valid India lat (8–38) and lng (68–98) required' });
      await q(
        `INSERT INTO unit_locations (unit_code, unit_name, lat, lng, address, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE unit_name=VALUES(unit_name), lat=VALUES(lat), lng=VALUES(lng),
           address=VALUES(address), updated_by=VALUES(updated_by)`,
        [unit_code, unit_name || unit_code, la, lo, address || '', req.auth?.name || 'admin']
      );
      res.json({ ok: true, unit_code, lat: la, lng: lo });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // POST /api/admin/unit-locations/import  — upload filled Excel (binary body)
  app.post('/api/admin/unit-locations/import',
    require('express').raw({ type: ['application/octet-stream',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel', '*/*'], limit: '10mb' }),
    async (req, res) => {
      try {
        if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
        const wb = XLSX.read(req.body, { type: 'buffer' });
        const validCoord = (la, lo) => !isNaN(la) && !isNaN(lo) && la >= 8 && la <= 38 && lo >= 68 && lo <= 98;

        // Sheet 1: unit office locations
        const ws = wb.Sheets['Unit Locations'] || wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
        let updated = 0, skipped = 0;
        for (const row of data) {
          const uc = String(row.unit_code || '').trim();
          const la = parseFloat(row.latitude  || row.lat || '');
          const lo = parseFloat(row.longitude || row.lng || '');
          if (!uc || !validCoord(la, lo)) { skipped++; continue; }
          await q(
            `INSERT INTO unit_locations (unit_code, unit_name, lat, lng, address, updated_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE unit_name=VALUES(unit_name), lat=VALUES(lat), lng=VALUES(lng),
               address=VALUES(address), updated_by=VALUES(updated_by)`,
            [uc, String(row.unit_name || uc), la, lo, String(row.address || ''), req.auth?.name || 'import']
          );
          updated++;
        }

        // Sheet 2: per-executive base locations (remote-based executives)
        let execUpdated = 0, execSkipped = 0;
        const wsE = wb.Sheets['Executive Locations'];
        if (wsE) {
          const edata = XLSX.utils.sheet_to_json(wsE, { defval: '' });
          for (const row of edata) {
            const ec = String(row.emp_code || '').trim();
            const la = parseFloat(row.latitude  || row.lat || '');
            const lo = parseFloat(row.longitude || row.lng || '');
            if (!ec || !validCoord(la, lo)) { execSkipped++; continue; }
            await q(
              `INSERT INTO exec_locations (emp_code, exec_name, unit_code, lat, lng, address, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE exec_name=VALUES(exec_name), unit_code=VALUES(unit_code),
                 lat=VALUES(lat), lng=VALUES(lng), address=VALUES(address), updated_by=VALUES(updated_by)`,
              [ec, String(row.executive_name || ec), String(row.unit_code || ''), la, lo,
               String(row.address || ''), req.auth?.name || 'import']
            );
            execUpdated++;
          }
        }
        res.json({ ok: true, updated, skipped, exec_updated: execUpdated, exec_skipped: execSkipped });
      } catch (e) { res.status(500).json({ detail: e.message }); }
    }
  );

};
