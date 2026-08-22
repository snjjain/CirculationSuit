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
  // "Flagged" = worth an executive's attention. MONITOR (healthy) and NO_VISIT_HISTORY
  // (never visited, but no outstanding/supply signal either — a data-coverage gap, not a
  // business risk) are excluded from every flagged-agency list, count and ranking.
  const isFlagged = s => !s.tags.includes('MONITOR') && !s.tags.includes('NO_VISIT_HISTORY');

  // ── Narrative engine: free local Ollama first, optional Claude second, ─────
  // deterministic template last — same 3-tier convention as ask_ai.js (and the
  // AI Remarks / Next-Day Plan already shipped in Field Visit Intelligence).
  const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  let ollamaOk = false;
  async function detectOllama() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(OLLAMA_URL + '/api/tags', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) { ollamaOk = false; return; }
      const d = await r.json();
      const names = (d.models || []).map(m => m.name || m.model || '');
      ollamaOk = names.some(n => n === OLLAMA_MODEL || n.split(':')[0] === OLLAMA_MODEL.split(':')[0]);
    } catch (_) { ollamaOk = false; }
  }
  detectOllama();
  setInterval(detectOllama, 5 * 60 * 1000);

  async function ollamaChat(system, userMsg, maxTokens, timeoutMs = 20000) {
    // Bounded wait: the briefing/draft endpoints must respond quickly even when
    // Ollama is slow or already busy with another request (e.g. a Field Visit
    // Intelligence tour-plan generation) — fall through to the deterministic
    // template rather than hang the whole request.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL, stream: false, format: 'json',
          options: { temperature: 0, num_predict: maxTokens || 1500 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        }),
      });
      if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
      const d = await r.json();
      return d.message?.content || '';
    } finally {
      clearTimeout(t);
    }
  }

  let anthropic = null;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  } catch (_) { /* SDK not installed / key missing — Ollama/template still work */ }
  const CLAUDE_MODEL = process.env.ASK_AI_MODEL || 'claude-opus-5';

  async function claudeChat(system, userMsg, maxTokens) {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: maxTokens || 1400, system, messages: [{ role: 'user', content: userMsg }],
    });
    if (resp.stop_reason === 'refusal') throw new Error('Model declined the request');
    return resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

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
                executive_code, executive_name,
                supply_start_dt, supply_stop_flag
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

      // "Never visited" is only a signal worth acting on when paired with real business
      // potential (outstanding or supply activity) — DCR visit-history coverage is sparse
      // (~28k agencies have no visit record at all), so treating every unvisited agency as
      // urgent would flag almost the entire base and drown out the genuinely urgent ones.
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

      const ag_status = (a.supply_stop_flag && a.supply_stop_flag === 'Y') ? 'Closed' : 'Active';
      const sig = {
        unit_code: a.unit_code, agcd: a.agcd, ag_name: a.ag_name, unit_name: a.unit_name, city_name: a.city_name,
        exec_code: a.executive_code || null, exec_name: a.executive_name || '(Unassigned)',
        ag_status, supply_start_dt: a.supply_start_dt || null,
        outstanding, last_visit: lastVisit ? fmtDate(lastVisit) : null, days_since_visit: daysSinceVisit,
        cur_supply: cur, peak30_supply: peak30, decline_pct: declinePct,
        opportunity_copies: tags.includes('WIN_BACK') ? Math.round(peak30 - cur) : 0,
        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
        tags, score: Math.round(score * 10) / 10,
      };
      sig.expected_outcome = expectedOutcome(sig);
      return sig;
    });
  }

  // ── Nearby clustering: geographically-close flagged agencies (§3/§4 of spec) ─
  // Bounded to the top-scoring 200 flagged agencies before the O(n²) sweep so an
  // admin's PAN-India scope (thousands of agencies) still resolves quickly.
  function computeNearbyClusters(signals) {
    const flagged = signals
      .filter(s => isFlagged(s) && s.lat != null && s.lng != null)
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
    if (!ollamaOk && !anthropic) return deterministicNarrative(digest);
    const sys = `You are the AI Circulation Boss for a newspaper circulation organization — proactive, decisive, ` +
      `data-grounded. Given a JSON digest of computed signals (never invent numbers not present in it), reply ONLY ` +
      `with JSON: {"summary":"2-3 sentence executive summary citing real numbers","recommendations":["decisive, ` +
      `numbered-style sentence per item, e.g. 'Add Agency ABC to Day 2 — 2.8 km from planned route, +180 copies ` +
      `opportunity, ₹75,000 pending, not visited 28 days.'"]}. Max 8 recommendations. Never say \"you may consider\" — ` +
      `be decisive.`;
    const userMsg = JSON.stringify(digest).slice(0, 24000);
    try {
      const text = ollamaOk ? await ollamaChat(sys, userMsg, 1400) : await claudeChat(sys, userMsg, 1400);
      const parsed = extractJson(text);
      return { ...parsed, engine: ollamaOk ? 'ollama' : 'claude' };
    } catch (e) {
      return deterministicNarrative(digest);
    }
  }

  // ── Expected business outcome of a single visit (per doc §"expected business
  //    outcome of each visit") — deterministic, no LLM needed for this.
  function expectedOutcome(a) {
    const bits = [];
    if (a.tags.includes('WIN_BACK')) bits.push(`+${a.opportunity_copies} copies/day if supply restored to peak`);
    if (a.outstanding > 0) bits.push(`${fmtINR(a.outstanding)} recoverable`);
    if (a.tags.includes('SUPPLY_AT_RISK')) bits.push('diagnose zero-supply cause');
    if (!bits.length) bits.push('confirm agency health, log visit');
    return bits.join(' + ');
  }

  // ── Hindi narrative — used only for email/Telegram drafts (dashboard stays
  //    English). Ollama first (grounded in the same live digest), deterministic
  //    Hindi template if Ollama is unavailable or returns something unusable. ──
  const TAG_HI = {
    URGENT_ACTION: 'तत्काल कार्रवाई आवश्यक', WIN_BACK: 'वापसी योग्य अवसर',
    SUPPLY_AT_RISK: 'आपूर्ति जोखिम में', COLLECTION_RECOVERY: 'वसूली आवश्यक',
    VISIT_OVERDUE: 'भ्रमण बकाया', NO_VISIT_HISTORY: 'भ्रमण इतिहास नहीं', MONITOR: 'सामान्य',
  };
  const hiTags = tags => (tags || []).map(t => TAG_HI[t] || t).join(', ');

  function deterministicNarrativeHindi(digest) {
    const { opportunities, collection_opportunities, supply_risks, expected_impact } = digest;
    const parts = [];
    if (opportunities.length) parts.push(`${opportunities.length} एजेंसियों में वापसी योग्य अवसर है, कुल मिलाकर लगभग ${(expected_impact.supply_growth_copies || 0).toLocaleString('en-IN')} प्रतियाँ/दिन।`);
    if (collection_opportunities.length) parts.push(`${collection_opportunities.length} एजेंसियों से ${fmtINR(expected_impact.collection_recovery)} वसूली योग्य है।`);
    if (supply_risks.length) parts.push(`${supply_risks.length} एजेंसियाँ शून्य आपूर्ति पर पहुँच गई हैं।`);
    const summary = parts.length ? parts.join(' ') : 'फिलहाल इस क्षेत्र में कोई बड़ा जोखिम या अवसर नहीं मिला — सभी संकेतक सामान्य हैं।';

    const recs = [];
    opportunities.slice(0, 3).forEach(a => recs.push(
      `${a.ag_name} (${a.unit_name}) की आपूर्ति अपने 30-दिन के उच्चतम स्तर से ${Math.abs(a.decline_pct)}% गिर चुकी है — पुनः प्राप्ति से लगभग ${a.opportunity_copies} प्रतियाँ/दिन जुड़ेंगी।`));
    collection_opportunities.slice(0, 3).forEach(a => recs.push(
      `${a.ag_name} (${a.unit_name}) से ${fmtINR(a.outstanding)} बकाया वसूल करें — ${a.days_since_visit == null ? 'अभी तक भ्रमण नहीं हुआ' : a.days_since_visit + ' दिन से भ्रमण नहीं हुआ'}।`));
    supply_risks.slice(0, 2).forEach(a => recs.push(
      `${a.ag_name} (${a.unit_name}) की आपूर्ति 30-दिन के ${a.peak30_supply} प्रतियों के उच्चतम स्तर से शून्य हो गई है — तुरंत भ्रमण कर कारण जानें।`));
    return { summary, recommendations: recs.slice(0, 8) };
  }

  async function hindiNarrative(digest) {
    if (ollamaOk) {
      try {
        const sys = 'आप एक समाचार पत्र परिसंचरण संगठन के लिए एआई सर्कुलेशन बॉस हैं। दिए गए JSON आंकड़ों ' +
          '(वास्तविक डेटा, कभी न बदलें) के आधार पर, केवल हिंदी में, वास्तविक संख्याओं (₹, प्रतियाँ, दिन) के साथ ' +
          'निर्णायक सुझाव दें। केवल इस JSON फॉर्मेट में उत्तर दें: {"summary":"2-3 वाक्य","recommendations":["निर्णायक ' +
          'वाक्य, जैसे: एजेंसी ABC को दूसरे दिन जोड़ें — योजना मार्ग से 2.8 किमी दूर, +180 प्रतियों का अवसर, ₹75,000 ' +
          'बकाया, 28 दिन से भ्रमण नहीं"]}। अधिकतम 8 सुझाव।';
        const text = await ollamaChat(sys, JSON.stringify(digest).slice(0, 24000), 1400);
        const parsed = extractJson(text);
        if (parsed && parsed.summary) return { ...parsed, engine: 'ollama' };
      } catch (_) { /* fall through to deterministic Hindi */ }
    }
    return { ...deterministicNarrativeHindi(digest), engine: 'template' };
  }

  // ── Briefing cache (per scope, 10 min) — mirrors insights.js ────────────────
  const cache = new Map();
  const CACHE_MS = 10 * 60 * 1000;

  // ════ GET /api/ai-nexus/status ════
  app.get('/api/ai-nexus/status', (req, res) => {
    res.json({ ollama_configured: ollamaOk, ai_configured: ollamaOk || !!anthropic, model: ollamaOk ? OLLAMA_MODEL : anthropic ? CLAUDE_MODEL : 'template' });
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

      // Q10 "which opportunities are not being acted upon" — P1/P2 insights with zero
      // open action_items logged against them (nobody has emailed/assigned/escalated yet).
      const unaddressed_opportunities = (insightsData.insights || [])
        .filter(i => (i.priority === 'P1' || i.priority === 'P2') && !i.open_actions)
        .slice(0, 8);

      const expected_impact = {
        supply_growth_copies: Math.round(signals.filter(s => s.tags.includes('WIN_BACK')).reduce((s, a) => s + a.opportunity_copies, 0)),
        collection_recovery: Math.round(collection_opportunities.reduce((s, a) => s + a.outstanding, 0)),
        agencies_flagged: signals.filter(isFlagged).length,
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
        unaddressed_opportunities,
        expected_impact: { ...expected_impact, fmt_collection_recovery: fmtINR(expected_impact.collection_recovery) },
        ai_summary: narrative.summary,
        recommendations: narrative.recommendations || [],
        engine: narrative.engine,
      };
      cache.set(cacheKey, { at: Date.now(), data });
      res.json(data);
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
  // Proxies to the competitor_data table summary. Returns { available: false }
  // when no data has been uploaded yet.
  app.get('/api/ai-nexus/competitor', async (req, res) => {
    try {
      const type = req.query.type === 'hawker' ? 'hawker' : 'agency';
      const { rows: lp } = await q(
        `SELECT period FROM competitor_data WHERE comp_type = ? ORDER BY period DESC LIMIT 1`, [type]);
      if (!lp.length) {
        return res.json({ available: false,
          message: 'No competitor data uploaded yet. Go to Competitor Data under your navigation to upload or enter data.' });
      }
      const period = lp[0].period;
      const { rows: units } = await q(`
        SELECT unit_code, unit_name, state_name,
          SUM(our_supply) AS our_supply,
          SUM(comp1_supply) AS comp1_supply, MAX(comp1_name) AS comp1_name,
          SUM(comp2_supply) AS comp2_supply, MAX(comp2_name) AS comp2_name,
          SUM(comp3_supply) AS comp3_supply, MAX(comp3_name) AS comp3_name,
          SUM(comp4_supply) AS comp4_supply, MAX(comp4_name) AS comp4_name,
          SUM(comp5_supply) AS comp5_supply, MAX(comp5_name) AS comp5_name,
          COUNT(*) AS agents
        FROM competitor_data WHERE comp_type = ? AND period = ?
        GROUP BY unit_code, unit_name, state_name ORDER BY our_supply DESC`, [type, period]);

      const compTotals = {};
      for (const r of units) {
        for (let i = 1; i <= 5; i++) {
          const name = r[`comp${i}_name`]; const copies = Number(r[`comp${i}_supply`] || 0);
          if (name && copies > 0) compTotals[name] = (compTotals[name] || 0) + copies;
        }
      }
      const competitors = Object.entries(compTotals).sort((a, b) => b[1] - a[1])
        .map(([name, total]) => ({ name, total }));
      const totalOurs = units.reduce((s, r) => s + Number(r.our_supply || 0), 0);
      const totalComp = competitors.reduce((s, c) => s + c.total, 0);
      const totalMkt  = totalOurs + totalComp;
      const losing = units.map(r => {
        const ours = Number(r.our_supply||0);
        const comp = [1,2,3,4,5].reduce((s,i)=>s+Number(r[`comp${i}_supply`]||0),0);
        const tot  = ours + comp;
        return { unit_code: r.unit_code, unit_name: r.unit_name, state_name: r.state_name,
          our_supply: ours, total_market: tot, share_pct: tot>0 ? Math.round(ours/tot*100) : 100 };
      }).filter(r => r.total_market > 0 && r.share_pct < 50)
        .sort((a, b) => a.share_pct - b.share_pct);

      res.json({ available: true, period, type,
        total_ours: totalOurs, total_market: totalMkt,
        our_share_pct: totalMkt > 0 ? Math.round(totalOurs/totalMkt*100) : 0,
        competitors, unit_count: units.length, losing_units: losing, units });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ POST /api/ai-nexus/draft — Hindi email/Telegram draft ════
  // kind: 'briefing' (whole digest) | 'agency' (single flagged agency). Body composed
  // server-side in Hindi; sending itself reuses the existing generic
  // /api/insights/send-email and /api/telegram/send endpoints.
  app.post('/api/ai-nexus/draft', async (req, res) => {
    try {
      const { channel = 'email', kind = 'briefing', briefing, agency } = req.body || {};
      const fromName = process.env.SMTP_FROM_NAME || 'Patrika Circulation MIS';
      let subject, body, unitCodes = [], execCode = null;

      if (kind === 'agency' && agency) {
        const a = agency;
        subject = `[कार्रवाई आवश्यक] ${a.ag_name} — ${hiTags(a.tags)}`;
        body = [
          'प्रिय टीम,', '',
          `एजेंसी: ${a.ag_name} (${a.unit_name}${a.city_name ? ', ' + a.city_name : ''})`,
          `स्थिति: ${hiTags(a.tags)}`,
          a.outstanding ? `बकाया राशि: ${fmtINR(a.outstanding)}` : null,
          a.opportunity_copies ? `संभावित वृद्धि: +${a.opportunity_copies} प्रतियाँ/दिन` : null,
          `अंतिम भ्रमण: ${a.last_visit ? a.last_visit + ' (' + a.days_since_visit + ' दिन पहले)' : 'अभी तक नहीं'}`,
          a.expected_outcome ? `अपेक्षित परिणाम: ${a.expected_outcome}` : null,
          '', 'कृपया 48 घंटे में समीक्षा करें और स्थिति सूचित करें।', '',
          'धन्यवाद,', fromName, '(यह सूचना लाइव डेटा से स्वचालित रूप से तैयार की गई है)',
        ].filter(Boolean).join('\n');
        unitCodes = [a.unit_code]; execCode = a.exec_code;
      } else {
        const b = briefing || {};
        const digest = {
          opportunities: b.opportunities || [], collection_opportunities: b.collection_opportunities || [],
          supply_risks: b.supply_risks || [], expected_impact: b.expected_impact || {},
        };
        const narrative = await hindiNarrative(digest);
        subject = `दैनिक एआई परिसंचरण रिपोर्ट — ${new Date().toISOString().slice(0, 10)}`;
        body = [
          'नमस्ते,', '', 'आज की एआई परिसंचरण रिपोर्ट (स्ट्रैटेजिक एआई नेक्सस) प्रस्तुत है:', '',
          narrative.summary, '', 'मुख्य आँकड़े:',
          `• ध्यान देने योग्य एजेंसियाँ: ${b.expected_impact?.agencies_flagged ?? 0}`,
          `• वापसी योग्य अवसर: ${(b.opportunities || []).length} एजेंसियाँ`,
          `• वसूली योग्य बकाया: ${b.expected_impact?.fmt_collection_recovery || '₹0'}`,
          `• शून्य आपूर्ति एजेंसियाँ: ${(b.supply_risks || []).length}`, '',
          'सुझाए गए कदम:', ...narrative.recommendations.map((r, i) => `${i + 1}. ${r}`), '',
          'धन्यवाद,', fromName, '(यह रिपोर्ट लाइव डेटा से स्वचालित रूप से तैयार की गई है)',
        ].join('\n');
      }

      let recipients = [];
      if (unitCodes.length) {
        const ph = unitCodes.map(() => '?').join(',');
        const r = await q(`SELECT unit_code, unit_name, role_label, person_name, email FROM unit_email_config WHERE unit_code IN (${ph}) AND is_active = 1`, unitCodes);
        recipients = r.rows;
      }
      let mobile = null;
      if (channel === 'telegram' && execCode) {
        const { rows } = await q(`SELECT mobile_no FROM exec_master WHERE executive_code = ? LIMIT 1`, [execCode]);
        mobile = rows[0]?.mobile_no || null;
      }
      res.json({ subject, body, recipients, mobile, channel });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
