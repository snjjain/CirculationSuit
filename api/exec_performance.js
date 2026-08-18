'use strict';
/**
 * exec_performance.js — Executive Performance dashboard (Circulation)
 *
 * Endpoints (auth-required via global middleware):
 *   GET /api/exec-perf/filters
 *   GET /api/exec-perf/kpis        ?from=&to=&state=&unit_code=
 *   GET /api/exec-perf/ranking     ?from=&to=&state=&unit_code=&metric=supply|collection|collection_pct|outstanding&top_n=10
 *   GET /api/exec-perf/list        ?from=&to=&state=&unit_code=&sort=collection_pct&dir=desc&search=&page=1&per_page=50
 *   GET /api/exec-perf/executive/:exec_code  ?from=&to=
 *   GET /api/exec-perf/agency/:unit_code/:ag_code  ?from=&to=
 *
 * Data sources (all READ-ONLY from MySQL sync tables):
 *   Supply:      supply_data JOIN agency_master  (unit_code=unit, agcd=agcd)
 *   Collection:  agency_collection JOIN agency_master  (unit=unit_code, agcd=ag_code), amount NEGATIVE
 *   Outstanding: agency_outstanding WHERE period_label='CURRENT'
 */

module.exports = function registerExecPerf({ app, q, getScopeUnitCodes }) {
  const N  = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const R1 = v => v == null ? null : Math.round(Number(v) * 10) / 10;
  const p2 = n => String(n).padStart(2, '0');

  // In-memory cache + in-flight dedup for execMetrics
  // Cache: completed results (60s TTL)
  // Inflight: pending Promises — simultaneous requests with same key share one DB round-trip
  const _mCache   = new Map();
  const _mInflight = new Map();
  const CACHE_TTL = 60000; // 60 seconds

  function defaultDates() {
    const now = new Date();
    return {
      from: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-01`,
      to:   `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
    };
  }
  function parseDates(query) {
    const def = defaultDates();
    return {
      from: String(query.from || def.from).slice(0, 10),
      to:   String(query.to   || def.to  ).slice(0, 10),
    };
  }

  // Resolve unit list: null = all, [] = none, [codes...] = scoped
  async function buildUnitList(req) {
    const personCode = req.auth ? (req.auth.personCode || '') : '';
    const hl         = req.auth ? (req.auth.hierarchyLevel || 1) : 1;
    const scoped     = await getScopeUnitCodes(personCode, hl);
    const reqUnit    = String(req.query.unit_code || '').trim();
    const reqState   = String(req.query.state     || '').trim();

    if (reqUnit) {
      if (scoped && !scoped.includes(reqUnit)) return [];
      return [reqUnit];
    }
    if (reqState) {
      const { rows } = await q(
        'SELECT DISTINCT unit FROM agency_master WHERE unit_state_nm = ?', [reqState]
      );
      let units = rows.map(r => r.unit);
      if (scoped) units = units.filter(u => scoped.includes(u));
      return units;
    }
    return scoped;  // null = all, array = scoped
  }

  // Build WHERE fragment + params for a given column name and unit list
  function unitCl(col, list) {
    if (list === null)  return { cl: '', p: [] };
    if (!list.length)   return { cl: ' AND 1=0', p: [] };
    return { cl: ` AND ${col} IN (${list.map(() => '?').join(',')})`, p: list };
  }

  // Core: run all 4 queries in parallel and merge into an exec-keyed map
  async function execMetrics(from, to, unitList) {
    // Cache key: same params → same result (shared by kpis/ranking/list)
    const cacheKey = `${from}|${to}|${unitList === null ? '__all__' : [...unitList].sort().join(',')}`;

    // 1. Completed cache hit
    const hit = _mCache.get(cacheKey);
    if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

    // 2. In-flight dedup: if same key is already being fetched, share that promise
    if (_mInflight.has(cacheKey)) return _mInflight.get(cacheKey);

    // 3. New fetch — wrap in a promise so simultaneous callers all wait on the same one
    const fetchPromise = (async () => {
    const amCl   = unitCl('am.unit',   unitList);  // base query (alias am)
    const subCl  = unitCl('unit',      unitList);  // subquery — no alias, plain column name
    const ouCl   = unitCl('unit_code', unitList);  // agency_outstanding

    const [base, supply, collection, outstanding] = await Promise.all([
      // Base: EXEC executives only.
      // LEFT JOIN exec_master so the dashboard works even before the Oracle sync populates it.
      // When exec_master has data: only include is_active_pli='Y' + exec_designation='EXEC'.
      // When exec_master is empty (pre-sync): include all executives (em.executive_code IS NULL).
      q(`SELECT am.executive_code,
                MAX(am.executive_name) exec_name,
                MAX(am.unit_state_nm)  state_name,
                MIN(am.unit)           main_unit,
                MAX(am.unit_name)      main_unit_name,
                GROUP_CONCAT(DISTINCT am.unit_name ORDER BY am.unit_name SEPARATOR ' / ') units,
                COUNT(DISTINCT am.agcd) agency_count
         FROM agency_master am
         LEFT JOIN exec_master em ON em.executive_code = am.executive_code
         WHERE am.executive_code IS NOT NULL AND am.executive_code != ''${amCl.cl}
           AND (em.executive_code IS NULL OR (em.is_active_pli = 'Y' AND em.exec_designation = 'EXEC'))
         GROUP BY am.executive_code
         ORDER BY exec_name`, amCl.p),

      // Supply — join to DISTINCT (unit,agcd) to avoid DPCD fan-out from agency_master
      // subCl params come FIRST because the subquery placeholder appears before the date placeholders
      q(`SELECT am.executive_code, SUM(sd.sup_copy) total_supply
         FROM supply_data sd
         JOIN (SELECT DISTINCT unit, agcd, executive_code
               FROM agency_master
               WHERE executive_code IS NOT NULL AND executive_code != ''${subCl.cl}
              ) am ON sd.unit_code = am.unit AND sd.agcd = am.agcd
         WHERE sd.supply_date BETWEEN ? AND ?
         GROUP BY am.executive_code`, [...subCl.p, from, to]),

      // Collection — same DISTINCT join to avoid DPCD fan-out
      q(`SELECT am2.executive_code,
                -SUM(CASE WHEN ac.amount < 0 THEN ac.amount ELSE 0 END) total_collection
         FROM agency_collection ac
         JOIN (SELECT DISTINCT unit, agcd, executive_code
               FROM agency_master
               WHERE executive_code IS NOT NULL AND executive_code != ''${subCl.cl}
              ) am2 ON am2.unit = ac.unit_code AND am2.agcd = ac.ag_code
         WHERE ac.is_valid = 1 AND ac.coll_date BETWEEN ? AND ?
         GROUP BY am2.executive_code`, [...subCl.p, from, to]),

      // Outstanding — always CURRENT period snapshot
      q(`SELECT exec_code, SUM(cl_amt) total_outstanding
         FROM agency_outstanding
         WHERE period_label = 'CURRENT'
           AND exec_code IS NOT NULL AND exec_code != ''${ouCl.cl}
         GROUP BY exec_code`, ouCl.p),
    ]);

    // Build lookup maps
    const supMap = {}, colMap = {}, ouMap = {};
    supply.rows.forEach(r      => { supMap[r.executive_code] = N(r.total_supply); });
    collection.rows.forEach(r  => { colMap[r.executive_code] = N(r.total_collection); });
    outstanding.rows.forEach(r => { ouMap[r.exec_code]       = N(r.total_outstanding); });

    const data = base.rows.map(r => {
      const sup  = supMap[r.executive_code] || 0;
      const col  = colMap[r.executive_code] || 0;
      const ou   = ouMap[r.executive_code]  || 0;
      const pct  = (col + ou) > 0 ? R1(col / (col + ou) * 100) : 0;
      return {
        executive_code:    r.executive_code,
        exec_name:         r.exec_name,
        state_name:        r.state_name,
        main_unit:         r.main_unit,
        main_unit_name:    r.main_unit_name,
        units:             r.units,
        agency_count:      N(r.agency_count),
        total_supply:      sup,
        total_collection:  col,
        total_outstanding: ou,
        collection_pct:    pct,
      };
    });

      // Only executives active in Oracle (is_active_pli='Y') are in `data` via the JOIN.
      // Further restrict to those with actual activity in the selected period.
      const activeData = data.filter(r => r.total_supply > 0 || r.total_collection > 0);

      _mCache.set(cacheKey, { data: activeData, ts: Date.now() });
      _mInflight.delete(cacheKey);
      // Prune entries older than 2× TTL to keep map bounded
      if (_mCache.size > 50) {
        const cutoff = Date.now() - CACHE_TTL * 2;
        for (const [k, v] of _mCache) if (v.ts < cutoff) _mCache.delete(k);
      }
      return activeData;
    })();

    // Clean up inflight entry on error so future callers can retry
    fetchPromise.catch(() => _mInflight.delete(cacheKey));
    _mInflight.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  // ══ FILTERS ══
  app.get('/api/exec-perf/filters', async (req, res) => {
    try {
      const personCode = req.auth ? (req.auth.personCode || '') : '';
      const hl         = req.auth ? (req.auth.hierarchyLevel || 1) : 1;
      const scoped     = await getScopeUnitCodes(personCode, hl);
      const sc         = unitCl('unit', scoped);

      const [states, units, dates] = await Promise.all([
        q(`SELECT DISTINCT unit_state_nm state FROM agency_master
           WHERE unit_state_nm IS NOT NULL AND unit_state_nm != ''${sc.cl}
           ORDER BY unit_state_nm`, sc.p),
        q(`SELECT DISTINCT unit unit_code, MAX(unit_name) unit_name, MAX(unit_state_nm) state_nm FROM agency_master
           WHERE 1=1${sc.cl} GROUP BY unit ORDER BY unit_name`, sc.p),
        q('SELECT MIN(supply_date) min_date, MAX(supply_date) max_date FROM supply_data'),
      ]);

      res.json({
        states:   states.rows.map(r => r.state),
        units:    units.rows,
        min_date: dates.rows[0]?.min_date || null,
        max_date: dates.rows[0]?.max_date || null,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ KPIs ══
  app.get('/api/exec-perf/kpis', async (req, res) => {
    try {
      const { from, to } = parseDates(req.query);
      const unitList = await buildUnitList(req);
      const all = await execMetrics(from, to, unitList);

      // Aggregate
      const execCount   = new Set(all.map(r => r.executive_code)).size;
      const agencyCount = all.reduce((s, r) => s + r.agency_count, 0);
      const totalSup    = all.reduce((s, r) => s + r.total_supply, 0);
      const totalCol    = all.reduce((s, r) => s + r.total_collection, 0);
      const totalOu     = all.reduce((s, r) => s + r.total_outstanding, 0);

      res.json({
        from, to,
        exec_count:        execCount,
        agency_count:      agencyCount,
        total_supply:      totalSup,
        total_collection:  totalCol,
        total_outstanding: totalOu,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ RANKING ══
  app.get('/api/exec-perf/ranking', async (req, res) => {
    const t0 = Date.now();
    try {
      const { from, to } = parseDates(req.query);
      const unitList  = await buildUnitList(req);
      const metric    = String(req.query.metric || 'collection_pct');
      const topN      = Math.min(25, Math.max(1, parseInt(req.query.top_n || '10', 10)));
      const minSupply = parseInt(req.query.min_supply || '0', 10);

      const all = await execMetrics(from, to, unitList);
      console.log(`[ranking] execMetrics: ${all.length} rows in ${Date.now()-t0}ms`);

      // Sort metric value
      const metricVal = r => ({
        supply:         r.total_supply,
        collection:     r.total_collection,
        collection_pct: r.collection_pct,
        outstanding:    r.total_outstanding,
      }[metric] ?? r.collection_pct);

      const filtered = minSupply > 0 ? all.filter(r => r.total_supply >= minSupply) : all;
      const sorted   = [...filtered].sort((a, b) => metricVal(b) - metricVal(a));

      // Top = highest value; bottom = lowest value (needs attention)
      const top    = sorted.slice(0, topN);
      const bottom = [...sorted].reverse().slice(0, topN);

      res.json({ metric, top_n: topN, min_supply: minSupply, top, bottom, total: filtered.length });
    } catch (e) {
      console.error(`[ranking] ERROR after ${Date.now()-t0}ms:`, e);
      res.status(500).json({ detail: String(e) });
    }
  });

  // ══ LIST ══
  app.get('/api/exec-perf/list', async (req, res) => {
    try {
      const { from, to } = parseDates(req.query);
      const unitList = await buildUnitList(req);
      const sort    = String(req.query.sort || 'collection_pct');
      const dir     = String(req.query.dir  || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
      const search  = String(req.query.search || '').trim().toLowerCase();
      const page    = Math.max(1, parseInt(req.query.page     || '1',  10));
      const perPage = Math.min(200, Math.max(10, parseInt(req.query.per_page || '50', 10)));

      let all = await execMetrics(from, to, unitList);

      // Apply search
      if (search) {
        all = all.filter(r =>
          (r.exec_name || '').toLowerCase().includes(search) ||
          (r.main_unit_name || '').toLowerCase().includes(search)
        );
      }

      // Sort
      const sortKey = {
        exec_name: 'exec_name', agencies: 'agency_count', supply: 'total_supply',
        collection: 'total_collection', outstanding: 'total_outstanding', collection_pct: 'collection_pct',
      }[sort] || 'collection_pct';

      all.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        return dir === 'asc' ? av - bv : bv - av;
      });

      const total   = all.length;
      const offset  = (page - 1) * perPage;
      const rows    = all.slice(offset, offset + perPage).map((r, i) => ({ ...r, rank: offset + i + 1 }));

      res.json({
        from, to, sort, dir, page, per_page: perPage,
        total, total_pages: Math.ceil(total / perPage) || 1,
        rows,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ EXECUTIVE DETAIL ══
  app.get('/api/exec-perf/executive/:exec_code', async (req, res) => {
    try {
      const execCode     = String(req.params.exec_code);
      const { from, to } = parseDates(req.query);

      const [execInfo, supR, colR, ouR, agencies, hierR] = await Promise.all([
        q(`SELECT executive_code, MAX(executive_name) exec_name, MAX(unit_state_nm) state_name,
                  GROUP_CONCAT(DISTINCT unit_name ORDER BY unit_name SEPARATOR ' / ') units,
                  COUNT(DISTINCT agcd) agency_count
           FROM agency_master WHERE executive_code = ?
           GROUP BY executive_code`, [execCode]),

        // Use DISTINCT join to avoid DPCD fan-out (agency_master has 1 row per delivery point)
        q(`SELECT SUM(sd.sup_copy) total
           FROM supply_data sd
           JOIN (SELECT DISTINCT unit, agcd FROM agency_master WHERE executive_code = ?) am
             ON sd.unit_code = am.unit AND sd.agcd = am.agcd
           WHERE sd.supply_date BETWEEN ? AND ?`, [execCode, from, to]),

        q(`SELECT -SUM(CASE WHEN ac.amount < 0 THEN ac.amount ELSE 0 END) total
           FROM agency_collection ac
           JOIN (SELECT DISTINCT unit, agcd FROM agency_master WHERE executive_code = ?) am
             ON am.unit = ac.unit_code AND am.agcd = ac.ag_code
           WHERE ac.is_valid = 1 AND ac.coll_date BETWEEN ? AND ?`,
          [execCode, from, to]),

        q(`SELECT SUM(ao.cl_amt) total FROM agency_outstanding ao
           WHERE ao.exec_code = ? AND ao.period_label = 'CURRENT'`, [execCode]),

        // Agency list: one row per AGCD (GROUP BY unit+agcd) — DPCDs are aggregated, not expanded
        q(`SELECT am.agcd ag_code, am.unit unit_code,
                  MAX(am.unit_name) unit_name, MAX(am.ag_name) ag_name,
                  MAX(am.ag_type_name) ag_type_name, MAX(am.ag_class_name) ag_class_name,
                  MAX(am.city_name) city_name, MAX(am.dist_name) dist_name,
                  MAX(am.supply_stop_flag) supply_stop_flag, MAX(am.suspend_date) suspend_date,
                  MAX(am.mobile_no1) mobile_no1,
                  MAX(COALESCE(s.total_supply, 0)) total_supply,
                  MAX(COALESCE(c.total_collection, 0)) total_collection,
                  MAX(COALESCE(o.total_outstanding, 0)) total_outstanding,
                  CASE WHEN (MAX(COALESCE(c.total_collection, 0)) + MAX(COALESCE(o.total_outstanding, 0))) > 0
                       THEN ROUND(MAX(COALESCE(c.total_collection,0)) /
                            (MAX(COALESCE(c.total_collection,0)) + MAX(COALESCE(o.total_outstanding,0))) * 100, 1)
                       ELSE 0 END collection_pct
           FROM agency_master am
           LEFT JOIN (
             SELECT unit_code, agcd, SUM(sup_copy) total_supply
             FROM supply_data WHERE supply_date BETWEEN ? AND ?
             GROUP BY unit_code, agcd
           ) s ON s.unit_code = am.unit AND s.agcd = am.agcd
           LEFT JOIN (
             SELECT unit_code, ag_code,
                    -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) total_collection
             FROM agency_collection WHERE is_valid = 1 AND coll_date BETWEEN ? AND ?
             GROUP BY unit_code, ag_code
           ) c ON c.unit_code = am.unit AND c.ag_code = am.agcd
           LEFT JOIN (
             SELECT unit_code, ag_code, SUM(cl_amt) total_outstanding
             FROM agency_outstanding WHERE period_label = 'CURRENT'
             GROUP BY unit_code, ag_code
           ) o ON o.unit_code = am.unit AND o.ag_code = am.agcd
           WHERE am.executive_code = ?
           GROUP BY am.unit, am.agcd
           ORDER BY total_supply DESC`, [from, to, from, to, execCode]),

        // Reporting chain from Oracle hierarchy
        q(`SELECT exec_desc, exec_desig,
                  edtn_incharge, edtn_incharge_name,
                  circ_incharge, circ_incharge_name,
                  zonal_head,    zonal_head_name,
                  vp_circulation, vp_circulation_name
           FROM exec_hierarchy_mapping WHERE exec_code = ? LIMIT 1`, [execCode]),
      ]);

      const ei         = execInfo.rows[0] || {};
      const totalColl  = N(colR.rows[0]?.total);
      const totalOu    = N(ouR.rows[0]?.total);
      const collPct    = (totalColl + totalOu) > 0 ? R1(totalColl / (totalColl + totalOu) * 100) : 0;
      const hier       = hierR.rows[0] || {};

      res.json({
        from, to,
        exec: {
          executive_code:       execCode,
          exec_name:            ei.exec_name || execCode,
          exec_designation:     hier.exec_desig || null,
          state_name:           ei.state_name,
          units:                ei.units,
          agency_count:         N(ei.agency_count),
          total_supply:         N(supR.rows[0]?.total),
          total_collection:     totalColl,
          total_outstanding:    totalOu,
          collection_pct:       collPct,
          edtn_incharge:        hier.edtn_incharge        || null,
          edtn_incharge_name:   hier.edtn_incharge_name   || null,
          circ_incharge:        hier.circ_incharge        || null,
          circ_incharge_name:   hier.circ_incharge_name   || null,
          zonal_head:           hier.zonal_head           || null,
          zonal_head_name:      hier.zonal_head_name      || null,
          vp_circulation:       hier.vp_circulation       || null,
          vp_circulation_name:  hier.vp_circulation_name  || null,
        },
        agencies: agencies.rows.map((r, i) => ({
          rank:              i + 1,
          ag_code:           r.ag_code,
          unit_code:         r.unit_code,
          unit_name:         r.unit_name,
          ag_name:           r.ag_name,
          ag_type_name:      r.ag_type_name,
          ag_class_name:     r.ag_class_name,
          city_name:         r.city_name,
          dist_name:         r.dist_name,
          supply_stop_flag:  r.supply_stop_flag,
          suspend_date:      r.suspend_date,
          mobile_no1:        r.mobile_no1,
          total_supply:      N(r.total_supply),
          total_collection:  N(r.total_collection),
          total_outstanding: N(r.total_outstanding),
          collection_pct:    R1(r.collection_pct),
          status: r.suspend_date ? 'Suspended' : (r.supply_stop_flag === 'Y' ? 'Stopped' : 'Active'),
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ AGENCY DETAIL ══
  app.get('/api/exec-perf/agency/:unit_code/:ag_code', async (req, res) => {
    try {
      const { unit_code, ag_code } = req.params;
      const { from, to }           = parseDates(req.query);

      const [agInfo, supR, colR, ouR, supHist, colHist] = await Promise.all([
        q(`SELECT ag_name, ag_type_name, ag_class_name, city_name, dist_name,
                  unit_name, mobile_no1, supply_stop_flag, suspend_date,
                  executive_code, executive_name, supply_start_dt, agent_name
           FROM agency_master WHERE unit = ? AND agcd = ? LIMIT 1`, [unit_code, ag_code]),

        q(`SELECT SUM(sup_copy) total, COUNT(DISTINCT supply_date) supply_days
           FROM supply_data
           WHERE unit_code = ? AND agcd = ? AND supply_date BETWEEN ? AND ?`,
          [unit_code, ag_code, from, to]),

        q(`SELECT -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) total,
                  MAX(coll_date) last_date, COUNT(*) txn_count
           FROM agency_collection
           WHERE unit_code = ? AND ag_code = ? AND is_valid = 1
             AND coll_date BETWEEN ? AND ?`, [unit_code, ag_code, from, to]),

        q(`SELECT cl_amt, bill_amt, rec_amt, op_amt, ag_status, exec_name
           FROM agency_outstanding
           WHERE unit_code = ? AND ag_code = ? AND period_label = 'CURRENT' LIMIT 1`,
          [unit_code, ag_code]),

        // Monthly supply history (last 6 months)
        q(`SELECT DATE_FORMAT(supply_date, '%Y-%m') month,
                  SUM(sup_copy) total_supply,
                  COUNT(DISTINCT supply_date) supply_days
           FROM supply_data
           WHERE unit_code = ? AND agcd = ?
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 6`, [unit_code, ag_code]),

        // Monthly collection history (last 6 months)
        q(`SELECT DATE_FORMAT(coll_date, '%Y-%m') month,
                  -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) total_collection,
                  COUNT(*) txn_count
           FROM agency_collection
           WHERE unit_code = ? AND ag_code = ? AND is_valid = 1
             AND coll_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 6`, [unit_code, ag_code]),
      ]);

      const ai       = agInfo.rows[0] || {};
      const ou       = ouR.rows[0]   || {};
      const totalCol = N(colR.rows[0]?.total);
      const totalOu  = N(ou.cl_amt);
      const collPct  = (totalCol + totalOu) > 0 ? R1(totalCol / (totalCol + totalOu) * 100) : 0;
      const supDays  = N(supR.rows[0]?.supply_days);

      res.json({
        from, to,
        agency: {
          unit_code, ag_code,
          ag_name:           ai.ag_name,
          ag_type_name:      ai.ag_type_name,
          ag_class_name:     ai.ag_class_name,
          city_name:         ai.city_name,
          dist_name:         ai.dist_name,
          unit_name:         ai.unit_name,
          mobile_no1:        ai.mobile_no1,
          supply_stop_flag:  ai.supply_stop_flag,
          suspend_date:      ai.suspend_date,
          executive_code:    ai.executive_code,
          executive_name:    ai.executive_name,
          supply_start_dt:   ai.supply_start_dt,
          agent_name:        ai.agent_name,
          status: ai.suspend_date ? 'Suspended' : (ai.supply_stop_flag === 'Y' ? 'Stopped' : 'Active'),
        },
        metrics: {
          total_supply:      N(supR.rows[0]?.total),
          supply_days:       supDays,
          avg_daily_supply:  supDays > 0 ? R1(N(supR.rows[0]?.total) / supDays) : 0,
          total_collection:  totalCol,
          last_coll_date:    colR.rows[0]?.last_date || null,
          txn_count:         N(colR.rows[0]?.txn_count),
          total_outstanding: totalOu,
          bill_amt:          N(ou.bill_amt),
          rec_amt:           N(ou.rec_amt),
          ag_status:         ou.ag_status,
          collection_pct:    collPct,
        },
        supply_history:     supHist.rows,
        collection_history: colHist.rows,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ SUPPLY GROWTH (current period vs equivalent previous period) ══════════════
  app.get('/api/exec-perf/growth', async (req, res) => {
    try {
      const { from, to } = parseDates(req.query);
      const unitList = await buildUnitList(req);

      // Previous period = same number of days, immediately before
      const fromD = new Date(from + 'T00:00:00');
      const toD   = new Date(to   + 'T00:00:00');
      const diffMs   = toD - fromD;
      const prevToD  = new Date(fromD.getTime() - 86400000); // day before from
      const prevFromD= new Date(prevToD.getTime() - diffMs);
      const prevFrom = prevFromD.toISOString().slice(0, 10);
      const prevTo   = prevToD.toISOString().slice(0, 10);

      const amCl  = unitCl('am.unit', unitList);
      const subCl = unitCl('unit',    unitList);

      const [currR, prevR] = await Promise.all([
        q(`SELECT am.executive_code,
                  SUM(CASE WHEN sd.sup_type_code='A' THEN sd.sup_copy ELSE 0 END) agent_sale,
                  SUM(CASE WHEN sd.sup_type_code='C' THEN sd.sup_copy ELSE 0 END) cash_sale,
                  SUM(sd.sup_copy) total_supply
           FROM supply_data sd
           JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                 WHERE executive_code IS NOT NULL AND executive_code != ''${subCl.cl}) am
             ON sd.unit_code=am.unit AND sd.agcd=am.agcd
           WHERE sd.supply_date BETWEEN ? AND ?
           GROUP BY am.executive_code`, [...subCl.p, from, to]),

        q(`SELECT am.executive_code, SUM(sd.sup_copy) total_supply
           FROM supply_data sd
           JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                 WHERE executive_code IS NOT NULL AND executive_code != ''${subCl.cl}) am
             ON sd.unit_code=am.unit AND sd.agcd=am.agcd
           WHERE sd.supply_date BETWEEN ? AND ?
           GROUP BY am.executive_code`, [...subCl.p, prevFrom, prevTo]),
      ]);

      const prevMap = {};
      for (const r of prevR.rows) prevMap[r.executive_code] = N(r.total_supply);

      let totalCurr = 0, totalPrev = 0, agentCurr = 0, cashCurr = 0;
      const byExec = currR.rows.map(r => {
        const curr = N(r.total_supply), prev = prevMap[r.executive_code] || 0;
        const diff = curr - prev;
        const pct  = prev > 0 ? R1(diff / prev * 100) : null;
        totalCurr += curr; totalPrev += prevMap[r.executive_code] || 0;
        agentCurr += N(r.agent_sale); cashCurr += N(r.cash_sale);
        return { executive_code: r.executive_code, curr, prev, diff, pct };
      });

      const totalDiff = totalCurr - totalPrev;
      const totalPct  = totalPrev > 0 ? R1(totalDiff / totalPrev * 100) : null;

      res.json({
        from, to, prev_from: prevFrom, prev_to: prevTo,
        total_curr: totalCurr, total_prev: totalPrev,
        total_diff: totalDiff, total_pct: totalPct,
        agent_curr: agentCurr, cash_curr: cashCurr,
        by_exec: byExec,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ DCR SUMMARY (visits + attendance per exec) ════════════════════════════════
  app.get('/api/exec-perf/dcr', async (req, res) => {
    try {
      const { from, to } = parseDates(req.query);
      const unitList = await buildUnitList(req);
      const ucd = unitCl('unit_code', unitList);
      const today = new Date().toISOString().slice(0, 10);

      const [visitsR, attendR, todayVisitR] = await Promise.all([
        q(`SELECT emp_code, COUNT(*) visits, COUNT(DISTINCT mark_attn_date) active_days,
                  COUNT(DISTINCT visit_to_main_code) agencies_visited
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ?
             AND emp_code IS NOT NULL AND emp_code != ''${ucd.cl}
           GROUP BY emp_code`, [from, to, ...ucd.p]),

        q(`SELECT emp_code, COUNT(DISTINCT attn_date) attn_days,
                  MIN(TIME(created_dt)) first_time, MAX(TIME(created_dt)) last_time
           FROM dcr_center_attendance
           WHERE attn_date BETWEEN ? AND ?
             AND emp_code IS NOT NULL AND emp_code != ''${ucd.cl}
           GROUP BY emp_code`, [from, to, ...ucd.p]),

        // Who has ANY DCR record today
        q(`SELECT DISTINCT emp_code FROM dcr_agency_visit
           WHERE mark_attn_date = ? AND emp_code IS NOT NULL${ucd.cl}
           UNION
           SELECT DISTINCT emp_code FROM dcr_center_attendance
           WHERE attn_date = ? AND emp_code IS NOT NULL${ucd.cl}`,
          [today, ...ucd.p, today, ...ucd.p]),
      ]);

      const attendMap = {};
      for (const r of attendR.rows) attendMap[r.emp_code] = r;

      const activeToday = new Set(todayVisitR.rows.map(r => r.emp_code));

      const byExec = visitsR.rows.map(r => {
        const att = attendMap[r.emp_code] || {};
        return {
          emp_code:         r.emp_code,
          visits:           N(r.visits),
          active_days:      N(r.active_days),
          agencies_visited: N(r.agencies_visited),
          attn_days:        N(att.attn_days),
          active_today:     activeToday.has(r.emp_code),
        };
      });

      // Aggregate
      const totalVisits    = byExec.reduce((s, r) => s + r.visits, 0);
      const totalActiveExec= byExec.filter(r => r.visits > 0).length;

      res.json({
        from, to, today,
        total_visits:     totalVisits,
        execs_active:     totalActiveExec,
        execs_active_today: activeToday.size,
        by_exec: byExec,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ LAST VISIT ANALYSIS ══════════════════════════════════════════════════════
  // Queries agency_master and dcr_agency_visit SEPARATELY then merges in JS
  // (avoids utf8mb4_unicode_ci vs utf8mb4_0900_ai_ci cross-table JOIN error)
  async function buildLastVisitData(unitList) {
    const amCl  = unitCl('unit',      unitList);  // agency_master: plain 'unit' column
    const ucdCl = unitCl('unit_code', unitList);  // dcr tables: 'unit_code' column

    const [agenciesR, visitsR] = await Promise.all([
      q(`SELECT DISTINCT agcd, unit, ag_name, unit_name, dist_name, city_name, executive_code, executive_name
         FROM agency_master
         WHERE executive_code IS NOT NULL AND executive_code != ''${amCl.cl}
           AND (supply_stop_flag IS NULL OR supply_stop_flag != 'Y')
           AND suspend_date IS NULL`, amCl.p),

      // Last visit per (unit_code, visit_to_main_code) from dcr_agency_visit only
      q(`SELECT unit_code, visit_to_main_code, MAX(mark_attn_date) last_visit
         FROM dcr_agency_visit
         WHERE visit_to_main_code IS NOT NULL AND visit_to_main_code != ''${ucdCl.cl}
         GROUP BY unit_code, visit_to_main_code`, ucdCl.p),
    ]);

    // Build visit map: key = unit_code + '|' + agcd
    const visitMap = new Map();
    for (const r of visitsR.rows) {
      visitMap.set(`${r.unit_code}|${r.visit_to_main_code}`, r.last_visit);
    }

    return { agencies: agenciesR.rows, visitMap };
  }

  app.get('/api/exec-perf/last-visit', async (req, res) => {
    try {
      const unitList = await buildUnitList(req);
      const today    = new Date().toISOString().slice(0, 10);
      const now      = new Date(today);
      const daysDiff = d => d ? Math.floor((now - new Date(d)) / 86400000) : null;

      const { agencies, visitMap } = await buildLastVisitData(unitList);

      const buckets = { today: 0, d1_3: 0, d4_7: 0, d8_15: 0, d15plus: 0, never: 0 };
      for (const r of agencies) {
        const lv = visitMap.get(`${r.unit}|${r.agcd}`) || null;
        const d  = daysDiff(lv);
        if (d === null) buckets.never++;
        else if (d === 0) buckets.today++;
        else if (d <= 3)  buckets.d1_3++;
        else if (d <= 7)  buckets.d4_7++;
        else if (d <= 15) buckets.d8_15++;
        else              buckets.d15plus++;
      }

      res.json({ today, total: agencies.length, buckets });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // GET /api/exec-perf/last-visit/agencies?bucket=today|d1_3|d4_7|d8_15|d15plus|never
  app.get('/api/exec-perf/last-visit/agencies', async (req, res) => {
    try {
      const bucket   = String(req.query.bucket || 'never');
      const unitList = await buildUnitList(req);
      const today    = new Date().toISOString().slice(0, 10);
      const now      = new Date(today);
      const daysDiff = d => d ? Math.floor((now - new Date(d)) / 86400000) : null;

      const { agencies, visitMap } = await buildLastVisitData(unitList);

      const inBucket = d => {
        if (bucket === 'never')   return d === null;
        if (bucket === 'today')   return d === 0;
        if (bucket === 'd1_3')    return d >= 1  && d <= 3;
        if (bucket === 'd4_7')    return d >= 4  && d <= 7;
        if (bucket === 'd8_15')   return d >= 8  && d <= 15;
        if (bucket === 'd15plus') return d > 15;
        return false;
      };

      const filtered = agencies
        .map(r => ({ ...r, last_visit: visitMap.get(`${r.unit}|${r.agcd}`) || null, days_since: daysDiff(visitMap.get(`${r.unit}|${r.agcd}`) || null) }))
        .filter(r => inBucket(r.days_since))
        .sort((a, b) => (b.days_since || 9999) - (a.days_since || 9999))
        .slice(0, 200);

      res.json({ bucket, count: filtered.length, agencies: filtered });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ SMART ALERTS ══════════════════════════════════════════════════════════════
  app.get('/api/exec-perf/alerts', async (req, res) => {
    try {
      const { from, to } = parseDates(req.query);
      const unitList = await buildUnitList(req);
      const amCl     = unitCl('am.unit',      unitList);
      const subCl    = unitCl('unit',          unitList);
      const ucd      = unitCl('unit_code',     unitList);
      const today    = new Date().toISOString().slice(0, 10);

      const cutoff15 = new Date();
      cutoff15.setDate(cutoff15.getDate() - 15);
      const dt15 = cutoff15.toISOString().slice(0, 10);

      const [
        allExecsR, activeTodayR,
        osHighR, supplyFallR,
      ] = await Promise.all([
        // All active executives in scope
        q(`SELECT DISTINCT am.executive_code, MAX(am.executive_name) exec_name, MIN(am.unit) unit_code
           FROM agency_master am
           LEFT JOIN exec_master em ON em.executive_code=am.executive_code
           WHERE am.executive_code IS NOT NULL AND am.executive_code != ''${amCl.cl}
             AND (em.executive_code IS NULL OR (em.is_active_pli='Y' AND em.exec_designation='EXEC'))
           GROUP BY am.executive_code`, amCl.p),

        // Execs active today (any DCR record)
        q(`SELECT DISTINCT emp_code FROM dcr_agency_visit
           WHERE mark_attn_date=? AND emp_code IS NOT NULL${ucd.cl}
           UNION SELECT DISTINCT emp_code FROM dcr_center_attendance
           WHERE attn_date=? AND emp_code IS NOT NULL${ucd.cl}`,
          [today, ...ucd.p, today, ...ucd.p]),

        // Agencies with outstanding > 0 (at risk)
        q(`SELECT COUNT(DISTINCT ao.ag_code) n
           FROM agency_outstanding ao
           JOIN agency_master am ON am.agcd=ao.ag_code AND am.unit=ao.unit_code
           WHERE ao.period_label='CURRENT' AND ao.cl_amt > 0${amCl.cl}`, amCl.p),

        // Execs with supply decline vs prev period
        q(`SELECT COUNT(*) n FROM (
             SELECT am.executive_code,
                    SUM(CASE WHEN sd.supply_date BETWEEN ? AND ? THEN sd.sup_copy ELSE 0 END) curr,
                    SUM(CASE WHEN sd.supply_date < ? THEN sd.sup_copy ELSE 0 END) prev
             FROM supply_data sd
             JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                   WHERE executive_code IS NOT NULL${subCl.cl}) am
               ON sd.unit_code=am.unit AND sd.agcd=am.agcd
             WHERE sd.supply_date >= DATE_SUB(?, INTERVAL 60 DAY)
             GROUP BY am.executive_code
             HAVING prev > 0 AND curr < prev
           ) t`, [from, to, from, from, ...subCl.p]),
      ]);

      // Visit data — queried separately to avoid cross-collation JOIN between agency_master and dcr_agency_visit
      const { agencies, visitMap } = await buildLastVisitData(unitList);
      let noVisit15Count = 0;
      let neverVisitedCount = 0;
      for (const ag of agencies) {
        const lastVisit = visitMap.get(`${ag.unit}|${ag.agcd}`);
        if (!lastVisit) {
          neverVisitedCount++;
        } else if (lastVisit <= dt15) {
          noVisit15Count++;
        }
      }

      const activeToday  = new Set(activeTodayR.rows.map(r => r.emp_code));
      const totalExecs   = allExecsR.rows.length;
      const inactiveToday= allExecsR.rows.filter(r => !activeToday.has(r.executive_code));

      const alerts = [];

      if (inactiveToday.length > 0) alerts.push({
        key:     'no_visit_today',
        type:    'danger',
        icon:    '🔴',
        message: `${inactiveToday.length} executive${inactiveToday.length > 1 ? 's' : ''} have no DCR activity today`,
        count:   inactiveToday.length,
        detail:  inactiveToday.map(r => ({ exec_code: r.executive_code, exec_name: r.exec_name, unit_code: r.unit_code })),
      });

      if (noVisit15Count > 0) alerts.push({
        key: 'visit_pending_15d', type: 'warning', icon: '🟠',
        message: `${noVisit15Count} agencies not visited in the last 15 days`,
        count: noVisit15Count, detail: [],
      });

      if (neverVisitedCount > 0) alerts.push({
        key: 'never_visited', type: 'danger', icon: '🔴',
        message: `${neverVisitedCount} agencies have NEVER been visited`,
        count: neverVisitedCount, detail: [],
      });

      const osHigh = N(osHighR.rows[0]?.n);
      if (osHigh > 0) alerts.push({
        key: 'os_outstanding', type: 'warning', icon: '🟠',
        message: `${osHigh} agencies have outstanding balance`,
        count: osHigh, detail: [],
      });

      const supplyFall = N(supplyFallR.rows[0]?.n);
      if (supplyFall > 0) alerts.push({
        key: 'supply_declining', type: 'warning', icon: '🟡',
        message: `${supplyFall} executives have declining supply vs previous period`,
        count: supplyFall, detail: [],
      });

      res.json({ total_execs: totalExecs, active_today: activeToday.size, today, alerts });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══ EMAIL TO REPORTING CHAIN ══════════════════════════════════════════════════
  app.post('/api/exec-perf/email', async (req, res) => {
    try {
      const { exec_code, to_roles = ['circ_incharge'], subject, message } = req.body || {};
      if (!exec_code || !subject || !message)
        return res.status(400).json({ detail: 'exec_code, subject and message required' });

      // Get hierarchy
      const { rows: hier } = await q(
        `SELECT edtn_incharge, edtn_incharge_name, circ_incharge, circ_incharge_name,
                zonal_head, zonal_head_name, vp_circulation, vp_circulation_name
         FROM exec_hierarchy_mapping WHERE exec_code=? LIMIT 1`, [exec_code]);

      const h = hier[0] || {};
      const roleMap = {
        edtn_incharge:  { code: h.edtn_incharge,   name: h.edtn_incharge_name   },
        circ_incharge:  { code: h.circ_incharge,   name: h.circ_incharge_name   },
        zonal_head:     { code: h.zonal_head,       name: h.zonal_head_name      },
        vp_circulation: { code: h.vp_circulation,  name: h.vp_circulation_name  },
      };

      const recipientCodes = to_roles
        .map(r => roleMap[r]?.code)
        .filter(Boolean);

      if (!recipientCodes.length)
        return res.status(400).json({ detail: 'No hierarchy members found for selected roles' });

      // Look up emails in app_users
      const ph = recipientCodes.map(() => '?').join(',');
      const { rows: emailRows } = await q(
        `SELECT person_code, name, email FROM app_users
         WHERE person_code IN (${ph}) AND email IS NOT NULL AND email != '' AND is_active=1`,
        recipientCodes);

      const emails = emailRows.map(r => r.email).filter(Boolean);
      if (!emails.length)
        return res.status(404).json({
          detail: 'No email addresses found for selected hierarchy members. Please configure email in user management.',
          recipients_checked: recipientCodes,
        });

      const SMTP_HOST = process.env.SMTP_HOST, SMTP_USER = process.env.SMTP_USER;
      if (!SMTP_HOST || !SMTP_USER)
        return res.status(503).json({ detail: 'SMTP not configured in .env' });

      const nodemailer = require('nodemailer');
      const port       = parseInt(process.env.SMTP_PORT || '587', 10);
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST, port, secure: port === 465,
        auth: { user: SMTP_USER, pass: process.env.SMTP_PASSWORD },
      });
      const from = `"${process.env.SMTP_FROM_NAME || 'Patrika Vitran'}" <${process.env.SMTP_FROM_EMAIL || SMTP_USER}>`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;white-space:pre-wrap">${
        String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;

      await transporter.sendMail({ from, to: emails.join(','), subject, text: message, html });

      res.json({ ok: true, sent_to: emails, recipients: emailRows.map(r => ({ code: r.person_code, name: r.name, email: r.email })) });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
