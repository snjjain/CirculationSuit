'use strict';

/**
 * Patrika Vitran — Strategic AI Nexus
 *
 * Proactive "AI Circulation Boss" briefing, modelled on Input Reports/AI
 * Circulation Insights.docx: surfaces urgent agencies, win-back/growth
 * opportunities, collection recovery, supply risk, a next-7-day tour plan
 * per executive, and geo-clustered "nearby agencies being missed" alerts.
 *
 * Every number is computed from live database values — the narrative
 * (ai_summary / recommendations) is the only LLM-generated part, and it is
 * built strictly from the computed digest (never invents figures). Works
 * without ANTHROPIC_API_KEY via a deterministic template fallback.
 *
 * Registered by server.js:  require('./ai_nexus')(ctx)
 * ctx = { app, q, getScopeUnitCodes, getOuScopeFilter, computeInsights }
 */

module.exports = function registerAiNexus(ctx) {
  const { app, q, getOuScopeFilter, computeInsights } = ctx;

  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
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

  // Publications excluded from Agent Sale-based signals — matches Supply Dashboard convention.
  const EXCLUDE_PUBS = ['P14'];
  const NEARBY_RADIUS_KM = 5;

  // ── Optional Claude narrative (same convention as ask_ai.js) ────────────────
  let anthropic = null;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  } catch (_) { /* SDK not installed / key missing — template fallback below */ }
  const CLAUDE_MODEL = process.env.ASK_AI_MODEL || 'claude-opus-5';

  // ── Core: per-agency signal set for the caller's scope ───────────────────────
  // Merges agency_master (active CREDIT SALE agencies) + agency_outstanding
  // (CURRENT) + supply_data (30-day peak vs latest) + DCR visit recency/GPS —
  // all joined in JS, never via cross-table SQL JOIN/UNION: Oracle-synced
  // tables use utf8mb4_unicode_ci, this app's own tables use
  // utf8mb4_0900_ai_ci, and a raw JOIN/UNION across the two collations errors.
  async function buildAgencySignals(req) {
    const scOu = await getOuScopeFilter(req); // { clause: ' AND unit_code IN (...)', params }
    const onUnit = col => scOu.clause.replace('unit_code', col);

    const [{ rows: active }, { rows: outR }, { rows: supR }, { rows: visitOra }, { rows: visitApp },
           { rows: gpsOra }, { rows: gpsApp }] = await Promise.all([
      q(`SELECT unit AS unit_code, agcd, ag_name, unit_name, city_name,
                executive_code, executive_name
         FROM agency_master
         WHERE ag_class_name = 'CREDIT SALE' AND COALESCE(supply_stop_flag,'N') = 'N'
           AND (suspend_date IS NULL OR suspend_date > CURDATE())
           AND CAST(dpcd AS UNSIGNED) = 1${onUnit('unit')}`, scOu.params),
      q(`SELECT unit_code, ag_code, cl_amt, last_supply_date, last_supply_copies
         FROM agency_outstanding WHERE period_label = 'CURRENT'${scOu.clause}`, scOu.params),
      q(`SELECT s.unit_code, s.agcd, MAX(s.sup_copy) peak30,
                SUM(CASE WHEN s.supply_date = (SELECT MAX(supply_date) FROM supply_data) THEN s.sup_copy ELSE 0 END) cur
         FROM supply_data s
         WHERE s.sup_type_code = 'S01' AND COALESCE(s.publ,'') NOT IN (${EXCLUDE_PUBS.map(p => `'${p}'`).join(',')})
           AND s.supply_date > DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 30 DAY)${onUnit('s.unit_code')}
         GROUP BY s.unit_code, s.agcd`, scOu.params),
      q(`SELECT unit_code, visit_to_main_code agcd, MAX(mark_attn_date) last_visit
         FROM dcr_agency_visit WHERE mark_attn_date IS NOT NULL${scOu.clause}
         GROUP BY unit_code, visit_to_main_code`, scOu.params),
      q(`SELECT unit_code, target_code agcd, MAX(visit_date) last_visit
         FROM dcr_visit WHERE target_type = 'agent' AND visit_date IS NOT NULL${scOu.clause}
         GROUP BY unit_code, target_code`, scOu.params),
      q(`SELECT unit_code, visit_to_main_code agcd,
                CAST(latitude AS DECIMAL(10,6)) lat, CAST(longitude AS DECIMAL(10,6)) lng, visit_date
         FROM dcr_agency_visit
         WHERE latitude IS NOT NULL AND latitude<>'' AND longitude IS NOT NULL AND longitude<>''
           AND CAST(latitude AS DECIMAL(10,6)) BETWEEN 8 AND 38
           AND CAST(longitude AS DECIMAL(10,6)) BETWEEN 68 AND 98${scOu.clause}
         ORDER BY visit_date DESC`, scOu.params),
      q(`SELECT unit_code, target_code agcd, lat, lng, visit_date
         FROM dcr_visit
         WHERE target_type='agent' AND lat IS NOT NULL AND lng IS NOT NULL
           AND lat BETWEEN 8 AND 38 AND lng BETWEEN 68 AND 98${scOu.clause}
         ORDER BY visit_date DESC`, scOu.params),
    ]);

    const key = (u, a) => `${u}|${a}`;
    const outMap = new Map(outR.map(r => [key(r.unit_code, r.ag_code), r]));
    const supMap = new Map(supR.map(r => [key(r.unit_code, r.agcd), r]));
    const visitMap = new Map();
    [...visitOra, ...visitApp].forEach(r => {
      const k = key(r.unit_code, r.agcd);
      const cur = visitMap.get(k);
      if (!cur || r.last_visit > cur) visitMap.set(k, r.last_visit);
    });
    const gpsMap = new Map();
    // appGps first: dcr_visit (newer app) rows are preferred when both sources have a fix.
    [...gpsApp, ...gpsOra].forEach(r => {
      const k = key(r.unit_code, r.agcd);
      if (!gpsMap.has(k)) gpsMap.set(k, { lat: N(r.lat), lng: N(r.lng) });
    });

    const today = new Date();
    return active.map(a => {
      const k = key(a.unit_code, a.agcd);
      const o = outMap.get(k);
      const s = supMap.get(k);
      const lastVisit = visitMap.get(k);
      const gps = gpsMap.get(k);
      const outstanding = o ? N(o.cl_amt) : 0;
      const daysSinceVisit = lastVisit ? daysBetween(today, new Date(lastVisit)) : null;
      const peak30 = s ? N(s.peak30) : 0;
      const cur = s ? N(s.cur) : (o ? N(o.last_supply_copies) : 0);
      const declinePct = peak30 > 0 ? Math.round((cur - peak30) / peak30 * 1000) / 10 : null;

      const tags = [];
      if (outstanding >= 100000 && (daysSinceVisit == null || daysSinceVisit >= 14)) tags.push('URGENT_ACTION');
      if (peak30 >= 50 && declinePct != null && declinePct <= -30) tags.push('WIN_BACK');
      if (peak30 > 0 && cur === 0) tags.push('SUPPLY_AT_RISK');
      if (daysSinceVisit == null || daysSinceVisit >= 21) tags.push('VISIT_OVERDUE');
      if (outstanding >= 50000 && !tags.includes('URGENT_ACTION')) tags.push('COLLECTION_RECOVERY');
      if (!tags.length) tags.push('MONITOR');

      const score = (outstanding / 50000) * 3
        + (daysSinceVisit == null ? 12 : Math.min(daysSinceVisit / 7, 8)) * 2
        + (declinePct != null && declinePct < 0 ? Math.min(-declinePct / 10, 10) : 0) * 2;

      return {
        unit_code: a.unit_code, agcd: a.agcd, ag_name: a.ag_name, unit_name: a.unit_name, city_name: a.city_name,
        exec_code: a.executive_code || null, exec_name: a.executive_name || '(Unassigned)',
        outstanding, last_visit: lastVisit ? fmtDate(lastVisit) : null, days_since_visit: daysSinceVisit,
        cur_supply: cur, peak30_supply: peak30, decline_pct: declinePct,
        opportunity_copies: tags.includes('WIN_BACK') ? Math.round(peak30 - cur) : 0,
        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
        tags, score: Math.round(score * 10) / 10,
      };
    });
  }

  // ── Nearby clustering: geographically-close flagged agencies (§3/§4 of spec) ─
  // Bounded to the top-scoring 200 flagged agencies before the O(n²) sweep so an
  // admin's PAN-India scope (thousands of agencies) still resolves quickly.
  function computeNearbyClusters(signals) {
    const flagged = signals
      .filter(s => !s.tags.includes('MONITOR') && s.lat != null && s.lng != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);

    const clusters = [];
    const used = new Set();
    for (let i = 0; i < flagged.length; i++) {
      if (used.has(i)) continue;
      const anchor = flagged[i];
      const group = [anchor];
      for (let j = i + 1; j < flagged.length; j++) {
        if (used.has(j)) continue;
        const cand = flagged[j];
        if (cand.unit_code !== anchor.unit_code) continue; // keep clusters within one branch's route
        if (haversineKm(anchor.lat, anchor.lng, cand.lat, cand.lng) <= NEARBY_RADIUS_KM) {
          group.push(cand); used.add(j);
        }
      }
      if (group.length >= 2) { used.add(i); clusters.push(group); }
    }
    return clusters
      .map(g => ({
        unit_code: g[0].unit_code, unit_name: g[0].unit_name,
        agencies: g.map(a => ({ agcd: a.agcd, ag_name: a.ag_name, tags: a.tags, outstanding: a.outstanding,
          opportunity_copies: a.opportunity_copies, days_since_visit: a.days_since_visit, exec_name: a.exec_name })),
        combined_score: Math.round(g.reduce((s, a) => s + a.score, 0) * 10) / 10,
      }))
      .sort((a, b) => b.combined_score - a.combined_score);
  }

  // ── 7-day tour plan: bucket each executive's top flagged agencies by day,
  //    chained by nearest-neighbour when GPS is available ─────────────────────
  function buildTourPlan(signals, days) {
    const byExec = new Map();
    signals.filter(s => !s.tags.includes('MONITOR')).forEach(s => {
      const k = s.exec_code || s.exec_name;
      if (!byExec.has(k)) byExec.set(k, { exec_code: s.exec_code, exec_name: s.exec_name, unit_name: s.unit_name, agencies: [] });
      byExec.get(k).agencies.push(s);
    });

    const PER_DAY = 2;
    const executives = [];
    for (const ex of byExec.values()) {
      const pool = ex.agencies.sort((a, b) => b.score - a.score).slice(0, days * PER_DAY);
      const chosenAgcds = new Set(pool.map(a => a.agcd));
      const plan = [];
      const today = new Date();
      for (let d = 0; d < days; d++) {
        const dayAgencies = pool.slice(d * PER_DAY, d * PER_DAY + PER_DAY);
        if (!dayAgencies.length) continue;
        // suggested add-ons: other flagged agencies (same unit, not already in this exec's week)
        // within radius of any of today's primary stops
        const addons = [];
        dayAgencies.forEach(primary => {
          if (primary.lat == null) return;
          ex.agencies.forEach(cand => {
            if (chosenAgcds.has(cand.agcd) || addons.find(x => x.agcd === cand.agcd)) return;
            if (cand.lat == null) return;
            if (haversineKm(primary.lat, primary.lng, cand.lat, cand.lng) <= NEARBY_RADIUS_KM) {
              addons.push({ agcd: cand.agcd, ag_name: cand.ag_name, distance_km: Math.round(haversineKm(primary.lat, primary.lng, cand.lat, cand.lng) * 10) / 10,
                tags: cand.tags, opportunity_copies: cand.opportunity_copies, outstanding: cand.outstanding, reason: cand.tags[0] });
            }
          });
        });
        const date = new Date(today); date.setDate(date.getDate() + d + 1);
        plan.push({
          day: d + 1, date: fmtDate(date),
          agencies: dayAgencies.map(a => ({
            agcd: a.agcd, ag_name: a.ag_name, city_name: a.city_name, tags: a.tags,
            outstanding: a.outstanding, opportunity_copies: a.opportunity_copies,
            days_since_visit: a.days_since_visit, last_visit: a.last_visit,
          })),
          suggested_addons: addons.slice(0, 3),
        });
      }
      if (plan.length) executives.push({ exec_code: ex.exec_code, exec_name: ex.exec_name, unit_name: ex.unit_name, plan });
    }
    return executives.sort((a, b) => b.plan.reduce((s, p) => s + p.agencies.length, 0) - a.plan.reduce((s, p) => s + p.agencies.length, 0));
  }

  // ── Narrative: Claude if configured, deterministic template otherwise ───────
  function extractJson(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const start = raw.indexOf('{');
    if (start === -1) throw new Error('No JSON in model output');
    return JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
  }

  function deterministicNarrative(digest) {
    const { immediate_attention, opportunities, collection_opportunities, supply_risks, expected_impact } = digest;
    const parts = [];
    if (immediate_attention.length) parts.push(`${immediate_attention.length} item(s) need immediate attention across the current scope.`);
    if (opportunities.length) parts.push(`${opportunities.length} agencies show a win-back opportunity worth ~${expected_impact.supply_growth_copies.toLocaleString('en-IN')} copies/day if recovered to their 30-day peak.`);
    if (collection_opportunities.length) parts.push(`${collection_opportunities.length} agencies carry recoverable outstanding of ${fmtINR(expected_impact.collection_recovery)}.`);
    if (supply_risks.length) parts.push(`${supply_risks.length} previously-supplying agencies are at zero supply today.`);
    const summary = parts.length ? parts.join(' ') : 'No significant risks or opportunities detected in the current scope — all monitored signals look healthy.';

    const recs = [];
    opportunities.slice(0, 3).forEach(a => recs.push(
      `Win back ${a.ag_name} (${a.unit_name}) — supply has dropped ${Math.abs(a.decline_pct)}% from its 30-day peak; recovering it would add ~${a.opportunity_copies} copies/day.`));
    collection_opportunities.slice(0, 3).forEach(a => recs.push(
      `Recover ${fmtINR(a.outstanding)} pending from ${a.ag_name} (${a.unit_name}) — ${a.days_since_visit == null ? 'never visited' : a.days_since_visit + ' days since last visit'}.`));
    supply_risks.slice(0, 2).forEach(a => recs.push(
      `${a.ag_name} (${a.unit_name}) has dropped to zero supply from a 30-day peak of ${a.peak30_supply} copies — visit immediately to diagnose.`));
    return { summary, recommendations: recs.slice(0, 8), engine: 'template' };
  }

  async function aiNarrative(digest) {
    if (!anthropic) return deterministicNarrative(digest);
    try {
      const sys = `You are the AI Circulation Boss for a newspaper circulation organization — proactive, decisive, ` +
        `data-grounded. Given a JSON digest of computed signals (never invent numbers not present in it), reply ONLY ` +
        `with JSON: {"summary":"2-3 sentence executive summary citing real numbers","recommendations":["decisive, ` +
        `numbered-style sentence per item, e.g. 'Add Agency ABC to Day 2 — 2.8 km from planned route, +180 copies ` +
        `opportunity, ₹75,000 pending, not visited 28 days.'"]}. Max 8 recommendations. Never say \"you may consider\" — ` +
        `be decisive.`;
      const resp = await anthropic.messages.create({
        model: CLAUDE_MODEL, max_tokens: 1400, system: sys,
        messages: [{ role: 'user', content: JSON.stringify(digest).slice(0, 24000) }],
      });
      if (resp.stop_reason === 'refusal') throw new Error('Model declined the request');
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const parsed = extractJson(text);
      return { ...parsed, engine: 'claude' };
    } catch (e) {
      return deterministicNarrative(digest);
    }
  }

  // ── Briefing cache (per scope, 10 min) — mirrors insights.js ────────────────
  const cache = new Map();
  const CACHE_MS = 10 * 60 * 1000;

  // ════ GET /api/ai-nexus/status ════
  app.get('/api/ai-nexus/status', (req, res) => {
    res.json({ ai_configured: !!anthropic, model: anthropic ? CLAUDE_MODEL : 'template' });
  });

  // ════ GET /api/ai-nexus/briefing ════
  app.get('/api/ai-nexus/briefing', async (req, res) => {
    try {
      const personCode = req.headers['x-person-code'] || '';
      const hl = req.headers['x-hierarchy-level'] || '1';
      const cacheKey = `brief|${personCode}|${hl}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS && !req.query.refresh) return res.json({ ...hit.data, cached: true });

      const [signals, insightsData] = await Promise.all([
        buildAgencySignals(req),
        computeInsights(personCode, parseInt(hl, 10), { refresh: !!req.query.refresh }).catch(() => ({ insights: [] })),
      ]);

      const immediate_attention = (insightsData.insights || []).filter(i => i.priority === 'P1').slice(0, 8);
      const opportunities = signals.filter(s => s.tags.includes('WIN_BACK')).sort((a, b) => b.opportunity_copies - a.opportunity_copies).slice(0, 12);
      const collection_opportunities = signals.filter(s => s.tags.includes('URGENT_ACTION') || s.tags.includes('COLLECTION_RECOVERY'))
        .sort((a, b) => b.outstanding - a.outstanding).slice(0, 12);
      const supply_risks = signals.filter(s => s.tags.includes('SUPPLY_AT_RISK')).sort((a, b) => b.peak30_supply - a.peak30_supply).slice(0, 12);
      const overdue_count = signals.filter(s => s.tags.includes('VISIT_OVERDUE')).length;
      const nearby = computeNearbyClusters(signals).slice(0, 8);

      const expected_impact = {
        supply_growth_copies: Math.round(signals.filter(s => s.tags.includes('WIN_BACK')).reduce((s, a) => s + a.opportunity_copies, 0)),
        collection_recovery: Math.round(collection_opportunities.reduce((s, a) => s + a.outstanding, 0)),
        agencies_flagged: signals.filter(s => !s.tags.includes('MONITOR')).length,
        agencies_scoped: signals.length,
      };

      const digest = { immediate_attention, opportunities, collection_opportunities, supply_risks, expected_impact };
      const narrative = await aiNarrative(digest);

      const data = {
        generated_at: new Date().toISOString(),
        immediate_attention,
        opportunities: opportunities.map(a => ({ ...a, fmt_outstanding: fmtINR(a.outstanding) })),
        collection_opportunities: collection_opportunities.map(a => ({ ...a, fmt_outstanding: fmtINR(a.outstanding) })),
        supply_risks,
        overdue_count,
        nearby_alerts: nearby,
        expected_impact: { ...expected_impact, fmt_collection_recovery: fmtINR(expected_impact.collection_recovery) },
        ai_summary: narrative.summary,
        recommendations: narrative.recommendations || [],
        engine: narrative.engine,
      };
      cache.set(cacheKey, { at: Date.now(), data });
      res.json(data);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/ai-nexus/tour-plan ════
  app.get('/api/ai-nexus/tour-plan', async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 14);
      const signals = await buildAgencySignals(req);
      const executives = buildTourPlan(signals, days);
      res.json({
        generated_at: new Date().toISOString(), days, executives,
        note: 'AI-generated from live outstanding/supply/visit signals. Once executive-submitted tour plans are ' +
              'available, this will additionally validate planned routes and flag missed nearby agencies (spec §4).',
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/ai-nexus/nearby-alerts ════
  app.get('/api/ai-nexus/nearby-alerts', async (req, res) => {
    try {
      const signals = await buildAgencySignals(req);
      const clusters = computeNearbyClusters(signals).slice(0, 30);
      res.json({ generated_at: new Date().toISOString(), radius_km: NEARBY_RADIUS_KM, clusters });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/ai-nexus/competitor ════
  // Placeholder until competitor cash/credit-sale benchmark data is supplied.
  app.get('/api/ai-nexus/competitor', async (req, res) => {
    res.json({
      available: false,
      message: 'Competitor cash-sale and credit-sale data has not been uploaded yet. Once provided, this tab will ' +
        'show per-agency and per-unit market-share comparisons against competing publications.',
    });
  });
};
