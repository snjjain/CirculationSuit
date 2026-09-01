/* ════════════════════════════════════════════════════════════════════════════
   DCR M-Site — the field forms, inside the dashboard SSO.

   Built to the team's own prototype (dcr-forms-prototype.html): three work modes,
   the tabs under each, and the same fields in the same order — because those fields
   are what the circulation business actually asks in the field, and re-inventing
   them would only make the app disagree with how people already work.

   Two things the prototype could not do, added here:
     · rights — the home screen shows an icon per form the user is entitled to, and
       nothing else. The entitlement comes from the server, never from the UI.
     · virtual call — an executive who is not on the road can still ring an agent,
       hawker or reader and file the report. A call is recorded as a call: no
       geofence, no selfie, counted apart from field visits at day close, because
       dressing a phone call up as a visit is exactly the dishonesty this app exists
       to remove.

   Responsive rather than phone-only: one column on a handset, two on a tablet or
   desktop, since incharges will open the same forms on a laptop.
   ════════════════════════════════════════════════════════════════════════════ */

const DM = {
  ctx: null, rights: null, loading: false, err: null,
  mode: null,                 // null = home | agent | hawker | office
  tab: 0,
  form: {}, extra: {},        // current form values
  targets: null, targetsKey: '', search: '',
  centres: null, hawkers: null,
  plan: null, planDate: null,
  pending: null, team: null, live: null,
  geo: null, geoAt: 0, geoErr: null,
  photo: null,
  callMode: false,            // filling the form from a phone call
  busy: '', toastMsg: '',
};

function _dmOn() { return S.screen === 'app_dcr' || String(S.screen || '').startsWith('dcrm'); }
const _dmINR = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const _dmN   = n => (Number(n) || 0).toLocaleString('en-IN');
const _dmQ   = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const _dmDay = () => new Date().toISOString().slice(0, 10);
const _dmNow = () => new Date().toTimeString().slice(0, 5);

