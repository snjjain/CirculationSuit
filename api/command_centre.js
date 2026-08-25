'use strict';

/**
 * command_centre.js — State-wise performance for the redesigned Circulation
 * Command Centre.
 *
 * ONE endpoint returns everything the management view needs: the four KPIs per
 * state (Supply, Collection, Outstanding, DCR) each with a previous-period
 * comparison, plus the alerts, opportunities and market-share rows derived from
 * those same numbers. Deriving them here rather than in the browser means the
 * dashboard, a future email digest and the Telegram alerts can never disagree
 * about what counts as "critical".
 *
 * State bucketing is deliberately per-source, because each table names states
 * differently and getting this wrong silently drops a whole region:
 *   supply_data           state_name        RAJASTHAN / MADHYA PRADESH / ...
 *   agency_collection     state_name        RAJASTHAN / MADHYA PRADESH / ...
 *   agency_outstanding    group_unit_name   RPPL / MP / CG / NATIONAL
 *   agency_master         unit_state_nm     RJ / MP / CG        (abbreviations)
 * Everything is normalised onto the four canonical buckets below; anything that
 * is not one of the three core states falls into NATIONAL, matching regionOf()
 * used everywhere else in the app.
 *
 * Registered by server.js:  require('./command_centre')({ app, q })
 */

