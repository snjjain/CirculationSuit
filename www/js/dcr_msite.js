/* ════════════════════════════════════════════════════════════════════════════
   DCR M-Site — field forms inside the dashboard SSO.

   Built to the team's own prototype, then tightened on their review:
     · dropdowns instead of chip rows, so a form fits a screen instead of scrolling
     · light weights, small type, no boxed sections — density over decoration
     · calling is its OWN form, not a mode inside a visit form
     · Approvals lists approved plans only and opens the visit already filled in
     · the bottom bar belongs to this app while you are in it

   A field executive fills these standing in a shop with one thumb. Every extra
   scroll is a reason to fill it later, badly, from memory.
   ════════════════════════════════════════════════════════════════════════════ */

const DM = {
  ctx: null, rights: null, loading: false, err: null,
  mode: null, form: {}, extra: {},
  targets: null, targetsKey: '', targetType: 'agent', search: '',
  centres: null, plan: null, planDate: null, approved: null,
  pending: null, team: null, live: null, day: null,
  geo: null, geoAt: 0, geoErr: null, photo: null,
  fbSet: 'basic', busy: '', flyout: null,
};

function _dmOn() { return S.screen === 'app_dcr' || String(S.screen || '').startsWith('dcrm'); }
const _INR = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const _NN  = n => (Number(n) || 0).toLocaleString('en-IN');
const _Q   = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const _DAY = () => new Date().toISOString().slice(0, 10);
const _NOW = () => new Date().toTimeString().slice(0, 5);

async function _api(path, opts) {
  const r = await fetch(`${api.base}/api/dcr-m${path}`, {
    ...(opts || {}), headers: { ...api.h(), ...((opts && opts.headers) || {}) } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) throw new Error((j && j.detail) || `Request failed (${r.status})`);
  return j || {};
}
function _geo(force) {
  return new Promise((res, rej) => {
    if (!force && DM.geo && Date.now() - DM.geoAt < 30000) return res(DM.geo);
    if (!navigator.geolocation) return rej(new Error('This device cannot provide a location.'));
    navigator.geolocation.getCurrentPosition(
      p => { DM.geo = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6),
             accuracy: Math.round(p.coords.accuracy || 0) }; DM.geoAt = Date.now(); res(DM.geo); },
      e => { DM.geoErr = e.message; rej(new Error(e.message)); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
async function _load(force) {
  if (DM.loading || (DM.ctx && DM.rights && !force)) return;
  DM.loading = true; DM.err = null;
  try { const [c, r] = await Promise.all([_api('/context'), _api('/rights')]);
        DM.ctx = c; DM.rights = r.forms || {}; }
  catch (e) { DM.err = e.message; }
  DM.loading = false; if (_dmOn()) render();
}

/* ── atoms ──────────────────────────────────────────────────────────────────
   Sections are a label and a hairline, not a card in a card. Labels are normal
   weight; only values that carry meaning are emphasised. */
const K = { ink: 'var(--ink,#0f172a)', mut: '#64748b', line: 'var(--brd2,#e6eaf0)', s2: 'var(--surface-2,#f8fafc)' };
const IN = 'width:100%;padding:9px 10px;border:1px solid #d7dde5;border-radius:8px;font-size:14px;box-sizing:border-box;background:#fff;color:#0f172a;font-family:inherit';

const _sec = t => `<div style="font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#9aa5b4;margin:15px 0 7px;padding-bottom:5px;border-bottom:1px solid ${K.line}">${t}</div>`;
const _f = (label, ctl, req, hint) => `<div style="margin-bottom:10px">
  <label style="display:block;font-size:12px;color:${K.mut};margin-bottom:4px">${label}${req ? ' <span style="color:#dc2626">*</span>' : ''}</label>
  ${ctl}${hint ? `<div style="font-size:10.5px;color:#9aa5b4;margin-top:3px">${hint}</div>` : ''}</div>`;
const _row = (a, b) => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">${a}${b}</div>`;

const _in = (k, ph, type, extra) => `<input id="f_${k}" value="${esc(DM.form[k] || '')}" type="${type || 'text'}"
  placeholder="${esc(ph || '')}" oninput="dmSet('${k}',this.value)" ${extra || ''} style="${IN}">`;
const _sel = (k, opts, ph, onX) => `<select onchange="${onX ? `dmSetX('${k}',this.value)` : `dmSet('${k}',this.value)`};render()" style="${IN}">
  <option value="">${esc(ph || '-- Select --')}</option>
  ${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o];
    const cur = onX ? DM.extra[k] : DM.form[k];
    return `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
const _txt = (k, ph, rows) => `<textarea id="f_${k}" rows="${rows || 2}" placeholder="${esc(ph || '')}"
  oninput="dmSet('${k}',this.value)" style="${IN}">${esc(DM.form[k] || '')}</textarea>`;
const _xin = (k, ph, type) => `<input value="${esc(DM.extra[k] || '')}" type="${type || 'text'}" placeholder="${esc(ph || '')}"
  oninput="dmSetX('${k}',this.value)" style="${IN}">`;

/* Multi-select as a compact dropdown-plus-tags: a chip row for eight publications
   costs three rows of scroll, this costs one. */
const _multi = (k, opts, ph) => {
  const cur = DM.extra[k] || [];
  return `<select onchange="dmMulti('${k}',this.value);this.value=''" style="${IN}">
      <option value="">${esc(ph || 'Add…')}</option>
      ${opts.filter(o => !cur.includes(Array.isArray(o) ? o[0] : o))
        .map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}">${esc(l)}</option>`; }).join('')}
    </select>
    ${cur.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">${cur.map(v =>
      `<span style="font-size:11.5px;background:#eef2f7;border-radius:12px;padding:3px 8px;color:#334155">${esc(v)}
        <a onclick="dmMulti('${k}','${_Q(v)}')" style="cursor:pointer;color:#94a3b8;margin-left:3px">×</a></span>`).join('')}</div>` : ''}`;
};

const _btn = (l, on, kind, ex) => {
  const s = { pri: 'background:#1e3a8a;color:#fff;border:none', ok: 'background:#15803d;color:#fff;border:none',
              ghost: 'background:#fff;color:#334155;border:1px solid #d7dde5' }[kind || 'ghost'];
  return `<button onclick="${on}" ${ex || ''} style="${s};border-radius:9px;padding:11px 14px;font-size:14px;font-weight:600;cursor:pointer;width:100%;min-height:44px">${l}</button>`;
};
const _tag = (t, tone) => { const c = { good: '#15803d,#e8f6ee', warn: '#b45309,#fdf3e3', bad: '#b91c1c,#fdeceb',
  info: '#0369a1,#e6f2fb', mute: '#64748b,#f1f5f9' }[tone || 'mute'].split(',');
  return `<span style="font-size:10.5px;color:${c[0]};background:${c[1]};border-radius:9px;padding:2px 7px;white-space:nowrap">${t}</span>`; };

