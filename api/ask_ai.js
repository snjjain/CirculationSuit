'use strict';

/**
 * Patrika Vitran — Ask AI (natural-language business Q&A) — 100% FREE stack
 *
 * Engines (auto-selected, best first):
 *   1. ollama   — free local LLM (if Ollama is running; set OLLAMA_URL/OLLAMA_MODEL in .env)
 *   2. claude   — only if ANTHROPIC_API_KEY is set (optional, paid)
 *   3. patterns — built-in semantic query engine (always available, instant, free)
 *
 * POST /api/ask-ai        { question, conversation_id }
 * GET  /api/ask-ai/status → { engine, model }
 *
 * Security: SELECT-only, table whitelist, LIMIT enforced, role-scoped,
 * SQL never returned to client, all questions logged to ai_query_log.
 *
 * Registered by server.js:  require('./ask_ai')({ app, q, getScopeUnitCodes })
 */

module.exports = function registerAskAI(ctx) {
  const { app, q, getScopeUnitCodes } = ctx;

  // ── LLM providers ───────────────────────────────────────────────────────────
  const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  const API_KEY      = process.env.ANTHROPIC_API_KEY || '';
  const CLAUDE_MODEL = process.env.ASK_AI_MODEL || 'claude-opus-5';

  let ollamaOk = false;
  let anthropic = null;

  async function detectOllama() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(OLLAMA_URL + '/api/tags', { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { ollamaOk = false; return; }
      const d = await r.json();
      const models = (d.models || []).map(m => m.name);
      ollamaOk = models.some(m => m === OLLAMA_MODEL || m.startsWith(OLLAMA_MODEL.split(':')[0]));
      if (ollamaOk) console.log(`[ask-ai] Ollama detected at ${OLLAMA_URL} — model ${OLLAMA_MODEL}`);
      else if (models.length) console.log(`[ask-ai] Ollama running but model ${OLLAMA_MODEL} not pulled (have: ${models.join(', ')})`);
    } catch (_) { ollamaOk = false; }
  }
  detectOllama();
  setInterval(detectOllama, 5 * 60 * 1000); // re-check every 5 min

  if (API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: API_KEY });
      console.log('[ask-ai] Claude API enabled (optional), model:', CLAUDE_MODEL);
    } catch (e) { console.warn('[ask-ai] Anthropic SDK load failed:', e.message); }
  }
  console.log('[ask-ai] Built-in semantic pattern engine active (free, instant)');

  // ── Query log ───────────────────────────────────────────────────────────────
  ;(async () => {
    await q(`CREATE TABLE IF NOT EXISTS ai_query_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id VARCHAR(64),
      person_code     VARCHAR(30),
      hierarchy_level INT,
      question        TEXT,
      sql_generated   TEXT,
      row_count       INT,
      duration_ms     INT,
      engine          VARCHAR(20),
      error           TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_conv (conversation_id), KEY idx_created (created_at)
    )`);
  })().catch(e => console.warn('[ask-ai] table init:', e.message));

  // ── Unit name lookup (for "Jaipur", "Kota" style filters) ───────────────────
  let UNIT_LIST = []; // [{unit_code, unit_name}]
  async function loadUnits() {
    try {
      const { rows } = await q('SELECT unit_code, unit_name FROM units');
      if (rows.length) UNIT_LIST = rows;
    } catch (_) {}
  }
  loadUnits();
  setInterval(loadUnits, 30 * 60 * 1000);

  function detectUnitFilter(question) {
    const ql = question.toLowerCase();
    for (const u of UNIT_LIST) {
      const base = String(u.unit_name || '').replace(/\s*(RP|PT)\s*$/i, '').trim().toLowerCase();
      if (base.length >= 4 && ql.includes(base)) return u;
    }
    return null;
  }

  // ── Hindi / Hinglish → English normalization ────────────────────────────────
  // Questions may be in English, Hindi (Devanagari) or romanized Hindi.
  // We translate keywords to English so the same intent patterns match all three.
  const HI_MAP = [
    // metrics
    [/प्रसार\s*संख्या|प्रसार|सर्कुलेशन/g, ' circulation '],
    [/प्रतियाँ|प्रतियां|प्रतियों|प्रति|कॉपियां|कॉपी/g, ' copies '],
    [/आपूर्ति|सप्लाई/g, ' supply '],
    [/बकाया|बाक़ी|बाकी/g, ' outstanding '],
    [/वसूली|वसूल|रिकवरी/g, ' recovery '],
    [/कलेक्शन|संग्रहण|संग्रह|भुगतान/g, ' collection '],
    [/एजेंसियों|एजेंसियां|एजेंसी|एजेन्सी/g, ' agencies '],
    [/आउटस्टैंडिंग|आउट\s*स्टैंडिंग/g, ' outstanding '],
    [/ओ\.?एस\.?|\bओएस\b/g, ' outstanding '],
    // agency status words
    [/एक्टिव|सक्रिय|चालू/g, ' active '],
    [/क्लोज्ड|क्लोज़्ड|क्लोज़|क्लोज/g, ' closed '],
    [/निलंबित|सस्पेंडेड|सस्पेंड/g, ' suspended '],
    [/संख्या|गिनती/g, ' count '],
    [/अलग\s*-?\s*अलग/g, ' separately '],
    [/बताइए|बताएं|बताओ|दिखाइए|दिखाएं|दिखाओ|बताये/g, ' show '],
    [/सर्वेक्षण|सर्वे/g, ' survey '],
    [/ऑर्डर|आर्डर/g, ' order '],
    // dimensions
    [/शाखावार|शाखा\s*वार|शाखा|ब्रांच/g, ' branch wise '],
    [/यूनिट\s*वार|यूनिट/g, ' unit wise '],
    [/राज्यवार|राज्य\s*वार|राज्य/g, ' state wise '],
    [/ज़ोन|जोन/g, ' zone '],
    [/कार्यकारी|एग्जीक्यूटिव/g, ' executive '],
    [/सेंटर|केंद्र/g, ' center '],
    // time
    [/आज\s*की|आज\s*का|आज/g, ' today '],
    [/कल\s*की|कल\s*का|कल\s*से|कल/g, ' yesterday '],
    [/इस\s*महीने|इस\s*माह/g, ' this month '],
    [/पिछले\s*महीने|पिछला\s*महीना|गत\s*माह/g, ' last month '],
    [/पिछले|पिछला|गत/g, ' last '],
    [/महीनों|महीने|महीना|माह/g, ' month '],
    [/दिनों|दिन/g, ' days '],
    [/सालों|साल|वर्ष/g, ' year '],
    [/रुझान|ट्रेंड/g, ' trend '],
    [/कोविड|कोरोना/g, ' covid '],
    // qualifiers
    [/सबसे\s*(ज़्यादा|ज्यादा|अधिक|बड़ी|बड़े|टॉप)/g, ' top '],
    [/शीर्ष|टॉप/g, ' top '],
    [/से\s*(ज़्यादा|ज्यादा|अधिक|ऊपर)/g, ' above '],
    [/से\s*कम|से\s*नीचे/g, ' below '],
    [/वृद्धि|बढ़ोतरी|बढ़त|इज़ाफ़ा|इजाफा/g, ' growth '],
    [/गिरावट|घटती|घट\s*रही|कम\s*हो\s*रही/g, ' declining '],
    [/तुलना|मुक़ाबला|मुकाबला/g, ' compare '],
    [/नई|नए|नयी/g, ' new '],
    [/जुड़ी|जुड़े|जोड़ी/g, ' added '],
    [/शून्य|ज़ीरो|जीरो/g, ' zero '],
    [/बंद/g, ' closed '],
    [/स्थिति|हालत|हाल/g, ' status '],
    [/कुल|टोटल/g, ' total '],
    [/कितनी|कितना|कितने/g, ' how much '],
    // amounts
    [/हज़ार|हजार/g, ' thousand '],
    [/लाख/g, ' lakh '],
    [/करोड़|करोड/g, ' crore '],
    [/₹|रुपये|रुपए|रु\./g, ' ₹ '],
    // major city names (Devanagari → Latin, for unit detection)
    [/जयपुर/g, ' jaipur '], [/जोधपुर/g, ' jodhpur '], [/कोटा/g, ' kota '],
    [/उदयपुर/g, ' udaipur '], [/अजमेर/g, ' ajmer '], [/बीकानेर/g, ' bikaner '],
    [/भोपाल/g, ' bhopal '], [/इंदौर/g, ' indore '], [/रायपुर/g, ' raipur '],
    [/अहमदाबाद/g, ' ahmedabad '], [/सूरत/g, ' surat '], [/चेन्नई/g, ' chennai '],
    [/बेंगलुरु|बैंगलोर/g, ' bangalore '], [/दिल्ली/g, ' delhi '],
    [/ग्वालियर/g, ' gwalior '], [/जबलपुर/g, ' jabalpur '], [/अलवर/g, ' alwar '],
    [/सीकर/g, ' sikar '], [/बिलासपुर/g, ' bilaspur '], [/हुबली/g, ' hubli '],
    // romanized Hinglish
    [/\bkitni\b|\bkitna\b|\bkitne\b/g, ' how much '],
    [/\baaj\s*ki\b|\baaj\s*ka\b|\baaj\b/g, ' today '],
    [/\bkal\b/g, ' yesterday '],
    [/\bis\s*mahine\b|\bis\s*maah\b/g, ' this month '],
    [/\bpichhle\b|\bpichle\b|\bpichhla\b/g, ' last '],
    [/\bmahina\b|\bmahine\b|\bmaah\b/g, ' month '],
    [/\bbakaya\b|\bbaki\b|\bbaaki\b/g, ' outstanding '],
    [/\bvasooli\b|\bvasuli\b/g, ' recovery '],
    [/\bprasar\b/g, ' circulation '],
    [/\bprati\b|\bpratiyan\b|\bcopiya\b/g, ' copies '],
    [/\bbadh\s*rahi\b|\bbadhotri\b|\bvriddhi\b/g, ' growth '],
    [/\bgir\s*rahi\b|\bgiravat\b|\bghat\s*rahi\b/g, ' declining '],
    [/\btulna\b|\bmukabla\b/g, ' compare '],
    [/\bnayi\b|\bnaye\b|\bnai\b/g, ' new '],
    [/\bjyada\b|\bzyada\b|\badhik\b/g, ' above '],
    [/\bhazaar\b|\bhazar\b/g, ' thousand '],
    [/\bband\b/g, ' closed '],
    [/\bsabse\b/g, ' top '],
    [/\bos\b/gi, ' outstanding '],
    [/\bsankhya\b|\bginti\b/g, ' count '],
    [/\bbatao\b|\bbataiye\b|\bbataen\b|\bdikhao\b/g, ' show '],
  ];

  function normalizeQuestion(qStr) {
    let s = ' ' + String(qStr) + ' ';
    for (const [re, rep] of HI_MAP) s = s.replace(re, rep);
    return s.replace(/\s+/g, ' ').trim();
  }

  // ── Formatting ──────────────────────────────────────────────────────────────
  const N = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  function fmtNum(v) {
    const n = N(v);
    if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
    if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(2) + ' Lakh';
    return Math.round(n).toLocaleString('en-IN');
  }
  const fmtINR = v => '₹' + fmtNum(v);
  const pct = (cur, prev) => (prev ? ((cur - prev) / Math.abs(prev) * 100) : null);
  const fmtPct = p => p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;

  // ── SQL safety ──────────────────────────────────────────────────────────────
  const ALLOWED_TABLES = ['supply_data', 'agency_master', 'agency_collection',
    'agency_outstanding', 'survey_data', 'units'];
  const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace\s+into|load_file|outfile|dumpfile|information_schema|mysql\.|performance_schema|sleep\s*\(|benchmark\s*\()\b/i;

  function validateSql(sql) {
    const s = sql.trim().replace(/;+\s*$/, '');
    if (!/^select\b|^\(?\s*select\b/i.test(s)) return { ok: false, err: 'Only SELECT allowed' };
    if (s.includes(';')) return { ok: false, err: 'Multiple statements not allowed' };
    if (FORBIDDEN.test(s)) return { ok: false, err: 'Forbidden keyword' };
    const tables = [...s.matchAll(/\b(?:from|join)\s+`?(\w+)`?/gi)].map(m => m[1].toLowerCase());
    for (const t of tables) if (!ALLOWED_TABLES.includes(t)) return { ok: false, err: `Table not allowed: ${t}` };
    let out = s;
    if (!/\blimit\s+\d+/i.test(s)) out = s + ' LIMIT 500';
    return { ok: true, sql: out };
  }

  async function execSafe(sql, timeoutMs = 25000) {
    const v = validateSql(sql);
    if (!v.ok) throw new Error('SQL rejected: ' + v.err);
    const { rows } = await Promise.race([
      q(v.sql),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Query timeout')), timeoutMs)),
    ]);
    return { rows, sql: v.sql };
  }

  // ── Scope ───────────────────────────────────────────────────────────────────
  async function scopeInfo(req) {
    const personCode = req.headers['x-person-code'] || '';
    const hl = parseInt(req.headers['x-hierarchy-level'] || '1', 10);
    const unitCodes = await getScopeUnitCodes(personCode, hl);
    if (!unitCodes) return { personCode, hl, unitCodes: null, note: 'FULL access — no unit restriction.' };
    if (!unitCodes.length) return { personCode, hl, unitCodes: [], note: 'NO units assigned — always add WHERE 1=0.' };
    return { personCode, hl, unitCodes,
      note: `Restrict every query: unit_code IN (${unitCodes.map(u => `'${u}'`).join(',')}) (column name "unit" in agency_master).` };
  }
  function sc(scope, col) {
    if (!scope.unitCodes) return '';
    if (!scope.unitCodes.length) return ' AND 1=0';
    return ` AND ${col} IN (${scope.unitCodes.map(u => `'${String(u).replace(/'/g, '')}'`).join(',')})`;
  }

  // ── Conversation memory ─────────────────────────────────────────────────────
  const convs = new Map();
  function convHistory(id) { if (!convs.has(id)) convs.set(id, []); return convs.get(id); }
  function pushConv(id, question, answer) {
    const h = convHistory(id);
    h.push({ q: question, a: answer });
    while (h.length > 6) h.shift();
    if (convs.size > 500) convs.delete(convs.keys().next().value);
  }

  /* ═════════════════════ SEMANTIC PATTERN ENGINE (free, instant) ═════════════════════
   *
   * Each intent: { match: regex, build(question, scope, m) → plan }
   * plan = { understood, queries:[{purpose, sql}], analyse(results) → {answer, summary, insights, recommendations, charts} }
   * Time helpers below let intents share date logic.
   */

  const T = {
    todayOrLatestSupply: `(SELECT MAX(supply_date) FROM supply_data)`,
    thisMonthStart: `DATE_FORMAT(CURDATE(),'%Y-%m-01')`,
  };

  function autoChart(rows, title, opts = {}) {
    if (!rows || rows.length < 2) return [];
    const keys = Object.keys(rows[0]);
    const lk = opts.labelKey || keys.find(k => typeof rows[0][k] === 'string');
    const vk = opts.valueKey || keys.find(k => k !== lk && rows[0][k] !== null && !isNaN(parseFloat(rows[0][k])));
    if (!lk || !vk) return [];
    const isTrend = opts.line || /month|date/i.test(lk) || /^\d{4}-\d{2}/.test(String(rows[0][lk]));
    return [{
      type: opts.type || (isTrend ? 'line' : 'bar'),
      title,
      labels: rows.slice(0, 12).map(r => String(r[lk])),
      values: rows.slice(0, 12).map(r => N(r[vk])),
      value_label: (opts.valueLabel || vk).replace(/_/g, ' '),
    }];
  }

  function genericAnalyse(plan, results) {
    const rows = (results[0] || {}).rows || [];
    if (!rows.length) return {
      answer: 'No data matched this question for your access scope.',
      summary: 'The query ran but returned no rows — the data may not be loaded for this period yet.',
      insights: [], recommendations: [], charts: [],
    };
    const fr = rows[0], keys = Object.keys(fr);
    const nameKey = keys.find(k => typeof fr[k] === 'string') || keys[0];
    const numKey = keys.find(k => k !== nameKey && fr[k] !== null && !isNaN(parseFloat(fr[k])));
    let answer;
    if (rows.length === 1 && keys.length <= 4) {
      answer = `${plan.understood} — ` + keys.map(k => `${k.replace(/_/g, ' ')}: ${fmtNum(fr[k])}`).join(', ') + '.';
    } else {
      answer = `${plan.understood}: ${rows.length} records. Highest — ${fr[nameKey]} (${fmtNum(fr[numKey])}).`;
    }
    return {
      answer,
      summary: `Found ${rows.length} records. See the table and chart below for the full breakdown.`,
      insights: [], recommendations: [],
      charts: autoChart(rows, plan.understood),
    };
  }

  const INTENTS = [

    // ── 1. Compare <unit> supply with yesterday / previous day ────────────────
    {
      match: /compare.*\b(yesterday|previous day)|\b(yesterday|previous day).*compare|vs\.?\s*yesterday/i,
      build: (question, scope) => {
        const u = detectUnitFilter(question);
        const uf = u ? ` AND unit_code='${u.unit_code}'` : '';
        const label = u ? `${u.unit_name} circulation` : 'Total circulation';
        return {
          understood: `Compare ${label}: latest day vs previous day`,
          queries: [{ purpose: 'Latest vs previous day', sql: `
            SELECT supply_date, SUM(sup_copy) AS copies, COUNT(DISTINCT agcd) AS agencies
            FROM supply_data
            WHERE supply_date IN (
              (SELECT MAX(supply_date) FROM supply_data),
              (SELECT MAX(supply_date) FROM supply_data WHERE supply_date < (SELECT MAX(supply_date) FROM supply_data))
            )${uf}${sc(scope, 'unit_code')}
            GROUP BY supply_date ORDER BY supply_date` }],
          analyse(results) {
            const rows = results[0].rows;
            if (rows.length < 2) return genericAnalyse(this, results);
            const [prev, cur] = rows;
            const d = N(cur.copies) - N(prev.copies), p = pct(N(cur.copies), N(prev.copies));
            return {
              answer: `${label} on ${String(cur.supply_date).slice(0, 10)}: ${fmtNum(cur.copies)} copies — ${d >= 0 ? 'up' : 'down'} ${fmtNum(Math.abs(d))} (${fmtPct(p)}) vs previous day (${fmtNum(prev.copies)}).`,
              summary: `Latest day supplied ${fmtNum(cur.copies)} copies through ${fmtNum(cur.agencies)} agencies, against ${fmtNum(prev.copies)} copies the previous day. Net change ${fmtNum(d)} copies (${fmtPct(p)}).`,
              insights: [`Day-over-day change is ${fmtPct(p)} (${d >= 0 ? '+' : ''}${fmtNum(d)} copies).`],
              recommendations: d < 0 ? ['Check drop-point-level supply for the units driving the decline.'] : [],
              charts: [{ type: 'bar', title: `${label} — day comparison`, labels: rows.map(r => String(r.supply_date).slice(0, 10)), values: rows.map(r => N(r.copies)), value_label: 'copies' }],
            };
          },
        };
      },
    },

    // ── 2. Pre-COVID comparison ───────────────────────────────────────────────
    {
      match: /covid|pre.?covid|18.*march.*2020|2020-03-18/i,
      build: (question, scope) => {
        const byUnit = /branch|unit/i.test(question);
        const grp = byUnit ? 'unit_name' : 'state_name';
        return {
          understood: `Supply vs pre-COVID baseline (18-Mar-2020), ${byUnit ? 'branch' : 'state'}-wise`,
          queries: [{ purpose: 'Pre-COVID vs latest', sql: `
            SELECT ${grp} AS grp,
                   SUM(CASE WHEN supply_date='2020-03-18' THEN sup_copy ELSE 0 END) AS covid_copies,
                   SUM(CASE WHEN supply_date=${T.todayOrLatestSupply} THEN sup_copy ELSE 0 END) AS latest_copies
            FROM supply_data
            WHERE supply_date IN ('2020-03-18', ${T.todayOrLatestSupply})${sc(scope, 'unit_code')}
            GROUP BY ${grp} HAVING covid_copies > 0 OR latest_copies > 0
            ORDER BY covid_copies DESC LIMIT 60` }],
          analyse(results) {
            const rows = results[0].rows.map(r => ({ ...r, change_pct: pct(N(r.latest_copies), N(r.covid_copies)) }));
            if (!rows.length) return genericAnalyse(this, results);
            const totC = rows.reduce((a, r) => a + N(r.covid_copies), 0);
            const totL = rows.reduce((a, r) => a + N(r.latest_copies), 0);
            const p = pct(totL, totC);
            const worst = [...rows].filter(r => r.change_pct != null).sort((a, b) => a.change_pct - b.change_pct)[0];
            const best  = [...rows].filter(r => r.change_pct != null).sort((a, b) => b.change_pct - a.change_pct)[0];
            results[0].rows = rows;
            return {
              answer: `Total supply is ${fmtNum(totL)} copies vs ${fmtNum(totC)} on 18-Mar-2020 (pre-COVID) — ${fmtPct(p)} overall.`,
              summary: `Comparing the latest supply day against the pre-COVID baseline of 18 March 2020 across ${rows.length} ${this.understood.includes('branch') ? 'branches' : 'states'}. Overall recovery stands at ${fmtPct(p)}.`,
              insights: [
                best ? `Best recovery: ${best.grp} at ${fmtPct(best.change_pct)} (${fmtNum(best.covid_copies)} → ${fmtNum(best.latest_copies)}).` : null,
                worst ? `Weakest: ${worst.grp} at ${fmtPct(worst.change_pct)} (${fmtNum(worst.covid_copies)} → ${fmtNum(worst.latest_copies)}).` : null,
              ].filter(Boolean),
              recommendations: worst && worst.change_pct < 0 ? [`Investigate ${worst.grp}: supply is still ${fmtPct(worst.change_pct)} below pre-COVID level.`] : [],
              charts: [{ type: 'bar', title: 'Latest vs pre-COVID (copies)', labels: rows.slice(0, 12).map(r => r.grp), values: rows.slice(0, 12).map(r => N(r.latest_copies)), value_label: 'latest copies' }],
            };
          },
        };
      },
    },

    // ── 3. Copy growth branch-wise / executive-wise (this month vs last) ──────
    {
      match: /growth|increase|decrease|badh|gir/i,
      guard: /branch|unit|executive|month|center|zone/i,
      build: (question, scope) => {
        const byExec = /executive/i.test(question);
        const grpSel = byExec
          ? `COALESCE(m.executive_name,'(no executive)')`
          : `s.unit_name`;
        const join = byExec ? `LEFT JOIN agency_master m ON m.unit=s.unit_code AND m.agcd=s.agcd AND m.dpcd=s.dpcd` : '';
        return {
          understood: `${byExec ? 'Executive' : 'Branch'}-wise copy growth — this month vs last month (daily average)`,
          queries: [{ purpose: 'Growth comparison', sql: `
            SELECT ${grpSel} AS grp,
                   SUM(CASE WHEN s.supply_date >= ${T.thisMonthStart} THEN s.sup_copy ELSE 0 END) /
                     NULLIF(COUNT(DISTINCT CASE WHEN s.supply_date >= ${T.thisMonthStart} THEN s.supply_date END),0) AS cur_daily,
                   SUM(CASE WHEN s.supply_date < ${T.thisMonthStart} THEN s.sup_copy ELSE 0 END) /
                     NULLIF(COUNT(DISTINCT CASE WHEN s.supply_date < ${T.thisMonthStart} THEN s.supply_date END),0) AS prev_daily
            FROM supply_data s ${join}
            WHERE s.supply_date >= DATE_SUB(${T.thisMonthStart}, INTERVAL 1 MONTH)${sc(scope, 's.unit_code')}
            GROUP BY grp HAVING cur_daily IS NOT NULL OR prev_daily IS NOT NULL
            ORDER BY cur_daily DESC LIMIT 60` }],
          analyse(results) {
            let rows = results[0].rows.map(r => ({
              grp: r.grp, cur_daily: Math.round(N(r.cur_daily)), prev_daily: Math.round(N(r.prev_daily)),
              growth_pct: pct(N(r.cur_daily), N(r.prev_daily)),
            }));
            if (!rows.length || rows.every(r => !r.cur_daily && !r.prev_daily)) return genericAnalyse(this, results);
            rows.sort((a, b) => (b.growth_pct ?? -1e9) - (a.growth_pct ?? -1e9));
            results[0].rows = rows;
            const grow = rows.filter(r => r.growth_pct > 0).length;
            const dec  = rows.filter(r => r.growth_pct < 0).length;
            const top = rows[0], bottom = rows[rows.length - 1];
            return {
              answer: top && top.growth_pct != null
                ? `Highest growth: ${top.grp} at ${fmtPct(top.growth_pct)} (daily avg ${fmtNum(top.prev_daily)} → ${fmtNum(top.cur_daily)} copies).`
                : 'Growth comparison computed — see table.',
              summary: `Compared daily-average copies this month vs last month. ${grow} ${grow === 1 ? 'entry' : 'entries'} growing, ${dec} declining.`,
              insights: [
                top && top.growth_pct != null ? `Top: ${top.grp} ${fmtPct(top.growth_pct)}.` : null,
                bottom && bottom.growth_pct != null && bottom.growth_pct < 0 ? `Biggest decline: ${bottom.grp} ${fmtPct(bottom.growth_pct)} (${fmtNum(bottom.prev_daily)} → ${fmtNum(bottom.cur_daily)}).` : null,
              ].filter(Boolean),
              recommendations: dec ? [`Review the ${dec} declining ${dec === 1 ? 'entry' : 'entries'} in the table — largest first.`] : [],
              charts: [{ type: 'bar', title: 'Growth % (this vs last month)', labels: rows.slice(0, 12).map(r => r.grp), values: rows.slice(0, 12).map(r => Number((r.growth_pct ?? 0).toFixed(1))), value_label: 'growth %' }],
            };
          },
        };
      },
    },

    // ── 4. Agencies with declining circulation (last 30 days) ─────────────────
    {
      match: /declin.*agenc|agenc.*declin|falling.*agenc/i,
      build: (question, scope) => ({
        understood: 'Agencies with declining supply — last 15 days vs the 15 days before',
        queries: [{ purpose: 'Declining agencies', sql: `
          SELECT ag_name, unit_name,
                 SUM(CASE WHEN supply_date >  DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 15 DAY) THEN sup_copy ELSE 0 END) AS recent_copies,
                 SUM(CASE WHEN supply_date <= DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 15 DAY) THEN sup_copy ELSE 0 END) AS prior_copies
          FROM supply_data
          WHERE supply_date > DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 30 DAY)${sc(scope, 'unit_code')}
          GROUP BY agcd, ag_name, unit_name
          HAVING prior_copies > 0 AND recent_copies < prior_copies * 0.9
          ORDER BY (prior_copies - recent_copies) DESC LIMIT 100` }],
        analyse(results) {
          const rows = results[0].rows.map(r => ({ ...r, drop_pct: pct(N(r.recent_copies), N(r.prior_copies)) }));
          if (!rows.length) return { answer: 'No agencies show a >10% supply decline in the last 30 days of loaded data.', summary: '', insights: [], recommendations: [], charts: [] };
          results[0].rows = rows;
          const totDrop = rows.reduce((a, r) => a + (N(r.prior_copies) - N(r.recent_copies)), 0);
          return {
            answer: `${rows.length} agencies declined >10%: combined drop of ${fmtNum(totDrop)} copies over 15 days. Worst: ${rows[0].ag_name} (${fmtPct(rows[0].drop_pct)}).`,
            summary: `Compared each agency's last 15 days against the 15 days before. ${rows.length} agencies fell more than 10%.`,
            insights: rows.slice(0, 3).map(r => `${r.ag_name} (${r.unit_name}): ${fmtNum(r.prior_copies)} → ${fmtNum(r.recent_copies)} (${fmtPct(r.drop_pct)}).`),
            recommendations: ['Assign field officers to visit the top declining agencies this week.'],
            charts: autoChart(rows, 'Copy drop by agency', { labelKey: 'ag_name', valueKey: 'recent_copies', valueLabel: 'recent copies' }),
          };
        },
      }),
    },

    // ── 5. Zero supply / zero billing agencies ────────────────────────────────
    {
      match: /zero.*(billing|supply|bill)|no.*(billing|supply).*(last|15|month)|band.*agenc/i,
      build: (question, scope) => ({
        understood: 'Active agencies with NO supply in the last 15 days of loaded data',
        queries: [{ purpose: 'Zero-supply agencies', sql: `
          SELECT am.ag_name, am.unit_name, am.city_name, am.executive_name, am.mobile_no1
          FROM agency_master am
          LEFT JOIN (
            SELECT DISTINCT unit_code, agcd, dpcd FROM supply_data
            WHERE supply_date > DATE_SUB((SELECT MAX(supply_date) FROM supply_data), INTERVAL 15 DAY)
          ) s ON s.unit_code=am.unit AND s.agcd=am.agcd AND s.dpcd=am.dpcd
          WHERE am.supply_stop_flag='N' AND am.suspend_date IS NULL AND s.agcd IS NULL${sc(scope, 'am.unit')}
          ORDER BY am.unit_name LIMIT 200` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return { answer: 'Every active agency has supply in the last 15 days of loaded data.', summary: '', insights: [], recommendations: [], charts: [] };
          const byUnit = {};
          rows.forEach(r => { byUnit[r.unit_name] = (byUnit[r.unit_name] || 0) + 1; });
          const units = Object.entries(byUnit).sort((a, b) => b[1] - a[1]);
          return {
            answer: `${rows.length} active agencies have had no supply in the last 15 days of loaded data.`,
            summary: `These agencies are marked active in the master but received no copies recently. Most affected: ${units.slice(0, 3).map(([u2, c]) => `${u2} (${c})`).join(', ')}. Note: recent supply data may still be syncing.`,
            insights: units.slice(0, 3).map(([u2, c]) => `${u2}: ${c} agencies without supply.`),
            recommendations: ['Verify these agencies with the branch — either restart supply or mark them suspended in ERP.'],
            charts: [{ type: 'bar', title: 'Zero-supply agencies by branch', labels: units.slice(0, 12).map(x => x[0]), values: units.slice(0, 12).map(x => x[1]), value_label: 'agencies' }],
          };
        },
      }),
    },

    // ── 5b. Active / Closed / Suspended agency counts + outstanding ───────────
    {
      match: /(active|closed|suspend)[\s\S]{0,50}?agenc|agenc[\s\S]{0,50}?(active|closed|suspend)|agenc[\s\S]{0,30}?(status|count)|status.{0,20}agenc/i,
      build: (question, scope) => ({
        understood: 'Agency count and outstanding by status (Active / Closed / Suspended)',
        queries: [{ purpose: 'Agencies by status', sql: `
          SELECT COALESCE(ag_status,'(unknown)') AS status,
                 COUNT(*) AS agencies,
                 SUM(CASE WHEN cl_amt > 0 THEN cl_amt ELSE 0 END) AS outstanding,
                 COUNT(CASE WHEN cl_amt > 50000 THEN 1 END) AS above_50k
          FROM agency_outstanding WHERE period_label='CURRENT'${sc(scope, 'unit_code')}
          GROUP BY ag_status ORDER BY outstanding DESC` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return genericAnalyse(this, results);
          const get = s => rows.find(r => String(r.status).toLowerCase() === s) || { agencies: 0, outstanding: 0, above_50k: 0 };
          const act = get('active'), clo = get('closed'), sus = get('suspended');
          const tot = rows.reduce((a, r) => a + N(r.outstanding), 0);
          return {
            answer: `Active: ${fmtNum(act.agencies)} agencies with ${fmtINR(act.outstanding)} outstanding · Closed: ${fmtNum(clo.agencies)} agencies with ${fmtINR(clo.outstanding)} outstanding` +
                    (N(sus.agencies) ? ` · Suspended: ${fmtNum(sus.agencies)} with ${fmtINR(sus.outstanding)}` : '') + '.',
            summary: `Current-period snapshot by agency status. Total outstanding across all statuses is ${fmtINR(tot)}. ` +
                     `Closed agencies still hold ${fmtINR(clo.outstanding)} (${(N(clo.outstanding) / (tot || 1) * 100).toFixed(1)}% of all dues) — money owed by agencies no longer taking supply.`,
            insights: [
              `Active agencies: ${fmtNum(act.agencies)} — outstanding ${fmtINR(act.outstanding)} (${N(act.above_50k)} owe over ₹50,000).`,
              `Closed agencies: ${fmtNum(clo.agencies)} — outstanding ${fmtINR(clo.outstanding)} (${N(clo.above_50k)} owe over ₹50,000).`,
              N(sus.agencies) ? `Suspended agencies: ${fmtNum(sus.agencies)} — outstanding ${fmtINR(sus.outstanding)}.` : null,
            ].filter(Boolean),
            recommendations: N(clo.outstanding) > 0 ? [
              `Closed-agency dues of ${fmtINR(clo.outstanding)} are the hardest to recover — prioritise legal/settlement action on the ${N(clo.above_50k)} closed agencies owing over ₹50,000.`,
            ] : [],
            charts: [{ type: 'pie', title: 'Outstanding by agency status', labels: rows.map(r => String(r.status)), values: rows.map(r => N(r.outstanding)), value_label: 'outstanding ₹' }],
          };
        },
      }),
    },

    // ── 6. Outstanding above threshold ────────────────────────────────────────
    {
      match: /outstanding.*(above|over|more than|greater|>\s*)\s*₹?\s*([\d,]+)\s*(k|thousand|lakh|lac|crore)?/i,
      build: (question, scope, m) => {
        let amt = parseFloat(String(m[2] || '50000').replace(/,/g, '')) || 50000;
        const unit = (m[3] || '').toLowerCase();
        if (unit === 'k' || unit === 'thousand') amt *= 1000;
        if (unit === 'lakh' || unit === 'lac') amt *= 100000;
        if (unit === 'crore') amt *= 10000000;
        return {
          understood: `Agencies with outstanding above ${fmtINR(amt)}`,
          queries: [{ purpose: 'High outstanding agencies', sql: `
            SELECT ag_name, unit_name, cl_amt AS outstanding, exec_name, zh_name, mobno,
                   last_supply_date, block_status
            FROM agency_outstanding
            WHERE period_label='CURRENT' AND cl_amt > ${amt}${sc(scope, 'unit_code')}
            ORDER BY cl_amt DESC LIMIT 200` }],
          analyse(results) {
            const rows = results[0].rows;
            if (!rows.length) return { answer: `No agencies currently owe more than ${fmtINR(amt)}.`, summary: '', insights: [], recommendations: [], charts: [] };
            const tot = rows.reduce((a, r) => a + N(r.outstanding), 0);
            const blocked = rows.filter(r => String(r.block_status || '').toUpperCase() === 'Y').length;
            return {
              answer: `${rows.length} agencies owe more than ${fmtINR(amt)} — total exposure ${fmtINR(tot)}. Largest: ${rows[0].ag_name} (${fmtINR(rows[0].outstanding)}).`,
              summary: `Combined outstanding of these agencies is ${fmtINR(tot)}. ${blocked ? blocked + ' of them are already supply-blocked.' : 'None are supply-blocked yet.'}`,
              insights: rows.slice(0, 3).map(r => `${r.ag_name} (${r.unit_name}): ${fmtINR(r.outstanding)} — executive ${r.exec_name || '—'}.`),
              recommendations: [
                `Prioritise recovery visits to the top ${Math.min(10, rows.length)} accounts (${fmtINR(rows.slice(0, 10).reduce((a, r) => a + N(r.outstanding), 0))}).`,
                blocked === 0 ? 'Consider supply-block policy for chronic defaulters.' : null,
              ].filter(Boolean),
              charts: autoChart(rows, `Top outstanding (> ${fmtINR(amt)})`, { labelKey: 'ag_name', valueKey: 'outstanding', valueLabel: 'outstanding ₹' }),
            };
          },
        };
      },
    },

    // ── 7. Outstanding recovery status branch-wise ────────────────────────────
    {
      match: /recovery.*(status|branch|unit)|outstanding.*recovery|collection efficiency/i,
      build: (question, scope) => ({
        understood: 'Recovery status branch-wise (current period)',
        queries: [{ purpose: 'Branch recovery status', sql: `
          SELECT unit_name AS branch,
                 SUM(bill_amt) AS billed, SUM(rec_amt) AS recovered,
                 SUM(CASE WHEN cl_amt > 0 THEN cl_amt ELSE 0 END) AS outstanding,
                 COUNT(CASE WHEN cl_amt > 50000 THEN 1 END) AS high_risk
          FROM agency_outstanding WHERE period_label='CURRENT'${sc(scope, 'unit_code')}
          GROUP BY unit_name ORDER BY outstanding DESC LIMIT 60` }],
        analyse(results) {
          const rows = results[0].rows.map(r => ({ ...r, recovery_pct: r.billed > 0 ? Math.round(N(r.recovered) / N(r.billed) * 100) : null }));
          if (!rows.length) return genericAnalyse(this, results);
          results[0].rows = rows;
          const best = [...rows].filter(r => r.recovery_pct != null).sort((a, b) => b.recovery_pct - a.recovery_pct)[0];
          const worst = [...rows].filter(r => r.recovery_pct != null).sort((a, b) => a.recovery_pct - b.recovery_pct)[0];
          const totOut = rows.reduce((a, r) => a + N(r.outstanding), 0);
          return {
            answer: `Total outstanding across ${rows.length} branches: ${fmtINR(totOut)}. Best recovery: ${best ? `${best.branch} (${best.recovery_pct}%)` : '—'}; weakest: ${worst ? `${worst.branch} (${worst.recovery_pct}%)` : '—'}.`,
            summary: `Recovery efficiency = amount recovered ÷ amount billed for the current period, per branch.`,
            insights: [
              best ? `${best.branch} leads with ${best.recovery_pct}% recovery.` : null,
              worst ? `${worst.branch} needs attention at ${worst.recovery_pct}% recovery with ${fmtINR(worst.outstanding)} outstanding.` : null,
            ].filter(Boolean),
            recommendations: worst ? [`Focus recovery drive on ${worst.branch} — ${N(worst.high_risk)} agencies there owe over ₹50,000.`] : [],
            charts: [{ type: 'bar', title: 'Recovery % by branch', labels: rows.slice(0, 12).map(r => r.branch), values: rows.slice(0, 12).map(r => N(r.recovery_pct)), value_label: 'recovery %' }],
          };
        },
      }),
    },

    // ── 8. Top N agencies by supply ───────────────────────────────────────────
    {
      match: /top[\s\S]{0,40}?agenc|agenc[\s\S]{0,30}?top/i,
      build: (question, scope, m) => {
        const n = Math.min(parseInt((question.match(/\b(\d{1,3})\b/) || [])[1] || '20', 10) || 20, 100);
        const byOut = /outstanding|due/i.test(question);
        if (byOut) return {
          understood: `Top ${n} agencies by outstanding`,
          queries: [{ purpose: 'Top outstanding', sql: `
            SELECT ag_name, unit_name, cl_amt AS outstanding, exec_name FROM agency_outstanding
            WHERE period_label='CURRENT' AND cl_amt > 0${sc(scope, 'unit_code')}
            ORDER BY cl_amt DESC LIMIT ${n}` }],
          analyse(results) { return genericAnalyse(this, results); },
        };
        return {
          understood: `Top ${n} agencies by copy supply (latest day)`,
          queries: [{ purpose: 'Top agencies', sql: `
            SELECT ag_name, unit_name, SUM(sup_copy) AS copies FROM supply_data
            WHERE supply_date=${T.todayOrLatestSupply}${sc(scope, 'unit_code')}
            GROUP BY agcd, ag_name, unit_name ORDER BY copies DESC LIMIT ${n}` }],
          analyse(results) {
            const rows = results[0].rows;
            if (!rows.length) return genericAnalyse(this, results);
            const tot = rows.reduce((a, r) => a + N(r.copies), 0);
            return {
              answer: `Top ${rows.length} agencies supply ${fmtNum(tot)} copies. #1 is ${rows[0].ag_name} (${rows[0].unit_name}) with ${fmtNum(rows[0].copies)}.`,
              summary: `Ranked by copies on the latest loaded supply day.`,
              insights: [`Top 3 (${rows.slice(0, 3).map(r => r.ag_name).join(', ')}) account for ${fmtNum(rows.slice(0, 3).reduce((a, r) => a + N(r.copies), 0))} copies.`],
              recommendations: [],
              charts: autoChart(rows, `Top ${rows.length} agencies`, { labelKey: 'ag_name', valueKey: 'copies' }),
            };
          },
        };
      },
    },

    // ── 9. New agencies this month ────────────────────────────────────────────
    {
      match: /new agenc|agenc.*added|recently (started|added)/i,
      build: (question, scope) => ({
        understood: 'New agencies added this month',
        queries: [{ purpose: 'New agencies', sql: `
          SELECT ag_name, unit_name, city_name, supply_start_dt, executive_name, mobile_no1
          FROM agency_master WHERE supply_start_dt >= ${T.thisMonthStart}${sc(scope, 'unit')}
          ORDER BY supply_start_dt DESC LIMIT 200` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return { answer: 'No new agencies added this month (per ERP supply start dates).', summary: '', insights: [], recommendations: [], charts: [] };
          const byUnit = {};
          rows.forEach(r => { byUnit[r.unit_name] = (byUnit[r.unit_name] || 0) + 1; });
          const units = Object.entries(byUnit).sort((a, b) => b[1] - a[1]);
          return {
            answer: `${rows.length} new agencies added this month. Leading branch: ${units[0][0]} (${units[0][1]}).`,
            summary: `New agency onboarding this month across ${units.length} branches.`,
            insights: units.slice(0, 3).map(([u2, c]) => `${u2}: ${c} new agencies.`),
            recommendations: ['Track first-month supply of the new agencies to confirm activation.'],
            charts: [{ type: 'bar', title: 'New agencies by branch', labels: units.slice(0, 12).map(x => x[0]), values: units.slice(0, 12).map(x => x[1]), value_label: 'new agencies' }],
          };
        },
      }),
    },

    // ── 10. Monthly trend ─────────────────────────────────────────────────────
    {
      match: /monthly.*trend|trend.*month|last 12 month|12 month.*trend|month wise (supply|circulation)/i,
      build: (question, scope) => {
        const u = detectUnitFilter(question);
        const uf = u ? ` AND unit_code='${u.unit_code}'` : '';
        return {
          understood: `Monthly circulation trend${u ? ' — ' + u.unit_name : ''} (loaded data)`,
          queries: [{ purpose: 'Monthly trend', sql: `
            SELECT DATE_FORMAT(supply_date,'%Y-%m') AS month, SUM(sup_copy) AS copies,
                   COUNT(DISTINCT supply_date) AS days
            FROM supply_data WHERE supply_date >= '2021-01-01'${uf}${sc(scope, 'unit_code')}
            GROUP BY month ORDER BY month LIMIT 80` }],
          analyse(results) {
            const rows = results[0].rows.map(r => ({ month: r.month, copies: N(r.copies), daily_avg: Math.round(N(r.copies) / Math.max(1, N(r.days))) }));
            if (!rows.length) return genericAnalyse(this, results);
            results[0].rows = rows;
            const first = rows[0], last = rows[rows.length - 1];
            const p = pct(last.daily_avg, first.daily_avg);
            return {
              answer: `Trend across ${rows.length} months: daily average moved from ${fmtNum(first.daily_avg)} (${first.month}) to ${fmtNum(last.daily_avg)} (${last.month}) — ${fmtPct(p)}.`,
              summary: `Monthly totals and daily averages from loaded supply data. If recent months are missing, the historical sync has not reached them yet.`,
              insights: [`Peak month: ${[...rows].sort((a, b) => b.daily_avg - a.daily_avg)[0].month}.`],
              recommendations: [],
              charts: [{ type: 'line', title: 'Daily-average copies by month', labels: rows.map(r => r.month), values: rows.map(r => r.daily_avg), value_label: 'daily avg copies' }],
            };
          },
        };
      },
    },

    // ── 11. Branch/state/zone-wise supply ─────────────────────────────────────
    {
      match: /(branch|unit|state|zone).?wise.*(circulation|supply|cop)|(circulation|supply|cop).*(branch|unit|state|zone).?wise/i,
      build: (question, scope) => {
        const byState = /state|zone/i.test(question);
        const grp = byState ? 'state_name' : 'unit_name';
        return {
          understood: `${byState ? 'State' : 'Branch'}-wise circulation (latest day)`,
          queries: [{ purpose: 'Group-wise supply', sql: `
            SELECT ${grp} AS grp, SUM(sup_copy) AS copies, COUNT(DISTINCT agcd) AS agencies
            FROM supply_data WHERE supply_date=${T.todayOrLatestSupply}${sc(scope, 'unit_code')}
            GROUP BY ${grp} ORDER BY copies DESC LIMIT 60` }],
          analyse(results) {
            const rows = results[0].rows;
            if (!rows.length) return genericAnalyse(this, results);
            const tot = rows.reduce((a, r) => a + N(r.copies), 0);
            const share = (N(rows[0].copies) / (tot || 1) * 100).toFixed(1);
            return {
              answer: `Total ${fmtNum(tot)} copies across ${rows.length} ${byState ? 'states' : 'branches'}. Largest: ${rows[0].grp} with ${fmtNum(rows[0].copies)} (${share}%).`,
              summary: `Supply distribution on the latest loaded day.`,
              insights: [`${rows[0].grp} contributes ${share}% of total supply.`],
              recommendations: [],
              charts: autoChart(rows, `${byState ? 'State' : 'Branch'}-wise copies`, { labelKey: 'grp', valueKey: 'copies' }),
            };
          },
        };
      },
    },

    // ── 12. Today's/total circulation ─────────────────────────────────────────
    {
      match: /(today|total|kitni|current).*(circulation|supply|cop)|(circulation|supply|copies)/i,
      build: (question, scope) => {
        const u = detectUnitFilter(question);
        const uf = u ? ` AND unit_code='${u.unit_code}'` : '';
        return {
          understood: `Total circulation${u ? ' — ' + u.unit_name : ''} (latest day)`,
          queries: [{ purpose: 'Total supply', sql: `
            SELECT supply_date, SUM(sup_copy) AS total_copies, COUNT(DISTINCT agcd) AS agencies,
                   COUNT(DISTINCT unit_code) AS units
            FROM supply_data WHERE supply_date=${T.todayOrLatestSupply}${uf}${sc(scope, 'unit_code')}
            GROUP BY supply_date` }],
          analyse(results) {
            const r = results[0].rows[0];
            if (!r) return genericAnalyse(this, results);
            return {
              answer: `${u ? u.unit_name + ' supplied' : 'Total supply is'} ${fmtNum(r.total_copies)} copies on ${String(r.supply_date).slice(0, 10)} through ${fmtNum(r.agencies)} agencies${u ? '' : ` across ${r.units} branches`}.`,
              summary: `Latest loaded supply day. If this date looks old, the historical sync is still catching up to current dates.`,
              insights: [], recommendations: [], charts: [],
            };
          },
        };
      },
    },

    // ── 13. Collection ────────────────────────────────────────────────────────
    {
      match: /collection|recovery|payment|receipt/i,
      build: (question, scope) => {
        const u = detectUnitFilter(question);
        const uf = u ? ` AND unit_code='${u.unit_code}'` : '';
        return {
          understood: `Collection this month — branch-wise${u ? ' (' + u.unit_name + ')' : ''}`,
          queries: [{ purpose: 'Branch collection', sql: `
            SELECT branch_name AS branch, -SUM(amount) AS collection, COUNT(*) AS receipts,
                   COUNT(DISTINCT ag_code) AS paying_agencies
            FROM agency_collection
            WHERE is_valid=1 AND coll_date >= ${T.thisMonthStart}${uf}${sc(scope, 'unit_code')}
            GROUP BY branch_name ORDER BY collection DESC LIMIT 60` }],
          analyse(results) {
            const rows = results[0].rows;
            if (!rows.length) return genericAnalyse(this, results);
            const tot = rows.reduce((a, r) => a + N(r.collection), 0);
            return {
              answer: `Collection this month: ${fmtINR(tot)} across ${rows.length} branches. Highest: ${rows[0].branch} (${fmtINR(rows[0].collection)}).`,
              summary: `Valid receipts summed per branch since the 1st of this month.`,
              insights: [`${rows[0].branch} leads with ${(N(rows[0].collection) / (tot || 1) * 100).toFixed(1)}% of total collection.`],
              recommendations: [],
              charts: autoChart(rows, 'Collection by branch (₹)', { labelKey: 'branch', valueKey: 'collection', valueLabel: 'collection ₹' }),
            };
          },
        };
      },
    },

    // ── 14. Outstanding (generic) ─────────────────────────────────────────────
    {
      match: /outstanding|baki|due/i,
      build: (question, scope) => ({
        understood: 'Outstanding summary — branch-wise (current)',
        queries: [{ purpose: 'Branch outstanding', sql: `
          SELECT unit_name AS branch, SUM(CASE WHEN cl_amt>0 THEN cl_amt ELSE 0 END) AS outstanding,
                 COUNT(CASE WHEN cl_amt>50000 THEN 1 END) AS high_risk_agencies,
                 COUNT(CASE WHEN cl_amt>0 THEN 1 END) AS agencies_with_dues
          FROM agency_outstanding WHERE period_label='CURRENT'${sc(scope, 'unit_code')}
          GROUP BY unit_name ORDER BY outstanding DESC LIMIT 60` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return genericAnalyse(this, results);
          const tot = rows.reduce((a, r) => a + N(r.outstanding), 0);
          const risk = rows.reduce((a, r) => a + N(r.high_risk_agencies), 0);
          return {
            answer: `Total current outstanding: ${fmtINR(tot)} across ${rows.length} branches; ${risk} agencies owe over ₹50,000. Highest branch: ${rows[0].branch} (${fmtINR(rows[0].outstanding)}).`,
            summary: `Current-period closing outstanding per branch.`,
            insights: [`${rows[0].branch} holds ${(N(rows[0].outstanding) / (tot || 1) * 100).toFixed(1)}% of total dues.`],
            recommendations: risk ? [`Start with the ${risk} high-risk (>₹50K) accounts — ask "agencies with outstanding above 50000" for the list.`] : [],
            charts: autoChart(rows, 'Outstanding by branch (₹)', { labelKey: 'branch', valueKey: 'outstanding', valueLabel: 'outstanding ₹' }),
          };
        },
      }),
    },

    // ── 15. DCR visit summary — by executive, unit, or purpose ──────────────
    {
      match: /\b(dcr|field visit|agency visit|visit summary|kitne.*visit|visit.*kitne|executive.*visit|visit.*executive|visit.*report|visit.*performance)\b/i,
      build: (question, scope) => {
        const byUnit  = /unit|branch/i.test(question);
        const byPurp  = /purpose/i.test(question);
        const grp     = byPurp ? 'visit_purpose' : byUnit ? 'unit_code, MAX(unit_name) unit_name' : 'emp_code, MAX(executive_name) exec_name, MAX(unit_code) unit_code, MAX(unit_name) unit_name';
        const lbl     = byPurp ? 'Purpose' : byUnit ? 'Branch' : 'Executive';
        const nameCol = byPurp ? 'visit_purpose' : byUnit ? 'unit_name' : 'exec_name';
        return {
          understood: `DCR agency visit summary — ${lbl}-wise (last 30 days)`,
          queries: [{ purpose: 'Visit count by ' + lbl.toLowerCase(), sql: `
            SELECT ${grp},
                   COUNT(*) visits,
                   COUNT(DISTINCT visit_to_main_code) agencies,
                   COUNT(DISTINCT visit_date) active_days
            FROM dcr_agency_visit
            WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sc(scope, 'unit_code')}
            GROUP BY ${byPurp ? 'visit_purpose' : byUnit ? 'unit_code' : 'emp_code'}
            ORDER BY visits DESC LIMIT 40` }],
          analyse(results) {
            const rows = results[0].rows;
            if (!rows.length) return { answer: 'No DCR visit data found for the last 30 days.', summary: '', insights: [], recommendations: [], charts: [] };
            const totV = rows.reduce((s, r) => s + N(r.visits), 0);
            const totA = rows.reduce((s, r) => s + N(r.agencies), 0);
            const top = rows[0];
            return {
              answer: `${fmtNum(totV)} DCR agency visits in last 30 days across ${fmtNum(totA)} unique agencies. Top ${lbl.toLowerCase()}: ${top[nameCol] || '—'} (${fmtNum(top.visits)} visits).`,
              summary: `${lbl}-wise breakdown of DCR agency visits in the last 30 days.`,
              insights: [
                `Total: ${fmtNum(totV)} visits to ${fmtNum(totA)} agencies by ${rows.length} ${lbl.toLowerCase()}${byPurp ? '' : 's'}.`,
                rows.length > 1 ? `Lowest: ${rows[rows.length - 1][nameCol] || '—'} (${fmtNum(rows[rows.length - 1].visits)} visits).` : null,
              ].filter(Boolean),
              recommendations: rows.some(r => N(r.visits) < 5) ? [`Some ${lbl.toLowerCase()}s have very low visit counts — check if targets are being met.`] : [],
              charts: [{ type: 'bar', title: `DCR visits by ${lbl.toLowerCase()} (last 30 days)`, labels: rows.slice(0, 15).map(r => r[nameCol] || '?'), values: rows.slice(0, 15).map(r => N(r.visits)), value_label: 'visits' }],
            };
          },
        };
      },
    },

    // ── 16. Executives with no/low visits ────────────────────────────────────
    {
      match: /\b(no visit|zero visit|inactive exec|exec.*not visit|visit.*nahi|field.*absent|absent.*field)\b/i,
      build: (question, scope) => ({
        understood: 'Executives with 0 DCR agency visits in the last 7 days (but active in last 30)',
        queries: [{ purpose: 'Inactive executives', sql: `
          SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_name) unit_name,
                 SUM(visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) last7,
                 SUM(visit_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) last30
          FROM dcr_agency_visit WHERE 1=1${sc(scope, 'unit_code')}
          GROUP BY emp_code
          HAVING last30 > 0 AND last7 = 0
          ORDER BY last30 DESC LIMIT 30` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return { answer: 'All active executives recorded field visits in the last 7 days.', summary: '', insights: [], recommendations: [], charts: [] };
          return {
            answer: `${rows.length} executives had 0 DCR agency visits in the last 7 days despite being active in the last 30 days.`,
            summary: `Executives who were field-active in the last 30 days but went silent in the last 7 days.`,
            insights: [rows.length > 5 ? `${rows.length} inactive executives is a concern — field coverage may have gaps.` : `${rows.length} executives temporarily inactive.`],
            recommendations: ['Unit heads should review attendance and daily field schedules for listed executives.'],
            charts: [],
          };
        },
      }),
    },

    // ── 17. Agencies not visited in N days ───────────────────────────────────
    {
      match: /\b(agenc.*not visit|not visit.*agenc|unvisit|visit gap|visit baaki|coverage gap|agency coverage)\b/i,
      build: (question, scope) => {
        const days = (question.match(/(\d+)\s*day/) || [])[1] || '30';
        return {
          understood: `Agencies with no DCR executive visit in last ${days} days`,
          queries: [{ purpose: 'Unvisited agencies per unit', sql: `
            SELECT unit_code, MAX(unit_name) unit_name,
                   COUNT(DISTINCT visit_to_main_code) agencies_visited,
                   MIN(visit_date) earliest_visit
            FROM dcr_agency_visit
            WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL ${parseInt(days, 10)} DAY)${sc(scope, 'unit_code')}
            GROUP BY unit_code ORDER BY agencies_visited ASC LIMIT 30` },
          { purpose: 'Agencies not visited recently', sql: `
            SELECT unit_code, visit_to_main_code agcd, MAX(executive_name) exec_name,
                   MAX(visit_date) last_visit, DATEDIFF(CURDATE(), MAX(visit_date)) days_since
            FROM dcr_agency_visit WHERE 1=1${sc(scope, 'unit_code')}
            GROUP BY unit_code, visit_to_main_code
            HAVING days_since >= ${parseInt(days, 10)}
            ORDER BY days_since DESC LIMIT 30` }],
          analyse(results) {
            const byUnit = results[0].rows;
            const stale  = results[1].rows;
            if (!stale.length && !byUnit.length) return { answer: 'No DCR visit data found.', summary: '', insights: [], recommendations: [], charts: [] };
            return {
              answer: `${stale.length} agency-unit combinations have not been visited in ${days}+ days. Across units, the lowest field coverage is: ${byUnit.slice(0, 3).map(u => `${u.unit_name} (${u.agencies_visited} agencies visited)`).join(', ')}.`,
              summary: `Agency visit gap analysis — agencies last visited more than ${days} days ago.`,
              insights: [`Top stale: ${stale.slice(0, 3).map(r => `${r.agcd} in ${r.unit_code} (${r.days_since} days)`).join(', ')}.`],
              recommendations: stale.length > 10 ? [`Assign a revisit schedule — agencies beyond ${days} days face payment and relationship risk.`] : [],
              charts: byUnit.length ? [{ type: 'bar', title: `Agencies visited per unit (last ${days} days)`, labels: byUnit.slice(0, 12).map(r => r.unit_name), values: byUnit.slice(0, 12).map(r => N(r.agencies_visited)), value_label: 'agencies visited' }] : [],
            };
          },
        };
      },
    },

    // ── 18. Executive target achievement ──────────────────────────────────────
    {
      match: /\b(target|achievement|achieved|lakshy|lakhshy|best exec|worst exec|top exec|performer)\b/i,
      guard: /exec|branch|unit|month/i,
      build: (question, scope) => ({
        understood: 'Executive target vs achievement — monthly (latest data)',
        queries: [{ purpose: 'Target vs actual by executive', sql: `
          SELECT t.emp_code, COALESCE(t.exec_name, t.emp_code) exec_name,
                 t.unit_code, MAX(t.unit_name) unit_name,
                 t.target_month,
                 SUM(t.target_copies) target_copies,
                 SUM(t.actual_copies) actual_copies,
                 ROUND(SUM(t.actual_copies) / NULLIF(SUM(t.target_copies), 0) * 100, 1) ach_pct
          FROM exec_targets t
          WHERE t.target_month = DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m')${sc(scope, 'unit_code')}
          GROUP BY t.emp_code, t.unit_code, t.target_month
          ORDER BY ach_pct DESC LIMIT 40` }],
        analyse(results) {
          const rows = results[0].rows;
          if (!rows.length) return { answer: 'No executive target data found. (exec_targets table may not have data for last month.)', summary: '', insights: [], recommendations: [], charts: [] };
          const avg = rows.reduce((s, r) => s + N(r.ach_pct), 0) / rows.length;
          const above = rows.filter(r => N(r.ach_pct) >= 100).length;
          const below60 = rows.filter(r => N(r.ach_pct) < 60).length;
          return {
            answer: `${rows.length} executives tracked. Average achievement: ${avg.toFixed(1)}%. ${above} met/exceeded target; ${below60} are below 60%.`,
            summary: `Executive target vs actual achievement for the previous month.`,
            insights: [
              `Best: ${rows[0].exec_name} (${rows[0].unit_name}) — ${N(rows[0].ach_pct)}% of target.`,
              rows.length > 1 ? `Lowest: ${rows[rows.length - 1].exec_name} (${rows[rows.length - 1].unit_name}) — ${N(rows[rows.length - 1].ach_pct)}%.` : null,
              below60 > 0 ? `${below60} executive${below60 > 1 ? 's' : ''} below 60% — flag for review.` : null,
            ].filter(Boolean),
            recommendations: below60 > 0 ? [`Review copy targets for the ${below60} underperforming executives; check if targets are realistic vs supply capacity.`] : [],
            charts: [{ type: 'bar', title: 'Target achievement % by executive', labels: rows.slice(0, 15).map(r => r.exec_name), values: rows.slice(0, 15).map(r => N(r.ach_pct)), value_label: '% achieved' }],
          };
        },
      }),
    },

    // ── 19. Survey / orders ───────────────────────────────────────────────────
    {
      match: /survey|order/i,
      build: (question, scope) => ({
        understood: 'Survey performance — unit-wise (all loaded data)',
        queries: [{ purpose: 'Survey summary', sql: `
          SELECT unit_name, COUNT(DISTINCT r_id) AS surveys,
                 COUNT(DISTINCT CASE WHEN order_id IS NOT NULL AND order_id != '' THEN order_id END) AS orders,
                 COUNT(DISTINCT created_by) AS surveyors
          FROM survey_data WHERE 1=1${sc(scope, 'unit_code')}
          GROUP BY unit_name ORDER BY surveys DESC LIMIT 60` }],
        analyse(results) {
          const rows = results[0].rows.map(r => ({ ...r, conversion_pct: r.surveys > 0 ? Number((N(r.orders) / N(r.surveys) * 100).toFixed(1)) : 0 }));
          if (!rows.length) return genericAnalyse(this, results);
          results[0].rows = rows;
          const totS = rows.reduce((a, r) => a + N(r.surveys), 0), totO = rows.reduce((a, r) => a + N(r.orders), 0);
          return {
            answer: `${fmtNum(totS)} surveys and ${fmtNum(totO)} orders (${(totO / (totS || 1) * 100).toFixed(1)}% conversion) across ${rows.length} units.`,
            summary: `Survey and order counts per unit with conversion rate.`,
            insights: [`Best conversion: ${[...rows].sort((a, b) => b.conversion_pct - a.conversion_pct)[0].unit_name}.`],
            recommendations: [],
            charts: autoChart(rows, 'Surveys by unit', { labelKey: 'unit_name', valueKey: 'surveys' }),
          };
        },
      }),
    },
  ];

  function patternPlan(question, scope) {
    for (const intent of INTENTS) {
      const m = question.match(intent.match);
      if (!m) continue;
      if (intent.guard && !intent.guard.test(question)) continue;
      return intent.build(question, scope, m);
    }
    return null;
  }

  /* ═════════════════════ LLM path (Ollama free / Claude optional) ═════════════════════ */

  const SCHEMA = `
MySQL 8 database for Rajasthan Patrika newspaper circulation. Today: {{TODAY}}.
TABLES (only these):
1. supply_data — daily copy supply. Cols: unit_code, unit_name (=branch), publ_name, edtn_name,
   supply_type_name, agcd, dpcd, ag_name, city_name, dist_name, state_name, supply_date DATE,
   sup_copy INT. "circulation"=SUM(sup_copy). Loaded: 2020-03-18 (pre-COVID day) + 2021 onward.
2. agency_master — agencies. Cols: unit (=unit_code), unit_name, executive_name, ag_type_name,
   agcd, dpcd, ag_name, city_name, state_name, mobile_no1, supply_start_dt DATE, suspend_date,
   supply_stop_flag (Y/N), iscenter.
3. agency_collection — receipts. Cols: coll_date DATE, ag_code, ag_name, branch_name, unit_code,
   payment_mode, amount (NEGATIVE for receipts → use -SUM(amount)), is_valid (must=1), zonal_head.
4. agency_outstanding — dues snapshot. Cols: period_label ('CURRENT'=latest), unit_code, unit_name,
   ag_code, ag_name, cl_amt (closing due, >0 means owes), bill_amt, rec_amt, exec_name, zh_name,
   last_supply_date, block_status, mobno.
5. survey_data — reader surveys. Cols: unit_code, unit_name, bookdate DATE, r_id, created_by,
   unprod_reason, order_id (non-empty=order), agcd, locality_code.
6. units — unit_code, unit_name.
7. dcr_agency_visit — field executive visits to agencies (synced from Oracle ERP). Cols: unit_code,
   unit_name, emp_code, executive_name, visit_to_main_code (=agcd), visit_date DATE, visit_purpose,
   visit_remarks (Hindi/English), latitude, longitude, followup_amount, mark_attn_date.
   Use visit_date for filtering. GROUP BY emp_code for executive-wise, visit_to_main_code for agency-wise.
8. exec_targets — monthly copy targets per executive. Cols: emp_code, exec_name, unit_code, unit_name,
   target_month (YYYY-MM), target_copies INT, actual_copies INT.
RULES: collection totals = -SUM(amount) with is_valid=1. Outstanding = period_label='CURRENT'.
Pre-COVID baseline = supply_date='2020-03-18'. Growth% = (cur-prev)/prev*100.
DCR visit data available from 2024-08 onward. agency_master.unit = unit_code (short code).`;

  function extractJson(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const start = raw.indexOf('{');
    if (start === -1) throw new Error('No JSON in model output');
    return JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
  }

  async function ollamaChat(system, userMsg, maxTokens) {
    const r = await fetch(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL, stream: false, format: 'json',
        options: { temperature: 0, num_predict: maxTokens || 1500 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
    const d = await r.json();
    return d.message?.content || '';
  }

  async function claudeChat(system, userMsg, maxTokens) {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: maxTokens || 2000,
      system, messages: [{ role: 'user', content: userMsg }],
    });
    if (resp.stop_reason === 'refusal') throw new Error('Model declined the request');
    return resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  async function llmChat(system, userMsg, maxTokens) {
    if (ollamaOk) return ollamaChat(system, userMsg, maxTokens);
    if (anthropic) return claudeChat(system, userMsg, maxTokens);
    throw new Error('No LLM available');
  }

  async function llmGenerateSql(question, scope, history) {
    const today = new Date().toISOString().slice(0, 10);
    const sys = `You are a MySQL analyst. ${SCHEMA.replace('{{TODAY}}', today)}
ACCESS SCOPE: ${scope.note}
Reply ONLY with JSON: {"understood":"...","queries":[{"purpose":"...","sql":"SELECT ..."}],"answerable":true}
or {"answerable":false,"reason":"..."} if the data cannot answer it.
Max 2 queries, single SELECT each, LIMIT<=300 on row lists, meaningful ORDER BY.`;
    const hist = history.length
      ? 'Previous conversation:\n' + history.map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n') + '\n\n'
      : '';
    return extractJson(await llmChat(sys, hist + 'Question: ' + question, 1200));
  }

  async function llmAnalyse(question, understood, results) {
    const trimmed = results.map(r => ({ purpose: r.purpose, row_count: r.rows.length, rows: r.rows.slice(0, 50) }));
    const sys = `You are a circulation business analyst. Given query results, reply ONLY with JSON:
{"answer":"<1-2 sentences with key numbers, ₹/Lakh/Crore>","summary":"<3-4 sentences>",
"insights":["..."],"recommendations":["..."],
"charts":[{"type":"bar|line|pie","title":"...","labels":[...],"values":[...],"value_label":"..."}]}
Insights must cite real numbers. Max 2 charts, 12 items each.
Write answer/summary/insights/recommendations in the SAME language as the user's question (Hindi or English).`;
    return extractJson(await llmChat(sys,
      `Question: ${question}\nInterpretation: ${understood}\nResults: ${JSON.stringify(trimmed).slice(0, 30000)}`, 1800));
  }

  /* ═════════════════════ Endpoints ═════════════════════ */

  app.get('/api/ask-ai/status', (req, res) => {
    res.json({
      engine: ollamaOk ? 'ollama' : anthropic ? 'claude' : 'patterns',
      model: ollamaOk ? OLLAMA_MODEL : anthropic ? CLAUDE_MODEL : 'semantic-patterns',
      free: !anthropic || ollamaOk,
    });
  });

  app.post('/api/ask-ai', async (req, res) => {
    const t0 = Date.now();
    const { question, conversation_id } = req.body || {};
    const convId = String(conversation_id || 'default').slice(0, 64);
    if (!question || !String(question).trim()) return res.status(400).json({ detail: 'question is required' });
    const qText = String(question).trim().slice(0, 1000);

    const scope = await scopeInfo(req);
    let engine = 'patterns', sqlLog = '', rowCount = 0;

    try {
      // 1. Try the built-in semantic engine first (instant, deterministic)
      //    Hindi/Hinglish questions are normalized to English keywords first.
      const qNorm = normalizeQuestion(qText);
      let plan = patternPlan(qNorm, scope);
      let analysis = null;

      // 2. If no pattern matched, try LLM (Ollama free / Claude optional)
      if (!plan && (ollamaOk || anthropic)) {
        engine = ollamaOk ? 'ollama' : 'claude';
        const gen = await llmGenerateSql(qText, scope, convHistory(convId));
        if (gen.answerable === false) {
          const payload = { answer: gen.reason || 'This cannot be answered from the available data.', summary: '', insights: [], recommendations: [], charts: [], table: null, engine };
          pushConv(convId, qText, payload.answer);
          logQuery(convId, scope, qText, '', 0, Date.now() - t0, engine, null);
          return res.json(payload);
        }
        plan = { understood: gen.understood, queries: gen.queries, llm: true };
      }

      if (!plan) {
        return res.json({
          answer: "I couldn't understand this question with the built-in engine.",
          summary: 'Try questions about: circulation/supply (today, branch-wise, trends, growth, pre-COVID compare), outstanding (above an amount, recovery status), collection, top agencies, new agencies, declining agencies, zero-supply agencies, or surveys. For free-form questions, install Ollama (free local AI) on the server.',
          insights: [], recommendations: [], charts: [], table: null, engine: 'patterns',
        });
      }

      // Execute
      const results = [];
      for (const item of (plan.queries || []).slice(0, 3)) {
        const r = await execSafe(item.sql);
        sqlLog += r.sql + '\n';
        rowCount += r.rows.length;
        results.push({ purpose: item.purpose, rows: r.rows });
      }

      // Analyse
      if (plan.llm) {
        analysis = await llmAnalyse(qText, plan.understood, results);
      } else {
        analysis = plan.analyse ? plan.analyse(results) : genericAnalyse(plan, results);
      }

      const biggest = results.reduce((a, b) => (b.rows.length > (a?.rows.length || 0) ? b : a), null);
      const table = biggest && biggest.rows.length
        ? { title: biggest.purpose, columns: Object.keys(biggest.rows[0]), rows: biggest.rows.slice(0, 200) }
        : null;

      const payload = {
        understood: plan.understood,
        answer: analysis.answer || '', summary: analysis.summary || '',
        insights: analysis.insights || [], recommendations: analysis.recommendations || [],
        charts: (analysis.charts || []).slice(0, 2), table, engine,
        took_ms: Date.now() - t0,
      };
      pushConv(convId, qText, payload.answer);
      logQuery(convId, scope, qText, sqlLog, rowCount, Date.now() - t0, engine, null);
      res.json(payload);
    } catch (e) {
      logQuery(convId, scope, qText, sqlLog, rowCount, Date.now() - t0, engine, e.message);
      console.error('[ask-ai]', e.message);
      res.status(500).json({
        detail: 'Ask AI failed: ' + e.message,
        answer: 'Sorry — I could not process that question. Please try rephrasing it.',
      });
    }
  });

  function logQuery(convId, scope, question, sql, rows, ms, engine, error) {
    q(`INSERT INTO ai_query_log (conversation_id, person_code, hierarchy_level, question, sql_generated, row_count, duration_ms, engine, error)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [convId, scope.personCode || null, scope.hl || null, question, sql || null, rows, ms, engine, error])
      .catch(() => {});
  }
};
