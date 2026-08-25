'use strict';

/**
 * Patrika Vitran — Tour Plan Validation
 *
 * Compares a submitted tour plan (synced from Oracle CIR_TOUR_PLAN_DTL via
 * oracle_tour_plan_sync.js) against what the AI would recommend for that
 * executive today (same outstanding/followup/visit-recency prioritization
 * already used by dcr_analytics.js's next-day-plan), and produces a Hindi
 * verdict: is the submitted plan correct, what should today's plan actually
 * be, and which nearby high-priority agencies are being missed.
 *
 * "Whose plan is this" is resolved by AGENCY OWNERSHIP (agency_master's
 * executive_name for each visited agcd), not by CREATED_BY — an Incharge can
 * create the entry on an executive's behalf, but the territory still belongs
 * to the executive who owns those agencies.
 *
 * Registered by server.js:  require('./tour_plan_validate')(ctx)
 * ctx = { app, q }
 * Also exports computeVerdictsForDate() for the daily cron notifier
 * (tour_plan_daily_notify.js) to reuse without an HTTP round-trip.
 */

const N = v => { const x = Number(v); return isNaN(x) ? 0 : x; };
function fmtINR(v) {
  const n = N(v); const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}
const NEARBY_RADIUS_KM = 5;
const TOP_N = 8; // same "top 8 agencies" scope as next-day-plan

// ── AI recommendation for one executive (same logic/weights as dcr_analytics's
//    next-day-plan Tier-3 rule engine — kept independent here since the daily
//    cron notifier must run standalone, without the API server up) ───────────
// unitCode scopes every lookup: agcd is unique only WITHIN a unit (agency_master's real
// key is unit+agcd), so an unscoped agcd match can pull an unrelated same-coded agency
// from another unit into an executive's recommendation.
async function buildAiRecommendation(q, execName, unitCode) {
  const uAg = unitCode ? ' AND unit=?' : '';   // agency_master's column is `unit`, not `unit_code`
  const uP  = unitCode ? [unitCode] : [];
  const [agR, visitR, osR, supR] = await Promise.all([
    q(`SELECT agcd, ag_name, COALESCE(city_name, dist_name) city_name, unit AS unit_code, unit_name
       FROM agency_master
       WHERE executive_name=? AND CAST(dpcd AS UNSIGNED)=1${uAg}
         AND (supply_stop_flag IS NULL OR supply_stop_flag!='Y') AND suspend_date IS NULL
       LIMIT 150`, [execName, ...uP]),
    q(`SELECT visit_to_main_code ag_code, MAX(mark_attn_date) last_visit, MAX(followup_amount) fup_amt, MAX(followup_date) fup_date
       FROM dcr_agency_visit
       WHERE executive_name=? AND mark_attn_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
         ${unitCode ? 'AND unit_code=?' : ''}
       GROUP BY visit_to_main_code`, [execName, ...uP]),
    q(`SELECT ao.ag_code, ao.cl_amt FROM agency_outstanding ao
       JOIN agency_master am ON am.agcd=ao.ag_code AND am.unit=ao.unit_code AND CAST(am.dpcd AS UNSIGNED)=1
       WHERE am.executive_name=? AND ao.period_label='CURRENT' AND ao.cl_amt>0
         ${unitCode ? 'AND ao.unit_code=?' : ''}
       GROUP BY ao.ag_code`, [execName, ...uP]),
    // Whole-unit 7-day average, narrowed to this executive's agencies in JS below.
    // Joining agency_master here instead made the optimizer drive off idx_sd_agcd and
    // scan every historical row per agency — 30s. Scoped to one unit with the
    // (supply_date, unit_code) index it is ~300ms even for the largest unit.
    unitCode
      ? q(`SELECT s.agcd, AVG(s.sup_copy) avg_sup FROM supply_data s FORCE INDEX (idx_sd_dateunit)
           WHERE s.unit_code = ? AND s.supply_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           GROUP BY s.agcd`, [unitCode])
      : Promise.resolve({ rows: [] }),
  ]);
  const vMap = {}, osMap = {}, supMap = {};
  visitR.rows.forEach(r => { vMap[r.ag_code] = r; });
  osR.rows.forEach(r => { osMap[r.ag_code] = N(r.cl_amt); });
  supR.rows.forEach(r => { supMap[r.agcd] = Math.round(N(r.avg_sup)); });

  const seen = new Set();
  const list = agR.rows.filter(r => !seen.has(r.agcd) && seen.add(r.agcd)).map(ag => {
    const v = vMap[ag.agcd] || {};
    const os = osMap[ag.agcd] || 0;
    const days = v.last_visit ? Math.floor((Date.now() - new Date(v.last_visit)) / 86400000) : 999;
    const avgSup = supMap[ag.agcd] || 0;
    return {
      agcd: ag.agcd, ag_name: ag.ag_name, city: ag.city_name || '', unit_code: ag.unit_code, unit_name: ag.unit_name,
      outstanding: os, days_since_visit: days === 999 ? null : days,
      fup_amt: N(v.fup_amt), fup_date: v.fup_date || null, avg_supply: avgSup,
      score: (os / 10000) + (days >= 999 ? 15 : Math.min(days / 3, 20)) + (v.fup_amt > 0 ? 20 : 0),
    };
  }).sort((a, b) => b.score - a.score);

  return list.slice(0, TOP_N);
}