window.dmSet  = (k, v) => { DM.form[k] = v; };
window.dmSetX = (k, v) => { DM.extra[k] = v; };
window.dmMulti = (k, v) => { const a = DM.extra[k] || [];
  DM.extra[k] = a.includes(v) ? a.filter(x => x !== v) : a.concat(v); render(); };

// ── flyout ──────────────────────────────────────────────────────────────────
/* Used where a choice would otherwise push the form off-screen: picking an
   agency, or the 23-question feedback set. It overlays instead of expanding. */
function _flyout() {
  if (!DM.flyout) return '';
  const f = DM.flyout;
  return `<div onclick="dmFly(null)" style="position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:400"></div>
  <div style="position:fixed;left:0;right:0;bottom:0;max-height:86vh;background:#fff;z-index:401;
      border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(15,23,42,.2);display:flex;flex-direction:column">
    <div style="padding:12px 15px;border-bottom:1px solid ${K.line};display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:14px;font-weight:600;color:${K.ink}">${esc(f.title)}</span>
      <button onclick="dmFly(null)" style="border:none;background:none;font-size:20px;color:#94a3b8;cursor:pointer;line-height:1">×</button>
    </div>
    <div style="flex:1;overflow:auto;padding:13px 15px">${f.body()}</div>
  </div>`;
}
window.dmFly = k => { DM.flyout = k; render(); };

// ── home: small icons, light type, no boxes ─────────────────────────────────
const FORMS = [
  { key: 'plan_tour',    icon: '🗺️', name: 'Plan Tour' },
  { key: 'agency_visit', icon: '🏪', name: 'Agency Visit' },
  { key: 'agent_feedback', icon: '📝', name: 'Agent Feedback' },
  { key: 'calling',      icon: '📞', name: 'Calling' },
  { key: 'center_attn',  icon: '📍', name: 'Attendance' },
  { key: 'hawker_visit', icon: '🛵', name: 'Hawker Visit' },
  { key: 'reader_visit', icon: '📰', name: 'Reader Visit' },
  { key: 'new_area',     icon: '🧭', name: 'New Area' },
  { key: 'office_work',  icon: '🏢', name: 'Office / Other' },
];

