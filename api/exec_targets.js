'use strict';
/**
 * exec_targets.js — Monthly Target Management
 *
 * Tables (created on startup):
 *   exec_targets          — per-executive monthly targets
 *   exec_target_weights   — configurable performance score weights
 *   exec_target_thresholds— configurable achievement status thresholds
 *
 * Endpoints:
 *   GET  /api/targets/filters
 *   GET  /api/targets/employees
 *   GET  /api/targets/list
 *   POST /api/targets
 *   GET  /api/targets/achievement
 *   GET  /api/targets/weights
 *   POST /api/targets/weights
 *   GET  /api/targets/thresholds
 *   POST /api/targets/thresholds
 */

module.exports = function registerExecTargets({ app, q, getScopeUnitCodes }) {
  const N  = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const p2 = n => String(n).padStart(2, '0');

  // ── Schema ──────────────────────────────────────────────────────────────────

  async function ensureTables() {
    await q(`CREATE TABLE IF NOT EXISTS exec_targets (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      emp_code     VARCHAR(20) NOT NULL,
      unit_code    VARCHAR(8),
      month_year   VARCHAR(7)  NOT NULL,
      target_type  VARCHAR(30) NOT NULL,
      target_value DECIMAL(15,2) NOT NULL DEFAULT 0,
      created_by   VARCHAR(50),
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by   VARCHAR(50),
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_exec_tgt (emp_code, month_year, target_type),
      INDEX idx_month_unit (month_year, unit_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await q(`CREATE TABLE IF NOT EXISTS exec_target_weights (
      weight_key VARCHAR(30) PRIMARY KEY,
      weight_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await q(`CREATE TABLE IF NOT EXISTS exec_target_thresholds (
      threshold_key VARCHAR(20) PRIMARY KEY,
      value_pct     DECIMAL(5,2) NOT NULL DEFAULT 0,
      label         VARCHAR(30),
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Seed defaults (INSERT IGNORE = no-op if already present)
    await q(`INSERT IGNORE INTO exec_target_weights (weight_key, weight_pct) VALUES
      ('growth_pct', 30), ('collection', 25), ('agency_visits', 20),
      ('survey', 15), ('attendance_days', 10)`);

    await q(`INSERT IGNORE INTO exec_target_thresholds (threshold_key, value_pct, label) VALUES
      ('excellent', 100, 'Achieved'), ('good', 80, 'Near Target'),
      ('attention', 60, 'Needs Attention'), ('poor', 0, 'Poor')`);
  }

  ensureTables().catch(e => console.error('[exec-targets] table init:', e.message));

  // ── Date helpers ─────────────────────────────────────────────────────────────

  function currentMonthYear() {
    const d = new Date();
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
  }
  function prevMonthYear(my) {
    const [y, m] = my.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${p2(m - 1)}`;
  }
  function monthStartEnd(my) {
    const [y, m] = my.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { from: `${my}-01`, to: `${my}-${p2(last)}` };
  }

  // Unit-clause helper (same pattern as exec_performance.js)
  function unitCl(col, list) {
    if (list === null)  return { cl: '', p: [] };
    if (!list.length)   return { cl: ' AND 1=0', p: [] };
    return { cl: ` AND ${col} IN (${list.map(() => '?').join(',')})`, p: list };
  }

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
        'SELECT DISTINCT unit FROM agency_master WHERE unit_state_nm = ?', [reqState]);
      let units = rows.map(r => r.unit);
      if (scoped) units = units.filter(u => scoped.includes(u));
      return units;
    }
    return scoped;
  }

  // ── GET /api/targets/filters ──────────────────────────────────────────────────

  app.get('/api/targets/filters', async (req, res) => {
    try {
      const personCode = req.auth ? (req.auth.personCode || '') : '';
      const hl         = req.auth ? (req.auth.hierarchyLevel || 1) : 1;
      const scoped     = await getScopeUnitCodes(personCode, hl);
      const sc         = unitCl('unit', scoped);

      const [states, units] = await Promise.all([
        q(`SELECT DISTINCT unit_state_nm state FROM agency_master
           WHERE unit_state_nm IS NOT NULL AND unit_state_nm != ''${sc.cl}
           ORDER BY unit_state_nm`, sc.p),
        q(`SELECT DISTINCT unit unit_code, MAX(unit_name) unit_name, MAX(unit_state_nm) state_nm
           FROM agency_master WHERE 1=1${sc.cl}
           GROUP BY unit ORDER BY unit_name`, sc.p),
      ]);

      // Month options: last 12 months + next month
      const months = [];
      const now = new Date();
      for (let i = -1; i <= 11; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}`);
      }

      res.json({ states: states.rows.map(r => r.state), units: units.rows, months });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/employees ────────────────────────────────────────────────

  app.get('/api/targets/employees', async (req, res) => {
    try {
      const unitList = await buildUnitList(req);
      const uc = unitCl('am.unit', unitList);

      const { rows } = await q(
        `SELECT DISTINCT am.executive_code emp_code, MAX(am.executive_name) emp_name,
                MIN(am.unit) unit_code, MAX(am.unit_name) unit_name
         FROM agency_master am
         LEFT JOIN exec_master em ON em.executive_code = am.executive_code
         WHERE am.executive_code IS NOT NULL AND am.executive_code != ''${uc.cl}
           AND (em.executive_code IS NULL OR (em.is_active_pli = 'Y' AND em.exec_designation = 'EXEC'))
         GROUP BY am.executive_code ORDER BY emp_name`, uc.p);

      res.json({ employees: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/list ─────────────────────────────────────────────────────

  app.get('/api/targets/list', async (req, res) => {
    try {
      const my   = String(req.query.month_year || currentMonthYear()).slice(0, 7);
      const unit = String(req.query.unit_code || '').trim();
      const emp  = String(req.query.emp_code || '').trim();

      const clauses = ['month_year = ?'];
      const params  = [my];
      if (unit) { clauses.push('unit_code = ?'); params.push(unit); }
      if (emp)  { clauses.push('emp_code = ?');  params.push(emp);  }

      const { rows } = await q(
        `SELECT * FROM exec_targets WHERE ${clauses.join(' AND ')} ORDER BY emp_code, target_type`,
        params);

      res.json({ month_year: my, targets: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/targets ─────────────────────────────────────────────────────────
  // Body: { emp_code, unit_code, month_year, targets: { growth_copies, growth_pct, collection, agency_visits, attendance_days, survey } }

  app.post('/api/targets', async (req, res) => {
    try {
      const { emp_code, unit_code, month_year, targets } = req.body || {};
      if (!emp_code || !month_year || !targets)
        return res.status(400).json({ detail: 'emp_code, month_year and targets required' });

      const my = String(month_year).slice(0, 7);
      const by = req.auth?.personCode || req.auth?.userId || 'system';

      for (const [type, value] of Object.entries(targets)) {
        if (value === '' || value == null) continue;
        await q(
          `INSERT INTO exec_targets (emp_code, unit_code, month_year, target_type, target_value, created_by, updated_by)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE target_value=?, updated_by=?`,
          [emp_code, unit_code || null, my, type, N(value), by, by, N(value), by]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/achievement ──────────────────────────────────────────────
  // Returns target vs actual for all executives in a given month

  app.get('/api/targets/achievement', async (req, res) => {
    try {
      const my       = String(req.query.month_year || currentMonthYear()).slice(0, 7);
      const unit     = String(req.query.unit_code || '').trim();
      const emp      = String(req.query.emp_code || '').trim();
      const { from, to } = monthStartEnd(my);
      const prevMy   = prevMonthYear(my);
      const { from: prevFrom, to: prevTo } = monthStartEnd(prevMy);

      const unitList = await buildUnitList(req);
      const uc  = unitCl('am.unit', unitList);
      const ucs = unitCl('unit', unitList);  // simple column (subquery)
      const ucd = unitCl('unit_code', unitList);

      // Pacing info
      const today     = new Date();
      const daysInMo  = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      const daysDone  = Math.min(today.getDate(), daysInMo);
      const isCurrent = my === `${today.getFullYear()}-${p2(today.getMonth() + 1)}`;

      // Target filter clause
      const tEmpCl  = emp  ? ' AND emp_code = ?'  : '';
      const tUnitCl = unit ? ' AND unit_code = ?' : '';
      const tParams = [my, ...(emp ? [emp] : []), ...(unit ? [unit] : [])];

      const [targetsR, supCurrR, supPrevR, colR, dcrR, attendR, weightsR] = await Promise.all([
        q(`SELECT * FROM exec_targets WHERE month_year=?${tEmpCl}${tUnitCl} ORDER BY emp_code`, tParams),

        q(`SELECT am.executive_code ec, SUM(sd.sup_copy) supply
           FROM supply_data sd
           JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                 WHERE executive_code IS NOT NULL AND executive_code != ''${uc.cl}) am
             ON sd.unit_code=am.unit AND sd.agcd=am.agcd
           WHERE sd.supply_date BETWEEN ? AND ?
           GROUP BY am.executive_code`, [...uc.p, from, to]),

        q(`SELECT am.executive_code ec, SUM(sd.sup_copy) supply
           FROM supply_data sd
           JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                 WHERE executive_code IS NOT NULL AND executive_code != ''${uc.cl}) am
             ON sd.unit_code=am.unit AND sd.agcd=am.agcd
           WHERE sd.supply_date BETWEEN ? AND ?
           GROUP BY am.executive_code`, [...uc.p, prevFrom, prevTo]),

        q(`SELECT am.executive_code ec, -SUM(CASE WHEN ac.amount<0 THEN ac.amount ELSE 0 END) coll
           FROM agency_collection ac
           JOIN (SELECT DISTINCT unit, agcd, executive_code FROM agency_master
                 WHERE executive_code IS NOT NULL AND executive_code != ''${uc.cl}) am
             ON am.unit=ac.unit_code AND am.agcd=ac.ag_code
           WHERE ac.is_valid=1 AND ac.coll_date BETWEEN ? AND ?
           GROUP BY am.executive_code`, [...uc.p, from, to]),

        q(`SELECT emp_code ec, COUNT(*) visits
           FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ?
             AND emp_code IS NOT NULL AND emp_code != ''${ucd.cl}
           GROUP BY emp_code`, [from, to, ...ucd.p]),

        q(`SELECT emp_code ec, COUNT(DISTINCT attn_date) attn_days
           FROM dcr_center_attendance
           WHERE attn_date BETWEEN ? AND ?
             AND emp_code IS NOT NULL AND emp_code != ''${ucd.cl}
           GROUP BY emp_code`, [from, to, ...ucd.p]),

        q('SELECT weight_key, weight_pct FROM exec_target_weights'),
      ]);

      // Build maps
      const weights = {};
      for (const w of weightsR.rows) weights[w.weight_key] = N(w.weight_pct);

      const supCurrMap = {}, supPrevMap = {}, colMap = {}, dcrMap = {}, attendMap = {};
      for (const r of supCurrR.rows)  supCurrMap[r.ec] = N(r.supply);
      for (const r of supPrevR.rows)  supPrevMap[r.ec] = N(r.supply);
      for (const r of colR.rows)      colMap[r.ec]     = N(r.coll);
      for (const r of dcrR.rows)      dcrMap[r.ec]     = N(r.visits);
      for (const r of attendR.rows)   attendMap[r.ec]  = N(r.attn_days);

      // Group targets by emp_code
      const targetsByEmp = {};
      for (const t of targetsR.rows) {
        if (!targetsByEmp[t.emp_code]) targetsByEmp[t.emp_code] = {};
        targetsByEmp[t.emp_code][t.target_type] = N(t.target_value);
      }

      // Merge all emp_codes from targets AND actuals
      const allCodes = new Set([
        ...Object.keys(targetsByEmp),
        ...supCurrR.rows.map(r => r.ec),
        ...colR.rows.map(r => r.ec),
      ]);
      if (emp) allCodes.add(emp);

      const results = [];
      for (const code of allCodes) {
        const tgt  = targetsByEmp[code] || {};
        const supC = supCurrMap[code] || 0;
        const supP = supPrevMap[code] || 0;
        const col  = colMap[code]     || 0;
        const dcr  = dcrMap[code]     || 0;
        const att  = attendMap[code]  || 0;

        const growthCopies = supC - supP;
        const growthPct    = supP > 0 ? Math.round(growthCopies / supP * 1000) / 10 : null;

        const pct = (v, t) => t > 0 ? Math.min(Math.round(v / t * 100), 999) : null;

        const achievement = {
          growth_copies:   pct(growthCopies, tgt.growth_copies),
          growth_pct:      tgt.growth_pct > 0 && growthPct != null
                             ? pct(growthPct, tgt.growth_pct) : null,
          collection:      pct(col,  tgt.collection),
          agency_visits:   pct(dcr,  tgt.agency_visits),
          attendance_days: pct(att,  tgt.attendance_days),
          survey:          null,  // survey not yet integrated
        };

        // Weighted overall score
        let wSum = 0, wTot = 0;
        for (const [k, w] of Object.entries(weights)) {
          if (achievement[k] != null) { wSum += Math.min(achievement[k], 150) * w; wTot += w; }
        }
        const overallScore = wTot > 0 ? Math.round(wSum / wTot) : null;

        // Pacing (current month only)
        let pacing = null;
        if (isCurrent && daysDone > 0) {
          const pace = daysInMo / daysDone;
          pacing = {
            days_done: daysDone, days_left: daysInMo - daysDone, days_in_month: daysInMo,
            pct_days_done: Math.round(daysDone / daysInMo * 100),
            projected_collection: Math.round(col  * pace),
            projected_visits:     Math.round(dcr  * pace),
            projected_supply:     Math.round(supC * pace),
          };
        }

        results.push({
          emp_code: code,
          month_year: my,
          targets: tgt,
          actuals: { supply_curr: supC, supply_prev: supP, growth_copies: growthCopies, growth_pct: growthPct, collection: col, agency_visits: dcr, attendance_days: att },
          achievement,
          overall_score: overallScore,
          pacing,
          has_targets: Object.keys(tgt).length > 0,
        });
      }

      results.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
      res.json({ month_year: my, from, to, prev_month: prevMy, day_in_month: daysDone, days_total: daysInMo, results });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/weights ──────────────────────────────────────────────────

  app.get('/api/targets/weights', async (req, res) => {
    try {
      const { rows } = await q('SELECT weight_key, weight_pct FROM exec_target_weights ORDER BY weight_pct DESC');
      res.json({ weights: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  app.post('/api/targets/weights', async (req, res) => {
    try {
      const { weights } = req.body || {};
      if (!weights || typeof weights !== 'object')
        return res.status(400).json({ detail: 'weights object required' });
      const total = Object.values(weights).reduce((s, v) => s + N(v), 0);
      if (Math.abs(total - 100) > 1)
        return res.status(400).json({ detail: `Weights must sum to 100 (currently ${total})` });
      for (const [k, v] of Object.entries(weights)) {
        await q('INSERT INTO exec_target_weights (weight_key, weight_pct) VALUES (?,?) ON DUPLICATE KEY UPDATE weight_pct=?', [k, N(v), N(v)]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/thresholds ───────────────────────────────────────────────

  app.get('/api/targets/thresholds', async (req, res) => {
    try {
      const { rows } = await q('SELECT threshold_key, value_pct, label FROM exec_target_thresholds ORDER BY value_pct DESC');
      res.json({ thresholds: rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  app.post('/api/targets/thresholds', async (req, res) => {
    try {
      const { thresholds } = req.body || {};
      if (!thresholds || typeof thresholds !== 'object')
        return res.status(400).json({ detail: 'thresholds object required' });
      for (const [k, v] of Object.entries(thresholds)) {
        await q('INSERT INTO exec_target_thresholds (threshold_key, value_pct, label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value_pct=?, label=?',
          [k, N(v.pct || v), v.label || k, N(v.pct || v), v.label || k]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
