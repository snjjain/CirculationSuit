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

module.exports = function installCommandCentre({ app, q, getScopeUnitCodes }) {
  /* The caller's own rights, as a hard ceiling on every figure this file returns.
     null means unrestricted (level 1 / admin); an array is the exact set of units.

     An empty array means "entitled to nothing" and must NOT be read as "no filter" —
     that inversion is how a scoping bug turns into a data leak. uFilter() below returns
     no clause for an empty list, so callers intersect first and refuse the request when
     the intersection is empty, rather than letting it widen. */
  async function callerScope(req) {
    if (!getScopeUnitCodes || !req.auth) return null;
    try { return await getScopeUnitCodes(req.auth.personCode, req.auth.hierarchyLevel); }
    catch (_) { return []; }          // fail closed
  }

  /* The units this request may actually read: what was asked for, narrowed to what the
     caller is entitled to. Returns null for unrestricted, [] when the caller asked for
     something outside their rights. */
  function narrow(requested, scope) {
    const req_ = Array.isArray(requested) ? requested.filter(Boolean)
               : (requested ? [String(requested)] : []);
    if (scope == null) return req_.length ? req_ : null;   // admin
    const allowed = new Set(scope);
    return req_.length ? req_.filter(u => allowed.has(u)) : scope.slice();
  }

  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

  /* ── Response cache for the expensive dashboard reads ────────────────────────
     These endpoints aggregate months of supply and collection; the underlying
     tables only change when the nightly Oracle sync runs, so recomputing them for
     every range toggle is pure waste. A short TTL keeps the dashboard feeling
     instant when a user flips between ranges or several people open the same state,
     while still picking up a mid-day re-sync within a couple of minutes.

     The key includes the caller's scope — these responses are branch-scoped, so
     caching on the URL alone would serve one user's branches to another. */
  const CACHE_TTL_MS = 120000;
  const _respCache = new Map();
  const _respInflight = new Map();

  function cacheFor(ttlMs) {
    return (req, res, next) => {
      const a = req.auth || {};
      const key = `${req.path}?${new URLSearchParams(req.query)}|${a.personCode || ''}|${a.hierarchyLevel || ''}|${a.isAdmin ? 1 : 0}`;

      const hit = _respCache.get(key);
      if (hit && Date.now() - hit.ts < ttlMs) {
        res.set('X-Cache', 'HIT');
        return res.json(hit.body);
      }
      // Two people opening the same screen at once should cost one database round,
      // not two — the second waits on the first instead of starting its own.
      const inflight = _respInflight.get(key);
      if (inflight) {
        res.set('X-Cache', 'COALESCED');
        return inflight.then(body => res.json(body), () => next());
      }

      let settle;
      _respInflight.set(key, new Promise(r => { settle = r; }));
      const done = body => { _respInflight.delete(key); if (settle) settle(body); };

      const origJson = res.json.bind(res);
      res.json = body => {
        if (res.statusCode === 200) _respCache.set(key, { ts: Date.now(), body });
        done(body);
        res.set('X-Cache', 'MISS');
        return origJson(body);
      };
      res.on('close', () => { if (_respInflight.has(key)) done(null); });
      next();
    };
  }

  // Bounded so a long-lived process cannot grow the cache without limit.
  setInterval(() => {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of _respCache) if (v.ts < cutoff) _respCache.delete(k);
  }, CACHE_TTL_MS).unref?.();
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  const pct = (cur, prev) => (!prev ? null : ((cur - prev) / Math.abs(prev)) * 100);

  /* Unit filter that takes either a single unit code (a drill-down) or a list (the
     caller's own rights). Both narrow the same way, and a list of one behaves exactly
     like the old string, so every call site keeps its meaning.

     Command Centre was mounted without getScopeUnitCodes at all, so nothing here
     narrowed by who was asking: a VP of Rajasthan, a zonal head, an edition incharge —
     every one of them saw all-India figures. */
  const uFilter = (col, scope) => {
    const list = Array.isArray(scope) ? scope.filter(Boolean) : (scope ? [scope] : []);
    if (!list.length) return { cl: '', p: [] };
    return { cl: ` AND ${col} IN (${list.map(() => '?').join(',')})`, p: list };
  };

  const STATES = [
    { key: 'RAJASTHAN',      name: 'Rajasthan',      os: 'RPPL',     abbr: 'RJ' },
    { key: 'MADHYA PRADESH', name: 'Madhya Pradesh', os: 'MP',       abbr: 'MP' },
    { key: 'CHHATTISGARH',   name: 'Chhattisgarh',   os: 'CG',       abbr: 'CG' },
    { key: 'NATIONAL',       name: 'National',       os: 'NATIONAL', abbr: null },
  ];
  const CORE = new Set(['RAJASTHAN', 'MADHYA PRADESH', 'CHHATTISGARH']);

  /* Branches that no longer operate. They still carry agencies and historical dues in
     agency_master, so they keep turning up as rows with stale or zero figures. Listed
     out of the branch list and blocked from drill-down; their numbers still roll into
     state totals, because the outstanding they left behind is real money owed. */
  const CLOSED_UNITS = new Set([
    'DA0', // JAIPUR DN
    'GA0', // GANGAPUR CITY
    'RA2', // RAJGARH RP
  ]);
  const bucketOf = s => { const u = String(s || '').trim().toUpperCase(); return CORE.has(u) ? u : 'NATIONAL'; };
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
  /* exec_hierarchy_mapping carries a few names in the raw ERP export form
     ("RAKESH Garhwal~~106~~106"), and a few placeholder values. One cleaner so every
     hierarchy name on the dashboard is filtered the same way. */
  const cleanName = s => {
    const t = String(s || '').split('~')[0].trim();
    return t && !/^(n\/a|not applicable|none|null)$/i.test(t) ? t : null;
  };

  /* unit -> its circulation incharges, one per line of business. A branch can carry two
     different people and they are not interchangeable: executives (exec_desig 'EXEC') sell
     through agencies, so their incharge owns agent/credit sale; centre incharges
     (exec_desig 'CI') run the city centres, so theirs owns cash sale. JA0 is the clear
     case — Neeraj Jain over 22 executives, Narendra Sharma over 101 centre incharges.
     Most branches have the same person in both roles; branches with no city sale have no
     'CI' rows at all. Within a role, the name most of that role reports to wins. */
  function unitCircIncharge() {
    return memo('unitCirc', async () => {
      const { rows } = await q(
        `SELECT m.unit_code, m.exec_desig, m.circ_incharge_name nm, COUNT(*) c
         FROM exec_hierarchy_mapping m
         INNER JOIN exec_master em ON em.unit_code = m.unit_code AND em.executive_code = m.exec_code AND em.is_active_pli = 'Y'
         WHERE m.circ_incharge_name IS NOT NULL AND m.circ_incharge_name <> ''
           AND m.exec_desig IN ('EXEC','CI')
         GROUP BY m.unit_code, m.exec_desig, m.circ_incharge_name`);
      const tally = {}; // unit -> role -> name -> count
      rows.forEach(r => {
        const nm = cleanName(r.nm); if (!nm) return;
        const role = r.exec_desig === 'CI' ? 'cash' : 'agent';
        const u = tally[r.unit_code] = (tally[r.unit_code] || { agent: {}, cash: {} });
        u[role][nm] = (u[role][nm] || 0) + N(r.c);
      });
      const top = m => { const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return e ? e[0] : null; };
      const out = {};
      Object.keys(tally).forEach(u => {
        out[u] = { agent: top(tally[u].agent), cash: top(tally[u].cash) };
      });
      return out;
    });
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
    let prev, label;
    if (mode === 'prev_day') {
      const { rows: pv } = await q(`SELECT MAX(supply_date) d FROM supply_data WHERE supply_date < ?`, [asOn]);
      prev = pv[0]?.d ? String(pv[0].d).slice(0, 10) : asOn;
      label = 'Previous Day';
    } else if (mode === 'prev_week') {
      const { rows: pv } = await q(`SELECT MAX(supply_date) d FROM supply_data WHERE supply_date <= DATE_SUB(?, INTERVAL 7 DAY)`, [asOn]);
      prev = pv[0]?.d ? String(pv[0].d).slice(0, 10) : asOn;
      label = 'Previous Week';
    } else if (mode === 'prev_month') {
      const { rows: pv } = await q(`SELECT MAX(supply_date) d FROM supply_data WHERE supply_date <= DATE_SUB(?, INTERVAL 30 DAY)`, [asOn]);
      prev = pv[0]?.d ? String(pv[0].d).slice(0, 10) : asOn;
      label = 'Previous Month';
    } else {
      // prev_year (default) — same date last year, nearest date with supply data
      const lyDate = `${Number(asOn.slice(0, 4)) - 1}${asOn.slice(4)}`;
      const { rows: pv } = await q(`SELECT MAX(supply_date) d FROM supply_data WHERE supply_date <= ?`, [lyDate]);
      prev = pv[0]?.d ? String(pv[0].d).slice(0, 10) : lyDate;
      label = 'Previous Year';
    }
    return { asOn, prev, label, mode: mode || 'prev_year' };
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
      case 'last_3m': {
        const s = new Date(d.getTime() - 89 * 86400000);
        return { from: s.toISOString().slice(0, 10), to: asOn, label: 'Last 3 Months', key: 'last_3m' };
      }
      case 'last_6m': {
        const s = new Date(d.getTime() - 179 * 86400000);
        return { from: s.toISOString().slice(0, 10), to: asOn, label: 'Last 6 Months', key: 'last_6m' };
      }
      case 'covid':
        return { from: '2020-03-18', to: '2020-03-18', label: 'COVID Period (18 Mar 2020)', key: 'covid' };
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
    const _uf = uFilter('unit_code', unitScope);
    const uC = _uf.cl, uP = _uf.p;

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
    // A list scope must key distinctly, or one caller's slice is served to another.
    const key = `${asOn}|${Array.isArray(unitScope) ? unitScope.join(',') : (unitScope || '')}`;
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
      const _scope = await callerScope(req);
      const _asked = String(req.query.unit_code || '').trim() || null;
      const unitScope = narrow(_asked, _scope);
      if (Array.isArray(unitScope) && !unitScope.length) return res.status(403).json({ detail: 'Outside your branch scope' });
      res.json(await quarterlyCached(asOn, unitScope));
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // Collection receipts + field visits over an arbitrary window, all-India.
  async function rangeTotals(win, unitScope) {
    const _uf = uFilter('unit_code', unitScope);
    const uC = _uf.cl, uD = _uf.cl, uP = _uf.p;
    const [coll, visits, any] = await Promise.all([
      q(`SELECT -COALESCE(SUM(amount),0) amt, COUNT(*) txn, COUNT(DISTINCT ag_code) agencies
         FROM agency_collection WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uC}`, [win.from, win.to, ...uP]),
      q(`SELECT COUNT(*) visits, COUNT(DISTINCT visit_to_main_code) agencies, COUNT(DISTINCT emp_code) execs
         FROM dcr_agency_visit WHERE mark_attn_date BETWEEN ? AND ?${uD}`, [win.from, win.to, ...uP]),
      /* Whether the DCR feed holds anything at all for this window, nationally and
         regardless of scope. Field reporting only began during 2026, so a comparison
         against last year returns zero visits — which is a gap in the record, not a
         month when nobody went out. Without this the card reported "was 0 agencies
         visited" and read as a total collapse in field activity. */
      q(`SELECT COUNT(*) n FROM dcr_agency_visit WHERE mark_attn_date BETWEEN ? AND ?`,
        [win.from, win.to]),
    ]);
    return {
      collection: N(coll.rows[0]?.amt), txn: N(coll.rows[0]?.txn), agencies_paid: N(coll.rows[0]?.agencies),
      visits: N(visits.rows[0]?.visits), agencies_visited: N(visits.rows[0]?.agencies), execs_active: N(visits.rows[0]?.execs),
      dcr_has_data: N(any.rows[0]?.n) > 0,
    };
  }

  // ── Supply: Agent (credit sale) + Cash (hawker), both sides state-bucketed ──
  /* Supply for the selected window vs the comparison window, as copies per day.

     This used to read two single dates and ignore the range entirely, so on the
     Command Centre picking Last 3 Months or COVID moved Collection and Coverage while
     Supply sat on today's count — the range appeared to do nothing. It now averages
     over each window: a one-day window (Today, COVID) still yields that day's copies,
     so short ranges read exactly as before.

     Divided by the days in the WINDOW, not the days each state happened to supply, for
     the same reason as the branch dashboard — a per-group divisor lets an irregular
     supplier's short-window rate stand in for a whole month. */
  async function supplyByState(win, prevWin, unitScope) {
    /* Only the hawker feed is trimmed. Agent supply is dispatched and recorded in the
       morning, so the current day is already complete — on 3 September it read
       1,701,288 against a 1,700,110 average for the two days before it. Cash is keyed
       through the day: the same date held 541,970 copies at 06:04 and 597,616 by
       midday. Trimming both moved the agent figure away from the ERP for no reason. */
    const cashWin = trimPartialDay(win);
    const _uf = uFilter('s.unit_code', unitScope);
    const uCl = _uf.cl, uP = _uf.p;
    const hCl = uFilter('h.loc_id', unitScope).cl;
    /* Bucketed by the UNIT's home state, not the agency's own state_name.
       An agency across a state border is still supplied by that unit and belongs to
       that unit's state — management's words: the agency's state does not matter, it
       receives its copies from that unit. Tagging by agency put 780 copies a day of
       Rajasthan supply under Haryana, Punjab and MP, and split a branch's figures
       across state cards that no one manages. Cash supply already bucketed this way;
       agent did not, so the two halves of the same branch disagreed. */
    /* Kept per unit AND per date, because the divisor has to be counted per STATE and a
       state's publishing days are the union of its units' days, which cannot be
       recovered from per-unit day counts. ~35 units x the window's days, so a month is
       about a thousand rows off the covering index. */
    /* Agent copies are the CREDIT SALE agencies' own copies, counted agency by agency —
       the same test the branch drill-down applies. They used to be estimated instead:
       the credit share of one day's supply, applied across the whole window. The mix
       does move slowly, but "slowly" is not "not at all", and the estimate landed 465
       copies a day away from the exact figure on the Rajasthan card while the drill-down
       below it showed the exact one. A LEFT JOIN keeps both numbers in a single pass, so
       every date with any supply still counts toward the divisor even when no credit
       agency lifted that day. */
    const agentSql =
      `SELECT s.unit_code unit, s.supply_date d,
              SUM(CASE WHEN cm.agcd IS NOT NULL THEN s.sup_copy ELSE 0 END) tot
       FROM supply_data s FORCE INDEX (idx_sd_cover_range)
       LEFT JOIN (SELECT DISTINCT unit, agcd FROM agency_master
                   WHERE ag_class_name = 'CREDIT SALE') cm
              ON cm.unit = s.unit_code AND cm.agcd = s.agcd
       WHERE s.supply_date BETWEEN ? AND ?
         AND s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN ('P14')${uCl}
       GROUP BY s.unit_code, s.supply_date`;
    const hawkSql =
      `SELECT h.loc_id unit, h.supply_date d, SUM(h.sup_copies) tot
       FROM hawker_supply h FORCE INDEX (idx_hs_cover_range)
       WHERE h.supply_date BETWEEN ? AND ?${hCl}
       GROUP BY h.loc_id, h.supply_date`;

    const [agentC, agentP, cashC, cashP, uhs] = await Promise.all([
      q(agentSql, [win.from, win.to, ...uP]),
      q(agentSql, [prevWin.from, prevWin.to, ...uP]),
      q(hawkSql,  [cashWin.from, cashWin.to, ...uP]),
      q(hawkSql,  [prevWin.from, prevWin.to, ...uP]),
      unitHomeState(),
    ]);
    const home = uhs;

    /* ONE divisor per state — the same rule the branch drill-down already uses.

       This used to average each unit over its OWN publishing days and then add those
       averages up. That is not the state's average daily supply: on 16 August most
       units did not publish, so a 30-day unit was divided by 30 while the state's
       window ran 31 days, and every such unit came out proportionally too high. The
       Rajasthan card read 11,23,651 against the drill-down's 11,07,269 for the same
       month — 16,382 copies a day of pure arithmetic, and the two screens showing the
       same state disagreed. Summing group averages only equals total/days when every
       group shares the divisor.

       Closed branches are dropped here too. The drill-down already excludes them, so
       leaving them in nationally would reintroduce the same disagreement the moment a
       range reaches back to when they still supplied. */
    /* Rounded once per BRANCH and then added, which is what the drill-down does, so a
       state card and the branch list under it are the same arithmetic and not merely
       close. Rounding per branch is safe now only because the divisor is shared; it was
       the divisor, not the rounding, that put the two screens 16,382 copies apart. */
    const roll = rows => {
      const byUnit = {}, days = {};
      rows.forEach(r => {
        if (CLOSED_UNITS.has(r.unit)) return;
        const st = bucketOf(home[r.unit]?.st);
        (byUnit[st] || (byUnit[st] = {}));
        byUnit[st][r.unit] = (byUnit[st][r.unit] || 0) + N(r.tot);
        (days[st] || (days[st] = new Set())).add(String(r.d));
      });
      const out = blank();
      Object.keys(out).forEach(st => {
        const n = days[st] ? days[st].size : 0;
        out[st] = (n > 0 && byUnit[st])
          ? Object.values(byUnit[st]).reduce((a, t) => a + Math.round(t / n), 0)
          : 0;
      });
      return out;
    };

    const agentCur  = roll(agentC.rows);
    const agentPrev = roll(agentP.rows);
    const cashCur   = roll(cashC.rows);
    const cashPrev  = roll(cashP.rows);
    return { agentCur, agentPrev, cashCur, cashPrev };
  }

  // ── Collection: this month vs LAST MONTH'S BILLING (the business question the
  //    doc asks for), plus previous-day receipts and YTD-vs-last-YTD ───────────
  /* Which bill a collection settles: an ERP monthly bill is raised at month end and
     paid over the month that follows, so collections made in month M are answering
     the bill raised for M-1. Every month the selected range touches is therefore
     shifted back one, and those months' bills are what the range is measured against.

     Each month resolves independently: BILL-YYYY-MM is the ERP's own monthly figure
     and is preferred wherever present; failing that a month is the difference between
     consecutive cumulative snapshots, because agency_outstanding.bill_amt is
     cumulative for the FY and taking it raw overstates billing several-fold. A month
     with neither is skipped and counted, so a partial answer is never passed off as
     a whole one. */
  /* A day still being keyed is not a day.

     Supply is reported as copies per day, so a window ending on today divides a partial
     day's copies by a whole day and pulls the average down. On 3 September the morning
     sync held 4,627 hawker rows at 06:04 and 5,049 by midday; that missing tenth showed
     as Rajasthan cash of 5.77 L against the ERP's 5.95 L, and the figure would have
     climbed on its own during the afternoon with nothing on screen to explain why.

     Averages therefore end at yesterday. Sums are left alone — a part-day of collection
     is genuinely what has been collected so far, and hiding it would be the lie.

     "Today" asked for on its own is honoured as asked; trimming it would leave nothing.
     Server-local time is used because the rest of this file already builds its windows
     that way. */
  const trimPartialDay = win => {
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const cur = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (win.to !== cur || win.from === cur) return win;
    const d = new Date(cur + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    const prev = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return prev < win.from ? win : { ...win, to: prev, partial_day_excluded: cur };
  };

  const _billMonthsFor = win => {
    const pad = n => String(n).padStart(2, '0');
    const lbl = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
    const f = new Date(win.from + 'T00:00:00'), t = new Date(win.to + 'T00:00:00');
    const out = [];
    let cur = new Date(f.getFullYear(), f.getMonth(), 1);
    const end = new Date(t.getFullYear(), t.getMonth(), 1);
    while (cur <= end && out.length < 36) {
      const b = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
      out.push({ label: lbl(b), prev: lbl(new Date(b.getFullYear(), b.getMonth() - 1, 1)) });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return out;
  };

  async function collectionByState(win, asOn, prev, unitScope) {
    const mStart = win.from, mEnd = win.to;
    const d = new Date(asOn + 'T00:00:00');
    const billMonths = _billMonthsFor(win);
    const prevMonthLabel = billMonths.length
      ? (billMonths.length === 1 ? billMonths[0].label
         : `${billMonths[0].label}…${billMonths[billMonths.length - 1].label}`)
      : null;
    const yStart = asOn.slice(0, 4) + '-01-01';
    const lyStart = (Number(asOn.slice(0, 4)) - 1) + '-01-01';
    const lyAsOn  = (Number(asOn.slice(0, 4)) - 1) + asOn.slice(4);
    const _uf = uFilter('unit_code', unitScope);
    const uCl = _uf.cl, uP = _uf.p;

    const [mtd, prevDay, ytd, lyYtd, billing] = await Promise.all([
      // Keyed by unit, then bucketed by the unit's home state — same rule as supply.
      q(`SELECT unit_code unit, -COALESCE(SUM(amount),0) amt, COUNT(*) txn, COUNT(DISTINCT ag_code) agencies
         FROM agency_collection WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY unit_code`, [mStart, mEnd, ...uP]),
      q(`SELECT unit_code unit, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date = ?${uCl} GROUP BY unit_code`, [prev, ...uP]),
      q(`SELECT unit_code unit, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY unit_code`, [yStart, asOn, ...uP]),
      q(`SELECT unit_code unit, -COALESCE(SUM(amount),0) amt FROM agency_collection
         WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uCl} GROUP BY unit_code`, [lyStart, lyAsOn, ...uP]),
      /* Every label the shifted months could need: the ERP monthly bill, the month's
         own cumulative snapshot, and the one before it to difference against. */
      (() => {
        const need = new Set();
        billMonths.forEach(m => { need.add('BILL-' + m.label); need.add(m.label); need.add(m.prev); });
        const labels = [...need];
        if (!labels.length) return { rows: [] };
        return q(`SELECT period_label, unit_code unit, SUM(bill_amt) amt FROM agency_outstanding
           WHERE period_label IN (${labels.map(() => '?').join(',')})${uFilter('unit_code', unitScope).cl}
           GROUP BY period_label, unit_code`, [...labels, ...uP]);
      })(),
    ]);
    const mk = () => blank();
    const out = { mtd: mk(), prevDay: mk(), ytd: mk(), lyYtd: mk(), billing: mk(), txn: mk(), agencies: mk() };
    // Declared before every use below; a unit's home state keys all of these.
    const homeSt = await unitHomeState();
    const stOf = u => bucketOf(homeSt[u]?.st);
    mtd.rows.forEach(r => { const b = stOf(r.unit); out.mtd[b] += N(r.amt); out.txn[b] += N(r.txn); out.agencies[b] += N(r.agencies); });
    prevDay.rows.forEach(r => { out.prevDay[stOf(r.unit)] += N(r.amt); });
    ytd.rows.forEach(r => { out.ytd[stOf(r.unit)] += N(r.amt); });
    lyYtd.rows.forEach(r => { out.lyYtd[stOf(r.unit)] += N(r.amt); });
    /* Fold the snapshots into per-label, per-state sums, then resolve each shifted
       month on its own and add up what resolved. */
    const byLabel = new Map();                       // label -> {stateKey: amount}
    billing.rows.forEach(r => {
      const b = bucketOf(homeSt[r.unit]?.st);
      if (!byLabel.has(r.period_label)) byLabel.set(r.period_label, blank());
      byLabel.get(r.period_label)[b] += N(r.amt);
    });
    const resolved = [], missing = [];
    let basis = null;
    billMonths.forEach(m => {
      const bill = byLabel.get('BILL-' + m.label), cum = byLabel.get(m.label), cumPrev = byLabel.get(m.prev);
      let pick = null, how = null;
      if (bill) { pick = s => bill[s]; how = 'ERP monthly bill'; }
      else if (cum && cumPrev) { pick = s => Math.max(0, cum[s] - cumPrev[s]); how = 'difference of cumulative snapshots'; }
      else if (cum) { pick = s => cum[s]; how = 'first snapshot of the year'; }
      if (!pick) { missing.push(m.label); return; }
      STATES.forEach(s => { out.billing[s.key] += pick(s.key); });
      resolved.push(m.label); basis = basis || how;
    });
    /* A month whose bill has not been snapshotted yet must not read as zero billing --
       that made a fully-collected month look like a total collection failure. The card
       shows "--" instead, and says which month is not in yet. */
    out.billing_months  = resolved;
    out.billing_missing = missing;
    out.billing_basis   = basis;
    out.has_billing     = resolved.length > 0;
    out.prev_month_label = resolved.length
      ? (resolved.length === 1 ? resolved[0] : `${resolved[0]}…${resolved[resolved.length - 1]}`)
      : prevMonthLabel;
    return out;
  }

  // ── Outstanding: live balance now vs the last month-end snapshot ───────────
  async function osByState(unitScope) {
    const _uf = uFilter('unit_code', unitScope);
    const uCl = _uf.cl, uP = _uf.p;
    const { rows: labels } = await q(
      `SELECT DISTINCT period_label FROM agency_outstanding
       WHERE period_label <> 'CURRENT' AND period_label NOT LIKE 'BILL-%' ORDER BY period_label DESC LIMIT 1`);
    const prevLabel = labels[0]?.period_label || null;
    const [cur, prv] = await Promise.all([
      q(`SELECT unit_code unit, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os,
                SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 AND cl_amt>=100000 THEN 1 ELSE 0 END) critical,
                SUM(CASE WHEN CAST(dp_code AS UNSIGNED)=1 THEN 1 ELSE 0 END) agencies
         FROM agency_outstanding WHERE period_label='CURRENT'${uCl} GROUP BY unit_code`, uP),
      prevLabel
        ? q(`SELECT unit_code unit, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os
             FROM agency_outstanding WHERE period_label=?${uCl} GROUP BY unit_code`, [prevLabel, ...uP])
        : Promise.resolve({ rows: [] }),
    ]);
    const out = { cur: blank(), prev: blank(), critical: blank(), agencies: blank(), prev_label: prevLabel };
    /* Was bucketed on group_unit_name (the ERP's RPPL / MP / CG grouping); now on the
       unit's home state like everything else, so outstanding lands on the same card as
       the supply and collection it belongs to. */
    const homeOs = await unitHomeState();
    const osSt = u => bucketOf(homeOs[u]?.st);
    cur.rows.forEach(r => { const b = osSt(r.unit); out.cur[b] += N(r.os); out.critical[b] += N(r.critical); out.agencies[b] += N(r.agencies); });
    prv.rows.forEach(r => { out.prev[osSt(r.unit)] += N(r.os); });
    return out;
  }

  // ── DCR: agency visits recorded, and how much of the book they cover ───────
  async function dcrByState(asOn, prev, unitScope) {
    const _uf = uFilter('v.unit_code', unitScope);
    const uCl = _uf.cl, uP = _uf.p;
    const monthStart = asOn.slice(0, 7) + '-01';
    // dcr_agency_visit is utf8mb4_unicode_ci while agency_master is
    // utf8mb4_0900_ai_ci, so joining them in SQL throws "Illegal mix of
    // collations". Both sides are fetched keyed by unit and merged in JS instead —
    // the same pattern the rest of the codebase uses for this table pair.
    // Book = agencies that actually received agent (credit) supply this month;
    // this matches the user expectation of "active agencies with supply going".
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
      q(`SELECT am.unit_state_nm st, COUNT(DISTINCT CONCAT(s.unit_code,'|',s.agcd)) agencies
         FROM supply_data s
         JOIN (SELECT DISTINCT unit, agcd, unit_state_nm FROM agency_master
               WHERE CAST(dpcd AS UNSIGNED)=1
                 AND ag_class_name = 'CREDIT SALE'${uFilter('unit', unitScope).cl}) am
           ON am.unit = s.unit_code AND am.agcd = s.agcd
         WHERE s.supply_date BETWEEN ? AND ?
           AND s.sup_type_code = 'S01'
           AND COALESCE(s.publ,'') NOT IN ('P14')
         GROUP BY am.unit_state_nm`, [...uP, monthStart, asOn]),
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
       FROM exec_hierarchy_mapping m
       INNER JOIN exec_master em ON em.unit_code = m.unit_code AND em.executive_code = m.exec_code AND em.is_active_pli = 'Y'
       GROUP BY m.unit_code`);
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

  app.get('/api/command/state-performance', cacheFor(CACHE_TTL_MS), async (req, res) => {
    try {
      /* The national strip is only national for someone entitled to the nation. A VP of
         Rajasthan asking for no particular unit gets their own units, not every unit. */
      const _scope = await callerScope(req);
      const _asked = (req.query.unit_code || '').trim() || null;
      const unitScope = narrow(_asked, _scope);
      if (Array.isArray(unitScope) && !unitScope.length) return res.status(403).json({ detail: 'Outside your branch scope' });
      const { asOn, prev, label, mode } = await resolveDates(req.query.as_on, req.query.compare);
      const _spRqRange = req.query.range, _spFrom = req.query.range_from, _spTo = req.query.range_to;
      const win = (_spRqRange === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(_spFrom || '') && /^\d{4}-\d{2}-\d{2}$/.test(_spTo || ''))
        ? { from: _spFrom, to: _spTo, label: `${_spFrom} → ${_spTo}`, key: 'custom' }
        : resolveRangeWindow(asOn, _spRqRange);
      // The window supplyByState averages CASH over; reported so a card can say so.
      const _supWinNat = trimPartialDay(win);
      /* Same comparison rule as the branch dashboard: default to the window one year
         back, let the caller name one explicitly, and for COVID compare against today —
         "18 Mar 2020 vs 18 Mar 2019" is not a question anyone asks of that range. */
      const _cf = String(req.query.compare_from || '').trim();
      const _ct = String(req.query.compare_to || '').trim();
      const _isD = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const prevWin = (_isD(_cf) && _isD(_ct))
        ? { from: _cf, to: _ct }
        : (win.key === 'covid'
          ? { from: asOn, to: asOn }
          : { from: `${Number(win.from.slice(0, 4)) - 1}${win.from.slice(4)}`,
              to:   `${Number(win.to.slice(0, 4)) - 1}${win.to.slice(4)}` });
      // Supply now covers the selected window, so the KPI caption must say so —
      // a one-day window still reads as a plain date rather than "X → X".
      const winLabel = win.from === win.to ? `on ${win.to}` : `${win.label} · ${win.from} → ${win.to}`;
      const [sup, col, os, dcr, heads, rng, rngPrev] = await Promise.all([
        supplyByState(win, prevWin, unitScope),
        collectionByState(win, asOn, prev, unitScope),
        osByState(unitScope),
        dcrByState(asOn, prev, unitScope),
        stateHeads(),
        rangeTotals(win, unitScope),
        // The same totals over the comparison window, so Collection and Field Coverage
        // can show what they are being measured against instead of a bare percentage.
        rangeTotals(prevWin, unitScope),
      ]);

      const states = STATES.map(s => {
        const k = s.key;
        const supCur = sup.agentCur[k] + sup.cashCur[k], supPrev = sup.agentPrev[k] + sup.cashPrev[k];
        const supPct = pct(supCur, supPrev);
        const osCur = os.cur[k], osPrev = os.prev[k];
        const osPct = pct(osCur, osPrev);
        const billing = col.has_billing ? col.billing[k] : null, mtd = col.mtd[k];
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
            gap: billing == null ? null : billing - mtd, previous_day: col.prevDay[k],
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
      const billTot = col.has_billing ? sum(s => s.collection.prev_month_billing) : null;
      const mtdTot = sum(s => s.collection.current);
      const osTot = sum(s => s.os.current), osPrevTot = sum(s => s.os.previous);
      const bookTot = sum(s => s.dcr.agencies_total);
      const totals = {
        supply:        { value: supTot, prev: supPrevTot, growth_pct: r1(pct(supTot, supPrevTot)), window: winLabel },
        /* Every card that has something to be measured against now carries that figure
           and its own growth, so the strip reads the way the state cards below it do —
           a number, what it was, and which way it moved. */
        agent:         { value: sum(s => s.supply.agent), prev: sum(s => s.supply.agent_previous),
                         growth_pct: r1(pct(sum(s => s.supply.agent), sum(s => s.supply.agent_previous))),
                         share_pct: supTot ? r1(sum(s => s.supply.agent) / supTot * 100) : null, window: winLabel },
        cash:          { value: sum(s => s.supply.cash), prev: sum(s => s.supply.cash_previous),
                         growth_pct: r1(pct(sum(s => s.supply.cash), sum(s => s.supply.cash_previous))),
                         share_pct: supTot ? r1(sum(s => s.supply.cash) / supTot * 100) : null, window: winLabel },
        collection:    { value: rng.collection, prev: rngPrev.collection,
                         growth_pct: r1(pct(rng.collection, rngPrev.collection)),
                         txn: rng.txn, agencies_paid: rng.agencies_paid, window: win.label },
        collection_pct:{ value: billTot > 0 ? r1(mtdTot / billTot * 100) : null, billed: billTot, collected: mtdTot,
                         bill_months: col.billing_months, bill_missing: col.billing_missing,
                         bill_basis: col.billing_basis, coll_label: win.label,
                         window: col.has_billing
                           ? `${win.label} collection vs ${col.prev_month_label} billing`
                           : `${col.billing_missing.join(', ')} billing not snapshotted yet` },
        outstanding:   { value: osTot, prev: osPrevTot, growth_pct: r1(pct(osTot, osPrevTot)), window: `as on today` },
        critical:      { value: sum(s => s.os.critical_agencies), of: sum(s => s.os.agencies), window: 'agencies above ₹1 L' },
        coverage:      { value: rng.agencies_visited, prev: rngPrev.agencies_visited,
                         prev_has_data: rngPrev.dcr_has_data, has_data: rng.dcr_has_data,
                         growth_pct: rngPrev.dcr_has_data ? r1(pct(rng.agencies_visited, rngPrev.agencies_visited)) : null,
                         of: bookTot, visits: rng.visits, prev_visits: rngPrev.visits, execs: rng.execs_active,
                         pct: bookTot ? r1(rng.agencies_visited / bookTot * 100) : null, window: win.label },
      };

      res.json({
        as_on: asOn, previous: prev, compare: mode, compare_label: label,
        range: win.key, range_label: win.label, range_from: win.from, range_to: win.to,
        // Named so a card can say why supply covers one day fewer than the range asked.
        // supplyByState trims the cash side only; this reports the same decision.
        cash_range_to: _supWinNat.to, cash_partial_day_excluded: _supWinNat.partial_day_excluded || null,
        prev_range_from: prevWin.from, prev_range_to: prevWin.to,
        /* True when the comparison window is LATER than the selected one — which is the
           normal case for COVID, compared against today. The growth figure is then not
           growth at all: "COVID 27.2L vs today 16.9L, +63%" reads as a rise when supply
           has in fact fallen 38.6% since. The UI uses this to state the change in time
           order instead of showing a green arrow on a decline. */
        compare_is_later: prevWin.from > win.to,
        unit_code: unitScope, prev_month_label: col.prev_month_label,
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
      .filter(([unit, v]) => bucketOf(v.st) === stateKey && !CLOSED_UNITS.has(unit))
      .map(([unit]) => ({ unit_code: unit, unit_name: nm[unit] || unit }))
      .sort((a, b) => String(a.unit_name).localeCompare(String(b.unit_name)));
  }

  app.get('/api/command/state-dashboard', cacheFor(CACHE_TTL_MS), async (req, res) => {
    try {
      const stateKey = String(req.query.state || '').toUpperCase();
      const meta = STATES.find(s => s.key === stateKey);
      if (!meta) return res.status(400).json({ detail: 'Unknown state' });

      const { asOn, prev, label, mode } = await resolveDates(req.query.as_on, req.query.compare || 'prev_year');
      const rqRange = req.query.range, rqFrom = req.query.range_from, rqTo = req.query.range_to;
      const win = (rqRange === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(rqFrom || '') && /^\d{4}-\d{2}-\d{2}$/.test(rqTo || ''))
        ? { from: rqFrom, to: rqTo, label: `${rqFrom} → ${rqTo}`, key: 'custom' }
        : resolveRangeWindow(asOn, rqRange);
      // Same window shifted one year back — used for YoY supply avg and collection comparison
      /* What the selected window is measured against. The default is the same window a
         year earlier, which is the right question for a normal range. It is the wrong
         question for COVID: "18 Mar 2020 vs 18 Mar 2019" compares two pre-pandemic-ish
         days, when what anyone actually wants is "where are we now against the COVID
         floor". So the caller may name the comparison window explicitly, and for COVID
         the default flips to today rather than a year before 2020. */
      const cmpFrom = String(req.query.compare_from || '').trim();
      const cmpTo   = String(req.query.compare_to || '').trim();
      const isDate  = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const prevWin = (isDate(cmpFrom) && isDate(cmpTo))
        ? { from: cmpFrom, to: cmpTo }
        : (win.key === 'covid'
          ? { from: asOn, to: asOn }
          : { from: `${Number(win.from.slice(0, 4)) - 1}${win.from.slice(4)}`,
              to:   `${Number(win.to.slice(0, 4)) - 1}${win.to.slice(4)}` });
      const allUnits = await unitsOfState(stateKey);
      const unitName = {}; allUnits.forEach(u => { unitName[u.unit_code] = u.unit_name; });

      /* Same screen, two levels. Without unit_code it is the state and the rows are its
         branches; with one it is that branch and the rows are its executives. Cash (city)
         supply carries a centre-incharge code but no agency, so at executive level it is
         attributed to the CI and at branch level it simply sums. */
      const unitScope = String(req.query.unit_code || '').trim();
      const isBranch = !!unitScope && allUnits.some(u => u.unit_code === unitScope);
      if (unitScope && !isBranch) return res.status(400).json({ detail: 'Branch is not in this state' });
      /* Narrow the state's branches to the ones this caller may read. Without it, any
         signed-in user could name any state and receive it in full. */
      const _scope = await callerScope(req);
      const _allowed = _scope == null ? null : new Set(_scope);
      const units = (isBranch ? allUnits.filter(u => u.unit_code === unitScope) : allUnits)
        .filter(u => !_allowed || _allowed.has(u.unit_code));
      if (!units.length) return res.status(403).json({ detail: 'Outside your branch scope' });
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

      // Billing snapshot labels for range-appropriate collection efficiency.
      // Complete billing months within [win.from, win.to]:
      //   billEnd = latest snapshot label to use; billBefore = snapshot to subtract.
      /* Which bills the collections in this range answer — the same shifted-month rule
         the national view uses, so a branch and the country cannot disagree about what
         "collection vs billing" means.

         This used to take the range's OWN month and difference two cumulative
         snapshots. Selecting Last Month therefore asked for the 2026-08 snapshot, which
         the ERP does not write until month end, and the missing row differenced to a
         zero denominator: the card read "of ₹0 billed". */
      /* Cash only. Agent supply is dispatched in the morning so the current day is
         already complete, but hawker entries are keyed through the day — trimming both
         would shorten the agent window for nothing. */
      const supWin = trimPartialDay(win);

      const rangeBillMonths = _billMonthsFor(win);
      const billLabelSet = new Set();
      rangeBillMonths.forEach(m => { billLabelSet.add('BILL-' + m.label); billLabelSet.add(m.label); billLabelSet.add(m.prev); });
      /* Receipts telescope from the range's OWN months, not the shifted ones. Money
         banked during August shows up as the movement between the July and August
         cumulative snapshots — the same pair whose bill movement is the bill raised on
         1 August. Both halves of the ratio then come from one ledger. */
      const pad2 = n => String(n).padStart(2, '0');
      const rangeOwnMonths = (() => {
        const f = new Date(win.from + 'T00:00:00'), t = new Date(win.to + 'T00:00:00');
        const out = []; let cur = new Date(f.getFullYear(), f.getMonth(), 1);
        const end = new Date(t.getFullYear(), t.getMonth(), 1);
        while (cur <= end && out.length < 36) {
          const p = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
          out.push({ label: `${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}`,
                     prev:  `${p.getFullYear()}-${pad2(p.getMonth() + 1)}` });
          cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        }
        return out;
      })();
      rangeOwnMonths.forEach(m => { billLabelSet.add(m.label); billLabelSet.add(m.prev); });
      const rangeBillLabels = [...billLabelSet];

      const [agentSup, cashSup, coll, os, billing, master, hier, visits, execActive, execBilling, monthSup, collPrevYr] = await Promise.all([
        /* Agent (credit) supply — daily average over the selected range vs the same
           range last year.

           Split into two tight range scans instead of one query spanning both windows,
           and the credit-sale agency set is fetched separately and merged in JS rather
           than joined here. The previous shape cost 23.4s on a 3-month range against
           4.2s for this one: an OR across two windows a year apart makes the optimizer
           walk ~15 months of an 8.4M-row table, and the derived-table join materialises
           27k agencies before touching supply. Both scans run inside the same
           Promise.all, so the pair costs the slower of the two, not their sum. */
        (async () => {
          const scan = (from, to) => q(
            /* idx_sd_cover_range is (supply_date, unit_code, sup_type_code, publ, agcd,
               sup_copy) — every column this query touches, so the aggregate runs off
               the index and never reads a row. Forced because the optimizer otherwise
               prefers idx_sd_dateunit and then does 8.4M row lookups behind it. */
            `SELECT s.unit_code, s.agcd, SUM(s.sup_copy) total,
                    COUNT(DISTINCT s.supply_date) days
             FROM supply_data s FORCE INDEX (idx_sd_cover_range)
             WHERE s.supply_date BETWEEN ? AND ? AND s.unit_code IN (${IN})
               AND s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')
             GROUP BY s.unit_code, s.agcd`, [from, to, ...codes]);
          /* Copies per day must divide by the DAYS IN THE WINDOW, not by the days each
             agency happened to supply. Dividing per-group inflates the total: an agency
             that lifted on 3 days of a month reports its 3-day average as if it ran all
             month, and the state total is the sum of those. Scope-wide divisor keeps
             sum(group averages) equal to (total copies / days), which is what "average
             daily supply" means. */
          const windowDays = (from, to) => q(
            `SELECT COUNT(DISTINCT s.supply_date) d FROM supply_data s FORCE INDEX (idx_sd_cover_range)
             WHERE s.supply_date BETWEEN ? AND ? AND s.unit_code IN (${IN})
               AND s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')`,
            [from, to, ...codes]);
          const [cur, prv, credit, curD, prvD] = await Promise.all([
            scan(win.from, win.to),
            scan(prevWin.from, prevWin.to),
            q(`SELECT DISTINCT unit, agcd FROM agency_master
               /* CREDIT SALE is a class, not a status. The stopped/suspended conditions that used to
             sit here were evaluated as of today and applied to BOTH windows, so an agency
             stopped this year was erased from last year's total too — where it had really
             supplied. Last year shrank, the current year did not, and growth was invented:
             Shakir Khan read +10.4% against a true -5.6% (prev 22,079 instead of 25,811),
             and Homesh Sharma +82.5% against -0.6% (prev 4,641 instead of 8,600).
             A stopped agency contributes ~nothing to the current window anyway, so dropping
             the status test changes today's figure by under 1% and makes history honest. */
          WHERE ag_class_name='CREDIT SALE'`),
            windowDays(win.from, win.to),
            windowDays(prevWin.from, prevWin.to),
          ]);
          const curDays = N(curD.rows[0] && curD.rows[0].d) || 0;
          const prvDays = N(prvD.rows[0] && prvD.rows[0].d) || 0;
          const isCredit = new Set(credit.rows.map(r => `${r.unit}|${r.agcd}`));
          const merged = new Map();
          const put = (rows, prefix) => rows.forEach(r => {
            const k = `${r.unit_code}|${r.agcd}`;
            if (!isCredit.has(k)) return;              // the join, done in JS
            if (!merged.has(k)) merged.set(k, {
              unit_code: r.unit_code, agcd: r.agcd,
              cur_total: 0, cur_days: 0, prv_total: 0, prv_days: 0,
            });
            const m = merged.get(k);
            m[`${prefix}_total`] = N(r.total);
            m[`${prefix}_days`]  = prefix === 'cur' ? curDays : prvDays;
          });
          put(cur.rows, 'cur');
          put(prv.rows, 'prv');
          return { rows: [...merged.values()] };
        })(),
        // Cash (city) supply — same split, for the same reason.
        (async () => {
          const scan = (from, to) => q(
            // center_incharge_name is not in the covering index, so it is looked up
            // separately below rather than dragging every row into this scan.
            `SELECT loc_id unit_code, center_incharge,
                    SUM(sup_copies) total, COUNT(DISTINCT supply_date) days
             FROM hawker_supply FORCE INDEX (idx_hs_cover_range)
             WHERE supply_date BETWEEN ? AND ? AND loc_id IN (${IN})
             GROUP BY loc_id, center_incharge`, [from, to, ...codes]);
          /* Same scope-wide divisor as agent supply, and it matters far more here: a
             centre changing hands mid-month splits its days across two incharge codes,
             so per-group averaging counted the same centre twice — once at each
             incharge's short-window rate. That overstated cash sale by 17.8%. */
          const windowDays = (from, to) => q(
            `SELECT COUNT(DISTINCT supply_date) d FROM hawker_supply FORCE INDEX (idx_hs_cover_range)
             WHERE supply_date BETWEEN ? AND ? AND loc_id IN (${IN})`, [from, to, ...codes]);
          // Centre and hawker counts are a point-in-time headcount, not a range total.
          const [cur, prv, today, curD, prvD] = await Promise.all([
            scan(supWin.from, supWin.to),
            scan(prevWin.from, prevWin.to),
            q(`SELECT loc_id unit_code, center_incharge,
                      MAX(center_incharge_name) center_incharge_name,
                      COUNT(DISTINCT hwk_cent_code) centres,
                      COUNT(DISTINCT hawker_id) hawkers,
                      MAX(COALESCE(hawker_center, hwk_cent_code)) cent_name
               FROM hawker_supply
               WHERE supply_date = ? AND loc_id IN (${IN})
               GROUP BY loc_id, center_incharge`, [asOn, ...codes]),
            windowDays(supWin.from, supWin.to),
            windowDays(prevWin.from, prevWin.to),
          ]);
          const curDays = N(curD.rows[0] && curD.rows[0].d) || 0;
          const prvDays = N(prvD.rows[0] && prvD.rows[0].d) || 0;
          const merged = new Map();
          const key = r => `${r.unit_code}|${r.center_incharge || ''}`;
          const seed = r => {
            if (!merged.has(key(r))) merged.set(key(r), {
              unit_code: r.unit_code, center_incharge: r.center_incharge,
              center_incharge_name: null, cur_total: 0, cur_days: 0,
              prv_total: 0, prv_days: 0, centres: 0, hawkers: 0, cent_name: null,
            });
            return merged.get(key(r));
          };
          cur.rows.forEach(r => { const m = seed(r); m.cur_total = N(r.total); m.cur_days = curDays; });
          prv.rows.forEach(r => { const m = seed(r); m.prv_total = N(r.total); m.prv_days = prvDays; });
          today.rows.forEach(r => { const m = seed(r); m.centres = N(r.centres);
            m.hawkers = N(r.hawkers); m.cent_name = r.cent_name;
            m.center_incharge_name = r.center_incharge_name; });
          return { rows: [...merged.values()] };
        })(),
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
        q(`SELECT period_label, unit_code, SUM(bill_amt) amt,
                  SUM(rec_amt) rec, SUM(other_cr) ocr FROM agency_outstanding
           WHERE period_label IN (${[prevMonthLabel, prevPrevLabel, ...rangeBillLabels].map(() => '?').join(',')})
             AND unit_code IN (${IN})
           GROUP BY period_label, unit_code`,
          [prevMonthLabel, prevPrevLabel, ...rangeBillLabels, ...codes]),
        q(`SELECT unit, agcd, MAX(ag_name) ag_name, MAX(executive_code) exec_code,
                  MAX(executive_name) exec_name, MAX(dist_name) dist_name,
                  MAX(ag_class_name) ag_class
           FROM agency_master
           /* No status test. This row set is what attributes supply to an executive, so
              excluding stopped agencies dropped their historical copies from every
              executive's previous-year figure — the same invented growth as the credit
              set above. The DCR book built from these rows already requires supply in
              the month, so a stopped agency cannot inflate that count either. */
           WHERE unit IN (${IN}) AND CAST(dpcd AS UNSIGNED)=1
           GROUP BY unit, agcd`, codes),
        q(`SELECT m.exec_code, MAX(m.exec_desig) desig,
                  MAX(m.edtn_incharge) edtn_code, MAX(m.edtn_incharge_name) edtn,
                  MAX(m.circ_incharge) circ_code, MAX(m.circ_incharge_name) circ,
                  MAX(m.zonal_head) zonal_code, MAX(m.zonal_head_name) zonal
           FROM exec_hierarchy_mapping m
           INNER JOIN exec_master em ON em.unit_code = m.unit_code AND em.executive_code = m.exec_code AND em.is_active_pli = 'Y'
           GROUP BY m.exec_code`),
        // Field visits over the selected window, by unit and by executive.
        // executive_name is carried so visits can be bridged onto the circulation
        // exec_code — DCR stores HR employee codes, which never equal exec_code.
        q(`SELECT unit_code, emp_code, MAX(executive_name) executive_name, COUNT(*) visits,
                  COUNT(DISTINCT visit_to_main_code) agencies
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ? AND unit_code IN (${IN})
           GROUP BY unit_code, emp_code`, [win.from, win.to, ...codes]),
        // Active exec flag — scoped to unit_code IN scope so the scan stays small.
        q(`SELECT executive_code, executive_desc, is_active_pli FROM exec_master WHERE unit_code IN (${IN})`, codes),
        // Exec-level billing: agency-level snapshots matched to executives via execOf in JS.
        // Avoid SQL join to agency_master — older snapshots may differ in dp_code/agcd format,
        // causing the June row to vanish (makes the diff return the full cumulative instead of delta).
        /* Receipts come from the same two snapshots as the bill, not from
           agency_collection. The ERP's "net receipt" is rec_amt + other_cr — money
           banked plus credit notes and adjustments — and agency_collection holds only
           the cash transactions. For SHAKIR KHAN in August that was 13.56 L against the
           ERP's 18.78 L, so his recovery showed as 53% where the ERP says 73%. Taking
           both halves of the ratio from one ledger also means they cannot drift apart. */
        q(`SELECT ao.period_label, ao.unit_code, ao.ag_code,
                  MAX(ao.exec_code) exec_code, SUM(ao.bill_amt) amt,
                  SUM(ao.rec_amt) rec, SUM(ao.other_cr) ocr
           FROM agency_outstanding ao
           WHERE ao.period_label IN (?, ?) AND ao.unit_code IN (${IN})
           GROUP BY ao.period_label, ao.unit_code, ao.ag_code`,
          [prevMonthLabel, prevPrevLabel, ...codes]),
        // Distinct agencies that received agent supply this month — used as DCR book denominator.
        q(`SELECT s.unit_code, s.agcd FROM supply_data s FORCE INDEX (idx_sd_dateunit)
           WHERE s.supply_date BETWEEN ? AND ? AND s.unit_code IN (${IN})
             AND s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN ('P14')
           GROUP BY s.unit_code, s.agcd`, [win.from, win.to, ...codes]),
        // Previous-year collection for the same window (YoY comparison)
        q(`SELECT -COALESCE(SUM(amount),0) amt
           FROM agency_collection
           WHERE is_valid=1 AND coll_date BETWEEN ? AND ? AND unit_code IN (${IN})`,
          [prevWin.from, prevWin.to, ...codes]),
      ]);

      // ── Active executive map from exec_master ──
      const activeMap = new Map();
      (execActive.rows || []).forEach(r => activeMap.set(r.executive_code, r.is_active_pli === 'Y'));
      // Set of "unit|agcd" keys that received agent supply this month — DCR book denominator.
      const supplySet = new Set((monthSup.rows || []).map(r => `${r.unit_code}|${r.agcd}`));

      // ── Roll everything up per branch and per executive ──
      const mk = () => ({
        agent_cur: 0, agent_prev: 0, cash_cur: 0, cash_prev: 0,
        /* Raw copies plus the window's day count, kept so the average is taken ONCE at
           the end. Adding a thousand quotients instead drifts in the last bit: Rajasthan
           landed on 5,31,849.4999 where the exact division gives 5,31,849.5, and the
           state card above read one copy more than the branch list below it. */
        _agc: 0, _agp: 0, _csc: 0, _csp: 0, _agdc: 0, _agdp: 0, _csdc: 0, _csdp: 0,
        collection: 0, txn: 0, agencies_paid: 0, billed: 0,
        os: 0, os_agencies: 0, critical: 0, book: 0, dcrBook: 0,
        visits: 0, agencies_visited: 0, execs: new Set(),
      });
      const B = {}; codes.forEach(c => { B[c] = mk(); });
      const E = {};                                     // exec_code -> aggregate
      const execOf = {};                                // "unit|agcd" -> {code,name}

      master.rows.forEach(r => {
        const k = `${r.unit}|${r.agcd}`;
        execOf[k] = { code: r.exec_code, name: r.exec_name };
        if (B[r.unit]) {
          B[r.unit].book += 1;
          // DCR coverage denominator = CREDIT SALE DPCD=1 agencies with supply this month
          if (supplySet.has(k) && r.ag_class === 'CREDIT SALE') B[r.unit].dcrBook += 1;
        }
      });
      /* Names for codes the range scan cannot carry.

         The cash-supply scan groups by centre incharge but leaves center_incharge_name
         out, because it is not in the covering index and dragging it through would pull
         every row into the scan. The name was then filled in from the as-on-date query
         alone — so a centre incharge with no supply on that one date got no name at all
         and the screen showed a bare code like E01804 instead of BABU LAL KHATIK.

         exec_master answers it for a thousand rows instead of a range scan: every one of
         the 83 centre incharges active in June resolves there. */
      const nameOf = new Map(
        (execActive.rows || []).map(r => [r.executive_code, r.executive_desc])
          .filter(([c, n]) => c && n && String(n).trim() && !/^(N\/A|#N\/A|NOT APPLICABLE)$/i.test(String(n).trim())));

      const exec = (code, name, unit) => {
        if (!code) return null;
        const known = name && String(name).trim() && !/^(N\/A|#N\/A)$/i.test(String(name).trim())
          ? name : nameOf.get(code);
        E[code] = E[code] || {
          exec_code: code, exec_name: known || code, units: new Set(),
          is_active: activeMap.has(code) ? activeMap.get(code) : null,
          agencies: 0, supply_cur: 0, supply_prev: 0, cash_cur: 0, cash_prev: 0, collection: 0, billed: 0, os: 0,
          _agc: 0, _agp: 0, _csc: 0, _csp: 0, _agdc: 0, _agdp: 0, _csdc: 0, _csdp: 0,
          txn: 0, agencies_paid: 0, os_agencies: 0, critical: 0,
          visits: 0, agencies_visited: 0,
          hawker_centres: 0, hawker_count: 0, hawker_cent_name: null,
        };
        if (known && E[code].exec_name === code) E[code].exec_name = known;
        if (unit) E[code].units.add(unit);
        return E[code];
      };
      master.rows.forEach(r => { const e = exec(r.exec_code, r.exec_name, r.unit); if (e) e.agencies += 1; });

      /* Averaged, then added — not rounded per agency and then added. Every agency here
         shares one divisor, so the exact sum is the branch's own copies-per-day; rounding
         each of a thousand agencies first scattered up to half a copy apiece and left the
         state 32 copies a day away from the card above it. Rounding happens once per
         branch and once per executive, below, so each list still adds up to its header. */
      /* Every row of a scan carries the same scope-wide day count, but a row that exists
         only in the comparison window carries cur_days = 0 from its seed. Assigning
         blindly let such a row land last and zero the divisor, which zeroed the figure
         it divided. MAX keeps the real count whatever order the rows arrive in. */
      const takeAg = (o, r) => { o._agc += N(r.cur_total); o._agp += N(r.prv_total);
                                 o._agdc = Math.max(o._agdc, N(r.cur_days));
                                 o._agdp = Math.max(o._agdp, N(r.prv_days)); };
      const takeCs = (o, r) => { o._csc += N(r.cur_total); o._csp += N(r.prv_total);
                                 o._csdc = Math.max(o._csdc, N(r.cur_days));
                                 o._csdp = Math.max(o._csdp, N(r.prv_days)); };
      agentSup.rows.forEach(r => {
        const b = B[r.unit_code]; if (b) takeAg(b, r);
        const k = `${r.unit_code}|${r.agcd}`;
        const e = execOf[k] && exec(execOf[k].code, execOf[k].name, r.unit_code);
        if (e) takeAg(e, r);
      });
      cashSup.rows.forEach(r => {
        const cur = N(r.cur_days) > 0 ? N(r.cur_total) / N(r.cur_days) : 0;
        const prv = N(r.prv_days) > 0 ? N(r.prv_total) / N(r.prv_days) : 0;
        const b = B[r.unit_code]; if (b) takeCs(b, r);
        // City sale belongs to the centre incharge, who is an executive in their own right.
        const e = exec(r.center_incharge, r.center_incharge_name, r.unit_code);
        if (e) { takeCs(e, r); e.hawker_centres += N(r.centres); e.hawker_count += N(r.hawkers); if (r.cent_name && !e.hawker_cent_name) e.hawker_cent_name = r.cent_name; }
      });
      /* Both supply loops are done, so the average is taken here — once per branch and
         once per executive, from raw copies over the window's own days. Agent and cash
         divide by their own day counts because agent supply reads the publishing calendar
         and cash stops at yesterday. Everything downstream (rows, totals, the zonal
         hierarchy) reads these integers and rounds nothing further. */
      const avgOnce = o => {
        const ag  = o._agdc > 0 ? Math.round(o._agc / o._agdc) : 0;
        const agP = o._agdp > 0 ? Math.round(o._agp / o._agdp) : 0;
        const cs  = o._csdc > 0 ? Math.round(o._csc / o._csdc) : 0;
        const csP = o._csdp > 0 ? Math.round(o._csp / o._csdp) : 0;
        return { ag, agP, cs, csP };
      };
      codes.forEach(c => {
        const b = B[c], v = avgOnce(b);
        b.agent_cur = v.ag; b.agent_prev = v.agP; b.cash_cur = v.cs; b.cash_prev = v.csP;
      });
      Object.values(E).forEach(e => {
        const v = avgOnce(e);
        e.cash_cur = v.cs; e.cash_prev = v.csP;
        // supply is agent + cash, so "agent = supply - cash" downstream stays exact.
        e.supply_cur = v.ag + v.cs; e.supply_prev = v.agP + v.csP;
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
      /* Match the two labels exactly. This used to treat "not the current month" as the
         previous one, which was harmless while the query fetched exactly two labels. It
         now fetches several — the BILL- labels and the range's own months — and every
         one of them landed in cumPrev, so the subtraction went negative, clamped to
         zero, and every branch showed a blank collection percentage. */
      const cumThis = {}, cumPrev = {}, recThis = {}, recPrev = {};
      billing.rows.forEach(r => {
        const bucket = r.period_label === prevMonthLabel ? [cumThis, recThis]
                     : r.period_label === prevPrevLabel  ? [cumPrev, recPrev] : null;
        if (!bucket) return;
        const [cb, rb] = bucket;
        cb[r.unit_code] = (cb[r.unit_code] || 0) + N(r.amt);
        rb[r.unit_code] = (rb[r.unit_code] || 0) + N(r.rec) + N(r.ocr);
      });
      const havePrev = billing.rows.some(r => r.period_label === prevPrevLabel);
      codes.forEach(c => {
        B[c].billed = havePrev ? Math.max(0, (cumThis[c] || 0) - (cumPrev[c] || 0)) : (cumThis[c] || 0);
        // Ledger recovery for the branch, from the same snapshot pair as its bill.
        B[c].net_receipt = havePrev ? Math.max(0, (recThis[c] || 0) - (recPrev[c] || 0)) : null;
      });
      // Range-appropriate billing denominator for the collection KPI card.
      // diff of two cumulative snapshots = billing for all complete months within the date range.
      /* Each shifted month resolved on its own: the ERP's own BILL-YYYY-MM where it
         exists, otherwise the difference of consecutive cumulative snapshots. A month
         with neither is skipped and named, so a denominator that is only part of the
         range is never passed off as the whole of it. */
      const labelTot = lbl => billing.rows.filter(r => r.period_label === lbl).reduce((a, r) => a + N(r.amt), 0);
      const haveLabel = lbl => billing.rows.some(r => r.period_label === lbl);
      const billMonthsUsed = [], billMonthsMissing = [];
      let rangeBilledAmt = 0;
      rangeBillMonths.forEach(m => {
        if (haveLabel('BILL-' + m.label))            { rangeBilledAmt += labelTot('BILL-' + m.label); billMonthsUsed.push(m.label); }
        else if (haveLabel(m.label) && haveLabel(m.prev)) { rangeBilledAmt += Math.max(0, labelTot(m.label) - labelTot(m.prev)); billMonthsUsed.push(m.label); }
        else if (haveLabel(m.label))                 { rangeBilledAmt += labelTot(m.label); billMonthsUsed.push(m.label); }
        else billMonthsMissing.push(m.label);
      });
      const rangeBilledKnown = billMonthsUsed.length > 0;

      /* Net receipt for the range, from the same ledger as the bill: rec_amt + other_cr,
         telescoped across the range's own months. This is the ERP's recovery figure;
         agency_collection holds only banked cash and runs materially lower. */
      const recTot = lbl => billing.rows.filter(r => r.period_label === lbl)
        .reduce((a, r) => a + N(r.rec) + N(r.ocr), 0);
      let rangeNetReceipt = 0, netReceiptKnown = false;
      rangeOwnMonths.forEach(m => {
        if (haveLabel(m.label) && haveLabel(m.prev)) {
          rangeNetReceipt += Math.max(0, recTot(m.label) - recTot(m.prev));
          netReceiptKnown = true;
        }
      });
      // Exec-level billing: use exec_code from agency_outstanding (covers closed/suspended agencies).
      // Falls back to execOf for agencies where exec_code is missing in the snapshot.
      const exBillThis = {}, exBillPrev = {}, exRecThis = {}, exRecPrev = {};
      (execBilling.rows || []).forEach(r => {
        const k = `${r.unit_code}|${r.ag_code}`;
        const execCode = r.exec_code || (execOf[k] && execOf[k].code);
        if (!execCode) return;
        const isThis = r.period_label === prevMonthLabel;
        const tb = isThis ? exBillThis : exBillPrev;
        const tr = isThis ? exRecThis  : exRecPrev;
        tb[execCode] = (tb[execCode] || 0) + N(r.amt);
        tr[execCode] = (tr[execCode] || 0) + N(r.rec) + N(r.ocr);
      });
      Object.keys(E).forEach(code => {
        E[code].billed = havePrev
          ? Math.max(0, (exBillThis[code] || 0) - (exBillPrev[code] || 0))
          : (exBillThis[code] || 0);
        // Movement between the same two snapshots the bill came from.
        E[code].net_receipt = havePrev
          ? Math.max(0, (exRecThis[code] || 0) - (exRecPrev[code] || 0))
          : null;
      });
      /* DCR and circulation identify the same person differently: dcr_agency_visit stores
         the Oracle HR employee code (R09838, FF06002, VN02303…) while E is keyed by the
         circulation exec_code (E01773…). Not one of them matches, so attributing visits by
         emp_code alone silently gave every executive zero while the branch totals — keyed
         on unit_code — looked right. Bridge on name instead, scoped to the unit: there is a
         NEERAJ JAIN in both JA0 and BH3, and an unscoped match would move Bharatpur's
         visits to Jaipur. */
      const execByName = {};
      Object.values(E).forEach(e => {
        const nm = String(e.exec_name || '').trim().toUpperCase();
        if (!nm) return;
        [...e.units].forEach(u => { execByName[`${u}|${nm}`] = e.exec_code; });
      });

      visits.rows.forEach(r => {
        const b = B[r.unit_code];
        if (b) { b.visits += N(r.visits); b.agencies_visited += N(r.agencies); b.execs.add(r.emp_code); }
        let e = E[r.emp_code];
        if (!e) {
          const nm = String(r.executive_name || '').trim().toUpperCase();
          const code = nm ? execByName[`${r.unit_code}|${nm}`] : null;
          if (code) e = E[code];
        }
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
                        collection_cash: a.collection_cash != null ? a.collection_cash : a.collection,
                        pct: a.billed ? r1((a.collection / a.billed) * 100) : null,
                        txn: a.txn, agencies_paid: a.agencies_paid },
          outstanding: { amount: a.os, agencies: a.os_agencies, critical: a.critical,
                         per_agency: a.os_agencies ? Math.round(a.os / a.os_agencies) : 0 },
          dcr: { visits: a.visits, agencies_visited: a.agencies_visited, book: a.dcrBook || a.book,
                 execs: a.execs, coverage_pct: (a.dcrBook || a.book) ? r1((a.agencies_visited / (a.dcrBook || a.book)) * 100) : null },
        };
      };
      const [circMap, heads] = await Promise.all([unitCircIncharge(), stateHeads()]);

      const branches = groupBy === 'unit'
        ? units.map(u => {
            const b = B[u.unit_code];
            const br = rowOf(u.unit_code, u.unit_name, null, {
              unit_code: u.unit_code, unit_name: u.unit_name,
              supply_cur: b.agent_cur + b.cash_cur, supply_prev: b.agent_prev + b.cash_prev,
              agent_cur: b.agent_cur, cash_cur: b.cash_cur,
              collection: b.net_receipt != null ? b.net_receipt : b.collection,
              collection_cash: b.collection, billed: b.billed, txn: b.txn, agencies_paid: b.agencies_paid,
              os: b.os, os_agencies: b.os_agencies, critical: b.critical,
              visits: b.visits, agencies_visited: b.agencies_visited, book: b.book, dcrBook: b.dcrBook, execs: b.execs.size,
            });
            br.supply.agent_prev = b.agent_prev;
            br.supply.cash_prev = b.cash_prev;
            br.supply.agent_growth_pct = r1(pct(b.agent_cur, b.agent_prev));
            br.supply.cash_growth_pct = r1(pct(b.cash_cur, b.cash_prev));
            const ci = circMap[u.unit_code] || {};
            br.circ_agent = ci.agent || null;   // owns agent (credit) sale via executives
            br.circ_cash  = ci.cash  || null;   // owns cash (city) sale via centre incharges
            return br;
          }).sort((a, x) => x.supply.current - a.supply.current)
        : Object.values(E).map(e => {
            const h = hier.rows.find(x => x.exec_code === e.exec_code) || {};
            const execRow = rowOf(e.exec_code, e.exec_name, h.desig || null, {
              unit_code: [...e.units][0] || unitScope,
              unit_name: [...e.units].map(u => unitName[u] || u).join(' / '),
              exec_code: e.exec_code,
              supply_cur: e.supply_cur, supply_prev: e.supply_prev,
              agent_cur: e.supply_cur - e.cash_cur, cash_cur: e.cash_cur,
              /* Ledger net receipt against the ledger's own bill — the ERP's recovery
                 figure. agency_collection holds only banked cash and understated it:
                 SHAKIR KHAN read 13.5 L against the ERP's 18.8 L, so 53% where the ERP
                 says 73%. Falls back to the cash figure when no snapshot pair exists. */
              collection: e.net_receipt != null ? e.net_receipt : e.collection,
              collection_cash: e.collection,
              billed: e.billed > 0 ? e.billed : (e.collection + e.os),
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
            /* The executive's direct manager. exec_hierarchy_mapping calls the column
               edtn_incharge ("edition"), but it carries the DAK incharge — every JA0
               executive routes through Ankit Bihari Sharma (69) to Neeraj Jain, so the
               circulation incharge is two levels up, not the reporting manager. */
            execRow.edtn_incharge = cleanName(h.edtn) || null;
            execRow.circ_incharge = cleanName(h.circ) || null;
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
          /* Recovery is the ledger's net receipt over the ledger's own bill, which is
             what the ERP reports. e.collection stays as the banked cash from
             agency_collection — a real figure, just a narrower one — and is kept
             alongside so the two are never confused for each other. */
          collection: e.net_receipt != null ? e.net_receipt : e.collection,
          collection_cash: e.collection, billed: e.billed, outstanding: e.os,
          collection_pct: e.billed > 0
            ? r1(((e.net_receipt != null ? e.net_receipt : e.collection) / e.billed) * 100)
            : null,
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
      const collected_prev_yr = Number((collPrevYr.rows || [])[0]?.amt || 0);
      const osTot = bsum(b => b.os);
      const bookTot = bsum(b => b.dcrBook || b.book), seenTot = bsum(b => b.agencies_visited);

      // ── Zonal Head performance hierarchy ──
      const hierIdx = {};
      (hier.rows || []).forEach(h => { hierIdx[h.exec_code] = h; });
      const addAgg = (a, e) => {
        a.agent_cur  += e.supply_cur - e.cash_cur;
        a.agent_prev += e.supply_prev - e.cash_prev;
        a.cash_cur   += e.cash_cur;
        a.cash_prev  += e.cash_prev;
        a.collection += e.collection;
        a.billed     += e.billed;
        a.os         += e.os;
        a.critical   += e.critical;
        a.visits     += e.visits;
        a.agencies   += e.agencies;
        a.n_execs    += 1;
      };
      const aggMk = () => ({ agent_cur:0, agent_prev:0, cash_cur:0, cash_prev:0, collection:0, billed:0, os:0, critical:0, visits:0, agencies:0, n_execs:0 });
      const aggFin = a => {
        const sc = a.agent_cur + a.cash_cur, sp = a.agent_prev + a.cash_prev;
        return { ...a, supply_cur: sc, supply_prev: sp,
          growth_pct: sp ? r1((sc / sp - 1) * 100) : null,
          coll_pct: a.billed ? r1((a.collection / a.billed) * 100) : null };
      };
      const zhMap = {};
      Object.values(E).forEach(e => {
        const h = hierIdx[e.exec_code]; if (!h) return;
        const zhName = cleanName(h.zonal); if (!zhName) return;
        const zhKey = h.zonal_code || zhName;
        if (!zhMap[zhKey]) zhMap[zhKey] = { zh_code: h.zonal_code, zh_name: zhName, ...aggMk(), unit_set: new Set(), cis: {} };
        addAgg(zhMap[zhKey], e);
        (e.units || []).forEach(u => zhMap[zhKey].unit_set.add(u));
        const ciName = cleanName(h.circ) || '—';
        const ciKey = h.circ_code || ciName;
        if (!zhMap[zhKey].cis[ciKey]) zhMap[zhKey].cis[ciKey] = { ci_code: h.circ_code, ci_name: ciName, ...aggMk(), daks: {} };
        addAgg(zhMap[zhKey].cis[ciKey], e);
        const dakName = cleanName(h.edtn) || '—';
        const dakKey = h.edtn_code || dakName;
        if (!zhMap[zhKey].cis[ciKey].daks[dakKey]) zhMap[zhKey].cis[ciKey].daks[dakKey] = { dak_code: h.edtn_code, dak_name: dakName, ...aggMk(), exec_list: [] };
        addAgg(zhMap[zhKey].cis[ciKey].daks[dakKey], e);
        zhMap[zhKey].cis[ciKey].daks[dakKey].exec_list.push({
          exec_code: e.exec_code, exec_name: e.exec_name, desig: h.desig,
          agent_cur: e.supply_cur - e.cash_cur, agent_prev: e.supply_prev - e.cash_prev,
          cash_cur: e.cash_cur, cash_prev: e.cash_prev,
          collection: e.collection, billed: e.billed, os: e.os, critical: e.critical, visits: e.visits, agencies: e.agencies,
        });
      });
      const bySupply = arr => arr.sort((a, b) => (b.agent_cur + b.cash_cur) - (a.agent_cur + a.cash_cur));
      const zh_perf = bySupply(Object.values(zhMap).map(zh => ({
        ...aggFin(zh),
        cis: bySupply(Object.values(zh.cis).map(ci => ({
          ...aggFin(ci),
          daks: bySupply(Object.values(ci.daks).map(dak => ({
            ...aggFin(dak),
            execs: bySupply(dak.exec_list.map(ex => ({
              ...ex, supply_cur: ex.agent_cur + ex.cash_cur, supply_prev: ex.agent_prev + ex.cash_prev,
              growth_pct: (ex.agent_prev + ex.cash_prev) ? r1(((ex.agent_cur + ex.cash_cur) / (ex.agent_prev + ex.cash_prev) - 1) * 100) : null,
              coll_pct: ex.billed ? r1((ex.collection / ex.billed) * 100) : null,
            }))),
          }))),
        }))),
      })));

      /* One person often holds two rungs at once — a Zonal Head who is also the
         Circulation Incharge for their own zone. Rendered literally that puts the same
         name on two stacked rows carrying identical numbers, which reads as a data bug.
         Two cases, handled differently because they carry different information:
           · sole child, same name  → pure repetition. Drop the child, lift its children
             onto the parent, so ZH → Dak → Exec.
           · same name beside other children → the split is real (43 execs = 35 direct
             + 8 under another CI). Keep the row, flag it `self` so the UI can say so. */
      const _sameName = (a, b) =>
        String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

      /* Two different employees can carry the same name (there are two Jitendra Joshis,
         on different employee codes and different branches). Name alone then reads as a
         duplicated row, so tell those apart by the branches each one actually covers. */
      const _zhNameCount = {};
      zh_perf.forEach(zh => {
        const k = String(zh.zh_name || '').trim().toUpperCase();
        _zhNameCount[k] = (_zhNameCount[k] || 0) + 1;
      });
      zh_perf.forEach(zh => {
        const units = [...(zh.unit_set || [])].map(u => unitName[u] || u).sort();
        delete zh.unit_set;
        if (_zhNameCount[String(zh.zh_name || '').trim().toUpperCase()] > 1) {
          zh.zh_hint = units.slice(0, 3).join(', ') + (units.length > 3 ? ` +${units.length - 3}` : '');
        }
      });

      zh_perf.forEach(zh => {
        if (zh.cis.length === 1 && _sameName(zh.cis[0].ci_name, zh.zh_name)) {
          zh.daks_direct = zh.cis[0].daks;   // ZH wears the CI hat alone — skip the rung
          zh.cis = [];
        } else {
          zh.cis.forEach(ci => { if (_sameName(ci.ci_name, zh.zh_name)) ci.self = true; });
        }
        const collapseDaks = holder => {
          if (!holder) return;
          const daks = holder.daks_direct || holder.daks;
          if (!daks || daks.length !== 1) return;
          const parentName = holder.ci_name || holder.zh_name;
          if (!_sameName(daks[0].dak_name, parentName)) return;
          holder.execs_direct = daks[0].execs;
          if (holder.daks_direct) holder.daks_direct = []; else holder.daks = [];
        };
        collapseDaks(zh);
        zh.cis.forEach(collapseDaks);
      });

      res.json({
        state: stateKey, state_name: meta.name,
        level: isBranch ? 'branch' : 'state',
        unit_code: isBranch ? unitScope : null,
        unit_name: isBranch ? (unitName[unitScope] || unitScope) : null,
        group_by: groupBy, group_label: groupBy === 'unit' ? 'Branch' : 'Executive',
        os_code: meta.os,
        // Who owns this view: the state's VP, and — when drilled into one branch —
        // that branch's circulation incharge.
        vp: heads[stateKey] || null,
        circ_agent: isBranch ? ((circMap[unitScope] || {}).agent || null) : null,
        circ_cash:  isBranch ? ((circMap[unitScope] || {}).cash  || null) : null,
        as_on: asOn, previous: prev, compare: mode, compare_label: label,
        range: win.key, range_label: win.label, range_from: win.from, range_to: win.to,
        prev_range_from: prevWin.from, prev_range_to: prevWin.to,
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
          collection: (() => {
            /* null, not zero, when no bill for the range has been snapshotted yet.
               Falling back to `billed` (last month's, anchored on as-on) silently
               measured the range's collection against a different period's billing. */
            const denom = rangeBilledKnown ? rangeBilledAmt : null;
            // Ledger recovery where the snapshots allow it; banked cash otherwise.
            const recovered = netReceiptKnown ? rangeNetReceipt : collected;
            return { collected: recovered, collection_cash: collected, billed,
                        range_billed: denom,
                        bill_months: billMonthsUsed, bill_missing: billMonthsMissing,
                        pct: denom ? r1((recovered / denom) * 100) : null,
                        gap: denom ? Math.max(0, denom - recovered) : null, txn: bsum(b => b.txn),
                        agencies_paid: bsum(b => b.agencies_paid),
                        prev_yr: collected_prev_yr,
                        growth_pct: collected_prev_yr ? r1((collected / collected_prev_yr - 1) * 100) : null }; })(),
          outstanding: { amount: osTot, agencies: bsum(b => b.os_agencies),
                         critical: bsum(b => b.critical) },
          dcr: { visits: bsum(b => b.visits), agencies_visited: seenTot, book: bookTot,
                 execs: bsum(b => b.execs.size), coverage_pct: bookTot ? r1((seenTot / bookTot) * 100) : null },
        },
        branches, executives, zh_perf,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  /* ── CI hawker-detail popup ─────────────────────────────────────────────────
     Returns hawker-wise MTD supply for one Centre Incharge, used by the
     clickable "N hwk" link in the Centre Wise performance table. */
  /* Hawker-wise detail for one centre incharge.
     Accepts `unit` or `unit_code` and answers both shapes (`rows` for the CI popup,
     `hawkers`+`totals` for the centre screen) because this route was registered twice
     with different contracts — Express served the first, so the centre screen silently
     received a body it could not read and rendered "No hawker data". */
  app.get('/api/command/ci-hawker-detail', cacheFor(CACHE_TTL_MS), async (req, res) => {
    try {
      const execCode = String(req.query.exec_code || '').trim();
      const unit = String(req.query.unit || req.query.unit_code || '').trim();
      if (!execCode) return res.status(400).json({ detail: 'exec_code required' });
      const unitCl = unit ? ' AND loc_id = ?' : '';
      const unitP  = unit ? [unit] : [];

      const { asOn } = await resolveDates(req.query.as_on);
      const mtdFrom  = asOn.slice(0, 7) + '-01';
      const [y, m, d] = asOn.split('-').map(Number);
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      const prevFrom = `${py}-${String(pm).padStart(2, '0')}-01`;
      const prevTo   = `${py}-${String(pm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      // Yesterday, for the day-on-day column.
      const dPrev = new Date(asOn + 'T00:00:00'); dPrev.setDate(dPrev.getDate() - 1);
      const yday = dPrev.toISOString().slice(0, 10);

      /* Step 1 — who this incharge runs *now*. Scoped to the current month, because
         hawker_supply.center_incharge is stamped per row and a handover rewrites it
         only from the handover date onward. */
      const { rows: mine } = await q(
        `SELECT DISTINCT hawker_id FROM hawker_supply
         WHERE center_incharge = ?${unitCl} AND supply_date BETWEEN ? AND ?`,
        [execCode, ...unitP, mtdFrom, asOn]);
      const hwkIds = mine.map(r => r.hawker_id).filter(Boolean);
      if (!hwkIds.length) {
        return res.json({ exec_code: execCode, unit, unit_code: unit, as_on: asOn,
          rows: [], hawkers: [], totals: { hawker_count: 0, today_cp: 0, mtd_cp: 0 } });
      }
      const IN_PH = hwkIds.map(() => '?').join(',');

      /* Step 2 — measure THOSE hawkers across both periods, keyed on hawker_id rather
         than on the incharge. Filtering last month by the current incharge returned
         nothing whenever a centre had changed hands, so every hawker showed prev 0 and
         growth +∞ — which is what a fresh handover looks like, not a real doubling.
         Asking "how did these hawkers do last month" survives the handover. */
      const { rows } = await q(
        `SELECT hs.hawker_id,
                MAX(hs.hawker_name) hawker_name,
                SUM(CASE WHEN hs.supply_date = ? THEN hs.sup_copies ELSE 0 END) today_cp,
                SUM(CASE WHEN hs.supply_date = ? THEN hs.sup_copies ELSE 0 END) yday_cp,
                SUM(CASE WHEN hs.supply_date BETWEEN ? AND ? THEN hs.sup_copies ELSE 0 END) mtd,
                COUNT(DISTINCT CASE WHEN hs.supply_date BETWEEN ? AND ? THEN hs.supply_date END) mtd_days,
                SUM(CASE WHEN hs.supply_date BETWEEN ? AND ? THEN hs.sup_copies ELSE 0 END) prev_mtd
         FROM hawker_supply hs
         WHERE hs.hawker_id IN (${IN_PH})${unitCl ? ' AND hs.loc_id = ?' : ''}
           AND hs.supply_date BETWEEN ? AND ?
         GROUP BY hs.hawker_id
         ORDER BY mtd DESC`,
        [asOn, yday, mtdFrom, asOn, mtdFrom, asOn, prevFrom, prevTo,
         ...hwkIds, ...unitP, prevFrom, asOn]);

      // Master metadata + competitor share, for the centre-screen shape.
      const [{ rows: hmRows }, { rows: compRows }] = await Promise.all([
        q(`SELECT hawker_id, hawker_name, actual_name, mobile_no, catagory,
                  hawker_center_code, hawker_center_name, payment_nature
           FROM hawker_master WHERE hawker_id IN (${IN_PH})`, hwkIds),
        q(`SELECT cd.agent_code hawker_id, cd.period, cd.our_supply patrika_cp,
                  COALESCE(cd.comp1_supply,0)+COALESCE(cd.comp2_supply,0)+COALESCE(cd.comp3_supply,0)+
                  COALESCE(cd.comp4_supply,0)+COALESCE(cd.comp5_supply,0) comp_total,
                  cd.comp1_name, cd.comp1_supply, cd.comp2_name, cd.comp2_supply,
                  cd.comp3_name, cd.comp3_supply, cd.comp4_name, cd.comp4_supply,
                  cd.comp5_name, cd.comp5_supply
           FROM competitor_data cd
           INNER JOIN (SELECT agent_code, MAX(period) max_period FROM competitor_data
                       WHERE comp_type='hawker' AND agent_code IN (${IN_PH}) AND period <= ?
                       GROUP BY agent_code) lp
             ON cd.agent_code = lp.agent_code AND cd.period = lp.max_period
           WHERE cd.comp_type='hawker'`, [...hwkIds, asOn.slice(0, 7)]),
      ]);
      const hmMap = {}; hmRows.forEach(r => { hmMap[r.hawker_id] = r; });
      const compMap = {}; compRows.forEach(r => { compMap[r.hawker_id] = r; });

      let totToday = 0, totMtd = 0, totDbAll = 0, totPatrika = 0;
      const out = rows.map(r => {
        const h = hmMap[r.hawker_id] || {}, c = compMap[r.hawker_id] || {};
        const todayCp = N(r.today_cp), ydayCp = N(r.yday_cp);
        const mtdCp = N(r.mtd), prevMtd = N(r.prev_mtd), days = N(r.mtd_days);
        const hasComp = !!c.period;
        const patrikaCp = hasComp ? (N(c.patrika_cp) > 0 ? N(c.patrika_cp) : mtdCp) : 0;
        const dbTotal = hasComp ? patrikaCp + N(c.comp_total) : 0;
        totToday += todayCp; totMtd += mtdCp;
        if (hasComp && dbTotal > 0) { totDbAll += dbTotal; totPatrika += patrikaCp; }
        return {
          hawker_id: r.hawker_id,
          hawker_name: h.actual_name || h.hawker_name || String(r.hawker_name || r.hawker_id || ''),
          erp_name: r.hawker_name || null,
          unit_code: unit || null,
          mobile: h.mobile_no || null, category: h.catagory || null,
          payment_nature: h.payment_nature || null,
          center_code: h.hawker_center_code || null, center_name: h.hawker_center_name || null,
          today_cp: todayCp, yday_cp: ydayCp, prev_cp: ydayCp,
          daily_avg: days > 0 ? Math.round(mtdCp / days) : 0,
          supply_days: days,
          mtd: mtdCp, mtd_cp: mtdCp,
          prev_mtd: prevMtd,
          growth_pct: prevMtd > 0 ? r1((mtdCp - prevMtd) / prevMtd * 100) : null,
          ms_period: c.period || null,
          patrika_cp: hasComp ? patrikaCp : null,
          db_total: hasComp && dbTotal > 0 ? dbTotal : null,
          ms_pct: (hasComp && dbTotal > 0) ? r1(patrikaCp / dbTotal * 100) : null,
          competitors: [1, 2, 3, 4, 5]
            .map(i => ({ name: c[`comp${i}_name`] || null, copies: N(c[`comp${i}_supply`]) }))
            .filter(x => x.name && x.copies > 0),
        };
      });

      return res.json({
        exec_code: execCode, unit, unit_code: unit, as_on: asOn, prev_label: `${prevFrom} → ${prevTo}`,
        rows: out, hawkers: out,
        totals: {
          hawker_count: out.length, today_cp: totToday, mtd_cp: totMtd,
          db_total: totDbAll || null, patrika_cp: totPatrika || null,
          ms_pct: totDbAll > 0 ? r1(totPatrika / totDbAll * 100) : null,
        },
      });
    } catch (e) {
      console.error('ci-hawker-detail error:', e);
      return res.status(500).json({ detail: e.message });
    }
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

      // execCode (e.g. E01827) is the circulation exec code from exec_master/hawker_supply.
      // dcr_center_attendance.emp_code (e.g. R02073) is the Oracle HR employee code — different system.
      // Resolve by matching center_incharge_name (from hawker_supply) against executive_name in dcr_center_attendance.
      // Bound by supply_date: idx_hs_ci covers center_incharge alone, so an unbounded
      // lookup walks every row this CI has ever had across 10.9M rows (~40 s). Narrowing
      // to the two dates the panel already reads lets idx_hs_unit/idx_hs_date drive it (~0.1 s).
      const { rows: nameRows } = await q(
        `SELECT MAX(center_incharge_name) exec_name FROM hawker_supply
         WHERE center_incharge = ? AND supply_date BETWEEN ? AND ?${unitCode ? ' AND loc_id = ?' : ''}`,
        [execCode, prev, asOn, ...(unitCode ? [unitCode] : [])]);
      const execName = nameRows[0]?.exec_name || null;
      let empCode = execCode; // fallback
      if (execName) {
        const { rows: empRows } = await q(
          `SELECT emp_code FROM dcr_center_attendance WHERE executive_name = ?${unitCode ? ' AND unit_code = ?' : ''} AND emp_code IS NOT NULL LIMIT 1`,
          [execName, ...(unitCode ? [unitCode] : [])]);
        if (empRows[0]?.emp_code) empCode = empRows[0].emp_code;
      }

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

        // Center attendance summary: attn_type A=attendance, V=visit (use empCode from hierarchy_master)
        q(`SELECT
             COUNT(*) total,
             COUNT(DISTINCT attn_date) active_days,
             COUNT(DISTINCT CASE WHEN attn_type = 'A' OR attn_type IS NULL OR attn_type = '' THEN attn_date END) attendance_days,
             SUM(CASE WHEN attn_type = 'V' THEN 1 ELSE 0 END) visit_count
           FROM dcr_center_attendance
           WHERE emp_code = ? AND attn_date BETWEEN ? AND ?${ucWhereCa}`,
          [empCode, win.from, win.to, ...ucPCa]),

        // Recent attendance/visit rows with remarks (limit 15)
        q(`SELECT attn_date, attn_type, center_name, location_name, present_rmrk, closed_rmrk,
                  TIME(created_dt) attn_time, center_closed
           FROM dcr_center_attendance
           WHERE emp_code = ? AND attn_date BETWEEN ? AND ?${ucWhereCa}
           ORDER BY attn_date DESC, created_dt DESC
           LIMIT 15`,
          [empCode, win.from, win.to, ...ucPCa]),

        // Last hawker supply receipt entry time today
        q(`SELECT MAX(creation_date) last_entry, COUNT(*) txn_count
           FROM hawker_supply
           WHERE center_incharge = ? AND supply_date = ?${ucWhere}`,
          [execCode, today, ...ucP]),

        // Survey & orders: created_by = CI's mobile login number
        // Resolve mobile via hierarchy_master.employee_code → app_users
        q(`SELECT COUNT(DISTINCT sd.r_id) survey_count,
                  COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.r_id END) order_count
           FROM survey_data sd
           WHERE sd.created_by IN (
             SELECT au.mobile FROM app_users au
             INNER JOIN hierarchy_master hm ON hm.person_code = au.person_code
             WHERE hm.employee_code = ? AND au.mobile IS NOT NULL AND au.mobile != ''
           ) AND sd.bookdate BETWEEN ? AND ?`,
          [empCode, win.from, win.to]),
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
        emp_code: empCode,
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

  /* ── CI Hawker Detail — full hawker list with supply + market share ─────────
     Called from the Executive Performance full-page view for CI execs.
     Uses hawker_supply.center_incharge as source of truth — avoids stale hawker_master
     data from Oracle sync (no active-status filter). */
  /* ── CI Centre summary ────────────────────────────────────────────────────────
     Uses hawker_supply.center_incharge as source of truth (actual deliveries),
     NOT hawker_master.center_incharge_code which can have stale/historical data
     from Oracle due to hawker reassignments without a status filter in the sync.
     idx_hs_ci index on hawker_supply(center_incharge) makes this fast at 10M+ rows. */
  app.get('/api/command/ci-centers', cacheFor(CACHE_TTL_MS), async (req, res) => {
    try {
      const execCode = String(req.query.exec_code || '').trim();
      if (!execCode) return res.status(400).json({ detail: 'exec_code required' });
      const { asOn, prev } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range || 'mtd');

      // Step 1: get hawker IDs + supply totals from hawker_supply (authoritative CI mapping)
      const centreSql =
        `SELECT hs.hawker_id, hs.loc_id AS unit_code,
                SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) today_cp,
                SUM(CASE WHEN supply_date = ? THEN sup_copies ELSE 0 END) prev_cp,
                SUM(CASE WHEN supply_date BETWEEN ? AND ? THEN sup_copies ELSE 0 END) mtd_cp
         FROM hawker_supply hs
         WHERE hs.center_incharge = ?
           AND hs.supply_date BETWEEN ? AND ?
         GROUP BY hs.hawker_id, hs.loc_id`;

      let { rows: supRows } = await q(centreSql,
        [asOn, prev, win.from, asOn, execCode, win.from, asOn]);

      /* The Executive Performance screen opens on LAST month, and center_incharge is
         stamped per supply row — a handover only rewrites it from the handover date
         onward. So a CI who took a centre over this month has no rows in the default
         window and the page rendered "No centres found" for someone running 144
         hawkers. The centre list is a roster, not a time series: if the requested
         window predates them, fall back to the most recent window in which they were
         the incharge and say which window the roster came from. */
      let rosterFrom = win.from, rosterTo = asOn, rosterFellBack = false;
      if (!supRows.length) {
        const { rows: last } = await q(
          `SELECT MAX(supply_date) d FROM hawker_supply WHERE center_incharge = ?`, [execCode]);
        const lastDate = last[0] && last[0].d ? String(last[0].d).slice(0, 10) : null;
        if (lastDate) {
          rosterTo = lastDate;
          rosterFrom = lastDate.slice(0, 8) + '01';
          rosterFellBack = true;
          ({ rows: supRows } = await q(centreSql,
            [rosterTo, prev, rosterFrom, rosterTo, execCode, rosterFrom, rosterTo]));
        }
      }

      if (!supRows.length) return res.json({ exec_code: execCode, as_on: asOn, centers: [] });

      // Step 2: get centre metadata from hawker_master by hawker_id (fast, indexed)
      const hwkIds = supRows.map(r => r.hawker_id);
      const IN_PH  = hwkIds.map(() => '?').join(',');
      const { rows: hmRows } = await q(
        `SELECT hawker_id, hawker_center_code, hawker_center_name
         FROM hawker_master WHERE hawker_id IN (${IN_PH})`, hwkIds);
      const hmMap = {};
      hmRows.forEach(r => { hmMap[r.hawker_id] = r; });

      // Step 3: group by (unit_code from supply, center from master) + aggregate supply
      const supMap = {};
      supRows.forEach(r => { supMap[r.hawker_id] = r; });

      const centerMap = {};
      supRows.forEach(r => {
        const hm  = hmMap[r.hawker_id] || {};
        const key = `${r.unit_code}|${hm.hawker_center_code || '?'}`;
        if (!centerMap[key]) centerMap[key] = {
          unit_code:   r.unit_code,
          center_code: hm.hawker_center_code || '?',
          center_name: hm.hawker_center_name || '?',
          hawker_ids:  [],
        };
        centerMap[key].hawker_ids.push(r.hawker_id);
      });

      const result = Object.values(centerMap).map(c => {
        let today = 0, prevCp = 0, mtd = 0;
        c.hawker_ids.forEach(id => {
          const s = supMap[id] || {};
          today  += N(s.today_cp);
          prevCp += N(s.prev_cp);
          mtd    += N(s.mtd_cp);
        });
        return {
          unit_code:    c.unit_code,
          center_code:  c.center_code,
          center_name:  c.center_name,
          hawker_count: c.hawker_ids.length,
          today_cp:     today  || null,
          prev_cp:      prevCp || null,
          mtd_cp:       mtd    || null,
          growth_pct:   prevCp > 0 ? r1((today - prevCp) / prevCp * 100) : null,
        };
      }).sort((a, b) => (b.mtd_cp || 0) - (a.mtd_cp || 0));

      res.json({
        exec_code: execCode, as_on: asOn, centers: result,
        // Set when the roster could not be built from the requested window — the UI
        // says so rather than presenting another period's figures as the selected one.
        roster_from: rosterFrom, roster_to: rosterTo,
        roster_fallback: rosterFellBack || undefined,
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
  app.get('/api/command/state-movers', cacheFor(CACHE_TTL_MS), async (req, res) => {
    try {
      const stateKey = String(req.query.state || '').toUpperCase();
      const meta = STATES.find(s => s.key === stateKey);
      if (!meta) return res.status(400).json({ detail: 'Unknown state' });
      const { asOn } = await resolveDates(req.query.as_on, req.query.compare);
      const win = resolveRangeWindow(asOn, req.query.range);
      const allUnits = await unitsOfState(stateKey);
      const unitName = {}; allUnits.forEach(u => { unitName[u.unit_code] = u.unit_name; });
      const unitScope = String(req.query.unit_code || '').trim();
      // Same ceiling as the dashboard this list sits under.
      const _scope = await callerScope(req);
      const _allowed = _scope == null ? null : new Set(_scope);
      const units = (unitScope ? allUnits.filter(u => u.unit_code === unitScope) : allUnits)
        .filter(u => !_allowed || _allowed.has(u.unit_code));
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
                  MAX(executive_code) exec_code, MAX(dist_name) dist_name,
                  MAX(ag_class_name) ag_class
           FROM agency_master WHERE CAST(dpcd AS UNSIGNED)=1 AND unit IN (${IN})
           GROUP BY unit, agcd`, codes),
        q(`SELECT unit_code, ag_code, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) os
           FROM agency_outstanding WHERE period_label='CURRENT' AND unit_code IN (${IN})
           GROUP BY unit_code, ag_code`, codes),
      ]);
      const M = {}; master.rows.forEach(r => { M[`${r.unit}|${r.agcd}`] = r; });
      const O = {}; os.rows.forEach(r => { O[`${r.unit_code}|${r.ag_code}`] = N(r.os); });

      const movSeg = ['agent', 'cash', 'all'].includes(req.query.seg) ? req.query.seg : 'all';
      const movers = mov.rows.map(r => {
        const k = `${r.unit_code}|${r.agcd}`, m = M[k] || {};
        const cur = N(r.cur_days) ? Math.round(N(r.cur_sum) / N(r.cur_days)) : 0;
        const prv = N(r.prv_days) ? Math.round(N(r.prv_sum) / N(r.prv_days)) : 0;
        return {
          unit_code: r.unit_code, unit_name: unitName[r.unit_code] || r.unit_code, agcd: r.agcd,
          ag_name: m.ag_name || r.agcd, dist_name: m.dist_name || null,
          exec: m.exec_name || null, exec_code: m.exec_code || null,
          ag_class: m.ag_class || null,
          current: cur, previous: prv, diff: cur - prv, growth_pct: r1(pct(cur, prv)),
          outstanding: O[k] || 0,
        };
      }).filter(m => m.diff !== 0)
        /* Respect the Agent / Cash toggle, as every other panel on this page does. The
           list mixed both, so RLY STATION CENTER and VATIKA CENTER — DIRECT SALE I,
           city sale — appeared while the page was filtered to Agent Sale (Credit). */
        .filter(m => movSeg === 'all' ? true
                   : movSeg === 'cash'  ? m.ag_class === 'DIRECT SALE I'
                   : m.ag_class === 'CREDIT SALE');

      res.json({
        state: stateKey, unit_code: unitScope || null, seg: movSeg,
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
                 WHERE ag_class_name='CREDIT SALE') cm
             ON cm.unit = s.unit_code AND cm.agcd = s.agcd
           WHERE s.sup_type_code='S01' AND COALESCE(s.publ,'') NOT IN ('P14')
             AND s.supply_date IN (?, ?) AND ${stCl}
           GROUP BY s.unit_code ORDER BY (SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END) -
                                          SUM(CASE WHEN s.supply_date = ? THEN s.sup_copy ELSE 0 END)) ASC LIMIT 12`,
          [asOn, prev, asOn, prev, ...stP, asOn, prev]);
        return res.json({ kpi, state: stateKey, as_on: asOn, previous: prev,
          columns: ['Branch', 'Now', 'Previous', 'Change'],
          rows: rows.filter(r => !CLOSED_UNITS.has(r.unit_code))
            .map(r => ({ label: r.unit_name || r.unit_code, unit_code: r.unit_code,
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
        // Closed branches would otherwise top this list — nobody visits them, so they
        // read as the worst coverage gaps when there is nothing left to cover.
        const rows = book.rows.filter(r => !CLOSED_UNITS.has(r.unit)).map(r => ({
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
          priority: 'high', state: s.key, state_name: s.name, type: 'Supply vs credit imbalance', kpi: 'Outstanding',
          title: `${s.name}: outstanding growing ${s.os.growth_pct}% against supply ${s.supply.growth_pct}%`,
          impact: `Credit is expanding faster than volume — ${inr(s.os.current)} tied up. Converting even 10% releases ${inr(s.os.current * 0.1)}.`,
          action: 'Recover from high-dues agencies, then push supply where credit is clean.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
      if (s.collection.collection_pct != null && s.collection.collection_pct >= 60 && s.collection.collection_pct < 90 && s.collection.gap > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Collection recovery', kpi: 'Collection',
          title: `${s.name}: ${inr(s.collection.gap)} recoverable this month`,
          impact: `At ${s.collection.collection_pct}% collected, closing the gap lifts the state to full realisation of ${s.collection.prev_month_label} billing.`,
          action: 'Target the largest short-paid agencies — see Short Payment.',
          drill: { screen: 'collections', state: s.key },
        });
      }
      if (s.dcr.coverage_pct != null && s.dcr.coverage_pct >= 2 && s.dcr.agencies_total - s.dcr.agencies_visited > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Coverage gap', kpi: 'DCR',
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
        priority: 'low', state: best.key, state_name: best.name, type: 'Replicate what works', kpi: 'Supply',
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
          priority: 'medium', state: s.key, state_name: s.name, type: 'Working capital released', kpi: 'Outstanding',
          title: `${s.name}: outstanding down ${Math.abs(s.os.growth_pct)}%`,
          impact: `${inr(Math.abs(s.os.diff))} recovered since ${s.os.prev_label}, bringing dues to ${inr(s.os.current)}.`,
          action: 'Hold the recovery discipline that produced this and extend it to the remaining critical agencies.',
          drill: { screen: 'outstanding', state: s.key },
        });
      }
      if (s.supply.growth_pct != null && s.supply.growth_pct > 0 && s.supply.diff > 0) {
        out.push({
          priority: 'medium', state: s.key, state_name: s.name, type: 'Volume momentum', kpi: 'Supply',
          title: `${s.name}: supply up ${s.supply.growth_pct}%`,
          impact: `${cp(s.supply.diff)} copies added per day — ${cp(s.supply.diff * 30)} a month if it holds.`,
          action: 'Find the branches driving it and set the same push as the target elsewhere.',
          drill: { screen: 'supply_dash', state: s.key },
        });
      }
      if (s.os.critical_agencies > 0 && s.os.agencies > 0 && s.os.current > 0) {
        const share = r1((s.os.critical_agencies / s.os.agencies) * 100);
        out.push({
          priority: 'low', state: s.key, state_name: s.name, type: 'Concentrated recovery', kpi: 'Outstanding',
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