function _home() {
  const c = DM.ctx, t = c.trip;
  const allowed = FORMS.filter(f => DM.rights && DM.rights[f.key]);

  const head = `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:3px">
      <span style="font-size:15px;color:${K.ink}">${esc(c.staff.name)}</span>
      ${t && t.status === 'active' ? _tag('On duty', 'good') : t ? _tag('Day closed', 'mute') : _tag('Not started', 'warn')}
    </div>
    <div style="font-size:11.5px;color:${K.mut};margin-bottom:12px">${esc(c.staff.designation || 'Field Executive')}${c.staff.unit_code ? ' · ' + esc(c.staff.unit_code) : ''} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
    ${t ? `<div style="display:flex;gap:18px;font-size:12px;color:${K.mut};margin-bottom:13px">
        <span>Entries <b style="color:${K.ink};font-weight:600">${t.visits || 0}</b></span>
        <span>Collected <b style="color:${K.ink};font-weight:600">${_INR(t.collected || 0)}</b></span>
      </div>` : `<div style="margin-bottom:13px">${_btn(DM.busy === 'trip' ? 'Starting…' : 'Start duty', 'dmStartTrip()', 'ok', DM.busy === 'trip' ? 'disabled' : '')}</div>`}`;

  if (!allowed.length) return head + `<div style="font-size:12.5px;color:${K.mut};padding:16px 0">No forms have been assigned to you. Your incharge decides which DCR forms you can use.</div>`;

  /* Small icons, four across on a phone. A tile is an icon and a word — the
     description text that was here only made the grid twice as tall. */
  const grid = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px">
    ${allowed.map(f => `<button onclick="dmOpen('${f.key}')" style="background:none;border:none;cursor:pointer;
        padding:10px 4px;border-radius:10px;display:flex;flex-direction:column;align-items:center;gap:5px"
        onmouseenter="this.style.background='${K.s2}'" onmouseleave="this.style.background='none'">
      <span style="font-size:23px;line-height:1">${f.icon}</span>
      <span style="font-size:11px;color:${K.ink};text-align:center;line-height:1.25">${f.name}</span>
    </button>`).join('')}
  </div>`;

  return head + _sec('Forms') + grid;
}

window.dmOpen = key => {
  DM.form = {}; DM.extra = {}; DM.photo = null; DM.err = null; DM.flyout = null;
  DM.form.visit_date = _DAY(); DM.form.check_in = _NOW();
  DM.mode = key; DM.targets = null; DM.targetsKey = ''; DM.search = '';
  if (key === 'calling') DM.targetType = 'agent';
  render();
};
window.dmHome = () => { DM.mode = null; DM.err = null; DM.flyout = null; render(); };

// ── target picker (flyout) ──────────────────────────────────────────────────
async function _loadTargets(type) {
  const key = `${type}|${DM.search}`;
  if (DM.targetsKey === key && DM.targets) return;
  DM.targetsKey = key;
  try { const r = await _api(`/targets?type=${type}&limit=60${DM.search ? '&q=' + encodeURIComponent(DM.search) : ''}`);
        DM.targets = r.rows || []; } catch (e) { DM.targets = []; }
  if (_dmOn()) render();
}
window.dmSearch = (() => { let t; return v => { DM.search = v; clearTimeout(t);
  t = setTimeout(() => { DM.targets = null; DM.targetsKey = ''; render(); }, 350); }; })();

function _pickerBody(type) {
  _loadTargets(type);
  const rows = (DM.targets || []).slice(0, 40).map(r => `<div onclick='dmPick(${JSON.stringify(r).replace(/'/g, "&#39;")})'
    style="padding:9px 2px;border-bottom:1px solid ${K.line};cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center">
    <div style="min-width:0"><div style="font-size:13.5px;color:${K.ink};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.target_name || r.target_code)}</div>
      <div style="font-size:11px;color:${K.mut}">${esc(r.city || r.centre || '')}</div></div>
    ${Number(r.outstanding) > 0 ? _tag(_INR(r.outstanding), Number(r.outstanding) > 100000 ? 'bad' : 'warn') : ''}</div>`).join('');
  return `<input value="${esc(DM.search)}" oninput="dmSearch(this.value)" placeholder="Type 3 letters…" style="${IN};margin-bottom:9px" autofocus>
    ${DM.targets ? (rows || `<div style="font-size:12.5px;color:${K.mut};padding:10px 0">No match.</div>`) : `<div style="font-size:12.5px;color:${K.mut};padding:10px 0">Loading…</div>`}`;
}
window.dmPick = r => { DM.form._target = r; DM.search = ''; DM.flyout = null; render(); };

function _pickField(type, label) {
  const s = DM.form._target;
  const title = type === 'hawker' ? 'Select hawker' : 'Select agency';
  return _f(label, s
    ? `<div onclick="dmFly({title:'${title}',body:()=>_pickerBody('${type}')})" style="${IN};cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.target_name || s.target_code)}</span>
        ${Number(s.outstanding) > 0 ? _tag(_INR(s.outstanding), 'warn') : ''}</div>`
    : `<div onclick="dmFly({title:'${title}',body:()=>_pickerBody('${type}')})" style="${IN};cursor:pointer;color:#9aa5b4">Tap to choose…</div>`, true);
}

// ── forms ───────────────────────────────────────────────────────────────────
const PURPOSES = ['Recovery – Outstanding Amount', 'Growth Discussion', 'New Agreement / Contract',
  'Agency Change', 'Reader Feedback Collection', 'Scheme & Offer Promotion',
  'Supply Complaint Redressal', 'Relationship Visit', 'Competitor Analysis Visit', 'Other'];
const PAPERS = ['Dainik Bhaskar', 'Amar Ujala', 'Hindustan', 'Times of India', 'Navbharat Times', 'Local Newspaper'];

function _fPlanTour() {
  return _sec('Tour planning') +
    _row(_f('Date', _in('visit_date', '', 'date'), true), _f('Time', _in('check_in', '', 'time'))) +
    _pickField('agent', 'Agency') +
    _f('Purpose', _sel('purpose', PURPOSES, '-- Select purpose --'), true) +
    _f('What do you intend to achieve?', _txt('remarks', '', 2)) +
    _sec('Competitor supply in area') +
    _f('Publications carried', _multi('comp_papers', PAPERS, 'Add publication…')) +
    ((DM.extra.comp_papers || []).length ? (DM.extra.comp_papers || []).map(p =>
      _f(p + ' — copies', `<input value="${esc((DM.extra.comp || {})[p] || '')}" type="number" inputmode="numeric"
        oninput="dmComp('${_Q(p)}',this.value)" placeholder="0" style="${IN}">`)).join('') : '') +
    _sec('Growth target') +
    _row(_f('Copies to add', _in('copies_committed', '0', 'number')), _f('Start date', _in('growth_start', '', 'date'))) +
    _btn(DM.busy ? 'Submitting…' : 'Submit for approval', "dmSubmit('plan_tour')", 'pri', DM.busy ? 'disabled' : '');
}
window.dmComp = (p, v) => { DM.extra.comp = DM.extra.comp || {}; DM.extra.comp[p] = v; };

function _fAgencyVisit() {
  const fromPlan = DM.form._fromPlan;
  return (fromPlan ? `<div style="font-size:11.5px;color:#0369a1;background:#e6f2fb;border-radius:8px;padding:8px 10px;margin-bottom:11px">
      From your approved plan${DM.form.purpose ? ' · ' + esc(DM.form.purpose) : ''}</div>` : '') +
    _sec('Visit') +
    _pickField('agent', 'Agency') +
    _row(_f('Check-in', _in('check_in', '', 'time')), _f('Check-out', _in('check_out', '', 'time'))) +
    _f('Purpose', _sel('purpose', PURPOSES, '-- Select purpose --')) +
    _sec('Collection') +
    _row(_f('Mode', _sel('pay_mode', ['Cash', 'Cheque', 'NEFT / RTGS', 'Net Banking', 'Agent App'], 'Mode', true)),
         _f('Type', _sel('pay_type', ['Full Payment', 'Partial Payment'], 'Type', true))) +
    _row(_f('Amount (₹)', _in('amount_collected', '0', 'number')), _f('Receipt no.', _in('receipt_no', ''))) +
    _sec('Growth commitment') +
    _f('New copies committed', _in('copies_committed', '0', 'number')) +
    _row(_f('Growth start', _in('growth_start', '', 'date')), _f('Dues clear by', _in('dues_clear_by', '', 'date'))) +
    _sec('Outcome') +
    _f('What happened', _sel('outcome', ['Payment collected', 'Promise to pay', 'No payment', 'Copies increased',
      'Complaint resolved', 'Complaint pending', 'Growth opportunity identified', 'Customer unavailable',
      'Shop closed', 'Other'], '-- Select --'), true) +
    _f('Remarks', _txt('remarks', 'English or Hindi', 3)) +
    _sec('Selfie with agent') + _photo('Take selfie', 'Required for a field visit') + _geoLine() +
    _btn(DM.busy ? 'Submitting…' : 'Submit report', "dmSubmit('agency_visit')", 'ok', DM.busy ? 'disabled' : '');
}

/* ── Calling — its own form, deliberately not a mode inside a visit ──────────
   Mixing the two invited a field report to be filed from a desk. Here the record
   is a call from the first field: no geofence, no selfie, counted separately. */
function _fCalling() {
  const s = DM.form._target || {};
  const tel = String(s.mobile || DM.extra.mobile || '').replace(/\D/g, '').slice(-10);
  return _sec('Who did you call?') +
    _f('Contact type', _sel('call_type', [['agent', 'Agency'], ['hawker', 'Hawker'], ['reader', 'Reader / other']], 'Select', true)) +
    (DM.extra.call_type === 'reader'
      ? _f('Name', _in('target_name', 'Reader / contact name'), true) +
        _f('Mobile', _xin('mobile', '10-digit mobile', 'tel'))
      : DM.extra.call_type ? _pickField(DM.extra.call_type, DM.extra.call_type === 'hawker' ? 'Hawker' : 'Agency') : '') +
    (tel.length === 10 ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:2px 0 12px">
        <a href="tel:+91${tel}" style="text-decoration:none;text-align:center;background:#15803d;color:#fff;border-radius:9px;padding:10px;font-size:13.5px">Dial ${tel}</a>
        <a href="https://wa.me/91${tel}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center;background:#fff;border:1px solid #d7dde5;color:#334155;border-radius:9px;padding:10px;font-size:13.5px">WhatsApp</a>
      </div>` : (DM.extra.call_type && DM.extra.call_type !== 'reader' && DM.form._target
        ? `<div style="font-size:11.5px;color:#b45309;margin-bottom:11px">No mobile on record — dial from your own list.</div>` : '')) +
    _sec('Call report') +
    _row(_f('Date', _in('visit_date', '', 'date')), _f('Time', _in('check_in', '', 'time'))) +
    _f('Purpose', _sel('purpose', PURPOSES, '-- Select purpose --'), true) +
    _f('Outcome', _sel('outcome', ['Payment collected', 'Promise to pay', 'No payment', 'Copies increased',
      'Complaint resolved', 'Complaint pending', 'Not reachable', 'Will call back', 'Other'], '-- Select --'), true) +
    _row(_f('Amount promised (₹)', _in('amount_collected', '0', 'number')), _f('Follow-up date', _in('next_followup_date', '', 'date'))) +
    _f('Discussion notes', _txt('remarks', 'What was said and agreed', 3), true) +
    `<div style="font-size:11px;color:${K.mut};margin-bottom:11px">Recorded as a phone call — no location or selfie is captured, and it is counted separately from field visits.</div>` +
    _btn(DM.busy ? 'Submitting…' : 'Submit call report', "dmSubmit('calling')", 'pri', DM.busy ? 'disabled' : '');
}