module.exports = function installCommandCentre({ app, q }) {
  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  const pct = (cur, prev) => (!prev ? null : ((cur - prev) / Math.abs(prev)) * 100);

  const STATES = [
    { key: 'RAJASTHAN',      name: 'Rajasthan',      os: 'RPPL',     abbr: 'RJ' },
    { key: 'MADHYA PRADESH', name: 'Madhya Pradesh', os: 'MP',       abbr: 'MP' },
    { key: 'CHHATTISGARH',   name: 'Chhattisgarh',   os: 'CG',       abbr: 'CG' },
    { key: 'NATIONAL',       name: 'National',       os: 'NATIONAL', abbr: null },
  ];
  const CORE = new Set(['RAJASTHAN', 'MADHYA PRADESH', 'CHHATTISGARH']);
  const bucketOf = s => { const u = String(s || '').trim().toUpperCase(); return CORE.has(u) ? u : 'NATIONAL'; };
  const bucketOfOs = s => {
    const u = String(s || '').trim().toUpperCase();
    return u === 'RPPL' ? 'RAJASTHAN' : u === 'MP' ? 'MADHYA PRADESH' : u === 'CG' ? 'CHHATTISGARH' : 'NATIONAL';
  };
  const blank = () => Object.fromEntries(STATES.map(s => [s.key, 0]));

  // ── Comparison windows ────────────────────────────────────────────────────
  // "Previous day" is the previous day WITH DATA, not calendar-yesterday — supply
  // syncs overnight and skips some days, and comparing against an empty day would
  // read as a total collapse.
  async function resolveDates(asOnParam, mode) {
    const { rows: mx } = await q(`SELECT MAX(supply_date) d FROM supply_data`);
    const latest = mx[0]?.d ? String(mx[0].d).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const asOn = /^\d{4}-\d{2}-\d{2}$/.test(asOnParam || '') && asOnParam <= latest ? asOnParam : latest;
    const back = mode === 'prev_week' ? 7 : mode === 'prev_month' ? 30 : 1;
    const { rows: pv } = await q(
      `SELECT MAX(supply_date) d FROM supply_data WHERE supply_date <= DATE_SUB(?, INTERVAL ? DAY)`, [asOn, back]);
    const prev = pv[0]?.d ? String(pv[0].d).slice(0, 10) : asOn;
    const label = mode === 'prev_week' ? 'Previous Week' : mode === 'prev_month' ? 'Previous Month' : 'Previous Day';
    return { asOn, prev, label, mode: mode || 'prev_day' };
  }

  /* Date range for the headline strip. Indian financial year runs Apr–Mar, so
     "This FY" starts on 1 April of the year the as-on date belongs to. Only the
     figures that are genuinely a SUM over time follow this range (collection,
     field visits); supply is a point-in-time daily count and outstanding is a
     balance, so both stay anchored to the as-on date whatever range is picked —
     each card says which window it covers rather than implying they all move. */
  function resolveRangeWindow(asOn, range) {
    const y = Number(asOn.slice(0, 4)), m = Number(asOn.slice(5, 7));
    const fyStartYear = m >= 4 ? y : y - 1;
    const pad = n => String(n).padStart(2, '0');
    const d = new Date(asOn + 'T00:00:00');
    switch (range) {
      case 'today':
        return { from: asOn, to: asOn, label: 'Today', key: 'today' };
      case 'last_month': {
        const s = new Date(d.getFullYear(), d.getMonth() - 1, 1);
        const e = new Date(d.getFullYear(), d.getMonth(), 0);
        const iso = x => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
        return { from: iso(s), to: iso(e), label: 'Last Month', key: 'last_month' };
      }
      case 'fytd':
        return { from: `${fyStartYear}-04-01`, to: asOn, label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)} (YTD)`, key: 'fytd' };
      case 'last_90':
        return { from: new Date(d.getTime() - 89 * 86400000).toISOString().slice(0, 10), to: asOn, label: 'Last 90 Days', key: 'last_90' };
      case 'mtd':
      default:
        return { from: asOn.slice(0, 8) + '01', to: asOn, label: 'This Month', key: 'mtd' };
    }
  }

  // Collection receipts + field visits over an arbitrary window, all-India.
  async function rangeTotals(win, unitScope) {
    const uC = unitScope ? ' AND unit_code = ?' : '';
    const uD = unitScope ? ' AND unit_code = ?' : '';
    const uP = unitScope ? [unitScope] : [];
    const [coll, visits] = await Promise.all([
      q(`SELECT -COALESCE(SUM(amount),0) amt, COUNT(*) txn, COUNT(DISTINCT ag_code) agencies
         FROM agency_collection WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uC}`, [win.from, win.to, ...uP]),
      q(`SELECT COUNT(*) visits, COUNT(DISTINCT visit_to_main_code) agencies, COUNT(DISTINCT emp_code) execs
         FROM dcr_agency_visit WHERE mark_attn_date BETWEEN ? AND ?${uD}`, [win.from, win.to, ...uP]),
    ]);
    return {
      collection: N(coll.rows[0]?.amt), txn: N(coll.rows[0]?.txn), agencies_paid: N(coll.rows[0]?.agencies),
      visits: N(visits.rows[0]?.visits), agencies_visited: N(visits.rows[0]?.agencies), execs_active: N(visits.rows[0]?.execs),
    };
  }

  // ── Supply: Agent (credit sale) + Cash (hawker), both sides state-bucketed ──
  async function supplyByState(asOn, prev, unitScope) {
    const uCl = unitScope ? ' AND s.unit_code = ?' : '';
    const uP  = unitScope ? [unitScope] : [];
    const hCl = unitScope ? ' AND h.loc_id = ?' : '';
    const [agent, cash, uhs] = await Promise.all([
      q(`SELECT COALESCE(NULLIF(s.state_name,''),'OTHER') st,
                SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) cur,
                SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prv
         FROM supply_data s
         JOIN (SELECT DISTINCT unit, agcd FROM agency_master
               WHERE ag_class_name = 'CREDIT SALE' AND COALESCE(supply_stop_flag,'N') = 'N'
                 AND (suspend_date IS NULL OR suspend_date > CURDATE())) cm
           ON cm.unit = s.unit_code AND cm.agcd = s.agcd
         WHERE s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN ('P14')
           AND s.supply_date IN (?, ?)${uCl}
         GROUP BY st`, [asOn, prev, asOn, prev, ...uP]),
      // hawker_supply has no state column — bucket via the unit's home state.
      q(`SELECT h.loc_id unit,
                SUM(CASE WHEN h.supply_date = ? THEN h.sup_copies ELSE 0 END) cur,
                SUM(CASE WHEN h.supply_date = ? THEN h.sup_copies ELSE 0 END) prv
         FROM hawker_supply h WHERE h.supply_date IN (?, ?)${hCl}
         GROUP BY h.loc_id`, [asOn, prev, asOn, prev, ...uP]),
      q(`SELECT unit, state_name, COUNT(*) c FROM agency_master
         WHERE state_name IS NOT NULL AND state_name <> '' GROUP BY unit, state_name`),
    ]);
    const home = {};
    uhs.rows.forEach(r => { const u = r.unit; if (!home[u] || N(r.c) > home[u].c) home[u] = { st: r.state_name, c: N(r.c) }; });

    const agentCur = blank(), agentPrev = blank(), cashCur = blank(), cashPrev = blank();
    agent.rows.forEach(r => { const b = bucketOf(r.st); agentCur[b] += N(r.cur); agentPrev[b] += N(r.prv); });
    cash.rows.forEach(r => { const b = bucketOf(home[r.unit]?.st); cashCur[b] += N(r.cur); cashPrev[b] += N(r.prv); });
    return { agentCur, agentPrev, cashCur, cashPrev };
  }

  // ── Collection: this month vs LAST MONTH'S BILLING (the business question the
  //    doc asks for), plus previous-day receipts and YTD-vs-last-YTD ───────────
  async function collectionByState(asOn, prev, unitScope) {
    const mStart = asOn.slice(0, 8) + '01';
    const d = new Date(asOn + 'T00:00:00');
    const pm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const prevMonthLabel = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
    // agency_outstanding.bill_amt on a monthly snapshot is CUMULATIVE for the financial
    // year, not that month's billing (RJ: Jun 33.55 Cr -> Jul 38.89 Cr). One month's
    // billing is therefore the difference between consecutive snapshots — the same
    // telescoping the Short Payment report uses. Taking the raw value would overstate
    // billing ~7x by July and make every state look like it collected almost nothing.
    const pm2 = new Date(d.getFullYear(), d.getMonth() - 2, 1);
    const prevPrevLabel = `${pm2.getFullYear()}-${String(pm2.getMonth() + 1).padStart(2, '0')}`;
    const yStart = asOn.slice(0, 4) + '-01-01';
    const lyStart = (Number(asOn.slice(0, 4)) - 1) + '-01-01';
    const lyAsOn  = (Number(asOn.slice(0, 4)) - 1) + asOn.slice(4);
    const uCl = unitScope ? ' AND unit_code = ?' : '';
    const uP  = unitScope ? [unitScope] : [];

    const [mtd, prevDay, ytd, lyYtd, billing] = await Promise.all([
      q(`SELECT state_name st, -COALESCE(SUM(amount),0) amt, COUNT(*) txn, COUNT(DISTINCT ag_code) agencies
         FROM agency_collection WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY state_name`, [mStart, asOn, ...uP]),
      q(`SELECT state_name st, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date = ?${uCl} GROUP BY state_name`, [prev, ...uP]),
      q(`SELECT state_name st, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY state_name`, [yStart, asOn, ...uP]),
      q(`SELECT state_name st, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY state_name`, [lyStart, lyAsOn, ...uP]),
      // Two consecutive snapshots — differenced below to isolate last month's billing.
      q(`SELECT period_label, group_unit_name st, SUM(bill_amt) amt FROM agency_outstanding
         WHERE period_label IN (?, ?)${unitScope ? ' AND unit_code = ?' : ''}
         GROUP BY period_label, group_unit_name`,
        [prevMonthLabel, prevPrevLabel, ...uP]),
    ]);
    const mk = () => blank();
    const out = { mtd: mk(), prevDay: mk(), ytd: mk(), lyYtd: mk(), billing: mk(), txn: mk(), agencies: mk() };
    mtd.rows.forEach(r => { const b = bucketOf(r.st); out.mtd[b] += N(r.amt); out.txn[b] += N(r.txn); out.agencies[b] += N(r.agencies); });
    prevDay.rows.forEach(r => { out.prevDay[bucketOf(r.st)] += N(r.amt); });
    ytd.rows.forEach(r => { out.ytd[bucketOf(r.st)] += N(r.amt); });
    lyYtd.rows.forEach(r => { out.lyYtd[bucketOf(r.st)] += N(r.amt); });
    const cumThis = blank(), cumPrev = blank();
    billing.rows.forEach(r => {
      const b = bucketOfOs(r.st);
      if (r.period_label === prevMonthLabel) cumThis[b] += N(r.amt);
      else cumPrev[b] += N(r.amt);
    });
    // Difference the cumulative snapshots. If the earlier one is missing (e.g. the
    // month is April, the FY's first), the cumulative figure IS that month's billing.
    const havePrev = billing.rows.some(r => r.period_label === prevPrevLabel);
    STATES.forEach(s => { out.billing[s.key] = havePrev ? Math.max(0, cumThis[s.key] - cumPrev[s.key]) : cumThis[s.key]; });
    out.prev_month_label = prevMonthLabel;
    return out;
  }

  // ── Outstanding: live balance now vs the last month-end snapshot ───────────
  async function osByState(unitScope) {
    const uCl = unitScope ? ' AND unit_code = ?' : '';
    const uP  = unitScope ? [unitScope] : [];
    const { rows: labels } = await q(
      `SELECT DISTINCT period_label FROM agency_outstanding
       WHERE period_label <> 'CURRENT' AND period_label NOT LIKE 'BILL-%' ORDER BY period_label DESC LIMIT 1`);
    const prevLabel = labels[0]?.period_label || null;
    const [cur, prv] = await Promise.all([
      q(`SELECT group_unit_name st, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os,
                SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 AND cl_amt>=100000 THEN 1 ELSE 0 END) critical,
                SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 THEN 1 ELSE 0 END) agencies
         FROM agency_outstanding WHERE period_label='CURRENT'${uCl} GROUP BY group_unit_name`, uP),
      prevLabel
        ? q(`SELECT group_unit_name st, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os
             FROM agency_outstanding WHERE period_label=?${uCl} GROUP BY group_unit_name`, [prevLabel, ...uP])
        : Promise.resolve({ rows: [] }),
    ]);
    const out = { cur: blank(), prev: blank(), critical: blank(), agencies: blank(), prev_label: prevLabel };
    cur.rows.forEach(r => { const b = bucketOfOs(r.st); out.cur[b] += N(r.os); out.critical[b] += N(r.critical); out.agencies[b] += N(r.agencies); });
    prv.rows.forEach(r => { out.prev[bucketOfOs(r.st)] += N(r.os); });
    return out;
  }

  // ── DCR: agency visits recorded, and how much of the book they cover ───────
  async function dcrByState(asOn, prev, unitScope) {
    const uCl = unitScope ? ' AND v.unit_code = ?' : '';
    const uP  = unitScope ? [unitScope] : [];
    // dcr_agency_visit is utf8mb4_unicode_ci while agency_master is
    // utf8mb4_0900_ai_ci, so joining them in SQL throws "Illegal mix of
    // collations". Both sides are fetched keyed by unit and merged in JS instead —
    // the same pattern the rest of the codebase uses for this table pair.
    const [visits, book, unitState] = await Promise.all([
      q(`SELECT v.unit_code unit, SUM(v.cur) cur, SUM(v.prv) prv,
                SUM(v.ag_cur) agencies_visited, COUNT(DISTINCT v.emp) execs
         FROM (SELECT unit_code, emp_code emp,
                      SUM(mark_attn_date = ?) cur, SUM(mark_attn_date = ?) prv,
                      COUNT(DISTINCT CASE WHEN mark_attn_date = ? THEN visit_to_main_code END) ag_cur
               FROM dcr_agency_visit
               WHERE mark_attn_date IN (?, ?) GROUP BY unit_code, emp_code) v
         WHERE 1=1${uCl} GROUP BY v.unit_code`,
        [asOn, prev, asOn, asOn, prev, ...uP]),
      q(`SELECT unit_state_nm st, COUNT(DISTINCT CONCAT(unit,'|',agcd)) agencies
         FROM agency_master
         WHERE CAST(dpcd AS UNSIGNED)=1 AND COALESCE(supply_stop_flag,'N')='N'
           AND (suspend_date IS NULL OR suspend_date > CURDATE())${unitScope ? ' AND unit = ?' : ''}
         GROUP BY unit_state_nm`, uP),
      q(`SELECT unit, MAX(unit_state_nm) st FROM agency_master GROUP BY unit`),
    ]);
    const uState = {};
    unitState.rows.forEach(r => { uState[r.unit] = r.st; });
    // agency_master.unit_state_nm stores abbreviations (RJ/MP/CG) plus RAJASTHAN.
    const bAbbr = s => {
      const u = String(s || '').trim().toUpperCase();
      if (u === 'RJ' || u === 'RAJASTHAN' || u === 'RPPL') return 'RAJASTHAN';
      if (u === 'MP' || u === 'MADHYA PRADESH') return 'MADHYA PRADESH';
      if (u === 'CG' || u === 'CHHATTISGARH') return 'CHHATTISGARH';
      return 'NATIONAL';
    };
    const out = { cur: blank(), prev: blank(), visited: blank(), execs: blank(), book: blank() };
    visits.rows.forEach(r => {
      const b = bAbbr(uState[r.unit]);
      out.cur[b] += N(r.cur); out.prev[b] += N(r.prv);
      out.visited[b] += N(r.agencies_visited); out.execs[b] += N(r.execs);
    });
    book.rows.forEach(r => { out.book[bAbbr(r.st)] += N(r.agencies); });
    return out;
  }

  async function stateHeads() {
    const { rows } = await q(
      `SELECT m.unit_code, MAX(m.vp_circulation_name) vp, MAX(m.zonal_head_name) zh
       FROM exec_hierarchy_mapping m GROUP BY m.unit_code`);
    const { rows: uhs } = await q(
      `SELECT unit, state_name, COUNT(*) c FROM agency_master
       WHERE state_name IS NOT NULL AND state_name<>'' GROUP BY unit, state_name`);
    const home = {};
    uhs.forEach(r => { const u = r.unit; if (!home[u] || N(r.c) > home[u].c) home[u] = r.state_name; });
    // Most-common VP per state bucket.
    const tally = {};
    rows.forEach(r => {
      const b = bucketOf(home[r.unit_code]);
      if (!r.vp || /^(n\/a|not applicable|none)$/i.test(r.vp)) return;
      tally[b] = tally[b] || {};
      tally[b][r.vp] = (tally[b][r.vp] || 0) + 1;
    });
    const out = {};
    Object.keys(tally).forEach(b => {
      out[b] = Object.entries(tally[b]).sort((a, c) => c[1] - a[1])[0][0];
    });
    // NATIONAL is a catch-all bucket spanning many far-flung units, so the
    // most-common-VP tally picks whoever happens to own the most of them rather
    // than the person actually accountable for it. Pinned per business.
    out.NATIONAL = 'Bhaskar Sahu';
    return out;
  }

  // Status ladder used consistently by every KPI so a "Critical" always means the
  // same severity to the reader, whichever card it appears on.
  function statusOf(growthPct, { critical = -10, watch = -2 } = {}) {
    if (growthPct == null) return 'watch';
    if (growthPct <= critical) return 'critical';
    if (growthPct <= watch) return 'watch';
    return 'healthy';
  }

  app.get('/api/command/state-performance', async (req, res) => {
    try {
      const unitScope = (req.query.unit_code || '').trim() || null;
      const { asOn, prev, label, mode } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range);
      const [sup, col, os, dcr, heads, rng] = await Promise.all([
        supplyByState(asOn, prev, unitScope),
        collectionByState(asOn, prev, unitScope),
        osByState(unitScope),
        dcrByState(asOn, prev, unitScope),
        stateHeads(),
        rangeTotals(win, unitScope),
      ]);

      const states = STATES.map(s => {
        const k = s.key;
        const supCur = sup.agentCur[k] + sup.cashCur[k], supPrev = sup.agentPrev[k] + sup.cashPrev[k];
        const supPct = pct(supCur, supPrev);
        const osCur = os.cur[k], osPrev = os.prev[k];
        const osPct = pct(osCur, osPrev);
        const billing = col.billing[k], mtd = col.mtd[k];
        const collPct = billing > 0 ? (mtd / billing) * 100 : null;
        const dcrCur = dcr.cur[k], dcrPrev = dcr.prev[k];
        const coverage = dcr.book[k] > 0 ? (dcr.visited[k] / dcr.book[k]) * 100 : null;
        return {
          key: k, name: s.name, head: heads[k] || null,
          supply: {
            current: supCur, previous: supPrev, diff: supCur - supPrev, growth_pct: r1(supPct),
            agent: sup.agentCur[k], cash: sup.cashCur[k],
            status: statusOf(supPct),
          },
          collection: {
            current: mtd, prev_month_billing: billing, collection_pct: r1(collPct),
            gap: billing - mtd, previous_day: col.prevDay[k],
            ytd: col.ytd[k], last_year_ytd: col.lyYtd[k], ytd_growth_pct: r1(pct(col.ytd[k], col.lyYtd[k])),
            txn: col.txn[k], agencies_paid: col.agencies[k], prev_month_label: col.prev_month_label,
            // Collection is judged against how much of last month's bill has come in,
            // not against a previous day — that is the number management acts on.
            status: collPct == null ? 'watch' : collPct >= 85 ? 'healthy' : collPct >= 60 ? 'watch' : 'critical',
          },
          os: {
            current: osCur, previous: osPrev, diff: osCur - osPrev, growth_pct: r1(osPct),
            critical_agencies: os.critical[k], agencies: os.agencies[k], prev_label: os.prev_label,
            // For outstanding, GROWTH is the bad direction — invert the ladder.
            status: osPct == null ? 'watch' : osPct >= 10 ? 'critical' : osPct >= 2 ? 'watch' : 'healthy',
          },
          dcr: {
            current: dcrCur, previous: dcrPrev, diff: dcrCur - dcrPrev, growth_pct: r1(pct(dcrCur, dcrPrev)),
            agencies_visited: dcr.visited[k], agencies_total: dcr.book[k], coverage_pct: r1(coverage),
            execs_active: dcr.execs[k],
            status: coverage == null ? 'watch' : coverage >= 5 ? 'healthy' : coverage >= 2 ? 'watch' : 'critical',
          },
        };
      }).filter(s => s.supply.current || s.collection.current || s.os.current || s.dcr.current);

      // All-India headline strip. Each figure carries the window it actually covers,
      // because they do not all follow the date range: supply is a point-in-time daily
      // count and outstanding is a balance, so both stay on the as-on date while
      // collection and field visits sum over the selected range.
      const sum = f => states.reduce((a, s) => a + f(s), 0);
      const supTot = sum(s => s.supply.current), supPrevTot = sum(s => s.supply.previous);
      const billTot = sum(s => s.collection.prev_month_billing);
      const mtdTot = sum(s => s.collection.current);
      const osTot = sum(s => s.os.current), osPrevTot = sum(s => s.os.previous);
      const bookTot = sum(s => s.dcr.agencies_total);
      const totals = {
        supply:        { value: supTot, prev: supPrevTot, growth_pct: r1(pct(supTot, supPrevTot)), window: `on ${asOn}` },
        agent:         { value: sum(s => s.supply.agent), share_pct: supTot ? r1(sum(s => s.supply.agent) / supTot * 100) : null, window: `on ${asOn}` },
        cash:          { value: sum(s => s.supply.cash),  share_pct: supTot ? r1(sum(s => s.supply.cash) / supTot * 100) : null, window: `on ${asOn}` },
        collection:    { value: rng.collection, txn: rng.txn, agencies_paid: rng.agencies_paid, window: win.label },
        collection_pct:{ value: billTot > 0 ? r1(mtdTot / billTot * 100) : null, billed: billTot, collected: mtdTot,
                         window: `this month vs ${col.prev_month_label} billing` },
        outstanding:   { value: osTot, prev: osPrevTot, growth_pct: r1(pct(osTot, osPrevTot)), window: `as on today` },
        critical:      { value: sum(s => s.os.critical_agencies), of: sum(s => s.os.agencies), window: 'agencies above ₹1 L' },
        coverage:      { value: rng.agencies_visited, of: bookTot, visits: rng.visits, execs: rng.execs_active,
                         pct: bookTot ? r1(rng.agencies_visited / bookTot * 100) : null, window: win.label },
      };

      res.json({
        as_on: asOn, previous: prev, compare: mode, compare_label: label,
        range: win.key, range_label: win.label, range_from: win.from, range_to: win.to,
        unit_code: unitScope,
        totals,
        states,
        alerts: buildAlerts(states),
        opportunities: buildOpportunities(states),
        market_share: buildMarketShare(states),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Derived intelligence ──────────────────────────────────────────────────
  // Rules, not a model: each alert states the number that triggered it and the
  // action it implies, so a reader can check the reasoning rather than trust it.
  const inr = n => {
    const a = Math.abs(N(n));
    if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    return `₹${Math.round(n).toLocaleString('en-IN')}`;
  };
  const cp = n => N(n).toLocaleString('en-IN');

  function buildAlerts(states) {
    const out = [];
    states.forEach(s => {
      if (s.supply.growth_pct != null && s.supply.growth_pct <= -2) {
        out.push({
          priority: s.supply.growth_pct <= -10 ? 'critical' : 'high',
          state: s.key, state_name: s.name, kpi: 'Supply',
          title: `${s.name}: supply down ${Math.abs(s.supply.growth_pct)}%`,
          impact: `${cp(Math.abs(s.supply.diff))} copies lost vs previous period (${cp(s.supply.current)} now, was ${cp(s.supply.previous)}).`,
          action: 'Check branch-wise decline and agencies that stopped lifting.',
          drill: { screen: 'supply_dash', state: s.key },
        });
      }
      if (s.collection.collection_pct != null && s.collection.collection_pct < 60 && s.collection.prev_month_billing > 0) {
        out.push({
          priority: s.collection.collection_pct < 40 ? 'critical' : 'high',
          state: s.key, state_name: s.name, kpi: 'Collection',
          title: `${s.name}: only ${s.collection.collection_pct}% of last month's billing collected`,
          impact: `${inr(s.collection.gap)} still uncollected against ${inr(s.collection.prev_month_billing)} billed in ${s.collection.prev_month_label}.`,
          action: 'Push recovery on the largest unpaid agencies before month end.',
          drill: { screen: 'collections', state: s.key },
        });
      }
      if (s.os.growth_pct != null && s.os.growth_pct >= 2) {
        out.push({
          priority: s.os.growth_pct >= 10 ? 'critical' : 'medium',
          state: s.key, state_name: s.name, kpi: 'Outstanding',
          title: `${s.name}: outstanding up ${s.os.growth_pct}%`,
          impact: `${inr(s.os.diff)} added since ${s.os.prev_label}; ${cp(s.os.critical_agencies)} agencies now above ₹1 L.`,
          action: 'Review critical agencies and hold supply where dues keep rising.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
      if (s.dcr.coverage_pct != null && s.dcr.coverage_pct < 2) {
        out.push({
          priority: s.dcr.coverage_pct < 1 ? 'critical' : 'medium',
          state: s.key, state_name: s.name, kpi: 'DCR',
          title: `${s.name}: field coverage only ${s.dcr.coverage_pct}%`,
          impact: `${cp(s.dcr.agencies_visited)} of ${cp(s.dcr.agencies_total)} agencies visited; ${cp(s.dcr.agencies_total - s.dcr.agencies_visited)} untouched.`,
          action: 'Check executive attendance and tour-plan compliance.',
          drill: { screen: 'dcr_analytics', state: s.key },
        });
      }
    });
    const rank = { critical: 0, high: 1, medium: 2 };
    return out.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 12);
  }

  function buildOpportunities(states) {
    const out = [];
    const withSupply = states.filter(s => s.supply.current > 0);
    const best = withSupply.slice().sort((a, b) => (b.supply.growth_pct ?? -999) - (a.supply.growth_pct ?? -999))[0];

    states.forEach(s => {
      // Dues rising faster than volume — the doc's worked example.
      if (s.os.growth_pct != null && s.supply.growth_pct != null && s.os.growth_pct > s.supply.growth_pct + 5) {
        out.push({
          priority: 'high', state: s.key, state_name: s.name, type: 'Supply vs credit imbalance',
          title: `${s.name}: outstanding growing ${s.os.growth_pct}% against supply ${s.supply.growth_pct}%`,
          impact: `Credit is expanding faster than volume — ${inr(s.os.current)} tied up. Converting even 10% releases ${inr(s.os.current * 0.1)}.`,
          action: 'Recover from high-dues agencies, then push supply where credit is clean.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
      if (s.collection.collection_pct != null && s.collection.collection_pct >= 60 && s.collection.collection_pct < 90 && s.collection.gap > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Collection recovery',
          title: `${s.name}: ${inr(s.collection.gap)} recoverable this month`,
          impact: `At ${s.collection.collection_pct}% collected, closing the gap lifts the state to full realisation of ${s.collection.prev_month_label} billing.`,
          action: 'Target the largest short-paid agencies — see Short Payment.',
          drill: { screen: 'collections', state: s.key },
        });
      }
      if (s.dcr.coverage_pct != null && s.dcr.coverage_pct >= 2 && s.dcr.agencies_total - s.dcr.agencies_visited > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Coverage gap',
          title: `${s.name}: ${cp(s.dcr.agencies_total - s.dcr.agencies_visited)} agencies not visited`,
          impact: 'Unvisited agencies drift on supply and dues; each visit is a recovery and growth chance.',
          action: 'Route the next tour plans through the uncovered belt.',
          drill: { screen: 'dcr_analytics', state: s.key },
        });
      }
    });
    if (best && best.supply.growth_pct != null && best.supply.growth_pct > 0) {
      out.push({
        priority: 'low', state: best.key, state_name: best.name, type: 'Replicate what works',
        title: `${best.name} is the only region growing (+${best.supply.growth_pct}%)`,
        impact: `${cp(best.supply.diff)} copies added while others declined — its branch practice is worth copying.`,
        action: 'Study its top branches and apply the same push elsewhere.',
        drill: { screen: 'supply_dash', state: best.key },
      });
    }
    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 10);
  }

  function buildMarketShare(states) {
    const totCur = states.reduce((s, x) => s + x.supply.current, 0);
    const totPrev = states.reduce((s, x) => s + x.supply.previous, 0);
    return states.map(s => {
      const share = totCur ? (s.supply.current / totCur) * 100 : 0;
      const prevShare = totPrev ? (s.supply.previous / totPrev) * 100 : 0;
      return {
        state: s.key, state_name: s.name,
        share_pct: r1(share), prev_share_pct: r1(prevShare), change_pp: r1(share - prevShare),
        copies: s.supply.current,
      };
    }).sort((a, b) => b.share_pct - a.share_pct).map((r, i) => ({ ...r, rank: i + 1 }));
  }
};