async function _dmApi(path, opts) {
  const r = await fetch(`${api.base}/api/dcr-m${path}`, {
    ...(opts || {}), headers: { ...api.h(), ...((opts && opts.headers) || {}) } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) throw new Error((j && j.detail) || `Request failed (${r.status})`);
  return j || {};
}

function _dmGeo(force) {
  return new Promise((resolve, reject) => {
    if (!force && DM.geo && Date.now() - DM.geoAt < 30000) return resolve(DM.geo);
    if (!navigator.geolocation) return reject(new Error('This device cannot provide a location.'));
    navigator.geolocation.getCurrentPosition(
      p => { DM.geo = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6),
               accuracy: Math.round(p.coords.accuracy || 0) };
             DM.geoAt = Date.now(); DM.geoErr = null; resolve(DM.geo); },
      e => { DM.geoErr = e.message || 'Location unavailable'; reject(new Error(DM.geoErr)); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

async function _dmLoad(force) {
  if (DM.loading || (DM.ctx && DM.rights && !force)) return;
  DM.loading = true; DM.err = null;
  try {
    const [c, r] = await Promise.all([_dmApi('/context'), _dmApi('/rights')]);
    DM.ctx = c; DM.rights = r.forms || {};
  } catch (e) { DM.err = e.message; }
  DM.loading = false;
  if (_dmOn()) render();
}

// ── UI atoms ────────────────────────────────────────────────────────────────
const C = { ink: 'var(--ink,#0f172a)', mut: '#64748b', line: 'var(--brd2,#e6eaf0)',
            card: 'var(--card,#fff)', s2: 'var(--surface-2,#f8fafc)' };

const _card = (inner, s) => `<div style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:15px;margin-bottom:12px;${s || ''}">${inner}</div>`;

const _sec = t => `<div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8;margin:16px 0 8px">${t}</div>`;

const _lbl = (t, req) => `<label style="display:block;font-size:12.5px;font-weight:700;color:${C.ink};margin-bottom:5px">${t}${req ? ' <span style="color:#dc2626">*</span>' : ''}</label>`;

const _IN = 'width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14.5px;box-sizing:border-box;background:#fff;color:#0f172a;font-family:inherit';

const _inp = (k, ph, type, extra) => `${''}<input id="f_${k}" value="${esc(DM.form[k] || '')}" type="${type || 'text'}"
  placeholder="${esc(ph || '')}" oninput="dmSet('${k}',this.value)" ${extra || ''} style="${_IN}">`;

const _sel = (k, opts, ph) => `<select id="f_${k}" onchange="dmSet('${k}',this.value)" style="${_IN}">
  <option value="">${esc(ph || '-- Select --')}</option>
  ${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}" ${DM.form[k] === v ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}
</select>`;

const _txt = (k, ph, rows) => `<textarea id="f_${k}" rows="${rows || 3}" placeholder="${esc(ph || '')}"
  oninput="dmSet('${k}',this.value)" style="${_IN}">${esc(DM.form[k] || '')}</textarea>`;

const _fld = (label, control, req, hint) => `<div style="margin-bottom:13px">${_lbl(label, req)}${control}
  ${hint ? `<div style="font-size:11px;color:${C.mut};margin-top:4px">${hint}</div>` : ''}</div>`;

const _btn = (label, onclick, kind, extra) => {
  const k = { pri: 'background:#1e3a8a;color:#fff;border:none',
              ok: 'background:#15803d;color:#fff;border:none',
              warn: 'background:#b45309;color:#fff;border:none',
              ghost: `background:#fff;color:#334155;border:1px solid #cbd5e1` }[kind || 'ghost'];
  return `<button onclick="${onclick}" ${extra || ''} style="${k};border-radius:11px;padding:13px 16px;
    font-size:14.5px;font-weight:700;cursor:pointer;width:100%;min-height:48px">${label}</button>`;
};

const _chip = (t, tone) => { const c = { good: '#15803d,#dcfce7', warn: '#b45309,#fef3c7',
  bad: '#b91c1c,#fee2e2', info: '#0369a1,#e0f2fe', mute: '#64748b,#f1f5f9' }[tone || 'mute'].split(',');
  return `<span style="font-size:10.5px;font-weight:800;color:${c[0]};background:${c[1]};border-radius:9px;padding:3px 9px;white-space:nowrap;display:inline-block">${t}</span>`; };

/* Multi-choice chips — the prototype used these for competitor papers and outcomes,
   and they beat a dropdown when someone is standing in a shop with one thumb free. */
const _chips = (k, opts, multi) => {
  const cur = multi ? (DM.extra[k] || []) : DM.extra[k];
  return `<div style="display:flex;flex-wrap:wrap;gap:7px">${opts.map(o => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    const on = multi ? cur.includes(v) : cur === v;
    return `<button type="button" onclick="dmChip('${k}','${_dmQ(v)}',${!!multi})"
      style="border:1.5px solid ${on ? '#1e3a8a' : '#cbd5e1'};background:${on ? '#1e3a8a' : '#fff'};
      color:${on ? '#fff' : '#334155'};border-radius:20px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer">${esc(l)}</button>`;
  }).join('')}</div>`;
};

window.dmSet   = (k, v) => { DM.form[k] = v; };
window.dmSetX  = (k, v) => { DM.extra[k] = v; };
window.dmChip  = (k, v, multi) => {
  if (multi) { const a = DM.extra[k] || []; DM.extra[k] = a.includes(v) ? a.filter(x => x !== v) : a.concat(v); }
  else DM.extra[k] = DM.extra[k] === v ? null : v;
  render();
};

// ── HOME — icons for the forms this user is entitled to ─────────────────────
const FORMS = [
  { key: 'plan_tour',    mode: 'agent',  tab: 0, icon: '🗺️', name: 'Plan Tour',        desc: 'Plan tomorrow’s agency visits for approval', tint: '#d97706' },
  { key: 'agency_visit', mode: 'agent',  tab: 2, icon: '🏪', name: 'Agency Visit',     desc: 'Collection, growth commitment, selfie',       tint: '#d97706' },
  { key: 'center_attn',  mode: 'hawker', tab: 0, icon: '📍', name: 'Centre Attendance',desc: 'Mark at your cash-sale centre',               tint: '#15803d' },
  { key: 'hawker_visit', mode: 'hawker', tab: 1, icon: '🛵', name: 'Hawker Visit',     desc: 'Outstanding and collection from hawkers',     tint: '#15803d' },
  { key: 'reader_visit', mode: 'hawker', tab: 2, icon: '📰', name: 'Reader Visit',     desc: 'Survey readers, capture leads',               tint: '#15803d' },
  { key: 'new_area',     mode: 'hawker', tab: 3, icon: '🧭', name: 'New Area',         desc: 'Survey a new area for growth',                tint: '#15803d' },
  { key: 'office_work',  mode: 'office', tab: 0, icon: '🏢', name: 'Office / Other',   desc: 'Meetings, legal, assigned work',              tint: '#1d4ed8' },
];

function _dmHome() {
  const c = DM.ctx, t = c.trip;
  const allowed = FORMS.filter(f => DM.rights && DM.rights[f.key]);

  const head = _card(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="min-width:0">
        <div style="font-size:18px;font-weight:800;color:${C.ink}">${esc(c.staff.name)}</div>
        <div style="font-size:12px;color:${C.mut};margin-top:2px">${esc(c.staff.designation || 'Field Executive')}${c.staff.unit_code ? ' · ' + esc(c.staff.unit_code) : ''}</div>
        <div style="font-size:12px;color:${C.mut};margin-top:1px">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
      </div>
      ${t && t.status === 'active' ? _chip('ON DUTY', 'good') : t ? _chip('DAY CLOSED', 'mute') : _chip('NOT STARTED', 'warn')}
    </div>
    ${t ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:13px">
      ${[['Visits', t.visits || 0], ['Done', t.completed || 0], ['Collected', _dmINR(t.collected || 0)]]
        .map(([l, v]) => `<div style="background:${C.s2};border-radius:10px;padding:9px;text-align:center">
          <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;color:#94a3b8">${l}</div>
          <div style="font-size:16px;font-weight:800;color:${C.ink};margin-top:2px">${v}</div></div>`).join('')}
    </div>` : ''}`);

  const trip = t && t.status === 'active'
    ? ''
    : t ? '' : _card(`<div style="font-size:12.5px;color:${C.mut};margin-bottom:10px">
        Start your duty to begin logging. Attendance and location are captured on the first entry.</div>
      ${_btn(DM.busy === 'trip' ? 'Starting…' : '▶ Start duty', 'dmStartTrip()', 'ok', DM.busy === 'trip' ? 'disabled' : '')}`);

  if (!allowed.length) {
    return head + trip + _card(`<div style="text-align:center;padding:18px;color:${C.mut}">
      <div style="font-size:30px;margin-bottom:7px">🔒</div>
      <div style="font-weight:700;color:${C.ink};margin-bottom:4px">No forms assigned</div>
      <div style="font-size:12.5px">Your incharge decides which DCR forms you can use. Ask them to enable the ones you need.</div></div>`);
  }

  /* Icon grid — exactly the forms this person may file, nothing greyed out. Showing a
     locked tile only invites a support call about a form they will never be given. */
  const grid = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
    ${allowed.map(f => `<button onclick="dmOpen('${f.key}')" style="text-align:left;background:${C.card};
      border:1px solid ${C.line};border-radius:14px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:6px;min-height:118px">
      <div style="width:42px;height:42px;border-radius:11px;background:${f.tint}1a;display:flex;align-items:center;justify-content:center;font-size:21px">${f.icon}</div>
      <div style="font-weight:800;font-size:14px;color:${C.ink};line-height:1.25">${f.name}</div>
      <div style="font-size:11.5px;color:${C.mut};line-height:1.35">${f.desc}</div>
    </button>`).join('')}
  </div>`;

  const more = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px">
    ${_btn('📋 My day', 'dmOpenDay()', 'ghost')}
    ${(S.user && S.user.hierarchyLevel <= 4) ? _btn('👥 My team', 'dmOpenTeam()', 'ghost') : _btn('🗺️ My tours', "dmOpen('plan_tour_list')", 'ghost')}
  </div>
  ${t && t.status === 'active' ? `<div style="margin-top:9px">${_btn('🏁 End duty & close day', 'dmEndTrip()', 'ghost')}</div>` : ''}`;

  return head + trip + _sec('Your forms') + grid + more;
}

window.dmOpen = key => {
  DM.form = {}; DM.extra = {}; DM.photo = null; DM.callMode = false; DM.err = null;
  if (key === 'plan_tour_list') { DM.mode = 'plan_list'; render(); return; }
  const f = FORMS.find(x => x.key === key);
  if (!f) return;
  DM.mode = key;
  DM.form.visit_date = _dmDay();
  DM.form.check_in = _dmNow();
  render();
};
window.dmHome = () => { DM.mode = null; DM.err = null; render(); };
window.dmOpenDay = async () => { DM.mode = 'day'; try { DM.day = await _dmApi('/day-close'); } catch (e) { DM.err = e.message; } render(); };
window.dmOpenTeam = async () => {
  DM.mode = 'team';
  try { const [t, p, l] = await Promise.all([_dmApi('/team'), _dmApi('/tour/pending'), _dmApi('/team-live')]);
    DM.team = t; DM.pending = p; DM.live = l; } catch (e) { DM.err = e.message; }
  render();
};

// ── virtual call ────────────────────────────────────────────────────────────
/* The switch that makes a form honest. Turning it on drops the geofence and the selfie
   requirement, dials the number if one is known, and stamps the record as a call. */
function _callBar(mobile) {
  const tel = String(mobile || '').replace(/\D/g, '').slice(-10);
  return `<div style="background:${DM.callMode ? '#eff6ff' : C.s2};border:1px solid ${DM.callMode ? '#93c5fd' : C.line};
      border-radius:12px;padding:12px;margin-bottom:13px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:800;color:${C.ink}">${DM.callMode ? '📞 Filing from a phone call' : 'Not on site?'}</div>
        <div style="font-size:11.5px;color:${C.mut};margin-top:2px">${DM.callMode
          ? 'No location or selfie needed. This is recorded as a call, not a field visit.'
          : 'Call instead and file the same report.'}</div>
      </div>
      <button onclick="dmToggleCall()" style="flex:none;border:1px solid ${DM.callMode ? '#1d4ed8' : '#cbd5e1'};
        background:${DM.callMode ? '#1d4ed8' : '#fff'};color:${DM.callMode ? '#fff' : '#334155'};
        border-radius:20px;padding:8px 14px;font-size:12.5px;font-weight:700;cursor:pointer">${DM.callMode ? 'On' : 'Call'}</button>
    </div>
    ${DM.callMode && tel.length === 10 ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
      <a href="tel:+91${tel}" style="text-decoration:none;text-align:center;background:#15803d;color:#fff;border-radius:10px;padding:11px;font-size:13.5px;font-weight:700">📞 Dial ${tel}</a>
      <a href="https://wa.me/91${tel}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center;background:#fff;border:1px solid #cbd5e1;color:#334155;border-radius:10px;padding:11px;font-size:13.5px;font-weight:700">WhatsApp</a>
    </div>` : DM.callMode ? `<div style="font-size:11.5px;color:#b45309;margin-top:8px">No mobile number on record for this contact — dial from your own list.</div>` : ''}
  </div>`;
}
window.dmToggleCall = () => { DM.callMode = !DM.callMode; render(); };

// ── shared pickers ──────────────────────────────────────────────────────────
async function _loadTargets(type) {
  const key = `${type}|${DM.search}`;
  if (DM.targetsKey === key && DM.targets) return;
  DM.targetsKey = key;
  try { const r = await _dmApi(`/targets?type=${type}&limit=60${DM.search ? '&q=' + encodeURIComponent(DM.search) : ''}`);
        DM.targets = r.rows || []; } catch (e) { DM.targets = []; DM.err = e.message; }
  if (_dmOn()) render();
}
window.dmSearch = (() => { let t; return v => { DM.search = v; clearTimeout(t);
  t = setTimeout(() => { DM.targets = null; DM.targetsKey = ''; render(); }, 350); }; })();

/* Picking who the form is about. The chosen row carries its dues and copies forward so
   the executive sees the reason for the call while filling the report. */
function _picker(type, label) {
  _loadTargets(type);
  const sel = DM.form._target;
  if (sel) {
    return _fld(label, `<div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:11px;padding:12px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0"><div style="font-weight:800;font-size:14px;color:${C.ink}">${esc(sel.target_name || sel.target_code)}</div>
          <div style="font-size:11.5px;color:${C.mut};margin-top:2px">${esc(sel.city || sel.centre || '')} · ${esc(sel.target_code)}</div></div>
        <a onclick="dmClearTarget()" style="cursor:pointer;color:#1d4ed8;font-size:12px;text-decoration:underline;flex:none">change</a>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px">
        ${Number(sel.outstanding) > 0 ? _chip('Dues ' + _dmINR(sel.outstanding), Number(sel.outstanding) > 100000 ? 'bad' : 'warn') : ''}
        ${sel.avg_copies ? _chip(_dmN(sel.avg_copies) + ' cp/day', 'info') : ''}
        ${sel.last_visit ? _chip('Last ' + String(sel.last_visit).slice(0, 10), 'mute') : _chip('Never visited', 'warn')}
      </div></div>`, true);
  }
  const rows = (DM.targets || []).slice(0, 25).map(r => `<div onclick='dmPickTarget(${JSON.stringify(r).replace(/'/g, "&#39;")})'
      style="border:1px solid ${C.line};border-radius:10px;padding:11px;margin-bottom:7px;cursor:pointer;background:${C.card}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0"><div style="font-weight:700;font-size:13.5px;color:${C.ink};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.target_name || r.target_code)}</div>
          <div style="font-size:11px;color:${C.mut}">${esc(r.city || r.centre || '')}</div></div>
        ${Number(r.outstanding) > 0 ? _chip(_dmINR(r.outstanding), Number(r.outstanding) > 100000 ? 'bad' : 'warn') : ''}
      </div></div>`).join('');
  return _fld(label, `<input value="${esc(DM.search)}" oninput="dmSearch(this.value)" placeholder="Type 3 letters of the name…" style="${_IN};margin-bottom:9px">
    <div style="max-height:290px;overflow:auto">${DM.targets ? (rows || `<div style="color:#94a3b8;font-size:13px;padding:10px">No match.</div>`) : `<div style="color:#94a3b8;font-size:13px;padding:10px">Loading…</div>`}</div>`, true);
}
window.dmPickTarget = r => { DM.form._target = r; DM.search = ''; render(); };
window.dmClearTarget = () => { DM.form._target = null; DM.targets = null; DM.targetsKey = ''; render(); };

// ── FORM: Plan Tour ─────────────────────────────────────────────────────────
const PURPOSES = ['Recovery – Outstanding Amount', 'Growth Discussion', 'New Agreement / Contract',
  'Reader Feedback Collection', 'Scheme & Offer Promotion', 'Supply Complaint Redressal',
  'Relationship Visit', 'Competitor Analysis Visit', 'Other'];
const PAPERS = ['Dainik Bhaskar', 'Times of India', 'Navbharat Times', 'Amar Ujala', 'Hindustan Times'];

function _formPlanTour() {
  return _card(_sec('Tour planning') +
    _fld('Date of tour', _inp('visit_date', '', 'date'), true) +
    _picker('agent', 'Select agency') +
    _fld('Tentative visit time', _inp('check_in', '', 'time'), false, 'Can be changed during the actual visit') +
    _fld('Visit purpose', _sel('purpose', PURPOSES, '-- Select purpose --'), true) +
    _fld('Purpose description', _txt('remarks', 'What do you intend to achieve on this visit?')) +

    _sec('Competitor supply in agent area') +
    `<div style="border:1px solid ${C.line};border-radius:11px;overflow:hidden;margin-bottom:13px">
      ${PAPERS.map((p, i) => `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;${i ? 'border-top:1px solid ' + C.line : ''}">
        <span style="flex:1;font-size:13.5px;color:${C.ink}">${p}</span>
        <input type="number" inputmode="numeric" placeholder="copies" value="${esc((DM.extra.comp || {})[p] || '')}"
          oninput="dmComp('${_dmQ(p)}',this.value)" style="width:96px;padding:9px;border:1px solid #cbd5e1;border-radius:8px;font-size:13.5px;text-align:right;box-sizing:border-box">
      </div>`).join('')}
    </div>` +

    _sec('Growth target') +
    _fld('Target copies to add', _inp('copies_committed', 'e.g. 250', 'number')) +
    _fld('Expected start date', _inp('growth_start', '', 'date')) +
    _btn(DM.busy ? 'Submitting…' : '📤 Submit for approval', "dmSubmit('plan_tour')", 'pri', DM.busy ? 'disabled' : ''));
}
window.dmComp = (paper, v) => { DM.extra.comp = DM.extra.comp || {}; DM.extra.comp[paper] = v; };

// ── FORM: Agency Visit report ───────────────────────────────────────────────
function _formAgencyVisit() {
  const sel = DM.form._target || {};
  return _card(
    _callBar(sel.mobile) +
    _sec('Visit details') +
    _picker('agent', 'Agency') +
    (DM.callMode ? '' : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
      ${_fld('Check-in time', _inp('check_in', '', 'time'))}
      ${_fld('Check-out time', _inp('check_out', '', 'time'))}</div>`) +

    _sec('Collection details') +
    _fld('Payment mode', _chips('pay_mode', ['Cash', 'Cheque', 'NEFT / RTGS', 'Net Banking', 'Agent App'])) +
    _fld('Payment type', _chips('pay_type', ['Full Payment', 'Partial Payment'])) +
    _fld('Amount collected (₹)', _inp('amount_collected', '0', 'number')) +
    _fld('Receipt number', _inp('receipt_no', 'If a receipt was issued')) +

    _sec('Growth commitment') +
    _fld('New copies committed', _inp('copies_committed', '0', 'number')) +
    _fld('Growth start date', _inp('growth_start', '', 'date')) +
    _fld('Agent will clear dues by', _inp('dues_clear_by', '', 'date')) +

    _sec('Meeting remarks') +
    _fld('Notes / remarks', _txt('remarks', 'Type in English or Hindi — both accepted', 4)) +
    _fld('Outcome', _sel('outcome', ['Payment collected', 'Promise to pay', 'No payment',
      'Copies increased', 'Complaint resolved', 'Complaint pending', 'Growth opportunity identified',
      'Customer unavailable', 'Shop closed', 'Other'], '-- What happened --'), true) +

    (DM.callMode ? '' : _sec('Selfie with agent') + _photoBlock('Tap to take a selfie with the agent', 'Required before submitting a field report')) +
    _geoNote() +
    _btn(DM.busy ? 'Submitting…' : (DM.callMode ? '📞 Submit call report' : 'Submit report 📤'),
      "dmSubmit('agency_visit')", DM.callMode ? 'pri' : 'ok', DM.busy ? 'disabled' : ''));
}

function _photoBlock(label, sub) {
  if (DM.photo) return `<div style="position:relative;margin-bottom:13px">
    <img src="${DM.photo.dataUrl}" style="width:100%;border-radius:12px;display:block">
    <button onclick="dmClearPhoto()" style="position:absolute;top:8px;right:8px;border:none;background:rgba(15,23,42,.75);color:#fff;border-radius:8px;padding:6px 11px;font-size:12px;cursor:pointer">Retake</button></div>`;
  return `<label style="display:block;border:1.5px dashed #cbd5e1;border-radius:12px;padding:20px;text-align:center;cursor:pointer;margin-bottom:13px">
    <div style="font-size:26px;margin-bottom:5px">📷</div>
    <div style="font-size:13.5px;font-weight:700;color:${C.ink}">${label}</div>
    <div style="font-size:11.5px;color:${C.mut};margin-top:3px">${sub}</div>
    <input type="file" accept="image/*" capture="environment" onchange="dmPhoto(this)" style="display:none"></label>`;
}
function _geoNote() {
  if (DM.callMode) return '';
  const g = DM.geo;
  return `<div style="display:flex;gap:10px;align-items:center;background:${C.s2};border-radius:11px;padding:11px;margin-bottom:13px">
    <span style="font-size:19px">📍</span>
    <div style="min-width:0"><div style="font-size:12.5px;font-weight:700;color:${C.ink}">${g ? `Location ready · ±${g.accuracy} m` : 'Location will be captured on submit'}</div>
      <div style="font-size:11px;color:${C.mut}">Lat/long and timestamp are recorded automatically</div></div></div>`;
}

// ── FORM: Centre attendance ─────────────────────────────────────────────────
async function _loadCentres() {
  if (DM.centres) return;
  try { const r = await _dmApi('/centres'); DM.centres = r.rows || []; }
  catch (_) { DM.centres = []; }
  if (_dmOn()) render();
}
function _formCentreAttn() {
  _loadCentres();
  const g = DM.geo;
  return _card(_sec('Cash sale centre') +
    _fld('Select your centre', DM.centres
      ? _sel('centre', (DM.centres || []).map(c => [c.depot_code, `${c.depot_name || c.depot_code}${c.has_geo ? '' : ' (location not registered)'}`]), '-- Select centre --')
      : `<div style="color:#94a3b8;font-size:13px;padding:10px">Loading centres…</div>`, true,
      'Your GPS is verified against the registered centre location — you must be within 50 m.') +
    `<div style="background:${C.s2};border-radius:11px;padding:13px;margin-bottom:13px;text-align:center">
      <div style="font-size:13px;font-weight:700;color:${g ? (g.accuracy <= 30 ? '#15803d' : '#b45309') : C.mut}">
        ${g ? `📍 GPS locked · ±${g.accuracy} m` : '📍 Tap below to read your location'}</div>
      <div style="margin-top:9px">${_btn('Read my location', 'dmRefreshGeo()', 'ghost')}</div></div>` +
    _fld('Remarks', _txt('remarks', 'Anything to note about today', 2)) +
    _btn(DM.busy ? 'Marking…' : '✓ Mark attendance', "dmSubmit('center_attn')", 'ok', DM.busy ? 'disabled' : ''));
}

// ── FORM: Hawker visit ──────────────────────────────────────────────────────
function _formHawkerVisit() {
  const sel = DM.form._target || {};
  return _card(
    _callBar(sel.mobile) +
    _sec('Hawker visit details') +
    _picker('hawker', 'Select hawker') +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
      ${_fld('Visit date', _inp('visit_date', '', 'date'))}
      ${_fld('Visit time', _inp('check_in', '', 'time'))}</div>` +
    _sec('Outstanding & collection') +
    _fld('Outstanding amount (₹)', _inp('outstanding_amount', '0', 'number')) +
    _fld('Collected amount (₹)', _inp('amount_collected', '0', 'number')) +
    _fld('Payment mode', _chips('pay_mode', ['Cash', 'UPI', 'Cheque'])) +
    _fld('Outcome', _sel('outcome', ['Payment collected', 'Promise to pay', 'No payment',
      'Copies increased', 'Copies decreased', 'Complaint pending', 'Hawker unavailable', 'Other'], '-- What happened --'), true) +
    _fld('Remarks / notes', _txt('remarks', 'What was discussed')) +
    (DM.callMode ? '' : _photoBlock('Photo with the hawker', 'Optional but recommended')) +
    _geoNote() +
    _btn(DM.busy ? 'Submitting…' : (DM.callMode ? '📞 Submit call report' : 'Submit visit 📤'),
      "dmSubmit('hawker_visit')", DM.callMode ? 'pri' : 'ok', DM.busy ? 'disabled' : ''));
}

// ── FORM: Reader visit ──────────────────────────────────────────────────────
function _formReaderVisit() {
  return _card(
    _callBar(DM.extra.mobile) +
    _sec('Reader / lead information') +
    _fld('Area / colony / locality', _inp('target_extra', 'e.g. Vaishali Nagar'), true) +
    _fld('Full name', _inp('target_name', 'Reader’s name'), true) +
    _fld('Gender', _chips('gender', ['Male', 'Female', 'Other'])) +
    _fld('Address', _txt('location', 'House / street / landmark', 2)) +
    _fld('Mobile number', `<input value="${esc(DM.extra.mobile || '')}" oninput="dmSetX('mobile',this.value)" type="tel" inputmode="numeric" placeholder="10-digit mobile" style="${_IN}">`) +
    _fld('Email (optional)', `<input value="${esc(DM.extra.email || '')}" oninput="dmSetX('email',this.value)" type="email" placeholder="name@example.com" style="${_IN}">`) +

    _sec('Current newspaper') +
    _fld('Which paper do they read now?', _chips('current_paper', PAPERS.concat(['Rajasthan Patrika', 'None / New Reader']), true)) +
    _fld('Copies per day', `<input value="${esc(DM.extra.current_copies || '')}" oninput="dmSetX('current_copies',this.value)" type="number" inputmode="numeric" placeholder="0" style="${_IN}">`) +

    _sec('Outcome') +
    _fld('Visit outcome', _chips('outcome', [['already', '✅ Already Patrika reader'], ['converted', '🔄 Converted to Patrika'],
      ['not_interested', '❌ Not interested'], ['no_reply', '📵 No reply'], ['later', '⏰ Will reply later']]), true) +
    _fld('Potential copies', `<input value="${esc(DM.extra.potential_copies || '')}" oninput="dmSetX('potential_copies',this.value)" type="number" inputmode="numeric" placeholder="0" style="${_IN}">`) +
    _fld('Additional notes', _txt('remarks', 'Anything worth following up')) +
    _fld('Follow-up date', _inp('next_followup_date', '', 'date')) +
    _geoNote() +
    _btn(DM.busy ? 'Submitting…' : (DM.callMode ? '📞 Submit call report' : 'Submit & mark location 📍'),
      "dmSubmit('reader_visit')", DM.callMode ? 'pri' : 'ok', DM.busy ? 'disabled' : ''));
}

// ── FORM: New area ──────────────────────────────────────────────────────────
function _formNewArea() {
  return _card(_sec('New area development') +
    _fld('Area / locality name', _inp('target_name', 'e.g. Mansarovar Extension'), true) +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
      ${_fld('City / town', _inp('target_extra', 'City'))}
      ${_fld('District', `<input value="${esc(DM.extra.district || '')}" oninput="dmSetX('district',this.value)" placeholder="District" style="${_IN}">`)}</div>` +
    _fld('Estimated households', `<input value="${esc(DM.extra.households || '')}" oninput="dmSetX('households',this.value)" type="number" inputmode="numeric" placeholder="e.g. 1200" style="${_IN}">`) +
    _fld('Current newspaper penetration', _chips('current_paper', PAPERS.concat(['None']), true)) +

    _sec('Growth potential') +
    _fld('Estimated Patrika potential (copies/day)', `<input value="${esc(DM.extra.potential_copies || '')}" oninput="dmSetX('potential_copies',this.value)" type="number" inputmode="numeric" placeholder="0" style="${_IN}">`) +
    _fld('Nearest existing hawker / centre', `<input value="${esc(DM.extra.nearest || '')}" oninput="dmSetX('nearest',this.value)" placeholder="Name or code" style="${_IN}">`) +
    _fld('Working notes / field observations', _txt('remarks', 'What did you see on the ground?', 4)) +
    (DM.callMode ? '' : _photoBlock('Photo of the area', 'Optional')) +
    _geoNote() +
    _btn(DM.busy ? 'Submitting…' : 'Submit report 📍', "dmSubmit('new_area')", 'ok', DM.busy ? 'disabled' : ''));
}

// ── FORM: Office / other work ───────────────────────────────────────────────
function _formOffice() {
  return _card(_sec('Work details') +
    _fld('Work type', _sel('work_type', ['In-Office Meeting with Incharge', 'Team Meeting / Review',
      'Report Preparation', 'Legal Work / Court Visit', 'Office Visit (Other Branch)',
      'Training / Workshop', 'Other Incharge-Assigned Work'], '-- Select work type --'), true) +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
      ${_fld('Date', _inp('visit_date', '', 'date'))}
      ${_fld('Location', _inp('location', 'Where'))}</div>
     <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
      ${_fld('Start time', _inp('check_in', '', 'time'))}
      ${_fld('End time', _inp('check_out', '', 'time'))}</div>` +
    _sec('People involved') +
    _fld('Permitted / assigned by', _inp('assigned_by', 'Name of the incharge')) +
    _fld('Attendees / others involved', _inp('attendees', 'Comma separated')) +
    _sec('Work description') +
    _fld('Subject / topic', _inp('subject', 'One line'), true) +
    _fld('Detailed description', _txt('remarks', 'What was done, decided or produced', 4), true) +
    _fld('Where was this work done?', _chips('work_mode', ['In Office', 'At Branch', 'Field', 'Court', 'Home'])) +
    _btn(DM.busy ? 'Submitting…' : 'Submit 📤', "dmSubmit('office_work')", 'ok', DM.busy ? 'disabled' : ''));
}

// ── submit ──────────────────────────────────────────────────────────────────
window.dmClearPhoto = () => { DM.photo = null; render(); };
window.dmRefreshGeo = async () => { try { await _dmGeo(true); } catch (_) {} render(); };

window.dmPhoto = async input => {
  const f = input.files && input.files[0]; if (!f) return;
  try {
    const dataUrl = await new Promise((res, rej) => {
      const img = new Image(), fr = new FileReader();
      fr.onload = () => { img.onload = () => {
        const max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', 0.72)); }; img.onerror = rej; img.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(f);
    });
    DM.photo = { dataUrl }; render();
    const blob = await (await fetch(dataUrl)).blob();
    const g = DM.geo || {};
    const r = await fetch(`${api.base}/api/dcr-m/photo?kind=selfie&lat=${g.lat || ''}&lng=${g.lng || ''}`,
      { method: 'POST', headers: { ...api.h(), 'Content-Type': 'image/jpeg' }, body: blob });
    const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Upload failed');
    DM.photo = { dataUrl, id: j.photo_id };
    if (j.duplicate_of) toast('⚠ This photo was uploaded before — it has been flagged.');
    render();
  } catch (e) { DM.photo = null; DM.err = e.message; render(); }
};

window.dmSubmit = async form => {
  DM.err = null;
  const t = DM.form._target || {};
  // Field visits need a fix; a call does not.
  let geo = null;
  if (!DM.callMode) { try { geo = await _dmGeo(true); } catch (_) {} }

  if (form === 'agency_visit' && !DM.callMode && !DM.photo) {
    DM.err = 'A selfie with the agent is required for a field visit. Switch to “Call” if you are not on site.'; render(); return;
  }
  if (['agency_visit', 'hawker_visit'].includes(form) && !t.target_code) {
    DM.err = 'Choose the ' + (form === 'hawker_visit' ? 'hawker' : 'agency') + ' first.'; render(); return;
  }

  DM.busy = '1'; render();
  try {
    const body = {
      form, visit_mode: DM.callMode ? 'call' : 'field',
      ...(geo || {}),
      unit_code: t.unit_code || (DM.ctx.staff && DM.ctx.staff.unit_code),
      target_code: t.target_code || DM.form.centre || null,
      target_name: DM.form.target_name || t.target_name || null,
      target_extra: DM.form.target_extra || t.city || t.centre || null,
      purpose: DM.form.purpose, outcome: DM.form.outcome || DM.extra.outcome,
      remarks: DM.form.remarks,
      amount_collected: DM.form.amount_collected, outstanding_amount: DM.form.outstanding_amount,
      payment_mode: DM.extra.pay_mode, payment_type: DM.extra.pay_type,
      receipt_no: DM.form.receipt_no, copies_committed: DM.form.copies_committed,
      growth_start: DM.form.growth_start, dues_clear_by: DM.form.dues_clear_by,
      next_followup_date: DM.form.next_followup_date,
      check_in: DM.form.check_in, check_out: DM.form.check_out,
      work_type: DM.form.work_type, location: DM.form.location,
      assigned_by: DM.form.assigned_by, attendees: DM.form.attendees, subject: DM.form.subject,
      selfie_id: DM.photo && DM.photo.id ? DM.photo.id : null,
      extra: DM.extra,
    };
    if (form === 'plan_tour') {
      await _dmApi('/tour', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tour_date: DM.form.visit_date || _dmDay(),
          stops: [{ target_type: 'agent', unit_code: t.unit_code, target_code: t.target_code,
            target_name: t.target_name, visit_time: DM.form.check_in, purpose: DM.form.purpose,
            description: DM.form.remarks, outstanding: t.outstanding }] }) });
      toast('Tour plan sent for approval');
    } else {
      const r = await _dmApi('/form', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      toast(r.visit_mode === 'call' ? '📞 Call report saved' : 'Report submitted'
        + (r.geofence && r.geofence.within === 0 ? ` · ${_dmN(r.geofence.distance_m)} m from the registered location` : ''));
    }
    DM.busy = ''; DM.form = {}; DM.extra = {}; DM.photo = null; DM.callMode = false;
    DM.mode = null; DM.targets = null; DM.targetsKey = '';
    await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

window.dmStartTrip = async () => {
  DM.busy = 'trip'; render();
  try { const g = await _dmGeo(true);
    await _dmApi('/trip/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...g, place: 'other' }) });
    DM.busy = ''; toast('Duty started'); await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};
window.dmEndTrip = async () => {
  if (!confirm('End duty and close the day?')) return;
  DM.busy = 'end'; render();
  try { let g = null; try { g = await _dmGeo(true); } catch (_) {}
    const r = await _dmApi('/trip/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g || {}) });
    DM.busy = ''; DM.day = r.summary; DM.mode = 'day';
    toast(`Day closed · ${r.summary.total_visits} entries · ${r.summary.total_km} km`);
    await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

// ── day / team / tours ──────────────────────────────────────────────────────
function _dayView() {
  const d = DM.day;
  if (!d) return _card('<div style="color:#94a3b8">Loading…</div>');
  return _card(_sec('Today') +
    [['Entries', d.total_visits], ['At location', d.valid_visits], ['Outside geofence', d.invalid_visits],
     ['Distance', d.total_km + ' km'], ['Collected', _dmINR(d.collection)]]
      .map(([k, v]) => `<div style="display:flex;justify-content:space-between;font-size:13.5px;padding:9px 0;border-top:1px solid ${C.line}">
        <span style="color:${C.mut}">${k}</span><b style="color:${C.ink}">${v}</b></div>`).join('') +
    `<div style="font-size:10.5px;color:#94a3b8;margin-top:9px">${esc(d.km_method || '')}</div>`) +
    ((d.visits || []).length ? _card(_sec('Entries') + d.visits.map(v => `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-top:1px solid ${C.line}">
        <div style="min-width:0"><div style="font-weight:700;font-size:13.5px;color:${C.ink}">${esc(v.target_name || v.target_type)}</div>
          <div style="font-size:11px;color:${C.mut}">${esc(v.purpose || '')}${v.outcome ? ' · ' + esc(v.outcome) : ''}</div></div>
        <div style="flex:none;text-align:right">${Number(v.amount_collected) > 0 ? _chip(_dmINR(v.amount_collected), 'good') : ''}
          ${v.within_fence === 0 ? _chip('outside', 'warn') : ''}</div></div>`).join('')) : '');
}

function _teamView() {
  const pend = (DM.pending && DM.pending.rows) || [], live = (DM.live && DM.live.rows) || [];
  const st = s => ({ on_visit: ['🟢 on visit', 'good'], travelling: ['🟡 travelling', 'warn'],
    started: ['🔵 started', 'info'], ended: ['⚫ closed', 'mute'], offline: ['⚪ not started', 'mute'] }[s] || [s, 'mute']);
  return (pend.length ? _card(_sec('Tour plans awaiting you') + pend.map(p => `
      <div style="border:1px solid ${C.line};border-radius:11px;padding:12px;margin-bottom:9px">
        <div style="font-weight:700;font-size:13.5px;color:${C.ink}">${esc(p.staff_name)}</div>
        <div style="font-size:11.5px;color:${C.mut}">${String(p.tour_date).slice(0, 10)} · ${p.stops} stops${Number(p.outstanding) > 0 ? ' · ' + _dmINR(p.outstanding) + ' dues' : ''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
          ${_btn('Approve', `dmDecide('${_dmQ(p.staff_person_code)}','${String(p.tour_date).slice(0, 10)}','approve')`, 'ok')}
          ${_btn('Reject', `dmDecide('${_dmQ(p.staff_person_code)}','${String(p.tour_date).slice(0, 10)}','reject')`, 'ghost')}
        </div></div>`).join('')) : '') +
    _card(_sec(`My team today · ${live.length}`) + (live.length ? live.map(m => {
      const [l, tone] = st(m.state);
      return `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px 0;border-top:1px solid ${C.line}">
        <div style="min-width:0"><div style="font-weight:700;font-size:13.5px;color:${C.ink}">${esc(m.name)}</div>
          <div style="font-size:11px;color:${C.mut}">${m.last_target ? esc(m.last_target) : 'no entry yet'}</div></div>
        ${_chip(l, tone)}</div>`; }).join('')
      : `<div style="color:#94a3b8;font-size:13px">Nobody reports to you in the DCR hierarchy.</div>`));
}

window.dmDecide = async (person, date, action) => {
  let reason = null;
  if (action === 'reject') { reason = prompt('Why is this being rejected? The executive will see this.'); if (!reason) return; }
  try { await _dmApi('/tour/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_code: person, tour_date: date, action, reason }) });
    toast(action === 'approve' ? 'Approved' : 'Rejected'); dmOpenTeam();
  } catch (e) { DM.err = e.message; render(); }
};

async function _planList() {
  if (DM.plan) return;
  try { DM.plan = await _dmApi(`/tour?date=${DM.planDate || _dmDay()}`); } catch (e) { DM.plan = { rows: [] }; }
  if (_dmOn()) render();
}
function _planView() {
  _planList();
  const rows = (DM.plan && DM.plan.rows) || [];
  const st = s => ({ submitted: ['awaiting approval', 'warn'], approved: ['approved', 'good'],
    rejected: ['rejected', 'bad'], done: ['visited', 'info'] }[s] || [s, 'mute']);
  return _card(_fld('Date', `<input type="date" value="${DM.planDate || _dmDay()}" onchange="DM.planDate=this.value;DM.plan=null;render()" style="${_IN}">`)) +
    (rows.length ? rows.map(r => { const [l, tone] = st(r.status);
      return _card(`<div style="display:flex;justify-content:space-between;gap:8px"><div style="min-width:0">
        <div style="font-weight:700;font-size:14px;color:${C.ink}">${esc(r.target_name || r.target_code)}</div>
        <div style="font-size:11.5px;color:${C.mut};margin-top:2px">${esc(r.purpose || '')}${r.visit_time ? ' · ' + esc(r.visit_time) : ''}</div>
        ${r.reject_reason ? `<div style="font-size:11.5px;color:#b91c1c;background:#fef2f2;border-radius:8px;padding:7px;margin-top:7px">${esc(r.reject_reason)}</div>` : ''}
      </div>${_chip(l, tone)}</div>`); }).join('')
    : _card(`<div style="text-align:center;color:${C.mut};padding:16px">No tour planned for this date.</div>`));
}

// ── shell ───────────────────────────────────────────────────────────────────
const _TITLES = { plan_tour: 'Plan Tour', agency_visit: 'Agency Visit', center_attn: 'Centre Attendance',
  hawker_visit: 'Hawker Visit', reader_visit: 'Reader Visit', new_area: 'New Area',
  office_work: 'Office / Other Work', day: 'My Day', team: 'My Team', plan_list: 'My Tours' };

VIEWS.dcrm = () => {
  _dmLoad();
  if (DM.loading && !DM.ctx) return `<div style="padding:34px;text-align:center;color:${C.mut}">Loading…</div>`;
  if (!DM.ctx) return `<div style="max-width:560px;margin:0 auto;padding:16px">${_card(
    `<div style="color:#b91c1c;font-weight:700;margin-bottom:5px">Could not open DCR</div>
     <div style="font-size:12.5px;color:${C.mut};margin-bottom:12px">${esc(DM.err || 'Unknown error')}</div>
     ${_btn('Try again', 'dmReload()', 'pri')}`)}</div>`;

  const body =
    DM.mode === null            ? _dmHome()
    : DM.mode === 'plan_tour'   ? _formPlanTour()
    : DM.mode === 'agency_visit'? _formAgencyVisit()
    : DM.mode === 'center_attn' ? _formCentreAttn()
    : DM.mode === 'hawker_visit'? _formHawkerVisit()
    : DM.mode === 'reader_visit'? _formReaderVisit()
    : DM.mode === 'new_area'    ? _formNewArea()
    : DM.mode === 'office_work' ? _formOffice()
    : DM.mode === 'day'         ? _dayView()
    : DM.mode === 'team'        ? _teamView()
    : DM.mode === 'plan_list'   ? _planView()
    : _dmHome();

  const err = DM.err ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:11px;padding:12px;font-size:13px;margin-bottom:12px">
    ${esc(DM.err)} <a onclick="DM.err=null;render()" style="cursor:pointer;text-decoration:underline;margin-left:6px">dismiss</a></div>` : '';

  /* Responsive, not phone-locked: a field executive is on a handset, an incharge
     reviewing the same forms is often on a laptop. */
  return `<div style="max-width:720px;margin:0 auto;padding:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        ${DM.mode !== null ? `<button onclick="dmHome()" style="flex:none;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:10px;padding:9px 12px;font-size:13px;cursor:pointer">←</button>` : ''}
        <div style="min-width:0"><div style="font-size:19px;font-weight:800;color:${C.ink}">${DM.mode === null ? 'DCR Entry' : esc(_TITLES[DM.mode] || 'DCR')}</div>
          <div style="font-size:11.5px;color:${C.mut}">${DM.mode === null ? 'Choose a form to begin' : esc(DM.ctx.staff.name)}</div></div>
      </div>
      <button onclick="go('home')" style="flex:none;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:10px;padding:9px 12px;font-size:12.5px;cursor:pointer">Apps</button>
    </div>
    ${err}${body}
  </div>`;
};
window.dmReload = () => { DM.ctx = null; DM.rights = null; DM.targets = null; _dmLoad(true); };