// ── Agent Feedback — 23 questions, asked by visit type ───────────────────────
/* The team's own note: not all 23 every visit, or nobody fills it. Each set is the
   subset that matters for that kind of visit, so a basic call takes 2-3 minutes. */
const FB_SETS = { basic: 'Basic visit', recovery: 'Recovery visit', growth: 'Growth visit',
                  problem: 'Problem / service', full: 'Quarterly — all 23' };
const FB = [
  { id: 'q1',  s: 'Agent status',  q: 'आज एजेंट से मुलाकात हुई?', t: 'sel', o: ['हाँ', 'नहीं'], sets: ['basic', 'recovery', 'growth', 'problem', 'full'] },
  { id: 'q2',  s: 'Agent status',  q: 'एजेंट हमारी सेवा से कितना संतुष्ट है?', t: 'star', sets: ['basic', 'problem', 'full'] },
  { id: 'q3',  s: 'Agent status',  q: 'पिछले महीने की तुलना में व्यवसाय', t: 'sel', o: ['बढ़ा', 'समान', 'घटा'], sets: ['basic', 'growth', 'full'] },
  { id: 'q4',  s: 'Agent status',  q: 'सबसे बड़ी समस्या', t: 'multi', o: ['Supply', 'Payment', 'Competition', 'Reader loss', 'Margin', 'Service', 'अन्य'], sets: ['basic', 'problem', 'full'] },
  { id: 'q5',  s: 'Supply',        q: 'क्या रोज़ाना समय पर पर्याप्त कॉपियाँ मिल रही हैं?', t: 'sel', o: ['हाँ, हमेशा', 'कभी-कभी समस्या', 'अक्सर समस्या', 'बहुत अधिक समस्या'], sets: ['basic', 'problem', 'full'] },
  { id: 'q6',  s: 'Supply',        q: 'Supply में किस प्रकार की समस्या?', t: 'multi', o: ['Late supply', 'कम copies', 'Extra copies', 'Damaged copies', 'गलत edition', 'कोई समस्या नहीं', 'अन्य'], sets: ['basic', 'problem', 'full'] },
  { id: 'q6b', s: 'Supply',        q: 'सप्लाई टैक्सी कितने बजे पहुँचती है?', t: 'time', sets: ['basic', 'problem', 'full'] },
  { id: 'q7',  s: 'Supply',        q: 'वर्तमान supply quantity', t: 'sel', o: ['पर्याप्त', 'कम', 'अधिक'], sets: ['basic', 'growth', 'full'] },
  { id: 'q8',  s: 'Supply',        q: 'अगले महीने copies बढ़ाने की संभावना?', t: 'sel', o: ['हाँ', 'नहीं', 'संभव है'], sets: ['growth', 'full'] },
  { id: 'q8a', s: 'Supply',        q: 'संभावित अतिरिक्त copies', t: 'num', sets: ['growth', 'full'], when: r => r.q8 === 'हाँ' || r.q8 === 'संभव है' },
  { id: 'q9',  s: 'Recovery',      q: 'Outstanding पर एजेंट की स्थिति', t: 'sel', o: ['आज भुगतान किया', 'आंशिक भुगतान किया', 'निर्धारित तारीख को करेगा', 'Payment pending है', 'भुगतान में समस्या है', 'कोई commitment नहीं'], sets: ['recovery', 'full'] },
  { id: 'q10', s: 'Recovery',      q: 'अगली payment की तारीख', t: 'date', sets: ['recovery', 'full'] },
  { id: 'q11', s: 'Recovery',      q: 'संभावित collection amount (₹)', t: 'num', sets: ['recovery', 'full'] },
  { id: 'q12', s: 'Recovery',      q: 'Payment delay का मुख्य कारण', t: 'sel', o: ['Cash flow problem', 'Market recovery pending', 'Customer payment pending', 'Business down', 'Dispute', 'अन्य'], sets: ['recovery', 'full'] },
  { id: 'q13', s: 'Competition',   q: 'क्या competitor की copies भी बाँटता है?', t: 'sel', o: ['हाँ', 'नहीं'], sets: ['basic', 'growth', 'full'] },
  { id: 'q14', s: 'Competition',   q: 'कौन-कौन से competitor?', t: 'multi', o: PAPERS.concat(['अन्य']), sets: ['basic', 'growth', 'full'], when: r => r.q13 === 'हाँ' },
  { id: 'q15', s: 'Competition',   q: 'Competitor की कौन-सी बात बेहतर लगती है?', t: 'multi', o: ['Price', 'Commission/Margin', 'Supply', 'Scheme', 'Content', 'Service', 'Promotional support', 'अन्य'], sets: ['growth', 'full'], when: r => r.q13 === 'हाँ' },
  { id: 'q16', s: 'Growth',        q: 'नए readers जोड़ने की संभावना', t: 'sel', o: ['बहुत अधिक', 'अधिक', 'सामान्य', 'कम', 'नहीं'], sets: ['growth', 'full'] },
  { id: 'q17', s: 'Growth',        q: 'कोई नया area जहाँ reach बढ़ सके?', t: 'sel', o: ['हाँ', 'नहीं'], sets: ['growth', 'full'] },
  { id: 'q17a', s: 'Growth',       q: 'Area का नाम', t: 'text', sets: ['growth', 'full'], when: r => r.q17 === 'हाँ' },
  { id: 'q17b', s: 'Growth',       q: 'अनुमानित households', t: 'num', sets: ['growth', 'full'], when: r => r.q17 === 'हाँ' },
  { id: 'q18', s: 'Growth',        q: 'क्या agent additional copies बढ़ा सकता है?', t: 'sel', o: ['हाँ', 'नहीं', 'Discussion required'], sets: ['growth', 'full'] },
  { id: 'q19', s: 'Growth',        q: 'संभावित copy growth', t: 'num', sets: ['growth', 'full'] },
  { id: 'q20', s: 'Service',       q: 'हमारी field service कैसी लगती है?', t: 'star', sets: ['basic', 'problem', 'full'] },
  { id: 'q21', s: 'Service',       q: 'Visit frequency पर्याप्त है?', t: 'sel', o: ['बहुत अच्छी', 'पर्याप्त', 'कम', 'बहुत कम'], sets: ['problem', 'full'] },
  { id: 'q22', s: 'Service',       q: 'किस प्रकार की support चाहिए?', t: 'multi', o: ['Promotional material', 'Scheme', 'Supply improvement', 'Recovery support', 'Reader acquisition', 'Area development', 'कोई support नहीं', 'अन्य'], sets: ['problem', 'growth', 'full'] },
  { id: 'q23', s: 'Open feedback', q: 'एजेंट की मुख्य समस्या / सुझाव', t: 'long', sets: ['basic', 'recovery', 'growth', 'problem', 'full'] },
];

