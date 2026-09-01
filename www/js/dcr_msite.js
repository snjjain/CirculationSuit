/* ════════════════════════════════════════════════════════════════════════════
   DCR M-Site — the field executive's day, inside the dashboard SSO.

   Loaded after app.js and registers its screens on the shared VIEWS map, so it is
   the same session, the same rights and the same shell — but its own file, because
   app.js is already ~18k lines and this is a self-contained application.

   Designed for a phone held one-handed on a street: one decision per screen, the
   reason to act stated before the action, and thumb-reachable primary buttons.
   The old app asked for ten fields at once and showed "null" where data was
   missing; here a field with nothing to say is simply absent.
   ════════════════════════════════════════════════════════════════════════════ */

const DM = {
  ctx: null, loading: false, err: null,
  tab: 'today',
  targets: null, targetsKey: '', targetType: 'agent', search: '',
  plan: null, planDate: null, planCart: [],
  pending: null, team: null, leads: null,
  visit: null,            // the open visit being reported
  geo: null, geoAt: 0, geoErr: null,
  photo: null,            // { id, dataUrl } for the current visit
  busy: '',
};

/* The M-Site is reachable as app_dcr (launcher card) and as dcrm (direct route), so
   an async load must check both before re-rendering — checking one only left the view
   stuck on "Loading your day…" after the data had already arrived. */
function _dmOnScreen() { return S.screen === 'app_dcr' || String(S.screen || '').startsWith('dcrm'); }

const _dmINR = n => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const _dmN   = n => (Number(n) || 0).toLocaleString('en-IN');
const _dmT   = s => (s ? String(s).slice(11, 16) : '—');
const _dmDay = () => new Date().toISOString().slice(0, 10);
const _dmQ   = v => String(v == null ? '' : v).replace(/'/g, "\\'").replace(/"/g, '&quot;');

