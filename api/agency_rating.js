'use strict';
/**
 * agency_rating.js — Agency Rating Engine (Circulation)
 *
 * Endpoints (auth-required):
 *   GET  /api/agency-rating/config           — get scoring config
 *   POST /api/agency-rating/config           — save config (admin only)
 *   GET  /api/agency-rating/filters          — states + units for dropdowns
 *   GET  /api/agency-rating/summary          — grade-wise summary cards
 *   GET  /api/agency-rating/list             — paginated rated agency list
 *   GET  /api/agency-rating/agency/:u/:ag    — full agency detail + history
 *
 * Scoring data sources (READ-ONLY MySQL):
 *   Base:    agency_outstanding CURRENT  (YTD billing, collection, supply stats)
 *   Monthly: agency_outstanding 2026-01…2026-07  (historical trend)
 *   Detail:  agency_collection, supply_data
 */

module.exports = function registerAgencyRating({ app, q, getScopeUnitCodes }) {
  const N  = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const R1 = v => v == null ? null : Math.round(Number(v) * 10) / 10;

  // ── Default config ───────────────────────────────────────────────────────────
  const DEFAULT_CONFIG = {
    businessWeight: 0.40,
    paymentWeight:  0.60,
    thresholds: { AAA: 90, AA: 80, A: 70, BBB: 60, BB: 50, B: 40, C: 28 },
    bw: { regularity: 0.35, volume: 0.30, tenure: 0.20, recency: 0.15 },
    pw: { collection: 0.45, outstanding: 0.30, security: 0.15, trend: 0.10 },
  };

  let _configCache = null;
  const GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'High Risk'];

  async function getConfig() {
    if (_configCache) return _configCache;
    try {
      await q(`CREATE TABLE IF NOT EXISTS agency_rating_config (
        id  INT NOT NULL DEFAULT 1,
        cfg JSON NOT NULL,
        upd TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB`);
      const { rows } = await q('SELECT cfg FROM agency_rating_config WHERE id = 1');
      _configCache = rows.length
        ? Object.assign({}, DEFAULT_CONFIG, JSON.parse(rows[0].cfg))
        : Object.assign({}, DEFAULT_CONFIG);
    } catch { _configCache = Object.assign({}, DEFAULT_CONFIG); }
    return _configCache;
  }

  async function saveConfig(cfg) {
    await q(`INSERT INTO agency_rating_config (id, cfg) VALUES (1, ?)
             ON DUPLICATE KEY UPDATE cfg = VALUES(cfg)`, [JSON.stringify(cfg)]);
    _configCache = cfg;
    _ratingCache.clear();
  }

  // ── Scoring ───────────────────────────────────────────────────────────────────
  function getGrade(score, thr) {
    if (score >= thr.AAA) return 'AAA';
    if (score >= thr.AA)  return 'AA';
    if (score >= thr.A)   return 'A';
    if (score >= thr.BBB) return 'BBB';
    if (score >= thr.BB)  return 'BB';
    if (score >= thr.B)   return 'B';
    if (score >= thr.C)   return 'C';
    return 'High Risk';
  }

  // Days elapsed in current financial year (starting Jan 2026)
  const YR_START      = new Date('2026-01-01').getTime();
  const DAYS_ELAPSED  = Math.max(1, Math.floor((Date.now() - YR_START) / 86400000));

  function computeScore(agency, unitMedians, cfg) {
    const { bw, pw } = cfg;

    // ── Business components ──────────────────────────────────────────────────
    const supplyDays = N(agency.supply_days);
    const dayCopies  = N(agency.day_copies);
    const supStart   = agency.supply_start_dt || agency.supply_start;
    const lastSup    = agency.last_supply_date;

    // 1. Supply regularity — fraction of year the agency was supplied
    const regularity = Math.min(100, supplyDays / DAYS_ELAPSED * 100);

    // 2. Volume — normalized vs unit median daily copies
    const med = (unitMedians && unitMedians[agency.unit_code]) || 1;
    const volume = dayCopies > 0 ? Math.min(100, (dayCopies / med) * 60) : 0;

    // 3. Tenure — years since first supply
    let tenureScore = 50;
    if (supStart) {
      const yrs = (Date.now() - new Date(supStart).getTime()) / (365.25 * 86400000);
      tenureScore = yrs >= 5 ? 100 : yrs >= 3 ? 80 : yrs >= 1 ? 60 : 30;
    }

    // 4. Recency — days since last supply
    let recencyScore = 50;
    if (lastSup) {
      const d = Math.floor((Date.now() - new Date(lastSup).getTime()) / 86400000);
      recencyScore = d <= 3 ? 100 : d <= 7 ? 90 : d <= 14 ? 75 : d <= 30 ? 55 : d <= 60 ? 35 : 15;
    }

    const businessScore = Math.min(100, R1(
      regularity   * bw.regularity +
      volume       * bw.volume     +
      tenureScore  * bw.tenure     +
      recencyScore * bw.recency
    ));

    // ── Payment components ───────────────────────────────────────────────────
    const recAmt = N(agency.rec_amt);
    const bilAmt = N(agency.bill_amt);
    const clAmt  = N(agency.cl_amt);
    const opAmt  = N(agency.op_amt);
    const secBal = N(agency.security_bal);
    const reqSec = N(agency.req_security);
    const totalExp = opAmt + bilAmt;

    // 1. Collection ratio — how much of total exposure was collected YTD
    let collectionScore = 75;
    if (totalExp > 0) {
      const pct = Math.min(100, recAmt / totalExp * 100);
      collectionScore = pct >= 95 ? pct
        : pct >= 80 ? 75 + (pct - 80) * 1.0
        : pct >= 60 ? 45 + (pct - 60) * 1.5
        : pct * 0.75;
    }

    // 2. Outstanding burden — cl_amt / bill_amt (lower is better)
    let ouScore = 100;
    if (bilAmt > 0) {
      ouScore = Math.max(0, 100 - (clAmt / bilAmt) * 100);
    } else if (clAmt > 0) {
      ouScore = 20;
    }

    // 3. Security coverage
    let secScore = 75;
    if (reqSec > 0) secScore = Math.min(100, secBal / reqSec * 100);

    // 4. Trend — is outstanding growing or paying down?
    let trendScore = 65;
    if (bilAmt > 0 && totalExp > 0) {
      const ratio = clAmt / totalExp;
      trendScore = ratio <= 0.05 ? 100
        : ratio <= 0.15 ? 85
        : ratio <= 0.30 ? 65
        : ratio <= 0.60 ? 40
        : 20;
    }

    const paymentScore = Math.min(100, R1(
      collectionScore * pw.collection +
      ouScore         * pw.outstanding +
      secScore        * pw.security   +
      trendScore      * pw.trend
    ));

    const composite = Math.min(100, R1(businessScore * cfg.businessWeight + paymentScore * cfg.paymentWeight));
    const collPct   = totalExp > 0 ? R1(recAmt / totalExp * 100) : null;
    const ouPct     = bilAmt  > 0 ? R1(clAmt  / bilAmt  * 100) : null;

    return {
      businessScore,
      paymentScore,
      composite,
      grade: getGrade(composite, cfg.thresholds),
      breakdown: {
        regularity:     R1(regularity),
        volume:         R1(volume),
        tenure:         R1(tenureScore),
        recency:        R1(recencyScore),
        collection:     R1(collectionScore),
        outstanding:    R1(ouScore),
        security:       R1(secScore),
        trend:          R1(trendScore),
        collection_pct: collPct,
        outstanding_pct: ouPct,
      },
    };
  }

  // ── Rating cache (5-min TTL) + pending-promise map (prevents stampede) ────────
  const _ratingCache   = new Map();
  const _ratingPending = new Map();
  const RATING_TTL     = 5 * 60 * 1000;

  async function computeAllRatings(unitList) {
    const key = unitList === null ? '__all__' : [...unitList].sort().join(',');
    const hit = _ratingCache.get(key);
    if (hit && (Date.now() - hit.ts) < RATING_TTL) return hit.data;

    // Prevent stampede: if a query for this key is already in flight, await it
    if (_ratingPending.has(key)) return _ratingPending.get(key);

    const promise = _doComputeAllRatings(key, unitList);
    _ratingPending.set(key, promise);
    try { return await promise; } finally { _ratingPending.delete(key); }
  }

  async function _doComputeAllRatings(key, unitList) {
    const cfg = await getConfig();
    const ucl  = unitList === null  ? ''
      : !unitList.length            ? ' AND 1=0'
      : ` AND unit_code IN (${unitList.map(() => '?').join(',')})`;
    const uclP = unitList === null || !unitList.length ? [] : unitList;

    // Query 1: outstanding (fast — uses composite index idx_ao_period_status_unit)
    const { rows: aoRows } = await q(`
      SELECT unit_code, ag_code, ag_name, unit_name, group_unit_name,
             exec_code, exec_name,
             bill_amt, rec_amt, cl_amt, op_amt, net_receipt,
             supply_days, day_copies, total_copies,
             security_bal, req_security, sec_diff,
             ag_status, ag_type, supply_start, last_supply_date, mobno
      FROM agency_outstanding
      WHERE period_label = 'CURRENT' AND ag_status = 'Active'${ucl}
    `, uclP);

    if (!aoRows.length) {
      _ratingCache.set(key, { data: [], ts: Date.now() });
      return [];
    }

    // Query 2: agency_master for matching units only — small IN list, fast index hit
    const unitCodes = [...new Set(aoRows.map(r => r.unit_code))];
    const ucIn  = unitCodes.length ? unitCodes.map(() => '?').join(',') : "'__none__'";
    const ucP   = unitCodes.length ? unitCodes : [];

    const { rows: amRows } = await q(`
      SELECT unit, agcd,
             unit_state_nm, ag_type_name, ag_class_name,
             city_name, dist_name, supply_start_dt, supply_stop_flag, mobile_no1
      FROM agency_master
      WHERE unit IN (${ucIn})
    `, ucP);

    // Build lookup map: "unit|agcd" → master row (first encountered per pair)
    const amMap = new Map();
    for (const r of amRows) {
      const k = `${r.unit}|${r.agcd}`;
      if (!amMap.has(k)) amMap.set(k, r);
    }

    const rows = aoRows.map(r => {
      const am = amMap.get(`${r.unit_code}|${r.ag_code}`) || {};
      return { ...r, ...am };
    });

    // Build unit-level day_copies medians for volume normalization
    const unitGroups = {};
    for (const r of rows) {
      const dc = N(r.day_copies);
      if (dc > 0) {
        if (!unitGroups[r.unit_code]) unitGroups[r.unit_code] = [];
        unitGroups[r.unit_code].push(dc);
      }
    }
    const medians = {};
    for (const [u, vals] of Object.entries(unitGroups)) {
      vals.sort((a, b) => a - b);
      medians[u] = vals[Math.floor(vals.length / 2)] || 1;
    }

    const rated = rows.map(r => {
      const s = computeScore(r, medians, cfg);
      return {
        unit_code:     r.unit_code,
        unit_name:     r.unit_name,
        ag_code:       r.ag_code,
        ag_name:       r.ag_name,
        unit_state_nm: r.unit_state_nm,
        ag_type_name:  r.ag_type_name,
        ag_class_name: r.ag_class_name,
        city_name:     r.city_name,
        dist_name:     r.dist_name,
        exec_code:     r.exec_code,
        exec_name:     r.exec_name,
        bill_amt:      N(r.bill_amt),
        rec_amt:       N(r.rec_amt),
        cl_amt:        N(r.cl_amt),
        op_amt:        N(r.op_amt),
        supply_days:   N(r.supply_days),
        day_copies:    N(r.day_copies),
        mobile_no1:    r.mobile_no1 || r.mobno,
        ...s,
      };
    });

    _ratingCache.set(key, { data: rated, ts: Date.now() });
    if (_ratingCache.size > 30) {
      const cut = Date.now() - RATING_TTL * 2;
      for (const [k, v] of _ratingCache) if (v.ts < cut) _ratingCache.delete(k);
    }
    return rated;
  }

  async function buildUnitList(req) {
    const pc     = req.auth ? (req.auth.personCode || '') : '';
    const hl     = req.auth ? (req.auth.hierarchyLevel || 1) : 1;
    const scoped = await getScopeUnitCodes(pc, hl);
    const ru     = String(req.query.unit_code || '').trim();
    const rs     = String(req.query.state     || '').trim();
    if (ru) {
      if (scoped && !scoped.includes(ru)) return [];
      return [ru];
    }
    if (rs) {
      const { rows } = await q('SELECT DISTINCT unit FROM agency_master WHERE unit_state_nm = ?', [rs]);
      let units = rows.map(r => r.unit);
      if (scoped) units = units.filter(u => scoped.includes(u));
      return units;
    }
    return scoped;
  }

  // ── Signals ───────────────────────────────────────────────────────────────────
  function buildSignals(curr, hist, collHist) {
    const sig = [];
    const cl  = N(curr.cl_amt), bil = N(curr.bill_amt);
    const rec = N(curr.rec_amt), op  = N(curr.op_amt);
    const secB = N(curr.security_bal), reqS = N(curr.req_security);
    const exp  = op + bil;
    const cpct = exp > 0 ? rec / exp * 100 : 100;

    if      (cpct >= 95) sig.push({ type: 'green',  text: 'Dues current and within terms' });
    else if (cpct >= 80) sig.push({ type: 'green',  text: `Collection at ${R1(cpct)}% — above target` });
    else if (cpct < 50)  sig.push({ type: 'red',    text: `Collection only ${R1(cpct)}% — high credit risk` });
    else                 sig.push({ type: 'yellow',  text: `Collection at ${R1(cpct)}% of exposure` });

    if (hist.length >= 2) {
      const d = N(hist[0].cl_amt) - N(hist[1].cl_amt);
      if (d > Math.max(1000, bil * 0.05))
        sig.push({ type: 'yellow', text: 'Outstanding increased in last billing period' });
      else if (d < -Math.max(1000, bil * 0.05))
        sig.push({ type: 'green',  text: 'Outstanding reduced in last billing period' });
    }

    if (reqS > 0) {
      if (secB >= reqS)           sig.push({ type: 'green',  text: 'Security deposit adequate' });
      else if (secB >= reqS * 0.5) sig.push({ type: 'yellow', text: 'Security deposit below required level' });
      else                        sig.push({ type: 'red',    text: 'Security deposit critically low' });
    }

    if (cl > bil * 2 && cl > 50000)
      sig.push({ type: 'red', text: 'Outstanding exceeds 2× billing — overdue risk' });
    else if (cl <= 0 && bil > 0)
      sig.push({ type: 'green', text: 'No outstanding — account fully cleared' });

    if (collHist.length >= 3) {
      const paid = collHist.slice(0, 3).filter(m => N(m.collection) > 0).length;
      if (paid === 3) sig.push({ type: 'green',  text: 'Payments received in last 3 consecutive months' });
      else if (paid === 0) sig.push({ type: 'red', text: 'No payment received in last 3 months' });
      else sig.push({ type: 'yellow', text: 'Irregular payment pattern over last 3 months' });
    }

    return sig;
  }

  // ── CONFIG ENDPOINTS ──────────────────────────────────────────────────────────
  app.get('/api/agency-rating/config', async (req, res) => {
    try { res.json(await getConfig()); }
    catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  app.post('/api/agency-rating/config', async (req, res) => {
    if (!req.auth || req.auth.hierarchyLevel !== 1)
      return res.status(403).json({ detail: 'Admin only' });
    try {
      const incoming = req.body;
      const bw = Math.max(0.05, Math.min(0.95, Number(incoming.businessWeight) || 0.4));
      const cfg = Object.assign({}, DEFAULT_CONFIG, incoming, {
        businessWeight: Math.round(bw * 100) / 100,
        paymentWeight:  Math.round((1 - bw) * 100) / 100,
      });
      await saveConfig(cfg);
      res.json({ ok: true, config: cfg });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── FILTERS ───────────────────────────────────────────────────────────────────
  app.get('/api/agency-rating/filters', async (req, res) => {
    try {
      const pc     = req.auth ? (req.auth.personCode || '') : '';
      const hl     = req.auth ? (req.auth.hierarchyLevel || 1) : 1;
      const scoped = await getScopeUnitCodes(pc, hl);
      const sc  = scoped ? ` AND unit IN (${scoped.map(() => '?').join(',')})` : '';
      const scP = scoped || [];
      const [states, units] = await Promise.all([
        q(`SELECT DISTINCT unit_state_nm state FROM agency_master
           WHERE unit_state_nm IS NOT NULL AND unit_state_nm != ''${sc}
           ORDER BY unit_state_nm`, scP),
        q(`SELECT DISTINCT unit unit_code, MAX(unit_name) unit_name, MAX(unit_state_nm) state_nm
           FROM agency_master WHERE 1=1${sc} GROUP BY unit ORDER BY unit_name`, scP),
      ]);
      res.json({ states: states.rows.map(r => r.state), units: units.rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── SUMMARY (grade cards) ────────────────────────────────────────────────────
  app.get('/api/agency-rating/summary', async (req, res) => {
    try {
      const unitList = await buildUnitList(req);
      const all = await computeAllRatings(unitList);
      const map = {};
      for (const g of GRADES) map[g] = { count: 0, outstanding: 0, supply: 0 };
      for (const r of all) {
        const g = r.grade;
        map[g].count++;
        map[g].outstanding += r.cl_amt;
        map[g].supply      += r.day_copies;
      }
      res.json({
        total: all.length,
        cards: GRADES.map(g => ({
          grade:       g,
          count:       map[g].count,
          outstanding: Math.round(map[g].outstanding),
          supply:      Math.round(map[g].supply),
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── LIST ──────────────────────────────────────────────────────────────────────
  app.get('/api/agency-rating/list', async (req, res) => {
    try {
      const unitList  = await buildUnitList(req);
      const grade     = String(req.query.grade   || '').trim();
      const search    = String(req.query.search  || '').trim().toLowerCase();
      const execCode  = String(req.query.exec    || '').trim();
      const sort      = String(req.query.sort    || 'composite');
      const dir       = String(req.query.dir     || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
      const page      = Math.max(1, parseInt(req.query.page     || '1',  10));
      const perPage   = Math.min(200, Math.max(10, parseInt(req.query.per_page || '50', 10)));

      let all = await computeAllRatings(unitList);

      if (grade)    all = all.filter(r => r.grade === grade);
      if (execCode) all = all.filter(r => r.exec_code === execCode);
      if (search)   all = all.filter(r =>
        (r.ag_name || '').toLowerCase().includes(search) ||
        (r.ag_code || '').toLowerCase().includes(search) ||
        (r.city_name || '').toLowerCase().includes(search));

      const SORT_KEYS = {
        composite: 'composite', business: 'businessScore', payment: 'paymentScore',
        supply: 'day_copies', collection: 'rec_amt', outstanding: 'cl_amt', name: 'ag_name',
      };
      const sk = SORT_KEYS[sort] || 'composite';
      all.sort((a, b) => {
        const av = a[sk], bv = b[sk];
        if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        return dir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0);
      });

      const total  = all.length;
      const offset = (page - 1) * perPage;
      const rows   = all.slice(offset, offset + perPage).map((r, i) => ({
        rank: offset + i + 1,
        ag_code:        r.ag_code,
        ag_name:        r.ag_name,
        unit_code:      r.unit_code,
        unit_name:      r.unit_name,
        unit_state_nm:  r.unit_state_nm,
        city_name:      r.city_name,
        exec_name:      r.exec_name,
        exec_code:      r.exec_code,
        grade:          r.grade,
        composite:      r.composite,
        businessScore:  r.businessScore,
        paymentScore:   r.paymentScore,
        day_copies:     r.day_copies,
        bill_amt:       r.bill_amt,
        rec_amt:        r.rec_amt,
        cl_amt:         r.cl_amt,
        breakdown:      r.breakdown,
      }));

      res.json({ total, total_pages: Math.ceil(total / perPage) || 1, page, per_page: perPage, rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── AGENCY DETAIL ────────────────────────────────────────────────────────────
  app.get('/api/agency-rating/agency/:unit_code/:ag_code', async (req, res) => {
    try {
      const { unit_code, ag_code } = req.params;

      const [agR, currR, histR, collHistR, supHistR] = await Promise.all([
        q(`SELECT ag_name, ag_type_name, ag_class_name, city_name, dist_name,
                  unit_name, unit_state_nm, mobile_no1, email_id,
                  supply_start_dt, supply_stop_flag, suspend_date,
                  executive_code, executive_name
           FROM agency_master WHERE unit = ? AND agcd = ? LIMIT 1`,
          [unit_code, ag_code]),

        q(`SELECT * FROM agency_outstanding
           WHERE period_label = 'CURRENT' AND unit_code = ? AND ag_code = ? LIMIT 1`,
          [unit_code, ag_code]),

        // Monthly YTD snapshots (chronological)
        q(`SELECT period_label, period_from, period_to,
                  bill_amt, rec_amt, cl_amt, op_amt, net_receipt,
                  supply_days, day_copies, total_copies
           FROM agency_outstanding
           WHERE unit_code = ? AND ag_code = ?
             AND period_label REGEXP '^[0-9]{4}-[0-9]{2}$'
           ORDER BY period_label DESC LIMIT 12`,
          [unit_code, ag_code]),

        // Collection history last 12 months
        q(`SELECT DATE_FORMAT(coll_date,'%Y-%m') month,
                  -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) collection,
                   SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) charges,
                   COUNT(*) txn_count, MAX(coll_date) last_date
           FROM agency_collection
           WHERE unit_code = ? AND ag_code = ? AND is_valid = 1
             AND coll_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 12`,
          [unit_code, ag_code]),

        // Supply history last 12 months (S01 = regular)
        q(`SELECT DATE_FORMAT(supply_date,'%Y-%m') month,
                  SUM(sup_copy) total_supply,
                  COUNT(DISTINCT supply_date) supply_days,
                  MAX(supply_date) last_supply
           FROM supply_data
           WHERE unit_code = ? AND agcd = ? AND sup_type_code = 'S01'
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 12`,
          [unit_code, ag_code]),
      ]);

      const ag   = agR.rows[0]      || {};
      const curr = currR.rows[0]    || {};
      const cfg  = await getConfig();

      const scores = computeScore(
        { ...curr, supply_start_dt: ag.supply_start_dt, unit_code },
        {}, cfg
      );

      const bil = N(curr.bill_amt), rec = N(curr.rec_amt);
      const cl  = N(curr.cl_amt),   op  = N(curr.op_amt);
      const exp = op + bil;

      res.json({
        agency: {
          unit_code, ag_code,
          ag_name:         ag.ag_name || curr.ag_name,
          ag_type_name:    ag.ag_type_name,
          ag_class_name:   ag.ag_class_name,
          city_name:       ag.city_name,
          dist_name:       ag.dist_name,
          unit_name:       ag.unit_name || curr.unit_name,
          unit_state_nm:   ag.unit_state_nm,
          mobile_no1:      ag.mobile_no1 || curr.mobno,
          email_id:        ag.email_id,
          supply_start_dt: ag.supply_start_dt || curr.supply_start,
          supply_stop_flag: ag.supply_stop_flag,
          suspend_date:    ag.suspend_date,
          executive_code:  ag.executive_code || curr.exec_code,
          executive_name:  ag.executive_name || curr.exec_name,
          ag_status:       curr.ag_status,
          status: ag.suspend_date ? 'Suspended' : (ag.supply_stop_flag === 'Y' ? 'Stopped' : 'Active'),
        },
        current: {
          bill_amt:       N(curr.bill_amt),
          rec_amt:        N(curr.rec_amt),
          cl_amt:         N(curr.cl_amt),
          op_amt:         N(curr.op_amt),
          net_receipt:    N(curr.net_receipt),
          supply_days:    N(curr.supply_days),
          day_copies:     N(curr.day_copies),
          total_copies:   N(curr.total_copies),
          security_bal:   N(curr.security_bal),
          req_security:   N(curr.req_security),
          sec_diff:       N(curr.sec_diff),
          collection_pct: exp > 0 ? R1(rec / exp * 100) : null,
          outstanding_pct: bil > 0 ? R1(cl  / bil * 100) : null,
        },
        rating: {
          composite:     scores.composite,
          grade:         scores.grade,
          businessScore: scores.businessScore,
          paymentScore:  scores.paymentScore,
          breakdown:     scores.breakdown,
        },
        signals:      buildSignals(curr, histR.rows, collHistR.rows),
        history:      histR.rows,
        coll_history: collHistR.rows,
        sup_history:  supHistR.rows,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