/* Health score, as the team specified: 25 payment, 25 growth, 20 supply, 20
   relationship, 10 competition risk. Only answered parameters count, and the score
   says how much of it was answered — a 3-question visit must not read as a verdict. */
function _health(r) {
  const P = [];
  const pay = { 'आज भुगतान किया': 25, 'आंशिक भुगतान किया': 18, 'निर्धारित तारीख को करेगा': 14,
                'Payment pending है': 8, 'भुगतान में समस्या है': 4, 'कोई commitment नहीं': 0 }[r.q9];
  if (pay != null) P.push(['Payment / recovery', pay, 25]);
  const gro = { 'बहुत अधिक': 25, 'अधिक': 20, 'सामान्य': 13, 'कम': 6, 'नहीं': 0 }[r.q16];
  if (gro != null) P.push(['Copy growth', gro, 25]);
  const sup = { 'हाँ, हमेशा': 20, 'कभी-कभी समस्या': 14, 'अक्सर समस्या': 7, 'बहुत अधिक समस्या': 0 }[r.q5];
  if (sup != null) P.push(['Supply satisfaction', sup, 20]);
  if (r.q20) P.push(['Relationship', Math.round((Number(r.q20) / 5) * 20), 20]);
  if (r.q13) P.push(['Competition risk', r.q13 === 'नहीं' ? 10 : Math.max(0, 10 - ((r.q14 || []).length * 2)), 10]);
  if (!P.length) return null;
  const got = P.reduce((s, x) => s + x[1], 0), max = P.reduce((s, x) => s + x[2], 0);
  const pct = Math.round(got / max * 100);
  return { pct, got, max, params: P, covered: Math.round(max / 100 * 100),
           band: pct >= 75 ? ['Healthy', 'good'] : pct >= 55 ? ['Attention required', 'warn']
                 : pct >= 35 ? ['At risk', 'warn'] : ['Critical', 'bad'] };
}

