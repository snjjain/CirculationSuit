'use strict';
/**
 * exec_targets.js — Monthly Target Management (unit-wise)
 *
 * Targets are set at state → unit (branch) level, not per-executive.
 * Actuals are aggregated from supply_data, agency_collection, dcr_* tables by unit_code.
 *
 * Tables:
 *   exec_targets           — unit-level monthly targets
 *   exec_target_weights    — configurable score weights
 *   exec_target_thresholds — configurable achievement thresholds
 *
 * Endpoints:
 *   GET  /api/targets/filters
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
    // Detect old exec-wise schema (has emp_code column) and migrate
    const colsR = await q(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exec_targets'`);

    if (colsR.rows.some(r => r.COLUMN_NAME === 'emp_code')) {
      // Migrate: drop old unique key → drop emp_code → rebuild as unit-wise
      await q('ALTER TABLE exec_targets DROP INDEX uq_exec_tgt').catch(() => {});
      await q('DELETE FROM exec_targets').catch(() => {});         // table was empty anyway
      await q('ALTER TABLE exec_targets DROP COLUMN emp_code').catch(() => {});
      await q('ALTER TABLE exec_targets MODIFY COLUMN unit_code VARCHAR(8) NOT NULL').catch(() => {});
      await q('ALTER TABLE exec_targets ADD COLUMN IF NOT EXISTS state_code VARCHAR(20) AFTER unit_code').catch(() => {});
      await q('ALTER TABLE exec_targets ADD UNIQUE KEY uq_unit_tgt (unit_code, month_year, target_type)').catch(() => {});
      await q('ALTER TABLE exec_targets ADD INDEX idx_month_state (month_year, state_code)').catch(() => {});
      console.log('[exec-targets] migrated schema to unit-wise');
    } else {
      // Fresh create (no-op if already correct)
      await q(`CREATE TABLE IF NOT EXISTS exec_targets (
        id           BIGINT AUTO_INCREMENT PRIMARY KEY,
        unit_code    VARCHAR(8)  NOT NULL,
        state_code   VARCHAR(20),
        month_year   VARCHAR(7)  NOT NULL,
        target_type  VARCHAR(30) NOT NULL,
        target_value DECIMAL(15,2) NOT NULL DEFAULT 0,
        created_by   VARCHAR(50),
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by   VARCHAR(50),
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_unit_tgt (unit_code, month_year, target_type),
        INDEX idx_month_state (month_year, state_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

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

    await q(`INSERT IGNORE INTO exec_target_weights (weight_key, weight_pct) VALUES
      ('supply_copies', 30), ('collection', 30), ('agency_visits', 25), ('attendance_days', 15)`);

    await q(`INSERT IGNORE INTO exec_target_thresholds (threshold_key, value_pct, label) VALUES
      ('excellent', 100, 'Achieved'), ('good', 80, 'Near Target'),
      ('attention', 60, 'Needs Attention'), ('poor', 0, 'Poor')`);
  }

  ensureTables().catch(e => console.error('[exec-targets] table init:', e.message));

  // ── Helpers ──────────────────────────────────────────────────────────────────

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

      const months = [];
      const now = new Date();
      for (let i = -1; i <= 11; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}`);
      }

      res.json({ states: states.rows.map(r => r.state), units: units.rows, months });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/list ─────────────────────────────────────────────────────
  // Returns saved targets grouped by unit_code for a given month+state/unit

  app.get('/api/targets/list', async (req, res) => {
    try {
      const my    = String(req.query.month_year || currentMonthYear()).slice(0, 7);
      const unit  = String(req.query.unit_code  || '').trim();
      const state = String(req.query.state      || '').trim();

      const clauses = ['month_year = ?'];
      const params  = [my];
      if (unit)  { clauses.push('unit_code = ?');  params.push(unit);  }
      if (state) { clauses.push('state_code = ?'); params.push(state); }

      const { rows } = await q(
        `SELECT unit_code, state_code, target_type, target_value
         FROM exec_targets WHERE ${clauses.join(' AND ')} ORDER BY unit_code, target_type`,
        params);

      // Group by unit_code → { unit_code, targets: {type: value} }
      const byUnit = {};
      for (const r of rows) {
        if (!byUnit[r.unit_code]) byUnit[r.unit_code] = { unit_code: r.unit_code, state_code: r.state_code, targets: {} };
        byUnit[r.unit_code].targets[r.target_type] = N(r.target_value);
      }
      res.json({ month_year: my, units: Object.values(byUnit) });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── POST /api/targets ─────────────────────────────────────────────────────────
  // Body: { unit_code, state_code, month_year, targets: {supply_copies, collection, agency_visits, attendance_days} }

  app.post('/api/targets', async (req, res) => {
    try {
      const { unit_code, state_code, month_year, targets } = req.body || {};
      if (!unit_code || !month_year || !targets)
        return res.status(400).json({ detail: 'unit_code, month_year and targets required' });

      const my = String(month_year).slice(0, 7);
      const by = req.auth?.personCode || req.auth?.userId || 'system';

      for (const [type, value] of Object.entries(targets)) {
        if (value === '' || value == null) continue;
        await q(
          `INSERT INTO exec_targets (unit_code, state_code, month_year, target_type, target_value, created_by, updated_by)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE target_value=?, state_code=COALESCE(?,state_code), updated_by=?`,
          [unit_code, state_code || null, my, type, N(value), by, by, N(value), state_code || null, by]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── GET /api/targets/achievement ──────────────────────────────────────────────
  // Actuals aggregated by unit_code — no JOIN with agency_master needed

  app.get('/api/targets/achievement', async (req, res) => {
    try {
      const my    = String(req.query.month_year || currentMonthYear()).slice(0, 7);
      const { from, to }             = monthStartEnd(my);
      const prevMy                   = prevMonthYear(my);
      const { from: prevFrom, to: prevTo } = monthStartEnd(prevMy);

      const unitList = await buildUnitList(req);
      const uc  = unitCl('unit_code', unitList);  // for supply_data, dcr, collection
      const us  = unitCl('unit',      unitList);  // for agency_master (column = 'unit')

      const today    = new Date();
      const daysInMo = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      const daysDone = Math.min(today.getDate(), daysInMo);
      const isCurrent = my === `${today.getFullYear()}-${p2(today.getMonth() + 1)}`;

      const [
        unitsMetaR, targetsR,
        supCurrR, supPrevR,
        colR, dcrR, attendR, weightsR,
      ] = await Promise.all([

        // Unit metadata — single table, no cross-collation issue
        q(`SELECT DISTINCT unit unit_code, MAX(unit_name) unit_name, MAX(unit_state_nm) state_nm
           FROM agency_master WHERE 1=1${us.cl} GROUP BY unit ORDER BY unit_name`, us.p),

        // Saved targets — exec_targets is utf8mb4_unicode_ci, matches Oracle tables
        q(`SELECT unit_code, target_type, target_value
           FROM exec_targets WHERE month_year=?${uc.cl} ORDER BY unit_code`, [my, ...uc.p]),

        // Supply current month — direct unit_code filter, no JOIN needed
        q(`SELECT unit_code, SUM(sup_copy) supply FROM supply_data
           WHERE supply_date BETWEEN ? AND ?${uc.cl} GROUP BY unit_code`,
          [from, to, ...uc.p]),

        // Supply previous month — for growth calculation
        q(`SELECT unit_code, SUM(sup_copy) supply FROM supply_data
           WHERE supply_date BETWEEN ? AND ?${uc.cl} GROUP BY unit_code`,
          [prevFrom, prevTo, ...uc.p]),

        // Collection — agency_collection has unit_code directly
        q(`SELECT unit_code, -SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) coll
           FROM agency_collection WHERE is_valid=1 AND coll_date BETWEEN ? AND ?${uc.cl}
           GROUP BY unit_code`, [from, to, ...uc.p]),

        // DCR agency visits by unit
        q(`SELECT unit_code, COUNT(*) visits FROM dcr_agency_visit
           WHERE mark_attn_date BETWEEN ? AND ?${uc.cl} GROUP BY unit_code`,
          [from, to, ...uc.p]),

        // Attendance man-days by unit
        q(`SELECT unit_code, COUNT(*) attn_days FROM dcr_center_attendance
           WHERE attn_date BETWEEN ? AND ?${uc.cl} GROUP BY unit_code`,
          [from, to, ...uc.p]),

        q('SELECT weight_key, weight_pct FROM exec_target_weights'),
      ]);

      const weights = {};
      for (const w of weightsR.rows) weights[w.weight_key] = N(w.weight_pct);

      const supCurrMap = {}, supPrevMap = {}, colMap = {}, dcrMap = {}, attendMap = {};
      for (const r of supCurrR.rows)  supCurrMap[r.unit_code] = N(r.supply);
      for (const r of supPrevR.rows)  supPrevMap[r.unit_code] = N(r.supply);
      for (const r of colR.rows)      colMap[r.unit_code]     = N(r.coll);
      for (const r of dcrR.rows)      dcrMap[r.unit_code]     = N(r.visits);
      for (const r of attendR.rows)   attendMap[r.unit_code]  = N(r.attn_days);

      const targetsByUnit = {};
      for (const t of targetsR.rows) {
        if (!targetsByUnit[t.unit_code]) targetsByUnit[t.unit_code] = {};
        targetsByUnit[t.unit_code][t.target_type] = N(t.target_value);
      }

      const results = unitsMetaR.rows.map(u => {
        const uc   = u.unit_code;
        const tgt  = targetsByUnit[uc] || {};
        const supC = supCurrMap[uc]    || 0;
        const supP = supPrevMap[uc]    || 0;
        const col  = colMap[uc]        || 0;
        const dcr  = dcrMap[uc]        || 0;
        const att  = attendMap[uc]     || 0;

        const growthCopies = supC - supP;
        const growthPct    = supP > 0 ? Math.round(growthCopies / supP * 1000) / 10 : null;
        const pct = (v, t) => t > 0 ? Math.min(Math.round(v / t * 100), 999) : null;

        const achievement = {
          supply_copies:   pct(supC, tgt.supply_copies),
          collection:      pct(col,  tgt.collection),
          agency_visits:   pct(dcr,  tgt.agency_visits),
          attendance_days: pct(att,  tgt.attendance_days),
        };

        let wSum = 0, wTot = 0;
        for (const [k, w] of Object.entries(weights)) {
          if (achievement[k] != null) { wSum += Math.min(achievement[k], 150) * w; wTot += w; }
        }
        const overallScore = wTot > 0 ? Math.round(wSum / wTot) : null;

        let pacing = null;
        if (isCurrent && daysDone > 0) {
          const pace = daysInMo / daysDone;
          pacing = {
            days_done: daysDone, days_left: daysInMo - daysDone, days_in_month: daysInMo,
            pct_days_done: Math.round(daysDone / daysInMo * 100),
            projected_supply:     Math.round(supC * pace),
            projected_collection: Math.round(col  * pace),
            projected_visits:     Math.round(dcr  * pace),
          };
        }

        return {
          unit_code: uc, unit_name: u.unit_name, state_nm: u.state_nm,
          month_year: my, targets: tgt,
          actuals: { supply_curr: supC, supply_prev: supP, growth_copies: growthCopies, growth_pct: growthPct, collection: col, agency_visits: dcr, attendance_days: att },
          achievement, overall_score: overallScore, pacing,
          has_targets: Object.keys(tgt).length > 0,
        };
      });

      results.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
      res.json({ month_year: my, from, to, prev_month: prevMy, day_in_month: daysDone, days_total: daysInMo, results });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Weights ───────────────────────────────────────────────────────────────────

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
      for (const [k, v] of Object.entries(weights))
        await q('INSERT INTO exec_target_weights (weight_key, weight_pct) VALUES (?,?) ON DUPLICATE KEY UPDATE weight_pct=?', [k, N(v), N(v)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Thresholds ────────────────────────────────────────────────────────────────

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
      for (const [k, v] of Object.entries(thresholds))
        await q('INSERT INTO exec_target_thresholds (threshold_key, value_pct, label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value_pct=?, label=?',
          [k, N(v.pct || v), v.label || k, N(v.pct || v), v.label || k]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
