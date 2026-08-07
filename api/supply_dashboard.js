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
  async function scopeUnits(req) {
    const personCode = req.headers['x-person-code'] || '';
    const hl = parseInt(req.headers['x-hierarchy-level'] || '1', 10);
    const allowed = await getScopeUnitCodes(personCode, hl); // null = all
    const want = (req.query.unit_code || '').trim();
    if (want) {
      if (allowed && !allowed.includes(want)) return { clause: ' AND 1=0', params: [] };
      return { clause: ' AND {col} = ?', params: [want] };
    }
    if (!allowed) return { clause: '', params: [] };
    if (!allowed.length) return { clause: ' AND 1=0', params: [] };
    return { clause: ` AND {col} IN (${allowed.map(() => '?').join(',')})`, params: allowed };
  }
  const on = (sc2, col) => sc2.clause.replace('{col}', col);

  // ── Reference dates (cached 5 min) ──────────────────────────────────────────
  let _dates = null, _datesAt = 0;
  async function refDates() {
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
    const fmt = x => x.toISOString().slice(0, 10);
    _dates = {
      cur: fmt(new Date(cur)), prev: prev ? fmt(new Date(prev)) : null,
      monthStart: fmt(monthStart), prevMonthStart: fmt(prevMonthStart),
    };
    _datesAt = Date.now();
    return _dates;
  }

  // ════ Filters ════
  app.get('/api/supply-dash/filters', async (req, res) => {
    try {
      const sc2 = await scopeUnits(req);
      const [units, execs] = await Promise.all([
        q(`SELECT DISTINCT unit_code, unit_name FROM supply_data WHERE 1=1${on(sc2, 'unit_code')} ORDER BY unit_name`, sc2.params),
        q(`SELECT DISTINCT executive_code, executive_name FROM agency_master
           WHERE executive_name IS NOT NULL${on(sc2, 'unit')} ORDER BY executive_name LIMIT 500`, sc2.params),
      ]);
      const d = await refDates();
      res.json({ units: units.rows, executives: execs.rows, data_upto: d ? d.cur : null });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ 1. KPI cards ════
  app.get('/api/supply-dash/kpis', async (req, res) => {
    try {
      const d = await refDates();
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
      const d = await refDates();
      if (!d) return res.json({ rows: [] });
      const sc2 = await scopeUnits(req);
      const S = on(sc2, 'unit_code');
      const { rows } = await q(`
        SELECT unit_code, unit_name,
               COUNT(DISTINCT CASE WHEN cur > 0 THEN agcd END) agents,
               SUM(cur) supply, SUM(prv) prev_supply,
               SUM(CASE WHEN cur > prv THEN cur - prv ELSE 0 END) growth,
               SUM(CASE WHEN cur < prv THEN prv - cur ELSE 0 END) reduction
        FROM (SELECT unit_code, unit_name, agcd,
                     SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) cur,
                     SUM(CASE WHEN supply_date = ? THEN sup_copy ELSE 0 END) prv
              FROM supply_data WHERE supply_date IN (?, ?)${S}
              GROUP BY unit_code, unit_name, agcd) x
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
      const d = await refDates();
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
              FROM supply_data s WHERE s.supply_date IN (?, ?)${S}${searchClause}
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
      const d = await refDates();
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
              FROM supply_data s WHERE s.supply_date IN (?, ?)${S}
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
      const d = await refDates();
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
      const d = await refDates();
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
      const d = await refDates();
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
};