function _fFeedback() {
  const set = DM.fbSet, r = DM.extra;
  const qs = FB.filter(q => q.sets.includes(set)).filter(q => !q.when || q.when(r));
  let lastSec = '';
  const body = qs.map(q => {
    const head = q.s !== lastSec ? (lastSec = q.s, _sec(q.s)) : '';
    const v = r[q.id];
    let ctl;
    if (q.t === 'sel')       ctl = _sel(q.id, q.o, '-- चुनें --', true);
    else if (q.t === 'multi')ctl = _multi(q.id, q.o, 'जोड़ें…');
    else if (q.t === 'star') ctl = `<div style="display:flex;gap:5px">${[1, 2, 3, 4, 5].map(n =>
        `<button type="button" onclick="dmSetX('${q.id}',${n});render()" style="border:none;background:none;font-size:23px;cursor:pointer;padding:2px;line-height:1;filter:${Number(v) >= n ? 'none' : 'grayscale(1) opacity(.35)'}">⭐</button>`).join('')}</div>`;
    else if (q.t === 'long') ctl = `<textarea rows="3" placeholder="बोलकर या लिखकर भरें" oninput="dmSetX('${q.id}',this.value)" style="${IN}">${esc(v || '')}</textarea>`;
    else ctl = `<input value="${esc(v || '')}" type="${q.t === 'num' ? 'number' : q.t === 'date' ? 'date' : q.t === 'time' ? 'time' : 'text'}"
        ${q.t === 'num' ? 'inputmode="numeric"' : ''} oninput="dmSetX('${q.id}',this.value)" style="${IN}">`;
    return head + _f(q.q, ctl);
  }).join('');

  const h = _health(r);
  return _f('Visit type', _sel('fb_set', Object.entries(FB_SETS).map(([k, v]) => [k, v]), null, true).replace(
      `onchange="dmSetX('fb_set',this.value);render()"`, `onchange="DM.fbSet=this.value;render()"`)
      .replace('<option value="">null</option>', '')
      .replace(/selected/g, '') .replace(`value="${set}"`, `value="${set}" selected`),
    false, `${qs.length} questions · about ${Math.max(2, Math.round(qs.length / 4))} minutes`) +
    _pickField('agent', 'Agency') + body +
    (h ? `<div style="margin:14px 0;padding:11px;background:${K.s2};border-radius:9px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px">
        <span style="font-size:12px;color:${K.mut}">Agent health score</span>
        <span style="font-size:17px;color:${K.ink}">${h.pct}<span style="font-size:12px;color:${K.mut}">/100</span> ${_tag(h.band[0], h.band[1])}</span></div>
      ${h.params.map(([n, g, m]) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;color:${K.mut};padding:2px 0">
        <span>${n}</span><span>${g}/${m}</span></div>`).join('')}
      <div style="font-size:10.5px;color:#9aa5b4;margin-top:6px">Scored on the ${h.params.length} parameters answered in this set.</div>
    </div>` : '') +
    _btn(DM.busy ? 'Saving…' : 'Submit feedback', "dmSubmit('agent_feedback')", 'ok', DM.busy ? 'disabled' : '');
}

// ── remaining forms ─────────────────────────────────────────────────────────
async function _loadCentres() { if (DM.centres) return;
  try { const r = await _api('/centres'); DM.centres = r.rows || []; } catch (_) { DM.centres = []; }
  if (_dmOn()) render(); }

function _fCentreAttn() {
  _loadCentres(); const g = DM.geo;
  return _sec('Cash sale centre') +
    _f('Centre', DM.centres ? _sel('centre', (DM.centres || []).map(c => [c.depot_code, c.depot_name || c.depot_code]), '-- Select centre --')
      : `<div style="font-size:12.5px;color:${K.mut};padding:8px 0">Loading…</div>`, true,
      'GPS is checked against the registered centre — you must be within 50 m.') +
    `<div style="font-size:12.5px;color:${g ? (g.accuracy <= 30 ? '#15803d' : '#b45309') : K.mut};margin-bottom:10px">
      ${g ? `GPS locked · ±${g.accuracy} m` : 'Location not read yet'}
      <a onclick="dmRefreshGeo()" style="cursor:pointer;color:#1e3a8a;margin-left:7px;text-decoration:underline">read</a></div>` +
    _f('Remarks', _txt('remarks', '', 2)) +
    _btn(DM.busy ? 'Marking…' : 'Mark attendance', "dmSubmit('center_attn')", 'ok', DM.busy ? 'disabled' : '');
}

function _fHawkerVisit() {
  return _sec('Hawker visit') + _pickField('hawker', 'Hawker') +
    _row(_f('Date', _in('visit_date', '', 'date')), _f('Time', _in('check_in', '', 'time'))) +
    _sec('Outstanding & collection') +
    _row(_f('Outstanding (₹)', _in('outstanding_amount', '0', 'number')), _f('Collected (₹)', _in('amount_collected', '0', 'number'))) +
    _f('Mode', _sel('pay_mode', ['Cash', 'UPI', 'Cheque'], 'Mode', true)) +
    _f('Outcome', _sel('outcome', ['Payment collected', 'Promise to pay', 'No payment', 'Copies increased',
      'Copies decreased', 'Complaint pending', 'Hawker unavailable', 'Other'], '-- Select --'), true) +
    _f('Remarks', _txt('remarks', '', 2)) + _photo('Photo with hawker', 'Optional') + _geoLine() +
    _btn(DM.busy ? 'Submitting…' : 'Submit visit', "dmSubmit('hawker_visit')", 'ok', DM.busy ? 'disabled' : '');
}

function _fReaderVisit() {
  return _sec('Reader / lead') +
    _row(_f('Name', _in('target_name', ''), true), _f('Mobile', _xin('mobile', '10-digit', 'tel'))) +
    _row(_f('Area / colony', _in('target_extra', ''), true), _f('Gender', _sel('gender', ['Male', 'Female', 'Other'], 'Gender', true))) +
    _f('Address', _txt('location', '', 2)) +
    _sec('Newspaper') +
    _f('Currently reads', _multi('current_paper', PAPERS.concat(['Rajasthan Patrika', 'None / New Reader']), 'Add…')) +
    _row(_f('Current copies', _xin('current_copies', '0', 'number')), _f('Potential copies', _xin('potential_copies', '0', 'number'))) +
    _sec('Outcome') +
    _f('Result', _sel('outcome', [['already', 'Already Patrika reader'], ['converted', 'Converted to Patrika'],
      ['not_interested', 'Not interested'], ['no_reply', 'No reply'], ['later', 'Will reply later']], '-- Select --', true), true) +
    _row(_f('Follow-up date', _in('next_followup_date', '', 'date')), _f('', '')) +
    _f('Notes', _txt('remarks', '', 2)) + _geoLine() +
    _btn(DM.busy ? 'Submitting…' : 'Submit', "dmSubmit('reader_visit')", 'ok', DM.busy ? 'disabled' : '');
}

function _fNewArea() {
  return _sec('New area') +
    _f('Area / locality', _in('target_name', ''), true) +
    _row(_f('City', _in('target_extra', '')), _f('District', _xin('district', ''))) +
    _row(_f('Households', _xin('households', '0', 'number')), _f('Potential copies/day', _xin('potential_copies', '0', 'number'))) +
    _f('Current penetration', _multi('current_paper', PAPERS.concat(['None']), 'Add…')) +
    _f('Nearest hawker / centre', _xin('nearest', '')) +
    _f('Field observations', _txt('remarks', '', 3)) + _photo('Photo of area', 'Optional') + _geoLine() +
    _btn(DM.busy ? 'Submitting…' : 'Submit', "dmSubmit('new_area')", 'ok', DM.busy ? 'disabled' : '');
}

function _fOffice() {
  return _sec('Work') +
    _f('Work type', _sel('work_type', ['In-Office Meeting with Incharge', 'Team Meeting / Review', 'Report Preparation',
      'Legal Work / Court Visit', 'Office Visit (Other Branch)', 'Training / Workshop', 'Other Incharge-Assigned Work'], '-- Select --'), true) +
    _row(_f('Date', _in('visit_date', '', 'date')), _f('Location', _in('location', ''))) +
    _row(_f('Start', _in('check_in', '', 'time')), _f('End', _in('check_out', '', 'time'))) +
    _sec('People') +
    _row(_f('Assigned by', _in('assigned_by', '')), _f('Attendees', _in('attendees', ''))) +
    _sec('Description') +
    _f('Subject', _in('subject', ''), true) + _f('Details', _txt('remarks', '', 3), true) +
    _f('Where', _sel('work_mode', ['In Office', 'At Branch', 'Field', 'Court', 'Home'], 'Where', true)) +
    _btn(DM.busy ? 'Submitting…' : 'Submit', "dmSubmit('office_work')", 'ok', DM.busy ? 'disabled' : '');
}

function _photo(l, sub) {
  if (DM.photo) return `<div style="position:relative;margin-bottom:11px"><img src="${DM.photo.dataUrl}" style="width:100%;border-radius:9px;display:block">
    <button onclick="dmClearPhoto()" style="position:absolute;top:7px;right:7px;border:none;background:rgba(15,23,42,.7);color:#fff;border-radius:7px;padding:5px 9px;font-size:11.5px;cursor:pointer">Retake</button></div>`;
  return `<label style="display:flex;gap:10px;align-items:center;border:1px dashed #d7dde5;border-radius:9px;padding:12px;cursor:pointer;margin-bottom:11px">
    <span style="font-size:20px">📷</span><span style="min-width:0"><span style="display:block;font-size:13px;color:${K.ink}">${l}</span>
    <span style="display:block;font-size:11px;color:${K.mut}">${sub}</span></span>
    <input type="file" accept="image/*" capture="environment" onchange="dmPhoto(this)" style="display:none"></label>`;
}
function _geoLine() { const g = DM.geo;
  return `<div style="font-size:11px;color:${K.mut};margin-bottom:11px">📍 ${g ? `Location ready · ±${g.accuracy} m` : 'Location captured on submit'}</div>`; }

// ── Approvals: approved plans only, opening a pre-filled visit ──────────────
async function _loadApproved() {
  if (DM.approved) return;
  try { const r = await _api(`/tour?date=${DM.planDate || _DAY()}`);
        DM.approved = (r.rows || []).filter(x => x.status === 'approved' || x.status === 'done'); }
  catch (_) { DM.approved = []; }
  if (_dmOn()) render();
}
function _approvals() {
  _loadApproved();
  const rows = DM.approved || [];
  return _f('Date', `<input type="date" value="${DM.planDate || _DAY()}" onchange="DM.planDate=this.value;DM.approved=null;render()" style="${IN}">`) +
    (!DM.approved ? `<div style="font-size:12.5px;color:${K.mut};padding:10px 0">Loading…</div>`
     : rows.length ? rows.map(r => `<div style="padding:11px 0;border-bottom:1px solid ${K.line};display:flex;justify-content:space-between;gap:9px;align-items:center">
        <div style="min-width:0"><div style="font-size:13.5px;color:${K.ink}">${esc(r.target_name || r.target_code)}</div>
          <div style="font-size:11px;color:${K.mut}">${esc(r.purpose || '')}${r.visit_time ? ' · ' + esc(r.visit_time) : ''}</div></div>
        ${r.status === 'done' ? _tag('Visited', 'mute')
          : `<button onclick="dmStartFromPlan(${r.id})" style="flex:none;background:#1e3a8a;color:#fff;border:none;border-radius:8px;padding:8px 13px;font-size:12.5px;cursor:pointer">Start visit</button>`}
      </div>`).join('')
     : `<div style="font-size:12.5px;color:${K.mut};padding:14px 0">No approved plans for this date. A plan appears here once your incharge approves it.</div>`);
}
/* Opening from an approved plan carries the agency, purpose and time across, so the
   executive never picks the same agency twice. */
window.dmStartFromPlan = async id => {
  const p = (DM.approved || []).find(x => Number(x.id) === Number(id));
  if (!p) return;
  DM.form = {}; DM.extra = {}; DM.photo = null; DM.err = null;
  DM.form._target = { unit_code: p.unit_code, target_code: p.target_code, target_name: p.target_name,
                      outstanding: p.outstanding_snap, city: p.target_extra };
  DM.form._fromPlan = true; DM.form.plan_id = p.id;
  DM.form.purpose = p.purpose || ''; DM.form.visit_date = _DAY();
  DM.form.check_in = p.visit_time || _NOW();
  DM.mode = 'agency_visit'; render();
};

// ── DCR dashboard (not the management one) ──────────────────────────────────
async function _loadDay() { try { DM.day = await _api('/day-close'); } catch (e) { DM.err = e.message; } }
function _dash() {
  const d = DM.day;
  if (!d) { _loadDay().then(() => _dmOn() && render()); return `<div style="font-size:12.5px;color:${K.mut};padding:12px 0">Loading…</div>`; }
  const calls = (d.visits || []).filter(v => v.visit_mode === 'call').length;
  const line = (k, v) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid ${K.line}">
    <span style="color:${K.mut}">${k}</span><span style="color:${K.ink}">${v}</span></div>`;
  return _sec('Today') + line('Entries', d.total_visits) + line('Field visits', d.total_visits - calls) +
    line('Phone calls', calls) + line('At location', d.valid_visits) + line('Outside geofence', d.invalid_visits) +
    line('Distance', d.total_km + ' km') + line('Collected', _INR(d.collection)) +
    `<div style="font-size:10.5px;color:#9aa5b4;margin-top:7px">${esc(d.km_method || '')}</div>` +
    ((d.visits || []).length ? _sec('Entries') + d.visits.map(v =>
      `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid ${K.line}">
        <div style="min-width:0"><div style="font-size:13px;color:${K.ink}">${esc(v.target_name || v.target_type)}</div>
          <div style="font-size:11px;color:${K.mut}">${esc(v.purpose || '')}${v.outcome ? ' · ' + esc(v.outcome) : ''}</div></div>
        <div style="flex:none;display:flex;gap:5px;align-items:center">
          ${v.visit_mode === 'call' ? _tag('call', 'info') : ''}
          ${Number(v.amount_collected) > 0 ? _tag(_INR(v.amount_collected), 'good') : ''}</div></div>`).join('') : '');
}

