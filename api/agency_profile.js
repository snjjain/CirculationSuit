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

  /* ══ Branch recovery, for "above average" ══
     Telescoped from the branch's own cumulative snapshots, the same rule as every
     collection figure in this suite. Cached for ten minutes because every agency in a
     branch asks the same question and the answer moves once a month. */
  const _brCache = new Map();
  async function branchLedger(unitCode) {
    const hit = _brCache.get(unitCode);
    if (hit && Date.now() - hit.ts < 600000) return hit.data;
    const { rows } = await q(
      `SELECT period_label, SUM(bill_amt) bill, SUM(rec_amt) + SUM(other_cr) rec
         FROM agency_outstanding
        WHERE unit_code = ? AND period_label REGEXP '^[0-9]{4}-[0-9]{2}$'
        GROUP BY period_label ORDER BY period_label DESC LIMIT 8`, [unitCode]);
    const snaps = rows.slice();
    const months = [];
    for (let i = 0; i < snaps.length - 1 && months.length < 6; i++) {
      const bill = Math.max(0, N(snaps[i].bill) - N(snaps[i + 1].bill));
      const rec  = Math.max(0, N(snaps[i].rec)  - N(snaps[i + 1].rec));
      if (bill > 0) months.push({ month: snaps[i].period_label, pct: (rec / bill) * 100 });
    }
    const data = months.length
      ? { months: months.length, avg_pct: R1(months.reduce((a, m) => a + m.pct, 0) / months.length) }
      : { months: 0, avg_pct: null };
    _brCache.set(unitCode, { data, ts: Date.now() });
    if (_brCache.size > 60) for (const [k, v] of _brCache) if (Date.now() - v.ts > 1200000) _brCache.delete(k);
    return data;
  }

  /* ══ Agency signals ══
     Plain statements about what the ledger actually shows, each carrying the figures it
     was drawn from so the reader can check it rather than trust it. Every one is a
     comparison the agency itself supplies — its own months, its own bill, its own payment
     rhythm, its own branch — never a fixed rupee threshold, which would flag every large
     agency and no small one.

     A signal is omitted when its inputs are missing. An unwritten snapshot is not a month
     of no billing, and silence is more honest than a green tick drawn from nothing. */
  function buildSignals({ ledger, closing, overdue, outstanding, branch, payDates, supRate, daysSinceVisit }) {
    const out = [];
    const add = (level, title, detail) => out.push({ level, title, detail });
    const pctChg = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);

    const billed = ledger.filter(m => m.bill > 0);
    const avgBill = billed.length ? billed.reduce((a, m) => a + m.bill, 0) / billed.length : null;
    const agencyPct = billed.length ? billed.reduce((a, m) => a + m.pct, 0) / billed.length : null;
    const noPay12m = !payDates.length;

    // ── Dues ──────────────────────────────────────────────────────────────────
    if (overdue != null) {
      if (outstanding <= 0) {
        add('good', 'No dues outstanding', 'Account is fully settled.');
      } else if (overdue <= 0) {
        add('good', 'Dues current and within terms',
          `${fmtINR(outstanding)} outstanding is this month's bill — nothing past due.`);
      } else if (avgBill && avgBill > 0) {
        const months = overdue / avgBill;
        if (months >= 1.5) {
          add('risk', 'Overdue amount exceeds normal pattern',
            `${fmtINR(overdue)} overdue — ${months.toFixed(1)} months of billing at its average ${fmtINR(avgBill)} a month.`);
        } else {
          add('watch', 'Carrying overdue dues',
            `${fmtINR(overdue)} overdue — ${months.toFixed(1)} months of its average ${fmtINR(avgBill)} bill.`);
        }
      } else if (noPay12m) {
        /* No bill to size it against and nothing paid in a year — a closed or dormant
           account. VIMAL AGENCIES (CLOSED) sat on 26.69 L unchanged for eight months and
           read as a mild "watch" purely because the absent billing history left the
           comparison with nothing to divide by. */
        add('risk', 'Dormant account carrying dues',
          `${fmtINR(overdue)} past due, with no billing and no receipt in 12 months.`);
      } else {
        add('watch', 'Carrying overdue dues', `${fmtINR(overdue)} past due.`);
      }
    }

    // ── Outstanding, three months on ─────────────────────────────────────────
    // The closing balance across snapshots, not the bill — the question is whether the
    // account is deepening, and a rising bill with matching receipts is not that.
    if (closing.length >= 4) {
      const now = closing[0].cl, then = closing[3].cl;
      const chg = pctChg(now, then), diff = now - then;
      if (chg != null && chg >= 10 && Math.abs(diff) >= 25000) {
        add('watch', 'Outstanding increased during last 3 months',
          `${fmtINR(then)} → ${fmtINR(now)} since ${closing[3].month} (+${chg.toFixed(1)}%).`);
      } else if (chg != null && chg <= -10 && Math.abs(diff) >= 25000) {
        add('good', 'Outstanding reduced over 3 months',
          `${fmtINR(then)} → ${fmtINR(now)} since ${closing[3].month} (${chg.toFixed(1)}%).`);
      }
    }

    // ── Recovery against the branch ──────────────────────────────────────────
    if (agencyPct != null && branch && branch.avg_pct != null && billed.length >= 3) {
      const gap = agencyPct - branch.avg_pct;
      if (gap >= 5) {
        add('good', 'Collection consistently above average',
          `${agencyPct.toFixed(1)}% recovered over ${billed.length} months against the branch's ${branch.avg_pct}%.`);
      } else if (gap <= -15) {
        add('risk', 'Collection below branch average',
          `${agencyPct.toFixed(1)}% recovered over ${billed.length} months against the branch's ${branch.avg_pct}%.`);
      } else if (gap <= -5) {
        add('watch', 'Collection trailing the branch',
          `${agencyPct.toFixed(1)}% recovered over ${billed.length} months against the branch's ${branch.avg_pct}%.`);
      }
    }

    // ── Payment rhythm ───────────────────────────────────────────────────────
    if (payDates.length) {
      const last = payDates[0];
      const sinceLast = daysBetween(Date.now(), last.getTime());
      if (sinceLast >= 45) {
        add('risk', 'No payment received recently',
          `Last receipt ${sinceLast} days ago, on ${fmtDate(last)}.`);
      }
      // Widening gaps beat a single late payment: three intervals against the three before
      // them, so one holiday month does not read as a collapse.
      if (payDates.length >= 7) {
        const gaps = [];
        for (let i = 0; i < payDates.length - 1; i++) gaps.push(daysBetween(payDates[i].getTime(), payDates[i + 1].getTime()));
        const recent = gaps.slice(0, 3), older = gaps.slice(3, 6);
        const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
        const r = mean(recent), o = mean(older);
        const dy = n => `${Math.round(n)} day${Math.round(n) === 1 ? '' : 's'}`;
        if (o > 0 && r >= 20 && r >= o * 1.3) {
          add('risk', 'Payment delay increasing',
            `${dy(r)} between payments lately, against ${dy(o)} before that.`);
        } else if (o >= 7 && r <= o * 0.7 && sinceLast < 45) {
          /* Only worth saying when the gap was meaningful to begin with — an agency
             moving from two days to one has not changed how it pays. */
          add('good', 'Paying more often than before',
            `${dy(r)} between payments lately, against ${dy(o)} before that.`);
        }
      }
    } else if (outstanding > 0 && !out.some(x => x.title === 'Dormant account carrying dues')) {
      // The dormant signal already says this, with the same figure — once is enough.
      add('risk', 'No payment on record this year', `${fmtINR(outstanding)} outstanding with no receipt in 12 months.`);
    }

    // ── Supply ───────────────────────────────────────────────────────────────
    if (supRate && supRate.cur != null && supRate.prev != null && supRate.prev > 0) {
      const chg = pctChg(supRate.cur, supRate.prev);
      if (chg <= -10) {
        add('watch', 'Supply falling',
          `${Math.round(supRate.cur)} copies/day, down from ${Math.round(supRate.prev)} last month (${chg.toFixed(1)}%).`);
      } else if (chg >= 10) {
        add('good', 'Supply growing',
          `${Math.round(supRate.cur)} copies/day, up from ${Math.round(supRate.prev)} last month (+${chg.toFixed(1)}%).`);
      }
    }

    // ── Field contact ────────────────────────────────────────────────────────
    if (daysSinceVisit == null) {
      add('watch', 'No visit in 6 months', 'No field visit on record for this agency.');
    } else if (daysSinceVisit > 30) {
      add('watch', 'Not visited recently', `${daysSinceVisit} days since the last field visit.`);
    }

    // Worst first — this is a list to act on, not a report card.
    const rank = { risk: 0, watch: 1, good: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

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

      const [collHistR, supHistR, collRecentR, oraVisitsR, appVisitsR, execLocR, ledgerR, curOuR,
             branchLed, payDatesR] = await Promise.all([
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
        /* Cumulative bill and receipt snapshots for this agency, newest first. Each
           month's own figures are the difference between consecutive snapshots —
           agency_outstanding.bill_amt and rec_amt are cumulative for the financial
           year, so taking them raw overstates a month several-fold. */
        q(`SELECT period_label, SUM(bill_amt) bill, SUM(rec_amt) + SUM(other_cr) rec,
                  SUM(cl_amt) cl
             FROM agency_outstanding
            WHERE unit_code = ? AND ag_code = ?
              AND period_label REGEXP '^[0-9]{4}-[0-9]{2}$'
            GROUP BY period_label
            ORDER BY period_label DESC LIMIT 8`, [unit_code, agcd]),

        /* The live balance and what has been billed into it since the last month end.
           That difference is the bill raised on the 1st of this month, which is
           collected across this month and is therefore not yet late. */
        q(`SELECT SUM(cl_amt) cl, SUM(bill_amt) bill FROM agency_outstanding
            WHERE unit_code = ? AND ag_code = ? AND period_label = 'CURRENT'`,
          [unit_code, agcd]),

        /* What the branch as a whole recovers, so "above average" means above this
           agency's own peers rather than above some invented number. Cached per branch
           because every agency in it computes the same figure. */
        branchLedger(unit_code),

        /* A year of receipt dates. The 90-day list above drives the receipts table and is
           too short to say whether the gap between payments is widening. */
        q(`SELECT coll_date FROM agency_collection
            WHERE unit_code = ? AND ag_code = ? AND is_valid = 1 AND amount < 0
              AND coll_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
            ORDER BY coll_date DESC LIMIT 40`, [unit_code, agcd]),
      ]);

      /* Telescope the snapshots into per-month bill and net receipt. A month whose
         snapshot pair is incomplete is left out rather than shown as zero — an unwritten
         record is not a month of no billing. */
      const _snaps = (ledgerR.rows || []).slice().sort((a, b) => (a.period_label < b.period_label ? 1 : -1));
      const monthlyLedger = [];
      for (let i = 0; i < _snaps.length - 1 && monthlyLedger.length < 6; i++) {
        const cur = _snaps[i], prv = _snaps[i + 1];
        const bill = Math.max(0, N(cur.bill) - N(prv.bill));
        const rec  = Math.max(0, N(cur.rec)  - N(prv.rec));
        monthlyLedger.push({
          month: cur.period_label,
          bill, net_receipt: rec,
          closing: N(cur.cl),
          pct: bill > 0 ? Math.round((rec / bill) * 1000) / 10 : null,
        });
      }

      /* The signals, built from what the ledger actually shows. Overdue is the same
         figure the card reports above them — the balance less this month's bill — so a
         signal and a card cannot say different things about the same agency. */
      const _overdue = (() => {
        const cur = (curOuR.rows || [])[0];
        if (!cur) return null;
        const lastSnapBill = _snaps.length ? N(_snaps[0].bill) : 0;
        return Math.max(0, N(cur.cl) - Math.max(0, N(cur.bill) - lastSnapBill));
      })();
      const _closing = _snaps.map(r => ({ month: r.period_label, cl: N(r.cl) }));
      /* One payment event per DAY. An agency often settles through several documents on
         the same date, and counting each row separately produced nought-day gaps — which
         made "paying more often than before" fire on agencies six lakh in arrears. */
      const _payDates = [...new Set((payDatesR.rows || [])
        .map(r => r.coll_date && String(r.coll_date).slice(0, 10)).filter(Boolean))]
        .sort().reverse().map(d => new Date(d + 'T00:00:00')).filter(d => !isNaN(d));
      const _supRate = (() => {
        const rt = m => (m && N(m.supply_days) > 0) ? N(m.total_supply) / N(m.supply_days) : null;
        const h = supHistR.rows || [];
        return { cur: rt(h[0]), prev: rt(h[1]) };
      })();
      const _signals = buildSignals({
        ledger: monthlyLedger,
        closing: _closing,
        overdue: _overdue,
        outstanding: N(anchor.outstanding),
        branch: branchLed,
        payDates: _payDates,
        supRate: _supRate,
        daysSinceVisit: anchor.days_since_visit,
      });

      // ── Current outstanding detail (bill/rec/op already carried on anchor;
      //    collection_pct needs both) ──────────────────────────────────────
      const exp = anchor.op_amt + anchor.bill_amt;
      const collection_pct = exp > 0 ? R1(anchor.rec_amt / exp * 100) : null;

      // ── Supply trend: this month vs last month, from the agency's own 12mo history ──
      const supHist = supHistR.rows; // DESC by month
      const thisMonth = supHist[0], lastMonth = supHist[1];
      /* Copies per day, not month totals. Comparing a part-month total against a whole
         previous month makes every agency collapse at the start of a month: on 5
         September GANESH NEWS AGENCY read -83.3% because 5 days of supply were measured
         against 30, while its actual rate — 682 copies a day — had not moved at all.
         Dividing each month by the days it actually supplied compares like with like,
         and matches the figure the DCR app now shows the executive standing in the shop. */
      const rate = m => (m && N(m.supply_days) > 0) ? N(m.total_supply) / N(m.supply_days) : null;
      const curRate = rate(thisMonth), prvRate = rate(lastMonth);
      const supply_trend_pct = (curRate != null && prvRate > 0)
        ? R1((curRate - prvRate) / prvRate * 100) : null;

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
          overdue: (() => {
            const cur = (curOuR.rows || [])[0];
            if (!cur) return null;
            const lastSnapBill = _snaps.length ? N(_snaps[0].bill) : 0;
            const notDue = Math.max(0, N(cur.bill) - lastSnapBill);
            return Math.max(0, N(cur.cl) - notDue);
          })(),
          growth_potential_copies: anchor.opportunity_copies || Math.max(0, anchor.peak30_supply - anchor.cur_supply),
          last_visit_date: anchor.last_visit,
          last_visit_days_ago: anchor.days_since_visit,
        },
        trends: {
          /* Month by month on the ERP's own ledger, not the cash book.

             The panel used to list individual receipts with their payment mode, which
             answered "how was this paid" when the question is "is this agency paying".
             Bill and net receipt are the movement between consecutive cumulative
             snapshots of agency_outstanding — the same basis as every collection
             percentage in the suite, so this table and the Coll % above it cannot
             disagree. agency_collection is deliberately not used: it holds banked cash
             only and omits credit notes and adjustments. */
          ledger_months: monthlyLedger,
          supply_history: supHist.map(r => ({ month: r.month, total_supply: N(r.total_supply), supply_days: N(r.supply_days) })),
          collection_history: collHistR.rows.map(r => ({ month: r.month, collection: N(r.collection), charges: N(r.charges), txn_count: N(r.txn_count) })),
        },
        opportunity_risk: { tags: anchor.tags, score: anchor.score, expected_outcome: expectedOutcome(anchor), decline_pct: anchor.decline_pct, peak30_supply: anchor.peak30_supply },
        signals: _signals,
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