async function _dmApi(path, opts) {
  const r = await fetch(`${api.base}/api/dcr-m${path}`, {
    ...(opts || {}),
    headers: { ...api.h(), ...((opts && opts.headers) || {}) },
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!r.ok) throw new Error((j && j.detail) || `Request failed (${r.status})`);
  return j || {};
}

/* GPS is the spine of this app, so it is asked for explicitly and its accuracy is
   shown. A silent fix of unknown quality is worse than no fix — the executive should
   be able to see that the phone is 8 m sure, not 80 m sure, before checking in. */
function _dmGetGeo(force) {
  return new Promise((resolve, reject) => {
    if (!force && DM.geo && Date.now() - DM.geoAt < 30000) return resolve(DM.geo);
    if (!navigator.geolocation) return reject(new Error('This device cannot provide a location.'));
    navigator.geolocation.getCurrentPosition(
      p => {
        DM.geo = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6),
                   accuracy: Math.round(p.coords.accuracy || 0) };
        DM.geoAt = Date.now(); DM.geoErr = null;
        resolve(DM.geo);
      },
      e => { DM.geoErr = e.message || 'Location unavailable'; reject(new Error(DM.geoErr)); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

async function _dmLoad(force) {
  if (DM.loading) return;
  if (DM.ctx && !force) return;
  DM.loading = true; DM.err = null;
  try { DM.ctx = await _dmApi('/context'); }
  catch (e) { DM.err = e.message; }
  DM.loading = false;
  if (_dmOnScreen()) render();
}

// ── shared chrome ───────────────────────────────────────────────────────────
const _dmCard = (inner, style) =>
  `<div style="background:var(--card,#fff);border:1px solid var(--brd2,#e6eaf0);border-radius:14px;padding:14px;margin-bottom:12px;${style || ''}">${inner}</div>`;

const _dmBtn = (label, onclick, kind, extra) => {
  const k = { pri: 'background:#1e3a8a;color:#fff;border:none',
              ok:  'background:#15803d;color:#fff;border:none',
              danger: 'background:#b91c1c;color:#fff;border:none',
              ghost: 'background:#fff;color:#334155;border:1px solid #cbd5e1' }[kind || 'ghost'];
  return `<button onclick="${onclick}" ${extra || ''}
    style="${k};border-radius:11px;padding:13px 16px;font-size:14.5px;font-weight:700;cursor:pointer;width:100%;min-height:48px">${label}</button>`;
};

const _dmChip = (txt, tone) => {
  const t = { good: '#15803d,#dcfce7', warn: '#b45309,#fef3c7', bad: '#b91c1c,#fee2e2',
              info: '#0369a1,#e0f2fe', mute: '#64748b,#f1f5f9' }[tone || 'mute'].split(',');
  return `<span style="font-size:10.5px;font-weight:800;color:${t[0]};background:${t[1]};border-radius:9px;padding:2px 8px;white-space:nowrap">${txt}</span>`;
};

function _dmTabs() {
  const t = [['today', 'Today'], ['plan', 'Tour'], ['visit', 'Visit'], ['more', 'More']];
  const lvl = (S.user && S.user.hierarchyLevel) || 99;
  if (lvl <= 4) t.splice(3, 0, ['team', 'Team']);
  return `<nav style="position:sticky;bottom:0;display:grid;grid-template-columns:repeat(${t.length},1fr);gap:2px;
      background:var(--card,#fff);border-top:1px solid var(--brd2,#e6eaf0);padding:6px 4px;margin:14px -14px -14px">
    ${t.map(([k, l]) => `<button onclick="dmTab('${k}')" style="border:none;background:${DM.tab === k ? '#eef4ff' : 'transparent'};
      color:${DM.tab === k ? '#1e3a8a' : '#64748b'};font-weight:${DM.tab === k ? 800 : 600};font-size:12px;
      padding:9px 4px;border-radius:9px;cursor:pointer">${l}</button>`).join('')}
  </nav>`;
}

window.dmTab = k => { DM.tab = k; DM.err = null; render(); };
window.dmReload = () => { DM.ctx = null; DM.targets = null; DM.plan = null; _dmLoad(true); };

// ── TODAY ───────────────────────────────────────────────────────────────────
function _dmToday() {
  const c = DM.ctx, t = c.trip, a = c.attendance;
  const running = t && t.status === 'active';

  const gps = DM.geo
    ? `<span style="color:${DM.geo.accuracy <= 20 ? '#15803d' : DM.geo.accuracy <= 60 ? '#b45309' : '#b91c1c'}">
         ±${DM.geo.accuracy} m</span>`
    : (DM.geoErr ? `<span style="color:#b91c1c">${esc(DM.geoErr)}</span>` : '<span style="color:#94a3b8">not read yet</span>');

  const head = _dmCard(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div>
        <div style="font-size:17px;font-weight:800;color:var(--ink,#0f172a)">${esc(c.staff.name)}</div>
        <div style="font-size:11.5px;color:#64748b;margin-top:2px">
          ${esc(c.staff.designation || 'Field Executive')}${c.staff.unit_code ? ' · ' + esc(c.staff.unit_code) : ''}
          ${c.staff.emp_code && c.staff.emp_code !== '0' ? ' · ' + esc(c.staff.emp_code) : ''}</div>
      </div>
      ${running ? _dmChip('TRIP RUNNING', 'good') : t ? _dmChip('DAY CLOSED', 'mute') : _dmChip('NOT STARTED', 'warn')}
    </div>
    <div style="font-size:11.5px;color:#64748b;margin-top:8px">GPS ${gps}
      <a onclick="dmRefreshGeo()" style="cursor:pointer;color:#1e3a8a;text-decoration:underline;margin-left:6px">refresh</a></div>`);

  // The four numbers that answer "how is my day going".
  const k = (lbl, val, tone) => `<div style="background:var(--surface-2,#f8fafc);border-radius:11px;padding:10px 8px;text-align:center">
    <div style="font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8">${lbl}</div>
    <div style="font-size:17px;font-weight:800;color:${tone || 'var(--ink,#0f172a)'};margin-top:2px">${val}</div></div>`;
  const kpis = t ? _dmCard(`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px">
      ${k('Visits', t.visits || 0)}
      ${k('Done', t.completed || 0, '#15803d')}
      ${k('Collected', _dmINR(t.collected || 0), '#15803d')}
      ${k('Started', _dmT(t.start_at), '#0369a1')}
    </div>`) : '';

  const action = running
    ? `<div style="display:grid;gap:9px">
        ${_dmBtn('📍 Go to my visits', "dmTab('visit')", 'pri')}
        ${_dmBtn('🏁 End trip &amp; close day', 'dmEndTrip()', 'ghost')}
      </div>`
    : t
      ? _dmCard(`<div style="text-align:center;color:#64748b;font-size:13px">
          Day closed at <b>${_dmT(t.end_at)}</b> · ${t.total_visits || 0} visits · ${t.total_km || 0} km · ${_dmINR(t.collection_amt)}
        </div>`)
      : `<div>
          <div style="font-size:12.5px;color:#64748b;margin-bottom:9px">Start your trip to begin recording visits. Your location is captured once, here.</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:9px">
            ${['home', 'office', 'other'].map(p => `<button onclick="dmStartFrom('${p}')"
              style="border:1px solid ${DM.startPlace === p ? '#1e3a8a' : '#cbd5e1'};background:${DM.startPlace === p ? '#eef4ff' : '#fff'};
              color:#334155;border-radius:10px;padding:10px 4px;font-size:12.5px;font-weight:700;cursor:pointer;text-transform:capitalize">${p}</button>`).join('')}
          </div>
          ${_dmBtn(DM.busy === 'trip' ? 'Starting…' : '▶ Start trip', 'dmStartTrip()', 'ok', DM.busy === 'trip' ? 'disabled' : '')}
        </div>`;

  // Centre attendance — only meaningful for hawker/centre staff, so it is offered
  // rather than imposed, and states the 50 m rule before it is enforced.
  const attn = a
    ? _dmCard(`<div style="display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-size:12px;font-weight:800;color:#15803d">✓ Attendance marked</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">${esc(a.centre_name || a.centre_code || '')} · ${_dmT(a.marked_at)}
          ${a.distance_m != null ? ` · ${a.distance_m} m away` : ''}</div></div>
        ${a.within_fence === 0 ? _dmChip('OUTSIDE', 'warn') : _dmChip('IN AREA', 'good')}
      </div>`)
    : _dmCard(`<div style="font-size:12.5px;font-weight:700;margin-bottom:3px">Centre attendance</div>
        <div style="font-size:11.5px;color:#64748b;margin-bottom:9px">Mark at your cash-sale centre. You must be within 50 m of it.</div>
        ${_dmBtn(DM.busy === 'attn' ? 'Marking…' : '🏢 Mark attendance', 'dmMarkAttn()', 'ghost', DM.busy === 'attn' ? 'disabled' : '')}`);

  return head + kpis + _dmCard(action) + attn;
}

window.dmRefreshGeo = async () => {
  try { await _dmGetGeo(true); } catch (_) {}
  render();
};
window.dmStartFrom = p => { DM.startPlace = p; render(); };

window.dmStartTrip = async () => {
  DM.busy = 'trip'; DM.err = null; render();
  try {
    const g = await _dmGetGeo(true);
    await _dmApi('/trip/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...g, place: DM.startPlace || 'other' }) });
    DM.busy = ''; toast('Trip started — have a good day');
    await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

window.dmEndTrip = async () => {
  if (!confirm('End the trip and close today? You will not be able to record more visits today.')) return;
  DM.busy = 'end'; render();
  try {
    let g = null; try { g = await _dmGetGeo(true); } catch (_) {}
    const r = await _dmApi('/trip/end', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g || {}) });
    DM.busy = ''; DM.dayClose = r.summary; DM.tab = 'today';
    toast(`Day closed · ${r.summary.total_visits} visits · ${r.summary.total_km} km`);
    await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

window.dmMarkAttn = async () => {
  const name = prompt('Which centre are you at?');
  if (!name) return;
  DM.busy = 'attn'; render();
  try {
    const g = await _dmGetGeo(true);
    await _dmApi('/attendance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...g, centre_name: name, centre_code: name.trim().toUpperCase() }) });
    DM.busy = ''; toast('Attendance marked'); await _dmLoad(true);
  } catch (e) {
    DM.busy = '';
    // Outside the fence the server asks for a reason rather than refusing outright.
    if (/within/.test(e.message)) {
      const why = prompt(`${e.message}\n\nWhy are you marking from here?`);
      if (why) {
        try {
          const g = await _dmGetGeo(true);
          await _dmApi('/attendance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...g, centre_name: name, centre_code: name.trim().toUpperCase(), override_reason: why }) });
          toast('Attendance marked with reason'); await _dmLoad(true); return;
        } catch (e2) { DM.err = e2.message; }
      }
    } else DM.err = e.message;
    render();
  }
};

// ── VISIT: worklist → check-in → report → check-out ─────────────────────────
async function _dmLoadTargets() {
  const key = `${DM.targetType}|${DM.search}`;
  if (DM.targetsKey === key && DM.targets) return;
  DM.targetsKey = key;
  try {
    const r = await _dmApi(`/targets?type=${DM.targetType}&limit=40${DM.search ? '&q=' + encodeURIComponent(DM.search) : ''}`);
    DM.targets = r.rows || [];
  } catch (e) { DM.targets = []; DM.err = e.message; }
  if (_dmOnScreen()) render();
}

function _dmVisitTab() {
  const c = DM.ctx;
  if (!c.trip || c.trip.status !== 'active') {
    return _dmCard(`<div style="text-align:center;padding:14px">
      <div style="font-size:30px;margin-bottom:6px">🚦</div>
      <div style="font-weight:800;margin-bottom:4px">Start your trip first</div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:12px">Visits are recorded against a trip, so the day's route and kilometres add up.</div>
      ${_dmBtn('Go to Today', "dmTab('today')", 'pri')}</div>`);
  }
  if (DM.visit) return _dmVisitReport();

  _dmLoadTargets();
  const seg = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
    ${['agent', 'hawker'].map(t => `<button onclick="dmType('${t}')"
      style="border:1px solid ${DM.targetType === t ? '#1e3a8a' : '#cbd5e1'};background:${DM.targetType === t ? '#1e3a8a' : '#fff'};
      color:${DM.targetType === t ? '#fff' : '#334155'};border-radius:10px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;text-transform:capitalize">${t === 'agent' ? 'Agencies' : 'Hawkers'}</button>`).join('')}
  </div>
  <input value="${esc(DM.search)}" oninput="dmSearch(this.value)" placeholder="Search by name or code…"
    style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;margin-bottom:11px;box-sizing:border-box">`;

  if (!DM.targets) return _dmCard(seg + '<div style="color:#94a3b8;font-size:13px;padding:8px">Loading…</div>');

  /* The list leads with WHY this stop matters — dues, ageing, last outcome — because
     an executive picking the next call is choosing on reason, not on name. */
  const rows = DM.targets.map(r => {
    const os = Number(r.outstanding) || 0;
    const never = !r.last_visit;
    return `<div onclick="dmCheckIn('${_dmQ(r.target_code)}','${_dmQ(r.unit_code)}','${_dmQ(r.target_name || r.target_code)}')"
      style="border:1px solid var(--brd2,#e6eaf0);border-radius:12px;padding:12px;margin-bottom:8px;cursor:pointer;background:var(--card,#fff)">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;font-size:14px;color:var(--ink,#0f172a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.target_name || r.target_code)}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">${esc(r.city || r.centre || '')}${r.station ? ' · ' + esc(r.station) : ''}</div>
        </div>
        ${os > 100000 ? _dmChip(_dmINR(os), 'bad') : os > 0 ? _dmChip(_dmINR(os), 'warn') : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${r.avg_copies ? _dmChip(_dmN(r.avg_copies) + ' cp/day', 'info') : ''}
        ${never ? _dmChip('never visited', 'warn') : _dmChip('last ' + String(r.last_visit).slice(0, 10), 'mute')}
        ${r.payment_nature && /defaul/i.test(r.payment_nature) ? _dmChip('DEFAULTER', 'bad') : ''}
        ${r.loc_source ? '' : _dmChip('location will be registered', 'mute')}
      </div>
    </div>`;
  }).join('');

  return _dmCard(seg) +
    (rows || `<div style="color:#94a3b8;font-size:13px;padding:14px;text-align:center">Nothing matched. Try a name or code.</div>`);
}

window.dmType = t => { DM.targetType = t; DM.targets = null; DM.targetsKey = ''; render(); };
let _dmSearchT = null;
window.dmSearch = v => {
  DM.search = v;
  clearTimeout(_dmSearchT);
  _dmSearchT = setTimeout(() => { DM.targets = null; DM.targetsKey = ''; render(); }, 350);
};

window.dmCheckIn = async (code, unit, name) => {
  DM.busy = 'in'; DM.err = null; render();
  try {
    const g = await _dmGetGeo(true);
    const r = await _dmApi('/visit/check-in', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: DM.targetType, unit_code: unit, target_code: code, target_name: name, ...g }) });
    DM.visit = { id: r.visit_id, name, code, unit, geofence: r.geofence || {}, at: Date.now() };
    DM.photo = null; DM.busy = '';
    render();
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

const DM_PURPOSE = ['Recovery', 'Growth', 'Supply discussion', 'Copy increase', 'Complaint',
  'Relationship visit', 'New business', 'Market survey', 'Reader feedback', 'Payment follow-up', 'Other'];
const DM_OUTCOME = ['Payment collected', 'Promise to pay', 'No payment', 'Copies increased',
  'Copies decreased', 'New customer opportunity', 'Complaint resolved', 'Complaint pending',
  'Growth opportunity identified', 'Customer unavailable', 'Shop closed', 'Other'];
const DM_NEXT = ['No further action', 'Payment follow-up', 'Growth follow-up', 'Complaint follow-up'];

function _dmVisitReport() {
  const v = DM.visit, gf = v.geofence || {};
  const mins = Math.max(0, Math.round((Date.now() - v.at) / 60000));

  const fence = gf.within === 1
    ? _dmChip(`✓ at location · ${gf.distance_m} m`, 'good')
    : gf.within === 0
      ? _dmChip(`⚠ ${_dmN(gf.distance_m)} m away`, 'bad')
      : _dmChip('location recorded', 'info');

  const sel = (id, opts, ph) => `<select id="${id}" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;background:#fff;margin-bottom:9px;box-sizing:border-box">
    <option value="">${ph}</option>${opts.map(o => `<option>${o}</option>`).join('')}</select>`;

  return _dmCard(`
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px">
      <div style="font-size:16px;font-weight:800;color:var(--ink,#0f172a);min-width:0">${esc(v.name)}</div>
      ${_dmChip(mins + ' min', 'mute')}
    </div>
    <div style="margin-bottom:10px">${fence}
      ${gf.note ? `<div style="font-size:11px;color:#b45309;margin-top:5px">${esc(gf.note)}</div>` : ''}</div>

    ${DM.photo
      ? `<div style="position:relative;margin-bottom:10px">
           <img src="${DM.photo.dataUrl}" style="width:100%;border-radius:11px;display:block">
           <button onclick="dmClearPhoto()" style="position:absolute;top:7px;right:7px;border:none;background:rgba(15,23,42,.72);color:#fff;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer">Retake</button>
         </div>`
      : `<label style="display:block;border:1.5px dashed #cbd5e1;border-radius:12px;padding:16px;text-align:center;color:#64748b;font-size:13px;cursor:pointer;margin-bottom:10px">
           📷 Take a photo with the ${DM.targetType === 'hawker' ? 'hawker' : 'agent'}
           <input type="file" accept="image/*" capture="environment" onchange="dmPhoto(this)" style="display:none">
         </label>`}

    ${sel('dmPurpose', DM_PURPOSE, 'Purpose of visit')}
    ${sel('dmOutcome', DM_OUTCOME, 'What happened')}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px">
      <input id="dmAmt" type="number" inputmode="decimal" placeholder="Amount collected"
        style="padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;box-sizing:border-box">
      <select id="dmMode" style="padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;background:#fff;box-sizing:border-box">
        <option value="">Mode</option><option>Cash</option><option>UPI</option><option>Cheque</option><option>Bank transfer</option>
      </select>
    </div>
    <input id="dmReceipt" placeholder="Receipt number (if issued)"
      style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;margin-bottom:9px;box-sizing:border-box">
    <input id="dmCopies" type="number" inputmode="numeric" placeholder="Copies committed (if any)"
      style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;margin-bottom:9px;box-sizing:border-box">
    <textarea id="dmRemarks" rows="3" placeholder="Remarks — what was discussed, what was agreed"
      style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;margin-bottom:9px;box-sizing:border-box;font-family:inherit"></textarea>

    ${sel('dmNext', DM_NEXT, 'Next action')}
    <input id="dmNextDate" type="date" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;margin-bottom:12px;box-sizing:border-box">

    <div style="display:grid;gap:8px">
      ${_dmBtn(DM.busy === 'out' ? 'Saving…' : '✓ Complete visit', 'dmCheckOut()', 'ok', DM.busy === 'out' ? 'disabled' : '')}
      ${_dmBtn('Cancel — keep visit open', 'dmCancelReport()', 'ghost')}
    </div>`);
}

window.dmClearPhoto = () => { DM.photo = null; render(); };
window.dmCancelReport = () => { DM.visit = null; render(); };

/* Compress on the device before upload. A modern phone camera produces 3-5 MB, which
   on field 4G is a slow upload and a wasted row; 1280 px at q0.72 is ~120 KB and still
   clearly identifies a person and a shopfront. */
window.dmPhoto = async (input) => {
  const f = input.files && input.files[0];
  if (!f) return;
  try {
    const dataUrl = await new Promise((res, rej) => {
      const img = new Image(), fr = new FileReader();
      fr.onload = () => { img.onload = () => {
        const max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', 0.72));
      }; img.onerror = rej; img.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(f);
    });
    DM.photo = { dataUrl, uploading: true }; render();
    const blob = await (await fetch(dataUrl)).blob();
    const g = DM.geo || {};
    const r = await fetch(`${api.base}/api/dcr-m/photo?kind=selfie&visit_id=${DM.visit ? DM.visit.id : ''}&lat=${g.lat || ''}&lng=${g.lng || ''}`,
      { method: 'POST', headers: { ...api.h(), 'Content-Type': 'image/jpeg' }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || 'Upload failed');
    DM.photo = { dataUrl, id: j.photo_id };
    if (j.duplicate_of) toast('⚠ This photo was uploaded before — it has been flagged.');
    render();
  } catch (e) { DM.photo = null; DM.err = e.message; render(); }
};

window.dmCheckOut = async () => {
  const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const purpose = g('dmPurpose'), outcome = g('dmOutcome');
  if (!purpose || !outcome) { DM.err = 'Purpose and outcome are needed before completing the visit.'; render(); return; }
  DM.busy = 'out'; DM.err = null; render();
  try {
    let geo = null; try { geo = await _dmGetGeo(true); } catch (_) {}
    await _dmApi('/visit/check-out', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visit_id: DM.visit.id, ...(geo || {}),
        purpose, outcome, remarks: g('dmRemarks'),
        amount_collected: g('dmAmt') || null, payment_mode: g('dmMode') || null,
        receipt_no: g('dmReceipt') || null, copies_committed: g('dmCopies') || null,
        next_action: g('dmNext') || null, next_followup_date: g('dmNextDate') || null,
        selfie_id: DM.photo && DM.photo.id ? DM.photo.id : null,
      }) });
    DM.visit = null; DM.photo = null; DM.busy = ''; DM.targets = null; DM.targetsKey = '';
    toast('Visit recorded');
    await _dmLoad(true);
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

// ── TOUR PLAN ───────────────────────────────────────────────────────────────
async function _dmLoadPlan() {
  const d = DM.planDate || _dmDay();
  if (DM.plan && DM.plan.date === d) return;
  try { DM.plan = await _dmApi(`/tour?date=${d}`); }
  catch (e) { DM.plan = { date: d, rows: [] }; DM.err = e.message; }
  if (_dmOnScreen()) render();
}

function _dmPlanTab() {
  _dmLoadPlan();
  const d = DM.planDate || _dmDay();
  const rows = (DM.plan && DM.plan.rows) || [];

  const head = _dmCard(`
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <input type="date" value="${d}" onchange="dmPlanDate(this.value)"
        style="flex:1;padding:11px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;box-sizing:border-box">
    </div>
    ${_dmBtn('+ Plan a tour for this date', 'dmPlanNew()', 'pri')}`);

  if (!rows.length) {
    return head + _dmCard(`<div style="text-align:center;color:#64748b;padding:16px">
      <div style="font-size:28px;margin-bottom:6px">🗺️</div>
      <div style="font-weight:700;color:var(--ink,#0f172a);margin-bottom:3px">No tour planned</div>
      <div style="font-size:12.5px">Plan the stops you intend to cover, or your incharge can assign them to you.</div></div>`);
  }

  const st = s => ({ submitted: ['awaiting approval', 'warn'], approved: ['approved', 'good'],
                     rejected: ['rejected', 'bad'], done: ['visited', 'info'], planned: ['draft', 'mute'] }[s] || [s, 'mute']);
  return head + rows.map((r, i) => {
    const [lbl, tone] = st(r.status);
    const canGo = r.status === 'approved' && DM.ctx.trip && DM.ctx.trip.status === 'active';
    return _dmCard(`
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;color:#94a3b8;font-weight:700">STOP ${r.seq_no || i + 1}${r.visit_time ? ' · ' + esc(r.visit_time) : ''}</div>
          <div style="font-weight:700;font-size:14.5px;margin-top:2px">${esc(r.target_name || r.target_code)}</div>
          <div style="font-size:11.5px;color:#64748b;margin-top:2px">${esc(r.purpose || '')}</div>
        </div>
        ${_dmChip(lbl, tone)}
      </div>
      ${r.reject_reason ? `<div style="font-size:11.5px;color:#b91c1c;background:#fef2f2;border-radius:9px;padding:8px;margin-top:8px">${esc(r.reject_reason)}</div>` : ''}
      ${r.assigned_by_name ? `<div style="font-size:11px;color:#64748b;margin-top:6px">Assigned by ${esc(r.assigned_by_name)}</div>` : ''}
      ${canGo ? `<div style="margin-top:9px">${_dmBtn('📍 Check in here', `dmCheckIn('${_dmQ(r.target_code)}','${_dmQ(r.unit_code)}','${_dmQ(r.target_name || r.target_code)}')`, 'pri')}</div>` : ''}`);
  }).join('');
}

window.dmPlanDate = v => { DM.planDate = v; DM.plan = null; render(); };

/* Planning is building a list, so it reuses the visit worklist rather than a second
   search screen: pick from the same reason-first list, then submit the lot. */
window.dmPlanNew = () => {
  DM.planCart = []; DM.tab = 'plancart'; DM.targets = null; DM.targetsKey = ''; render();
};
window.dmPlanAdd = (code, unit, name, os) => {
  if (DM.planCart.some(x => x.target_code === code && x.unit_code === unit)) {
    DM.planCart = DM.planCart.filter(x => !(x.target_code === code && x.unit_code === unit));
  } else {
    DM.planCart.push({ target_code: code, unit_code: unit, target_name: name,
      target_type: DM.targetType, outstanding: Number(os) || 0 });
  }
  render();
};
window.dmPlanSubmit = async () => {
  if (!DM.planCart.length) return;
  const forWhom = DM.planFor || null;
  DM.busy = 'plan'; render();
  try {
    const r = await _dmApi('/tour', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tour_date: DM.planDate || _dmDay(), stops: DM.planCart,
        for_person_code: forWhom }) });
    DM.busy = ''; DM.planCart = []; DM.plan = null; DM.tab = 'plan';
    toast(r.assigned ? `Assigned ${r.stops} stops` : `${r.stops} stops sent for approval`);
    render();
  } catch (e) { DM.busy = ''; DM.err = e.message; render(); }
};