// ── Submitted plan for one executive+date, grouped by AGENCY OWNERSHIP ──────
async function getSubmittedPlan(q, date) {
  const { rows } = await q(
    `SELECT unit_code, visit_to_main_code agcd, agency_name, station_name, from_time, till_time,
            visit_purpose, call_type_name, current_outstanding, current_growth_target,
            approved_flag, cancel_status, station_lat, station_lng
     FROM cir_tour_plan_dtl
     WHERE visit_date = ? AND COALESCE(cancel_status,'N') != 'Y' AND visit_to_main_code IS NOT NULL`,
    [date]);
  return rows;
}

// ── Resolve which executive owns each submitted agency (JS map — agency_master
//    is the authority for "who owns this agency", not CREATED_BY) ───────────
async function attachOwnerAndGroup(q, submittedRows) {
  const agcds = [...new Set(submittedRows.map(r => r.agcd).filter(Boolean))];
  if (!agcds.length) return new Map();
  const ph = agcds.map(() => '?').join(',');
  const { rows: owners } = await q(
    `SELECT agcd, unit AS unit_code, executive_name, unit_name FROM agency_master
     WHERE agcd IN (${ph}) AND CAST(dpcd AS UNSIGNED)=1`, agcds);
  const ownerMap = new Map(owners.map(o => [`${o.unit_code}|${o.agcd}`, o]));

  const byExec = new Map();
  submittedRows.forEach(r => {
    const owner = ownerMap.get(`${r.unit_code}|${r.agcd}`);
    const execName = owner ? owner.executive_name : null;
    if (!execName) return; // agency not found / not owned by a credit-sale executive — skip
    const key = execName;
    if (!byExec.has(key)) byExec.set(key, { exec_name: execName, unit_code: owner.unit_code, unit_name: owner.unit_name, submitted: [] });
    byExec.get(key).submitted.push(r);
  });
  return byExec;
}

// ── Nearby GPS lookup (dcr_agency_visit/dcr_visit visit-time GPS, same as
//    ai_nexus.js's buildAgencySignals — kept independent for the standalone cron) ─
async function gpsMapFor(q, unitCode) {
  const [{ rows: gpsOra }, { rows: gpsApp }] = await Promise.all([
    q(`SELECT visit_to_main_code agcd, CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng, visit_date
       FROM dcr_agency_visit
       WHERE unit_code = ? AND latitude IS NOT NULL AND latitude<>'' AND longitude IS NOT NULL AND longitude<>''
         AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38 AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98
       ORDER BY visit_date DESC`, [unitCode]),
    q(`SELECT target_code agcd, lat, lng, visit_date FROM dcr_visit
       WHERE unit_code = ? AND target_type='agent' AND lat IS NOT NULL AND lng IS NOT NULL
         AND lat BETWEEN 8 AND 38 AND lng BETWEEN 68 AND 98
       ORDER BY visit_date DESC`, [unitCode]),
  ]);
  const map = new Map();
  [...gpsApp, ...gpsOra].forEach(r => { if (!map.has(r.agcd)) map.set(r.agcd, { lat: N(r.lat), lng: N(r.lng) }); });
  return map;
}

const TAG_HI = { high: 'उच्च', medium: 'मध्यम', low: 'सामान्य' };

