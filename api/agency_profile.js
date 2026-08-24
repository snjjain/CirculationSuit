'use strict';

/**
 * agency_profile.js — Agency 360° Profile page
 *
 * One assembled view of a single agency: identity, status classification,
 * headline metrics, supply/collection trends, DCR visit intelligence,
 * GPS-nearby agencies, and a deterministic AI brief + next-best-action.
 *
 * Reuses the exact tag/score/opportunity formula from ai_nexus.js's
 * buildAgencySignals (scoped to one unit instead of the caller's whole
 * scope) so the numbers shown here always agree with the AI Nexus page —
 * two different-looking "opportunity" figures for the same agency would
 * undermine both screens.
 *
 * agcd is unique only WITHIN a unit (agency_master's real key is unit+agcd,
 * see dcr_analytics.js's resolveAgency) — this endpoint is always addressed
 * as /:unit_code/:agcd, never by agcd alone.
 *
 * Registered by server.js:  require('./agency_profile')({ app, q, getScopeUnitCodes })
 */

module.exports = function installAgencyProfile({ app, q, getScopeUnitCodes }) {
  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const R1 = v => v == null ? null : Math.round(v * 10) / 10;
  function fmtINR(n) {
    n = N(n);
    const abs = Math.abs(n);
    if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    return `₹${Math.round(n).toLocaleString('en-IN')}`;
  }
  const fmtDate = d => d ? new Date(d).toISOString().slice(0, 10) : null;
  const daysBetween = (a, b) => Math.round((a - b) / 86400000);
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(s));
  }
  const EXCLUDE_PUBS = ['P14'];
  const NEARBY_RADIUS_KM = 5;
  const COMPLAINT_WORDS = ['complaint', 'शिकायत', 'problem', 'issue', 'गलत', 'नाराज', 'angry', 'refuse', 'मना कर'];

  // ── Per-unit agency signal set — same tags/score/opportunity math as
  //    ai_nexus.js's buildAgencySignals, just scoped by unit_code directly
  //    instead of the caller's req scope, so a single-agency lookup doesn't
  //    need to pull the whole org's data. ─────────────────────────────────
  async function computeUnitAgencySignals(unitCode) {
    const [{ rows: active }, { rows: outR }, { rows: supR }, { rows: visitOra }, { rows: visitApp },
           { rows: gpsOra }, { rows: gpsApp }] = await Promise.all([
      q(`SELECT unit AS unit_code, agcd, ag_name, unit_name, unit_state_nm, city_name, dist_name,
                state_name, station_code, station_name, area_code, address, mobile_no1, ag_class_name, dpcd,
                executive_code, executive_name, field_officer_name,
                supply_start_dt, supply_stop_flag, suspend_date
         FROM agency_master WHERE unit = ?`, [unitCode]),
      q(`SELECT ag_code, cl_amt, bill_amt, rec_amt, op_amt, security_bal, req_security,
                last_supply_date, last_supply_copies, exec_code, exec_name
         FROM agency_outstanding WHERE period_label = 'CURRENT' AND unit_code = ?`, [unitCode]),
      q(`SELECT s.agcd, MAX(s.sup_copy) peak30,
                SUM(CASE WHEN s.supply_date = (SELECT MAX(supply_date) FROM supply_data) THEN s.sup_copy ELSE 0 END) cur
         FROM supply_data s
         WHERE s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN (${EXCLUDE_PUBS.map(p => `'${p}'`).join(',')})
           AND s.supply_date > DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 30 DAY)
           AND s.unit_code = ?
         GROUP BY s.agcd`, [unitCode]),
      q(`SELECT visit_to_main_code agcd, MAX(visit_date) last_visit
         FROM dcr_agency_visit WHERE unit_code = ? AND visit_date IS NOT NULL GROUP BY visit_to_main_code`, [unitCode]),
      q(`SELECT target_code agcd, MAX(visit_date) last_visit
         FROM dcr_visit WHERE unit_code = ? AND target_type = 'agent' AND visit_date IS NOT NULL GROUP BY target_code`, [unitCode]),
      q(`SELECT visit_to_main_code agcd, CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng, visit_date
         FROM dcr_agency_visit
         WHERE unit_code = ? AND latitude IS NOT NULL AND latitude<>'' AND longitude IS NOT NULL AND longitude<>''
           AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38 AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
         ORDER BY visit_date DESC`, [unitCode]),
      q(`SELECT target_code agcd, lat, lng, visit_date
         FROM dcr_visit
         WHERE unit_code = ? AND target_type='agent' AND lat IS NOT NULL AND lng IS NOT NULL
           AND lat BETWEEN 8 AND 38 AND lng BETWEEN 68 AND 98
         ORDER BY visit_date DESC`, [unitCode]),
    ]);

    const outMap = new Map(outR.map(r => [r.ag_code, r]));
    const supMap = new Map(supR.map(r => [r.agcd, r]));
    const visitMap = new Map();
    [...visitOra, ...visitApp].forEach(r => {
      const cur = visitMap.get(r.agcd);
      if (!cur || r.last_visit > cur) visitMap.set(r.agcd, r.last_visit);
    });
    const gpsMap = new Map();
    [...gpsApp, ...gpsOra].forEach(r => { if (!gpsMap.has(r.agcd)) gpsMap.set(r.agcd, { lat: N(r.lat), lng: N(r.lng) }); });

    const today = new Date();
    return active.map(a => {
      const o = outMap.get(a.agcd);
      const s = supMap.get(a.agcd);
      const lastVisit = visitMap.get(a.agcd);
      const gps = gpsMap.get(a.agcd);
      const outstanding = o ? N(o.cl_amt) : 0;
      const daysSinceVisit = lastVisit ? daysBetween(today, new Date(lastVisit)) : null;
      const peak30 = s ? N(s.peak30) : 0;
      const cur = s ? N(s.cur) : (o ? N(o.last_supply_copies) : 0);
      const declinePct = peak30 > 0 ? R1((cur - peak30) / peak30 * 100) : null;

      const neverVisited = daysSinceVisit == null;
      const hasPotential = outstanding >= 25000 || peak30 >= 20;
      const visitStale = daysSinceVisit != null && daysSinceVisit >= 21;

      const tags = [];
      if (outstanding >= 100000 && ((daysSinceVisit != null && daysSinceVisit >= 14) || (neverVisited && hasPotential))) tags.push('URGENT_ACTION');
      if (peak30 >= 50 && declinePct != null && declinePct <= -30) tags.push('WIN_BACK');
      if (peak30 > 0 && cur === 0) tags.push('SUPPLY_AT_RISK');
      if (visitStale || (neverVisited && hasPotential)) tags.push('VISIT_OVERDUE');
      if (outstanding >= 50000 && !tags.includes('URGENT_ACTION')) tags.push('COLLECTION_RECOVERY');
      if (!tags.length) tags.push(neverVisited ? 'NO_VISIT_HISTORY' : 'MONITOR');

      const score = (outstanding / 50000) * 3
        + (neverVisited ? (hasPotential ? 12 : 0) : Math.min(daysSinceVisit / 7, 8)) * 2
        + (declinePct != null && declinePct < 0 ? Math.min(-declinePct / 10, 10) : 0) * 2;

      const opportunity_copies = tags.includes('WIN_BACK') ? Math.round(peak30 - cur) : 0;
      const sig = {
        unit_code: a.unit_code, agcd: a.agcd, ag_name: a.ag_name, unit_name: a.unit_name,
        unit_state_nm: a.unit_state_nm, city_name: a.city_name, dist_name: a.dist_name,
        state_name: a.state_name, station_code: a.station_code, station_name: a.station_name, area_code: a.area_code, address: a.address,
        mobile_no1: a.mobile_no1, ag_class_name: a.ag_class_name, dpcd: a.dpcd,
        exec_code: a.executive_code || null, exec_name: a.executive_name || a.field_officer_name || '(Unassigned)',
        ag_status: (a.supply_stop_flag === 'Y') ? 'Stopped' : a.suspend_date ? 'Suspended' : 'Active',
        supply_start_dt: fmtDate(a.supply_start_dt),
        outstanding, bill_amt: o ? N(o.bill_amt) : 0, rec_amt: o ? N(o.rec_amt) : 0, op_amt: o ? N(o.op_amt) : 0,
        last_visit: lastVisit ? fmtDate(lastVisit) : null, days_since_visit: daysSinceVisit,
        cur_supply: cur, peak30_supply: peak30, decline_pct: declinePct, opportunity_copies,
        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
        tags, score: R1(score),
      };
      return sig;
    });
  }

  function statusFromTags(tags) {
    if (tags.includes('URGENT_ACTION') || tags.includes('SUPPLY_AT_RISK')) return 'Risk';
    if (tags.includes('WIN_BACK')) return 'Growth Opportunity';
    if (tags.includes('VISIT_OVERDUE') || tags.includes('COLLECTION_RECOVERY') || tags.includes('NO_VISIT_HISTORY')) return 'Underperforming';
    return 'Healthy';
  }

  function expectedOutcome(a) {
    const bits = [];
    if (a.tags.includes('WIN_BACK')) bits.push(`+${a.opportunity_copies} copies/day if supply restored to peak`);
    if (a.outstanding > 0) bits.push(`${fmtINR(a.outstanding)} recoverable`);
    if (a.tags.includes('SUPPLY_AT_RISK')) bits.push('diagnose zero-supply cause');
    if (!bits.length) bits.push('confirm agency health, log visit');
    return bits.join(' + ');
  }

  // ── Deterministic AI brief — every number is copied from the computed
  //    signal, never invented, matching the ai_nexus.js narrative contract ──
  function buildBrief(anchor, ctx) {
    const status = statusFromTags(anchor.tags);
    const bits = [];
    if (anchor.tags.includes('URGENT_ACTION')) bits.push(`${fmtINR(anchor.outstanding)} outstanding with ${anchor.days_since_visit == null ? 'no visit on record' : anchor.days_since_visit + ' days since last visit'} — needs immediate attention.`);
    if (anchor.tags.includes('WIN_BACK')) bits.push(`Supply has dropped ${Math.abs(anchor.decline_pct)}% from its 30-day peak of ${anchor.peak30_supply} copies — recovering it adds ~${anchor.opportunity_copies} copies/day.`);
    if (anchor.tags.includes('SUPPLY_AT_RISK')) bits.push(`Supply has fallen to zero from a 30-day peak of ${anchor.peak30_supply} copies.`);
    if (anchor.tags.includes('COLLECTION_RECOVERY') && !anchor.tags.includes('URGENT_ACTION')) bits.push(`${fmtINR(anchor.outstanding)} pending collection.`);
    if (anchor.tags.includes('VISIT_OVERDUE') && !bits.length) bits.push(`${anchor.days_since_visit == null ? 'Never visited' : anchor.days_since_visit + ' days since last visit'} — overdue for a check-in.`);
    if (ctx.complaintCount > 0) bits.push(`${ctx.complaintCount} visit remark${ctx.complaintCount === 1 ? '' : 's'} flagged a possible complaint in the last 6 months.`);
    if (!bits.length) bits.push(`Supplying steadily at ${anchor.cur_supply} copies/day with no outstanding or visit-overdue flags — healthy.`);
    return { status, summary: bits.join(' '), engine: 'template' };
  }

  function buildNextBestAction(anchor, ctx) {
    const recs = [];
    if (anchor.tags.includes('URGENT_ACTION')) recs.push(`Visit immediately — ${fmtINR(anchor.outstanding)} outstanding and ${anchor.days_since_visit == null ? 'no visit on record' : anchor.days_since_visit + ' days unvisited'}.`);
    if (anchor.tags.includes('WIN_BACK')) recs.push(`Diagnose the ${Math.abs(anchor.decline_pct)}% supply decline — restoring to the 30-day peak recovers ~${anchor.opportunity_copies} copies/day.`);
    if (anchor.tags.includes('SUPPLY_AT_RISK')) recs.push(`Call the agency today — supply has gone to zero from a peak of ${anchor.peak30_supply} copies/day.`);
    if (anchor.tags.includes('COLLECTION_RECOVERY')) recs.push(`Follow up for ${fmtINR(anchor.outstanding)} pending collection.`);
    if (anchor.tags.includes('VISIT_OVERDUE') && !recs.length) recs.push(`Schedule a visit — ${anchor.days_since_visit == null ? 'never visited' : anchor.days_since_visit + ' days since last visit'}.`);
    if (ctx.nearby.length) recs.push(`${ctx.nearby.length} other agenc${ctx.nearby.length === 1 ? 'y is' : 'ies are'} within ${NEARBY_RADIUS_KM}km — worth combining into one route.`);
    if (!recs.length) recs.push('No action needed — agency is healthy. Keep on the regular visit cadence.');
    return recs.slice(0, 5);
  }

  app.get('/api/agency-profile/:unit_code/:agcd', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const { unit_code, agcd } = req.params;

      const allowed = await getScopeUnitCodes(req.auth.personCode, req.auth.hierarchyLevel);
      if (allowed && !allowed.includes(unit_code)) return res.status(403).json({ detail: 'Outside your assigned scope' });

      const signals = await computeUnitAgencySignals(unit_code);
      let anchor = signals.find(s => s.agcd === agcd);
      if (!anchor) return res.status(404).json({ detail: 'Agency not found in this unit' });

      const [collHistR, supHistR, collRecentR, oraVisitsR, appVisitsR, execLocR] = await Promise.all([
        q(`SELECT DATE_FORMAT(coll_date,'%Y-%m') month,
                  -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) collection,
                   SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) charges,
                   COUNT(*) txn_count, MAX(coll_date) last_date
           FROM agency_collection
           WHERE unit_code = ? AND ag_code = ? AND is_valid = 1
             AND coll_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 12`, [unit_code, agcd]),
        q(`SELECT DATE_FORMAT(supply_date,'%Y-%m') month,
                  SUM(sup_copy) total_supply, COUNT(DISTINCT supply_date) supply_days
           FROM supply_data
           WHERE unit_code = ? AND agcd = ? AND sup_type_code = 'S01'
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 12`, [unit_code, agcd]),
        // Collections are stored as negative amounts (see collHistR's sign flip above) —
        // only actual receipts belong in this list, not positive-amount charge/debit rows.
        q(`SELECT coll_date, -amount amount, payment_mode, payment_cat, doc_type
           FROM agency_collection
           WHERE unit_code = ? AND ag_code = ? AND is_valid = 1 AND amount < 0
             AND coll_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
           ORDER BY coll_date DESC LIMIT 30`, [unit_code, agcd]),
        q(`SELECT visit_date, executive_name, emp_code, from_time, till_time,
                  visit_purpose, visit_remarks, call_status, followup_amount, followup_date,
                  CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng
           FROM dcr_agency_visit WHERE unit_code = ? AND visit_to_main_code = ?
             AND visit_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
           ORDER BY visit_date DESC, id DESC LIMIT 50`, [unit_code, agcd]),
        q(`SELECT visit_date, staff_name, staff_person_code, check_in, check_out,
                  purpose, remarks, outcome, amount_collected, outstanding_amount, copies_committed,
                  lat, lng
           FROM dcr_visit WHERE unit_code = ? AND target_code = ? AND target_type = 'agent'
             AND visit_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
           ORDER BY visit_date DESC, id DESC LIMIT 50`, [unit_code, agcd]),
        anchor.exec_code ? q(`SELECT lat, lng, exec_name, address FROM exec_locations WHERE emp_code = ? AND lat IS NOT NULL LIMIT 1`, [String(anchor.exec_code)]) : Promise.resolve({ rows: [] }),
      ]);

      // ── Current outstanding detail (bill/rec/op already carried on anchor;
      //    collection_pct needs both) ──────────────────────────────────────
      const exp = anchor.op_amt + anchor.bill_amt;
      const collection_pct = exp > 0 ? R1(anchor.rec_amt / exp * 100) : null;

      // ── Supply trend: this month vs last month, from the agency's own 12mo history ──
      const supHist = supHistR.rows; // DESC by month
      const thisMonth = supHist[0], lastMonth = supHist[1];
      const supply_trend_pct = (thisMonth && lastMonth && N(lastMonth.total_supply) > 0)
        ? R1((N(thisMonth.total_supply) - N(lastMonth.total_supply)) / N(lastMonth.total_supply) * 100) : null;

      // ── Visit intelligence: merge oracle + app, unify shape ──────────────
      const visits = [
        ...oraVisitsR.rows.map(r => ({
          source: 'oracle', date: fmtDate(r.visit_date), time: r.from_time || null,
          executive: r.executive_name, purpose: r.visit_purpose, remarks: r.visit_remarks,
          call_status: r.call_status, commitment_amount: N(r.followup_amount) || null,
          commitment_date: r.followup_date ? fmtDate(r.followup_date) : null,
          amount_collected: null, outcome: null,
          lat: r.lat, lng: r.lng,
        })),
        ...appVisitsR.rows.map(r => ({
          source: 'app', date: fmtDate(r.visit_date), time: r.check_in ? String(r.check_in).slice(11, 16) : null,
          executive: r.staff_name, purpose: r.purpose, remarks: r.remarks,
          call_status: r.outcome, commitment_amount: null, commitment_date: null,
          amount_collected: N(r.amount_collected) || null, outcome: r.outcome,
          copies_committed: N(r.copies_committed) || null,
          lat: r.lat, lng: r.lng,
        })),
      ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      const complaintCount = visits.filter(v => {
        const t = (v.remarks || '').toLowerCase();
        return COMPLAINT_WORDS.some(w => t.includes(w.toLowerCase()) || (v.remarks || '').includes(w));
      }).length;
      const issues = visits.filter(v => {
        const t = (v.remarks || '').toLowerCase();
        return COMPLAINT_WORDS.some(w => t.includes(w.toLowerCase()) || (v.remarks || '').includes(w));
      }).slice(0, 10).map(v => ({ date: v.date, executive: v.executive, remarks: v.remarks }));

      // ── Nearby agencies within radius, same unit ──────────────────────────
      let nearby = [];
      if (anchor.lat != null && anchor.lng != null) {
        nearby = signals
          .filter(s => s.agcd !== agcd && s.lat != null && s.lng != null)
          .map(s => ({ ...s, distance_km: R1(haversineKm(anchor.lat, anchor.lng, s.lat, s.lng)) }))
          .filter(s => s.distance_km <= NEARBY_RADIUS_KM)
          .sort((a, b) => a.distance_km - b.distance_km)
          .slice(0, 10)
          .map(s => ({
            agcd: s.agcd, ag_name: s.ag_name, distance_km: s.distance_km, outstanding: s.outstanding,
            days_since_visit: s.days_since_visit, tags: s.tags, cur_supply: s.cur_supply,
          }));
      }

      const execLoc = execLocR.rows[0] || null;
      const ctx = { complaintCount, nearby };
      const status = statusFromTags(anchor.tags);

      res.json({
        identity: {
          ag_name: anchor.ag_name, agcd: anchor.agcd, unit_code: anchor.unit_code, unit_name: anchor.unit_name,
          state_name: anchor.state_name || anchor.unit_state_nm, dist_name: anchor.dist_name, city_name: anchor.city_name,
          station_code: anchor.station_code, station_name: anchor.station_name, area_code: anchor.area_code, address: anchor.address,
          mobile_no1: anchor.mobile_no1, ag_class_name: anchor.ag_class_name, ag_status: anchor.ag_status,
          supply_start_dt: anchor.supply_start_dt,
          exec_code: anchor.exec_code, exec_name: anchor.exec_name,
          exec_location: execLoc ? { lat: N(execLoc.lat), lng: N(execLoc.lng), address: execLoc.address || '' } : null,
        },
        status,
        metrics: {
          current_supply: anchor.cur_supply,
          supply_trend_pct,
          collection_efficiency_pct: collection_pct,
          outstanding: anchor.outstanding,
          growth_potential_copies: anchor.opportunity_copies || Math.max(0, anchor.peak30_supply - anchor.cur_supply),
          last_visit_date: anchor.last_visit,
          last_visit_days_ago: anchor.days_since_visit,
        },
        trends: {
          supply_history: supHist.map(r => ({ month: r.month, total_supply: N(r.total_supply), supply_days: N(r.supply_days) })),
          collection_history: collHistR.rows.map(r => ({ month: r.month, collection: N(r.collection), charges: N(r.charges), txn_count: N(r.txn_count) })),
        },
        opportunity_risk: { tags: anchor.tags, score: anchor.score, expected_outcome: expectedOutcome(anchor), decline_pct: anchor.decline_pct, peak30_supply: anchor.peak30_supply },
        visits: visits.slice(0, 30),
        issues,
        nearby,
        collection_recent: collRecentR.rows.map(r => ({ date: fmtDate(r.coll_date), amount: N(r.amount), payment_mode: r.payment_mode, payment_cat: r.payment_cat, doc_type: r.doc_type })),
        ai_brief: buildBrief(anchor, ctx),
        next_best_action: buildNextBestAction(anchor, ctx),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