// ── submit / actions ────────────────────────────────────────────────────────
window.dmClearPhoto = () => { DM.photo = null; render(); };
window.dmRefreshGeo = async () => { try { await _geo(true); } catch (_) {} render(); };
window.dmPhoto = async input => {
  const f = input.files && input.files[0]; if (!f) return;
  try {
    const dataUrl = await new Promise((res, rej) => { const img = new Image(), fr = new FileReader();
      fr.onload = () => { img.onload = () => { const max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); res(cv.toDataURL('image/jpeg', 0.72)); };
        img.onerror = rej; img.src = fr.result; }; fr.onerror = rej; fr.readAsDataURL(f); });
    DM.photo = { dataUrl }; render();
    const blob = await (await fetch(dataUrl)).blob(); const g = DM.geo || {};
    const r = await fetch(`${api.base}/api/dcr-m/photo?kind=selfie&lat=${g.lat || ''}&lng=${g.lng || ''}`,
      { method: 'POST', headers: { ...api.h(), 'Content-Type': 'image/jpeg' }, body: blob });
    const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Upload failed');
    DM.photo = { dataUrl, id: j.photo_id };
    if (j.duplicate_of) toast('This photo was uploaded before — flagged.');
    render();
  } catch (e) { DM.photo = null; DM.err = e.message; render(); }
};

