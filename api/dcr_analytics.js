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

      // Query 1: GPS from Oracle dcr_agency_visit
      const { rows: oracleGps } = await q(
        `SELECT visit_to_main_code AS agcd,
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
        `SELECT target_code AS agcd, lat, lng, visit_date, staff_name AS executive_name,
                remarks AS visit_remarks, purpose AS visit_purpose, id
         FROM dcr_visit
         WHERE target_type = 'agent' AND lat IS NOT NULL AND lng IS NOT NULL
           AND lat BETWEEN 8 AND 38 AND lng BETWEEN 68 AND 98
           ${unitWhere}
         ORDER BY visit_date DESC, id DESC`,
        sp
      );

      // Merge: latest GPS per agcd (Oracle preferred if same date)
      const gpsMap = {};
      [...appGps, ...oracleGps].forEach(r => { // oracle overrides app for same agcd
        if (!gpsMap[r.agcd] || r.visit_date > gpsMap[r.agcd].visit_date)
          gpsMap[r.agcd] = { lat: Number(r.lat), lng: Number(r.lng), last_visit_date: r.visit_date,
            last_exec_name: r.executive_name, last_remarks: r.visit_remarks, last_purpose: r.visit_purpose };
      });

      const agcdList = Object.keys(gpsMap);
      if (!agcdList.length) return res.json({ count: 0, agencies: [] });

      const ph2 = agcdList.map(() => '?').join(',');
      const { rows: agencies } = await q(
        `SELECT am.agcd, am.ag_name, am.unit AS unit_code, am.unit_name,
                am.dist_name AS district, am.city_name AS city,
                am.ag_class_name AS ag_class, am.field_officer_name AS field_officer,
                am.executive_name AS assigned_exec,
                CASE WHEN am.supply_stop_flag = 'Y' OR (am.suspend_date IS NOT NULL AND am.suspend_date <= CURDATE())
                THEN 'Inactive' ELSE 'Active' END AS status
         FROM agency_master am
         WHERE am.agcd IN (${ph2})
         ${amWhere ? 'AND ' + amWhere.replace(/^\s*AND\s*/,'') : ''}
         ORDER BY am.unit, am.ag_name`,
        [...agcdList, ...sp]
      );

      // Attach current supply (latest date per agency) — batch query
      const agcds = agencies.map(a => a.agcd).filter(Boolean);
      let supplyMap = {};
      if (agcds.length) {
        const ph = agcds.map(() => '?').join(',');
        const { rows: supRows } = await q(
          `SELECT sd.agcd, sd.sup_copy, sd.supply_date
           FROM supply_data sd
           JOIN (
             SELECT agcd, MAX(supply_date) mxd FROM supply_data WHERE agcd IN (${ph}) GROUP BY agcd
           ) mx ON mx.agcd = sd.agcd AND mx.mxd = sd.supply_date
           WHERE sd.agcd IN (${ph})`,
          [...agcds, ...agcds]
        );
        supRows.forEach(r => { supplyMap[r.agcd] = { copies: r.sup_copy, date: r.supply_date }; });
      }

      const result = agencies.map(a => ({
        ...a,
        ...(gpsMap[a.agcd] || {}),
        supply: supplyMap[a.agcd]?.copies || null,
        supply_date: supplyMap[a.agcd]?.date || null,
      }));

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

      const chain = []; // GPS-tagged points in order
      if (centerGps) chain.push({ lat: centerGps.lat, lng: centerGps.lng, type: 'center' });

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
      // Return to center
      if (centerGps && chain.length > 1) {
        const last = chain[chain.length - 1];
        totalDist += hav(last.lat, last.lng, centerGps.lat, centerGps.lng);
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
      const unitCode   = oracleVisits[0]?.unit_code || appVisits[0]?.unit_code || hm.unit_code || '';
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
};
