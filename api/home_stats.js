'use strict';
/**
 * home_stats.js — the four figures on the launcher, from the database.
 *
 * They used to be a lookup table of invented numbers keyed on hierarchy level. Admin's
 * card read "5 Zones · 12 Branches · 124 Agents · 4.1L+ Copies/day" against a real 36
 * branches, 27,645 agencies and 23.5 lakh copies a day; a VP's read "4 Agents · 24
 * Hawkers · 3.2k Rural readers" against his whole circulation. Nothing on a management
 * dashboard may be made up, least of all the first thing anyone sees after signing in.
 *
 * Everything here is scoped with getScopeUnitCodes, so a Zonal Head's four figures cover
 * his zone and an Edition Incharge's cover his branch — the same scope every other screen
 * gives them.
 *
 * Copies per day follows the suite's rule: each unit divides by its OWN publishing days
 * and the units are summed. A branch that does not publish on a Sunday is not a branch
 * whose supply fell.
 */

module.exports = function registerHomeStats({ app, q, getScopeUnitCodes }) {
  const N = v => Number(v) || 0;

  const fmtN = n => Number(n || 0).toLocaleString('en-IN');
  const fmtC = n => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
    if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
    return '₹' + Math.round(v).toLocaleString('en-IN');
  };
  const fmtK = n => {
    const v = Number(n) || 0;
    if (v >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
    if (v >= 1e5) return (v / 1e5).toFixed(2) + ' L';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  };

  const MANAGEMENT = new Set(['admin', 'edition_incharge', 'circ_incharge', 'zonal_head', 'vp']);
  // 60 seconds: the launcher is opened repeatedly during a session and these are scans.
  const cache = new Map();

  app.get('/api/home-stats', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const pc   = req.auth.personCode || '';
      const hl   = Number(req.auth.hierarchyLevel) || 99;
      const role = String(req.query.role || '');
      const key  = `${pc}|${hl}|${role}`;
      const hit  = cache.get(key);
      if (hit && Date.now() - hit.ts < 60000) return res.json(hit.data);

      const units = await getScopeUnitCodes(pc, hl);
      const scoped = Array.isArray(units) && units.length;
      const IN  = (col) => scoped ? ` AND ${col} IN (${units.map(() => '?').join(',')})` : '';
      const P   = scoped ? units : [];

      let stats;
      if (MANAGEMENT.has(role) || hl <= 6) {
        const [br, ag, sup, hw, os] = await Promise.all([
          // Branches that actually publish — a unit in the master with no supply is not a
          // branch anyone runs.
          q(`SELECT COUNT(DISTINCT unit_code) n FROM supply_data
              WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${IN('unit_code')}`, P),
          q(`SELECT COUNT(DISTINCT unit, agcd) n FROM agency_master
              WHERE CAST(dpcd AS UNSIGNED) = 1${IN('unit')}`, P),
          q(`SELECT unit_code, SUM(sup_copy) c, COUNT(DISTINCT supply_date) d FROM supply_data
              WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${IN('unit_code')}
              GROUP BY unit_code`, P),
          q(`SELECT loc_id unit_code, SUM(sup_copies) c, COUNT(DISTINCT supply_date) d FROM hawker_supply
              WHERE supply_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${IN('loc_id')}
              GROUP BY loc_id`, P),
          q(`SELECT SUM(cl_amt) v FROM agency_outstanding
              WHERE period_label = 'CURRENT'${IN('unit_code')}`, P),
        ]);
        const perDay = rows => rows.reduce((a, r) => a + (N(r.d) ? Math.round(N(r.c) / N(r.d)) : 0), 0);
        const copies = perDay(sup.rows) + perDay(hw.rows);
        const nBr = N(br.rows[0] && br.rows[0].n);
        stats = [
          [fmtN(nBr), nBr === 1 ? 'Branch' : 'Branches'],
          [fmtK(N(ag.rows[0] && ag.rows[0].n)), 'Agencies'],
          [fmtK(copies), 'Copies/day'],
          [fmtC(N(os.rows[0] && os.rows[0].v)), 'Outstanding'],
        ];
      } else {
        /* A field executive's day, keyed on their own person_code — every figure here is
           something they did, not something their branch did. */
        const [vis, task, fup, coll] = await Promise.all([
          q(`SELECT COUNT(*) n FROM dcr_visit WHERE staff_person_code = ? AND visit_date = CURDATE()`, [pc]),
          q(`SELECT COUNT(*) n FROM dcr_tour_plan
              WHERE staff_person_code = ? AND status = 'approved'
                AND COALESCE(exec_status,'pending') <> 'done'`, [pc]),
          q(`SELECT COUNT(*) n FROM dcr_visit v
              WHERE v.staff_person_code = ? AND v.next_followup_date IS NOT NULL
                AND v.next_followup_date <= CURDATE()
                AND NOT EXISTS (SELECT 1 FROM dcr_visit v2
                     WHERE v2.staff_person_code = v.staff_person_code
                       AND v2.target_type = v.target_type AND v2.target_code = v.target_code
                       AND v2.visit_date >= v.next_followup_date AND v2.id <> v.id)`, [pc]),
          q(`SELECT SUM(amount_collected) v FROM dcr_visit
              WHERE staff_person_code = ? AND visit_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [pc]),
        ]);
        stats = [
          [fmtN(N(vis.rows[0] && vis.rows[0].n)),  'Visits today'],
          [fmtN(N(task.rows[0] && task.rows[0].n)), 'Open tasks'],
          [fmtN(N(fup.rows[0] && fup.rows[0].n)),  'Follow-ups due'],
          [fmtC(N(coll.rows[0] && coll.rows[0].v)), 'Collected (month)'],
        ];
      }

      const data = { stats, scope: scoped ? units.length : 'all', as_on: new Date().toISOString().slice(0, 10) };
      cache.set(key, { data, ts: Date.now() });
      if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.ts > 120000) cache.delete(k);
      res.json(data);
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });
};