function _dmPlanCartTab() {
  _dmLoadTargets();
  const chosen = new Set(DM.planCart.map(x => x.unit_code + '|' + x.target_code));
  const seg = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:9px">
    ${['agent', 'hawker'].map(t => `<button onclick="dmType('${t}')"
      style="border:1px solid ${DM.targetType === t ? '#1e3a8a' : '#cbd5e1'};background:${DM.targetType === t ? '#1e3a8a' : '#fff'};
      color:${DM.targetType === t ? '#fff' : '#334155'};border-radius:10px;padding:9px;font-size:13px;font-weight:700;cursor:pointer">${t === 'agent' ? 'Agencies' : 'Hawkers'}</button>`).join('')}
  </div>
  <input value="${esc(DM.search)}" oninput="dmSearch(this.value)" placeholder="Search…"
    style="width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;box-sizing:border-box">`;

  const list = (DM.targets || []).map(r => {
    const on = chosen.has(r.unit_code + '|' + r.target_code);
    return `<div onclick="dmPlanAdd('${_dmQ(r.target_code)}','${_dmQ(r.unit_code)}','${_dmQ(r.target_name || r.target_code)}',${Number(r.outstanding) || 0})"
      style="border:1.5px solid ${on ? '#1e3a8a' : 'var(--brd2,#e6eaf0)'};background:${on ? '#eef4ff' : 'var(--card,#fff)'};
      border-radius:11px;padding:11px;margin-bottom:7px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center">
      <div style="min-width:0"><div style="font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.target_name || r.target_code)}</div>
        <div style="font-size:11px;color:#64748b">${esc(r.city || r.centre || '')}</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex:none">
        ${Number(r.outstanding) > 0 ? _dmChip(_dmINR(r.outstanding), Number(r.outstanding) > 100000 ? 'bad' : 'warn') : ''}
        <span style="font-size:17px;color:${on ? '#1e3a8a' : '#cbd5e1'}">${on ? '☑' : '☐'}</span></div>
    </div>`;
  }).join('');

  const team = (DM.team && DM.team.rows) || [];
  const assign = team.length ? _dmCard(`
    <div style="font-size:12px;font-weight:800;margin-bottom:6px">Plan for</div>
    <select onchange="DM.planFor=this.value||null"
      style="width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:11px;font-size:14px;background:#fff;box-sizing:border-box">
      <option value="">Myself</option>
      ${team.map(t => `<option value="${esc(t.person_code)}">${esc(t.person_name)}</option>`).join('')}
    </select>
    <div style="font-size:11px;color:#64748b;margin-top:6px">A tour you assign is approved already. Your own goes to your incharge.</div>`) : '';

  return _dmCard(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-weight:800;font-size:15px">Build tour · ${DM.planDate || _dmDay()}</div>
      <a onclick="dmTab('plan')" style="cursor:pointer;color:#64748b;font-size:12.5px;text-decoration:underline">cancel</a>
    </div>${seg}`) + assign +
    (list || '<div style="color:#94a3b8;font-size:13px;padding:12px;text-align:center">Loading…</div>') +
    (DM.planCart.length ? `<div style="position:sticky;bottom:56px;padding-top:8px">
      ${_dmBtn(DM.busy === 'plan' ? 'Saving…' : `Submit ${DM.planCart.length} stop${DM.planCart.length > 1 ? 's' : ''}`,
        'dmPlanSubmit()', 'ok', DM.busy === 'plan' ? 'disabled' : '')}</div>` : '');
}

