'use strict';

/**
 * Patrika Vitran — Supply Management Dashboard (Agency/Credit sale)
 *
 * Management decision dashboard for HO / Zonal Head / Circulation Incharge / Executives.
 * All figures are date-relative to the latest loaded supply day ("current day"),
 * so the dashboard works correctly while the 5-year historical sync completes.
 *
 * Hawker/Cash-sale, DCR-visit and approval data plug in later (queries pending).
 *
 * Endpoints (all scoped via x-person-code / x-hierarchy-level):
 *   GET /api/supply-dash/filters
 *   GET /api/supply-dash/kpis        ?unit_code=
 *   GET /api/supply-dash/branches    ?unit_code=
 *   GET /api/supply-dash/agents      ?unit_code=&order=growth|decline|supply&search=&limit=
 *   GET /api/supply-dash/executives  ?unit_code=
 *   GET /api/supply-dash/trend       ?granularity=daily|monthly|yearly&days=30&unit_code=
 *   GET /api/supply-dash/exceptions  ?unit_code=
 *   GET /api/supply-dash/insights    ?unit_code=
 *
 * Registered by server.js: require('./supply_dashboard')({ app, q, getScopeUnitCodes })
 */

module.exports = function registerSupplyDash(ctx) {
  const { app, q, getScopeUnitCodes } = ctx;

  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const pct = (cur, prev) => (prev ? (cur - prev) / Math.abs(prev) * 100 : null);
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;

  // ── Scope: unit filter from role headers + optional explicit unit_code ──────
  async function scopeUnits(req, opts = {}) {
    const personCode = req.headers['x-person-code'] || '';
    const hl = parseInt(req.headers['x-hierarchy-level'] || '1', 10);
    const allowed = await getScopeUnitCodes(personCode, hl); // null = all
    const want  = (req.query.unit_code  || '').trim();
    // Sale views resolve the state filter by branch HOME state (post-aggregation), so they ask
    // scopeUnits to ignore the supply-row state_name resolution to avoid cross-state unit leakage.
    const state = opts.ignoreState ? '' : (req.query.state_name || '').trim();
    // Explicit unit selection is the most specific — use it directly.
    if (want) {
      if (allowed && !allowed.includes(want)) return { clause: ' AND 1=0', params: [] };
      return { clause: ' AND {col} = ?', params: [want] };
    }
    // State selection → restrict to that state's units (intersected with the role scope).
    // Reuses the {col} IN (...) machinery so every endpoint honours it without per-query edits.
    if (state) {
      const { rows } = await q('SELECT DISTINCT unit_code FROM supply_data WHERE state_name = ?', [state]);
      let stateUnits = rows.map(r => r.unit_code);
      if (allowed) stateUnits = stateUnits.filter(u => allowed.includes(u));
      if (!stateUnits.length) return { clause: ' AND 1=0', params: [] };
      return { clause: ` AND {col} IN (${stateUnits.map(() => '?').join(',')})`, params: stateUnits };
    }
    if (!allowed) return { clause: '', params: [] };
    if (!allowed.length) return { clause: ' AND 1=0', params: [] };
    return { clause: ` AND {col} IN (${allowed.map(() => '?').join(',')})`, params: allowed };
  }
  const on = (sc2, col) => sc2.clause.replace('{col}', col);

  // ── Reference dates (cached 5 min) ──────────────────────────────────────────
  let _dates = null, _datesAt = 0;
  async function refDates(req) {
    const fmt = x => new Date(x).toISOString().slice(0, 10);
    const from = (req && req.query && req.query.from || '').trim();
    const to   = (req && req.query && req.query.to   || '').trim();

    // Custom date range: cur = last supply day IN the range, prev = first supply day in the
    // range → all the existing cur-vs-prev logic then reads as "change over the selected period".
    if (from && to) {
      const { rows } = await q(
        `SELECT MAX(supply_date) cur_day, MIN(supply_date) prev_day
         FROM supply_data WHERE supply_date BETWEEN ? AND ?`, [from, to]);
      const cur = rows[0]?.cur_day, prev = rows[0]?.prev_day;
      if (!cur) return null;
      return {
        cur: fmt(cur),
        prev: prev && fmt(prev) !== fmt(cur) ? fmt(prev) : null,
        monthStart: from, prevMonthStart: from, range: true, from, to,
      };
    }

    // Default: latest loaded supply day (cached 5 min)
    if (_dates && Date.now() - _datesAt < 5 * 60 * 1000) return _dates;
    const { rows } = await q(`
      SELECT MAX(supply_date) AS cur_day,
             (SELECT MAX(supply_date) FROM supply_data
               WHERE supply_date < (SELECT MAX(supply_date) FROM supply_data)) AS prev_day
      FROM supply_data`);
    const cur = rows[0]?.cur_day, prev = rows[0]?.prev_day;
    if (!cur) return null;
    const d = new Date(cur);
    const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    _dates = {
      cur: fmt(new Date(cur)), prev: prev ? fmt(new Date(prev)) : null,
      monthStart: fmt(monthStart), prevMonthStart: fmt(prevMonthStart),
    };
    _datesAt = Date.now();
    return _dates;
  }

  // ════ Filters ════
  // Filter dropdowns are slow-changing reference data derived from full scans of the large
  // supply_data table — cache in-memory per scope (30-min TTL) so the dashboard isn't blocked.
  const _supdFiltersCache = new Map();
  const _SUPD_FILTERS_TTL = 30 * 60 * 1000;
  app.get('/api/supply-dash/filters', async (req, res) => {
    try {
      const sc2 = await scopeUnits(req);
      const key = JSON.stringify(sc2.params || []);
      const now = Date.now();
      const hit = _supdFiltersCache.get(key);
      if (hit && hit.exp > now && !('refresh' in req.query)) return res.json(hit.data);

      const [units, states, execs] = await Promise.all([
        q(`SELECT DISTINCT unit_code, unit_name, state_name FROM supply_data WHERE 1=1${on(sc2, 'unit_code')} ORDER BY unit_name`, sc2.params),
        q(`SELECT DISTINCT state_name FROM supply_data WHERE state_name IS NOT NULL AND state_name<>''${on(sc2, 'unit_code')} ORDER BY state_name`, sc2.params),
        q(`SELECT DISTINCT executive_code, executive_name FROM agency_master
           WHERE executive_name IS NOT NULL${on(sc2, 'unit')} ORDER BY executive_name LIMIT 500`, sc2.params),
      ]);
      const d = await refDates(req);
      const data = { units: units.rows, states: states.rows, executives: execs.rows, data_upto: d ? d.cur : null };
      _supdFiltersCache.set(key, { data, exp: now + _SUPD_FILTERS_TTL });
      res.json(data);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 1. KPI cards ════
  app.get('/api/supply-dash/kpis', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ no_data: true });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code'), P = sc2.params;
      const SM = on(sc2, 'unit'), // agency_master uses "unit"
            PM = sc2.params;

      const [today, mtd, agentDelta, masterStats, newAgents, sparkQ] = await Promise.all([
        // today + yesterday totals
        q(`SELECT supply_date, SUM(sup_copy) copies, COUNT(DISTINCT agcd) agents
           FROM supply_data WHERE supply_date IN (?, ?)${S} GROUP BY supply_date`,
          [d.cur, d.prev || d.cur, ...P]),
        // month-to-date daily average (month of the latest day)
        q(`SELECT SUM(sup_copy)/NULLIF(COUNT(DISTINCT supply_date),0) daily_avg,
                  COUNT(DISTINCT supply_date) days
           FROM supply_data WHERE supply_date >= ?${S}`, [d.monthStart, ...P]),
        // per-agent growth/reduction between prev and cur day
        q(`SELECT SUM(CASE WHEN cur > prv THEN cur - prv ELSE 0 END) growth,
                  SUM(CASE WHEN cur < prv THEN prv - cur ELSE 0 END) reduction,
                  SUM(cur > prv) grow_agents, SUM(cur < prv AND cur > 0) reduce_agents,
                  SUM(prv > 0 AND cur = 0) zero_agents
           FROM (SELECT agcd, dpcd,
                        SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) cur,
                        SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) prv
                 FROM supply_data WHERE supply_date IN (?, ?)${S}
                 GROUP BY agcd, dpcd) x`,
          [d.cur, d.prev || d.cur, d.cur, d.prev || d.cur, ...P]),
        // master counts
        q(`SELECT SUM(supply_stop_flag='N' AND suspend_date IS NULL) active_agents,
                  SUM(supply_stop_flag='Y' OR suspend_date IS NOT NULL) inactive_agents,
                  SUM(iscenter='Y') centers
           FROM agency_master WHERE 1=1${SM}`, PM),
        // new agents in the latest data month (bounded to that month, not open-ended)
        q(`SELECT COUNT(*) cnt FROM agency_master
           WHERE supply_start_dt >= ? AND supply_start_dt <= LAST_DAY(?)${SM}`,
          [d.monthStart, d.cur, ...PM]),
        // 14-day daily totals for the KPI sparkline
        q(`SELECT supply_date, SUM(sup_copy) copies FROM supply_data
           WHERE supply_date > DATE_SUB(?, INTERVAL 14 DAY)${S}
           GROUP BY supply_date ORDER BY supply_date`, [d.cur, ...P]),
      ]);

      const curRow  = today.rows.find(r => String(r.supply_date).slice(0, 10) === d.cur) || {};
      const prevRow = today.rows.find(r => String(r.supply_date).slice(0, 10) === d.prev) || {};
      const ad = agentDelta.rows[0] || {};
      const ms = masterStats.rows[0] || {};

      res.json({
        data_upto: d.cur, prev_day: d.prev,
        today_supply: N(curRow.copies), today_agents: N(curRow.agents),
        yesterday_supply: N(prevRow.copies),
        day_change: N(curRow.copies) - N(prevRow.copies),
        day_change_pct: r1(pct(N(curRow.copies), N(prevRow.copies))),
        month_avg_supply: Math.round(N(mtd.rows[0]?.daily_avg)),
        mtd_days: N(mtd.rows[0]?.days),
        mtd_growth_copies: N(ad.growth),
        mtd_reduction_copies: N(ad.reduction),
        net_growth: N(ad.growth) - N(ad.reduction),
        growing_agents: N(ad.grow_agents), reducing_agents: N(ad.reduce_agents),
        zero_supply_agents: N(ad.zero_agents),
        active_agents: N(ms.active_agents), inactive_agents: N(ms.inactive_agents),
        centers: N(ms.centers),
        new_agents_month: N(newAgents.rows[0]?.cnt),
        spark: sparkQ.rows.map(r => N(r.copies)),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 2. Branch-wise ════
  app.get('/api/supply-dash/branches', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code');
      const { rows } = await q(`
        SELECT unit_code, unit_name,
               COUNT(DISTINCT CASE WHEN cur > 0 THEN agcd END) agents,
               SUM(cur) supply, SUM(prv) prev_supply,
               SUM(CASE WHEN cur > prv THEN cur - prv ELSE 0 END) growth,
               SUM(CASE WHEN cur < prv THEN prv - cur ELSE 0 END) reduction
        FROM (SELECT s.unit_code, s.unit_name, s.agcd,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) cur,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prv
              FROM supply_data s ${AGENT_JOIN}
              WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}
              GROUP BY s.unit_code, s.unit_name, s.agcd) x
        GROUP BY unit_code, unit_name ORDER BY supply DESC`,
        [d.cur, d.prev || d.cur, d.cur, d.prev || d.cur, ...sc2.params]);

      const out = rows.map((r, i) => ({
        rank: i + 1, unit_code: r.unit_code, branch: r.unit_name,
        agents: N(r.agents), supply: N(r.supply), prev_supply: N(r.prev_supply),
        growth: N(r.growth), reduction: N(r.reduction),
        net_change: N(r.growth) - N(r.reduction),
        growth_pct: r1(pct(N(r.supply), N(r.prev_supply))),
      }));
      const by = k => out.length ? out.reduce((a, b) => (b[k] > a[k] ? b : a)) : null;
      res.json({
        data_upto: d.cur, rows: out,
        highest_supply: by('supply')?.branch || null,
        highest_growth: by('net_change')?.branch || null,
        highest_reduction: out.length ? out.reduce((a, b) => (b.reduction > a.reduction ? b : a)).branch : null,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 4. Agent-wise ════
  app.get('/api/supply-dash/agents', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 's.unit_code');
      const order = { growth: 'net_change DESC', decline: 'net_change ASC', supply: 'supply DESC' }[req.query.order] || 'supply DESC';
      const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 300);
      const search = (req.query.search || '').trim();
      const searchClause = search ? ' AND s.ag_name LIKE ?' : '';
      const searchParams = search ? [`%${search}%`] : [];

      const { rows } = await q(`
        SELECT x.agcd, x.ag_name, x.unit_name, x.city_name,
               MAX(am.executive_name) executive,
               x.supply, x.prev_supply, (x.supply - x.prev_supply) net_change,
               MAX(ao.cl_amt) outstanding
        FROM (SELECT s.unit_code, s.agcd, s.ag_name, s.unit_name, s.city_name,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) supply,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prev_supply
              FROM supply_data s ${AGENT_JOIN} WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}${searchClause}
              GROUP BY s.unit_code, s.agcd, s.ag_name, s.unit_name, s.city_name) x
        LEFT JOIN (SELECT unit, agcd, MAX(executive_name) executive_name
                   FROM agency_master GROUP BY unit, agcd) am
          ON am.unit = x.unit_code AND am.agcd = x.agcd
        LEFT JOIN (SELECT unit_code, ag_code, SUM(CASE WHEN cl_amt > 0 THEN cl_amt ELSE 0 END) cl_amt
                   FROM agency_outstanding WHERE period_label='CURRENT'
                   GROUP BY unit_code, ag_code) ao
          ON ao.unit_code = x.unit_code AND ao.ag_code = x.agcd
        GROUP BY x.unit_code, x.agcd, x.ag_name, x.unit_name, x.city_name, x.supply, x.prev_supply
        ORDER BY ${order} LIMIT ${limit}`,
        [d.cur, d.prev || d.cur, d.cur, d.prev || d.cur, ...sc2.params, ...searchParams]);

      res.json({
        data_upto: d.cur,
        rows: rows.map(r => ({
          agcd: r.agcd, agent: r.ag_name, branch: r.unit_name, city: r.city_name,
          executive: r.executive || null,
          supply: N(r.supply), prev_supply: N(r.prev_supply), net_change: N(r.net_change),
          growth_pct: r1(pct(N(r.supply), N(r.prev_supply))),
          outstanding: r.outstanding == null ? null : N(r.outstanding),
          last_visit: null, // DCR visit data pending sync
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 5. Executive performance ════
  app.get('/api/supply-dash/executives', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 's.unit_code');
      const { rows } = await q(`
        SELECT COALESCE(am.executive_name, '(no executive)') executive,
               COUNT(DISTINCT CONCAT(x.unit_code, '|', x.agcd)) agents,
               SUM(x.cur) supply,
               SUM(CASE WHEN x.cur > x.prv THEN x.cur - x.prv ELSE 0 END) growth,
               SUM(CASE WHEN x.cur < x.prv THEN x.prv - x.cur ELSE 0 END) reduction
        FROM (SELECT s.unit_code, s.agcd,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) cur,
                     SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prv
              FROM supply_data s ${AGENT_JOIN} WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}
              GROUP BY s.unit_code, s.agcd) x
        LEFT JOIN (SELECT unit, agcd, MAX(executive_name) executive_name
                   FROM agency_master GROUP BY unit, agcd) am
          ON am.unit = x.unit_code AND am.agcd = x.agcd
        GROUP BY executive HAVING supply > 0 OR growth > 0 OR reduction > 0
        ORDER BY supply DESC LIMIT 200`,
        [d.cur, d.prev || d.cur, d.cur, d.prev || d.cur, ...sc2.params]);

      const out = rows.map((r, i) => ({
        rank: i + 1, executive: r.executive,
        agents: N(r.agents), supply: N(r.supply),
        growth: N(r.growth), reduction: N(r.reduction),
        net_change: N(r.growth) - N(r.reduction),
        visits: null, new_agents: null, // DCR + onboarding attribution pending
      }));
      res.json({ data_upto: d.cur, rows: out });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 6. Trend ════
  app.get('/api/supply-dash/trend', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code');
      const g = req.query.granularity || 'daily';
      let sql, params;
      if (g === 'monthly') {
        sql = `SELECT DATE_FORMAT(supply_date,'%Y-%m') label,
                      SUM(sup_copy) copies, COUNT(DISTINCT supply_date) days,
                      ROUND(SUM(sup_copy)/COUNT(DISTINCT supply_date)) daily_avg
               FROM supply_data WHERE 1=1${S} GROUP BY label ORDER BY label`;
        params = sc2.params;
      } else if (g === 'yearly') {
        sql = `SELECT DATE_FORMAT(supply_date,'%Y') label,
                      SUM(sup_copy) copies, COUNT(DISTINCT supply_date) days,
                      ROUND(SUM(sup_copy)/COUNT(DISTINCT supply_date)) daily_avg
               FROM supply_data WHERE 1=1${S} GROUP BY label ORDER BY label`;
        params = sc2.params;
      } else {
        const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 120);
        sql = `SELECT DATE_FORMAT(supply_date,'%Y-%m-%d') label, SUM(sup_copy) copies
               FROM supply_data
               WHERE supply_date > DATE_SUB(?, INTERVAL ${days} DAY)${S}
               GROUP BY label ORDER BY label`;
        params = [d.cur, ...sc2.params];
      }
      const { rows } = await q(sql, params);
      res.json({ data_upto: d.cur, granularity: g, rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 11. Exceptions ════
  app.get('/api/supply-dash/exceptions', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ no_data: true });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code');
      const SM = on(sc2, 'am.unit');

      const [zeroSupply, negGrowth, abnormal, highOS] = await Promise.all([
        // active agents with no supply on current day but supply on prev day
        q(`SELECT ag_name, unit_name, prv copies_lost FROM (
             SELECT agcd, MAX(ag_name) ag_name, MAX(unit_name) unit_name,
                    SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) cur,
                    SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) prv
             FROM supply_data WHERE supply_date IN (?, ?)${S}
             GROUP BY agcd) x
           WHERE cur = 0 AND prv > 0 ORDER BY prv DESC LIMIT 50`,
          [d.cur, d.prev || d.cur, d.cur, d.prev || d.cur, ...sc2.params]),
        // negative growth >10% (14d vs prior 14d)
        q(`SELECT ag_name, unit_name, recent, prior,
                  ROUND((recent - prior) / prior * 100, 1) change_pct
           FROM (SELECT agcd, MAX(ag_name) ag_name, MAX(unit_name) unit_name,
                        SUM(CASE WHEN supply_date >  DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) recent,
                        SUM(CASE WHEN supply_date <= DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) prior
                 FROM supply_data WHERE supply_date > DATE_SUB(?, INTERVAL 28 DAY)${S}
                 GROUP BY agcd) x
           WHERE prior > 0 AND recent < prior * 0.9
           ORDER BY (prior - recent) DESC LIMIT 50`,
          [d.cur, d.cur, d.cur, ...sc2.params]),
        // abnormal growth >20%
        q(`SELECT ag_name, unit_name, recent, prior,
                  ROUND((recent - prior) / prior * 100, 1) change_pct
           FROM (SELECT agcd, MAX(ag_name) ag_name, MAX(unit_name) unit_name,
                        SUM(CASE WHEN supply_date >  DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) recent,
                        SUM(CASE WHEN supply_date <= DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) prior
                 FROM supply_data WHERE supply_date > DATE_SUB(?, INTERVAL 28 DAY)${S}
                 GROUP BY agcd) x
           WHERE prior > 100 AND recent > prior * 1.2
           ORDER BY (recent - prior) DESC LIMIT 50`,
          [d.cur, d.cur, d.cur, ...sc2.params]),
        // high outstanding among high-supply agents
        q(`SELECT ao.ag_name, ao.unit_name, ao.cl_amt outstanding, ao.last_supply_copies
           FROM agency_outstanding ao
           WHERE ao.period_label='CURRENT' AND ao.cl_amt > 100000
             AND ao.last_supply_copies > 100${on(sc2, 'ao.unit_code')}
           ORDER BY ao.cl_amt DESC LIMIT 50`, sc2.params),
      ]);

      res.json({
        data_upto: d.cur,
        zero_supply: zeroSupply.rows,
        negative_growth: negGrowth.rows,
        abnormal_growth: abnormal.rows,
        high_outstanding: highOS.rows,
        no_visit: [], // DCR data pending
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 14. AI Insights (auto-generated sentences) ════
  app.get('/api/supply-dash/insights', async (req, res) => {
    try {
      const d = await refDates(req);
      if (!d) return res.json({ insights: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code');
      const P = sc2.params;
      const fmtN2 = v => Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(2) + ' Lakh' : Math.round(v).toLocaleString('en-IN');

      const [branchDelta, weekLoss, reduced10, highOsHighSupply] = await Promise.all([
        q(`SELECT unit_name, SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE -sup_copy END) delta
           FROM supply_data WHERE supply_date IN (?, ?)${S}
           GROUP BY unit_name ORDER BY delta DESC`,
          [d.cur, d.cur, d.prev || d.cur, ...P]),
        q(`SELECT unit_name,
                  SUM(CASE WHEN supply_date >  DATE_SUB(?, INTERVAL 7 DAY) THEN sup_copy ELSE 0 END) -
                  SUM(CASE WHEN supply_date <= DATE_SUB(?, INTERVAL 7 DAY) THEN sup_copy ELSE 0 END) delta7
           FROM supply_data WHERE supply_date > DATE_SUB(?, INTERVAL 14 DAY)${S}
           GROUP BY unit_name ORDER BY delta7 ASC LIMIT 1`,
          [d.cur, d.cur, d.cur, ...P]),
        q(`SELECT COUNT(*) cnt FROM (
             SELECT agcd FROM supply_data WHERE supply_date > DATE_SUB(?, INTERVAL 28 DAY)${S}
             GROUP BY agcd
             HAVING SUM(CASE WHEN supply_date <= DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) > 0
                AND SUM(CASE WHEN supply_date >  DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) <
                    SUM(CASE WHEN supply_date <= DATE_SUB(?, INTERVAL 14 DAY) THEN sup_copy ELSE 0 END) * 0.9
           ) x`, [d.cur, d.cur, d.cur, d.cur, ...P]),
        q(`SELECT COUNT(*) cnt FROM agency_outstanding
           WHERE period_label='CURRENT' AND cl_amt > 100000 AND last_supply_copies > 100${on(sc2, 'unit_code')}`, P),
      ]);

      const insights = [];
      const bd = branchDelta.rows;
      if (bd.length) {
        const totalGrowth = bd.filter(r => N(r.delta) > 0).reduce((a, r) => a + N(r.delta), 0);
        const top = bd[0];
        if (N(top.delta) > 0 && totalGrowth > 0) {
          insights.push(`${top.unit_name} contributed ${Math.round(N(top.delta) / totalGrowth * 100)}% of total copy growth (${fmtN2(N(top.delta))} of ${fmtN2(totalGrowth)} copies) on the latest day.`);
        }
        const bottom = bd[bd.length - 1];
        if (N(bottom.delta) < 0) {
          insights.push(`${bottom.unit_name} lost ${fmtN2(-N(bottom.delta))} copies vs the previous day — the largest single-day decline.`);
        }
      }
      const wl = weekLoss.rows[0];
      if (wl && N(wl.delta7) < 0) {
        insights.push(`${wl.unit_name} lost ${fmtN2(-N(wl.delta7))} copies in the last 7 days vs the week before.`);
      }
      if (N(reduced10.rows[0]?.cnt) > 0) {
        insights.push(`${reduced10.rows[0].cnt} agents have reduced supply by more than 10% in the last 14 days.`);
      }
      if (N(highOsHighSupply.rows[0]?.cnt) > 0) {
        insights.push(`Outstanding above ₹1 Lakh exists for ${highOsHighSupply.rows[0].cnt} high-supply agents — supply continues despite heavy dues.`);
      }
      if (bd.length) {
        const best = [...bd].sort((a, b) => N(b.delta) - N(a.delta))[0];
        if (N(best.delta) > 0) insights.push(`${best.unit_name} achieved the highest net growth on the latest day (+${fmtN2(N(best.delta))} copies).`);
      }

      res.json({ data_upto: d.cur, insights });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  AGENT SALE (credit-sale active agencies) vs CASH SALE (hawker) analytics
  // ══════════════════════════════════════════════════════════════════════════

  // Publication → geography mapping (business rule, configurable — not hard-coded in queries).
  const PUB_GEO = {
    'RAJASTHAN PATRIKA': { label: 'Rajasthan + National', core: ['RAJASTHAN'] },
    'PATRIKA':           { label: 'MP + Chhattisgarh',    core: ['MADHYA PRADESH', 'CHHATTISGARH'] },
  };
  // Publications excluded from Agent Sale (by publ code). P14 = RAJASTHAN PATRIKA CITY.
  const AGENT_EXCLUDE_PUBS = ['P14'];

  // Agent Sale base = REGULAR supply to CREDIT-SALE + ACTIVE agencies only.
  // DISTINCT (unit,agcd) prevents agency_master dpcd rows from fanning out supply_data.
  const AGENT_JOIN = `JOIN (SELECT DISTINCT unit, agcd FROM agency_master
      WHERE ag_class_name = 'CREDIT SALE' AND COALESCE(supply_stop_flag,'N') = 'N'
        AND (suspend_date IS NULL OR suspend_date > CURDATE())) cm
    ON cm.unit = s.unit_code AND cm.agcd = s.agcd`;
  // REGULAR only, and drop excluded publications (Rajasthan Patrika City) from Agent Sale.
  const AGENT_WHERE = `s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN (${AGENT_EXCLUDE_PUBS.map(p => `'${p}'`).join(',')})`;

  // Unit → single home state (dominant state of that unit's agencies) — hawker_supply has no
  // state column, and a unit supplies many states in supply_data, so we cannot join unit→state
  // without double-counting. Cached 30 min. 43 units.
  let _uhs = null, _uhsAt = 0;
  async function unitHomeState() {
    if (_uhs && Date.now() - _uhsAt < 30 * 60 * 1000) return _uhs;
    const { rows } = await q(`SELECT unit, state_name, COUNT(*) c FROM agency_master
      WHERE state_name IS NOT NULL AND state_name <> '' GROUP BY unit, state_name`);
    const best = {};
    rows.forEach(r => { const u = r.unit; if (!best[u] || N(r.c) > best[u].c) best[u] = { state: r.state_name, c: N(r.c) }; });
    _uhs = {}; Object.keys(best).forEach(u => { _uhs[u] = best[u].state; });
    _uhsAt = Date.now();
    return _uhs;
  }
  const mkDelta = (cur, prev) => ({ current: cur, previous: prev, diff: cur - prev, growth_pct: r1(pct(cur, prev)) });

  // Sale date windows. Both single-day and date-range are a TWO-DAY comparison, never a sum:
  //   default   → current = latest business day, previous = the day before.
  //   date range → current = To date (latest supply day in range), previous = From date
  //                (earliest supply day in range). So "01→06 Aug" reads as 06 Aug vs 01 Aug.
  const COVID_DATE = '2020-03-18'; // fixed circulation baseline (pre-COVID)
  async function saleWin(req) {
    // COVID comparison: fixed previous = 18-Mar-2020, current = the user-selected date.
    if (req.query.covid === '1' || req.query.covid === 'true') {
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''));
      let cur = dateOk ? req.query.date : null;
      if (!cur) { const d0 = await refDates(req); cur = d0 ? d0.cur : COVID_DATE; }
      return { range: true, covid: true, cF: cur, cT: cur, pF: COVID_DATE, pT: COVID_DATE, data_upto: cur, cur_label: cur, prev_label: COVID_DATE };
    }
    const d = await refDates(req);
    if (!d) return null;
    if (d.range && d.from && d.to) {
      const prev = d.prev || d.cur;   // refDates gives cur=MAX(day in range), prev=MIN(day in range)
      return { range: true, cF: d.cur, cT: d.cur, pF: prev, pT: prev, data_upto: d.cur, cur_label: d.cur, prev_label: prev };
    }
    const prev = d.prev || d.cur;
    return { range: false, cF: d.cur, cT: d.cur, pF: prev, pT: prev, data_upto: d.cur, cur_label: d.cur, prev_label: prev };
  }
  // cur/prev SUM over the windows; the last two params are always (w.pF, w.cT) for the WHERE span.
  const winMeta = w => ({ data_upto: w.data_upto, range: w.range, cur_label: w.cur_label, prev_label: w.prev_label });

  // Cash Sale edition → display alias (configurable). Names normalised (uppercase, single spaces).
  const _normEd = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const EDITION_ALIAS = {};
  [
    ['CHAKSU - BASSI - KANOTA', 'City Dak'], ['CHOMU', 'City Dak'], ['DAUSA', 'City Dak'],
    ['DUDU - PHULERA - PHAGI', 'City Dak'], ['KARAULI', 'City Dak'], ['KOTPUTALI', 'City Dak'], ['TONK', 'City Dak'],
    ['VARIANT I', 'Bold'], ['VARIANT II', 'News Today'], ['VARIANT IIND', 'News Today'],
    ['GOLDEN WITH X', 'City Super'], ['UJJAIN', 'Ujjain'], ['WITHOUT X', 'City Standard'],
    ['AJMER CITY', 'CITY'], ['BHL ( CITY )', 'CITY'], ['BIKANER CITY', 'CITY'], ['JODHPUR CITY', 'CITY'],
    ['SRI GANGANAGAR CITY', 'CITY'], ['CITY EDITION', 'CITY'], ['CITY', 'CITY'],
  ].forEach(([k, v]) => { EDITION_ALIAS[_normEd(k)] = v; });
  const editionAlias = name => (name ? (EDITION_ALIAS[_normEd(name)] || name) : '—');

  // ════ Agent + Cash + Total summary (current period vs previous equivalent period) ════
  app.get('/api/supply-dash/sale-summary', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ no_data: true });
      const sc2 = await scopeUnits(req, { ignoreState: true });
      const stF = (req.query.state_name || req.query.state || '').trim();
      let hs = null;
      if (stF) { const uhs = await unitHomeState(); hs = Object.keys(uhs).filter(u => uhs[u] === stF); }
      const hsS = hs ? ` AND s.unit_code IN (${hs.map(() => '?').join(',') || "''"})` : '';
      const hsH = hs ? ` AND h.loc_id IN (${hs.map(() => '?').join(',') || "''"})` : '';
      const S = on(sc2, 's.unit_code'), Sh = on(sc2, 'h.loc_id');
      const [agent, cash] = await Promise.all([
        q(`SELECT SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) cur,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prv
           FROM supply_data s ${AGENT_JOIN}
           WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}${hsS}`,
          [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params, ...(hs || [])]),
        q(`SELECT SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) cur,
                  SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) prv
           FROM hawker_supply h WHERE h.supply_date IN (?, ?)${Sh}${hsH}`,
          [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params, ...(hs || [])]),
      ]);
      const aC = N(agent.rows[0] && agent.rows[0].cur), aP = N(agent.rows[0] && agent.rows[0].prv);
      const cC = N(cash.rows[0] && cash.rows[0].cur), cP = N(cash.rows[0] && cash.rows[0].prv);
      const totC = aC + cC;
      res.json({
        ...winMeta(w), prev_day: w.range ? null : w.prev_label, from: w.range ? w.cF : null, to: w.range ? w.cT : null,
        agent: mkDelta(aC, aP), cash: mkDelta(cC, cP), total: mkDelta(totC, aP + cP),
        agent_share_pct: totC ? r1(aC / totC * 100) : null, cash_share_pct: totC ? r1(cC / totC * 100) : null,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ AGENT drill — Level 1: state-wise (by branch HOME state, full unit supply) ════
  app.get('/api/supply-dash/agent/states', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req, { ignoreState: true });
      const S = on(sc2, 's.unit_code');
      const [uhs, agg] = await Promise.all([
        unitHomeState(),
        q(`SELECT s.unit_code uc,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) cur,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prv
           FROM supply_data s ${AGENT_JOIN}
           WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}
           GROUP BY s.unit_code`, [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params]),
      ]);
      const byState = {};
      agg.rows.forEach(r => {
        const st = uhs[r.uc] || '—';
        const o = byState[st] = byState[st] || { state: st, supply: 0, prev_supply: 0, branches: 0 };
        o.supply += N(r.cur); o.prev_supply += N(r.prv); if (N(r.cur) > 0) o.branches += 1;
      });
      let out = Object.values(byState).sort((a, b) => b.supply - a.supply);
      const _stF = (req.query.state_name || req.query.state || '').trim();
      if (_stF) out = out.filter(r => r.state === _stF);
      const total = out.reduce((a, r) => a + r.supply, 0);
      res.json({
        ...winMeta(w), total,
        rows: out.map(r => ({
          state: r.state, supply: r.supply, prev_supply: r.prev_supply, branches: r.branches,
          net_change: r.supply - r.prev_supply, growth_pct: r1(pct(r.supply, r.prev_supply)),
          contribution_pct: total ? r1(r.supply / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ AGENT drill — branches (full unit supply; home-state, optionally filtered) ════
  app.get('/api/supply-dash/agent/branches', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req, { ignoreState: true });
      const S = on(sc2, 's.unit_code');
      const state = (req.query.state || req.query.state_name || '').trim();
      const [uhs, agg] = await Promise.all([
        unitHomeState(),
        q(`SELECT s.unit_code, MAX(s.unit_name) unit_name,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) cur,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prv,
                  COUNT(DISTINCT s.agcd) agents
           FROM supply_data s ${AGENT_JOIN}
           WHERE ${AGENT_WHERE} AND s.supply_date IN (?, ?)${S}
           GROUP BY s.unit_code`, [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params]),
      ]);
      let rows = agg.rows.map(r => ({ ...r, state: uhs[r.unit_code] || '—' }));
      if (state) rows = rows.filter(r => r.state === state);
      rows.sort((a, b) => N(b.cur) - N(a.cur));
      const total = rows.reduce((a, r) => a + N(r.cur), 0);
      res.json({
        ...winMeta(w), state: state || null, total,
        rows: rows.map((r, i) => ({
          rank: i + 1, unit_code: r.unit_code, branch: r.unit_name, state: r.state, agents: N(r.agents),
          supply: N(r.cur), prev_supply: N(r.prv), net_change: N(r.cur) - N(r.prv),
          growth_pct: r1(pct(N(r.cur), N(r.prv))), contribution_pct: total ? r1(N(r.cur) / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ AGENT drill — Level 2: a branch by executive OR district (full unit) ════
  app.get('/api/supply-dash/agent/branch/:unit', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const unit = req.params.unit;
      const sc2 = await scopeUnits(req);
      if (sc2.clause === ' AND 1=0') return res.json({ rows: [] });
      const by = req.query.by === 'executive' ? 'executive' : 'district';
      let rows;
      if (by === 'district') {
        ({ rows } = await q(`
          SELECT COALESCE(s.dist_name,'—') label,
                 SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) supply,
                 SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prev_supply,
                 COUNT(DISTINCT s.agcd) agents
          FROM supply_data s ${AGENT_JOIN}
          WHERE ${AGENT_WHERE} AND s.unit_code = ? AND s.supply_date IN (?, ?)
          GROUP BY label ORDER BY supply DESC`,
          [w.cF, w.cT, w.pF, w.pT, unit, w.cF, w.pF]));
      } else {
        ({ rows } = await q(`
          SELECT COALESCE(am.executive_name,'(no executive)') label,
                 SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) supply,
                 SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prev_supply,
                 COUNT(DISTINCT s.agcd) agents
          FROM supply_data s ${AGENT_JOIN}
          LEFT JOIN (SELECT unit, agcd, MAX(executive_name) executive_name FROM agency_master GROUP BY unit, agcd) am
            ON am.unit = s.unit_code AND am.agcd = s.agcd
          WHERE ${AGENT_WHERE} AND s.unit_code = ? AND s.supply_date IN (?, ?)
          GROUP BY label ORDER BY supply DESC`,
          [w.cF, w.cT, w.pF, w.pT, unit, w.cF, w.pF]));
      }
      const total = rows.reduce((a, r) => a + N(r.supply), 0);
      res.json({
        ...winMeta(w), unit_code: unit, by, total,
        rows: rows.map(r => ({
          label: r.label, agents: N(r.agents), supply: N(r.supply), prev_supply: N(r.prev_supply),
          net_change: N(r.supply) - N(r.prev_supply), growth_pct: r1(pct(N(r.supply), N(r.prev_supply))),
          contribution_pct: total ? r1(N(r.supply) / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ CASH drill — Level 1: state-wise (unit home-state) ════
  app.get('/api/supply-dash/cash/states', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req, { ignoreState: true });
      const S = on(sc2, 'h.loc_id');
      const [uhs, agg] = await Promise.all([
        unitHomeState(),
        q(`SELECT h.loc_id, SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) cur,
                  SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) prv,
                  COUNT(DISTINCT h.hawker_id) hawkers
           FROM hawker_supply h WHERE h.supply_date IN (?, ?)${S}
           GROUP BY h.loc_id`, [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params]),
      ]);
      const byState = {};
      agg.rows.forEach(r => {
        const st = uhs[r.loc_id] || '—';
        const o = byState[st] = byState[st] || { state: st, supply: 0, prev_supply: 0, branches: 0 };
        o.supply += N(r.cur); o.prev_supply += N(r.prv); if (N(r.cur) > 0) o.branches += 1;
      });
      let out = Object.values(byState).sort((a, b) => b.supply - a.supply);
      const _stF = (req.query.state_name || req.query.state || '').trim();
      if (_stF) out = out.filter(r => r.state === _stF);
      const total = out.reduce((a, r) => a + r.supply, 0);
      res.json({
        ...winMeta(w), total,
        rows: out.map(r => ({
          state: r.state, supply: r.supply, prev_supply: r.prev_supply, branches: r.branches,
          net_change: r.supply - r.prev_supply, growth_pct: r1(pct(r.supply, r.prev_supply)),
          contribution_pct: total ? r1(r.supply / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ CASH drill — branches (optionally within a home-state) ════
  app.get('/api/supply-dash/cash/branches', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req, { ignoreState: true });
      const S = on(sc2, 'h.loc_id');
      const state = (req.query.state || req.query.state_name || '').trim();
      const [uhs, agg] = await Promise.all([
        unitHomeState(),
        q(`SELECT h.loc_id, MAX(h.unit_name) unit_name,
                  SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) cur,
                  SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) prv,
                  COUNT(DISTINCT h.hawker_id) hawkers, COUNT(DISTINCT h.hwk_cent_code) centers
           FROM hawker_supply h WHERE h.supply_date IN (?, ?)${S}
           GROUP BY h.loc_id`, [w.cF, w.cT, w.pF, w.pT, w.cF, w.pF, ...sc2.params]),
      ]);
      let rows = agg.rows.map(r => ({ ...r, state: uhs[r.loc_id] || '—' }));
      if (state) rows = rows.filter(r => r.state === state);
      rows.sort((a, b) => N(b.cur) - N(a.cur));
      const total = rows.reduce((a, r) => a + N(r.cur), 0);
      res.json({
        ...winMeta(w), state: state || null, total,
        rows: rows.map((r, i) => ({
          rank: i + 1, unit_code: r.loc_id, branch: r.unit_name, state: r.state,
          hawkers: N(r.hawkers), centers: N(r.centers), supply: N(r.cur), prev_supply: N(r.prv),
          net_change: N(r.cur) - N(r.prv), growth_pct: r1(pct(N(r.cur), N(r.prv))),
          contribution_pct: total ? r1(N(r.cur) / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ CASH drill — Level 2: a branch by executive OR center ════
  app.get('/api/supply-dash/cash/branch/:unit', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ rows: [] });
      const unit = req.params.unit;
      const by = ['executive', 'edition', 'hawker'].includes(req.query.by) ? req.query.by : 'center';
      const center = (req.query.center || '').trim();
      let groupCol, extraCls = '', extraP = [];
      if (by === 'executive') groupCol = `COALESCE(NULLIF(h.field_officer_name,''), NULLIF(h.center_incharge_name,''), '(no executive)')`;
      else if (by === 'edition') groupCol = `COALESCE(NULLIF(h.edtn_name,''), '—')`;
      else if (by === 'hawker') { groupCol = `COALESCE(NULLIF(h.hawker_name,''), h.hawker_id, '—')`; if (center) { extraCls = ' AND h.hawker_center = ?'; extraP = [center]; } }
      else groupCol = `COALESCE(NULLIF(h.hawker_center,''), '—')`;
      let { rows } = await q(`
        SELECT ${groupCol} label,
               SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) supply,
               SUM(CASE WHEN h.supply_date BETWEEN ? AND ? THEN h.sup_copies ELSE 0 END) prev_supply,
               COUNT(DISTINCT h.hawker_id) hawkers
        FROM hawker_supply h WHERE h.loc_id = ?${extraCls} AND h.supply_date IN (?, ?)
        GROUP BY label ORDER BY supply DESC`,
        [w.cF, w.cT, w.pF, w.pT, unit, ...extraP, w.cF, w.pF]);
      // Edition Wise: map raw edition names to their display alias and re-aggregate by alias.
      if (by === 'edition') {
        const byAlias = {};
        rows.forEach(r => {
          const al = editionAlias(r.label);
          const o = byAlias[al] = byAlias[al] || { label: al, supply: 0, prev_supply: 0, hawkers: 0 };
          o.supply += N(r.supply); o.prev_supply += N(r.prev_supply); o.hawkers += N(r.hawkers);
        });
        rows = Object.values(byAlias).sort((a, b) => N(b.supply) - N(a.supply));
      }
      const total = rows.reduce((a, r) => a + N(r.supply), 0);
      res.json({
        ...winMeta(w), unit_code: unit, by, center: center || null, total,
        rows: rows.map(r => ({
          label: r.label, hawkers: N(r.hawkers), supply: N(r.supply), prev_supply: N(r.prev_supply),
          net_change: N(r.supply) - N(r.prev_supply), growth_pct: r1(pct(N(r.supply), N(r.prev_supply))),
          contribution_pct: total ? r1(N(r.supply) / total * 100) : null,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ CASH — Center × Edition pivot (editions as columns, Date 1 [prev] vs Date 2 [current]) ════
  app.get('/api/supply-dash/cash/center-edition/:unit', async (req, res) => {
    try {
      const w = await saleWin(req);
      if (!w) return res.json({ centers: [], editions: [] });
      const unit = req.params.unit;
      const { rows } = await q(`
        SELECT COALESCE(NULLIF(h.hawker_center,''),'—') center,
               COALESCE(NULLIF(h.edtn_name,''),'—') edition,
               SUM(CASE WHEN h.supply_date = ? THEN h.sup_copies ELSE 0 END) cur,
               SUM(CASE WHEN h.supply_date = ? THEN h.sup_copies ELSE 0 END) prv
        FROM hawker_supply h WHERE h.loc_id = ? AND h.supply_date IN (?, ?)
        GROUP BY center, edition`, [w.cF, w.pF, unit, w.cF, w.pF]);

      const centers = {}, edSet = new Set();
      rows.forEach(r => {
        const al = editionAlias(r.edition); edSet.add(al);
        const c = centers[r.center] = centers[r.center] || { center: r.center, cur: {}, prev: {}, cur_total: 0, prev_total: 0 };
        c.cur[al] = (c.cur[al] || 0) + N(r.cur); c.prev[al] = (c.prev[al] || 0) + N(r.prv);
        c.cur_total += N(r.cur); c.prev_total += N(r.prv);
      });
      const ORDER = ['CITY', 'Bold', 'City Dak', 'News Today', 'City Super', 'City Standard', 'Ujjain'];
      const editions = [...edSet].sort((a, b) => { const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
      const out = Object.values(centers).map(c => ({ ...c, diff: c.cur_total - c.prev_total })).sort((a, b) => b.cur_total - a.cur_total);
      res.json({ ...winMeta(w), unit_code: unit, editions, centers: out });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
