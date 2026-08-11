'use strict';
/**
 * agent_app.js — Live-data endpoints for the Agent (Agency) web app.
 *
 * A logged-in agent is resolved to the agency (or agencies) they own via agency_master,
 * matched on mobile_no1 = their login mobile, or agcd = their app_users.person_code.
 * All agency data (supply, billing, outstanding, collections) is then keyed by the
 * agency's (unit_code, agcd). ag_code alone is NOT unique across units, so every
 * agency-scoped query is filtered by BOTH unit and code.
 *
 * Read-only. Scope is enforced server-side: an agent may only read agencies resolved
 * for their own session. Admins (hierarchy_level 1) may pass an explicit ?unit=&agcd=
 * to inspect any agency (for support/testing).
 *
 * Installed from server.js:  require('./agent_app')({ app, q });
 */
module.exports = function installAgentApp({ app, q }) {

  const num = v => (v == null ? 0 : Number(v) || 0);
  const iso = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const isMonth = s => /^\d{4}-\d{2}$/.test(String(s || ''));
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  // Only current + last 6 calendar months are allowed (older data is hidden in-app).
  function monthAllowed(ym) {
    if (!isMonth(ym)) return false;
    const now = new Date(); const [y, m] = ym.split('-').map(Number);
    const cur = now.getFullYear() * 12 + now.getMonth();
    const req = y * 12 + (m - 1);
    return req <= cur && req >= cur - 6;
  }
  function prevMonthLabel(ym) { let [y, m] = ym.split('-').map(Number); m -= 1; if (m < 1) { m = 12; y -= 1; } return `${y}-${String(m).padStart(2, '0')}`; }

  async function ensureSchema() {
    await q(`CREATE TABLE IF NOT EXISTS agent_feedback (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      unit_code VARCHAR(10), agcd VARCHAR(30), ag_name VARCHAR(300),
      category VARCHAR(60), rating TINYINT, message TEXT, submitted_by VARCHAR(20)) CHARACTER SET utf8mb4`);
    await q(`CREATE TABLE IF NOT EXISTS agent_competitor (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      report_date DATE, unit_code VARCHAR(10), agcd VARCHAR(30), ag_name VARCHAR(300),
      competitor VARCHAR(120), copies INT, remarks TEXT, submitted_by VARCHAR(20)) CHARACTER SET utf8mb4`);
  }
  ensureSchema().catch(e => console.warn('[agent] schema init:', e.message));

  function auth(req) {
    const a = req.auth || {};
    return {
      mobile: a.mobile || req.headers['x-user-mobile'] || null,
      personCode: a.personCode || req.headers['x-person-code'] || null,
      hl: a.hierarchyLevel != null ? a.hierarchyLevel
        : (req.headers['x-hierarchy-level'] ? parseInt(req.headers['x-hierarchy-level'], 10) : null),
    };
  }

  // Resolve the agencies this session may access. Returns [] if none.
  async function resolveAgencies(req) {
    const { mobile, personCode } = auth(req);
    const digits = String(mobile || '').replace(/\D/g, '');
    const conds = [], params = [];
    if (digits) {
      // mobile_no1 may be stored with or without a leading 0 / country code — match on trailing 10 digits
      conds.push("RIGHT(REGEXP_REPLACE(COALESCE(mobile_no1,''),'[^0-9]',''),10) = RIGHT(?,10)");
      params.push(digits);
    }
    if (personCode) { conds.push('agcd = ?'); params.push(personCode); }
    if (!conds.length) return [];
    // Access rule: inactive / closed / suspended / supply-stopped agencies cannot access the app.
    const { rows } = await q(
      `SELECT unit AS unit_code, unit_name, agcd, dpcd, ag_name, ag_class_name, ag_type_name,
              city_name, dist_name, state_name, mobile_no1 AS mobile, executive_name,
              supply_start_dt, supply_stop_flag
         FROM agency_master
        WHERE (${conds.join(' OR ')})
          AND COALESCE(supply_stop_flag,'N') <> 'Y'
          AND (suspend_date IS NULL OR suspend_date > CURDATE())
        ORDER BY (state_name='RAJASTHAN') DESC, ag_name
        LIMIT 50`, params);
    return rows;
  }

  // Pick the (unit, agcd) to serve: requested if allowed, else the primary resolved agency.
  async function pickAgency(req) {
    const agencies = await resolveAgencies(req);
    const { hl } = auth(req);
    const wantUnit = String(req.query.unit || '').trim();
    const wantAgcd = String(req.query.agcd || '').trim();

    if (wantUnit && wantAgcd) {
      const hit = agencies.find(a => a.unit_code === wantUnit && a.agcd === wantAgcd);
      if (hit) return { agency: hit, agencies };
      if (hl === 1) { // admin may inspect any agency
        const { rows } = await q(
          `SELECT unit AS unit_code, unit_name, agcd, dpcd, ag_name, ag_class_name, ag_type_name,
                  city_name, dist_name, state_name, mobile_no1 AS mobile, executive_name
             FROM agency_master WHERE unit=? AND agcd=? LIMIT 1`, [wantUnit, wantAgcd]);
        if (rows[0]) return { agency: rows[0], agencies: agencies.length ? agencies : [rows[0]], admin: true };
      }
      return { agency: null, agencies, denied: true };
    }
    return { agency: agencies[0] || null, agencies };
  }

  // GET /api/agent/context — who am I, which agency/agencies
  app.get('/api/agent/context', async (req, res) => {
    try {
      const agencies = await resolveAgencies(req);
      res.json({ agencies, primary: agencies[0] || null, count: agencies.length });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/summary?unit=&agcd= — dashboard KPIs
  app.get('/api/agent/summary', async (req, res) => {
    try {
      const { agency, agencies, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, agencies, note: 'No agency linked to this login.' });
      const { unit_code, agcd } = agency;

      const [latest, os, colMonth] = await Promise.all([
        q(`SELECT MAX(supply_date) mx FROM supply_data WHERE unit_code=? AND agcd=?`, [unit_code, agcd]),
        q(`SELECT op_amt, bill_amt, rec_amt, cl_amt, total_copies, day_copies
             FROM agency_outstanding WHERE period_label='CURRENT' AND unit_code=? AND ag_code=? LIMIT 1`, [unit_code, agcd]),
        q(`SELECT -SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) received, MAX(coll_date) last_date
             FROM agency_collection
            WHERE is_valid=1 AND unit_code=? AND ag_code=? AND coll_date >= DATE_FORMAT(CURDATE(),'%Y-%m-01')`, [unit_code, agcd]),
      ]);
      const latestDate = latest.rows[0] && latest.rows[0].mx ? iso(latest.rows[0].mx) : null;

      let todayCopies = 0, byPub = [];
      if (latestDate) {
        const bp = await q(
          `SELECT publ_name, SUM(sup_copy) copies FROM supply_data
            WHERE unit_code=? AND agcd=? AND supply_date=?
            GROUP BY publ_name ORDER BY copies DESC`, [unit_code, agcd, latestDate]);
        byPub = bp.rows.map(r => ({ publication: r.publ_name, copies: num(r.copies) }));
        todayCopies = byPub.reduce((s, r) => s + r.copies, 0);
      }

      const o = os.rows[0] || {};
      res.json({
        agency,
        latest_supply_date: latestDate,
        today_copies: todayCopies,
        today_by_publication: byPub,
        opening: num(o.op_amt),
        billed: num(o.bill_amt),
        received: num(o.rec_amt),
        outstanding: num(o.cl_amt),
        total_copies: num(o.total_copies),
        day_copies: num(o.day_copies),
        collection_this_month: num(colMonth.rows[0] && colMonth.rows[0].received),
        last_collection_date: colMonth.rows[0] && colMonth.rows[0].last_date ? iso(colMonth.rows[0].last_date) : null,
      });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/supply?unit=&agcd=&month=YYYY-MM|date=YYYY-MM-DD|days=30
  //   default: last 30 days trend + latest-day breakdown
  //   month : that month's daily trend + breakdown of the month's last supplied day
  //   date  : that month's daily trend + breakdown of the chosen day
  app.get('/api/agent/supply', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, days: [], breakdown: [] });
      const { unit_code, agcd } = agency;

      const wantDate = isDate(req.query.date) ? String(req.query.date) : null;
      let wantMonth = isMonth(req.query.month) ? String(req.query.month) : (wantDate ? wantDate.slice(0, 7) : null);
      if (wantMonth && !monthAllowed(wantMonth)) return res.status(403).json({ detail: 'Only the current and last 6 months are available in the app.' });

      let trend;
      if (wantMonth) {
        trend = await q(
          `SELECT supply_date, SUM(sup_copy) copies, SUM(sup_copy*sup_rate) value
             FROM supply_data WHERE unit_code=? AND agcd=? AND DATE_FORMAT(supply_date,'%Y-%m')=?
             GROUP BY supply_date ORDER BY supply_date`, [unit_code, agcd, wantMonth]);
      } else {
        const days = Math.min(120, Math.max(7, parseInt(req.query.days || '30', 10)));
        trend = await q(
          `SELECT supply_date, SUM(sup_copy) copies, SUM(sup_copy*sup_rate) value
             FROM supply_data WHERE unit_code=? AND agcd=? AND supply_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
             GROUP BY supply_date ORDER BY supply_date`, [unit_code, agcd, days]);
      }

      // Which day to break down
      let brkDate = wantDate;
      if (!brkDate) {
        const scope = wantMonth
          ? await q(`SELECT MAX(supply_date) mx FROM supply_data WHERE unit_code=? AND agcd=? AND DATE_FORMAT(supply_date,'%Y-%m')=?`, [unit_code, agcd, wantMonth])
          : await q(`SELECT MAX(supply_date) mx FROM supply_data WHERE unit_code=? AND agcd=?`, [unit_code, agcd]);
        brkDate = scope.rows[0] && scope.rows[0].mx ? iso(scope.rows[0].mx) : null;
      }
      let breakdown = [];
      if (brkDate) {
        const b = await q(
          `SELECT publ_name, edtn_name, supply_type_name, SUM(sup_copy) copies, AVG(sup_rate) rate, AVG(comm_rate) comm
             FROM supply_data WHERE unit_code=? AND agcd=? AND supply_date=?
             GROUP BY publ_name, edtn_name, supply_type_name ORDER BY copies DESC`, [unit_code, agcd, brkDate]);
        breakdown = b.rows.map(r => ({ publication: r.publ_name, edition: r.edtn_name, type: r.supply_type_name, copies: num(r.copies), rate: num(r.rate), commission: num(r.comm) }));
      }
      res.json({
        agency, month: wantMonth || null, breakdown_date: brkDate,
        days: trend.rows.map(r => ({ date: iso(r.supply_date), copies: num(r.copies), value: Math.round(num(r.value)) })),
        breakdown,
      });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/supply-history?months=6 — monthly supply totals (current + last 6 months)
  app.get('/api/agent/supply-history', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, months: [] });
      const { unit_code, agcd } = agency;
      const { rows } = await q(
        `SELECT DATE_FORMAT(supply_date,'%Y-%m') ym, SUM(sup_copy) copies, ROUND(SUM(sup_copy*sup_rate)) value,
                ROUND(AVG(comm_rate),1) comm
           FROM supply_data
          WHERE unit_code=? AND agcd=? AND supply_date >= DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'), INTERVAL 6 MONTH)
          GROUP BY ym ORDER BY ym`, [unit_code, agcd]);
      res.json({ agency, months: rows.map(r => ({ month: r.ym, copies: num(r.copies), value: num(r.value), avg_commission: num(r.comm) })) });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/bill-history?months=6 — monthly billing (cumulative delta) for last 6 months
  app.get('/api/agent/bill-history', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, months: [] });
      const { unit_code, agcd } = agency;
      const labels = await q(`SELECT period_label FROM agency_outstanding WHERE period_label REGEXP '^[0-9]{4}-[0-9]{2}$' GROUP BY period_label ORDER BY period_label`);
      const list = labels.rows.map(r => r.period_label);
      const rows = await q(
        `SELECT period_label, bill_amt, cl_amt FROM agency_outstanding
          WHERE unit_code=? AND ag_code=? AND period_label IN (${list.map(() => '?').join(',') || "''"})`,
        [unit_code, agcd, ...list]);
      const byLabel = {}; rows.rows.forEach(r => { byLabel[r.period_label] = r; });
      const months = list.map((lbl, i) => {
        const cur = byLabel[lbl], prev = i > 0 ? byLabel[list[i - 1]] : null;
        const monthly = cur ? num(cur.bill_amt) - (prev ? num(prev.bill_amt) : 0) : 0;
        return { month: lbl, billing: Math.round(monthly), outstanding: cur ? Math.round(num(cur.cl_amt)) : null };
      }).filter(m => monthAllowed(m.month));
      res.json({ agency, months });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/netsales?month=YYYY-MM — supply value net of commission for the month
  app.get('/api/agent/netsales', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null });
      const { unit_code, agcd } = agency;
      const month = isMonth(req.query.month) && monthAllowed(req.query.month) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
      const { rows } = await q(
        `SELECT publ_name, SUM(sup_copy) copies, ROUND(SUM(sup_copy*sup_rate)) gross,
                ROUND(SUM(sup_copy*sup_rate*comm_rate/100)) commission,
                ROUND(SUM(sup_copy*sup_rate*(1-comm_rate/100))) net
           FROM supply_data WHERE unit_code=? AND agcd=? AND DATE_FORMAT(supply_date,'%Y-%m')=?
           GROUP BY publ_name ORDER BY net DESC`, [unit_code, agcd, month]);
      const tot = rows.reduce((a, r) => ({ copies: a.copies + num(r.copies), gross: a.gross + num(r.gross), commission: a.commission + num(r.commission), net: a.net + num(r.net) }), { copies: 0, gross: 0, commission: 0, net: 0 });
      res.json({ agency, month, total: tot, by_publication: rows.map(r => ({ publication: r.publ_name, copies: num(r.copies), gross: num(r.gross), commission: num(r.commission), net: num(r.net) })) });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/payments?month=YYYY-MM — receipts (money paid in) for a month
  app.get('/api/agent/payments', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, rows: [] });
      const { unit_code, agcd } = agency;
      const month = isMonth(req.query.month) && monthAllowed(req.query.month) ? String(req.query.month) : null;
      const monthCls = month ? ` AND DATE_FORMAT(coll_date,'%Y-%m')=?` : '';
      const params = [unit_code, agcd]; if (month) params.push(month);
      const { rows } = await q(
        `SELECT coll_date, doc_no, payment_mode, payment_cat, -amount amount, bank, cheque_no
           FROM agency_collection
          WHERE is_valid=1 AND unit_code=? AND ag_code=? AND amount<0${monthCls}
          ORDER BY coll_date DESC, id DESC LIMIT 100`, params);
      const total = rows.reduce((a, r) => a + num(r.amount), 0);
      res.json({ agency, month, total: Math.round(total), rows: rows.map(r => ({ date: iso(r.coll_date), doc_no: r.doc_no, mode: r.payment_mode, category: r.payment_cat, amount: num(r.amount), bank: r.bank, cheque_no: r.cheque_no })) });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // POST /api/agent/feedback — agent submits feedback (writes MySQL)
  app.post('/api/agent/feedback', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied || !agency) return res.status(403).json({ detail: 'No agency linked to your account.' });
      const b = req.body || {};
      await q(`INSERT INTO agent_feedback (unit_code, agcd, ag_name, category, rating, message, submitted_by) VALUES (?,?,?,?,?,?,?)`,
        [agency.unit_code, agency.agcd, agency.ag_name, (b.category || '').slice(0, 60) || null,
         b.rating ? Math.max(1, Math.min(5, parseInt(b.rating, 10))) : null, (b.message || '').slice(0, 2000) || null, auth(req).personCode]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // POST /api/agent/competitor — agent reports competitor copies (writes MySQL)
  app.post('/api/agent/competitor', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied || !agency) return res.status(403).json({ detail: 'No agency linked to your account.' });
      const b = req.body || {};
      const dt = isDate(b.report_date) ? b.report_date : new Date().toISOString().slice(0, 10);
      await q(`INSERT INTO agent_competitor (report_date, unit_code, agcd, ag_name, competitor, copies, remarks, submitted_by) VALUES (?,?,?,?,?,?,?,?)`,
        [dt, agency.unit_code, agency.agcd, agency.ag_name, (b.competitor || '').slice(0, 120) || null,
         b.copies != null ? parseInt(b.copies, 10) || 0 : null, (b.remarks || '').slice(0, 2000) || null, auth(req).personCode]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/competitor?limit= — recent competitor reports for this agency
  app.get('/api/agent/competitor', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied || !agency) return res.json({ rows: [] });
      const { rows } = await q(`SELECT report_date, competitor, copies, remarks FROM agent_competitor WHERE unit_code=? AND agcd=? ORDER BY report_date DESC, id DESC LIMIT 30`, [agency.unit_code, agency.agcd]);
      res.json({ rows: rows.map(r => ({ date: iso(r.report_date), competitor: r.competitor, copies: num(r.copies), remarks: r.remarks })) });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/billing?unit=&agcd= — outstanding breakdown + latest monthly bill
  app.get('/api/agent/billing', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null });
      const { unit_code, agcd } = agency;

      // latest monthly-billing snapshot label (BILL-YYYY-MM) if present
      const lbl = await q(`SELECT MAX(period_label) pl FROM agency_outstanding WHERE period_label LIKE 'BILL-%'`);
      const billLabel = lbl.rows[0] && lbl.rows[0].pl;
      const [cur, monthly] = await Promise.all([
        q(`SELECT op_amt, bill_amt, other_db, rec_amt, other_cr, cl_amt, total_copies, day_copies, security_bal
             FROM agency_outstanding WHERE period_label='CURRENT' AND unit_code=? AND ag_code=? LIMIT 1`, [unit_code, agcd]),
        billLabel
          ? q(`SELECT bill_amt FROM agency_outstanding WHERE period_label=? AND unit_code=? AND ag_code=? LIMIT 1`, [billLabel, unit_code, agcd])
          : Promise.resolve({ rows: [] }),
      ]);
      const c = cur.rows[0] || {};
      res.json({
        agency,
        opening: num(c.op_amt), billed_cumulative: num(c.bill_amt), other_debit: num(c.other_db),
        received: num(c.rec_amt), other_credit: num(c.other_cr), outstanding: num(c.cl_amt),
        security_balance: num(c.security_bal), total_copies: num(c.total_copies), day_copies: num(c.day_copies),
        month_bill_label: billLabel || null,
        month_bill: monthly.rows[0] ? num(monthly.rows[0].bill_amt) : null,
      });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });

  // GET /api/agent/ledger?unit=&agcd=&limit=50 — recent collection / receipt transactions
  app.get('/api/agent/ledger', async (req, res) => {
    try {
      const { agency, denied } = await pickAgency(req);
      if (denied) return res.status(403).json({ detail: 'This agency is not linked to your account.' });
      if (!agency) return res.json({ agency: null, rows: [] });
      const { unit_code, agcd } = agency;
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || '50', 10)));
      const { rows } = await q(
        `SELECT coll_date, doc_type, doc_no, payment_mode, payment_cat, amount, narration, bank, cheque_no
           FROM agency_collection
          WHERE is_valid=1 AND unit_code=? AND ag_code=?
          ORDER BY coll_date DESC, id DESC LIMIT ${limit}`, [unit_code, agcd]);
      res.json({
        agency,
        rows: rows.map(r => ({
          date: iso(r.coll_date), doc_type: r.doc_type, doc_no: r.doc_no,
          mode: r.payment_mode, category: r.payment_cat,
          amount: num(r.amount), is_receipt: num(r.amount) < 0,
          narration: r.narration, bank: r.bank, cheque_no: r.cheque_no,
        })),
      });
    } catch (e) { res.status(500).json({ detail: String(e && e.message || e) }); }
  });
};
