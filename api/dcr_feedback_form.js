/**
 * Agent Feedback form — configuration, not code.
 *
 * The 23-question questionnaire used to live as a literal array in the DCR bundle, so
 * every wording change was a deploy. Management owns these questions, so they live in
 * a table and are edited from Admin → Agent Feedback Form.
 *
 * Two things the old array did with JavaScript have to become data:
 *
 *   show_when  A question that only applies after another answer ("which competitors?"
 *              after "does he carry competitors?"). Stored declaratively as
 *              {field, op, values} and evaluated by the client, because a function
 *              cannot be stored and must not be eval'd from the database.
 *
 *   calc       A field that is shown rather than asked (potential minus current).
 *              Stored as {op, a, b, suffix}; only whitelisted ops run.
 *
 * Scoring travels with the question too, so a question management adds can count
 * towards the agent health score instead of being decorative. The seed reproduces the
 * existing weights exactly — payment 25, growth 25, supply 20, relationship 20,
 * competition 10 — so scores computed before and after this change agree.
 */
module.exports = function installFeedbackForm({ app, q, requireAdmin }) {
  const S = (v, n) => (v == null ? null : String(v).slice(0, n));
  const J = v => { try { return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v); } catch (_) { return null; } };
  const jstr = v => (v == null ? null : JSON.stringify(v));

  const INPUT_TYPES = ['sel', 'multi', 'star', 'num', 'text', 'long', 'date', 'time', 'photo', 'calc'];
  const SCORE_KINDS = ['map', 'star', 'competition'];
  const CALC_OPS = ['diff', 'sum'];
  const WHEN_OPS = ['in', 'not_in', 'answered', 'gt', 'lt'];

  async function ensure() {
    await q(`CREATE TABLE IF NOT EXISTS dcr_feedback_set (
      set_key    VARCHAR(30) PRIMARY KEY,
      label      VARCHAR(120) NOT NULL,
      sort_order INT DEFAULT 0,
      is_active  TINYINT(1) DEFAULT 1
    ) CHARACTER SET utf8mb4`);

    await q(`CREATE TABLE IF NOT EXISTS dcr_feedback_question (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      code        VARCHAR(20)  NOT NULL,
      section     VARCHAR(60)  NOT NULL,
      question    TEXT         NOT NULL,
      input_type  VARCHAR(12)  NOT NULL,
      options     TEXT         NULL,
      sets        TEXT         NOT NULL,
      show_when   TEXT         NULL,
      calc        TEXT         NULL,
      score_kind  VARCHAR(16)  NULL,
      score_map   TEXT         NULL,
      score_max   DECIMAL(6,2) NULL,
      score_label VARCHAR(60)  NULL,
      score_ref   VARCHAR(20)  NULL,
      hint        VARCHAR(300) NULL,
      is_required TINYINT(1)   DEFAULT 0,
      is_active   TINYINT(1)   DEFAULT 1,
      sort_order  INT          NOT NULL DEFAULT 0,
      updated_by  VARCHAR(20)  NULL,
      updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_code (code),
      INDEX idx_active (is_active, sort_order)
    ) CHARACTER SET utf8mb4`);

    const { rows: n } = await q('SELECT COUNT(*) n FROM dcr_feedback_question');
    if (!Number(n[0].n)) await seed();
  }

  /* First run only. After this the table is the source of truth and the seed is never
     consulted again, so editing a question here has no effect on a live install. */
  async function seed() {
    const PAPERS = ['Dainik Bhaskar', 'Amar Ujala', 'Hindustan', 'Times of India', 'Navbharat Times', 'Local Newspaper'];
    const SETS = [
      ['basic', 'Basic visit', 1], ['recovery', 'Recovery visit', 2], ['growth', 'Growth visit', 3],
      ['problem', 'Problem / service', 4], ['full', 'Quarterly — all questions', 5],
    ];
    for (const [k, l, o] of SETS) {
      await q(`INSERT INTO dcr_feedback_set (set_key,label,sort_order) VALUES (?,?,?)
               ON DUPLICATE KEY UPDATE label=VALUES(label)`, [k, l, o]);
    }

    const ALL = ['basic', 'recovery', 'growth', 'problem', 'full'];
    const Y = ['हाँ'];
    const Qs = [
      ['q1', 'Agent status', 'आज एजेंट से मुलाकात हुई?', 'sel', ['हाँ', 'नहीं'], ALL],
      ['q2', 'Agent status', 'एजेंट हमारी सेवा से कितना संतुष्ट है?', 'star', null, ['basic', 'problem', 'full']],
      ['q3', 'Agent status', 'पिछले महीने की तुलना में व्यवसाय', 'sel', ['बढ़ा', 'समान', 'घटा'], ['basic', 'growth', 'full']],
      ['q4', 'Agent status', 'सबसे बड़ी समस्या', 'multi', ['Supply', 'Payment', 'Competition', 'Reader loss', 'Margin', 'Service', 'अन्य'], ['basic', 'problem', 'full']],
      ['q5', 'Supply', 'क्या रोज़ाना समय पर पर्याप्त कॉपियाँ मिल रही हैं?', 'sel', ['हाँ, हमेशा', 'कभी-कभी समस्या', 'अक्सर समस्या', 'बहुत अधिक समस्या'], ['basic', 'problem', 'full'],
        null, null, { kind: 'map', max: 20, label: 'Supply satisfaction', map: { 'हाँ, हमेशा': 20, 'कभी-कभी समस्या': 14, 'अक्सर समस्या': 7, 'बहुत अधिक समस्या': 0 } }],
      ['q6', 'Supply', 'Supply में किस प्रकार की समस्या?', 'multi', ['Late supply', 'कम copies', 'Extra copies', 'Damaged copies', 'गलत edition', 'कोई समस्या नहीं', 'अन्य'], ['basic', 'problem', 'full']],
      ['q6b', 'Supply', 'सप्लाई टैक्सी कितने बजे पहुँचती है?', 'time', null, ['basic', 'problem', 'full']],
      ['q7', 'Supply', 'वर्तमान supply quantity', 'sel', ['पर्याप्त', 'कम', 'अधिक'], ['basic', 'growth', 'full']],
      ['q8', 'Supply', 'अगले महीने copies बढ़ाने की संभावना?', 'sel', ['हाँ', 'नहीं', 'संभव है'], ['growth', 'full']],
      ['q8a', 'Supply', 'संभावित अतिरिक्त copies', 'num', null, ['growth', 'full'], { field: 'q8', op: 'in', values: ['हाँ', 'संभव है'] }],
      ['q9', 'Recovery', 'Outstanding पर एजेंट की स्थिति', 'sel', ['आज भुगतान किया', 'आंशिक भुगतान किया', 'निर्धारित तारीख को करेगा', 'Payment pending है', 'भुगतान में समस्या है', 'कोई commitment नहीं'], ['recovery', 'full'],
        null, null, { kind: 'map', max: 25, label: 'Payment / recovery', map: { 'आज भुगतान किया': 25, 'आंशिक भुगतान किया': 18, 'निर्धारित तारीख को करेगा': 14, 'Payment pending है': 8, 'भुगतान में समस्या है': 4, 'कोई commitment नहीं': 0 } }],
      ['q10', 'Recovery', 'अगली payment की तारीख', 'date', null, ['recovery', 'full']],
      ['q11', 'Recovery', 'संभावित collection amount (₹)', 'num', null, ['recovery', 'full']],
      ['q12', 'Recovery', 'Payment delay का मुख्य कारण', 'sel', ['Cash flow problem', 'Market recovery pending', 'Customer payment pending', 'Business down', 'Dispute', 'अन्य'], ['recovery', 'full']],
      ['q13', 'Competition', 'क्या competitor की copies भी बाँटता है?', 'sel', ['हाँ', 'नहीं'], ['basic', 'growth', 'full'],
        null, null, { kind: 'competition', max: 10, label: 'Competition risk', ref: 'q14' }],
      ['q14', 'Competition', 'कौन-कौन से competitor?', 'multi', PAPERS.concat(['अन्य']), ['basic', 'growth', 'full'], { field: 'q13', op: 'in', values: Y }],
      ['q15', 'Competition', 'Competitor की कौन-सी बात बेहतर लगती है?', 'multi', ['Price', 'Commission/Margin', 'Supply', 'Scheme', 'Content', 'Service', 'Promotional support', 'अन्य'], ['growth', 'full'], { field: 'q13', op: 'in', values: Y }],
      ['q16', 'Growth', 'नए readers जोड़ने की संभावना', 'sel', ['बहुत अधिक', 'अधिक', 'सामान्य', 'कम', 'नहीं'], ['growth', 'full'],
        null, null, { kind: 'map', max: 25, label: 'Copy growth', map: { 'बहुत अधिक': 25, 'अधिक': 20, 'सामान्य': 13, 'कम': 6, 'नहीं': 0 } }],
      ['q17', 'Growth', 'कोई नया area जहाँ reach बढ़ सके?', 'sel', ['हाँ', 'नहीं'], ['growth', 'full']],
      ['q17a', 'Growth', 'Area का नाम', 'text', null, ['growth', 'full'], { field: 'q17', op: 'in', values: Y }],
      ['q17b', 'Growth', 'अनुमानित households', 'num', null, ['growth', 'full'], { field: 'q17', op: 'in', values: Y }],
      ['q17c', 'Growth', 'Potential copies', 'num', null, ['growth', 'full'], { field: 'q17', op: 'in', values: Y }],
      ['q17d', 'Growth', 'वहाँ का current competitor', 'multi', PAPERS.concat(['None']), ['growth', 'full'], { field: 'q17', op: 'in', values: Y }],
      ['q17e', 'Growth', 'नए area की photo', 'photo', null, ['growth', 'full'], { field: 'q17', op: 'in', values: Y }],
      ['q18', 'Growth', 'क्या agent additional copies बढ़ा सकता है?', 'sel', ['हाँ', 'नहीं', 'Discussion required'], ['growth', 'full']],
      ['q19a', 'Growth', 'Current copies', 'num', null, ['growth', 'full']],
      ['q19b', 'Growth', 'Potential copies', 'num', null, ['growth', 'full']],
      // Shown, not asked, so the stated growth can never contradict the two figures.
      ['q19c', 'Growth', 'संभावित growth', 'calc', null, ['growth', 'full'], null, { op: 'diff', a: 'q19b', b: 'q19a', suffix: 'copies' }],
      ['q20', 'Service', 'हमारी field service कैसी लगती है?', 'star', null, ['basic', 'problem', 'full'],
        null, null, { kind: 'star', max: 20, label: 'Relationship' }],
      ['q21', 'Service', 'Visit frequency पर्याप्त है?', 'sel', ['बहुत अच्छी', 'पर्याप्त', 'कम', 'बहुत कम'], ['problem', 'full']],
      ['q22', 'Service', 'किस प्रकार की support चाहिए?', 'multi', ['Promotional material', 'Scheme', 'Supply improvement', 'Recovery support', 'Reader acquisition', 'Area development', 'कोई support नहीं', 'अन्य'], ['problem', 'growth', 'full']],
      ['q23', 'Open feedback', 'एजेंट की मुख्य समस्या / सुझाव', 'long', null, ALL],
    ];

    let order = 0;
    for (const [code, section, question, type, opts, sets, when, calc, score] of Qs) {
      await q(
        `INSERT INTO dcr_feedback_question
           (code, section, question, input_type, options, sets, show_when, calc,
            score_kind, score_map, score_max, score_label, score_ref, sort_order, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'seed')`,
        [code, section, question, type, jstr(opts), jstr(sets), jstr(when), jstr(calc),
         score ? score.kind : null, score && score.map ? jstr(score.map) : null,
         score ? score.max : null, score ? score.label : null, score ? score.ref || null : null,
         (order += 10)]);
    }
    console.log(`[feedback-form] seeded ${Qs.length} questions and ${SETS.length} visit types`);
  }

  const shape = r => ({
    id: r.id, code: r.code, section: r.section, question: r.question, input_type: r.input_type,
    options: J(r.options), sets: J(r.sets) || [], show_when: J(r.show_when), calc: J(r.calc),
    score: r.score_kind ? { kind: r.score_kind, map: J(r.score_map), max: r.score_max == null ? null : Number(r.score_max),
                            label: r.score_label, ref: r.score_ref } : null,
    hint: r.hint, is_required: !!r.is_required, is_active: !!r.is_active, sort_order: r.sort_order,
    updated_by: r.updated_by, updated_at: r.updated_at,
  });

  const ready = ensure().catch(e => console.error('[feedback-form] schema failed:', e.message));

  // ── what the DCR app renders ──────────────────────────────────────────────
  app.get('/api/dcr-m/feedback-form', async (req, res) => {
    try {
      await ready;
      const [qs, sets] = await Promise.all([
        q(`SELECT * FROM dcr_feedback_question WHERE is_active = 1 ORDER BY sort_order, id`),
        q(`SELECT set_key, label FROM dcr_feedback_set WHERE is_active = 1 ORDER BY sort_order, set_key`),
      ]);
      res.json({ sets: sets.rows, questions: qs.rows.map(shape) });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  // ── admin ─────────────────────────────────────────────────────────────────
  app.get('/api/admin/feedback-questions', requireAdmin, async (req, res) => {
    try {
      await ready;
      const [qs, sets] = await Promise.all([
        q(`SELECT * FROM dcr_feedback_question ORDER BY sort_order, id`),
        q(`SELECT * FROM dcr_feedback_set ORDER BY sort_order, set_key`),
      ]);
      res.json({ sets: sets.rows, questions: qs.rows.map(shape), input_types: INPUT_TYPES });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* Validation is deliberate rather than trusting the form: these rows drive what
     hundreds of field phones render, and a malformed condition or an unknown input
     type would show up as a blank question on a phone in the field, not here. */
  function validate(b, existing) {
    const code = S(b.code, 20);
    if (!code || !/^[a-zA-Z0-9_]+$/.test(code)) return 'Code is required — letters, digits and underscore only.';
    if (!S(b.question, 2000)) return 'Question text is required.';
    if (!S(b.section, 60)) return 'Section is required.';
    if (!INPUT_TYPES.includes(b.input_type)) return `Answer type must be one of: ${INPUT_TYPES.join(', ')}.`;
    const sets = Array.isArray(b.sets) ? b.sets.filter(Boolean) : [];
    if (!sets.length) return 'Choose at least one visit type this question appears in.';
    if (['sel', 'multi'].includes(b.input_type)) {
      const o = Array.isArray(b.options) ? b.options.filter(x => String(x || '').trim()) : [];
      if (!o.length) return 'A choice question needs at least one option.';
    }
    if (b.show_when && b.show_when.field) {
      if (!WHEN_OPS.includes(b.show_when.op)) return `Condition test must be one of: ${WHEN_OPS.join(', ')}.`;
      if (b.show_when.field === code) return 'A question cannot depend on its own answer.';
    }
    if (b.calc && b.calc.op && !CALC_OPS.includes(b.calc.op)) return `Calculation must be one of: ${CALC_OPS.join(', ')}.`;
    if (b.score && b.score.kind && !SCORE_KINDS.includes(b.score.kind)) return 'Unknown scoring type.';
    if (existing && existing.code !== code) return 'The code cannot be changed — answers already recorded are stored against it.';
    return null;
  }

  app.post('/api/admin/feedback-questions', requireAdmin, async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      let existing = null;
      if (b.id) {
        const { rows } = await q('SELECT * FROM dcr_feedback_question WHERE id = ?', [Number(b.id)]);
        if (!rows[0]) return res.status(404).json({ detail: 'Question not found' });
        existing = rows[0];
      }
      const err = validate(b, existing);
      if (err) return res.status(400).json({ detail: err });

      const sc = b.score && b.score.kind ? b.score : null;
      const vals = [
        S(b.code, 20), S(b.section, 60), S(b.question, 2000), b.input_type,
        ['sel', 'multi'].includes(b.input_type) ? jstr((b.options || []).map(x => String(x).trim()).filter(Boolean)) : null,
        jstr(b.sets), b.show_when && b.show_when.field ? jstr(b.show_when) : null,
        b.calc && b.calc.op ? jstr(b.calc) : null,
        sc ? sc.kind : null, sc && sc.map ? jstr(sc.map) : null, sc && sc.max != null ? Number(sc.max) : null,
        sc ? S(sc.label, 60) : null, sc ? S(sc.ref, 20) : null,
        S(b.hint, 300), b.is_required ? 1 : 0, b.is_active === false ? 0 : 1,
        Number(b.sort_order) || 0, S(req.auth && req.auth.personCode, 20),
      ];

      if (existing) {
        await q(`UPDATE dcr_feedback_question SET code=?, section=?, question=?, input_type=?,
                   options=?, sets=?, show_when=?, calc=?, score_kind=?, score_map=?, score_max=?,
                   score_label=?, score_ref=?, hint=?, is_required=?, is_active=?, sort_order=?, updated_by=?
                 WHERE id=?`, [...vals, existing.id]);
        return res.json({ ok: true, id: existing.id, action: 'updated' });
      }
      // A code already used by a retired question is reused rather than duplicated.
      const { rows: dup } = await q('SELECT id FROM dcr_feedback_question WHERE code = ?', [S(b.code, 20)]);
      if (dup[0]) return res.status(409).json({ detail: `Code "${b.code}" is already used by another question.` });
      if (!Number(b.sort_order)) {
        const { rows: mx } = await q('SELECT COALESCE(MAX(sort_order),0) m FROM dcr_feedback_question');
        vals[16] = Number(mx[0].m) + 10;
      }
      const r = await q(`INSERT INTO dcr_feedback_question
          (code, section, question, input_type, options, sets, show_when, calc, score_kind,
           score_map, score_max, score_label, score_ref, hint, is_required, is_active, sort_order, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, vals);
      res.json({ ok: true, id: r.rows.insertId, action: 'created' });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  /* Retire, never delete: answers already recorded are stored against the code, and
     removing the row would leave those answers unlabelled in every past report. */
  app.delete('/api/admin/feedback-questions/:id', requireAdmin, async (req, res) => {
    try {
      await ready;
      await q('UPDATE dcr_feedback_question SET is_active = 0, updated_by = ? WHERE id = ?',
        [S(req.auth && req.auth.personCode, 20), Number(req.params.id)]);
      res.json({ ok: true, retired: true });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/admin/feedback-questions/reorder', requireAdmin, async (req, res) => {
    try {
      await ready;
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ detail: 'ids are required' });
      for (let i = 0; i < ids.length; i++) {
        await q('UPDATE dcr_feedback_question SET sort_order = ? WHERE id = ?', [(i + 1) * 10, ids[i]]);
      }
      res.json({ ok: true, n: ids.length });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  app.post('/api/admin/feedback-sets', requireAdmin, async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      const key = S(b.set_key, 30);
      if (!key || !/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ detail: 'Key must be lower-case letters, digits or underscore.' });
      if (!S(b.label, 120)) return res.status(400).json({ detail: 'Label is required.' });
      await q(`INSERT INTO dcr_feedback_set (set_key,label,sort_order,is_active) VALUES (?,?,?,?)
               ON DUPLICATE KEY UPDATE label=VALUES(label), sort_order=VALUES(sort_order), is_active=VALUES(is_active)`,
        [key, S(b.label, 120), Number(b.sort_order) || 0, b.is_active === false ? 0 : 1]);
      res.json({ ok: true, set_key: key });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });

  return { ready };
};