window.dmSubmit = async form => {
  DM.err = null;
  const t = DM.form._target || {};
  const isCall = form === 'calling';
  let geo = null; if (!isCall) { try { geo = await _geo(true); } catch (_) {} }

  if (form === 'agency_visit' && !DM.photo) { DM.err = 'A selfie with the agent is required. Use the Calling form if you were not on site.'; render(); return; }
  if (['agency_visit', 'hawker_visit', 'agent_feedback'].includes(form) && !t.target_code) {
    DM.err = 'Choose the ' + (form === 'hawker_visit' ? 'hawker' : 'agency') + ' first.'; render(); return; }
  if (isCall && !DM.extra.call_type) { DM.err = 'Who did you call?'; render(); return; }

  DM.busy = '1'; render();
  try {
    if (form === 'plan_tour') {
      await _api('/tour', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tour_date: DM.form.visit_date || _DAY(),
          stops: [{ target_type: 'agent', unit_code: t.unit_code, target_code: t.target_code, target_name: t.target_name,
            visit_time: DM.form.check_in, purpose: DM.form.purpose, description: DM.form.remarks, outstanding: t.outstanding }] }) });
      toast('Sent for approval');
    } else {
      const body = { form: isCall ? 'calling' : form, visit_mode: isCall ? 'call' : 'field', ...(geo || {}),
        unit_code: t.unit_code || (DM.ctx.staff && DM.ctx.staff.unit_code),
        target_code: t.target_code || DM.form.centre || null,
        target_name: DM.form.target_name || t.target_name || null,
        target_extra: DM.form.target_extra || t.city || t.centre || null,
        purpose: DM.form.purpose, outcome: DM.form.outcome, remarks: DM.form.remarks,
        amount_collected: DM.form.amount_collected, outstanding_amount: DM.form.outstanding_amount,
        payment_mode: DM.extra.pay_mode, payment_type: DM.extra.pay_type,
        receipt_no: DM.form.receipt_no, copies_committed: DM.form.copies_committed,
        growth_start: DM.form.growth_start, dues_clear_by: DM.form.dues_clear_by,
        next_followup_date: DM.form.next_followup_date,
        check_in: DM.form.check_in, check_out: DM.form.check_out,
        work_type: DM.form.work_type, location: DM.form.location, assigned_by: DM.form.assigned_by,
        attendees: DM.form.attendees, subject: DM.form.subject, plan_id: DM.form.plan_id || null,
        selfie_id: DM.photo && DM.photo.id ? DM.photo.id : null,
        extra: form === 'agent_feedback' ? { ...DM.extra, fb_set: DM.fbSet, health: _health(DM.extra) } : DM.extra };
      const r = await _api('/form', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast(r.visit_mode === 'call' ? 'Call report saved' : 'Submitted'
        + (r.geofence && r.geofence.within === 0 ? ` · ${_NN(r.geofence.distance_m)} m away` : ''));
    }
    DM.busy = ''; DM.form = {}; DM.extra = {}; DM.photo = null; DM.mode = null;
    DM.targets = null; DM.targetsKey = ''; DM.approved = null; DM.day = null;
    await _load(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

window.dmStartTrip = async () => { DM.busy = 'trip'; render();
  try { const g = await _geo(true);
    await _api('/trip/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...g, place: 'other' }) });
    DM.busy = ''; toast('Duty started'); await _load(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); } };
window.dmEndTrip = async () => { if (!confirm('End duty and close the day?')) return;
  try { let g = null; try { g = await _geo(true); } catch (_) {}
    const r = await _api('/trip/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g || {}) });
    DM.day = r.summary; DM.mode = 'dash'; toast(`Day closed · ${r.summary.total_km} km`); await _load(true);
  } catch (e) { DM.err = e.message; render(); } };

// ── app-owned bottom bar ────────────────────────────────────────────────────
window.appBottomNav = screen => {
  if (screen !== 'app_dcr' && !String(screen || '').startsWith('dcrm')) return null;
  const items = [['', 'Home', '🏠'], ['dash', 'Dashboard', '📊'], ['approvals', 'Approvals', '✅']];
  if (DM.ctx && DM.ctx.trip && DM.ctx.trip.status === 'active') items.push(['end', 'End duty', '🏁']);
  else items.push(['apps', 'Apps', '⋯']);
  return items.map(([k, l, i]) => `<button class="${(DM.mode || '') === k ? 'on' : ''}"
    onclick="${k === 'apps' ? "go('home')" : k === 'end' ? 'dmEndTrip()' : `dmNav('${k}')`}">
    <span class="bico">${i}</span>${l}</button>`).join('');
};
window.dmNav = k => { DM.mode = k || null; DM.err = null; DM.flyout = null;
  if (k === 'dash') DM.day = null; if (k === 'approvals') DM.approved = null;
  if (S.sideOpen) toggleSide();
  render(); };

/* The sidebar while inside DCR: this app's forms, nothing from the management
   dashboard. Only the forms the user is entitled to appear, same source as the home
   grid, so the two can never disagree. */
window.appSideNav = screen => {
  if (screen !== 'app_dcr' && !String(screen || '').startsWith('dcrm')) return null;
  if (!DM.rights) return `<div class="sb-lbl"><span>DCR</span></div>`;
  const item = (k, label, icon) => `<button class="nav-item ${DM.mode === k ? 'on' : ''}"
    onclick="dmNav('${k}')"><span class="nico">${icon}</span><span>${label}</span></button>`;
  let h = `<div class="sb-lbl"><span>DCR</span></div>`
    + item('', 'DCR Home', '📋') + item('dash', 'DCR Dashboard', '📊') + item('approvals', 'Approved Plans', '✅');
  const allowed = FORMS.filter(f => DM.rights[f.key]);
  if (allowed.length) {
    h += `<div class="sb-lbl"><span>Forms</span></div>`;
    h += allowed.map(f => `<button class="nav-item ${DM.mode === f.key ? 'on' : ''}"
      onclick="dmOpen('${f.key}');if(S.sideOpen)toggleSide()"><span class="nico">${f.icon}</span><span>${f.name}</span></button>`).join('');
  }
  return h;
};

// ── shell ───────────────────────────────────────────────────────────────────
const TITLES = { plan_tour: 'Plan Tour', agency_visit: 'Agency Visit', agent_feedback: 'Agent Feedback',
  calling: 'Calling', center_attn: 'Attendance', hawker_visit: 'Hawker Visit', reader_visit: 'Reader Visit',
  new_area: 'New Area', office_work: 'Office / Other', dash: 'DCR Dashboard', approvals: 'Approved Plans' };

VIEWS.dcrm = () => {
  _load();
  if (DM.loading && !DM.ctx) return `<div style="padding:30px;text-align:center;color:${K.mut};font-size:13px">Loading…</div>`;
  if (!DM.ctx) return `<div style="max-width:640px;margin:0 auto;padding:16px">
    <div style="color:#b91c1c;font-size:13.5px;margin-bottom:6px">Could not open DCR</div>
    <div style="font-size:12.5px;color:${K.mut};margin-bottom:12px">${esc(DM.err || 'Unknown error')}</div>
    ${_btn('Try again', 'dmReload()', 'pri')}</div>`;

  const body =
      DM.mode === null            ? _home()
    : DM.mode === 'dash'          ? _dash()
    : DM.mode === 'approvals'     ? _approvals()
    : DM.mode === 'plan_tour'     ? _fPlanTour()
    : DM.mode === 'agency_visit'  ? _fAgencyVisit()
    : DM.mode === 'agent_feedback'? _fFeedback()
    : DM.mode === 'calling'       ? _fCalling()
    : DM.mode === 'center_attn'   ? _fCentreAttn()
    : DM.mode === 'hawker_visit'  ? _fHawkerVisit()
    : DM.mode === 'reader_visit'  ? _fReaderVisit()
    : DM.mode === 'new_area'      ? _fNewArea()
    : DM.mode === 'office_work'   ? _fOffice()
    : _home();

  const err = DM.err ? `<div style="background:#fdeceb;color:#b91c1c;border-radius:8px;padding:9px 11px;font-size:12.5px;margin-bottom:11px">
    ${esc(DM.err)} <a onclick="DM.err=null;render()" style="cursor:pointer;text-decoration:underline;margin-left:5px">dismiss</a></div>` : '';

  return `<div style="max-width:640px;margin:0 auto;padding:12px 14px 16px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:11px">
      ${DM.mode !== null ? `<button onclick="dmHome()" style="flex:none;border:1px solid #d7dde5;background:#fff;color:#334155;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer">←</button>` : ''}
      <span style="font-size:16px;color:${K.ink}">${DM.mode === null ? 'DCR' : esc(TITLES[DM.mode] || 'DCR')}</span>
    </div>
    ${err}${body}${_flyout()}
  </div>`;
};
window.dmReload = () => { DM.ctx = null; DM.rights = null; DM.targets = null; _load(true); };