// ── Core: verdict for one executive on one date ──────────────────────────────
async function computeVerdict(q, execName, unitCode, unitName, date) {
  const [recommendation, gps] = await Promise.all([
    buildAiRecommendation(q, execName, unitCode),
    gpsMapFor(q, unitCode),
  ]);
  const submittedRows = (await getSubmittedPlan(q, date)).filter(r => r.unit_code === unitCode);
  const submittedAgcds = new Set(submittedRows.map(r => r.agcd));

  const recAgcds = new Set(recommendation.map(r => r.agcd));
  const matched  = recommendation.filter(r => submittedAgcds.has(r.agcd));
  const missing  = recommendation.filter(r => !submittedAgcds.has(r.agcd));
  const lowPriority = submittedRows.filter(r => !recAgcds.has(r.agcd));

  // Nearby gaps: AI-recommended agencies (missing from plan) within radius of
  // any SUBMITTED agency that has GPS — "these nearby agencies should also be covered"
  const nearbyGaps = [];
  submittedRows.forEach(s => {
    const sGps = gps.get(s.agcd) || (s.station_lat != null ? { lat: N(s.station_lat), lng: N(s.station_lng) } : null);
    if (!sGps) return;
    missing.forEach(m => {
      if (nearbyGaps.find(x => x.agcd === m.agcd)) return;
      const mGps = gps.get(m.agcd);
      if (!mGps) return;
      const d = haversineKm(sGps.lat, sGps.lng, mGps.lat, mGps.lng);
      if (d <= NEARBY_RADIUS_KM) nearbyGaps.push({ ...m, distance_km: Math.round(d * 10) / 10, near_agency: s.agency_name });
    });
  });

  const overlapPct = recommendation.length ? Math.round((matched.length / recommendation.length) * 100) : 100;
  const isCorrect = overlapPct >= 50;

  // ── Hindi narrative ──
  const lines = [];
  lines.push(isCorrect
    ? `आपके द्वारा बनाया गया टूर प्लान सही है — ${overlapPct}% प्राथमिकता वाली एजेंसियां कवर हो रही हैं।`
    : `आपके द्वारा बनाया गया टूर प्लान सुधार चाहता है — केवल ${overlapPct}% प्राथमिकता वाली एजेंसियां कवर हो रही हैं।`);
  if (missing.length) {
    lines.push('');
    lines.push('इसके स्थान पर आपका आज का टूर प्लान ये होना चाहिए:');
    missing.forEach((a, i) => {
      const bits = [];
      if (a.outstanding > 0) bits.push(`बकाया ${fmtINR(a.outstanding)}`);
      if (a.fup_amt > 0) bits.push(`वादा की गई राशि ${fmtINR(a.fup_amt)}`);
      bits.push(a.days_since_visit == null ? 'कभी भ्रमण नहीं हुआ' : `${a.days_since_visit} दिन से भ्रमण नहीं`);
      lines.push(`${i + 1}. ${a.ag_name}${a.city ? ' (' + a.city + ')' : ''} — ${bits.join(', ')}`);
    });
  }
  if (nearbyGaps.length) {
    lines.push('');
    lines.push('साथ ही आपके टूर में नजदीकी एजेंसियां ये हैं जिन्हें भी आपको कवर करना है:');
    nearbyGaps.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.ag_name} — ${a.near_agency} से ${a.distance_km} किमी दूर`);
    });
  }
  if (!missing.length && !nearbyGaps.length) lines.push('कोई अतिरिक्त सुझाव नहीं — प्लान पूर्ण है।');

  return {
    exec_name: execName, unit_code: unitCode, unit_name: unitName, date,
    is_correct: isCorrect, overlap_pct: overlapPct,
    matched, missing, low_priority: lowPriority, nearby_gaps: nearbyGaps,
    submitted_count: submittedRows.length, recommended_count: recommendation.length,
    hindi_message: lines.join('\n'),
  };
}

// Placeholder owners in agency_master — unassigned markers, not people to advise.
const PLACEHOLDER_EXEC = new Set(['N/A', '#N/A', 'NA', 'NOT APPLICABLE', 'NAEXECUTIVE', 'NONE', '']);
const isPlaceholderExec = n => PLACEHOLDER_EXEC.has(String(n || '').trim().toUpperCase());

// ── Daily sweep: every executive with a submitted plan for `date` ───────────
// Used by both the on-demand "all executives today" API and the cron notifier.
async function computeVerdictsForDate(q, date, unitCode) {
  const submittedRows = await getSubmittedPlan(q, date);
  const byExec = await attachOwnerAndGroup(q, submittedRows);
  const results = [];
  for (const { exec_name, unit_code, unit_name } of byExec.values()) {
    if (isPlaceholderExec(exec_name)) continue;
    if (unitCode && unit_code !== unitCode) continue;
    try {
      results.push(await computeVerdict(q, exec_name, unit_code, unit_name, date));
    } catch (e) { /* one exec's failure shouldn't sink the sweep */ }
  }
  return results;
}

module.exports = function registerTourPlanValidate(ctx) {
  const { app, q } = ctx;

  // ════ GET /api/tour-plan-validation/:exec_name ════
  // ?unit_code=&date=YYYY-MM-DD — on-demand verdict for one executive
  app.get('/api/tour-plan-validation/:exec_name', async (req, res) => {
    try {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
      const unitCode = req.query.unit_code;
      if (!unitCode) return res.status(400).json({ detail: 'unit_code query param required' });
      const { rows: u } = await q(`SELECT unit_name FROM units WHERE unit_code = ? LIMIT 1`, [unitCode]);
      const verdict = await computeVerdict(q, req.params.exec_name, unitCode, u[0]?.unit_name || unitCode, date);
      res.json(verdict);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/tour-plan-validation ════
  // ?date=YYYY-MM-DD — every executive with a submitted plan that day
  app.get('/api/tour-plan-validation', async (req, res) => {
    try {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
      const unitCode = (req.query.unit_code || '').trim() || null;
      const results = await computeVerdictsForDate(q, date, unitCode);
      // Roll-up for the screen's header: how many executives planned, and how well.
      const n = results.length;
      const correct = results.filter(r => r.is_correct).length;
      const summary = {
        executives: n,
        plans_correct: correct,
        plans_need_work: n - correct,
        avg_overlap_pct: n ? Math.round(results.reduce((s, r) => s + r.overlap_pct, 0) / n) : null,
        planned_visits: results.reduce((s, r) => s + r.submitted_count, 0),
        missed_priority: results.reduce((s, r) => s + r.missing.length, 0),
      };
      res.json({ date, unit_code: unitCode, count: n, summary, results });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};

module.exports.computeVerdict = computeVerdict;
module.exports.computeVerdictsForDate = computeVerdictsForDate;
