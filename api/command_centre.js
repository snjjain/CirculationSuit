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

  /* agency_master's unit -> home-state tally and the VP-per-state rollup are the same
     two full GROUP BYs on every request (~1.1s each), and they only move when
     agency_master syncs. Memoised for an hour so the dashboard is not re-deriving the
     org chart on every page load. */
  const MEMO = new Map();
  const MEMO_TTL_MS = 60 * 60 * 1000;
  function memo(key, fn) {
    const hit = MEMO.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.p;
    const p = Promise.resolve().then(fn).catch(e => { MEMO.delete(key); throw e; });
    MEMO.set(key, { at: Date.now(), p });
    return p;
  }
  // unit -> the state most of its agencies sit in. Used by supply bucketing, the state
  // head rollup and the state dashboard's branch list, so they cannot disagree.
  function unitHomeState() {
    return memo('unitHome', async () => {
      const { rows } = await q(
        `SELECT unit, state_name, COUNT(*) c FROM agency_master
         WHERE state_name IS NOT NULL AND state_name <> '' GROUP BY unit, state_name`);
      const home = {};
      rows.forEach(r => { const u = r.unit; if (!home[u] || N(r.c) > home[u].c) home[u] = { st: r.state_name, c: N(r.c) }; });
      return home;
    });
  }

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

  /* Quarterly Collection and Supply, current period vs the one before — the "base vs
     achieved" comparison management reads first.

     The two metrics do NOT share a quarter definition, and mixing them up shifts every
     bar by one quarter:
       Collection   financial year, Apr-Mar   Q1 Apr-Jun ... Q4 Jan-Mar
       Supply       calendar year,  Jan-Dec   Q1 Jan-Mar ... Q4 Oct-Dec
     So Q1 of "FY 2026-27" collection is Apr-Jun 2026, while Q1 of "CY 2026" supply is
     Jan-Mar 2026. Each series therefore gets its own window, its own year bucketing and
     its own pair of labels.

     Supply is a daily count, so a quarter's figure is its DAILY AVERAGE, not a sum —
     summing copies over 90 days produces a number nobody has a use for and swings purely
     on how many days happened to sync. */
  async function quarterly(asOn, unitScope) {
    const y = Number(asOn.slice(0, 4)), m = Number(asOn.slice(5, 7));
    const fy = m >= 4 ? y : y - 1;                 // current FY start year (Apr-Mar)
    const cy = y;                                  // current calendar year (Jan-Dec)
    const fySpan = yy => ({ from: `${yy}-04-01`, to: `${yy + 1}-03-31` });
    const cySpan = yy => ({ from: `${yy}-01-01`, to: `${yy}-12-31` });
    const fyCur = fySpan(fy), fyBase = fySpan(fy - 1);
    const cyCur = cySpan(cy), cyBase = cySpan(cy - 1);
    const uC = unitScope ? ' AND unit_code = ?' : '';
    const uP = unitScope ? [unitScope] : [];

    const [coll, sup] = await Promise.all([
      q(`SELECT YEAR(coll_date) y, QUARTER(coll_date) q, -COALESCE(SUM(amount),0) amt
         FROM agency_collection
         WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uC}
         GROUP BY y, q`, [fyBase.from, fyCur.to, ...uP]),
      q(`SELECT YEAR(supply_date) y, QUARTER(supply_date) q,
                SUM(sup_copy) copies, COUNT(DISTINCT supply_date) days
         FROM supply_data
         WHERE supply_date BETWEEN ? AND ?${uC}
         GROUP BY y, q`, [cyBase.from, cyCur.to, ...uP]),
    ]);
    // Calendar quarter -> FY quarter. Calendar Q2 (Apr-Jun) is FY Q1, and calendar
    // Q1 (Jan-Mar) belongs to the PREVIOUS financial year's Q4.
    const toFy = (yy, cq) => (cq === 1 ? { fy: yy - 1, q: 4 } : { fy: yy, q: cq - 1 });
    const mk = () => [1, 2, 3, 4].map(q => ({ q: 'Q' + q, base: 0, current: 0 }));
    const collOut = mk(), supOut = mk();
    coll.rows.forEach(r => {
      const f = toFy(N(r.y), N(r.q));
      const slot = collOut[f.q - 1]; if (!slot) return;
      if (f.fy === fy) slot.current += N(r.amt); else if (f.fy === fy - 1) slot.base += N(r.amt);
    });
    sup.rows.forEach(r => {
      // Calendar quarters map straight through — no FY shift for supply.
      const slot = supOut[N(r.q) - 1]; if (!slot) return;
      const avg = N(r.days) ? Math.round(N(r.copies) / N(r.days)) : 0;
      if (N(r.y) === cy) slot.current += avg; else if (N(r.y) === cy - 1) slot.base += avg;
    });
    return {
      collection: collOut, supply: supOut,
      collection_current: `FY ${fy}-${String(fy + 1).slice(2)}`,
      collection_base: `FY ${fy - 1}-${String(fy).slice(2)}`,
      collection_basis: 'Financial year · Apr–Mar',
      supply_current: `CY ${cy}`,
      supply_base: `CY ${cy - 1}`,
      supply_basis: 'Calendar year · Jan–Dec',
      // kept so anything still reading the old field names keeps working
      fy_current: `FY ${fy}-${String(fy + 1).slice(2)}`,
      fy_base: `FY ${fy - 1}-${String(fy).slice(2)}`,
    };
  }

  /* The quarterly supply figure is a two-year scan of supply_data — 7-8 seconds on its
     own, which was the whole reason the Command Centre sat on skeletons. It moves only
     when supply syncs, so the result is cached per (as-on date, unit scope): the first
     caller after a sync pays for it and everyone else is served from memory. It is also
     served from its own endpoint so the KPI cards never wait behind it. */
  const QTR_CACHE = new Map();
  const QTR_TTL_MS = 60 * 60 * 1000;
  async function quarterlyCached(asOn, unitScope) {
    const key = `${asOn}|${unitScope || ''}`;
    const hit = QTR_CACHE.get(key);
    if (hit && Date.now() - hit.at < QTR_TTL_MS) return hit.val;
    const val = await quarterly(asOn, unitScope);
    QTR_CACHE.set(key, { at: Date.now(), val });
    // Keyed by as-on date, so yesterday's entries are dead weight once supply syncs.
    if (QTR_CACHE.size > 40) {
      for (const k of QTR_CACHE.keys()) { if (!k.startsWith(asOn)) QTR_CACHE.delete(k); }
    }
    return val;
  }

  app.get('/api/command/quarterly', async (req, res) => {
    try {
      const { asOn } = await resolveDates(req.query.as_on, req.query.compare);
      const unitScope = String(req.query.unit_code || '').trim() || null;
      res.json(await quarterlyCached(asOn, unitScope));
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

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
      unitHomeState(),
    ]);
    const home = uhs;

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

  function stateHeads() { return memo('stateHeads', _stateHeads); }
  async function _stateHeads() {
    const { rows } = await q(
      `SELECT m.unit_code, MAX(m.vp_circulation_name) vp, MAX(m.zonal_head_name) zh
       FROM exec_hierarchy_mapping m GROUP BY m.unit_code`);
    const hs = await unitHomeState();
    const home = {};
    Object.keys(hs).forEach(u => { home[u] = hs[u].st; });
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
            // Agent (credit) and cash (city) sale are separate businesses, so each carries
            // its own previous figure and movement rather than only a combined one.
            agent_previous: sup.agentPrev[k], cash_previous: sup.cashPrev[k],
            agent_growth_pct: r1(pct(sup.agentCur[k], sup.agentPrev[k])),
            cash_growth_pct: r1(pct(sup.cashCur[k], sup.cashPrev[k])),
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
        ...balance(buildAlerts(states), buildOpportunities(states)),
        market_share: buildMarketShare(states),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  /* ── One state, branch by branch ────────────────────────────────────────────
     The state cards answer "which region is in trouble". This answers the next
     question — "where in that region" — with the same four KPIs plus branch-wise
     supply, collection, outstanding, the agencies moving most, and the executives
     carrying them.

     Everything is fetched ONCE, scoped to the state's unit list, and aggregated in JS.
     Per-unit round trips would mean ~30 queries for Rajasthan, and SQL joins across
     agency_master (utf8mb4_0900_ai_ci) and dcr_agency_visit (utf8mb4_unicode_ci) throw
     "Illegal mix of collations" — so the merge happens here either way. */
  async function unitsOfState(stateKey) {
    /* A unit belongs to the state most of its agencies sit in; agency_master.state_name is
       per-agency and a handful are mistagged, so the majority wins rather than MAX().
       Blank state_name is excluded from the tally — a unit with many unfilled rows would
       otherwise "win" with '' and fall into NATIONAL. Unit names are read separately so
       they cannot split a unit's tally across two spellings. This is the same
       most-agencies-wins rule the state cards use, so the two views agree on which
       branches make up a state. */
    const [home, nm] = await Promise.all([
      unitHomeState(),
      memo('unitNames', async () => {
        const { rows } = await q(`SELECT unit, MAX(unit_name) unit_name FROM agency_master GROUP BY unit`);
        const m = {}; rows.forEach(r => { m[r.unit] = r.unit_name; });
        return m;
      }),
    ]);
    return Object.entries(home)
      .filter(([, v]) => bucketOf(v.st) === stateKey)
      .map(([unit]) => ({ unit_code: unit, unit_name: nm[unit] || unit }))
      .sort((a, b) => String(a.unit_name).localeCompare(String(b.unit_name)));
  }

  app.get('/api/command/state-dashboard', async (req, res) => {
    try {
      const stateKey = String(req.query.state || '').toUpperCase();
      const meta = STATES.find(s => s.key === stateKey);
      if (!meta) return res.status(400).json({ detail: 'Unknown state' });

      const { asOn, prev, label, mode } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range);
      const allUnits = await unitsOfState(stateKey);
      const unitName = {}; allUnits.forEach(u => { unitName[u.unit_code] = u.unit_name; });

      /* Same screen, two levels. Without unit_code it is the state and the rows are its
         branches; with one it is that branch and the rows are its executives. Cash (city)
         supply carries a centre-incharge code but no agency, so at executive level it is
         attributed to the CI and at branch level it simply sums. */
      const unitScope = String(req.query.unit_code || '').trim();
      const isBranch = !!unitScope && allUnits.some(u => u.unit_code === unitScope);
      if (unitScope && !isBranch) return res.status(400).json({ detail: 'Branch is not in this state' });
      const units = isBranch ? allUnits.filter(u => u.unit_code === unitScope) : allUnits;
      const codes = units.map(u => u.unit_code);
      const groupBy = isBranch ? 'exec' : 'unit';
      if (!codes.length) return res.json({ state: stateKey, state_name: meta.name, branches: [] });
      const IN = codes.map(() => '?').join(',');

      // Last month's billing needs two consecutive cumulative snapshots differenced —
      // agency_outstanding.bill_amt is cumulative for the FY, not the month.
      const d = new Date(asOn + 'T00:00:00');
      const pm  = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const pm2 = new Date(d.getFullYear(), d.getMonth() - 2, 1);
      const lbl = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
      const prevMonthLabel = lbl(pm), prevPrevLabel = lbl(pm2);

      const [agentSup, cashSup, coll, os, billing, master, hier, visits, execActive] = await Promise.all([
        // Agent (credit) supply, agency level, on both dates.
        q(`SELECT s.unit_code, s.agcd,
                  SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) cur,
                  SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prv
           FROM supply_data s FORCE INDEX (idx_sd_dateunit)
           JOIN (SELECT DISTINCT unit, agcd FROM agency_master
                 WHERE ag_class_name='CREDIT SALE' AND COALESCE(supply_stop_flag,'N')='N'
                   AND (suspend_date IS NULL OR suspend_date > CURDATE())) cm
             ON cm.unit = s.unit_code AND cm.agcd = s.agcd
           WHERE s.supply_date IN (?, ?) AND s.unit_code IN (${IN})
             AND s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')
           GROUP BY s.unit_code, s.agcd`, [asOn, prev, asOn, prev, ...codes]),
        // Cash (city) supply exists only in the 9 hawker branches. There is no agency
        // dimension, but there is a centre incharge — which is who carries it.
        q(`SELECT loc_id unit_code, center_incharge, MAX(center_incharge_name) center_incharge_name,
                  SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) cur,
                  SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) prv,
                  COUNT(DISTINCT CASE WHEN supply_date = ? THEN hwk_cent_code END) centres,
                  COUNT(DISTINCT CASE WHEN supply_date = ? THEN hawker_id END) hawkers,
                  MAX(CASE WHEN supply_date = ? THEN COALESCE(hawker_center, hwk_cent_code) END) cent_name
           FROM hawker_supply WHERE supply_date IN (?, ?) AND loc_id IN (${IN})
           GROUP BY loc_id, center_incharge`, [asOn, prev, asOn, asOn, asOn, asOn, prev, ...codes]),
        q(`SELECT unit_code, ag_code, -COALESCE(SUM(amount),0) amt, COUNT(*) txn
           FROM agency_collection
           WHERE is_valid=1 AND coll_date BETWEEN ? AND ? AND unit_code IN (${IN})
           GROUP BY unit_code, ag_code`, [win.from, win.to, ...codes]),
        q(`SELECT unit_code, ag_code, MAX(ag_name) ag_name, MAX(exec_code) exec_code,
                  MAX(exec_name) exec_name,
                  SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os,
                  SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 THEN 1 ELSE 0 END) is_main,
                  SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 AND cl_amt>=100000 THEN 1 ELSE 0 END) critical
           FROM agency_outstanding
           WHERE period_label='CURRENT' AND unit_code IN (${IN})
           GROUP BY unit_code, ag_code`, codes),
        q(`SELECT period_label, unit_code, SUM(bill_amt) amt FROM agency_outstanding
           WHERE period_label IN (?, ?) AND unit_code IN (${IN})
           GROUP BY period_label, unit_code`, [prevMonthLabel, prevPrevLabel, ...codes]),
        q(`SELECT unit, agcd, MAX(ag_name) ag_name, MAX(executive_code) exec_code,
                  MAX(executive_name) exec_name, MAX(dist_name) dist_name
           FROM agency_master
           WHERE unit IN (${IN}) AND CAST(dpcd AS UNSIGNED)=1
             AND COALESCE(supply_stop_flag,'N')='N'
             AND (suspend_date IS NULL OR suspend_date > CURDATE())
           GROUP BY unit, agcd`, codes),
        q(`SELECT exec_code, MAX(exec_desig) desig, MAX(edtn_incharge_name) edtn,
                  MAX(circ_incharge_name) circ, MAX(zonal_head_name) zonal
           FROM exec_hierarchy_mapping GROUP BY exec_code`),
        // Field visits over the selected window, by unit and by executive.
        q(`SELECT unit_code, emp_code, COUNT(*) visits,
                  COUNT(DISTINCT visit_to_main_code) agencies
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ? AND unit_code IN (${IN})
           GROUP BY unit_code, emp_code`, [win.from, win.to, ...codes]),
        // Active exec flag — scoped to unit_code IN scope so the scan stays small.
        q(`SELECT executive_code, is_active_pli FROM exec_master WHERE unit_code IN (${IN})`, codes),
      ]);

      // ── Active executive map from exec_master ──
      const activeMap = new Map();
      (execActive.rows || []).forEach(r => activeMap.set(r.executive_code, r.is_active_pli === 'Y'));

      // ── Roll everything up per branch and per executive ──
      const mk = () => ({
        agent_cur: 0, agent_prev: 0, cash_cur: 0, cash_prev: 0,
        collection: 0, txn: 0, agencies_paid: 0, billed: 0,
        os: 0, os_agencies: 0, critical: 0, book: 0,
        visits: 0, agencies_visited: 0, execs: new Set(),
      });
      const B = {}; codes.forEach(c => { B[c] = mk(); });
      const E = {};                                     // exec_code -> aggregate
      const execOf = {};                                // "unit|agcd" -> {code,name}

      master.rows.forEach(r => {
        const k = `${r.unit}|${r.agcd}`;
        execOf[k] = { code: r.exec_code, name: r.exec_name };
        if (B[r.unit]) B[r.unit].book += 1;
      });
      const exec = (code, name, unit) => {
        if (!code) return null;
        E[code] = E[code] || {
          exec_code: code, exec_name: name || code, units: new Set(),
          is_active: activeMap.has(code) ? activeMap.get(code) : null,
          agencies: 0, supply_cur: 0, supply_prev: 0, cash_cur: 0, cash_prev: 0, collection: 0, billed: 0, os: 0,
          txn: 0, agencies_paid: 0, os_agencies: 0, critical: 0,
          visits: 0, agencies_visited: 0,
          hawker_centres: 0, hawker_count: 0, hawker_cent_name: null,
        };
        if (name && E[code].exec_name === code) E[code].exec_name = name;
        if (unit) E[code].units.add(unit);
        return E[code];
      };
      master.rows.forEach(r => { const e = exec(r.exec_code, r.exec_name, r.unit); if (e) e.agencies += 1; });

      agentSup.rows.forEach(r => {
        const b = B[r.unit_code]; if (b) { b.agent_cur += N(r.cur); b.agent_prev += N(r.prv); }
        const k = `${r.unit_code}|${r.agcd}`;
        const e = execOf[k] && exec(execOf[k].code, execOf[k].name, r.unit_code);
        if (e) { e.supply_cur += N(r.cur); e.supply_prev += N(r.prv); }
      });
      cashSup.rows.forEach(r => {
        const b = B[r.unit_code]; if (b) { b.cash_cur += N(r.cur); b.cash_prev += N(r.prv); }
        // City sale belongs to the centre incharge, who is an executive in their own right.
        const e = exec(r.center_incharge, r.center_incharge_name, r.unit_code);
        if (e) { e.supply_cur += N(r.cur); e.supply_prev += N(r.prv); e.cash_cur += N(r.cur); e.cash_prev += N(r.prv); e.hawker_centres += N(r.centres); e.hawker_count += N(r.hawkers); if (r.cent_name && !e.hawker_cent_name) e.hawker_cent_name = r.cent_name; }
      });
      coll.rows.forEach(r => {
        const b = B[r.unit_code];
        if (b) { b.collection += N(r.amt); b.txn += N(r.txn); if (N(r.amt) > 0) b.agencies_paid += 1; }
        const k = `${r.unit_code}|${r.ag_code}`;
        const e = execOf[k] && exec(execOf[k].code, execOf[k].name, r.unit_code);
        if (e) { e.collection += N(r.amt); e.txn += N(r.txn); if (N(r.amt) > 0) e.agencies_paid += 1; }
      });
      os.rows.forEach(r => {
        const b = B[r.unit_code];
        if (b) { b.os += N(r.os); b.os_agencies += N(r.is_main); b.critical += N(r.critical); }
        const k = `${r.unit_code}|${r.ag_code}`;
        // agency_outstanding carries its own exec — the authority when master is stale.
        const e = exec(r.exec_code || (execOf[k] && execOf[k].code), r.exec_name || (execOf[k] && execOf[k].name), r.unit_code);
        if (e) { e.os += N(r.os); e.os_agencies += N(r.is_main); e.critical += N(r.critical); }
      });
      const cumThis = {}, cumPrev = {};
      billing.rows.forEach(r => {
        (r.period_label === prevMonthLabel ? cumThis : cumPrev)[r.unit_code] =
          ((r.period_label === prevMonthLabel ? cumThis : cumPrev)[r.unit_code] || 0) + N(r.amt);
      });
      const havePrev = billing.rows.some(r => r.period_label === prevPrevLabel);
      codes.forEach(c => {
        B[c].billed = havePrev ? Math.max(0, (cumThis[c] || 0) - (cumPrev[c] || 0)) : (cumThis[c] || 0);
      });
      visits.rows.forEach(r => {
        const b = B[r.unit_code];
        if (b) { b.visits += N(r.visits); b.agencies_visited += N(r.agencies); b.execs.add(r.emp_code); }
        const e = E[r.emp_code];
        if (e) { e.visits += N(r.visits); e.agencies_visited += N(r.agencies); }
      });

      /* The three breakdown tables all read from one row shape, so the same screen can
         render the state's branches or a branch's executives without a second layout. */
      const rowOf = (key, name, sub, a) => {
        const supCur = a.supply_cur, supPrev = a.supply_prev;
        return {
          key, name, sub,
          unit_code: a.unit_code || null, unit_name: a.unit_name || null,
          exec_code: a.exec_code || null,
          supply: { current: supCur, previous: supPrev, diff: supCur - supPrev,
                    growth_pct: r1(pct(supCur, supPrev)), agent: a.agent_cur, cash: a.cash_cur },
          collection: { collected: a.collection, billed: a.billed, gap: Math.max(0, a.billed - a.collection),
                        pct: a.billed ? r1((a.collection / a.billed) * 100) : null,
                        txn: a.txn, agencies_paid: a.agencies_paid },
          outstanding: { amount: a.os, agencies: a.os_agencies, critical: a.critical,
                         per_agency: a.os_agencies ? Math.round(a.os / a.os_agencies) : 0 },
          dcr: { visits: a.visits, agencies_visited: a.agencies_visited, book: a.book,
                 execs: a.execs, coverage_pct: a.book ? r1((a.agencies_visited / a.book) * 100) : null },
        };
      };
      const branches = groupBy === 'unit'
        ? units.map(u => {
            const b = B[u.unit_code];
            const br = rowOf(u.unit_code, u.unit_name, null, {
              unit_code: u.unit_code, unit_name: u.unit_name,
              supply_cur: b.agent_cur + b.cash_cur, supply_prev: b.agent_prev + b.cash_prev,
              agent_cur: b.agent_cur, cash_cur: b.cash_cur,
              collection: b.collection, billed: b.billed, txn: b.txn, agencies_paid: b.agencies_paid,
              os: b.os, os_agencies: b.os_agencies, critical: b.critical,
              visits: b.visits, agencies_visited: b.agencies_visited, book: b.book, execs: b.execs.size,
            });
            br.supply.agent_prev = b.agent_prev;
            br.supply.cash_prev = b.cash_prev;
            br.supply.agent_growth_pct = r1(pct(b.agent_cur, b.agent_prev));
            br.supply.cash_growth_pct = r1(pct(b.cash_cur, b.cash_prev));
            return br;
          }).sort((a, x) => x.supply.current - a.supply.current)
        : Object.values(E).map(e => {
            const h = hier.rows.find(x => x.exec_code === e.exec_code) || {};
            /* Billing has no executive dimension — agency_outstanding's bill_amt snapshots
               are per agency, so an executive's "billed" is the sum over the agencies they
               hold. Only the branch has a differenced monthly figure, so at executive level
               collection % is measured against collection + dues instead, and the column
               header says so rather than quietly changing meaning. */
            const execRow = rowOf(e.exec_code, e.exec_name, h.desig || null, {
              unit_code: [...e.units][0] || unitScope,
              unit_name: [...e.units].map(u => unitName[u] || u).join(' / '),
              exec_code: e.exec_code,
              supply_cur: e.supply_cur, supply_prev: e.supply_prev,
              agent_cur: e.supply_cur - e.cash_cur, cash_cur: e.cash_cur,
              collection: e.collection, billed: e.collection + e.os,
              txn: e.txn, agencies_paid: e.agencies_paid,
              os: e.os, os_agencies: e.os_agencies, critical: e.critical,
              visits: e.visits, agencies_visited: e.agencies_visited, book: e.agencies, execs: 1,
            });
            execRow.is_active = e.is_active;
            execRow.supply.agent_prev = e.supply_prev - e.cash_prev;
            execRow.supply.cash_prev = e.cash_prev;
            execRow.supply.agent_growth_pct = r1(pct(execRow.supply.agent, execRow.supply.agent_prev));
            execRow.supply.cash_growth_pct = r1(pct(execRow.supply.cash, execRow.supply.cash_prev));
            execRow.is_ci = e.cash_cur > 0 && e.supply_cur - e.cash_cur === 0;
            execRow.hawker_centres = e.hawker_centres;
            execRow.hawker_count = e.hawker_count;
            execRow.hawker_cent_name = e.hawker_cent_name || null;
            return execRow;
          }).filter(r => r.supply.current || r.outstanding.amount || r.dcr.book)
            .sort((a, x) => x.supply.current - a.supply.current);

      const executives = Object.values(E).map(e => {
        const h = hier.rows.find(x => x.exec_code === e.exec_code) || {};
        const us = [...e.units];
        return {
          exec_code: e.exec_code, exec_name: e.exec_name, designation: h.desig || null,
          is_active: e.is_active,
          unit_code: us[0] || null,
          unit_name: us.map(u => unitName[u] || u).join(' / '),
          edtn_incharge: h.edtn || null, circ_incharge: h.circ || null, zonal_head: h.zonal || null,
          agencies: e.agencies, supply: e.supply_cur, supply_prev: e.supply_prev,
          agent_supply: e.supply_cur - e.cash_cur, cash_supply: e.cash_cur,
          growth_pct: r1(pct(e.supply_cur, e.supply_prev)),
          collection: e.collection, outstanding: e.os,
          collection_pct: e.os + e.collection ? r1((e.collection / (e.os + e.collection)) * 100) : null,
          visits: e.visits, agencies_visited: e.agencies_visited,
          coverage_pct: e.agencies ? r1((e.agencies_visited / e.agencies) * 100) : null,
        };
      }).filter(e => e.agencies > 0 || e.supply > 0 || e.outstanding > 0)
        .sort((a, b) => b.supply - a.supply);

      const sum = f => branches.reduce((a, b) => a + f(b), 0);
      /* Totals come from the per-BRANCH aggregates, never from the group rows. At branch
         level the rows are executives, whose "billed" is a stand-in (dues + receipts)
         because billing has no executive dimension — summing those would have made the
         branch's collection card read 6.4% of ₹4.99 Cr instead of the real 44.4% of
         ₹72.56 L. Supply, outstanding and DCR would double-count the same way wherever an
         agency's exec differs between master and the outstanding snapshot. */
      const bsum = f => codes.reduce((a, c) => a + f(B[c]), 0);
      const supCur = bsum(b => b.agent_cur + b.cash_cur), supPrev = bsum(b => b.agent_prev + b.cash_prev);
      const agentCur = bsum(b => b.agent_cur), agentPrev = bsum(b => b.agent_prev);
      const cashCur = bsum(b => b.cash_cur), cashPrev = bsum(b => b.cash_prev);
      const collected = bsum(b => b.collection), billed = bsum(b => b.billed);
      const osTot = bsum(b => b.os);
      const bookTot = bsum(b => b.book), seenTot = bsum(b => b.agencies_visited);

      res.json({
        state: stateKey, state_name: meta.name,
        level: isBranch ? 'branch' : 'state',
        unit_code: isBranch ? unitScope : null,
        unit_name: isBranch ? (unitName[unitScope] || unitScope) : null,
        group_by: groupBy, group_label: groupBy === 'unit' ? 'Branch' : 'Executive',
        os_code: meta.os,
        as_on: asOn, previous: prev, compare: mode, compare_label: label,
        range: win.key, range_label: win.label, range_from: win.from, range_to: win.to,
        prev_month_label: prevMonthLabel,
        totals: {
          supply: { current: supCur, previous: supPrev, growth_pct: r1(pct(supCur, supPrev)),
                    agent: agentCur, cash: cashCur },
          // Agent (credit) and cash (city) sale are separate businesses and are reported
          // as such, each with its own movement, rather than folded into one supply line.
          agent: { current: agentCur, previous: agentPrev, growth_pct: r1(pct(agentCur, agentPrev)),
                   share_pct: supCur ? r1((agentCur / supCur) * 100) : null },
          cash:  { current: cashCur, previous: cashPrev, growth_pct: r1(pct(cashCur, cashPrev)),
                   share_pct: supCur ? r1((cashCur / supCur) * 100) : null,
                   centres: codes.filter(c => B[c].cash_cur > 0).length },
          collection: { collected, billed, pct: billed ? r1((collected / billed) * 100) : null,
                        gap: Math.max(0, billed - collected), txn: bsum(b => b.txn),
                        agencies_paid: bsum(b => b.agencies_paid) },
          outstanding: { amount: osTot, agencies: bsum(b => b.os_agencies),
                         critical: bsum(b => b.critical) },
          dcr: { visits: bsum(b => b.visits), agencies_visited: seenTot, book: bookTot,
                 execs: bsum(b => b.execs.size), coverage_pct: bookTot ? r1((seenTot / bookTot) * 100) : null },
        },
        branches, executives,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  /* ── Centre Incharge (CI) hawker panel ──────────────────────────────────────
     CIs don't appear in agency_master so the exec-perf endpoint returns zeros.
     This endpoint reads hawker_supply directly for the correct figures. */
  app.get('/api/command/ci-panel', async (req, res) => {
    try {
      const execCode = String(req.query.exec_code || '').trim();
      if (!execCode) return res.status(400).json({ detail: 'exec_code required' });
      const unitCode = String(req.query.unit_code || '').trim();

      const { asOn, prev } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range || 'mtd');

      const today = asOn;
      const ucWhere = unitCode ? ' AND loc_id = ?' : '';
      const ucP    = unitCode ? [unitCode] : [];
      const ucWhereCa = unitCode ? ' AND unit_code = ?' : '';
      const ucPCa    = unitCode ? [unitCode] : [];

      const [hawker, attnSummary, attnRows, receipt, survey] = await Promise.all([
        q(`SELECT loc_id unit_code, MAX(center_incharge_name) exec_name,
                  SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) cur,
                  SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) prv,
                  COUNT(DISTINCT CASE WHEN supply_date = ? THEN hwk_cent_code END) centres,
                  COUNT(DISTINCT CASE WHEN supply_date = ? THEN hawker_id END) hawkers,
                  MAX(CASE WHEN supply_date = ? THEN COALESCE(hawker_center, hwk_cent_code) END) center_name,
                  MAX(CASE WHEN supply_date = ? THEN hwk_cent_code END) cent_code
           FROM hawker_supply
           WHERE center_incharge = ?${ucWhere}
             AND supply_date IN (?, ?)
           GROUP BY loc_id`,
          [asOn, prev, asOn, asOn, asOn, asOn, execCode, ...ucP, asOn, prev]),

        // Center attendance summary: attn_type A=attendance, V=visit
        q(`SELECT
             COUNT(*) total,
             COUNT(DISTINCT attn_date) active_days,
             SUM(CASE WHEN attn_type = 'A' OR attn_type IS NULL OR attn_type = '' THEN 1 ELSE 0 END) attendance_days,
             SUM(CASE WHEN attn_type = 'V' THEN 1 ELSE 0 END) visit_count
           FROM dcr_center_attendance
           WHERE emp_code = ? AND attn_date BETWEEN ? AND ?${ucWhereCa}`,
          [execCode, win.from, win.to, ...ucPCa]),

        // Recent attendance/visit rows with remarks (limit 15)
        q(`SELECT attn_date, attn_type, center_name, location_name, present_rmrk, closed_rmrk,
                  TIME(created_dt) attn_time, center_closed
           FROM dcr_center_attendance
           WHERE emp_code = ? AND attn_date BETWEEN ? AND ?${ucWhereCa}
           ORDER BY attn_date DESC, created_dt DESC
           LIMIT 15`,
          [execCode, win.from, win.to, ...ucPCa]),

        // Last hawker supply receipt entry time today
        q(`SELECT MAX(creation_date) last_entry, COUNT(*) txn_count
           FROM hawker_supply
           WHERE center_incharge = ? AND supply_date = ?${ucWhere}`,
          [execCode, today, ...ucP]),

        // Survey & orders this month for hawkers under this CI's centres
        q(`SELECT COUNT(DISTINCT sd.r_id) survey_count,
                  COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.r_id END) order_count
           FROM survey_data sd
           WHERE sd.agcd IN (
             SELECT DISTINCT hawker_id FROM hawker_supply
             WHERE center_incharge = ?${ucWhere} AND supply_date >= ?
           ) AND sd.bookdate BETWEEN ? AND ?`,
          [execCode, ...ucP, win.from, win.from, win.to]),
      ]);

      const h = hawker.rows[0] || {};
      const rc = receipt.rows[0] || {};
      const as = attnSummary.rows[0] || {};
      const sv = survey.rows[0] || {};
      const cur = N(h.cur), prv = N(h.prv);
      const lastEntry = rc.last_entry ? String(rc.last_entry).slice(0, 19) : null;

      const recentAttn = attnRows.rows.map(r => ({
        date: r.attn_date ? String(r.attn_date).slice(0, 10) : null,
        type: r.attn_type || 'A',
        time: r.attn_time ? String(r.attn_time).slice(0, 5) : null,
        center_name: r.center_name || null,
        location: r.location_name || null,
        remark: r.present_rmrk || r.closed_rmrk || null,
        closed: r.center_closed ? String(r.center_closed).slice(0, 16) : null,
      }));

      res.json({
        exec_code: execCode,
        exec_name: h.exec_name || execCode,
        unit_code: h.unit_code || unitCode,
        as_on: asOn,
        supply_cur: cur, supply_prev: prv,
        growth_pct: r1(pct(cur, prv)),
        centres: N(h.centres), hawkers: N(h.hawkers),
        center_name: h.center_name || null,
        cent_code: h.cent_code || null,
        collection_pct: 100,
        last_entry_today: lastEntry,
        txn_count_today: N(rc.txn_count),
        // Attendance from dcr_center_attendance (correct table for CIs)
        attendance_days: N(as.attendance_days),
        visit_count: N(as.visit_count),
        active_days: N(as.active_days),
        recent_attn: recentAttn,
        // Survey + orders (hawkers under CI's centres this month)
        survey_count: N(sv.survey_count),
        order_count: N(sv.order_count),
        range_label: win.label,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  /* ── Agencies growing and declining fastest ─────────────────────────────────
     Its own endpoint because it is the expensive part: a ~50-day scan of supply_data
     while everything else on the dashboard is two dates and a snapshot. Fetched after
     the first paint so the KPIs and branch tables are not held up by it.

     Day-over-day is the wrong lens: agent supply barely moves between two consecutive
     days (Rajasthan shifted 7 copies), so a day comparison surfaces rounding wobbles
     instead of the agencies actually growing or dying. Movers are the DAILY AVERAGE over
     the selected window against the equal window immediately before — capped at 31 days
     a side so a full-FY range does not become a 300-day scan. The window is returned and
     printed above the table rather than left implied. */
  app.get('/api/command/state-movers', async (req, res) => {
    try {
      const stateKey = String(req.query.state || '').toUpperCase();
      const meta = STATES.find(s => s.key === stateKey);
      if (!meta) return res.status(400).json({ detail: 'Unknown state' });
      const { asOn } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range);
      const allUnits = await unitsOfState(stateKey);
      const unitName = {}; allUnits.forEach(u => { unitName[u.unit_code] = u.unit_name; });
      const unitScope = String(req.query.unit_code || '').trim();
      const units = unitScope ? allUnits.filter(u => u.unit_code === unitScope) : allUnits;
      const codes = units.map(u => u.unit_code);
      if (!codes.length) return res.json({ growing: [], declining: [], growing_total: 0, declining_total: 0 });
      const IN = codes.map(() => '?').join(',');

      const dayMs = 86400000;
      const shift = (iso, n) => new Date(new Date(iso + 'T00:00:00').getTime() + n * dayMs).toISOString().slice(0, 10);
      const rawLen = Math.max(1, Math.round((new Date(win.to + 'T00:00:00') - new Date(win.from + 'T00:00:00')) / dayMs) + 1);
      const mLen = Math.min(31, rawLen);
      const mTo = win.to, mFrom = shift(mTo, -(mLen - 1));
      const mPrevTo = shift(mFrom, -1), mPrevFrom = shift(mPrevTo, -(mLen - 1));

      const [mov, master, os] = await Promise.all([
        q(`SELECT s.unit_code, s.agcd,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) cur_sum,
                  COUNT(DISTINCT CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.supply_date END) cur_days,
                  SUM(CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.sup_copy ELSE 0 END) prv_sum,
                  COUNT(DISTINCT CASE WHEN s.supply_date BETWEEN ? AND ? THEN s.supply_date END) prv_days
           FROM supply_data s FORCE INDEX (idx_sd_dateunit)
           WHERE s.supply_date BETWEEN ? AND ? AND s.unit_code IN (${IN})
             AND s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')
           GROUP BY s.unit_code, s.agcd`,
          [mFrom, mTo, mFrom, mTo, mPrevFrom, mPrevTo, mPrevFrom, mPrevTo, mPrevFrom, mTo, ...codes]),
        q(`SELECT unit, agcd, MAX(ag_name) ag_name, MAX(executive_name) exec_name,
                  MAX(executive_code) exec_code, MAX(dist_name) dist_name
           FROM agency_master WHERE unit IN (${IN}) GROUP BY unit, agcd`, codes),
        q(`SELECT unit_code, ag_code, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os
           FROM agency_outstanding WHERE period_label='CURRENT' AND unit_code IN (${IN})
           GROUP BY unit_code, ag_code`, codes),
      ]);
      const M = {}; master.rows.forEach(r => { M[`${r.unit}|${r.agcd}`] = r; });
      const O = {}; os.rows.forEach(r => { O[`${r.unit_code}|${r.ag_code}`] = N(r.os); });

      const movers = mov.rows.map(r => {
        const k = `${r.unit_code}|${r.agcd}`, m = M[k] || {};
        const cur = N(r.cur_days) ? Math.round(N(r.cur_sum) / N(r.cur_days)) : 0;
        const prv = N(r.prv_days) ? Math.round(N(r.prv_sum) / N(r.prv_days)) : 0;
        return {
          unit_code: r.unit_code, unit_name: unitName[r.unit_code] || r.unit_code, agcd: r.agcd,
          ag_name: m.ag_name || r.agcd, dist_name: m.dist_name || null,
          exec: m.exec_name || null, exec_code: m.exec_code || null,
          current: cur, previous: prv, diff: cur - prv, growth_pct: r1(pct(cur, prv)),
          outstanding: O[k] || 0,
        };
      }).filter(m => m.diff !== 0);

      res.json({
        state: stateKey, unit_code: unitScope || null,
        window: { from: mFrom, to: mTo, prev_from: mPrevFrom, prev_to: mPrevTo, days: mLen, capped: mLen < rawLen },
        growing: movers.filter(m => m.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 300),
        declining: movers.filter(m => m.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 300),
        growing_total: movers.filter(m => m.diff > 0).length,
        declining_total: movers.filter(m => m.diff < 0).length,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  /* ── Detail behind one alert / opportunity ──────────────────────────────────
     Fetched only when a card is opened, so the dashboard's first paint stays fast.
     Returns the actual rows responsible for the headline, which is what makes the
     flyout worth opening instead of bouncing the user to another dashboard. */
  app.get('/api/command/alert-detail', async (req, res) => {
    try {
      const kpi = String(req.query.kpi || '').toLowerCase();
      const stateKey = String(req.query.state || '').toUpperCase();
      const asOnQ = await resolveDates(req.query.as_on, req.query.compare);
      const { asOn, prev } = asOnQ;
      const osCode = { 'RAJASTHAN': 'RPPL', 'MADHYA PRADESH': 'MP', 'CHHATTISGARH': 'CG' }[stateKey] || 'NATIONAL';
      const isNat = stateKey === 'NATIONAL';
      const coreList = ['RAJASTHAN', 'MADHYA PRADESH', 'CHHATTISGARH'];

      if (kpi === 'supply') {
        // Which branches lost the copies — the first question after "supply is down".
        const stCl = isNat ? `COALESCE(NULLIF(s.state_name,''),'OTHER') NOT IN (?,?,?)` : `s.state_name = ?`;
        const stP  = isNat ? coreList : [stateKey];
        const { rows } = await q(
          `SELECT s.unit_code, MAX(s.unit_name) unit_name,
                  SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) cur,
                  SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) prv
           FROM supply_data s
           JOIN (SELECT DISTINCT unit, agcd FROM agency_master
                 WHERE ag_class_name='CREDIT SALE' AND COALESCE(supply_stop_flag,'N')='N'
                   AND (suspend_date IS NULL OR suspend_date > CURDATE())) cm
             ON cm.unit = s.unit_code AND cm.agcd = s.agcd
           WHERE s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')
             AND s.supply_date IN (?, ?) AND ${stCl}
           GROUP BY s.unit_code ORDER BY (SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) -
                                          SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END)) ASC LIMIT 12`,
          [asOn, prev, asOn, prev, ...stP, asOn, prev]);
        return res.json({ kpi, state: stateKey, as_on: asOn, previous: prev,
          columns: ['Branch', 'Now', 'Previous', 'Change'],
          rows: rows.map(r => ({ label: r.unit_name || r.unit_code, unit_code: r.unit_code,
            a: N(r.cur), b: N(r.prv), delta: N(r.cur) - N(r.prv) })) });
      }

      if (kpi === 'outstanding' || kpi === 'collection') {
        // Biggest dues in the state — the recovery worklist behind both alerts.
        const { rows } = await q(
          `SELECT ag_code, MAX(ag_name) ag_name, MAX(unit_code) unit_code, MAX(unit_name) unit_name,
                  MAX(exec_name) exec_name, MAX(exec_code) exec_code, SUM(cl_amt) os, SUM(bill_amt) billed
           FROM agency_outstanding
           WHERE period_label='CURRENT' AND group_unit_name = ? AND cl_amt > 0
           GROUP BY ag_code ORDER BY os DESC LIMIT 15`, [osCode]);
        return res.json({ kpi, state: stateKey,
          columns: ['Agency', 'Branch', 'Executive', 'Outstanding'],
          // exec_code is carried so the executive name is clickable, not just readable.
          rows: rows.map(r => ({ label: r.ag_name || r.ag_code, agcd: r.ag_code,
            unit_code: r.unit_code, unit_name: r.unit_name,
            exec: r.exec_name, exec_code: r.exec_code, amount: N(r.os) })) });
      }

      if (kpi === 'dcr') {
        // Branches with the most agencies still unvisited.
        const abbr = { 'RAJASTHAN': ['RJ', 'RAJASTHAN'], 'MADHYA PRADESH': ['MP'], 'CHHATTISGARH': ['CG'] }[stateKey];
        const [book, seen] = await Promise.all([
          q(`SELECT unit, MAX(unit_name) unit_name, COUNT(DISTINCT agcd) agencies
             FROM agency_master
             WHERE CAST(dpcd AS UNSIGNED)=1 AND COALESCE(supply_stop_flag,'N')='N'
               AND (suspend_date IS NULL OR suspend_date > CURDATE())
               ${abbr ? `AND unit_state_nm IN (${abbr.map(() => '?').join(',')})` : `AND COALESCE(unit_state_nm,'') NOT IN ('RJ','RAJASTHAN','MP','CG')`}
             GROUP BY unit`, abbr || []),
          q(`SELECT unit_code, COUNT(DISTINCT visit_to_main_code) visited
             FROM dcr_agency_visit WHERE mark_attn_date BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND ?
             GROUP BY unit_code`, [asOn, asOn]),
        ]);
        const seenMap = {}; seen.rows.forEach(r => { seenMap[r.unit_code] = N(r.visited); });
        const rows = book.rows.map(r => ({
          label: r.unit_name || r.unit, unit_code: r.unit,
          a: seenMap[r.unit] || 0, b: N(r.agencies), delta: (seenMap[r.unit] || 0) - N(r.agencies),
        })).sort((x, y) => (x.a / (x.b || 1)) - (y.a / (y.b || 1))).slice(0, 12);
        return res.json({ kpi, state: stateKey, columns: ['Branch', 'Visited (30d)', 'Agencies', 'Uncovered'], rows });
      }

      res.json({ kpi, state: stateKey, columns: [], rows: [] });
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
    return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
  }

  /* The two panels sit side by side, so a 9-vs-2 split reads as a broken layout rather
     than as a finding. Cap both at CARDS and, when both actually have something to say,
     level them to the shorter list. If one side is genuinely empty — nothing is wrong,
     or nothing is on offer — the other keeps its full list rather than being blanked. */
  const CARDS = 8;
  function balance(alerts, opps) {
    let a = alerts.slice(0, CARDS), o = opps.slice(0, CARDS);
    if (a.length && o.length) {
      const n = Math.min(a.length, o.length);
      a = a.slice(0, n); o = o.slice(0, n);
    }
    return { alerts: a, opportunities: o };
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
      // "only region growing" is a claim, not a phrase — check it before making it.
      const growers = withSupply.filter(s => (s.supply.growth_pct ?? 0) > 0).length;
      const sole = growers === 1;
      out.push({
        priority: 'low', state: best.key, state_name: best.name, type: 'Replicate what works',
        title: sole
          ? `${best.name} is the only region growing (+${best.supply.growth_pct}%)`
          : `${best.name} is the fastest growing region (+${best.supply.growth_pct}%)`,
        impact: `${cp(best.supply.diff)} copies added${sole ? ' while others declined' : `, ahead of the other ${withSupply.length - 1} regions`} — its branch practice is worth copying.`,
        action: 'Study its top branches and apply the same push elsewhere.',
        drill: { screen: 'supply_dash', state: best.key },
      });
    }

    /* The rules above only fire on specific shapes (credit outrunning volume, a 60-90%
       collection band, coverage already past 2%). In a month where none of them hit, the
       panel would come up empty beside eight alerts — so these three read the same
       numbers from the positive side. They are the standing opportunities, not filler:
       dues actually coming down, volume actually rising, and the concentration of dues in
       a small set of agencies, which is what makes a recovery drive worth running. */
    states.forEach(s => {
      if (s.os.growth_pct != null && s.os.growth_pct < 0 && s.os.diff < 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Working capital released',
          title: `${s.name}: outstanding down ${Math.abs(s.os.growth_pct)}%`,
          impact: `${inr(Math.abs(s.os.diff))} recovered since ${s.os.prev_label}, bringing dues to ${inr(s.os.current)}.`,
          action: 'Hold the recovery discipline that produced this and extend it to the remaining critical agencies.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
      if (s.supply.growth_pct != null && s.supply.growth_pct > 0 && s.supply.diff > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Volume momentum',
          title: `${s.name}: supply up ${s.supply.growth_pct}%`,
          impact: `${cp(s.supply.diff)} copies added per day — ${cp(s.supply.diff * 30)} a month if it holds.`,
          action: 'Find the branches driving it and set the same push as the target elsewhere.',
          drill: { screen: 'supply_dash', state: s.key },
        });
      }
      if (s.os.critical_agencies > 0 && s.os.agencies > 0 && s.os.current > 0) {
        const share = r1((s.os.critical_agencies / s.os.agencies) * 100);
        out.push({
          priority: 'low', state: s.key, state_name: s.name, type: 'Concentrated recovery',
          title: `${s.name}: ${cp(s.os.critical_agencies)} agencies carry most of ${inr(s.os.current)}`,
          impact: `Just ${share}% of the state's ${cp(s.os.agencies)} billed agencies are above ₹1 L — a short, targeted drive reaches the bulk of the dues.`,
          action: 'Work the ₹1 L+ list branch by branch instead of a broad reminder run.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
    });

    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
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