// ── TEAM (incharge) ─────────────────────────────────────────────────────────
async function _dmLoadTeam() {
  if (DM.team && DM.pending) return;
  try {
    const [t, p, l] = await Promise.all([_dmApi('/team'), _dmApi('/tour/pending'), _dmApi('/team-live')]);
    DM.team = t; DM.pending = p; DM.live = l;
  } catch (e) { DM.err = e.message; DM.team = { rows: [] }; DM.pending = { rows: [] }; }
  if (_dmOnScreen()) render();
}

function _dmTeamTab() {
  _dmLoadTeam();
  if (!DM.team) return _dmCard('<div style="color:#94a3b8;padding:10px">Loading team…</div>');
  const pend = (DM.pending && DM.pending.rows) || [];
  const live = (DM.live && DM.live.rows) || [];

  const approvals = pend.length ? _dmCard(`
    <div style="font-weight:800;font-size:14px;margin-bottom:3px">Tour plans awaiting you</div>
    <div style="font-size:11.5px;color:#64748b;margin-bottom:10px">Approving releases the plan so the executive can check in against it.</div>
    ${pend.map(p => `<div style="border:1px solid var(--brd2,#e6eaf0);border-radius:11px;padding:11px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div><div style="font-weight:700;font-size:13.5px">${esc(p.staff_name)}</div>
          <div style="font-size:11.5px;color:#64748b">${String(p.tour_date).slice(0, 10)} · ${p.stops} stops
            ${Number(p.outstanding) > 0 ? ' · ' + _dmINR(p.outstanding) + ' dues' : ''}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px">
        ${_dmBtn('Approve', `dmDecide('${_dmQ(p.staff_person_code)}','${String(p.tour_date).slice(0, 10)}','approve')`, 'ok')}
        ${_dmBtn('Reject', `dmDecide('${_dmQ(p.staff_person_code)}','${String(p.tour_date).slice(0, 10)}','reject')`, 'ghost')}
      </div></div>`).join('')}`) : '';

  const stateChip = s => ({ on_visit: ['🟢 on visit', 'good'], travelling: ['🟡 travelling', 'warn'],
    started: ['🔵 started', 'info'], ended: ['⚫ day closed', 'mute'], offline: ['⚪ not started', 'mute'] }[s] || [s, 'mute']);

  const board = _dmCard(`
    <div style="font-weight:800;font-size:14px;margin-bottom:10px">My team today · ${live.length}</div>
    ${live.length ? live.map(m => {
      const [lbl, tone] = stateChip(m.state);
      return `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px 0;border-top:1px solid var(--brd2,#eef2f7)">
        <div style="min-width:0"><div style="font-weight:700;font-size:13.5px">${esc(m.name)}</div>
          <div style="font-size:11px;color:#64748b">${m.last_target ? esc(m.last_target) : (m.started_at ? 'started ' + _dmT(m.started_at) : 'no trip today')}</div></div>
        ${_dmChip(lbl, tone)}</div>`;
    }).join('') : '<div style="color:#94a3b8;font-size:13px">Nobody reports to you in the DCR hierarchy.</div>'}`);

  return approvals + board;
}

window.dmDecide = async (person, date, action) => {
  let reason = null;
  if (action === 'reject') {
    reason = prompt('Why is this tour plan being rejected? The executive will see this.');
    if (!reason) return;                       // the server requires it too
  }
  try {
    await _dmApi('/tour/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_code: person, tour_date: date, action, reason }) });
    DM.pending = null; DM.team = null;
    toast(action === 'approve' ? 'Tour approved' : 'Tour rejected');
    _dmLoadTeam();
  } catch (e) { DM.err = e.message; render(); }
};

// ── MORE ────────────────────────────────────────────────────────────────────
function _dmMoreTab() {
  const c = DM.ctx;
  return _dmCard(`<div style="font-weight:800;font-size:14px;margin-bottom:10px">Day close</div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:10px">See the day's totals before you end the trip.</div>
      ${_dmBtn('📋 View day summary', 'dmDayClose()', 'ghost')}`) +
    _dmCard(`<div style="font-weight:800;font-size:14px;margin-bottom:8px">New lead</div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:10px">A new agency, hawker, area or reader spotted in the field.</div>
      ${_dmBtn('+ Record a lead', 'dmLeadNew()', 'ghost')}`) +
    (DM.dayClose ? _dmCard(`
      <div style="font-weight:800;font-size:14px;margin-bottom:9px">Today</div>
      ${[['Visits', DM.dayClose.total_visits], ['Valid (at location)', DM.dayClose.valid_visits],
         ['Outside geofence', DM.dayClose.invalid_visits], ['Distance', DM.dayClose.total_km + ' km'],
         ['Collected', _dmINR(DM.dayClose.collection)]]
        .map(([k, v]) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-top:1px solid var(--brd2,#eef2f7)">
          <span style="color:#64748b">${k}</span><b>${v}</b></div>`).join('')}
      <div style="font-size:10.5px;color:#94a3b8;margin-top:8px">${esc(DM.dayClose.km_method || '')}</div>`) : '') +
    _dmCard(`<div style="font-size:11.5px;color:#64748b">Signed in as <b>${esc(c.staff.name)}</b>
      ${c.staff.emp_code && c.staff.emp_code !== '0' ? ' · ' + esc(c.staff.emp_code) : ''}</div>`);
}

window.dmDayClose = async () => {
  try { DM.dayClose = await _dmApi('/day-close'); toast('Summary updated'); render(); }
  catch (e) { DM.err = e.message; render(); }
};

window.dmLeadNew = async () => {
  const type = prompt('Lead type — New Agent / New Hawker / New Area / New Reader / Additional Copies');
  if (!type) return;
  const name = prompt('Name');
  if (!name) return;
  const mobile = prompt('Mobile (optional)') || null;
  const copies = prompt('Potential copies (optional)') || null;
  try {
    let g = null; try { g = await _dmGetGeo(false); } catch (_) {}
    await _dmApi('/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_type: type, name, mobile, potential_copies: copies,
        visit_id: DM.visit ? DM.visit.id : null, ...(g || {}) }) });
    toast('Lead recorded');
  } catch (e) { DM.err = e.message; render(); }
};

// ── shell ───────────────────────────────────────────────────────────────────
VIEWS.dcrm = () => {
  _dmLoad();
  if (DM.loading && !DM.ctx) {
    return `<div style="padding:30px;text-align:center;color:#64748b">Loading your day…</div>`;
  }
  if (!DM.ctx) {
    return `<div style="padding:22px">${_dmCard(`<div style="color:#b91c1c;font-weight:700;margin-bottom:5px">Could not open DCR</div>
      <div style="font-size:12.5px;color:#64748b">${esc(DM.err || 'Unknown error')}</div>
      <div style="margin-top:12px">${_dmBtn('Try again', 'dmReload()', 'pri')}</div>`)}</div>`;
  }

  const err = DM.err ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:11px;padding:11px;font-size:12.5px;margin-bottom:11px">
      ${esc(DM.err)} <a onclick="DM.err=null;render()" style="cursor:pointer;text-decoration:underline;margin-left:6px">dismiss</a></div>` : '';

  const body =
    DM.tab === 'today'     ? _dmToday()
    : DM.tab === 'visit'   ? _dmVisitTab()
    : DM.tab === 'plan'    ? _dmPlanTab()
    : DM.tab === 'plancart'? _dmPlanCartTab()
    : DM.tab === 'team'    ? _dmTeamTab()
    : _dmMoreTab();

  /* Constrained to phone width even on a desktop: this is a field tool, and a form
     stretched across a 27-inch monitor is harder to use, not easier. */
  return `<div style="max-width:520px;margin:0 auto;padding:14px 14px 0">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div><div style="font-size:19px;font-weight:800;color:var(--ink,#0f172a)">DCR</div>
        <div style="font-size:11.5px;color:#64748b">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</div></div>
      <button onclick="go('home')" style="border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:10px;padding:8px 12px;font-size:12.5px;cursor:pointer">← Apps</button>
    </div>
    ${err}${body}${_dmTabs()}
  </div>`;
};
