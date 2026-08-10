/* ═══════════ Patrika Vitran Suite — SPA ═══════════ */
"use strict";

/* ---------- navigation model (menus & submenus from both references) ---------- */
const DASH_MENU = [
  ["command",     "Command Centre",        "📊"],
  ["ai_insights", "AI Insights & Actions", "🤖"],
  ["supply_dash", "Supply Dashboard",      "📦"],
  ["collections", "Collections",         "₹"],
  ["outstanding",   "Agency Outstanding",  "💰"],
  ["short_payment", "Short Payment",      "📋"],
  ["transport",     "Taxi Dashboard",     "🚕"],
  ["survey_dash", "Survey Intelligence", "📊"],
];

const APP_MENU = {
  agent:  { label: "Agent App",   icon: "🏢", tint: "var(--red-l)",   desc: "Agency management — supply, billing, collections and complaints.",
            sub: [["agent_day", "My Day"], ["agent_supply", "Supply & Net Sales"], ["agent_ledger", "Bills & Ledger"], ["agent_complaints", "Complaints"]] },
  hawker: { label: "Hawker App",  icon: "🛵", tint: "var(--teal-l)",  desc: "Delivery run, reader database, collections and earnings.",
            sub: [["hawker_day", "My Day"], ["hawker_route", "My Route"], ["hawker_readers", "My Readers"], ["hawker_collect", "Collect"], ["hawker_earn", "Earnings"]] },
  dcr:    { label: "DCR Forms",   icon: "📋", tint: "var(--gold-l)",  desc: "Daily Collection Register — attendance, visit entry and day report.",
            sub: [["dcr_att", "Attendance"], ["dcr_visit", "Visit Entry"], ["dcr_report", "Day Report"]] },
  survey: { label: "Survey Form", icon: "📝", tint: "var(--grn-l)",   desc: "Field lead capture with GPS, paper selection and instant submission.",
            sub: [["survey_new", "New Survey"], ["survey_leads", "My Leads"]] },
  taxi:   { label: "Taxi Fleet",  icon: "🚕", tint: "var(--blue-l)",  desc: "Fleet & dispatch — trips, trip logging and vehicle compliance.",
            sub: [["taxi_trips", "Today's Trips"], ["taxi_log", "Log Trip"], ["taxi_vehicles", "Vehicles"]] }
};

/* ---------- state & persistence ---------- */
let S = { user: null, screen: "home", openGroups: {}, sideOpen: false, drill: {}, live: {}, range: null };
const $ = s => document.querySelector(s);

/* ---------- default dashboard date range: 1st of current month → today ---------- */
function _pad2(n) { return String(n).padStart(2, "0"); }
function todayISO()      { const d = new Date(); return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate()); }
function monthStartISO()  { const d = new Date(); return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-01"; }
function defaultRange()  { return { from: monthStartISO(), to: todayISO() }; }

/* ---------- date-range filter (null = latest day) ---------- */
function rangeQS(path) {
  if (!S.range) return path;
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "from=" + S.range.from + "&to=" + S.range.to;
}
function resetLiveData() {
  const dbUsers = S.live.dbUsers; // keep user list — not date-dependent
  S.live = { dbUsers };
}
window.applyDateRange = () => {
  const f = document.getElementById("dr-from")?.value;
  const t = document.getElementById("dr-to")?.value;
  if (!f || !t) { toast("Select both From and To dates"); return; }
  S.range = f <= t ? { from: f, to: t } : { from: t, to: f };
  resetLiveData();
  render();
};
window.clearDateRange = () => {
  S.range = null;
  resetLiveData();
  render();
};

/* ---------- REST API client (port 8001) — JWT bearer auth ---------- */
let AUTH_TOKEN = null;   // set on login / restore; sent as Authorization: Bearer
const api = {
  base: "http://localhost:8001",
  h() {
    const h = { "Content-Type": "application/json" };
    if (AUTH_TOKEN) h["Authorization"] = "Bearer " + AUTH_TOKEN;
    return h;   // identity/scope is derived server-side from the verified token, not client headers
  },
  async post(path, body) {
    try {
      const r = await fetch(this.base + path, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
      if (r.status === 401) { onAuthExpired(); return null; }
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },
  async get(path) {
    try {
      const r = await fetch(this.base + path, { headers: this.h() });
      if (r.status === 401) { onAuthExpired(); return null; }
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
};
/* Raw call that preserves status + error detail (used by admin screens; supports PATCH) */
async function apiCall(method, path, body) {
  try {
    const opt = { method, headers: api.h() };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(api.base + path, opt);
    if (r.status === 401) { onAuthExpired(); return { ok: false, detail: "Session expired" }; }
    const j = await r.json().catch(() => null);
    return Object.assign({ ok: r.ok, status: r.status }, j || {});
  } catch { return { ok: false, detail: "Cannot reach the server" }; }
}
/* Read a form field value by element id */
function gv(id) { const e = document.getElementById(id); return e ? String(e.value).trim() : ""; }

/* ---------- live dashboard data fetch ---------- */
async function fetchDashboard() {
  if (S.live._loading) return;
  S.live._loading = true;
  const txDate = S.live.txFilterDate;
  const url = txDate ? `/api/dashboard/delivery?from=${txDate}&to=${txDate}` : rangeQS("/api/dashboard/delivery");
  const data = await api.get(url);
  if (data) S.live.delivery = data;
  S.live._loading = false;
  if (S.screen === "command" || S.screen === "transport") render();
}
async function fetchRoutes(unitName) {
  const txDate = S.live.txFilterDate;
  const key = "routes_" + unitName + (txDate ? "_" + txDate : "");
  if (S.live[key]) return;
  const base = "/api/dashboard/routes?unit_name=" + encodeURIComponent(unitName);
  const url = txDate ? base + "&date=" + txDate : rangeQS(base);
  const data = await api.get(url);
  if (data) S.live[key] = data;
  if (S.screen === "drill" || S.screen === "transport") render();
}
async function fetchHierarchyUsers() {
  if (S.live._usersLoading || S.live.dbUsers) return;
  S.live._usersLoading = true;
  const data = await api.get("/api/hierarchy/users");
  if (data && data.users) S.live.dbUsers = data.users;
  S.live._usersLoading = false;
  if (!S.user || S.screen === 'manage_rights') render();
}
async function fetchDropPoints(routeCode, subRouteName) {
  const txDate = S.live.txFilterDate;
  const key = (txDate ? txDate + "_" : "") + "dp_" + routeCode + (subRouteName ? "|" + subRouteName : "");
  if (S.live[key]) return;
  let url = txDate
    ? `/api/dashboard/drop-points?route_code=${encodeURIComponent(routeCode)}&from=${txDate}&to=${txDate}`
    : rangeQS("/api/dashboard/drop-points?route_code=" + encodeURIComponent(routeCode));
  if (subRouteName) url += "&sub_route=" + encodeURIComponent(subRouteName);
  const data = await api.get(url);
  if (data) S.live[key] = data;
  if (S.screen === "drill" || S.screen === "transport") render();
}
async function fetchOutstanding() {
  if (S.live._outstandingLoading) return;
  S.live._outstandingLoading = true;
  const data = await api.get(rangeQS("/api/dashboard/outstanding"));
  if (data) S.live.outstanding = data;
  S.live._outstandingLoading = false;
  if (S.screen === "command" || S.screen === "drill") render();
}
async function fetchOutstandingAgencies(unitName) {
  const key = "outstanding_agencies_" + unitName;
  if (S.live[key]) return;
  const data = await api.get(rangeQS("/api/dashboard/outstanding/agencies?unit_name=" + encodeURIComponent(unitName)));
  if (data) S.live[key] = data;
  if (S.screen === "drill") render();
}
async function fetchSupply() {
  if (S.live._supplyLoading) return;
  S.live._supplyLoading = true;
  const data = await api.get(rangeQS("/api/dashboard/supply"));
  if (data) S.live.supply = data;
  S.live._supplyLoading = false;
  if (S.screen === "command" || S.screen === "drill") render();
}
async function fetchCollection() {
  if (S.live._collectionLoading) return;
  S.live._collectionLoading = true;
  const data = await api.get(rangeQS("/api/dashboard/collection"));
  if (data) S.live.collection = data;
  S.live._collectionLoading = false;
  if (S.screen === "command" || S.screen === "drill") render();
}
async function fetchSupplyAgencies(unitName) {
  const key = "supply_agencies_" + unitName;
  if (S.live[key]) return;
  const data = await api.get(rangeQS("/api/dashboard/supply/agencies?unit_name=" + encodeURIComponent(unitName)));
  if (data) S.live[key] = data;
  if (S.screen === "drill") render();
}

const store = {
  read() { try { return JSON.parse(localStorage.getItem("patrika_store")) || {}; } catch { return {}; } },
  write(d) { localStorage.setItem("patrika_store", JSON.stringify(d)); },
  get(k, fallback) { const d = this.read(); return k in d ? d[k] : fallback; },
  set(k, v) { const d = this.read(); d[k] = v; this.write(d); },
  push(k, v) { const d = this.read(); (d[k] = d[k] || []).push(v); this.write(d); }
};

function saveSession(u, token) {
  if (u && token) {
    sessionStorage.setItem("patrika_token", token);
    sessionStorage.setItem("patrika_profile", JSON.stringify(u));
  } else {
    sessionStorage.removeItem("patrika_token");
    sessionStorage.removeItem("patrika_profile");
    sessionStorage.removeItem("patrika_user"); // legacy key cleanup
  }
}
function restoreSession() {
  const token = sessionStorage.getItem("patrika_token");
  const prof  = sessionStorage.getItem("patrika_profile");
  if (token && prof) {
    try { S.user = JSON.parse(prof); AUTH_TOKEN = token; }
    catch { S.user = null; AUTH_TOKEN = null; }
  }
}

/* ---------- primitives ---------- */
function toast(msg) {
  document.querySelectorAll(".toast").forEach(e => e.remove());
  const e = document.createElement("div"); e.className = "toast"; e.textContent = msg;
  document.body.appendChild(e); setTimeout(() => e.remove(), 2600);
}
function modal(html) {
  const sc = document.createElement("div"); sc.className = "modal-scrim";
  sc.innerHTML = `<div class="modal">${html}</div>`;
  sc.addEventListener("click", e => { if (e.target === sc) sc.remove(); });
  document.body.appendChild(sc); return sc;
}
function closeModals() { document.querySelectorAll(".modal-scrim").forEach(e => e.remove()); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function go(screen) {
  S.screen = screen; S.sideOpen = false; render();
  const m = $(".main"); if (m) m.scrollTop = 0;
}
function setLoggedIn(profile, token) {
  S = { user: profile, screen: "home", openGroups: {}, sideOpen: false, live: {}, range: null };
  AUTH_TOKEN = token;
  saveSession(profile, token);
  render();
}
function logout() {
  api.post("/api/auth/logout", {}).catch(() => {});
  S = { user: null, screen: "home", openGroups: {}, sideOpen: false, live: {} };
  AUTH_TOKEN = null; saveSession(null);
  render();
}
/* Called when any API call returns 401 (token expired/invalid) — force re-login */
function onAuthExpired() {
  if (!S.user && !AUTH_TOKEN) return;
  S = { user: null, screen: "home", openGroups: {}, sideOpen: false, live: {} };
  AUTH_TOKEN = null; saveSession(null);
  toast("Session expired — please sign in again");
  render();
}
function toggleSide() { S.sideOpen = !S.sideOpen; paintSide(); }
function toggleGroup(g) { S.openGroups[g] = !S.openGroups[g]; render(); }
function toggleTheme() {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  localStorage.setItem("patrika_theme", document.documentElement.dataset.theme);
}
(function initTheme() { const t = localStorage.getItem("patrika_theme"); if (t) document.documentElement.dataset.theme = t; })();

/* ---------- hierarchy-aware home stats ---------- */
function homeStats(u) {
  const hl = u.hierarchyLevel || 99;
  if (hl === 1)  return [["5", "Zones"], ["12", "Branches"], ["124", "Agents"], ["4.1L+", "Copies/day"]];
  if (hl === 2)  return [["5", "Zones"], ["12", "Branches"], ["38", "Agencies"], ["5.1L", "Copies/day"]];
  if (hl === 3)  return [["4", "Branches"], ["38", "Agencies"], ["82", "Hawkers"], ["1.1L", "Copies/day"]];
  if (hl === 4)  return [["6", "Routes"], ["14", "Hawkers"], ["4,820", "Copies/day"], ["38", "Agencies"]];
  if (hl === 5)  return [["4", "Agents"], ["24", "Hawkers"], ["3.2k", "Rural readers"], ["₹1.2L", "Outstanding"]];
  if (hl === 6)  return [["6", "Centers"], ["58", "Hawkers"], ["8.6k", "City readers"], ["₹96k", "Due today"]];
  if (hl === 7)  return [["4", "Visits today"], ["2", "Agents"], ["62", "Leads (month)"], ["₹22k", "Collected"]];
  if (hl === 8)  return [["12", "Hawkers"], ["365", "Copies/day"], ["2", "Routes"], ["98%", "OTD"]];
  if (hl === 9)  return [["6", "Routes"], ["14", "Hawkers"], ["4,820", "Copies/day"], ["₹1.8L", "Outstanding"]];
  return [["365", "My copies"], ["126", "My stops"], ["₹3,355", "Collect today"], ["97%", "OTD"]];
}

/* ---------- generic form modal ---------- */
function formModal(title, intro, fields, submitLabel, onSubmit) {
  const m = modal(`
    <h3>${title}</h3>${intro ? `<p class="mint">${intro}</p>` : ""}
    ${fields.map(f => `<div class="fld"><label>${f.label}</label>${
      f.type === "select" ? `<select data-k="${f.k}">${f.opts.map(o => `<option ${o === f.val ? "selected" : ""}>${o}</option>`).join("")}</select>`
      : f.type === "textarea" ? `<textarea data-k="${f.k}" placeholder="${f.ph || ""}">${f.val || ""}</textarea>`
      : `<input data-k="${f.k}" type="${f.type || "text"}" value="${f.val ?? ""}" placeholder="${f.ph || ""}" ${f.attrs || ""}>`
    }</div>`).join("")}
    <div style="display:flex;gap:9px;margin-top:16px">
      <button class="btn pri block" data-submit>${submitLabel}</button>
      <button class="btn" data-cancel>Cancel</button>
    </div>`);
  m.querySelector("[data-cancel]").onclick = () => m.remove();
  m.querySelector("[data-submit]").onclick = () => {
    const vals = {};
    m.querySelectorAll("[data-k]").forEach(el => vals[el.dataset.k] = el.value.trim());
    if (onSubmit(vals) !== false) m.remove();
  };
  return m;
}

/* ---------- shared UI builders ---------- */
function kpi(label, value, delta, cls, icoBg, ico, drillMetric) {
  const attr = drillMetric
    ? ` role="button" onclick="openDrill('${drillMetric}')" style="cursor:pointer"`
    : "";
  return `<div class="card kpi"${attr}><div class="kico" style="background:${icoBg || "var(--gold-l)"}">${ico || "▦"}</div>
    <div class="lbl">${label}</div><div class="v num">${value}</div>${delta ? `<div class="d ${cls || "fl"}">${delta}</div>` : ""}</div>`;
}
function pagehead(title, sub, actions) {
  const u = S.user;
  const crumb = `${u.roleLabel}${u.scopeLabel ? " · " + u.scopeLabel : ""} · ${TODAY}`;
  return `<div class="pagehead"><div><div class="crumbs">${crumb}</div>
    <h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${actions || ""}</div>`;
}
function table(cols, rows) {
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr>${cols.map(c => `<th${c.startsWith(">") ? ' class="r"' : ""}>${c.replace(/^>/, "")}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody></table></div></div>`;
}
const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;
const slaChip = st => chip(st === "crit" ? "crit" : st === "warn" ? "warn" : "good", "");

/* ═══════════ VIEWS ═══════════ */
const VIEWS = {};

/* ---- Home (module launcher, from suite reference) ---- */
VIEWS.home = () => {
  const u = S.user, hl = u.hierarchyLevel || 99;
  const apps = u.modules.map(k => {
    const a = APP_MENU[k];
    return `<button class="card appcard" onclick="go('${a.sub[0][0]}')">
      <div class="aico" style="background:${a.tint}">${a.icon}</div>
      <b>${a.label}</b><small>${a.desc}</small>
      <div class="tagrow">${a.sub.map(s => chip("mut", s[1])).join("")}</div></button>`;
  }).join("");
  const stats = homeStats(u);
  const statsHtml = stats.map(([v, l]) => `<div><b class="num">${v}</b><small>${l}</small></div>`).join("");
  const dashEntry = hl <= 4
    ? { screen:"command", title:"Vitran — Circulation OS",
        desc:"Command centre — pipeline, partners, collections, complaints, approvals and reports.",
        tags: chip("mut","Command Centre")+chip("mut","Approvals")+chip("mut","Reports") }
    : { screen:"routes",  title:"Field Operations Dashboard",
        desc:"Operational view — routes, deliveries, collections and complaints in your territory.",
        tags: chip("mut","Routes")+chip("mut","Collections")+chip("mut","Complaints") };
  return `
    <div class="hero"><h2>Namaste, ${u.name.split(" ")[0]} 🙏</h2>
      <p>${u.roleLabel} · ${u.scopeLabel} · Level ${hl} of 10</p>
      <div class="hstats">${statsHtml}</div></div>
    ${u.dashboard ? `<div class="sb-lbl" style="padding-left:2px">Dashboard</div>
      <div class="applist" style="margin-bottom:15px"><button class="card appcard" onclick="go('${dashEntry.screen}')">
      <div class="aico" style="background:var(--navy-l)">🗞️</div><b>${dashEntry.title}</b>
      <small>${dashEntry.desc}</small>
      <div class="tagrow">${dashEntry.tags}</div></button></div>` : ""}
    <div class="sb-lbl" style="padding-left:2px">Field Apps — User Input</div>
    <div class="applist">${apps}</div>`;
};

/* ---- Dashboard: Command Centre ---- */
/* ── Command Centre helpers ─────────────────────────────── */
function _cmdBase() { return `${location.protocol}//${location.hostname}:8001`; }

function _cmdLoad() {
  const c = S.live.cmd || (S.live.cmd = {});
  if (!c.ou && !c._ouLoading) {
    c._ouLoading = true;
    fetch(_cmdBase() + '/api/outstanding/kpis', { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.ou = d; c._ouLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._ouLoading = false; c.ou = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.co && !c._coLoading) {
    c._coLoading = true;
    fetch(_cmdBase() + '/api/collection/kpis?from=' + monthStartISO() + '&to=' + todayISO(), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.co = d; c._coLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._coLoading = false; c.co = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.si && !c._siLoading) {
    c._siLoading = true;
    fetch(_cmdBase() + '/api/reports/supply-issues', { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.si = d; c._siLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._siLoading = false; c.si = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.sv && !c._svLoading) {
    c._svLoading = true;
    fetch(_cmdBase() + '/api/survey/kpis', { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.sv = d; c._svLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._svLoading = false; c.sv = { _err: true }; if (S.screen === 'command') render(); });
  }
}

function _cmdSkel() {
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;padding:4px 0">
    ${[1,2,3,4].map(() =>
      `<div style="flex:1;min-width:100px;height:56px;background:var(--brd);border-radius:8px;animation:_cmdPulse 1.4s ease-in-out infinite"></div>`
    ).join('')}
  </div>`;
}

function _cmdFmtC(n) {
  n = Number(n) || 0;
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' L';
  return s + '₹' + a.toLocaleString('en-IN');
}

function _cmdBar(pct, color) {
  return `<div style="height:5px;background:var(--brd);border-radius:3px;margin-top:6px">
    <div style="height:100%;width:${Math.min(100, pct).toFixed(1)}%;background:${color};border-radius:3px"></div></div>`;
}

function _cmdKpiGrid(items) {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:12px">
    ${items.map(([val, lbl, color]) =>
      `<div style="background:var(--bg);border-radius:8px;padding:10px 12px">
        <div style="font-size:17px;font-weight:700;color:${color||'var(--ink)'};line-height:1.2">${val}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.04em">${lbl}</div>
      </div>`
    ).join('')}
  </div>`;
}

function _cmdModuleCard({ icon, title, period, onClick, kpis, footer, error, loading, badge, badgeColor, accent }) {
  const accentBorder = accent ? `;border-left:4px solid ${accent}` : '';
  const clickAttr = onClick ? `onclick="${onClick}" style="cursor:pointer${accentBorder}"` : `style="opacity:.75${accentBorder}"`;
  const badgeHtml = badge
    ? `<span style="margin-left:auto;font-size:11px;font-weight:700;color:${badgeColor||'var(--grn)'};background:${badgeColor?badgeColor+'1a':'var(--grn-l)'};padding:2px 9px;border-radius:10px;white-space:nowrap">${badge}</span>`
    : onClick
      ? `<span style="margin-left:auto;font-size:16px;color:var(--muted)">›</span>`
      : `<span style="margin-left:auto;font-size:11px;color:var(--muted);background:var(--brd);padding:2px 9px;border-radius:10px;white-space:nowrap">Pending sync</span>`;
  let body;
  if (loading)      body = _cmdSkel();
  else if (error)   body = `<p style="color:var(--red);font-size:13px;margin:8px 0">Failed to load. <a href="#" onclick="S.live.cmd=null;render();return false" style="color:var(--acc)">Retry</a></p>`;
  else if (kpis)    body = _cmdKpiGrid(kpis) + (footer ? `<div style="margin-top:8px;font-size:12px;color:var(--muted)">${footer}</div>` : '');
  else              body = `<p style="color:var(--muted);font-size:13px;margin:8px 0 4px">${period||''}</p>`;
  return `<div class="_cmd-card" ${clickAttr}>
    <div style="display:flex;align-items:flex-start;gap:11px;margin-bottom:10px">
      <span style="font-size:22px;line-height:1;flex-shrink:0;margin-top:2px">${icon}</span>
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:15px;color:var(--ink)">${title}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:1px">${period||''}</div>
      </div>
      ${badgeHtml}
    </div>
    ${body}
  </div>`;
}

VIEWS.command = () => {
  _cmdLoad();
  const c = S.live.cmd || {};
  const ou = c.ou, co = c.co, si = c.si, sv = c.sv;

  /* ── Agency Outstanding — point-in-time balance, never a period sum ── */
  let ouKpis, ouFooter;
  if (ou && !ou._err) {
    ouKpis = [
      [_cmdFmtC(ou.total_outstanding),                      'Current Outstanding · As on Today', 'var(--red)'],
      [_cmdFmtC(ou.current_outstanding),                    'Ageing < 31 days',     'var(--gold)'],
      [_cmdFmtC(ou.overdue_outstanding),                    'Overdue (31+ days)',   'var(--red)'],
      [_cmdFmtC(ou.critical_outstanding),                   'Critical (₹2L+)',      'var(--red)'],
      [(ou.total_agencies||0).toLocaleString('en-IN'),      'Total Agencies',       'var(--ink)'],
      [(ou.agencies_with_outstanding||0).toLocaleString('en-IN'), 'With Outstanding','var(--ink)'],
      [(ou.overdue_ag_count||0).toLocaleString('en-IN'),    'Overdue Agencies',    'var(--gold)'],
      [(ou.critical_count||0).toLocaleString('en-IN'),      'Critical Agencies',   'var(--red)'],
    ];
    ouFooter = `Snapshot balance as on <b>${TODAY}</b> — collection activity is shown separately in the Collections card`;
  }

  /* ── Collections ────────────────────────────────────────── */
  let coKpis, coFooter;
  if (co && !co._err) {
    const cashAmt = co.cash_collection || 0, digAmt = co.digital_collection || 0;
    const cashPct = co.total_collection > 0 ? (cashAmt / co.total_collection * 100).toFixed(0) : 0;
    const digPct  = co.total_collection > 0 ? (digAmt  / co.total_collection * 100).toFixed(0) : 0;
    coKpis = [
      [_cmdFmtC(co.total_collection),                       'YTD Total',           'var(--grn)'],
      [_cmdFmtC(co.mtd_collection||0),                      'MTD Collection',      'var(--ink)'],
      [(co.total_txn||0).toLocaleString('en-IN'),           'Transactions',        'var(--ink)'],
      [(co.agencies_paid||0).toLocaleString('en-IN'),       'Agencies Paid',       'var(--ink)'],
      [_cmdFmtC(digAmt),                                    `Digital · ${digPct}%`,'var(--acc)'],
      [_cmdFmtC(cashAmt),                                   `Cash · ${cashPct}%`,  'var(--gold)'],
      [_cmdFmtC(co.avg_per_agency||0),                      'Avg / Agency',        'var(--ink)'],
      [_cmdFmtC(co.highest_collection||0),                  'Highest Single',      'var(--ink)'],
    ];
    coFooter = `Cash share: <b>${cashPct}%</b> &nbsp;·&nbsp; Digital: <b>${_cmdFmtC(digAmt)}</b> &nbsp;·&nbsp; Last payment: <b>${co.last_date||'—'}</b>`;
  }

  /* ── Taxi Deliveries ────────────────────────────────────── */
  let siKpis, siFooter, siBadge, siBadgeColor;
  if (si && !si._err) {
    const lateCount = si.late?.length || 0, missedCount = si.app_not_running?.length || 0;
    const dateLabel = si.dates?.length ? si.dates[si.dates.length - 1] : '—';
    const totalIssues = lateCount + missedCount;
    siKpis = [
      [String(lateCount),   'Late (after 6 AM)', lateCount   > 0 ? 'var(--red)'  : 'var(--grn)'],
      [String(missedCount), 'App Not Running',   missedCount > 0 ? 'var(--gold)' : 'var(--grn)'],
      [dateLabel,           'Latest Date',       'var(--ink)'],
    ];
    siFooter = totalIssues > 0
      ? `<span style="color:var(--red);font-weight:600">${totalIssues} issue${totalIssues !== 1 ? 's' : ''} today</span> · <a href="#" onclick="go('transport');return false" style="color:var(--acc)">View alerts →</a>`
      : `<span style="color:var(--grn)">✓ All taxis on time today</span>`;
    siBadge = totalIssues > 0 ? totalIssues + ' issues' : '✓ All clear';
    siBadgeColor = totalIssues > 0 ? 'var(--red)' : 'var(--grn)';
  }

  /* ── Survey Intelligence ────────────────────────────────── */
  let svKpis, svFooter;
  if (sv && !sv._err) {
    const total  = sv.total  || 0;
    const orders = sv.order_count || 0;
    const fups   = sv.followup_pending || 0;
    const rpRdr  = sv.by_reason?.RP_READER || 0;
    const notInt = sv.by_reason?.NOT_INTERESTED || 0;
    const convPct = total > 0 ? (orders / total * 100).toFixed(1) : '0.0';
    svKpis = [
      [fmtN(total),                   'Total Surveys',    'var(--ink)'],
      [fmtN(orders),                  'Orders Booked',    'var(--grn)'],
      [fmtN(rpRdr),                   'RP Readers',       '#2E7D32'],
      [fmtN(notInt),                  'Not Interested',   'var(--red)'],
      [fmtN(fups),                    'Follow-ups Due',   'var(--gold)'],
      [String(sv.surveyors || 0),     'Active Surveyors', 'var(--acc)'],
    ];
    svFooter = `Conversion: <b style="color:var(--grn)">${convPct}%</b> &nbsp;·&nbsp; Surveyors: <b>${sv.surveyors||0}</b> &nbsp;·&nbsp; Areas covered: <b>${sv.areas||0}</b>
      ${_cmdBar(parseFloat(convPct), 'var(--grn)')}`;
  }

  /* ── Top KPI strip data ─────────────────────────────────── */
  const strip = [
    { val: ou && !ou._err ? _cmdFmtC(ou.total_outstanding)      : (c._ouLoading ? '…' : '—'),
      lbl: 'Outstanding · As on Today', icon: '💰', color: 'var(--red)',
      sub: ou && !ou._err ? (ou.critical_count||0).toLocaleString('en-IN') + ' critical agencies' : '' },
    { val: co && !co._err ? _cmdFmtC(co.total_collection)        : (c._coLoading ? '…' : '—'),
      lbl: 'YTD Collections',    icon: '₹',  color: 'var(--grn)',
      sub: co && !co._err ? _cmdFmtC(co.mtd_collection||0) + ' this month' : '' },
    { val: si && !si._err ? String((si.late?.length||0) + (si.app_not_running?.length||0)) : (c._siLoading ? '…' : '—'),
      lbl: 'Taxi Alerts Today',  icon: '🚕', color: si && !si._err && (si.late?.length||0)+(si.app_not_running?.length||0)>0 ? 'var(--red)' : 'var(--grn)',
      sub: si && !si._err ? (si.late?.length||0)+' late · '+(si.app_not_running?.length||0)+' offline' : '' },
    { val: sv && !sv._err ? fmtN(sv.total||0)                   : (c._svLoading ? '…' : '—'),
      lbl: 'Reader Surveys',     icon: '📋', color: 'var(--acc)',
      sub: sv && !sv._err ? fmtN(sv.order_count||0) + ' orders booked' : '' },
  ];

  /* ── Pending modules ────────────────────────────────────── */
  const pending = [
    { icon:'📦', title:'Supply & Distribution', desc:'Print-to-door pipeline, unit-wise dispatch, wastage %' },
    { icon:'🛵', title:'Hawker Operations',      desc:'Route coverage, reader database, earnings, missed drops' },
    { icon:'🚚', title:'Vehicle Tracking',       desc:'Delays, breakdowns, real-time location, compliance' },
  ];

  return pagehead('Command Centre', 'Live data summary · ' + TODAY) + `
    <style>
      ._cmd-card{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:16px 18px;transition:box-shadow .15s,border-color .15s}
      ._cmd-card[onclick]:hover{box-shadow:0 4px 20px rgba(0,0,0,.11);border-color:var(--acc)}
      ._cmd-strip-item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}
      @keyframes _cmdPulse{0%,100%{opacity:1}50%{opacity:.45}}
    </style>

    <!-- Top 4-KPI summary strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${strip.map(s => `
        <div class="_cmd-strip-item" style="border-left:4px solid ${s.color}">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:15px;line-height:1">${s.icon}</span>
            <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.lbl}</span>
          </div>
          <div style="font-size:24px;font-weight:800;color:${s.color};line-height:1.1;font-variant-numeric:tabular-nums;margin-top:2px">${s.val}</div>
          ${s.sub ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">${s.sub}</div>` : '<div style="height:14px"></div>'}
        </div>
      `).join('')}
    </div>

    <!-- 2×2 main card grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      ${_cmdModuleCard({
        icon:'💰', title:'Agency Outstanding', period:'Balance as on today',
        onClick:"go('outstanding')", accent:'var(--red)',
        kpis: ouKpis, footer: ouFooter,
        loading: !ou && !c._ouError, error: ou?._err,
        badge: ou && !ou._err ? _cmdFmtC(ou.total_outstanding) + ' outstanding' : null,
        badgeColor: 'var(--red)',
      })}
      ${_cmdModuleCard({
        icon:'₹', title:'Collections', period:'Jan–Jul 2026 · ' + (co && !co._err ? (co.total_txn||0).toLocaleString('en-IN') : '…') + ' transactions',
        onClick:"go('collections')", accent:'var(--grn)',
        kpis: coKpis, footer: coFooter,
        loading: !co && !c._coError, error: co?._err,
        badge: co && !co._err ? _cmdFmtC(co.total_collection) + ' collected' : null,
        badgeColor: 'var(--grn)',
      })}
      ${_cmdModuleCard({
        icon:'🚕', title:'Taxi Deliveries', period:"Today's supply alerts",
        onClick:"go('transport')", accent: siBadgeColor || 'var(--gold)',
        kpis: siKpis, footer: siFooter,
        loading: !si && !c._siError, error: si?._err,
        badge: siBadge, badgeColor: siBadgeColor,
      })}
      ${_cmdModuleCard({
        icon:'📋', title:'Survey Intelligence', period:'Reader survey outcomes · all time',
        onClick:"go('survey_dash')", accent:'var(--acc)',
        kpis: svKpis, footer: svFooter,
        loading: !sv && !c._svError, error: sv?._err,
        badge: sv && !sv._err ? fmtN(sv.total||0) + ' surveyed' : null,
        badgeColor: 'var(--acc)',
      })}
    </div>

    ${si && !si._err && (si.late?.length || si.app_not_running?.length) ? `
    <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.07em;text-transform:uppercase;margin:18px 0 10px;padding-left:2px">
      Taxi Deliveries — State / Unit / Route Detail · ${si.dates?.slice(-1)[0] || ''}
    </div>
    ${si.late?.length ? `<div class="card pad" style="margin-bottom:12px">
      <div style="margin-bottom:10px">
        <h3 style="margin:0 0 3px;font-size:14px;font-weight:700;color:#dc2626">SUPPLY TAXI REACHED AFTER 6 AM</h3>
        <div style="font-size:11px;color:var(--muted)">${si.late.length} route${si.late.length!==1?'s':''} · Click a button in the row to send the alert</div>
      </div>
      <div style="overflow-x:auto">${renderAlertRows(si.late, 'last_late', 'color:#dc2626;font-weight:bold')}</div>
    </div>` : ''}
    ${si.app_not_running?.length ? `<div class="card pad" style="margin-bottom:12px">
      <div style="margin-bottom:10px">
        <h3 style="margin:0 0 3px;font-size:14px;font-weight:700;color:#d97706">APP NOT RUNNING (App KM = 0)</h3>
        <div style="font-size:11px;color:var(--muted)">${si.app_not_running.length} route${si.app_not_running.length!==1?'s':''} · Click a button in the row to send the alert</div>
      </div>
      <div style="overflow-x:auto">${renderAlertRows(si.app_not_running, 'vehicle_no', 'color:#d97706;font-weight:bold')}</div>
    </div>` : ''}` : ''}

    <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.07em;text-transform:uppercase;margin:18px 0 10px;padding-left:2px">
      Pending Oracle Sync — will be connected progressively
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${pending.map(m => _cmdModuleCard({ icon: m.icon, title: m.title, period: m.desc })).join('')}
    </div>`;
};

/* ═══════════ VZ — data-viz component library ═══════════
   Theme-aware (light/dark via CSS tokens --chart-1..5), CVD-validated palette,
   hover tooltips, animated marks, direct value labels. */
const VZ = {
  C: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'],
  fmt(v) {
    const n = Number(v); if (isNaN(n)) return String(v);
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
    if (a >= 1e5) return (n / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  },
  full(v) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('en-IN'); },
};

/* singleton tooltip w/ pointer-follow (delegated) */
(function vzTipInit() {
  let el = null;
  const ensure = () => {
    if (!el) { el = document.createElement('div'); el.className = 'vz-tip'; document.body.appendChild(el); }
    return el;
  };
  document.addEventListener('mousemove', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    const tip = ensure();
    if (t) {
      tip.innerHTML = t.getAttribute('data-tip');
      tip.classList.add('show');
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 10);
      const y = Math.min(e.clientY + 18, window.innerHeight - tip.offsetHeight - 10);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    } else tip.classList.remove('show');
  }, { passive: true });
})();

function vzSpark(values, color, w = 74, h = 26) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), rng = (max - min) || 1;
  const px = i => (i / (values.length - 1)) * (w - 2) + 1;
  const py = v => h - 2 - ((v - min) / rng) * (h - 6);
  const pts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="kspark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="1,${h - 1} ${pts} ${w - 1},${h - 1}" fill="${color}" opacity="0.12" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="${px(values.length - 1).toFixed(1)}" cy="${py(last).toFixed(1)}" r="2.4" fill="${color}"/>
  </svg>`;
}

/* Smart KPI card: value, delta pill, sparkline, status stripe */
function vzKpi(o) {
  const SC = { good: 'var(--grn)', bad: 'var(--red)', warn: 'var(--gold)', info: 'var(--chart-1)', mute: 'var(--muted)' };
  const c = SC[o.status] || SC.info;
  let pill = '';
  if (o.delta != null && o.delta !== 0) {
    const up = o.delta > 0;
    const good = o.invert ? !up : up;
    pill = `<span class="vz-pill ${good ? 'up' : 'down'}">${up ? '▲' : '▼'} ${VZ.fmt(Math.abs(o.delta))}${o.pct != null ? ` · ${Math.abs(o.pct)}%` : ''}</span>`;
  } else if (o.delta === 0) pill = `<span class="vz-pill flat">—</span>`;
  return `<div class="vz-kpi" style="--kpi-c:${c}" ${o.tip ? `data-tip="${esc(o.tip)}"` : ''}>
    <span class="kl">${o.icon || ''} ${esc(o.label)}</span>
    <div class="kv num">${o.value}</div>
    <div class="kd">${pill}${o.sub ? `<small style="color:var(--muted)">${o.sub}</small>` : ''}</div>
    ${o.spark && o.spark.length > 1 ? vzSpark(o.spark, c) : ''}
  </div>`;
}

/* Horizontal bars: rounded ends, hover tooltip, direct labels, +/- coloring */
function vzHBar(o) {
  const items = (o.items || []).slice(0, o.max || 14);
  if (!items.length) return '';
  const maxV = Math.max(...items.map(it => Math.abs(Number(it.value) || 0)), 1);
  const rows = items.map((it, i) => {
    const v = Number(it.value) || 0;
    const w = Math.max(1.5, Math.abs(v) / maxV * 100);
    const color = it.color || (o.signed ? (v >= 0 ? 'var(--grn)' : 'var(--red)') : (o.color || 'var(--chart-1)'));
    const tip = it.tip || `<b>${esc(it.label)}</b><br>${o.valueLabel ? esc(o.valueLabel) + ': ' : ''}${VZ.full(v)}`;
    return `<div class="vz-hrow" data-tip="${esc(tip)}" ${it.onclick ? `onclick="${it.onclick}" style="cursor:pointer"` : ''}>
      <span class="hl">${esc(String(it.label))}</span>
      <div class="ht"><div class="hb" style="width:${w}%;background:${color};animation-delay:${Math.min(i * 40, 400)}ms"></div></div>
      <span class="hv" style="color:${o.signed ? (v >= 0 ? 'var(--grn)' : 'var(--red)') : 'var(--ink)'}">${o.fmt ? o.fmt(v) : VZ.fmt(v)}</span>
    </div>`;
  }).join('');
  return `<div class="vz-sec">${o.title ? `<div class="vzt"><b>${esc(o.title)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>` : ''}${rows}</div>`;
}

let _vzUid = 0;
/* Line/area chart with per-point hover targets */
function vzLine(o) {
  const vals = (o.values || []).map(Number), labels = o.labels || [];
  if (vals.length < 2) return '';
  const uid = 'vzg' + (++_vzUid);
  const W = 640, H = 200, PL = 44, PR = 12, PT = 12, PB = 26;
  const min = Math.min(...vals), max = Math.max(...vals);
  const lo = min - (max - min) * 0.06, hi = max + (max - min) * 0.06 || max + 1;
  const rng = (hi - lo) || 1;
  const px = i => PL + i * (W - PL - PR) / (vals.length - 1);
  const py = v => PT + (H - PT - PB) * (1 - (v - lo) / rng);
  const color = o.color || 'var(--chart-1)';
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const grid = [0.25, 0.5, 0.75].map(f => {
    const y = PT + (H - PT - PB) * f;
    return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--brd2)" stroke-width="1"/>`;
  }).join('');
  const yLbl = [hi, (hi + lo) / 2, lo].map((v, i) => `<text x="${PL - 6}" y="${PT + (H - PT - PB) * (i * 0.5) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${VZ.fmt(v)}</text>`).join('');
  const step = Math.max(1, Math.ceil(vals.length / 8));
  const xLbl = labels.map((l, i) => i % step === 0
    ? `<text x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(String(l).slice(-7))}</text>` : '').join('');
  const colW = (W - PL - PR) / (vals.length - 1);
  const hovers = vals.map((v, i) => {
    const tip = `<b>${esc(String(labels[i] || ''))}</b><br>${o.valueLabel ? esc(o.valueLabel) + ': ' : ''}${VZ.full(v)}`;
    return `<g data-tip="${esc(tip)}"><rect x="${(px(i) - colW / 2).toFixed(1)}" y="${PT}" width="${colW.toFixed(1)}" height="${H - PT - PB}" fill="transparent"/><circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.6" fill="${color}"/></g>`;
  }).join('');
  return `<div class="vz-sec">${o.title ? `<div class="vzt"><b>${esc(o.title)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="${esc(o.title || 'trend chart')}">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient></defs>
      ${grid}${yLbl}
      <polygon points="${PL},${H - PB} ${pts} ${W - PR},${H - PB}" fill="url(#${uid})"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${hovers}${xLbl}
    </svg>
    ${o.valueLabel ? `<div style="font-size:10.5px;color:var(--muted);margin-top:4px">${esc(o.valueLabel)} · low ${VZ.fmt(min)} · high ${VZ.fmt(max)}</div>` : ''}</div>`;
}

/* Donut with centre total, slice gaps, hover, legend */
function vzDonut(o) {
  const items = (o.items || []).filter(it => Number(it.value) > 0).slice(0, 8);
  if (!items.length) return '';
  const total = items.reduce((a, it) => a + Number(it.value), 0) || 1;
  const R = 62, r = 40, CX = 75, CY = 75;
  let ang = -90, paths = '';
  items.forEach((it, i) => {
    const frac = Number(it.value) / total, sweep = frac * 360;
    const large = sweep > 180 ? 1 : 0;
    const a0 = ang * Math.PI / 180, a1 = (ang + sweep) * Math.PI / 180;
    const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    const xi1 = CX + r * Math.cos(a1), yi1 = CY + r * Math.sin(a1);
    const xi0 = CX + r * Math.cos(a0), yi0 = CY + r * Math.sin(a0);
    const color = it.color || VZ.C[i % VZ.C.length];
    const tip = `<b>${esc(it.label)}</b><br>${VZ.full(it.value)} (${(frac * 100).toFixed(1)}%)`;
    paths += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 ${large},1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${r},${r} 0 ${large},0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z"
      fill="${color}" stroke="var(--surf)" stroke-width="2" data-tip="${esc(tip)}"/>`;
    ang += sweep;
  });
  const legend = items.map((it, i) => `<span><i style="background:${it.color || VZ.C[i % VZ.C.length]}"></i>${esc(it.label)} <b class="num" style="color:var(--ink)">${VZ.fmt(it.value)}</b></span>`).join('');
  return `<div class="vz-sec">${o.title ? `<div class="vzt"><b>${esc(o.title)}</b></div>` : ''}
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 150 150" style="width:132px;flex:none">${paths}
        <text x="${CX}" y="${CY - 3}" text-anchor="middle" font-size="17" font-weight="800" fill="var(--ink)">${VZ.fmt(total)}</text>
        <text x="${CX}" y="${CY + 13}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(o.centerLabel || 'total')}</text>
      </svg>
      <div class="vz-legend" style="flex-direction:column;gap:6px;align-items:flex-start">${legend}</div>
    </div></div>`;
}

/* ═══════════ Supply Management Dashboard ═══════════ */
function _supdState() {
  return S.live.supd || (S.live.supd = { tab: 'overview', unit: '', agentOrder: 'supply', trendGran: 'daily', trendDays: 30 });
}
const _supdN = v => v == null ? '—' : Number(v).toLocaleString('en-IN');
const _supdINR = v => v == null ? '—' : (Math.abs(v) >= 1e7 ? '₹' + (v / 1e7).toFixed(2) + ' Cr' : Math.abs(v) >= 1e5 ? '₹' + (v / 1e5).toFixed(2) + ' L' : '₹' + Math.round(v).toLocaleString('en-IN'));
const _supdPct = p => p == null ? '—' : `${p >= 0 ? '+' : ''}${p}%`;
const _supdDelta = v => v == null ? '—' : `<span style="color:${v > 0 ? 'var(--grn)' : v < 0 ? 'var(--red)' : 'var(--muted)'}">${v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}${Math.abs(v).toLocaleString('en-IN')}</span>`;

function _supdQS(st) {
  return st.unit ? `?unit_code=${encodeURIComponent(st.unit)}` : '';
}
function _supdFetch(key, path, force) {
  const st = _supdState();
  const loadKey = '_l_' + key;
  if (st[loadKey] || (st[key] && !force)) return;
  st[loadKey] = true;
  fetch(api.base + path, { headers: api.h() })
    .then(r => r.json())
    .then(d => { st[key] = d; st[loadKey] = false; if (S.screen === 'supply_dash') render(); })
    .catch(() => { st[key] = { _err: true }; st[loadKey] = false; if (S.screen === 'supply_dash') render(); });
}
window.supdTab = t => { _supdState().tab = t; render(); };
window.supdUnit = u => {
  const st = _supdState();
  st.unit = u;
  ['kpis', 'branches', 'agents', 'execs', 'trend', 'exceptions', 'insights'].forEach(k => { st[k] = null; });
  render();
};
window.supdAgentOrder = o => { const st = _supdState(); st.agentOrder = o; st.agents = null; render(); };
window.supdAgentSearch = () => { const st = _supdState(); st.agentQ = (document.getElementById('supdAgentQ') || {}).value || ''; st.agents = null; render(); };
window.supdTrendGran = g => { const st = _supdState(); st.trendGran = g; st.trend = null; render(); };
window.supdRefresh = () => { supdUnit(_supdState().unit); };

window.supdCSV = key => {
  const st = _supdState();
  const rows = (st[key] || {}).rows || [];
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => {
    const v = r[c] == null ? '' : String(r[c]);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `supply_${key}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

function _supdKpiCard(icon, label, value, sub, color) {
  return `<div class="_cmd-strip-item" style="${color ? `border-left:4px solid ${color}` : ''}">
    <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600">${icon} ${label}</span>
    <div style="font-size:21px;font-weight:800">${value}</div>
    ${sub ? `<small style="color:var(--muted);font-size:10.5px">${sub}</small>` : ''}</div>`;
}

function _supdOverview(st) {
  _supdFetch('kpis', '/api/supply-dash/kpis' + _supdQS(st));
  _supdFetch('branches', '/api/supply-dash/branches' + _supdQS(st));
  _supdFetch('insights', '/api/supply-dash/insights' + _supdQS(st));
  const k = st.kpis;
  if (!k) return _cmdSkel() + _cmdSkel();
  if (k._err || k.no_data) return `<div class="card pad" style="color:var(--muted)">Supply data not loaded yet — run the supply sync first.</div>`;
  const spark = k.spark || [];

  const hero = `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">
    ${vzKpi({ icon: '📦', label: 'Day Supply', value: _supdN(k.today_supply), status: 'info',
              delta: k.day_change, pct: Math.abs(k.day_change_pct || 0), spark,
              sub: `on ${k.data_upto}`, tip: `<b>Previous day</b>: ${_supdN(k.yesterday_supply)} copies` })}
    ${vzKpi({ icon: '🔄', label: 'Net Change (DoD)', value: _supdN(Math.abs(k.net_growth)),
              status: k.net_growth >= 0 ? 'good' : 'bad', delta: k.net_growth,
              sub: `${_supdN(k.growing_agents)} ↑ · ${_supdN(k.reducing_agents)} ↓ agents` })}
    ${vzKpi({ icon: '📊', label: 'Month Avg / Day', value: _supdN(k.month_avg_supply), status: 'info',
              sub: `${k.mtd_days} days this month` })}
    ${vzKpi({ icon: '🏢', label: 'Active Agents', value: _supdN(k.active_agents), status: 'good',
              sub: `${_supdN(k.today_agents)} supplied today` })}
  </div>
  <div class="vz-kgrid">
    ${vzKpi({ icon: '🔼', label: 'Copy Growth', value: _supdN(k.mtd_growth_copies), status: 'good', sub: `${_supdN(k.growing_agents)} agents` })}
    ${vzKpi({ icon: '🔽', label: 'Copy Reduction', value: _supdN(k.mtd_reduction_copies), status: 'bad', sub: `${_supdN(k.reducing_agents)} agents` })}
    ${vzKpi({ icon: '⚠️', label: 'Zero Supply', value: _supdN(k.zero_supply_agents), status: 'warn', sub: 'had supply prev day' })}
    ${vzKpi({ icon: '🆕', label: 'New Agents', value: _supdN(k.new_agents_month), status: 'info', sub: 'this month' })}
    ${vzKpi({ icon: '🚫', label: 'Inactive', value: _supdN(k.inactive_agents), status: 'mute', sub: 'stopped / suspended' })}
    ${vzKpi({ icon: '📍', label: 'Centers', value: _supdN(k.centers), status: 'mute', sub: 'hawker data pending' })}
  </div>`;

  let mid = '';
  if (st.branches && st.branches.rows && st.branches.rows.length) {
    const rows = st.branches.rows;
    mid = `<div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;align-items:start" class="supd-mid">
      ${vzHBar({ title: 'Branch-wise Supply', sub: `latest day · top ${Math.min(14, rows.length)}`, valueLabel: 'copies',
                 items: rows.slice(0, 14).map(r => ({ label: r.branch, value: r.supply,
                   tip: `<b>${esc(r.branch)}</b><br>Supply: ${VZ.full(r.supply)}<br>Net change: ${r.net_change >= 0 ? '+' : ''}${VZ.full(r.net_change)}<br>Agents: ${VZ.full(r.agents)}` })) })}
      ${vzDonut({ title: 'Agent Movement (DoD)', centerLabel: 'agents',
                  items: [
                    { label: 'Growing', value: k.growing_agents, color: 'var(--grn)' },
                    { label: 'Reducing', value: k.reducing_agents, color: 'var(--red)' },
                    { label: 'Zero supply', value: k.zero_supply_agents, color: 'var(--gold)' },
                  ] })}
    </div>
    <style>@media(max-width:820px){.supd-mid{grid-template-columns:1fr!important}}</style>`;
  }

  let insights = '';
  if (st.insights && st.insights.insights && st.insights.insights.length) {
    const icons = ['📈', '📉', '⚠️', '💰', '🏆', '🔍'];
    insights = `<div class="vz-sec">
      <div class="vzt"><b>🤖 AI Insights</b><small>auto-generated from live data</small></div>
      ${st.insights.insights.map((i, idx) => `<div class="vz-alert"><span class="ai">${icons[idx % icons.length]}</span><span>${esc(i)}</span></div>`).join('')}
    </div>`;
  }
  return hero + mid + insights;
}

function _supdBranches(st) {
  _supdFetch('branches', '/api/supply-dash/branches' + _supdQS(st));
  const d = st.branches;
  if (!d) return _cmdSkel();
  if (d._err || !d.rows || !d.rows.length) return `<div class="card pad" style="color:var(--muted)">No branch data.</div>`;
  const hl = `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
    ${vzKpi({ icon: '🏆', label: 'Highest Supply', value: `<span style="font-size:16px">${esc(d.highest_supply || '—')}</span>`, status: 'info' })}
    ${vzKpi({ icon: '📈', label: 'Highest Growth', value: `<span style="font-size:16px">${esc(d.highest_growth || '—')}</span>`, status: 'good' })}
    ${vzKpi({ icon: '📉', label: 'Highest Reduction', value: `<span style="font-size:16px">${esc(d.highest_reduction || '—')}</span>`, status: 'bad' })}
  </div>`;
  const rows = d.rows.map(r => `<tr>
    <td>${r.rank}</td><td><b>${esc(r.branch)}</b></td>
    <td class="r num">${_supdN(r.agents)}</td>
    <td class="r num">${_supdN(r.supply)}</td>
    <td class="r num" style="color:var(--grn)">${_supdN(r.growth)}</td>
    <td class="r num" style="color:var(--red)">${_supdN(r.reduction)}</td>
    <td class="r num">${_supdDelta(r.net_change)}</td>
    <td class="r num">${_supdPct(r.growth_pct)}</td></tr>`);
  return hl
    + `<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="btn" onclick="supdCSV('branches')">⬇ Excel/CSV</button></div>`
    + table(['#', 'Branch', '>Agents', '>Supply', '>Growth', '>Reduction', '>Net', '>%'], rows)
    + `<div class="card pad" style="margin-top:12px">${_askChart({ type: 'bar', title: 'Net change by branch', labels: d.rows.slice(0, 14).map(r => r.branch), values: d.rows.slice(0, 14).map(r => r.net_change), value_label: 'net copies' })}</div>`;
}

function _supdAgents(st) {
  const qs = _supdQS(st) + (st.unit ? '&' : '?') + `order=${st.agentOrder}&limit=100` + (st.agentQ ? `&search=${encodeURIComponent(st.agentQ)}` : '');
  _supdFetch('agents', '/api/supply-dash/agents' + qs);
  const d = st.agents;
  const bar = `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
    ${[['supply', '📦 Top Supply'], ['growth', '📈 Top Growing'], ['decline', '📉 Top Declining']].map(([k, l]) =>
      `<button class="btn ${st.agentOrder === k ? 'pri' : ''}" onclick="supdAgentOrder('${k}')">${l}</button>`).join('')}
    <input id="supdAgentQ" type="text" placeholder="Search agent…" value="${esc(st.agentQ || '')}"
      onkeydown="if(event.key==='Enter')supdAgentSearch()"
      style="margin-left:auto;background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--fg)">
    <button class="btn" onclick="supdAgentSearch()">🔍</button>
    <button class="btn" onclick="supdCSV('agents')">⬇ CSV</button>
  </div>`;
  if (!d) return bar + _cmdSkel();
  if (d._err || !d.rows || !d.rows.length) return bar + `<div class="card pad" style="color:var(--muted)">No agents found.</div>`;
  const rows = d.rows.map(r => `<tr>
    <td><b>${esc(r.agent)}</b><small style="display:block;color:var(--muted)">${esc(r.agcd)} · ${esc(r.city || '')}</small></td>
    <td>${esc(r.branch)}</td>
    <td><small>${esc(r.executive || '—')}</small></td>
    <td class="r num">${_supdN(r.supply)}</td>
    <td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td>
    <td class="r num">${_supdDelta(r.net_change)}</td>
    <td class="r num">${r.outstanding == null ? '—' : `<span style="color:${r.outstanding > 100000 ? 'var(--red)' : 'var(--fg)'}">${_supdINR(r.outstanding)}</span>`}</td>
    <td class="r"><small style="color:var(--muted)">${r.last_visit || 'DCR pending'}</small></td></tr>`);
  return bar + table(['Agent', 'Branch', 'Executive', '>Supply', '>Prev', '>Change', '>Outstanding', '>Last Visit'], rows);
}

function _supdExecs(st) {
  _supdFetch('execs', '/api/supply-dash/executives' + _supdQS(st));
  const d = st.execs;
  if (!d) return _cmdSkel();
  if (d._err || !d.rows || !d.rows.length) return `<div class="card pad" style="color:var(--muted)">No executive data.</div>`;
  const rows = d.rows.map(r => `<tr>
    <td>${r.rank}</td><td><b>${esc(r.executive)}</b></td>
    <td class="r num">${_supdN(r.agents)}</td>
    <td class="r num">${_supdN(r.supply)}</td>
    <td class="r num" style="color:var(--grn)">${_supdN(r.growth)}</td>
    <td class="r num" style="color:var(--red)">${_supdN(r.reduction)}</td>
    <td class="r num">${_supdDelta(r.net_change)}</td>
    <td class="r"><small style="color:var(--muted)">DCR pending</small></td></tr>`);
  const best = [...d.rows].sort((a, b) => b.net_change - a.net_change)[0];
  const worst = [...d.rows].sort((a, b) => a.net_change - b.net_change)[0];
  return `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
      ${vzKpi({ icon: '🏆', label: 'Highest Growth', value: `<span style="font-size:15px">${esc(best ? best.executive : '—')}</span>`, status: 'good', sub: best ? `+${_supdN(best.net_change)} copies` : '' })}
      ${vzKpi({ icon: '⚠️', label: 'Lowest Performance', value: `<span style="font-size:15px">${esc(worst ? worst.executive : '—')}</span>`, status: 'bad', sub: worst ? `${_supdN(worst.net_change)} copies` : '' })}
    </div>`
    + `<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="btn" onclick="supdCSV('execs')">⬇ Excel/CSV</button></div>`
    + table(['#', 'Executive', '>Agents', '>Supply', '>Growth', '>Reduction', '>Net', '>Visits'], rows);
}

function _supdTrend(st) {
  const qs = _supdQS(st) + (st.unit ? '&' : '?') + `granularity=${st.trendGran}&days=${st.trendDays}`;
  _supdFetch('trend', '/api/supply-dash/trend' + qs);
  const d = st.trend;
  const bar = `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
    ${[['daily', '📅 Daily (30d)'], ['monthly', '📆 Monthly'], ['yearly', '🗓 Yearly']].map(([k, l]) =>
      `<button class="btn ${st.trendGran === k ? 'pri' : ''}" onclick="supdTrendGran('${k}')">${l}</button>`).join('')}
    <button class="btn" style="margin-left:auto" onclick="supdCSV('trend')">⬇ CSV</button></div>`;
  if (!d) return bar + _cmdSkel();
  if (d._err || !d.rows || !d.rows.length) return bar + `<div class="card pad" style="color:var(--muted)">No trend data for this selection.</div>`;
  const useAvg = d.granularity !== 'daily';
  const chart = _askChart({
    type: 'line', title: useAvg ? 'Daily-average copies' : 'Daily copies',
    labels: d.rows.map(r => r.label),
    values: d.rows.map(r => Number(useAvg ? r.daily_avg : r.copies) || 0),
    value_label: useAvg ? 'avg copies/day' : 'copies',
  });
  const rows = d.rows.slice().reverse().slice(0, 40).map(r => `<tr>
    <td>${esc(r.label)}</td><td class="r num">${_supdN(r.copies)}</td>
    ${useAvg ? `<td class="r num">${_supdN(r.daily_avg)}</td>` : ''}</tr>`);
  return bar + `<div class="card pad">${chart}</div>`
    + table(useAvg ? ['Period', '>Total Copies', '>Daily Avg'] : ['Date', '>Copies'], rows);
}

function _supdExceptions(st) {
  _supdFetch('exceptions', '/api/supply-dash/exceptions' + _supdQS(st));
  const d = st.exceptions;
  if (!d) return _cmdSkel();
  if (d._err || d.no_data) return `<div class="card pad" style="color:var(--muted)">No exception data.</div>`;
  const sect = (title, color, rows, cols, mk) => `
    <div class="card pad" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:800;color:${color};margin-bottom:6px">${title} · ${rows.length}</div>
      ${rows.length ? `<div class="tablewrap"><table>
        <thead><tr>${cols.map(c => `<th${c.startsWith('>') ? ' class="r"' : ''}>${c.replace(/^>/, '')}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 25).map(mk).join('')}</tbody></table></div>` : `<small style="color:var(--muted)">None 🎉</small>`}
    </div>`;
  return sect('⚠️ Zero Supply (had copies previous day)', 'var(--gold)', d.zero_supply || [], ['Agent', 'Branch', '>Copies Lost'],
      r => `<tr><td><b>${esc(r.ag_name)}</b></td><td>${esc(r.unit_name)}</td><td class="r num" style="color:var(--red)">${_supdN(r.copies_lost)}</td></tr>`)
    + sect('📉 Negative Growth >10% (14 days)', 'var(--red)', d.negative_growth || [], ['Agent', 'Branch', '>Before', '>Now', '>%'],
      r => `<tr><td><b>${esc(r.ag_name)}</b></td><td>${esc(r.unit_name)}</td><td class="r num">${_supdN(r.prior)}</td><td class="r num">${_supdN(r.recent)}</td><td class="r num" style="color:var(--red)">${r.change_pct}%</td></tr>`)
    + sect('🚀 Abnormal Growth >20% (14 days)', 'var(--acc)', d.abnormal_growth || [], ['Agent', 'Branch', '>Before', '>Now', '>%'],
      r => `<tr><td><b>${esc(r.ag_name)}</b></td><td>${esc(r.unit_name)}</td><td class="r num">${_supdN(r.prior)}</td><td class="r num">${_supdN(r.recent)}</td><td class="r num" style="color:var(--grn)">+${r.change_pct}%</td></tr>`)
    + sect('💰 High Outstanding (>₹1L) with Active Supply', 'var(--red)', d.high_outstanding || [], ['Agent', 'Branch', '>Outstanding', '>Last Supply'],
      r => `<tr><td><b>${esc(r.ag_name)}</b></td><td>${esc(r.unit_name)}</td><td class="r num" style="color:var(--red)">${_supdINR(Number(r.outstanding))}</td><td class="r num">${_supdN(r.last_supply_copies)}</td></tr>`)
    + `<div class="card pad" style="color:var(--muted);font-size:11.5px">🚶 "No DCR Visit" exceptions will appear once the DCR visit sync is added.</div>`;
}

VIEWS.supply_dash = () => {
  const st = _supdState();
  _supdFetch('filters', '/api/supply-dash/filters');
  const tabs = [['overview', '📊 Overview'], ['branches', '🏢 Branches'], ['agents', '👤 Agents'],
                ['execs', '👔 Executives'], ['trend', '📈 Trends'], ['exceptions', '⚠️ Exceptions']];
  const units = (st.filters && st.filters.units) || [];
  const unitSel = `<select onchange="supdUnit(this.value)"
      style="background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--fg)">
    <option value="">All Branches</option>
    ${units.map(u => `<option value="${esc(u.unit_code)}" ${st.unit === u.unit_code ? 'selected' : ''}>${esc(u.unit_name)}</option>`).join('')}
  </select>`;
  const tabBar = `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
    ${tabs.map(([k, l]) => `<button class="btn ${st.tab === k ? 'pri' : ''}" onclick="supdTab('${k}')">${l}</button>`).join('')}
    <span style="margin-left:auto"></span>${unitSel}
    <button class="btn" title="Print / save as PDF" onclick="window.print()">🖨</button>
    <button class="btn" onclick="supdRefresh()">↻</button>
  </div>`;
  const bodyMap = { overview: _supdOverview, branches: _supdBranches, agents: _supdAgents,
                    execs: _supdExecs, trend: _supdTrend, exceptions: _supdExceptions };
  const dataNote = st.filters && st.filters.data_upto
    ? `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:8px">Agency/Credit sale data up to <b>${esc(String(st.filters.data_upto).slice(0, 10))}</b> · Hawker/Cash sale &amp; DCR visit data pending sync · 5-year history loading</div>`
    : '';
  return pagehead('Supply Dashboard', 'Agency supply · growth & reduction · exceptions — decision view for HO, ZH, Incharge & Executives') + `
    <style>._cmd-strip-item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}</style>
    ${tabBar}${(bodyMap[st.tab] || _supdOverview)(st)}${dataNote}`;
};

/* ═══════════ AI Insights & Action Center ═══════════ */
const _AI_PRI = { P1: ['var(--red)',  'P1 · Act Today'],
                  P2: ['var(--gold)', 'P2 · This Week'],
                  P3: ['var(--acc)',  'P3 · Monitor'] };
const _AI_MOD = { outstanding: ['💰','Outstanding'], collection: ['₹','Collections'],
                  short_payment: ['⚠️','Short Payment'], taxi: ['🚕','Taxi'], app_usage: ['📵','App Usage'],
                  survey: ['📋','Survey'], digital: ['💳','Digital'] };
const _AI_DRILL = { outstanding:'outstanding', collection:'collections', short_payment:'outstanding',
                    taxi:'transport', app_usage:'transport', survey:'survey_dash', digital:'collections' };

function _aiState() { return S.live.ins || (S.live.ins = { tab: 'insights' }); }

function _aiLoad(force) {
  const st = _aiState();
  if (st._loading || (st.data && !force)) return;
  st._loading = true; if (force) st.data = null;
  fetch(api.base + '/api/insights' + (force ? '?refresh=1' : ''), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.data = d; st._loading = false; st._err = false; if (S.screen === 'ai_insights') render(); })
    .catch(() => { st._loading = false; st._err = true; if (S.screen === 'ai_insights') render(); });
}
function _aiLoadActions(force) {
  const st = _aiState();
  if (st._actLoading || (st.actions && !force)) return;
  st._actLoading = true; if (force) st.actions = null;
  fetch(api.base + '/api/actions?limit=100', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.actions = d.actions || []; st._actLoading = false; if (S.screen === 'ai_insights') render(); })
    .catch(() => { st._actLoading = false; st.actions = []; if (S.screen === 'ai_insights') render(); });
}
function _aiLoadCfg(force) {
  const st = _aiState();
  if (st._cfgLoading || (st.cfg && !force)) return;
  st._cfgLoading = true; if (force) st.cfg = null;
  fetch(api.base + '/api/email-config', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.cfg = d; st._cfgLoading = false; if (S.screen === 'ai_insights') render(); })
    .catch(() => { st._cfgLoading = false; st.cfg = { units: [], contacts: [] }; if (S.screen === 'ai_insights') render(); });
}

window.aiTab = t => { _aiState().tab = t; render(); };
window.aiRefresh = () => { _aiLoad(true); render(); };

/* ═══════════ Ask AI (chat) ═══════════ */
function _askState() {
  const st = _aiState();
  if (!st.chat) {
    st.chat = [];
    st.convId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  return st;
}

const _ASK_SUGGESTIONS = [
  "Today's total circulation",
  'Branch-wise circulation for today',
  'Agencies with outstanding above ₹50,000',
  'Top 20 agencies by copy supply',
  'Monthly circulation trend for the last 12 months',
  'New agencies added this month',
  'Outstanding recovery status branch-wise',
  'Compare supply with pre-COVID (18 March 2020)',
  'आज की कुल प्रसार संख्या',
  'शाखावार बकाया की स्थिति',
];

window.askSuggest = i => {
  const el = document.getElementById('askInput');
  if (el) { el.value = _ASK_SUGGESTIONS[i]; el.focus(); }
};

window.askKey = ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); window.askSend(); } };

window.askSend = async () => {
  const st = _askState();
  const el = document.getElementById('askInput');
  const qText = (el ? el.value : '').trim();
  if (!qText || st.askBusy) return;
  st.chat.push({ role: 'user', text: qText });
  st.askBusy = true;
  render(); _askScroll();
  try {
    const r = await fetch(api.base + '/api/ask-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...api.h() },
      body: JSON.stringify({ question: qText, conversation_id: st.convId }),
    });
    const d = await r.json();
    st.chat.push({ role: 'ai', ...d });
  } catch (e) {
    st.chat.push({ role: 'ai', answer: 'Network error — could not reach the AI service. Is the API server running?' });
  }
  st.askBusy = false;
  render(); _askScroll();
};

window.askClear = () => { const st = _askState(); st.chat = []; st.convId = 'c' + Date.now().toString(36); render(); };

function _askScroll() {
  setTimeout(() => { const b = document.getElementById('askChatBody'); if (b) b.scrollTop = b.scrollHeight; }, 60);
}

/* — chart renderer: delegates to the VZ design-system components — */
function _askChart(c) {
  if (!c || !c.labels || !c.labels.length) return '';
  const vals = (c.values || []).map(Number);
  const anyNeg = vals.some(v => v < 0);
  if (c.type === 'pie') {
    return vzDonut({
      title: c.title,
      items: c.labels.map((l, i) => ({ label: String(l), value: Math.abs(vals[i] || 0) })),
      centerLabel: c.value_label || 'total',
    });
  }
  if (c.type === 'line') {
    return vzLine({ title: c.title, labels: c.labels, values: vals, valueLabel: c.value_label });
  }
  return vzHBar({
    title: c.title, valueLabel: c.value_label, signed: anyNeg,
    items: c.labels.map((l, i) => ({ label: String(l), value: vals[i] || 0 })),
  });
}

function _askTable(t) {
  if (!t || !t.rows || !t.rows.length) return '';
  const cols = t.columns;
  const fmtCell = v => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return v.toLocaleString('en-IN');
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
    return s;
  };
  const head = cols.map(cName => `<th style="text-align:left;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--brd);white-space:nowrap">${esc(cName.replace(/_/g, ' '))}</th>`).join('');
  const body = t.rows.slice(0, 100).map(r => `<tr>${cols.map(cName => {
    const v = r[cName];
    const isNum = typeof v === 'number';
    return `<td style="padding:4px 8px;font-size:12px;border-bottom:1px solid var(--brd);${isNum ? 'text-align:right;font-variant-numeric:tabular-nums' : ''}">${esc(fmtCell(v))}</td>`;
  }).join('')}</tr>`).join('');
  return `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--acc)">📋 Detailed table (${t.rows.length} rows${t.rows.length > 100 ? ', showing 100' : ''})</summary>
    <div style="overflow-x:auto;margin-top:6px;max-height:340px;overflow-y:auto"><table style="border-collapse:collapse;width:100%">${head ? `<thead><tr>${head}</tr></thead>` : ''}<tbody>${body}</tbody></table></div></details>`;
}

function _askMsg(m) {
  if (m.role === 'user') {
    return `<div style="display:flex;justify-content:flex-end;margin:8px 0"><div style="background:var(--acc);color:#fff;border-radius:14px 14px 4px 14px;padding:9px 14px;max-width:82%;font-size:13px">${esc(m.text)}</div></div>`;
  }
  const parts = [];
  if (m.answer) parts.push(`<div style="font-size:14px;font-weight:700;line-height:1.45">${esc(m.answer)}</div>`);
  if (m.summary) parts.push(`<div style="font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:5px">${esc(m.summary)}</div>`);
  (m.charts || []).forEach(ch => parts.push(`<div style="margin-top:8px">${_askChart(ch)}</div>`));
  if (m.insights && m.insights.length) {
    parts.push(`<div style="margin-top:8px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--gold)">💡 Insights</div>
      ${m.insights.map(i => `<div style="font-size:12px;margin-top:3px;padding-left:10px;border-left:2px solid var(--gold);line-height:1.45">${esc(i)}</div>`).join('')}</div>`);
  }
  if (m.recommendations && m.recommendations.length) {
    parts.push(`<div style="margin-top:8px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--grn)">✅ Recommendations</div>
      ${m.recommendations.map(i => `<div style="font-size:12px;margin-top:3px;padding-left:10px;border-left:2px solid var(--grn);line-height:1.45">${esc(i)}</div>`).join('')}</div>`);
  }
  parts.push(_askTable(m.table));
  if (m.took_ms) parts.push(`<div style="font-size:10px;color:var(--muted);margin-top:6px">${(m.took_ms / 1000).toFixed(1)}s · ${m.engine === 'claude' ? 'AI analysis' : 'pattern engine'}</div>`);
  return `<div style="display:flex;margin:8px 0"><div style="background:var(--card);border:1px solid var(--brd);border-radius:14px 14px 14px 4px;padding:11px 14px;max-width:94%;width:100%">${parts.join('')}</div></div>`;
}

function _aiAskTab(st) {
  const chat = st.chat || [];
  const empty = !chat.length;
  const chips = _ASK_SUGGESTIONS.map((s, i) =>
    `<button class="btn" style="font-size:11px;padding:5px 10px" onclick="askSuggest(${i});askSend()">${esc(s)}</button>`).join('');

  return `
    <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 210px);min-height:420px">
      <div id="askChatBody" style="flex:1;overflow-y:auto;padding:14px">
        ${empty ? `
          <div style="text-align:center;padding:26px 10px">
            <div style="font-size:34px">🤖</div>
            <div style="font-size:16px;font-weight:800;margin-top:6px">Ask anything about your circulation business</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">Supply, collection, outstanding, agencies, surveys — in plain language.<br>Answers come with data tables, charts and recommendations.</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:14px">${chips}</div>
          </div>` : chat.map(_askMsg).join('')}
        ${st.askBusy ? `<div style="display:flex;margin:8px 0"><div style="background:var(--card);border:1px solid var(--brd);border-radius:14px;padding:10px 16px;font-size:12px;color:var(--muted)"><span style="animation:_cmdPulse 1.2s infinite">Analysing your data…</span></div></div>` : ''}
      </div>
      <div style="border-top:1px solid var(--brd);padding:10px;display:flex;gap:8px;align-items:center">
        <input id="askInput" type="text" placeholder="e.g. Branch-wise circulation for today…" onkeydown="askKey(event)"
          style="flex:1;background:var(--bg);border:1px solid var(--brd);border-radius:10px;padding:10px 13px;font-size:13px;color:var(--fg);outline:none">
        <button class="btn pri" onclick="askSend()" ${st.askBusy ? 'disabled' : ''}>Ask ➤</button>
        ${chat.length ? `<button class="btn" title="New conversation" onclick="askClear()">🗑</button>` : ''}
      </div>
    </div>`;
}

function _aiIns(idx) { return _aiState().data?.insights?.[idx]; }
function _aiLogAction(body) {
  return api.post('/api/actions', { created_by: S.user?.name || '', ...body });
}

/* — message drafting + send — */
window.aiDraft = async (idx, channel) => {
  const ins = _aiIns(idx); if (!ins) return;
  toast('Generating ' + channel + ' draft…');
  const d = await api.post('/api/insights/draft', { insight: ins, channel });
  if (!d) { toast('Draft failed — is the API running?'); return; }

  if (channel === 'email') {
    const toPre = (d.recipients || []).map(r => r.email).join(', ');
    const who   = (d.recipients || []).map(r => `${r.person_name || r.role_label} (${r.unit_name || r.unit_code})`).join(', ');
    const m = modal(`
      <h3>✉ Send Email — Review &amp; Edit</h3>
      <p class="mint">${who ? 'Configured recipients: ' + esc(who) : '<span style="color:var(--gold)">No emails configured for the target units — add them in the Email Config tab, or type addresses below.</span>'}</p>
      <div class="fld"><label>To (comma-separated)</label><input data-k="to" value="${esc(toPre)}" placeholder="name@in.patrika.com"></div>
      <div class="fld"><label>Subject</label><input data-k="subject" value="${esc(d.subject)}"></div>
      <div class="fld"><label>Message (editable)</label><textarea data-k="body" rows="12" style="min-height:220px;font-size:13px">${esc(d.body)}</textarea></div>
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn pri block" data-send>Send Email</button>
        <button class="btn" data-cancel>Cancel</button>
      </div>`);
    m.querySelector('[data-cancel]').onclick = () => m.remove();
    m.querySelector('[data-send]').onclick = async () => {
      const to = m.querySelector('[data-k=to]').value.split(',').map(s => s.trim()).filter(Boolean);
      const subject = m.querySelector('[data-k=subject]').value.trim();
      const body = m.querySelector('[data-k=body]').value;
      if (!to.length) { toast('Enter at least one email address'); return; }
      const btn = m.querySelector('[data-send]'); btn.disabled = true; btn.textContent = 'Sending…';
      const r = await api.post('/api/insights/send-email', {
        to, subject, body, insight_key: ins.id, module: ins.module, priority: ins.priority,
        created_by: S.user?.name || '' });
      if (r && r.ok) { m.remove(); toast('✓ Email sent to ' + r.sent_to.length + ' recipient' + (r.sent_to.length > 1 ? 's' : '')); _aiState().actions = null; }
      else { btn.disabled = false; btn.textContent = 'Send Email'; toast((r && r.detail) || 'Send failed'); }
    };
    return;
  }

  /* whatsapp / sms — preview, copy, open app, log */
  const mobiles = (d.mobiles || []).slice(0, 6);
  const chIcon = channel === 'whatsapp' ? '💬 WhatsApp' : '📱 SMS';
  const m = modal(`
    <h3>${chIcon} — Review &amp; Edit</h3>
    ${mobiles.length ? `<p class="mint">Numbers from the insight: ${mobiles.map(x => esc(x)).join(', ')}</p>`
                     : `<p class="mint">No mobile numbers attached to this insight — copy the text and send manually.</p>`}
    <div class="fld"><label>Send to (mobile)</label><input data-k="mob" value="${esc(mobiles[0] || '')}" placeholder="10-digit mobile"></div>
    <div class="fld"><label>Message (editable)</label><textarea data-k="body" rows="9" style="min-height:160px;font-size:13px">${esc(d.body)}</textarea></div>
    <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap">
      <button class="btn pri" data-open>Open ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS app'}</button>
      <button class="btn" data-copy>Copy text</button>
      <button class="btn" data-cancel>Close</button>
    </div>`);
  m.querySelector('[data-cancel]').onclick = () => m.remove();
  m.querySelector('[data-copy]').onclick = () => {
    navigator.clipboard.writeText(m.querySelector('[data-k=body]').value).then(() => toast('Copied to clipboard'));
  };
  m.querySelector('[data-open]').onclick = () => {
    const mob = m.querySelector('[data-k=mob]').value.replace(/\D/g, '');
    const body = m.querySelector('[data-k=body]').value;
    const url = channel === 'whatsapp'
      ? 'https://wa.me/91' + mob + '?text=' + encodeURIComponent(body)
      : 'sms:+91' + mob + '?body=' + encodeURIComponent(body);
    if (channel === 'whatsapp' && !mob) { toast('Enter a mobile number'); return; }
    window.open(url, '_blank');
    _aiLogAction({ insight_key: ins.id, module: ins.module, title: `${channel.toUpperCase()}: ${ins.title}`.slice(0, 300),
      detail: body, priority: ins.priority, action_type: channel + '_sent', status: 'in_progress',
      channel_meta: { mobile: mob } });
    _aiState().actions = null;
    toast(channel === 'whatsapp' ? 'Opening WhatsApp…' : 'Opening SMS app…');
  };
};

window.aiAssign = idx => {
  const ins = _aiIns(idx); if (!ins) return;
  formModal('📌 Assign Task', 'Creates a tracked action item for this insight.', [
    { k: 'title', label: 'Task title', val: ins.title },
    { k: 'assigned_to', label: 'Assign to (name / role)', ph: 'e.g. ZH Bhopal — Ramesh' },
    { k: 'priority', label: 'Priority', type: 'select', opts: ['P1', 'P2', 'P3'], val: ins.priority },
    { k: 'detail', label: 'Instructions', type: 'textarea', val: ins.next },
  ], 'Create Task', vals => {
    if (!vals.assigned_to) { toast('Enter who this is assigned to'); return false; }
    _aiLogAction({ insight_key: ins.id, module: ins.module, title: vals.title, detail: vals.detail,
      priority: vals.priority, assigned_to: vals.assigned_to, action_type: 'task', status: 'open' })
      .then(r => { toast(r && r.ok ? '✓ Task assigned to ' + vals.assigned_to : 'Failed to save task');
        _aiState().actions = null; _aiLoad(true); });
  });
};

window.aiEscalate = idx => {
  const ins = _aiIns(idx); if (!ins) return;
  formModal('↑ Escalate', 'Raises this to P1 and logs an escalation for senior management.', [
    { k: 'to', label: 'Escalate to', ph: 'e.g. GM Circulation', val: 'GM Circulation' },
    { k: 'note', label: 'Note', type: 'textarea', val: `${ins.what}\n\n${ins.why}` },
  ], 'Escalate', vals => {
    _aiLogAction({ insight_key: ins.id, module: ins.module, title: ('ESCALATED: ' + ins.title).slice(0, 300),
      detail: vals.note, priority: 'P1', assigned_to: vals.to, action_type: 'escalation', status: 'open' })
      .then(r => { toast(r && r.ok ? '✓ Escalated to ' + vals.to : 'Failed'); _aiState().actions = null; _aiLoad(true); });
  });
};

window.aiResolve = idx => {
  const ins = _aiIns(idx); if (!ins) return;
  formModal('✓ Mark Resolved', 'Logs this insight as handled with your note.', [
    { k: 'note', label: 'Resolution note', type: 'textarea', ph: 'What was done?' },
  ], 'Mark Resolved', vals => {
    _aiLogAction({ insight_key: ins.id, module: ins.module, title: ('Resolved: ' + ins.title).slice(0, 300),
      detail: vals.note || '', priority: ins.priority, action_type: 'resolved', status: 'resolved' })
      .then(r => { toast(r && r.ok ? '✓ Marked resolved' : 'Failed'); _aiState().actions = null; _aiLoad(true); });
  });
};

window.aiView = idx => {
  const ins = _aiIns(idx); if (!ins) return;
  go(_AI_DRILL[ins.module] || 'command');
};

window.aiActStatus = async (id, status) => {
  const r = await fetch(api.base + '/api/actions/' + id, {
    method: 'PATCH', headers: api.h(),
    body: JSON.stringify({ status, resolved_by: S.user?.name || '' }) }).then(x => x.json()).catch(() => null);
  toast(r && r.ok ? 'Updated' : 'Update failed');
  _aiLoadActions(true);
};

/* — email config CRUD — */
window.aiCfgForm = id => {
  const st = _aiState(), cfg = st.cfg || { units: [], contacts: [] };
  const cur = id ? cfg.contacts.find(c => c.id === id) : null;
  const unitOpts = cfg.units.map(u => `${u.unit_code}${u.unit_name ? ' — ' + u.unit_name : ''}`);
  const curUnit = cur ? `${cur.unit_code} — ${cur.unit_name || ''}` : unitOpts[0];
  formModal(cur ? 'Edit Contact' : 'Add Unit Contact',
    'Emails here receive the one-click alerts for their unit.', [
    { k: 'unit', label: 'Unit', type: 'select', opts: unitOpts, val: unitOpts.find(o => o.startsWith((cur?.unit_code || '') + ' — ')) || curUnit },
    { k: 'role_label', label: 'Role', type: 'select', opts: ['Zonal Head', 'Branch Manager', 'Circulation Executive', 'GM Circulation', 'Other'], val: cur?.role_label || 'Zonal Head' },
    { k: 'person_name', label: 'Person name', val: cur?.person_name || '' },
    { k: 'email', label: 'Email', type: 'email', val: cur?.email || '', ph: 'name@in.patrika.com' },
    { k: 'mobile', label: 'Mobile (for WhatsApp/SMS)', val: cur?.mobile || '', ph: '10-digit' },
  ], cur ? 'Save Changes' : 'Add Contact', vals => {
    if (!vals.email) { toast('Email is required'); return false; }
    const unit_code = vals.unit.split(' — ')[0];
    api.post('/api/email-config', { id: cur?.id, unit_code, role_label: vals.role_label,
      person_name: vals.person_name, email: vals.email, mobile: vals.mobile, is_active: 1 })
      .then(r => { toast(r && r.ok ? '✓ Saved' : (r && r.detail) || 'Save failed'); _aiLoadCfg(true); });
  });
};
window.aiCfgDel = id => {
  const m = modal(`<h3>Delete contact?</h3><p class="mint">This contact will no longer receive alerts.</p>
    <div style="display:flex;gap:9px;margin-top:14px">
      <button class="btn pri block" data-y style="background:var(--red)">Delete</button>
      <button class="btn" data-n>Cancel</button></div>`);
  m.querySelector('[data-n]').onclick = () => m.remove();
  m.querySelector('[data-y]').onclick = async () => {
    await fetch(api.base + '/api/email-config/' + id, { method: 'DELETE', headers: api.h() }).catch(() => {});
    m.remove(); toast('Deleted'); _aiLoadCfg(true);
  };
};

/* — card renderers — */
function _aiCard(ins, idx) {
  const [pColor, pLabel] = _AI_PRI[ins.priority] || _AI_PRI.P3;
  const [mIcon, mLabel]  = _AI_MOD[ins.module]  || ['📌', ins.module];
  const top = (ins.top || []).slice(0, 5);
  const more = (ins.top || []).length - top.length;
  return `<div class="_cmd-card" style="border-left:4px solid ${pColor};margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:11px;font-weight:800;color:#fff;background:${pColor};padding:2px 9px;border-radius:10px;letter-spacing:.03em">${pLabel}</span>
      <span style="font-size:11px;color:var(--muted);background:var(--bg);padding:2px 9px;border-radius:10px">${mIcon} ${mLabel}</span>
      ${ins.open_actions ? `<span style="font-size:11px;color:var(--grn);background:var(--grn-l);padding:2px 9px;border-radius:10px">⏳ ${ins.open_actions} action${ins.open_actions > 1 ? 's' : ''} in progress</span>` : ''}
    </div>
    <div style="font-weight:800;font-size:16px;color:var(--ink);line-height:1.3;margin-bottom:10px">${esc(ins.title)}</div>
    <div style="display:grid;gap:7px;font-size:13px;line-height:1.45">
      <div><b style="color:var(--muted);font-size:10px;letter-spacing:.06em">WHAT</b><br>${esc(ins.what)}</div>
      <div><b style="color:var(--muted);font-size:10px;letter-spacing:.06em">WHY</b><br>${esc(ins.why)}</div>
      <div><b style="color:${pColor};font-size:10px;letter-spacing:.06em">IMPACT</b><br>${esc(ins.impact)}</div>
      <div style="background:var(--bg);border-radius:8px;padding:9px 12px"><b style="color:var(--grn);font-size:10px;letter-spacing:.06em">▶ WHAT NEXT</b><br>${esc(ins.next)}</div>
    </div>
    ${top.length ? `<div style="margin-top:10px;font-size:12px;color:var(--muted)">
      ${top.map((t, i) => `<div style="padding:3px 0;border-bottom:1px dashed var(--brd)">${i + 1}. ${esc(t.text || t.label)}</div>`).join('')}
      ${more > 0 ? `<div style="padding:3px 0">… and ${more} more</div>` : ''}
    </div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
      <button class="btn" style="font-size:12px" onclick="aiDraft(${idx},'email')">✉ Email</button>
      <button class="btn" style="font-size:12px" onclick="aiDraft(${idx},'whatsapp')">💬 WhatsApp</button>
      <button class="btn" style="font-size:12px" onclick="aiDraft(${idx},'sms')">📱 SMS</button>
      <button class="btn" style="font-size:12px" onclick="aiAssign(${idx})">📌 Assign</button>
      <button class="btn" style="font-size:12px" onclick="aiEscalate(${idx})">↑ Escalate</button>
      <button class="btn" style="font-size:12px" onclick="aiView(${idx})">🔍 Details</button>
      <button class="btn" style="font-size:12px;color:var(--grn)" onclick="aiResolve(${idx})">✓ Resolve</button>
    </div>
  </div>`;
}

const _AI_ACT_ICON = { email_sent: '✉', whatsapp_sent: '💬', sms_sent: '📱', task: '📌', escalation: '↑', resolved: '✓' };
function _aiActionsTab(st) {
  _aiLoadActions();
  if (!st.actions) return _cmdSkel();
  if (!st.actions.length) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:30px">No actions logged yet — use the buttons on any insight.</div>`;
  const stChip = s => s === 'resolved' ? chip('good', 'Resolved') : s === 'in_progress' ? chip('warn', 'In Progress') : chip('crit', 'Open');
  return table(['', 'Action', 'Assigned', 'Pri', 'Status', '>'],
    st.actions.map(a => `<tr>
      <td>${_AI_ACT_ICON[a.action_type] || '•'}</td>
      <td><b>${esc(a.title || '')}</b><br><small style="color:var(--muted)">${esc(String(a.created_at || '').slice(0, 16).replace('T', ' '))}${a.module ? ' · ' + a.module : ''}</small></td>
      <td>${esc(a.assigned_to || '—')}</td>
      <td><b style="color:${(_AI_PRI[a.priority] || ['var(--muted)'])[0]}">${a.priority || '—'}</b></td>
      <td>${stChip(a.status)}</td>
      <td class="r" style="white-space:nowrap">${a.status !== 'resolved'
        ? `${a.status === 'open' ? `<button class="btn" style="font-size:11px" onclick="aiActStatus(${a.id},'in_progress')">Start</button> ` : ''}
           <button class="btn" style="font-size:11px;color:var(--grn)" onclick="aiActStatus(${a.id},'resolved')">✓ Done</button>` : ''}</td>
    </tr>`));
}

function _aiCfgTab(st) {
  _aiLoadCfg();
  if (!st.cfg) return _cmdSkel();
  const rows = (st.cfg.contacts || []).map(c => `<tr>
    <td><b>${esc(c.unit_name || c.unit_code)}</b><br><small style="color:var(--muted)">${esc(c.unit_code)}</small></td>
    <td>${esc(c.role_label || '')}<br><small style="color:var(--muted)">${esc(c.person_name || '')}</small></td>
    <td>${esc(c.email)}<br><small style="color:var(--muted)">${esc(c.mobile || '')}</small></td>
    <td>${c.is_active ? chip('good', 'Active') : chip('mut', 'Off')}</td>
    <td class="r" style="white-space:nowrap">
      <button class="btn" style="font-size:11px" onclick="aiCfgForm(${c.id})">Edit</button>
      <button class="btn" style="font-size:11px;color:var(--red)" onclick="aiCfgDel(${c.id})">Delete</button></td>
  </tr>`);
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:13px;color:var(--muted)">Unit-wise contacts who receive the one-click alerts. Add each Zonal Head's email against their unit.</div>
      <button class="btn pri" onclick="aiCfgForm()">＋ Add Contact</button>
    </div>
    ${rows.length ? table(['Unit', 'Role / Person', 'Email / Mobile', 'Status', '>'], rows)
      : `<div class="card pad" style="text-align:center;color:var(--muted);padding:30px">No contacts configured yet — click "＋ Add Contact" to add the first Zonal Head.</div>`}`;
}

VIEWS.ai_insights = () => {
  const st = _aiState();
  if (st.tab === 'insights') _aiLoad();
  const d = st.data;
  const tabs = [['insights', '🤖 Insights'], ['ask', '💬 Ask AI'], ['actions', '⚡ Action Center'], ['email', '✉ Email Config']];
  const tabBar = `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
    ${tabs.map(([k, l]) => `<button class="btn ${st.tab === k ? 'pri' : ''}" onclick="aiTab('${k}')">${l}</button>`).join('')}
    ${st.tab === 'insights' ? `<button class="btn" style="margin-left:auto" onclick="aiRefresh()">↻ Refresh</button>` : ''}
  </div>`;

  let body;
  if (st.tab === 'ask') body = _aiAskTab(_askState());
  else if (st.tab === 'actions') body = _aiActionsTab(st);
  else if (st.tab === 'email') body = _aiCfgTab(st);
  else if (st._err) body = `<div class="card pad" style="color:var(--red)">Failed to load insights. <a href="#" onclick="aiRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  else if (!d) body = _cmdSkel() + _cmdSkel() + _cmdSkel();
  else {
    const list = d.insights || [];
    const counts = { P1: 0, P2: 0, P3: 0 };
    list.forEach(i => counts[i.priority] = (counts[i.priority] || 0) + 1);
    const strip = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      ${['P1', 'P2', 'P3'].map(p => `<div class="_cmd-strip-item" style="border-left:4px solid ${_AI_PRI[p][0]}">
        <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600">${_AI_PRI[p][1]}</span>
        <div style="font-size:24px;font-weight:800;color:${_AI_PRI[p][0]}">${counts[p] || 0}</div>
      </div>`).join('')}
    </div>`;
    body = strip + (list.length
      ? list.map((i, idx) => _aiCard(i, idx)).join('')
      : `<div class="card pad" style="text-align:center;color:var(--grn);padding:34px">✓ Nothing needs your attention right now — all monitored KPIs look normal for your scope.</div>`)
      + (d.generated_at ? `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:6px">Generated ${esc(String(d.generated_at).slice(0, 16).replace('T', ' '))} UTC${d.cached ? ' · cached (max 10 min old)' : ''} · computed from live database values</div>` : '');
  }

  return pagehead('AI Insights & Actions', 'What needs attention · why it happened · what to do next') + `
    <style>@keyframes _cmdPulse{0%,100%{opacity:1}50%{opacity:.45}}
    ._cmd-card{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:16px 18px}
    ._cmd-strip-item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}</style>
    ${tabBar}${body}`;
};

/* ---- Drill: openDrill / drillInto / drillBack ---- */
window.openDrill = metric => {
  const u = S.user, hl = u.hierarchyLevel || 99;
  /* For delivery, use live unit/route/droppoint levels if live data is available */
  if (metric === "delivery" && S.live.delivery) {
    S.drill = { metric, level:"unit", unitName:null, routeCode:null };
    go("drill"); return;
  }
  /* For outstanding, use live unit→agency levels if live data is available */
  if (metric === "outstanding") {
    if (!S.live.outstanding && !S.live._outstandingLoading) fetchOutstanding();
    S.drill = { metric, level:"unit", unitName:null, routeCode:null };
    go("drill"); return;
  }
  if (metric === "supply") {
    if (!S.live.supply && !S.live._supplyLoading) fetchSupply();
    S.drill = { metric, level:"unit", unitName:null, routeCode:null };
    go("drill"); return;
  }
  if (metric === "collection") {
    if (!S.live.collection && !S.live._collectionLoading) fetchCollection();
    S.drill = { metric, level:"unit", unitName:null, routeCode:null };
    go("drill"); return;
  }
  if (hl <= 2) S.drill = { metric, level:"zone",   zoneId:null,         branchId:null, agencyId:null };
  else if (hl === 3) S.drill = { metric, level:"branch", zoneId:u.zone_id||1,  branchId:null, agencyId:null };
  else         S.drill = { metric, level:"agency", zoneId:u.zone_id||1, branchId:u.branch_id||1, agencyId:null };
  go("drill");
};
window.openDrillAt = (metric, level, id) => {
  if (level === "zone")   S.drill = { metric, level:"branch", zoneId:id,  branchId:null, agencyId:null };
  if (level === "branch") S.drill = { metric, level:"agency", zoneId:null,branchId:id,   agencyId:null };
  if (level === "agency") S.drill = { metric, level:"hawker", zoneId:null,branchId:null, agencyId:id   };
  go("drill");
};
/* Live delivery drill: unit name -> routes -> drop points */
window.openDrillLive = unitName => {
  S.drill = { metric:"delivery", level:"unit", unitName:null, routeCode:null };
  go("drill");
  setTimeout(() => {
    S.drill.level = "route"; S.drill.unitName = unitName;
    fetchRoutes(unitName).then(() => render());
  }, 0);
};
window.drillInto = id => {
  const d = S.drill;
  if (d.level === "unit") {
    S.drill = { ...d, level:"route", unitName:id, routeCode:null };
    if (d.metric === "outstanding") fetchOutstandingAgencies(id);
    else if (d.metric === "supply") fetchSupplyAgencies(id);
    else fetchRoutes(id);
  } else if (d.level === "zone") S.drill = { ...d, level:"branch", zoneId:id, branchId:null, agencyId:null };
  else if (d.level === "branch") {
    if (d.metric === "delivery") {
      const br = BRANCHES_DATA.find(b => b.id === id);
      const unitName = br ? br.name : String(id);
      S.drill = { ...d, level:"route", branchId:id, unitName, routeCode:null };
      fetchRoutes(unitName).then(() => render());
    } else {
      S.drill = { ...d, level:"agency", branchId:id, agencyId:null };
    }
  } else if (d.level === "agency") S.drill = { ...d, level:"hawker", agencyId:id };
  render(); const m = $(".main"); if (m) m.scrollTop = 0;
};
window.drillIntoRoute = (routeCode, subRouteName) => {
  S.drill = { ...S.drill, level:"droppoint", routeCode, subRouteName: subRouteName || null };
  render();
  fetchDropPoints(routeCode, subRouteName || null).then(() => render());
  const m = $(".main"); if (m) m.scrollTop = 0;
};

window.txToggleFilter = () => {
  if (!S.live.txFilter) S.live.txFilter = {};
  S.live.txFilter.open = !S.live.txFilter.open;
  render();
};

window.txStateChange = (stateVal) => {
  if (!S.live.txFilter) S.live.txFilter = {};
  S.live.txFilter.state = stateVal;
  S.live.txFilter.unit  = '';
  render();
};

window.txApplyFilter = (state, unit, date) => {
  if (!S.live.txFilter) S.live.txFilter = {};
  S.live.txFilter.state = state;
  S.live.txFilter.unit  = unit;
  S.live.txFilter.open  = false;
  const currentDate   = S.live.delivery?.date?.slice(0, 10) || '';
  if (date && date !== currentDate) {
    S.live.delivery     = null;
    S.live._loading     = false;
    S.live.txFilterDate = date;
  } else if (!date && S.live.txFilterDate) {
    S.live.txFilterDate = null;
    S.live.delivery     = null;
    S.live._loading     = false;
  }
  if (unit) {
    S.drill = { level:'route', metric:'delivery', unitName:unit, routeCode:null, subRouteName:null };
    fetchRoutes(unit);
  } else {
    S.drill = { level:'unit', metric:'delivery', unitName:null, routeCode:null, subRouteName:null };
  }
  render();
};
window.drillBack = level => {
  const d = S.drill;
  if (level === "unit")   S.drill = { ...d, level:"unit",  unitName:null, routeCode:null, subRouteName:null };
  if (level === "route")  S.drill = { ...d, level:"route", routeCode:null, subRouteName:null };
  if (level === "zone")   S.drill = { ...d, level:"zone",   zoneId:null,  branchId:null, agencyId:null };
  if (level === "branch") S.drill = { ...d, level:"branch", branchId:null,agencyId:null };
  if (level === "agency") S.drill = { ...d, level:"agency", agencyId:null };
  render(); const m = $(".main"); if (m) m.scrollTop = 0;
};

// ─── Taxi Delay Report ────────────────────────────────────────────────────────
(function() {
  const ST = {}; // { filters, rows, totals, month, state, unit, loading, err }

  async function _load(month, state, unit) {
    ST.loading = true; ST.err = null;
    render();
    try {
      const qs = new URLSearchParams({ month });
      if (state) qs.set('state', state);
      if (unit)  qs.set('unit', unit);
      const d = await fetch(api.base + `/api/taxi-delay/summary?${qs}`, { headers: api.h() }).then(r => r.json());
      ST.rows = d.rows || [];
      ST.totals = d.totals || {};
    } catch (e) { ST.err = String(e); }
    ST.loading = false; render();
  }

  function _loadFilters() {
    if (ST.filters || ST._filtersLoading) return;
    ST._filtersLoading = true;
    fetch(api.base + '/api/taxi-delay/filters', { headers: api.h() })
      .then(r => r.json())
      .then(d => { ST.filters = d; ST._filtersLoading = false; if (S.screen === 'transport') render(); })
      .catch(() => { ST.filters = { months: [], states: [], stateLabels: {}, unitsByState: {} }; ST._filtersLoading = false; if (S.screen === 'transport') render(); });
  }

  window.tdApply = async function() {
    const mon = document.getElementById('td-month')?.value || '';
    const sta = document.getElementById('td-state')?.value || '';
    const uni = document.getElementById('td-unit')?.value  || '';
    if (!mon) return;
    ST.month = mon; ST.state = sta; ST.unit = uni;
    await _load(mon, sta, uni);
  };

  window.tdStateChange = function() {
    const sta = document.getElementById('td-state')?.value || '';
    const uSel = document.getElementById('td-unit');
    if (!uSel || !ST.filters) return;
    const units = (ST.filters.unitsByState || {})[sta] || [];
    uSel.innerHTML = '<option value="">— All Units —</option>' +
      units.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    uSel.disabled = !units.length;
  };

  window.tdDownload = function(fmt) {
    const mon = ST.month || document.getElementById('td-month')?.value || '';
    const sta = ST.state || document.getElementById('td-state')?.value || '';
    const uni = ST.unit  || document.getElementById('td-unit')?.value  || '';
    if (!mon) return;
    const qs = new URLSearchParams({ month: mon, format: fmt });
    if (sta) qs.set('state', sta);
    if (uni) qs.set('unit', uni);
    const a = document.createElement('a');
    a.href = api.base + '/api/taxi-delay/download?' + qs;
    a.click();
  };

  async function _loadDrill(vno, route, sub, unit) {
    ST.drillVehicle = { vehicle_no: vno, route_name: route, sub_route_name: sub, unit_name: unit };
    ST.drillData = null; ST.drillLoading = true;
    render();
    try {
      const qs = new URLSearchParams({ month: ST.month || '', vehicle_no: vno, route_name: route });
      if (sub && sub !== '-') qs.set('sub_route_name', sub);
      const d = await fetch(api.base + '/api/taxi-delay/route-detail?' + qs, { headers: api.h() }).then(r => r.json());
      ST.drillData = d.rows || [];
    } catch(e) { ST.drillData = []; }
    ST.drillLoading = false;
    render();
  }

  window.tdDrill = function(el) {
    _loadDrill(el.dataset.vno, el.dataset.route, el.dataset.sub, el.dataset.unit);
  };

  window.tdDrillBack = function() {
    ST.drillVehicle = null; ST.drillData = null;
    render();
  };

  window.tdViewDrops = function(repDate, unitName) {
    S.live.txFilterDate = repDate;
    if (!S.live.txFilter) S.live.txFilter = { state: '', unit: '', open: false };
    S.live.txFilter.unit = unitName;
    S.live.delivery = null;
    S.drill = { level: 'unit', metric: 'delivery', unitName: null, routeCode: null, subRouteName: null };
    S.live.txTab = 'delivery';
    setTimeout(fetchDashboard, 0);
    render();
  };

  window._renderTaxiDelayTab = function() {
    _loadFilters();
    const f = ST.filters || {};
    const months = f.months || [];
    const states = f.states || [];
    const stateLabels = f.stateLabels || {};
    const curMonth = ST.month || months[0] || '';
    const curState = ST.state || '';
    const curUnit  = ST.unit  || '';
    const units = (f.unitsByState || {})[curState] || [];

    const rows   = ST.rows   || [];
    const totals = ST.totals || {};

    const fmtN = v => v == null ? '—' : Number(v).toLocaleString('en-IN');
    const fmtK = v => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN');

    const filterBar = `
      <div class="vz-sec" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:16px;padding:14px 18px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Month</label>
          <select id="td-month" style="padding:7px 10px;border-radius:8px;border:1px solid var(--brd);background:var(--surf);color:var(--ink);font-size:13px">
            ${months.map(m => `<option value="${m}" ${m===curMonth?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">State</label>
          <select id="td-state" onchange="tdStateChange()" style="padding:7px 10px;border-radius:8px;border:1px solid var(--brd);background:var(--surf);color:var(--ink);font-size:13px">
            <option value="">— All States —</option>
            ${states.map(s => `<option value="${s}" ${s===curState?'selected':''}>${esc(stateLabels[s]||s)}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Unit</label>
          <select id="td-unit" ${!curState?'disabled':''} style="padding:7px 10px;border-radius:8px;border:1px solid var(--brd);background:var(--surf);color:var(--ink);font-size:13px;min-width:180px">
            <option value="">— All Units —</option>
            ${units.map(u => `<option value="${esc(u)}" ${u===curUnit?'selected':''}>${esc(u)}</option>`).join('')}
          </select>
        </div>
        <button class="btn" onclick="tdApply()" style="padding:6px 14px;font-size:13px;align-self:flex-end">Apply</button>
        <div style="flex:1"></div>
        <button class="btn sm" onclick="tdDownload('csv')"  style="align-self:flex-end;gap:4px">⬇ CSV</button>
        <button class="btn sm" onclick="tdDownload('xlsx')" style="align-self:flex-end;gap:4px">⬇ Excel</button>
      </div>`;

    let body = '';
    if (ST.loading) {
      body = `<div style="padding:40px;text-align:center;color:var(--txt2)">Loading…</div>`;
    } else if (ST.err) {
      body = `<div style="padding:40px;text-align:center;color:#e55">Error: ${esc(ST.err)}</div>`;
    } else if (!ST.month && !rows.length) {
      body = `<div style="padding:40px;text-align:center;color:var(--txt2)">Select a month and click Apply to generate the report.</div>`;
    } else if (!rows.length) {
      body = `<div style="padding:40px;text-align:center;color:var(--txt2)">No data for selected filters.</div>`;
    } else {
      const thStyle = 'padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--txt2);border-bottom:2px solid var(--brd);white-space:nowrap';
      const tdStyle = 'padding:7px 10px;font-size:12px;border-bottom:1px solid var(--brd);white-space:nowrap';
      const numTd  = `${tdStyle};text-align:right;font-variant-numeric:tabular-nums`;
      const penTd  = `${numTd};color:${totals.penalty>0?'#e55':'var(--txt)'}`;

      const byState = {};
      for (const r of rows) {
        const s = r.state || '?';
        if (!byState[s]) byState[s] = {};
        if (!byState[s][r.unit_name]) byState[s][r.unit_name] = [];
        byState[s][r.unit_name].push(r);
      }

      let tableRows = '';
      for (const state of Object.keys(byState).sort()) {
        for (const unitName of Object.keys(byState[state]).sort()) {
          const unitRows = byState[state][unitName];
          const uTotals = {
            total_app_km: unitRows.reduce((s,r)=>s+parseFloat(r.total_app_km||0),0).toFixed(1),
            app_running_days: unitRows.reduce((s,r)=>s+parseInt(r.app_running_days||0),0),
            delay_mins: unitRows.reduce((s,r)=>s+parseInt(r.delay_mins||0),0),
            penalty: unitRows.reduce((s,r)=>s+parseInt(r.penalty||0),0),
          };
          for (let i=0; i<unitRows.length; i++) {
            const r = unitRows[i];
            const isFirst = i===0;
            tableRows += `<tr>
              ${isFirst ? `<td rowspan="${unitRows.length}" style="${tdStyle};font-weight:700;vertical-align:top;border-right:1px solid var(--brd)">${esc(state)}</td>
              <td rowspan="${unitRows.length}" style="${tdStyle};vertical-align:top;border-right:1px solid var(--brd)">${esc(unitName)}</td>` : ''}
              <td style="${tdStyle}">${esc(r.vehicle_no)}</td>
              <td style="${tdStyle}"><button onclick="tdDrill(this)" data-vno="${esc(r.vehicle_no)}" data-route="${esc(r.route_name)}" data-sub="${esc(r.sub_route_name)}" data-unit="${esc(r.unit_name)}" style="background:none;border:none;color:var(--acc);cursor:pointer;font-size:12px;padding:0;text-decoration:underline;text-align:left">${esc(r.route_name)}</button></td>
              <td style="${tdStyle};color:var(--txt2)">${r.sub_route_name && r.sub_route_name !== '-' ? `<button onclick="tdDrill(this)" data-vno="${esc(r.vehicle_no)}" data-route="${esc(r.route_name)}" data-sub="${esc(r.sub_route_name)}" data-unit="${esc(r.unit_name)}" style="background:none;border:none;color:var(--acc);cursor:pointer;font-size:12px;padding:0;text-decoration:underline;text-align:left">${esc(r.sub_route_name)}</button>` : esc(r.sub_route_name)}</td>
              <td style="${numTd}">${fmtN(r.route_master_km)}</td>
              <td style="${numTd}">${fmtN(r.total_app_km)}</td>
              <td style="${numTd}">${r.app_running_days}</td>
              <td style="${numTd}">${fmtN(r.delay_mins)}</td>
              <td style="${r.penalty>0?penTd:numTd}">${r.penalty>0 ? fmtK(r.penalty) : '—'}</td>
            </tr>`;
          }
          if (unitRows.length > 1) {
            tableRows += `<tr style="background:var(--surf2)">
              <td colspan="5" style="${tdStyle};font-weight:700;color:var(--txt2)">Total — ${esc(unitName)}</td>
              <td style="${numTd}"></td>
              <td style="${numTd};font-weight:700">${fmtN(uTotals.total_app_km)}</td>
              <td style="${numTd};font-weight:700">${fmtN(uTotals.app_running_days)}</td>
              <td style="${numTd};font-weight:700">${fmtN(uTotals.delay_mins)}</td>
              <td style="${uTotals.penalty>0?penTd:numTd};font-weight:700">${uTotals.penalty>0 ? fmtK(uTotals.penalty) : '—'}</td>
            </tr>`;
          }
        }
      }

      tableRows += `<tr style="background:var(--acc);color:#fff">
        <td colspan="7" style="padding:8px 10px;font-size:12px;font-weight:700">Grand Total — ${rows.length} vehicles</td>
        <td style="${numTd};color:#fff;font-weight:700">${fmtN(totals.app_running_days)}</td>
        <td style="${numTd};color:#fff;font-weight:700">${fmtN(totals.delay_mins)} min</td>
        <td style="${numTd};color:#fff;font-weight:700">${fmtK(totals.penalty)}</td>
      </tr>`;

      const summaryKpis = `<div class="vz-kgrid" style="margin-bottom:16px">
        ${vzKpi({ icon:"🚕", label:"Vehicles", value:String(rows.length), sub:"in report", status:"fl" })}
        ${vzKpi({ icon:"📅", label:"Running Days", value:fmtN(totals.app_running_days), sub:"app active", status:"up" })}
        ${vzKpi({ icon:"⏱️", label:"Total Delay", value:fmtN(totals.delay_mins)+' min', sub:"cumulative", status:(totals.delay_mins||0)>0?"dn":"up" })}
        ${vzKpi({ icon:"💰", label:"Penalty", value:fmtK(totals.penalty), sub:"total deduction", status:(totals.penalty||0)>0?"dn":"up" })}
      </div>`;
      body = summaryKpis + `<div style="overflow-x:auto;border-radius:10px;border:1px solid var(--brd)">
        <table style="width:100%;border-collapse:collapse">
          <thead style="background:var(--surf2)">
            <tr>
              <th style="${thStyle}">State</th>
              <th style="${thStyle}">Unit</th>
              <th style="${thStyle}">Vehicle No.</th>
              <th style="${thStyle}">Route</th>
              <th style="${thStyle}">Sub Route</th>
              <th style="${thStyle};text-align:right">Mast KM</th>
              <th style="${thStyle};text-align:right">Max App KM</th>
              <th style="${thStyle};text-align:right">Days</th>
              <th style="${thStyle};text-align:right">Delay (min)</th>
              <th style="${thStyle};text-align:right">Penalty</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;
    }

    // ── Drill panel: date-wise detail for one vehicle+route ──────────────────
    if (ST.drillVehicle) {
      const dv = ST.drillVehicle;
      const th2 = 'padding:7px 8px;text-align:left;font-size:11px;font-weight:700;color:var(--txt2);border-bottom:2px solid var(--brd);white-space:nowrap';
      const td2 = 'padding:6px 8px;font-size:12px;border-bottom:1px solid var(--brd);white-space:nowrap';
      const n2  = `${td2};text-align:right;font-variant-numeric:tabular-nums`;
      let drillContent = '';
      if (ST.drillLoading) {
        drillContent = '<div style="padding:30px;text-align:center;color:var(--txt2)">Loading…</div>';
      } else if (!ST.drillData || !ST.drillData.length) {
        drillContent = '<div style="padding:30px;text-align:center;color:var(--txt2)">No records found.</div>';
      } else {
        const drillRows = ST.drillData.map(r => {
          const late = r.actual_dep && r.sched_dep && r.actual_dep > r.sched_dep;
          return `<tr>
            <td style="${td2};font-weight:600">${r.rep_date_short}</td>
            <td style="${td2};color:var(--muted);font-size:11px">${r.reg_cas}${r.casual_reason ? ' · ' + esc(r.casual_reason) : ''}</td>
            <td style="${td2}">${r.sched_dep || '—'}</td>
            <td style="${td2};color:${late ? '#dc2626' : 'var(--txt)'};font-weight:${late ? '700' : '400'}">${r.actual_dep || '—'}</td>
            <td style="${td2}">${esc(r.start_location || '—')}</td>
            <td style="${td2}">${esc(r.last_location || '—')}</td>
            <td style="${td2}">${r.reached_time || '—'}</td>
            <td style="${n2}">${r.route_master_km || '—'}</td>
            <td style="${n2}${r.route_master_km && parseFloat(r.total_app_km) > parseFloat(r.route_master_km) ? ';color:#d97706' : ''}">${r.total_app_km || '—'}${r.route_master_km && parseFloat(r.total_app_km) > parseFloat(r.route_master_km) ? ' ⚠️' : ''}</td>
            <td style="${n2};color:${r.taxi_delayed_mins > 0 ? '#d97706' : 'var(--txt)'}">${r.taxi_delayed_mins > 0 ? r.taxi_delayed_mins + ' min' : '—'}</td>
            <td style="${n2};color:${r.delay_mins > 0 ? '#dc2626' : 'var(--txt)'}">${r.delay_mins > 0 ? r.delay_mins + ' min' : '—'}</td>
            <td style="${n2};color:${r.penalty > 0 ? '#dc2626' : 'var(--txt)'}">${r.penalty > 0 ? '₹' + r.penalty : '—'}</td>
            <td style="${td2}"><button onclick="tdViewDrops('${r.rep_date}','${esc(dv.unit_name)}')" style="font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid var(--brd);background:var(--surf2);color:var(--acc);cursor:pointer;white-space:nowrap">📍 View Drops</button></td>
          </tr>`;
        }).join('');
        drillContent = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
          <thead style="background:var(--surf2)"><tr>
            <th style="${th2}">Date</th>
            <th style="${th2}">Type</th>
            <th style="${th2}">Sched Dep</th>
            <th style="${th2}">Actual Dep</th>
            <th style="${th2}">Start</th>
            <th style="${th2}">Last Location</th>
            <th style="${th2}">Reached</th>
            <th style="${th2};text-align:right">Route KM</th>
            <th style="${th2};text-align:right">App KM</th>
            <th style="${th2};text-align:right">Total Delay</th>
            <th style="${th2};text-align:right">Penalty Delay</th>
            <th style="${th2};text-align:right">Penalty</th>
            <th style="${th2}">Delivery Detail</th>
          </tr></thead>
          <tbody>${drillRows}</tbody>
        </table></div>`;
      }
      body = `<div style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
          <button onclick="tdDrillBack()" style="padding:5px 12px;border-radius:7px;border:1px solid var(--brd);background:var(--surf2);color:var(--txt);cursor:pointer;font-size:12px;white-space:nowrap">← Back to Report</button>
          <div>
            <span style="font-weight:700;font-size:13px;color:var(--txt)">${esc(dv.vehicle_no)}</span>
            <span style="color:var(--acc);font-size:12px;margin-left:8px">${esc(dv.route_name)}${dv.sub_route_name && dv.sub_route_name !== '-' ? ' · ' + esc(dv.sub_route_name) : ''}</span>
            <span style="color:var(--muted);font-size:11px;margin-left:8px">${esc(dv.unit_name)} · ${ST.month || ''}</span>
          </div>
        </div>
        <div style="border:1px solid var(--brd);border-radius:10px;overflow:hidden">${drillContent}</div>
      </div>`;
    }

    return filterBar + body;
  };

  VIEWS.taxi_delay = function() {
    S.live.txTab = 'delay_report';
    go('transport');
    return '';
  };
})();

VIEWS.drill = () => {
  const u = S.user;
  const d = S.drill || {};
  const metric = d.metric || "delivery";
  const level  = d.level  || "zone";
  const MLABEL = { delivery:"Delivery Detail", collections:"Collections Detail",
                   outstanding:"Outstanding Detail", complaints:"Complaints Detail", approvals:"Approvals",
                   supply:"Supply Detail", collection:"Collection Detail" };

  /* breadcrumb */
  const bc = item => `<button class="btn sm" style="font-size:11px" onclick="${item.fn}">${item.label}</button>`;
  const crumbs = [bc({ label:"← Dashboard", fn:"go('command')" })];
  if ((level === "route" || level === "droppoint") && d.zoneId) {
    /* came via Zone → Branch → Unit (live route data) */
    const z = ZONES_DATA.find(x=>x.id===d.zoneId);
    crumbs.push(bc({ label:"All Zones", fn:"drillBack('zone')" }));
    crumbs.push(bc({ label: z ? z.name : "Zone", fn:"drillBack('branch')" }));
    if (level === "droppoint" && d.unitName)
      crumbs.push(bc({ label: esc(d.unitName), fn:"drillBack('route')" }));
  } else if ((level === "route" || level === "droppoint") && d.unitName) {
    /* came via live unit list */
    crumbs.push(bc({ label:"All Units", fn:"drillBack('unit')" }));
    crumbs.push(bc({ label: esc(d.unitName), fn:"drillBack('route')" }));
  }
  if (level === "droppoint" && d.routeCode) {
    crumbs.push(bc({ label: esc(d.routeCode), fn:"drillBack('route')" }));
    if (d.subRouteName)
      crumbs.push(`<span style="font-size:11px;padding:4px 8px;background:var(--surf2);border-radius:9px;font-weight:700;color:var(--acc)">${esc(d.subRouteName)} · LINK</span>`);
  }
  /* static hierarchy breadcrumbs */
  if (d.zoneId  && (level==="branch"||level==="agency"||level==="hawker")) {
    const z = ZONES_DATA.find(x=>x.id===d.zoneId);
    crumbs.push(bc({ label: z ? z.name : "Zone", fn:"drillBack('zone')" }));
  }
  if (d.branchId && (level==="agency"||level==="hawker")) {
    const b = BRANCHES_DATA.find(x=>x.id===d.branchId);
    crumbs.push(bc({ label: b ? b.name : "Branch", fn:"drillBack('branch')" }));
  }
  if (d.agencyId && level==="hawker") {
    const a = AGENCIES_DATA.find(x=>x.id===d.agencyId);
    crumbs.push(bc({ label: a ? a.name : "Agency", fn:"drillBack('agency')" }));
  }
  const crumbBar = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${crumbs.join(" ")}</div>`;

  /* metric tabs */
  const metrics = ["delivery","supply","collection","outstanding","complaints"];
  const tabs = `<div class="seg" style="margin-bottom:14px">${metrics.map(m=>
    `<button class="${m===metric?"on":""}" onclick="S.drill.metric='${m}';render()">${(MLABEL[m]||m).split(" ")[0]}</button>`
  ).join("")}</div>`;

  /* level label */
  const LLABEL = {
    unit: metric === "outstanding" ? "Outstanding — All Units"
        : metric === "supply"      ? "Supply — All Units"
        : metric === "collection"  ? "Collection — All Units"
        : "All RP Units — live data",
    route: metric === "outstanding" ? (d.unitName ? `Outstanding — ${d.unitName}` : "Outstanding — Agencies")
         : metric === "supply"      ? (d.unitName ? `Supply — ${d.unitName}` : "Supply — Agencies")
         : (d.unitName ? `Routes in ${d.unitName}` : "Routes"),
    droppoint: d.subRouteName ? `Drop Points — ${d.subRouteName} (LINK)` : d.routeCode ? `Drop Points — ${d.routeCode}` : "Drop Points",
    zone:"All Zones", branch:"Zone → Branches", agency:"Branch → Agencies", hawker:"Agency → Routes / Hawkers"
  };

  let body = "";

  if (level === "unit") {
    if (metric === "outstanding")   body = renderLiveOutstandingUnits();
    else if (metric === "supply")   body = renderLiveSupplyUnits();
    else if (metric === "collection") body = renderLiveCollectionUnits();
    else                            body = renderLiveUnits();
  } else if (level === "route") {
    if (metric === "outstanding")   body = renderLiveOutstandingAgencies(d.unitName);
    else if (metric === "supply")   body = renderLiveSupplyAgencies(d.unitName);
    else                            body = renderLiveRoutes(d.unitName);
  } else if (level === "droppoint") {
    body = renderLiveDropPoints(d.routeCode, d.subRouteName);
  } else if (level === "zone") {
    body = renderDrillZone(metric);
  } else if (level === "branch") {
    const list = BRANCHES_DATA.filter(b => !d.zoneId || b.zone_id === d.zoneId);
    body = renderDrillBranch(metric, list);
  } else if (level === "agency") {
    const list = AGENCIES_DATA.filter(a => !d.branchId || a.branch_id === d.branchId);
    body = renderDrillAgency(metric, list);
  } else {
    body = renderDrillHawker(metric);
  }

  return pagehead(MLABEL[metric] || metric, LLABEL[level] || level) + crumbBar + tabs + body;
};

/* ---- Live delivery render functions ---- */
function renderLiveUnits(unitsOverride) {
  const ld = S.live.delivery;
  if (!ld) {
    if (!S.live._loading) setTimeout(fetchDashboard, 0);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading live delivery data…</div>`;
  }
  const rows = (unitsOverride || ld.units).map(u => {
    const cls = u.otd_pct >= 70 ? "up" : u.otd_pct >= 50 ? "fl" : "dn";
    const dCls = u.cnt_delayed > 0 ? "dn" : "up";
    return `<tr class="rowbtn" onclick="drillInto(${esc(JSON.stringify(u.unit_name))})">
      <td><b>${esc(u.unit_name)}</b><small style="display:block;color:var(--muted)">${u.routes} routes · supply ${fmtN(u.supply)}</small></td>
      <td class="r num ${dCls}">${u.cnt_delayed}</td>
      <td class="r num up">${u.on_time}</td>
      <td class="r num ${cls}">${u.otd_pct}%</td>
      <td class="r num">${fmtN(u.actual_km)} km</td>
      <td class="r num">${fmtN(u.delivered_drops)}</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`;
  }).join("");
  const sm = ld.summary;
  const summaryBar = `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon:"🛣️", label:"Total Routes", value:String(sm.total_routes||0), sub:ld.date, status:"fl" })}
    ${vzKpi({ icon:"📦", label:"Supply", value:fmtN(sm.total_supply), sub:"copies dispatched", status:"up" })}
    ${vzKpi({ icon:"✅", label:"OTD", value:(sm.otd_pct||0)+'%', sub:"on-time delivery", status:(sm.otd_pct||0)>=70?"up":"dn" })}
    ${vzKpi({ icon:"📍", label:"App KM", value:fmtN(sm.actual_km), sub:"recorded by app", status:"fl" })}
    ${vzKpi({ icon:"📬", label:"Delivered", value:fmtN(sm.delivered_drops), sub:"drop points", status:"up" })}
    ${vzKpi({ icon:"⚠️", label:"Missed", value:fmtN(sm.missed_drops), sub:"not delivered", status:(sm.missed_drops||0)>0?"dn":"up" })}
  </div>`;
  return summaryBar + table(["RP Unit", ">Delayed", ">On-Time", ">OTD%", ">App KM", ">Drops Delivered", ""], [rows]);
}

function renderLiveRoutes(unitName) {
  if (!unitName) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">No unit selected.</div>`;
  const txDate = S.live.txFilterDate;
  const key = "routes_" + unitName + (txDate ? "_" + txDate : "");
  const rd = S.live[key];
  if (!rd) {
    fetchRoutes(unitName);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading routes for <b>${esc(unitName)}</b>…</div>`;
  }
  const rows = rd.routes.map(r => {
    const dCls = r.is_delayed ? "dn" : "up";
    const depTime = r.actual_departure || r.scheduled_departure || "—";
    const isLink = r.taxi_type === 'LINK' && r.sub_route_name && r.sub_route_name !== '-';
    const onArgs = isLink
      ? `${esc(JSON.stringify(r.route_name))},${esc(JSON.stringify(r.sub_route_name))}`
      : esc(JSON.stringify(r.route_code || r.route_name));
    const subLabel = isLink
      ? `<small style="display:block;color:var(--acc);font-weight:600">↳ ${esc(r.sub_route_name)} · LINK</small>`
      : (r.sub_route_name && r.sub_route_name !== '-' ? `<small style="display:block;color:var(--muted)">${esc(r.sub_route_name)}</small>` : '');
    return `<tr class="rowbtn" onclick="drillIntoRoute(${onArgs})">
      <td><b>${esc(r.route_name)}</b>${subLabel}</td>
      <td class="r num">${fmtN(r.bundles||r.supply)}</td>
      <td class="r">${esc(r.vehicle_no||"—")}</td>
      <td class="r">${esc(depTime)}</td>
      <td class="r num ${dCls}">${r.delay_minutes != null ? (r.delay_minutes > 0 ? "+"+r.delay_minutes : r.delay_minutes) : "—"} min</td>
      <td class="r num">${r.planned_km != null ? r.planned_km+" km" : "—"}</td>
      <td class="r num">${r.actual_km != null ? r.actual_km+" km" : "—"}</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`;
  }).join("");
  return `<div style="color:var(--muted);font-size:12px;margin-bottom:8px">${rd.routes.length} routes · ${esc(rd.date)}</div>` +
    table(["Route / Sub-route", ">Supply", ">Vehicle", ">Departure", ">Delay", ">Plan KM", ">App KM", ""], [rows]);
}

function renderLiveDropPoints(routeCode, subRouteName) {
  if (!routeCode) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">No route selected.</div>`;
  const txDate = S.live.txFilterDate;
  const key = (txDate ? txDate + "_" : "") + "dp_" + routeCode + (subRouteName ? "|" + subRouteName : "");
  const dp = S.live[key];
  if (!dp) {
    fetchDropPoints(routeCode, subRouteName);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading drop points for <b>${esc(subRouteName || routeCode)}</b>…</div>`;
  }
  // If both scheduled and actual are blank, treat as Missed and exclude km from total
  let pts = dp.drop_points.map(p => ({
    ...p,
    _missed: !p.actual_arrival && !p.scheduled_arrival ? true : p.status !== 'delivered'
  }));
  // Issue 4: first drop = dispatch start; show 0 km, add its km to second drop
  const _firstKm = parseFloat(pts[0]?.api_distance ?? pts[0]?.actual_km) || 0;
  pts = pts.map((p, i) => {
    const rawKm = parseFloat(p.api_distance ?? p.actual_km) || 0;
    return { ...p, _displayKm: i === 0 ? 0 : i === 1 ? rawKm + _firstKm : rawKm };
  });
  // Issue 2: same GPS lat-long + same actual_arrival = bundle drop
  // Pass 1: build per-cluster km totals and first-occurrence index
  const _bundleMap = new Map(); // key -> { firstIdx, totalKm }
  pts.forEach((p, i) => {
    if (i === 0 || p._missed || !p.actual_arrival || !p.actual_lat || !p.actual_long) return;
    const bk = `${p.actual_lat}|${p.actual_long}|${p.actual_arrival}`;
    if (!_bundleMap.has(bk)) _bundleMap.set(bk, { firstIdx: i, totalKm: p._displayKm || 0 });
    else _bundleMap.get(bk).totalKm += p._displayKm || 0;
  });
  // Pass 2: assign cluster total km to first occurrence; mark rest _bundleDup
  pts = pts.map((p, i) => {
    if (i === 0 || p._missed || !p.actual_arrival || !p.actual_lat || !p.actual_long) return p;
    const bk = `${p.actual_lat}|${p.actual_long}|${p.actual_arrival}`;
    const bundle = _bundleMap.get(bk);
    if (!bundle || bundle.firstIdx === i) return bundle ? { ...p, _displayKm: bundle.totalKm } : p;
    return { ...p, _bundleDup: true };
  });
  const rows = pts.map(p => {
    const status = !p._missed ? `<span class="chip ok" style="font-size:11px">Delivered</span>`
                               : `<span class="chip crit" style="font-size:11px">Missed</span>`;
    // Cross-midnight fix: if diff > 720 min (12h), actual was previous night → early departure
    let _dm = p.diff_minutes != null ? parseInt(p.diff_minutes) : null;
    if (_dm != null && _dm > 720) _dm = _dm - 1440;
    const diff = p._missed ? '<span style="color:var(--muted)">—</span>'
      : _dm == null ? '—'
      : _dm > 0 ? `<span class="dn">+${_dm}m</span>`
      : _dm < 0 ? `<span class="up">${_dm}m</span>`
      : '<span style="color:var(--muted)">0m</span>';
    const kmVal = p._missed || p._bundleDup ? null : p._displayKm;
    const km = kmVal != null ? `${parseFloat(kmVal).toFixed(2)} km` : "—";
    const supplyVal = Number(p.supply) || 0;
    const supplyCell = p._missed
      ? '<span style="color:var(--muted)">—</span>'
      : `<span class="num">${fmtN(supplyVal)}</span>`;
    return `<tr>
      <td><b>${esc(p.drop_point_name)}</b></td>
      <td class="r">${supplyCell}</td>
      <td class="r">${p.scheduled_arrival||"—"}</td>
      <td class="r">${p.actual_arrival||"—"}</td>
      <td class="r">${diff}</td>
      <td class="r num">${km}</td>
      <td class="r">${status}</td></tr>`;
  }).join("");
  const deliveredCount = pts.filter(p => !p._missed).length;
  const missedCount    = pts.filter(p =>  p._missed).length;
  const totalKm = pts.slice(1).filter(p => !p._missed && !p._bundleDup)
    .reduce((s, p) => s + p._displayKm, 0).toFixed(2);
  const totalSupply = pts.filter(p => !p._missed).reduce((s, p) => s + (Number(p.supply) || 0), 0);
  return `<div style="display:flex;gap:16px;font-size:13px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
    <span>Date: <b>${esc(dp.date)}</b></span>
    <span class="up">Delivered: <b>${fmtN(deliveredCount)}</b></span>
    <span class="dn">Missed: <b>${fmtN(missedCount)}</b></span>
    <span>Supply: <b>${fmtN(totalSupply)}</b> copies</span>
    <button class="btn sm" onclick="showRouteMap(${esc(JSON.stringify(routeCode))},${esc(JSON.stringify(subRouteName||null))})" title="View route on map" style="margin-left:auto;font-size:12px;padding:4px 10px">🗺️ Map</button>
  </div>` +
  table(["Drop Point", ">Supply", ">Scheduled", ">Actual", ">Diff", ">API Km", ">Status"], [rows]) +
  `<div style="text-align:right;font-size:13px;font-weight:600;padding:8px 12px;border-top:2px solid var(--border);margin-top:-1px">
    Total distance covered: <span class="num">${totalKm} km</span> &nbsp;·&nbsp; Total supply: <span class="num">${fmtN(totalSupply)} copies</span>
  </div>`;
}

window.showRouteMap = function(routeCode, subRouteName) {
  const txDate = S.live.txFilterDate;
  const key = (txDate ? txDate + "_" : "") + "dp_" + routeCode + (subRouteName ? "|" + subRouteName : "");
  const dp = S.live[key];
  if (!dp || !dp.drop_points) { toast("No route data loaded"); return; }

  function validLL(lat, lon) { return lat >= 8 && lat <= 37 && lon >= 68 && lon <= 97; }

  // Build stop list: registered GPS = planned position; actual GPS = where driver was
  const pts = dp.drop_points.map((p, i) => {
    const aLat = parseFloat(p.actual_lat), aLon = parseFloat(p.actual_long);
    const rLat = parseFloat(p.reg_lat),    rLon = parseFloat(p.reg_long);
    const aOk = validLL(aLat, aLon), rOk = validLL(rLat, rLon);
    return {
      ...p,
      rLat: rOk ? rLat : null, rLon: rOk ? rLon : null,   // registered (planned)
      aLat: aOk ? aLat : null, aLon: aOk ? aLon : null,   // actual (driver GPS)
      seq: i + 1
    };
  });

  const withReg = pts.filter(p => p.rLat != null);
  const withAct = pts.filter(p => p.aLat != null);
  const anyGps  = withReg.length || withAct.length;
  if (!anyGps) { toast("No GPS coordinates available for this route"); return; }

  // Google Maps link using registered GPS sequence (up to 23 waypoints)
  const gmBase = (withReg.length ? withReg : withAct).slice(0, 23);
  const gmMids = gmBase.slice(1, -1).map(p => `${p.rLat||p.aLat},${p.rLon||p.aLon}`).join('/');
  const gmUrl  = `https://www.google.com/maps/dir/${gmBase[0].rLat||gmBase[0].aLat},${gmBase[0].rLon||gmBase[0].aLon}/` +
                 (gmMids ? gmMids + '/' : '') +
                 `${gmBase[gmBase.length-1].rLat||gmBase[gmBase.length-1].aLat},${gmBase[gmBase.length-1].rLon||gmBase[gmBase.length-1].aLon}`;

  const sc = modal(
    `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;flex-wrap:wrap">` +
      `<div><div style="font-size:15px;font-weight:700">${esc(routeCode)}</div>` +
      `<div style="font-size:11px;color:var(--muted)">${dp.drop_points.length} stops · ${esc(dp.date)}</div></div>` +
      `<div style="display:flex;gap:8px;align-items:center">` +
        `<a href="${gmUrl}" target="_blank" rel="noopener" style="font-size:12px;color:var(--acc);text-decoration:none;white-space:nowrap">↗ Google Maps</a>` +
        `<button class="btn sm" onclick="closeModals()" style="font-size:12px">✕ Close</button>` +
      `</div></div>` +
    `<div id="pvs-map" style="width:100%;height:480px;border-radius:8px;overflow:hidden;border:1px solid var(--border)"></div>` +
    `<div style="display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:8px;flex-wrap:wrap">` +
      `<span><span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#1d4ed8;color:#fff;font-size:9px;font-weight:700;line-height:18px;text-align:center;vertical-align:middle;margin-right:4px">N</span>Numbered stop (registered GPS)</span>` +
      `<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;border:2px solid #fff;vertical-align:middle;margin-right:4px"></span>Actual driver location</span>` +
    `</div>`
  );
  const mEl = sc.querySelector('.modal');
  if (mEl) { mEl.style.maxWidth = '820px'; mEl.style.width = '96vw'; }

  function numIcon(seq, delivered) {
    const bg = seq === 1 ? '#dc2626' : delivered ? '#16a34a' : '#6b7280';
    return L.divIcon({
      className: '',
      html: `<div style="background:${bg};color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);line-height:1">${seq}</div>`,
      iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -14]
    });
  }

  function renderMap() {
    const container = document.getElementById('pvs-map');
    if (!container || !window.L) return;
    const map = L.map(container, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom: 18
    }).addTo(map);

    // Dashed polyline through registered GPS sequence (planned route)
    const regLl = withReg.map(p => [p.rLat, p.rLon]);
    if (regLl.length > 1)
      L.polyline(regLl, { color: '#2563eb', weight: 3, opacity: 0.75, dashArray: '8 5' }).addTo(map);

    // Solid polyline through actual driver GPS (unique positions only)
    const actLl = withAct.map(p => [p.aLat, p.aLon]);
    const uniqAct = actLl.filter((ll, i) =>
      i === 0 || ll[0] !== actLl[i-1][0] || ll[1] !== actLl[i-1][1]
    );
    if (uniqAct.length > 1)
      L.polyline(uniqAct, { color: '#f59e0b', weight: 2.5, opacity: 0.9 }).addTo(map);

    // Numbered markers at registered GPS for every stop
    pts.forEach(p => {
      const lat = p.rLat, lon = p.rLon;
      if (lat == null) return;
      // Same _missed logic as renderLiveDropPoints: blank sched + blank actual = missed
      const isMissed = (!p.actual_arrival && !p.scheduled_arrival) ? true : p.status !== 'delivered';
      const delivered = !isMissed;
      const marker = L.marker([lat, lon], { icon: numIcon(p.seq, delivered) }).addTo(map);
      const kmVal = p.api_distance != null ? p.api_distance : (p.actual_km != null ? p.actual_km : '—');
      let _dm = p.diff_minutes != null ? parseInt(p.diff_minutes) : null;
      if (_dm != null && _dm > 720) _dm = _dm - 1440;
      const diff  = _dm == null ? '—' : _dm > 0 ? '+' + _dm + 'm' : _dm + 'm';
      const gpsNote = p.aLat ? `<br><span style="color:#888;font-size:10px">Driver at: ${p.aLat.toFixed(4)},${p.aLon.toFixed(4)}</span>` : '';
      marker.bindTooltip(
        `<b>${p.drop_point_name}</b><br>` +
        `Actual: <b>${p.actual_arrival || '—'}</b> &nbsp; Diff: <b>${diff}</b>`,
        { permanent: false, direction: 'top', opacity: 0.95 }
      );
      marker.bindPopup(
        `<b style="font-size:13px">Stop ${p.seq}: ${p.drop_point_name}</b><br>` +
        `Sched: <b>${p.scheduled_arrival || '—'}</b> &nbsp; Actual: <b>${p.actual_arrival || '—'}</b><br>` +
        `Diff: <b>${diff}</b> &nbsp; API KM: <b>${kmVal} km</b><br>` +
        `<span style="color:${delivered ? '#16a34a' : '#6b7280'};font-weight:600">${delivered ? '✓ Delivered' : '✗ Missed'}</span>` + gpsNote
      );
    });

    // Small orange dots at actual driver GPS positions (where different from reg)
    const seenAct = new Set();
    withAct.forEach(p => {
      const k = `${p.aLat.toFixed(4)},${p.aLon.toFixed(4)}`;
      if (seenAct.has(k)) return; seenAct.add(k);
      L.circleMarker([p.aLat, p.aLon], {
        radius: 5, fillColor: '#f59e0b', color: '#fff', weight: 1.5, opacity: 1, fillOpacity: 0.9
      }).addTo(map).bindTooltip('Driver GPS', { permanent: false });
    });

    // Fit to all registered GPS; fall back to actual if no registered
    const allLl = pts.map(p => [p.rLat || p.aLat, p.rLon || p.aLon]).filter(ll => ll[0] != null);
    if (allLl.length) map.fitBounds(allLl, { padding: [30, 30] });
  }

  if (window.L) {
    setTimeout(renderMap, 80);
  } else {
    if (!document.getElementById('lf-css')) {
      const lnk = document.createElement('link');
      lnk.id = 'lf-css'; lnk.rel = 'stylesheet';
      lnk.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(lnk);
    }
    const scr = document.createElement('script');
    scr.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    scr.onload = () => setTimeout(renderMap, 80);
    document.head.appendChild(scr);
  }
};

function renderLiveOutstandingUnits() {
  const lo = S.live.outstanding;
  if (!lo) {
    if (!S.live._outstandingLoading) setTimeout(fetchOutstanding, 0);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading outstanding data…</div>`;
  }
  const sm = lo.summary;
  const summaryBar = `<div class="card pad" style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px;font-size:13px">
    <span><b>${lo.date}</b></span>
    <span>Agencies: <b>${fmtN(sm.total_agencies)}</b></span>
    <span class="dn">Outstanding: <b>${lakh(sm.total_outstanding)}</b></span>
    <span>Bill: <b>${lakh(sm.total_bill)}</b></span>
    <span class="up">Collected: <b>${lakh(sm.total_collected)}</b></span>
    <span>Avg coll%: <b>${sm.avg_collection_pct}%</b></span>
  </div>`;
  const rows = lo.units.map(un => {
    const cls = un.avg_collection_pct >= 70 ? "up" : un.avg_collection_pct >= 50 ? "fl" : "dn";
    return `<tr class="rowbtn" onclick="drillInto(${esc(JSON.stringify(un.unit_name))})">
      <td><b>${esc(un.unit_name)}</b><small style="display:block;color:var(--muted)">${un.agency_count} agencies · ${un.outstanding_count} with outstanding</small></td>
      <td class="r num dn">${lakh(un.outstanding)}</td>
      <td class="r num">${lakh(un.bill_amount)}</td>
      <td class="r num up">${lakh(un.collected)}</td>
      <td class="r num ${cls}">${un.avg_collection_pct}%</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`;
  }).join("");
  return summaryBar + table(["Unit", ">Outstanding", ">Bill", ">Collected", ">Coll%", ""], [rows]);
}

function renderLiveOutstandingAgencies(unitName) {
  if (!unitName) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">No unit selected.</div>`;
  const key = "outstanding_agencies_" + unitName;
  const data = S.live[key];
  if (!data) {
    fetchOutstandingAgencies(unitName);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading agencies for <b>${esc(unitName)}</b>…</div>`;
  }
  const rows = data.agencies.map(a => {
    const collCls = a.collection_pct >= 70 ? "up" : a.collection_pct >= 50 ? "fl" : "dn";
    const bal = a.closing_debit > 0
      ? `<span class="dn">${lakh(a.closing_debit)} Dr</span>`
      : a.closing_credit > 0
        ? `<span class="up">${lakh(a.closing_credit)} Cr</span>`
        : "—";
    return `<tr>
      <td><b>${esc(a.agency_name)}</b><small style="display:block;color:var(--muted)">${esc(a.ag_code)} · ${esc(a.drop_point||a.district||"")}</small></td>
      <td>${esc(a.executive||"—")}</td>
      <td class="r num">${lakh(a.bill_amount)}</td>
      <td class="r num up">${lakh(a.receipt_amount)}</td>
      <td class="r num ${collCls}">${a.collection_pct}%</td>
      <td class="r num">${bal}</td></tr>`;
  }).join("");
  return `<div style="color:var(--muted);font-size:12px;margin-bottom:8px">${data.agencies.length} agencies · ${esc(unitName)} · ${esc(data.date)}</div>` +
    table(["Agency", "Executive", ">Bill", ">Collected", ">Coll%", ">Balance"], [rows]);
}

function renderLiveSupplyUnits() {
  const ls = S.live.supply;
  if (!ls) {
    if (!S.live._supplyLoading) setTimeout(fetchSupply, 0);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading supply data…</div>`;
  }
  const sm = ls.summary;
  const summaryBar = `<div class="card pad" style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px;font-size:13px">
    <span><b>${ls.date}</b></span>
    <span>Agencies: <b>${fmtN(sm.total_agencies)}</b></span>
    <span>Total copies: <b>${fmtN(sm.total_copies)}</b></span>
    <span>Avg/agency: <b>${Math.round(sm.avg_copies)}</b></span>
  </div>`;
  const rows = ls.units.map(u => {
    return `<tr class="rowbtn" onclick="drillInto(${esc(JSON.stringify(u.unit_name))})">
      <td><b>${esc(u.unit_name)}</b><small style="display:block;color:var(--muted)">${fmtN(u.agencies)} agencies</small></td>
      <td class="r num">${fmtN(u.total_copies)}</td>
      <td class="r num">${Math.round(u.avg_copies)}</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`;
  }).join("");
  return summaryBar + table(["Unit", ">Total Copies", ">Avg/Agency", ""], [rows]);
}

function renderLiveSupplyAgencies(unitName) {
  if (!unitName) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">No unit selected.</div>`;
  const key = "supply_agencies_" + unitName;
  const data = S.live[key];
  if (!data) {
    fetchSupplyAgencies(unitName);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading agencies for <b>${esc(unitName)}</b>…</div>`;
  }
  const rows = data.agencies.map(a => {
    return `<tr>
      <td><b>${esc(a.agency_name || a.ag_code)}</b><small style="display:block;color:var(--muted)">${esc(a.ag_code)}</small></td>
      <td>${esc(a.executive || "—")}</td>
      <td class="r num">${fmtN(a.copies_supplied)}</td></tr>`;
  }).join("");
  return `<div style="color:var(--muted);font-size:12px;margin-bottom:8px">${data.agencies.length} agencies · ${esc(unitName)} · ${esc(data.date)}</div>` +
    table(["Agency", "Executive", ">Copies"], [rows]);
}

function renderLiveCollectionUnits() {
  const lc = S.live.collection;
  if (!lc) {
    if (!S.live._collectionLoading) setTimeout(fetchCollection, 0);
    return `<div class="card pad" style="text-align:center;color:var(--muted);padding:32px">Loading collection data…</div>`;
  }
  const sm = lc.summary;
  const digitalPctTotal = sm.total_collected > 0 ? Math.round(sm.digital_collection / sm.total_collected * 100) : 0;
  const summaryBar = `<div class="card pad" style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px;font-size:13px">
    <span><b>${lc.date}</b></span>
    <span class="up">Collected: <b>${lakh(sm.total_collected)}</b></span>
    <span>Transactions: <b>${fmtN(sm.total_transactions)}</b></span>
    <span>Agencies paid: <b>${fmtN(sm.agencies_paid)}</b></span>
    <span>Digital: <b>${lakh(sm.digital_collection)}</b> (${digitalPctTotal}%)</span>
    <span>Cash: <b>${lakh(sm.physical_cash)}</b></span>
  </div>`;
  const rows = lc.units.map(u => {
    const dpct = u.total_collected > 0 ? Math.round(u.digital_collection / u.total_collected * 100) : 0;
    return `<tr>
      <td><b>${esc(u.unit_name)}</b><small style="display:block;color:var(--muted)">${u.transactions} txns · ${u.agencies_paid} agencies</small></td>
      <td class="r num up">${lakh(u.total_collected)}</td>
      <td class="r num">${lakh(u.digital_collection)}</td>
      <td class="r num">${dpct}%</td></tr>`;
  }).join("");
  return summaryBar + table(["Unit", ">Collected", ">Digital", ">Digital%"], [rows]);
}

function renderDrillZone(metric) {
  if (metric === "delivery") {
    const rows = ZONES_DATA.map(z=>`<tr class="rowbtn" onclick="drillInto(${z.id})">
      <td><b>${z.name}</b><small style="display:block;color:var(--muted)">${z.region} · ${z.branches} branches · ${z.agencies} agencies</small></td>
      <td class="r num">${fmtN(z.copies_plan)}</td><td class="r num">${fmtN(z.copies_del)}</td>
      <td class="r num ${z.missed>3000?"dn":"up"}">${fmtN(z.missed)}</td>
      <td class="r num ${z.otd>=95?"up":z.otd>=92?"fl":"dn"}">${z.otd}%</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`).join("");
    return table(["Zone",">Planned",">Delivered",">Missed",">OTD%",""], [rows]);
  }
  if (metric === "collections" || metric === "outstanding") {
    const rows = ZONES_DATA.map(z=>{
      const pct=Math.round(z.collected/z.due*100);
      return `<tr class="rowbtn" onclick="drillInto(${z.id})">
        <td><b>${z.name}</b><small style="display:block;color:var(--muted)">${z.region} · ${z.branches} branches</small></td>
        <td class="r num">${lakh(z.due)}</td><td class="r num up">${lakh(z.collected)}</td>
        <td class="r num ${pct>=70?"up":pct>=60?"fl":"dn"}">${pct}%</td>
        <td class="r num dn">${lakh(z.out)}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Zone",">Due — July",">Collected",">%",">Outstanding",""], [rows]);
  }
  if (metric === "complaints") {
    const rows = ZONES_DATA.map(z=>{
      const ip=Math.round(z.complaints*.4), res=Math.round(z.complaints*.2);
      return `<tr class="rowbtn" onclick="drillInto(${z.id})">
        <td><b>${z.name}</b><small style="display:block;color:var(--muted)">${z.region} · ${z.branches} branches</small></td>
        <td class="r num ${z.complaints>40?"dn":"fl"}">${z.complaints}</td>
        <td class="r num fl">${ip}</td><td class="r num up">${res}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Zone",">Open",">In Progress",">Resolved Today",""], [rows]);
  }
  return "";
}

function renderDrillBranch(metric, list) {
  if (metric === "delivery") {
    const rows = list.map(b=>{
      const zn = ZONES_DATA.find(z=>z.id===b.zone_id);
      return `<tr class="rowbtn" onclick="drillInto(${b.id})">
        <td><b>${b.name}</b><small style="display:block;color:var(--muted)">${b.city}${zn?" · "+zn.name:""} · ${b.agencies} agencies</small></td>
        <td class="r num">${fmtN(b.copies_plan)}</td><td class="r num">${fmtN(b.copies_del)}</td>
        <td class="r num ${b.missed>1000?"dn":"up"}">${fmtN(b.missed)}</td>
        <td class="r num ${b.otd>=96?"up":b.otd>=93?"fl":"dn"}">${b.otd}%</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Branch",">Planned",">Delivered",">Missed",">OTD%",""], [rows]);
  }
  if (metric === "collections" || metric === "outstanding") {
    const rows = list.map(b=>{
      const pct=Math.round(b.collected/b.due*100), zn=ZONES_DATA.find(z=>z.id===b.zone_id);
      return `<tr class="rowbtn" onclick="drillInto(${b.id})">
        <td><b>${b.name}</b><small style="display:block;color:var(--muted)">${b.city}${zn?" · "+zn.name:""}</small></td>
        <td class="r num">${lakh(b.due)}</td><td class="r num up">${lakh(b.collected)}</td>
        <td class="r num ${pct>=70?"up":pct>=60?"fl":"dn"}">${pct}%</td>
        <td class="r num dn">${lakh(b.out)}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Branch",">Due — July",">Collected",">%",">Outstanding",""], [rows]);
  }
  if (metric === "complaints") {
    const rows = list.map(b=>{
      const ip=Math.round(b.complaints*.4), res=Math.round(b.complaints*.2), zn=ZONES_DATA.find(z=>z.id===b.zone_id);
      return `<tr class="rowbtn" onclick="drillInto(${b.id})">
        <td><b>${b.name}</b><small style="display:block;color:var(--muted)">${b.city}${zn?" · "+zn.name:""}</small></td>
        <td class="r num ${b.complaints>10?"dn":"fl"}">${b.complaints}</td>
        <td class="r num fl">${ip}</td><td class="r num up">${res}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Branch",">Open",">In Progress",">Resolved Today",""], [rows]);
  }
  return "";
}

function renderDrillAgency(metric, list) {
  if (metric === "delivery") {
    const rows = list.map(a=>`<tr class="rowbtn" onclick="drillInto('${a.id}')">
      <td><b>${a.name}</b><small style="display:block;color:var(--muted)">${a.area} · ${a.owner}</small></td>
      <td class="r num">${fmtN(a.copies_plan)}</td><td class="r num">${fmtN(a.copies_del)}</td>
      <td class="r num ${a.missed>100?"dn":"up"}">${fmtN(a.missed)}</td>
      <td class="r num ${a.otd>=96?"up":a.otd>=93?"fl":"dn"}">${a.otd}%</td>
      <td>${chip(a.tier==="Platinum"?"purple":a.tier==="Gold"?"warn":"mut",a.tier)}</td>
      <td class="r" style="color:var(--acc)">▶</td></tr>`).join("");
    return table(["Agency",">Planned",">Delivered",">Missed",">OTD%","Tier",""], [rows]);
  }
  if (metric === "collections" || metric === "outstanding") {
    const rows = list.map(a=>{
      const pct=Math.round(a.collected/a.due*100);
      return `<tr class="rowbtn" onclick="drillInto('${a.id}')">
        <td><b>${a.name}</b><small style="display:block;color:var(--muted)">${a.area} · ${a.owner}</small></td>
        <td class="r num">${lakh(a.due)}</td><td class="r num up">${lakh(a.collected)}</td>
        <td class="r num ${pct>=70?"up":pct>=60?"fl":"dn"}">${pct}%</td>
        <td class="r num ${a.out>300000?"dn":"fl"}">${lakh(a.out)}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Agency",">Due — July",">Collected",">%",">Outstanding",""], [rows]);
  }
  if (metric === "complaints") {
    const rows = list.map(a=>{
      const ip=Math.round(a.complaints*.4), res=Math.round(a.complaints*.2);
      return `<tr class="rowbtn" onclick="drillInto('${a.id}')">
        <td><b>${a.name}</b><small style="display:block;color:var(--muted)">${a.area} · ${a.owner}</small></td>
        <td class="r num ${a.complaints>=6?"dn":"fl"}">${a.complaints}</td>
        <td class="r num fl">${ip}</td><td class="r num up">${res}</td>
        <td class="r" style="color:var(--acc)">▶</td></tr>`;
    }).join("");
    return table(["Agency",">Open",">In Progress",">Resolved Today",""], [rows]);
  }
  return "";
}

function renderDrillHawker(metric) {
  /* deepest level — shows individual routes/hawkers */
  const rows = ROUTES.map(r=>`<tr>
    <td><b>${r.id}</b></td><td>${r.hawker}</td>
    <td class="r num">${r.copies}</td><td class="r num">${r.done}/${r.stops}</td>
    <td class="r num ${r.missed>2?"dn":"fl"}">${r.missed}</td>
    <td>${chip(r.status==="Completed"?"good":"info",r.status)}</td>
    <td>${r.window}</td></tr>`).join("");
  return table(["Route","Hawker",">Copies",">Stops done",">Missed","Status","Window"], [rows]);
}

/* ---- Dashboard: Customers ---- */
VIEWS.customers = () => {
  const extra = store.get("customers", []);
  const all = [...CUSTOMERS, ...extra];
  const rows = all.map(c => `<tr class="rowbtn" onclick='custDetail(${JSON.stringify(c.id)})'>
    <td><b>${esc(c.name)}</b><br><small style="color:var(--muted)">${c.id}</small></td>
    <td>${esc(c.plan)}</td><td>${c.route}</td>
    <td class="r num">${c.out ? fmtC(c.out) : "—"}</td>
    <td>${chip(c.churn === "High" ? "crit" : c.churn === "Medium" ? "warn" : "good", c.churn + " risk")}</td>
    <td>${chip(c.status === "Active" ? "good" : c.status === "Paused" ? "mut" : "warn", c.status)}</td></tr>`).join("");
  return pagehead("Customers", `${fmtN(412500 + extra.length)} active subscribers · Jaipur district view`,
    `<button class="btn pri" onclick="newSubscription()">＋ New subscription</button>`) +
    table(["Customer", "Plan", "Route", ">Outstanding", "Churn", "Status"], [rows]);
};
window.custDetail = id => {
  const c = [...CUSTOMERS, ...store.get("customers", [])].find(x => x.id === id); if (!c) return;
  modal(`<h3>${esc(c.name)} <span class="chip mut">${c.id}</span></h3><p class="mint">${esc(c.addr)}</p>
    <div class="detailgrid">
      <div><div class="lbl">Plan</div>${esc(c.plan)}</div><div><div class="lbl">Route</div>${c.route}</div>
      <div><div class="lbl">Phone</div>${c.phone}</div><div><div class="lbl">Outstanding</div>${c.out ? fmtC(c.out) : "Nil"}</div>
      <div><div class="lbl">Churn risk</div>${c.churn}</div><div><div class="lbl">Status</div>${c.status}</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
      <button class="btn pri sm" onclick="toast('Renewal link sent on WhatsApp')">Renew now</button>
      <button class="btn sm" onclick="toast('Delivery paused — credit will apply')">Pause</button>
      <button class="btn crit sm" onclick="toast('Complaint logged — ticket created')">Log complaint</button>
      <button class="btn sm" onclick="closeModals()">Close</button>
    </div>`);
};
window.newSubscription = () => formModal("New subscription", "Customer 360 record is created and the route hawker is notified.",
  [{ k: "name", label: "Full name", ph: "e.g. Rekha Sharma" },
   { k: "phone", label: "Mobile", type: "tel", ph: "10-digit mobile" },
   { k: "addr", label: "Address", type: "textarea", ph: "House, colony, landmark" },
   { k: "plan", label: "Plan", type: "select", opts: ["RP City · Monthly ₹360", "RP City · Annual ₹3,960", "RP City + Plus · Monthly ₹475", "Trial 14-day · Free", "Monsoon 3-month pack ₹960"] },
   { k: "route", label: "Route", type: "select", opts: ROUTES.map(r => r.id) }],
  "Create subscription", v => {
    if (!v.name || !/^\d{10}$/.test(v.phone.replace(/\D/g, ""))) { toast("Enter name and a valid 10-digit mobile"); return false; }
    store.push("customers", { id: "C-" + Math.floor(107100 + Math.random() * 800), name: v.name, phone: v.phone, addr: v.addr, plan: v.plan.split(" ₹")[0], route: v.route, out: 0, churn: "Low", status: "Active" });
    api.post("/api/customers", { name: v.name, phone: v.phone, address: v.addr, plan: v.plan, route: v.route });
    toast("Subscription created ✓"); render();
  });

/* ---- Dashboard: Partners ---- */
VIEWS.partners = () => {
  const rows = AGENCIES.map(a => `<tr>
    <td><b>${a.name}</b><br><small style="color:var(--muted)">${a.area} · ${a.owner}</small></td>
    <td class="r num">${fmtN(a.copies)}</td><td class="r num">${a.otd}%</td>
    <td class="r num">${lakh(a.out)}</td>
    <td><div class="bar"><i style="width:${a.score}%;background:${a.score >= 85 ? "var(--grn)" : a.score >= 75 ? "var(--gold)" : "var(--red)"}"></i></div></td>
    <td>${chip(a.tier === "Platinum" ? "purple" : a.tier === "Gold" ? "warn" : "mut", a.tier)}</td>
    <td class="r num">${a.routes} / ${a.hawkers}</td></tr>`).join("");
  return pagehead("Partners", "38 agencies · 214 routes · Jaipur district") + `
    <div class="grid kpis">
      ${kpi("Active agencies", "38", "", "", "var(--gold-l)", "🤝")}
      ${kpi("Active hawkers", "512", "31 substitutes today", "fl", "var(--teal-l)", "🛵")}
      ${kpi("Settlement due", lakh(1846200), "June cycle", "fl", "var(--red-l)", "🧾")}
      ${kpi("Loyalty — Gold+", "21", "score ≥ 85", "up", "var(--purple-l)", "⭐")}
    </div>` +
    table(["Agency", ">Copies/day", ">OTD", ">Outstanding", "Score", "Tier", ">Routes / Hawkers"], [rows]);
};

/* ---- Dashboard: Routes & Deliveries ---- */
VIEWS.routes = () => {
  const rows = ROUTES.map(r => `<tr>
    <td><b>${r.id}</b></td><td>${r.hawker}</td><td class="r num">${r.copies}</td>
    <td class="r num">${r.done}/${r.stops}</td><td class="r num">${r.missed}</td>
    <td>${chip(r.status === "Completed" ? "good" : "info", r.status)}</td><td class="num">${r.window}</td></tr>`).join("");
  return pagehead("Routes & Deliveries", "Shree Ganesh News Agency · Malviya Nagar · 6 routes") + `
    <div class="grid kpis">
      ${kpi("Routes done", "4 / 6", "2 out for delivery", "fl", "var(--grn-l)", "🛣️")}
      ${kpi("Stops covered", "715 / 731", "97.8%", "up", "var(--gold-l)", "🏠")}
      ${kpi("Missed today", "12", "vs 16 yesterday", "up", "var(--red-l)", "❌")}
      ${kpi("Avg finish time", "07:41", "window ends 07:30", "dn", "var(--blue-l)", "⏰")}
    </div>` +
    table(["Route", "Hawker", ">Copies", ">Stops done", ">Missed", "Status", "Window"], [rows]);
};

/* ---- Dashboard: Sales & Leads ---- */
VIEWS.salesleads = () => {
  const stages = Object.entries({ Surveyed: LEADS.surveyed, Interested: LEADS.interested, "Trial started": LEADS.trial, "Offer shared": LEADS.offer, Converted: LEADS.converted });
  const funnel = stages.map(([k, v]) => `<div class="funnel-row"><span>${k}</span>
    <div class="funnel-bar"><i style="width:${(v / LEADS.surveyed * 100).toFixed(1)}%"></i></div>
    <span class="num" style="text-align:right;font-weight:700">${fmtN(v)}</span></div>`).join("");
  const mine = store.get("leads", []);
  const rows = [...LEADLIST, ...mine].map(l => `<tr>
    <td><b>${esc(l.name)}</b><br><small style="color:var(--muted)">${esc(l.area)} · ${esc(l.phone)}</small></td>
    <td>${esc(l.pub)}</td><td>${chip(l.stage === "Converted" ? "good" : l.stage === "Payment pending" ? "warn" : "info", l.stage)}</td>
    <td>${esc(l.next || "—")}</td>
    <td><div class="bar"><i style="width:${l.score}%;background:${l.score >= 75 ? "var(--grn)" : "var(--gold)"}"></i></div></td></tr>`).join("");
  return pagehead("Sales & Leads", "Monsoon acquisition drive · Jaipur West") + `
    <div class="two"><div class="card pad"><div class="cardhead" style="padding:0 0 10px;border:none"><h3>Acquisition funnel — July</h3></div>${funnel}</div>
    <div class="card pad"><div class="cardhead" style="padding:0 0 10px;border:none"><h3>Campaign</h3></div>
      <div class="stat-pair"><span>Campaign</span><b>Monsoon 3-month pack ₹960</b></div>
      <div class="stat-pair"><span>Conversion rate</span><b class="num">5.2%</b></div>
      <div class="stat-pair"><span>Cost per acquisition</span><b class="num">₹118</b></div>
      <div class="stat-pair"><span>Best area</span><b>Nirman Nagar B</b></div></div></div>
    <div style="height:13px"></div>` +
    table(["Lead", "Publication", "Stage", "Next action", "Score"], [rows]);
};

/* ---- Dashboard: Collections ---- */

function colState() {
  return window._colState || (window._colState = {
    tab: 'overview', gran: 'monthly', agSearch: '', bSearch: '', loading: false, error: null,
    filters: { from: monthStartISO(), to: todayISO(), state:'', branch:'', district:'', ag_code:'', payment_cat:'' },
    opts: { states:[], branches:[], districts:[], payment_cats:[], agencies:[] },
    kpis: null, trend: [], modes: [], agencies: [], behavior: [], appUsage: [],
  });
}

function colApi() { return `${location.protocol}//${location.hostname}:8001/api/collection`; }

function colQS(extra) {
  const f = colState().filters, p = new URLSearchParams();
  if (f.from)        p.set('from',        f.from);
  if (f.to)          p.set('to',          f.to);
  if (f.state)       p.set('state',       f.state);
  if (f.branch)      p.set('branch',      f.branch);
  if (f.district)    p.set('district',    f.district);
  if (f.ag_code)     p.set('ag_code',     f.ag_code);
  if (f.payment_cat) p.set('payment_cat', f.payment_cat);
  if (extra) Object.entries(extra).forEach(([k,v]) => p.set(k,v));
  const s = p.toString(); return s ? '?' + s : '';
}

async function colFetch() {
  const st = colState();
  st.loading = true; st.error = null; render();
  // Filter dropdown options are slow-changing and independent — load them WITHOUT blocking the
  // dashboard (they used to make the whole screen wait on a full-table scan).
  if (!st._filtersLoaded && !st._filtersLoading) {
    st._filtersLoading = true;
    fetch(colApi() + '/filters', { headers: api.h() }).then(r => r.json())
      .then(f => { if (f) st.opts = f; st._filtersLoaded = true; st._filtersLoading = false; if (S.screen === 'collections') render(); })
      .catch(() => { st._filtersLoading = false; });
  }
  try {
    const h = { headers: api.h() };
    const [kpis, trend, modes, agencies, behavior, appUsage] = await Promise.all([
      fetch(colApi() + '/kpis'            + colQS(), h).then(r=>r.json()),
      fetch(colApi() + '/trend'           + colQS({granularity:st.gran}), h).then(r=>r.json()),
      fetch(colApi() + '/payment-modes'   + colQS(), h).then(r=>r.json()),
      fetch(colApi() + '/agencies'        + colQS({limit:300}), h).then(r=>r.json()),
      fetch(colApi() + '/agency-behavior' + colQS({limit:300}), h).then(r=>r.json()),
      fetch(colApi() + '/app-usage'       + colQS(), h).then(r=>r.json()),
    ]);
    Object.assign(st, {
      kpis,
      trend:    trend.rows    || [],
      modes:    modes.rows    || [],
      agencies: agencies.rows || [],
      behavior: behavior.rows || [],
      appUsage: appUsage.rows || [],
    });
  } catch(e) { st.error = e.message; }
  st.loading = false; render();
}

function colFmtC(n) {
  const abs = Math.abs(Number(n) || 0);
  if (abs >= 1e7) return '₹' + (abs/1e7).toFixed(2) + ' Cr';
  if (abs >= 1e5) return '₹' + (abs/1e5).toFixed(2) + ' L';
  return '₹' + abs.toLocaleString('en-IN');
}

const _COL_MODE_LABELS = {
  'PAYMENT GATWWAY': 'Agent App',
  'PAYMENT GATEWAY': 'Agent App',
};
function colModeLabel(s) { return _COL_MODE_LABELS[s] || s || 'Other'; }

function colKpi(label, value, sub, bg, icon) {
  return `<div style="background:${bg||'var(--card)'};border-radius:12px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start;border:1px solid var(--brd)">
    <div style="font-size:22px;line-height:1">${icon||'📊'}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:18px;font-weight:700;color:var(--ink);line-height:1.2">${value}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.04em">${label}</div>
      ${sub?`<div style="font-size:11px;color:var(--muted);margin-top:2px">${sub}</div>`:''}
    </div></div>`;
}

function colBar2(v, max, color) {
  const pct = max>0 ? Math.min(100,(v/max)*100) : 0;
  return `<div style="height:6px;background:var(--brd);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct.toFixed(1)}%;background:${color||'var(--acc)'};border-radius:3px"></div></div>`;
}

function colDonut(modes) {
  const cats = {};
  modes.forEach(r => { const c = colModeLabel(r.payment_cat||'Other'); cats[c] = (cats[c]||0) + (Number(r.amount)||0); });
  const entries = Object.entries(cats).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const total = entries.reduce((s,[,v])=>s+v,0);
  if (!total) return '<p style="color:var(--muted);padding:20px 0">No data</p>';
  const COLORS = ['#2563eb','#d97706','#16a34a','#dc2626','#7c3aed','#0891b2','#059669'];
  const R=54, CX=80, CY=80, CIRC=2*Math.PI*R;
  let cum = 0;
  const arcs = entries.map(([name,val],i) => {
    const pct = val/total;
    const dA = `${(pct*CIRC).toFixed(2)} ${CIRC.toFixed(2)}`;
    const dO = (CIRC*(0.25-cum)).toFixed(2);
    cum += pct;
    return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${COLORS[i%COLORS.length]}" stroke-width="20"
      stroke-dasharray="${dA}" stroke-dashoffset="${dO}"><title>${name}: ${colFmtC(val)} (${(pct*100).toFixed(1)}%)</title></circle>`;
  }).join('');
  const legend = entries.map(([name,val],i) => {
    const pct = total>0?(val/total*100).toFixed(1):0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:12px;height:12px;border-radius:50%;background:${COLORS[i%COLORS.length]};flex-shrink:0"></div>
      <span style="flex:1;font-size:12px;color:var(--ink)">${esc(name)}</span>
      <b style="font-size:12px">${colFmtC(val)}</b>
      <span style="color:var(--muted);font-size:11px;min-width:34px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 160 160" style="width:160px;height:160px;flex-shrink:0">
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--brd)" stroke-width="20"/>
      ${arcs}
      <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="var(--muted)">Total</text>
      <text x="${CX}" y="${CY+14}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="var(--ink)" font-weight="600">${colFmtC(total)}</text>
    </svg>
    <div style="flex:1;min-width:160px">${legend}</div>
  </div>`;
}

function colTrendChart(rows) {
  if (!rows.length) return '<p style="color:var(--muted);text-align:center;padding:40px 0">No data</p>';
  const maxAmt = Math.max(...rows.map(r=>Number(r.amount)||0), 1);
  const W=680, H=180, PAD=50, avail=W-2*PAD;
  const BW = Math.max(4, Math.floor(avail/rows.length)-3);
  const bars = rows.map((r,i) => {
    const amt = Number(r.amount)||0;
    const barH = Math.max(2,(amt/maxAmt)*(H-30));
    const x = PAD + i*(avail/rows.length) + (avail/rows.length-BW)/2;
    const y = H - barH - 10;
    const lbl = String(r.period||'').slice(5);
    return `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${BW}" height="${barH.toFixed(0)}" fill="var(--acc)" rx="2" opacity="0.85">
      <title>${r.period}: ${colFmtC(amt)} (${r.txn} txn)</title></rect>
      ${rows.length<=18?`<text x="${(x+BW/2).toFixed(0)}" y="${(H-1).toFixed(0)}" text-anchor="middle" font-size="8" fill="var(--muted)">${lbl}</text>`:''}`;
  }).join('');
  const guides = [0.25,0.5,0.75,1].map(f => {
    const y = H - 10 - f*(H-30);
    return `<text x="${PAD-4}" y="${y.toFixed(0)}" text-anchor="end" font-size="9" fill="var(--muted)">${colFmtC(maxAmt*f)}</text>
      <line x1="${PAD}" y1="${y.toFixed(0)}" x2="${W-PAD}" y2="${y.toFixed(0)}" stroke="var(--brd)" stroke-width="0.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${guides}${bars}</svg>`;
}

function colFilterPanel() {
  const st = colState(), f = st.filters, o = st.opts;
  const sel = (name, opts, ph) =>
    `<select style="padding:5px 8px;border:1px solid var(--brd);border-radius:6px;background:var(--card);color:var(--ink);font-size:12px"
      onchange="colState().filters.${name}=this.value;colFetch()">
      <option value="">${ph}</option>
      ${(opts||[]).map(v=>v?`<option value="${esc(v)}" ${f[name]===v?'selected':''}>${esc(v)}</option>`:'').join('')}
    </select>`;
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0 14px">
    <label style="font-size:11px;color:var(--muted)">From</label>
    <input type="date" value="${f.from||''}" style="padding:5px 8px;border:1px solid var(--brd);border-radius:6px;background:var(--card);color:var(--ink);font-size:12px"
      onchange="colState().filters.from=this.value;colFetch()">
    <label style="font-size:11px;color:var(--muted)">To</label>
    <input type="date" value="${f.to||''}" style="padding:5px 8px;border:1px solid var(--brd);border-radius:6px;background:var(--card);color:var(--ink);font-size:12px"
      onchange="colState().filters.to=this.value;colFetch()">
    ${sel('state',    o.states||[],        '🗺 All States')}
    ${sel('branch',   o.branches||[],      '🏢 All Branches')}
    ${sel('payment_cat',o.payment_cats||[],'💳 All Modes')}
    <button class="btn sm" onclick="Object.assign(colState().filters,{from:monthStartISO(),to:todayISO(),state:'',branch:'',district:'',ag_code:'',payment_cat:''});colFetch()">✕ Reset to this month</button>
  </div>`;
}

function colOverviewTab() {
  const st = colState(), k = st.kpis;
  if (!k) return '<p style="color:var(--muted);padding:20px">Loading...</p>';
  const cashPct  = k.total_collection>0 ? (k.cash_collection/k.total_collection*100).toFixed(1) : 0;
  const digPct   = k.total_collection>0 ? (k.digital_collection/k.total_collection*100).toFixed(1) : 0;
  const topAg    = (st.agencies||[]).slice(0,5);
  const maxAgAmt = topAg.length ? Math.max(...topAg.map(r=>Number(r.total_amount)||0)) : 1;
  const top5 = topAg.map((r,i) => `<tr>
    <td style="color:var(--muted);font-size:12px;width:28px">#${i+1}</td>
    <td><b style="font-size:13px">${esc(r.ag_name||r.ag_code||'')}</b><br><small style="color:var(--muted)">${esc(r.branch_name||'')}</small></td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
    <td class="r" style="font-size:11px;color:var(--muted)">${(r.txn||0).toLocaleString()}</td>
    <td style="width:80px">${colBar2(Number(r.total_amount),maxAgAmt,'var(--acc)')}</td>
  </tr>`).join('');
  return `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon:'💰', label:'Total Collection', value:colFmtC(k.total_collection), status:'up' })}
    ${vzKpi({ icon:'📆', label:'MTD Collection',   value:colFmtC(k.mtd_collection),   status:'up' })}
    ${vzKpi({ icon:'📊', label:'YTD Collection',   value:colFmtC(k.ytd_collection),   status:'fl' })}
    ${vzKpi({ icon:'🔄', label:'Transactions',     value:(k.total_txn||0).toLocaleString(), status:'fl' })}
    ${vzKpi({ icon:'🏢', label:'Agencies Paid',    value:(k.agencies_paid||0).toLocaleString(), status:'up' })}
    ${vzKpi({ icon:'📐', label:'Avg / Agency',     value:colFmtC(k.avg_per_agency), status:'fl' })}
    ${vzKpi({ icon:'💵', label:'Cash',             value:colFmtC(k.cash_collection), sub:cashPct+'% of total', status:'fl' })}
    ${vzKpi({ icon:'📱', label:'Digital',          value:colFmtC(k.digital_collection), sub:digPct+'% of total', status:'up' })}
    ${vzKpi({ icon:'🏆', label:'Highest Single',   value:colFmtC(k.highest_collection), status:'fl' })}
    ${vzKpi({ icon:'📅', label:'Latest Day',       value:colFmtC(k.today_collection), sub:k.last_date||'', status:'up' })}
  </div>
  <div class="two">
    <div class="vz-sec">
      <div class="cardhead"><h3>Payment Mode Mix</h3></div>
      ${colDonut(st.modes)}
    </div>
    <div class="vz-sec">
      <div class="cardhead" style="padding:0 0 12px"><h3>Top 5 Agencies</h3></div>
      <div class="tablewrap"><table>
        <thead><tr><th>#</th><th>Agency</th><th class="r">Collection</th><th class="r">Txn</th><th>Share</th></tr></thead>
        <tbody>${top5||'<tr><td colspan="5" style="text-align:center;color:var(--muted)">No data</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>`;
}

function colTrendTab() {
  const st = colState();
  const granBtns = ['daily','weekly','monthly'].map(g =>
    `<button class="btn sm ${st.gran===g?'pri':''}" onclick="colState().gran='${g}';colFetch()">${g[0].toUpperCase()+g.slice(1)}</button>`
  ).join('');
  const rows = st.trend || [];
  const tbl = rows.slice().reverse().slice(0,20).reverse().map(r =>
    `<tr><td>${r.period||''}</td><td class="r num">${colFmtC(r.amount)}</td><td class="r">${(r.txn||0).toLocaleString()}</td><td class="r">${(r.agencies||0).toLocaleString()}</td></tr>`
  ).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No data</td></tr>';
  return `<div class="vz-sec">
    <div class="cardhead" style="align-items:center">
      <h3>Collection Trend</h3>
      <div style="display:flex;gap:6px">${granBtns}</div>
    </div>
    <div style="margin:8px 0 4px">${colTrendChart(rows)}</div>
    <div class="tablewrap" style="margin-top:16px"><table>
      <thead><tr><th>Period</th><th class="r">Collection</th><th class="r">Transactions</th><th class="r">Agencies</th></tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

function colModesTab() {
  const st = colState();
  const modes = st.modes || [];
  const cats = {};
  modes.forEach(r => {
    const c = r.payment_cat;
    if (!cats[c]) cats[c] = { amount:0, txn:0 };
    cats[c].amount += Number(r.amount)||0;
    cats[c].txn    += Number(r.txn)||0;
  });
  const grand = Object.values(cats).reduce((s,v)=>s+v.amount,0);
  const catRows = Object.entries(cats).sort((a,b)=>b[1].amount-a[1].amount).map(([cat,v]) =>
    `<tr><td><b>${esc(cat)}</b></td><td class="r num">${colFmtC(v.amount)}</td><td class="r">${(v.txn||0).toLocaleString()}</td>
    <td class="r" style="color:var(--muted)">${grand>0?(v.amount/grand*100).toFixed(1):0}%</td>
    <td style="width:120px">${colBar2(v.amount,grand)}</td></tr>`
  ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No data</td></tr>';
  const modeRows = modes.slice().filter(r=>Number(r.amount)>0).sort((a,b)=>Number(b.amount)-Number(a.amount)).map(r =>
    `<tr><td style="color:var(--muted);font-size:12px">${esc(colModeLabel(r.payment_cat))}</td><td>${esc(colModeLabel(r.payment_mode||''))}</td>
    <td class="r num">${colFmtC(r.amount)}</td><td class="r">${(r.txn||0).toLocaleString()}</td>
    <td class="r" style="color:var(--muted)">${grand>0?(Number(r.amount)/grand*100).toFixed(1):0}%</td></tr>`
  ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No data</td></tr>';
  return `<div class="two">
    <div class="vz-sec">
      <div class="cardhead"><h3>By Category</h3></div>
      ${colDonut(modes)}
      <div class="tablewrap" style="margin-top:16px"><table>
        <thead><tr><th>Category</th><th class="r">Amount</th><th class="r">Txn</th><th class="r">%</th><th>Bar</th></tr></thead>
        <tbody>${catRows}</tbody>
      </table></div>
    </div>
    <div class="vz-sec">
      <div class="cardhead" style="padding:12px 16px 8px"><h3>By Mode</h3></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Category</th><th>Mode</th><th class="r">Amount</th><th class="r">Txn</th><th class="r">%</th></tr></thead>
        <tbody>${modeRows}</tbody>
      </table></div>
    </div>
  </div>
  ${colAppUsageTable(st.appUsage)}`;
}

/* Agent App collection summary — state / unit wise (gateway payments = app) */
function colAppUsageTable(rows) {
  if (!rows || !rows.length) return '';
  const STATE_ORDER = ['RAJASTHAN', 'MP', 'CG', 'NATIONAL'];
  const byState = {};
  rows.forEach(r => { (byState[r.state_name] = byState[r.state_name] || []).push(r); });
  const states = Object.keys(byState).sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a), ib = STATE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const g = { agencies:0, app_agencies:0, app_amount:0, total_amount:0 };
  let body = '';
  states.forEach(stName => {
    const units = byState[stName];
    const s = { agencies:0, app_agencies:0, app_amount:0, total_amount:0 };
    body += units.map(u => {
      s.agencies += u.agencies; s.app_agencies += u.app_agencies;
      s.app_amount += u.app_amount; s.total_amount += u.total_amount;
      return `<tr>
        <td style="color:var(--muted);font-size:12px">${esc(u.state_name)}</td>
        <td><b>${esc(u.branch_name)}</b></td>
        <td class="r num">${fmtN(u.agencies)}</td>
        <td class="r num">${fmtN(u.app_agencies)}</td>
        <td class="r num">${colFmtC(u.app_amount)}</td>
        <td class="r num" style="color:${u.app_pct >= 5 ? 'var(--grn)' : 'var(--muted)'}">${u.app_pct}%</td>
      </tr>`;
    }).join('');
    const sPct = s.total_amount > 0 ? Math.round(s.app_amount / s.total_amount * 1000) / 10 : 0;
    body += `<tr style="background:var(--surf2);font-weight:700">
      <td colspan="2">${esc(stName)} TOTAL</td>
      <td class="r num">${fmtN(s.agencies)}</td>
      <td class="r num">${fmtN(s.app_agencies)}</td>
      <td class="r num">${colFmtC(s.app_amount)}</td>
      <td class="r num">${sPct}%</td>
    </tr>`;
    g.agencies += s.agencies; g.app_agencies += s.app_agencies;
    g.app_amount += s.app_amount; g.total_amount += s.total_amount;
  });
  const gPct = g.total_amount > 0 ? Math.round(g.app_amount / g.total_amount * 1000) / 10 : 0;
  body += `<tr style="background:var(--navy,#1C2B45);color:#fff;font-weight:700">
    <td colspan="2">GRAND TOTAL</td>
    <td class="r num">${fmtN(g.agencies)}</td>
    <td class="r num">${fmtN(g.app_agencies)}</td>
    <td class="r num">${colFmtC(g.app_amount)}</td>
    <td class="r num">${gPct}%</td>
  </tr>`;

  return `<div class="vz-sec" style="margin-top:12px">
    <div class="cardhead" style="padding:12px 16px 8px">
      <h3>📱 Agent App Collection Summary — State / Unit wise</h3>
      <small style="color:var(--muted)">App = payment gateway · Agency App Used = agencies that paid via app in the selected period</small>
    </div>
    <div class="tablewrap"><table>
      <thead><tr>
        <th>State</th><th>Unit</th>
        <th class="r">No. of Agency</th>
        <th class="r">Agency App Used</th>
        <th class="r">Agency App Collection</th>
        <th class="r">App Collection %</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}

function colAgenciesTab() {
  const st = colState();
  const q = (st.agSearch||'').toLowerCase();
  const rows = (st.agencies||[]).filter(r =>
    !q || (r.ag_name||'').toLowerCase().includes(q) || (r.ag_code||'').toLowerCase().includes(q) || (r.branch_name||'').toLowerCase().includes(q)
  );
  const maxAmt = rows.length ? Math.max(...rows.map(r=>Number(r.total_amount)||0),1) : 1;

  // Group by state — Rajasthan, MP, CG, National order
  const STATE_ORDER = ['RAJASTHAN', 'MP', 'CG', 'NATIONAL'];
  const byState = {};
  rows.forEach(r => { const s = r.state_name || '—'; (byState[s] = byState[s] || []).push(r); });
  const states = Object.keys(byState).sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a), ib = STATE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const agRow = (r, i) => `<tr>
    <td style="color:var(--muted);font-size:12px;width:28px">#${i+1}</td>
    <td><b>${esc(r.ag_name||r.ag_code||'')}</b><br><small style="color:var(--muted)">${esc(r.ag_code||'')} · ${esc(r.branch_name||'')}</small></td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
    <td class="r">${(r.txn||0).toLocaleString()}</td>
    <td>${r.last_payment_date||'—'}</td>
    <td class="r" style="color:${Number(r.days_since)>60?'var(--red)':'var(--grn)'}">${r.days_since!=null?r.days_since+' d':'—'}</td>
    <td style="width:70px">${colBar2(Number(r.total_amount),maxAmt)}</td>
  </tr>`;

  const tbl = states.map(stName => {
    const list = byState[stName];
    const stTotal = list.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    return `<tr style="background:var(--navy,#1C2B45);color:#fff;font-weight:700">
      <td colspan="2">${esc(stName)} · ${list.length} agencies</td>
      <td class="r num">${colFmtC(stTotal)}</td>
      <td colspan="4"></td>
    </tr>` + list.map(agRow).join('');
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No data</td></tr>';

  return `<div class="vz-sec">
    <div class="cardhead" style="padding:0 0 12px;flex-wrap:wrap;gap:8px">
      <h3>Agency Rankings (${rows.length}) — State wise</h3>
      <input placeholder="🔍 Search agency..." value="${esc(st.agSearch||'')}"
        style="padding:5px 10px;border:1px solid var(--brd);border-radius:6px;background:var(--card);color:var(--ink);font-size:12px;width:180px"
        oninput="colState().agSearch=this.value;render()">
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>#</th><th>Agency</th><th class="r">Collection</th><th class="r">Txn</th><th>Last Payment</th><th class="r">Days Since</th><th>Share</th></tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

function colBehaviorTab() {
  const st = colState();
  const q = (st.bSearch||'').toLowerCase();
  const rows = (st.behavior||[]).filter(r =>
    !q || (r.ag_name||'').toLowerCase().includes(q) || (r.ag_code||'').toLowerCase().includes(q)
  );
  // Group by state — Rajasthan, MP, CG, National order
  const STATE_ORDER = ['RAJASTHAN', 'MP', 'CG', 'NATIONAL'];
  const byState = {};
  rows.forEach(r => { const s = r.state_name || '—'; (byState[s] = byState[s] || []).push(r); });
  const states = Object.keys(byState).sort((a, b) => {
    const ia = STATE_ORDER.indexOf(a), ib = STATE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const bRow = r => `<tr>
    <td><b>${esc(r.ag_name||r.ag_code||'')}</b><br><small style="color:var(--muted)">${esc(r.ag_code||'')} · ${esc(r.branch_name||'')}</small></td>
    <td style="font-size:12px">${r.last_payment||'—'}</td>
    <td class="r" style="color:${Number(r.days_since)>60?'var(--red)':'var(--grn)'}">${r.days_since!=null?r.days_since+'d':'—'}</td>
    <td class="r">${(r.num_payments||0).toLocaleString()}</td>
    <td class="r num">${colFmtC(r.avg_amount)}</td>
    <td class="r num">${colFmtC(r.highest)}</td>
    <td class="r num">${colFmtC(r.lowest)}</td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
    <td class="r" style="color:var(--muted);font-size:11px">${r.freq_per_month!=null?Number(r.freq_per_month||0).toFixed(1)+'/mo':'—'}</td>
  </tr>`;

  const tbl = states.map(stName => {
    const list = byState[stName];
    const stTotal = list.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    return `<tr style="background:var(--navy,#1C2B45);color:#fff;font-weight:700">
      <td colspan="7">${esc(stName)} · ${list.length} agencies</td>
      <td class="r num">${colFmtC(stTotal)}</td>
      <td></td>
    </tr>` + list.map(bRow).join('');
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No data</td></tr>';

  return `<div class="vz-sec">
    <div class="cardhead" style="padding:0 0 12px;flex-wrap:wrap;gap:8px">
      <h3>Agency Payment Behaviour (${rows.length}) — State wise</h3>
      <input placeholder="🔍 Search agency..." value="${esc(st.bSearch||'')}"
        style="padding:5px 10px;border:1px solid var(--brd);border-radius:6px;background:var(--card);color:var(--ink);font-size:12px;width:180px"
        oninput="colState().bSearch=this.value;render()">
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Agency</th><th>Last Payment</th><th class="r">Days Since</th><th class="r"># Payments</th><th class="r">Avg Amount</th><th class="r">Highest</th><th class="r">Lowest</th><th class="r">Total</th><th class="r">Freq/Mo</th></tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

VIEWS.collections = () => {
  const st = colState();
  if (!st.kpis && !st.loading && !st.error) { colFetch(); return pagehead('Collections','Loading collection data...'); }
  const tabs = [['overview','📊 Overview'],['trend','📈 Trend'],['modes','💳 Modes'],['agencies','🏢 Agencies'],['behavior','📋 Behaviour']];
  const tabBar = `<div style="display:flex;border-bottom:1px solid var(--brd);margin-bottom:16px;overflow-x:auto">
    ${tabs.map(([id,lbl])=>`<button onclick="colState().tab='${id}';render()"
      style="padding:10px 18px;border:none;border-bottom:3px solid ${st.tab===id?'var(--chart-1)':'transparent'};background:none;font-size:13px;font-weight:${st.tab===id?'700':'500'};color:${st.tab===id?'var(--chart-1)':'var(--muted)'};cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s">${lbl}</button>`).join('')}
  </div>`;
  let content;
  if (st.loading) content = '<div style="text-align:center;padding:60px;color:var(--muted)">⏳ Loading collection data...</div>';
  else if (st.error) content = `<div class="card pad" style="color:var(--red)">⚠️ ${esc(st.error)} <button class="btn sm" style="margin-left:8px" onclick="colFetch()">Retry</button></div>`;
  else {
    const tab = st.tab;
    if      (tab==='overview') content = colOverviewTab();
    else if (tab==='trend')    content = colTrendTab();
    else if (tab==='modes')    content = colModesTab();
    else if (tab==='agencies') content = colAgenciesTab();
    else                       content = colBehaviorTab();
  }
  const sub = st.kpis ? (st.kpis.last_date ? `Jan–Jul 2026 · last payment ${st.kpis.last_date}` : 'Jan–Jul 2026') : 'Loading...';
  return pagehead('Collections', sub) + colFilterPanel() + tabBar + content;
};

/* ---- Dashboard: Settlements ---- */
VIEWS.settlements = () => {
  const lines = SETTLEMENT.lines.map(([k, v]) => `<div class="stat-pair"><span>${k}</span>
    <b class="num ${v < 0 ? "dn" : "up"}">${v < 0 ? "−" : "+"}${fmtC(Math.abs(v))}</b></div>`).join("");
  const done = store.get("settlementApproved", false);
  return pagehead("Settlements", "Maker–checker settlement cycle · monthly") + `
    <div class="two"><div class="card pad">
      <div class="cardhead" style="padding:0 0 10px;border:none"><h3>${SETTLEMENT.partner}</h3>
        ${chip(done ? "good" : "warn", done ? "Approved" : SETTLEMENT.status)}</div>
      <div class="lbl" style="margin-bottom:6px">Period — ${SETTLEMENT.period}</div>${lines}
      <div class="stat-pair" style="border-top:2px solid var(--brd);margin-top:6px"><span><b style="color:var(--ink)">Net payable to agency</b></span><b class="num" style="font-size:16px">${fmtC(SETTLEMENT.net)}</b></div>
      ${done ? "" : `<div style="display:flex;gap:9px;margin-top:16px">
        <button class="btn pri" onclick="store.set('settlementApproved',true);toast('Settlement approved — payout queued');render()">Approve & release</button>
        <button class="btn" onclick="toast('Returned to finance desk with query')">Query</button></div>`}
    </div>
    <div class="card pad"><div class="cardhead" style="padding:0 0 10px;border:none"><h3>Cycle status — June</h3></div>
      <div class="stat-pair"><span>Statements generated</span><b class="num">38 / 38</b></div>
      <div class="stat-pair"><span>Acknowledged by agency</span><b class="num">34</b></div>
      <div class="stat-pair"><span>Approved</span><b class="num">${done ? 30 : 29}</b></div>
      <div class="stat-pair"><span>Paid out</span><b class="num">26</b></div>
      <div class="stat-pair"><span>Disputed</span><b class="num dn">2</b></div></div></div>`;
};

/* ---- Dashboard: Complaints ---- */
VIEWS.complaints = () => {
  const extra = store.get("complaints", []);
  const rows = [...extra.slice().reverse(), ...COMPLAINTS].map(c => `<tr>
    <td><b>${c.id}</b></td><td><b>${esc(c.cust)}</b><br><small style="color:var(--muted)">${esc(c.cat)}</small></td>
    <td>${c.route}</td>
    <td>${chip(c.slaState === "crit" ? "crit" : c.slaState === "warn" ? "warn" : "good", c.sla)}</td>
    <td>${chip(c.pri === "High" ? "crit" : c.pri === "Medium" ? "warn" : "mut", c.pri)}</td>
    <td>${chip(c.status === "Resolved" ? "good" : c.status === "Escalated" ? "crit" : "info", c.status)}</td></tr>`).join("");
  return pagehead("Complaints", "SLA-tracked service desk", `<button class="btn pri" onclick="logComplaint()">＋ Log complaint</button>`) + `
    <div class="grid kpis">
      ${kpi("Open", String(48 + extra.length), "9 SLA at risk", "dn", "var(--red-l)", "💬")}
      ${kpi("Avg resolution", "5h 12m", "target 8h", "up", "var(--grn-l)", "⏱️")}
      ${kpi("Repeat complainants", "31", "root-cause review due", "fl", "var(--gold-l)", "🔁")}
      ${kpi("Per 10k copies", "1.2", "▼ 0.2 MoM", "up", "var(--blue-l)", "📉")}
    </div>` +
    table(["Ticket", "Customer", "Route", "SLA", "Priority", "Status"], [rows]);
};
window.logComplaint = () => formModal("Log complaint", "Ticket is auto-assigned by route with an SLA timer.",
  [{ k: "cust", label: "Customer", ph: "name or customer ID" },
   { k: "cat", label: "Category", type: "select", opts: ["Newspaper not delivered", "Late delivery (after 7:30)", "Short supply", "Damaged copy", "Billing issue", "Pause / restart request"] },
   { k: "route", label: "Route", type: "select", opts: ROUTES.map(r => r.id) },
   { k: "pri", label: "Priority", type: "select", opts: ["High", "Medium", "Low"] },
   { k: "note", label: "Details", type: "textarea" }],
  "Create ticket", v => {
    if (!v.cust) { toast("Enter the customer name"); return false; }
    store.push("complaints", { id: "T-" + Math.floor(88250 + Math.random() * 700), cust: v.cust, cat: v.cat, route: v.route, sla: "8h left", slaState: "good", pri: v.pri, status: "Open" });
    api.post("/api/complaints", { customer_name: v.cust, complaint_type: v.cat, route: v.route, priority: v.pri, description: v.note || "" });
    toast("Ticket created ✓"); render();
  });

/* ---- Dashboard: Transport — Live Supply Alerts ---- */

/* Fetch latest-date supply issues for Transport dashboard (no date param = server picks latest) */
async function fetchTransportSI() {
  if (S.live._transportSILoading) return;
  S.live._transportSILoading = true;
  if (S.screen === 'transport') render();
  const data = await api.get('/api/reports/supply-issues');
  S.live.transportSI = data || null;
  S.live._transportSILoading = false;
  if (S.screen === 'transport') render();
}

/* Flat alert table for Transport view — groups by State→Zone, full-text send buttons */
function renderAlertRows(rows, valueKey, valueStyle) {
  if (!rows.length) return `<div style="color:var(--muted);font-size:13px;padding:8px">No issues.</div>`;

  // Normalise state/zone: RP units without hierarchy → 'RAJASTHAN', unknown zone → unit_name
  const normed = rows.map(r => ({
    ...r,
    _state: (r.state_name && r.state_name !== 'State Unknown')
              ? 'VP: ' + r.state_name
              : (r.unit_name?.endsWith(' RP') ? 'RAJASTHAN' : r.unit_name),
    _zone:  (r.zone_name && r.zone_name !== 'Zone Unknown')
              ? 'Zonal Head: ' + r.zone_name
              : r.unit_name
  }));

  const byState = {};
  normed.forEach(r => {
    if (!byState[r._state])             byState[r._state] = {};
    if (!byState[r._state][r._zone])    byState[r._state][r._zone] = [];
    byState[r._state][r._zone].push(r);
  });

  let html = `<table style="border-collapse:collapse;font-size:12px;width:100%;min-width:700px">
    <thead><tr style="background:var(--navy);color:#fff">
      <th style="padding:7px 10px;text-align:left;white-space:nowrap">Unit</th>
      <th style="padding:7px 10px;text-align:left;white-space:nowrap">Route</th>
      <th style="padding:7px 10px;text-align:left;white-space:nowrap">Sub Route</th>
      <th style="padding:7px 10px;text-align:center;white-space:nowrap">Issue</th>
      <th style="padding:7px 10px;text-align:center;white-space:nowrap" colspan="2">Send Alert</th>
    </tr></thead><tbody>`;

  Object.keys(byState).sort().forEach(stateName => {
    const zoneMap = byState[stateName];
    const total = Object.values(zoneMap).reduce((s, v) => s + v.length, 0);
    html += `<tr><td colspan="6" style="padding:7px 12px;background:#0f1f36;color:#93c5fd;font-size:12px;font-weight:700">
      📍 ${esc(stateName)} &ensp;<span style="font-weight:400;font-size:11px;color:#60a5fa">${total} route${total!==1?'s':''}</span>
    </td></tr>`;

    Object.keys(zoneMap).sort().forEach(zoneName => {
      const zRows = zoneMap[zoneName];
      html += `<tr><td colspan="6" style="padding:5px 12px 5px 24px;background:#1C2B45;color:#bfdbfe;font-size:11px;font-weight:700">
        🗺 ${esc(zoneName)} &ensp;<span style="font-weight:400">${zRows.length} route${zRows.length!==1?'s':''}</span>
      </td></tr>`;

      zRows.forEach((r, i) => {
        const val = r[valueKey] || '—';
        const uJ = JSON.stringify(r.unit_name), rJ = JSON.stringify(r.route_name),
              sJ = JSON.stringify(r.sub_route_name), dJ = JSON.stringify(r.rpt_date);
        const bg = i % 2 === 0 ? 'var(--surf)' : 'var(--surf2)';
        html += `<tr style="background:${bg}">
          <td style="padding:6px 10px 6px 32px;border-bottom:1px solid var(--border);white-space:nowrap">${esc(r.unit_name)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);font-weight:600;white-space:nowrap">${esc(r.route_name)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);color:var(--muted);white-space:nowrap">${esc(r.sub_route_name)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:center;${valueStyle}">${esc(val)}</td>
          <td style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:center;white-space:nowrap">
            <button class="btn sm" onclick="sendRouteAlert(${uJ},${rJ},${sJ},${dJ},'email')"
              style="font-size:11px;padding:3px 9px">📧 Send Email</button>
          </td>
          <td style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:center;white-space:nowrap">
            <button class="btn sm" onclick="sendRouteAlert(${uJ},${rJ},${sJ},${dJ},'whatsapp')"
              style="font-size:11px;padding:3px 9px">📱 Send WhatsApp</button>
          </td>
        </tr>`;
      });
    });
  });

  html += '</tbody></table>';
  return html;
}

VIEWS.transport = () => {
  const si      = S.live.transportSI;
  const loading = S.live._transportSILoading;
  if (!si && !loading) setTimeout(fetchTransportSI, 0);

  // Delivery drill state — reset when entering from another section
  if (!S.drill || S.drill.metric !== 'delivery') {
    S.drill = { level: 'unit', metric: 'delivery', unitName: null, routeCode: null, subRouteName: null };
  }
  if (!S.live.delivery && !S.live._loading) setTimeout(fetchDashboard, 0);
  const drill = S.drill;

  // Filter state
  if (!S.live.txFilter) S.live.txFilter = { state: '', unit: '', open: false };
  const txF = S.live.txFilter;
  const ld  = S.live.delivery;

  // Active tab
  const tab = S.live.txTab || 'delivery';
  const tBtn = (id, label) => `<button onclick="S.live.txTab='${id}';render()"
    style="padding:10px 20px;border:none;border-bottom:3px solid ${tab===id?'var(--chart-1)':'transparent'};
    background:none;font-size:13px;font-weight:${tab===id?'700':'500'};color:${tab===id?'var(--chart-1)':'var(--muted)'};
    cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s">${label}</button>`;

  const dateLabel = si?.dates?.length ? si.dates[si.dates.length - 1] : '';
  const header = pagehead("Taxi Dashboard",
    `Route-wise delivery & supply delay · ${dateLabel || 'latest sync'}`);

  const tabBar = `<div style="display:flex;border-bottom:1px solid var(--brd);margin-bottom:16px;overflow-x:auto">
    ${tBtn('delivery',     '📍 Route-wise Delivery Detail · Live KM & Timings')}
    ${tBtn('supply',       '⏰ Supply Delay')}
    ${tBtn('delay_report', '📋 Taxi Delay Report')}
  </div>`;

  // ── TAB 1: DELIVERY ───────────────────────────────────────────────────────
  let tabContent = '';
  if (tab === 'delivery') {
    // State → unit mapping
    const zoneNames  = { '1':'Rajasthan', '2':'Madhya Pradesh', '3':'Chhattisgarh', '4':'National' };
    const branchByZone = {};
    (typeof BRANCHES_DATA !== 'undefined' ? BRANCHES_DATA : []).forEach(b => {
      const z = String(b.zone_id);
      if (!branchByZone[z]) branchByZone[z] = [];
      branchByZone[z].push(b.name);
    });

    const allUnits = ld ? ld.units : [];
    const stateSet = txF.state ? new Set(branchByZone[txF.state] || []) : null;
    const visUnits = stateSet
      ? (txF.unit ? allUnits.filter(u => u.unit_name === txF.unit) : allUnits.filter(u => stateSet.has(u.unit_name)))
      : (txF.unit ? allUnits.filter(u => u.unit_name === txF.unit) : allUnits);
    const unitPool = txF.state
      ? (branchByZone[txF.state] || []).filter(n => allUnits.find(u => u.unit_name === n))
      : allUnits.map(u => u.unit_name);

    // Filter panel
    const filterPanel = txF.open ? `
      <div class="vz-sec" style="margin-bottom:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:14px 18px">
        <div style="display:flex;flex-direction:column;gap:5px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">State</label>
          <select id="txFState" onchange="txStateChange(this.value)" style="padding:7px 10px;border:1px solid var(--brd);border-radius:7px;background:var(--card);color:var(--ink);font-size:13px;min-width:160px">
            <option value="">All States</option>
            ${Object.entries(zoneNames).map(([id,name]) => `<option value="${id}" ${txF.state===id?'selected':''}>${name}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Unit</label>
          <select id="txFUnit" style="padding:7px 10px;border:1px solid var(--brd);border-radius:7px;background:var(--card);color:var(--ink);font-size:13px;min-width:170px">
            <option value="">All Units</option>
            ${unitPool.map(n => `<option value="${n}" ${txF.unit===n?'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">
          <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Date</label>
          <input id="txFDate" type="date" value="${S.live.txFilterDate || (ld?.from ? ld.from.slice(0,10) : '')}"
            style="padding:7px 10px;border:1px solid var(--brd);border-radius:7px;background:var(--card);color:var(--ink);font-size:13px">
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <button class="btn" onclick="txApplyFilter(document.getElementById('txFState')?.value||'',document.getElementById('txFUnit')?.value||'',document.getElementById('txFDate')?.value||'')"
            style="padding:7px 20px;font-size:13px">Apply</button>
          <button class="btn" onclick="txApplyFilter('','','')"
            style="padding:7px 14px;font-size:13px;background:transparent;color:var(--muted);border:1px solid var(--brd)">Reset</button>
        </div>
      </div>` : '';

    const chips = [
      txF.state ? `<span style="background:var(--acc);color:#fff;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600">${zoneNames[txF.state]}</span>` : '',
      txF.unit  ? `<span style="background:var(--acc);color:#fff;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600">${esc(txF.unit)}</span>` : '',
      S.live.txFilterDate ? `<span style="background:#2563eb;color:#fff;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600">📅 ${S.live.txFilterDate}</span>` : '',
    ].filter(Boolean).join(' ');

    const filterBar = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted)">
        ${ld ? `<span>${ld.date} · <b>${ld.summary?.total_routes}</b> routes · OTD <b class="${(ld.summary?.otd_pct||0)>=70?'up':'dn'}">${ld.summary?.otd_pct}%</b> · App KM <b>${fmtN(ld.summary?.actual_km)}</b></span>` : '<span>Loading…</span>'}
        ${chips}
      </div>
      <button class="btn sm" onclick="txToggleFilter()" style="white-space:nowrap">🔍 Filter ${txF.open?'▲':'▼'}</button>
    </div>`;

    let drillNav = '';
    if (drill.level === 'route') {
      drillNav = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <button class="btn sm" onclick="S.drill={...S.drill,level:'unit',unitName:null,routeCode:null};render()">← All Units</button>
        <span style="font-weight:600;font-size:13px">${esc(drill.unitName||'')}</span>
      </div>`;
    } else if (drill.level === 'droppoint') {
      drillNav = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <button class="btn sm" onclick="S.drill={...S.drill,level:'unit',unitName:null,routeCode:null};render()">← All Units</button>
        <button class="btn sm" onclick="S.drill={...S.drill,level:'route',routeCode:null,subRouteName:null};render()">← ${esc(drill.unitName||'')}</button>
        <span style="color:var(--muted);font-size:13px">${esc(drill.routeCode||'')}${drill.subRouteName&&drill.subRouteName!=='-'?' / '+esc(drill.subRouteName):''}</span>
      </div>`;
    }

    let drillContent;
    if (drill.level === 'unit')       drillContent = renderLiveUnits(stateSet || txF.unit ? visUnits : undefined);
    else if (drill.level === 'route') drillContent = renderLiveRoutes(drill.unitName);
    else                              drillContent = renderLiveDropPoints(drill.routeCode, drill.subRouteName);

    tabContent = filterBar + filterPanel + `<div>${drillNav}<div style="overflow-x:auto">${drillContent}</div></div>`;
  }

  // ── TAB 2: SUPPLY DELAY ───────────────────────────────────────────────────
  if (tab === 'supply') {
    if (loading) {
      tabContent = `<div style="text-align:center;padding:40px;color:var(--muted)">Loading supply data…</div>`;
    } else if (!si) {
      tabContent = `<div class="card pad" style="text-align:center;padding:32px;color:var(--muted)">
        No data yet — run oracle_sync or check server connection.</div>`;
    } else {
      const lateCount = si.late?.length || 0;
      const appCount  = si.app_not_running?.length || 0;
      if (!lateCount && !appCount) {
        tabContent = `<div class="card pad" style="text-align:center;padding:32px;color:var(--grn)">
          ✓ No supply issues for ${dateLabel} — all taxis on time.</div>`;
      } else {
        const summary = `<div class="vz-kgrid" style="margin-bottom:16px">
          ${vzKpi({ icon:"⏰", label:"Late Taxis", value:String(lateCount), sub:"arrived after 6 AM", status:lateCount>0?"dn":"up" })}
          ${vzKpi({ icon:"📵", label:"App Not Running", value:String(appCount), sub:"App KM = 0", status:appCount>0?"dn":"up" })}
          ${vzKpi({ icon:"📅", label:"Sync Date", value:dateLabel||"—", sub:"latest data", status:"fl" })}
        </div>`;
        let body = summary;
        if (lateCount) body += `<div class="vz-sec" style="margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:22px">⏰</span>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--chart-5)">Supply Taxi — Arrived After 6 AM</div>
              <div style="font-size:11px;color:var(--muted)">${lateCount} route${lateCount!==1?'s':''} · Click a button in the row to send the alert</div>
            </div>
          </div>
          <div style="overflow-x:auto">${renderAlertRows(si.late, 'last_late', 'color:var(--chart-5);font-weight:bold')}</div>
        </div>`;
        if (appCount) body += `<div class="vz-sec">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:22px">📵</span>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--chart-2)">App Not Running (App KM = 0)</div>
              <div style="font-size:11px;color:var(--muted)">${appCount} route${appCount!==1?'s':''} · Click a button in the row to send the alert</div>
            </div>
          </div>
          <div style="overflow-x:auto">${renderAlertRows(si.app_not_running, 'vehicle_no', 'color:var(--chart-2);font-weight:bold')}</div>
        </div>`;
        tabContent = body;
      }
    }
  }

  // ── TAB 3: TAXI DELAY REPORT ─────────────────────────────────────────────────
  if (tab === 'delay_report') {
    tabContent = window._renderTaxiDelayTab ? window._renderTaxiDelayTab() : '';
  }

  return header + tabBar + tabContent;
};

/* ---- Dashboard: Approvals ---- */
VIEWS.approvals = () => {
  const decided = store.get("approvalsDecided", {});
  const cards = APPROVALS.map(a => {
    const d = decided[a.id];
    return `<div class="card pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <div>${chip("mut", a.type)} ${chip(a.pri === "High" ? "crit" : a.pri === "Medium" ? "warn" : "mut", a.pri)}
          <span style="color:var(--muted);font-size:11.5px">· ${a.age} ago · by ${a.req}</span></div>
        <b class="num">${a.amt}</b></div>
      <h3 style="margin:8px 0 4px;font-size:14.5px">${a.title}</h3>
      <p style="color:var(--muted);font-size:12.5px">${a.note}</p>
      <div style="display:flex;gap:9px;margin-top:12px">${d
        ? chip(d === "approved" ? "good" : "crit", d === "approved" ? "✓ Approved" : "✕ Rejected")
        : `<button class="btn good sm" onclick="decide('${a.id}','approved')">✓ Approve</button>
           <button class="btn crit sm" onclick="decide('${a.id}','rejected')">✕ Reject</button>`}</div></div>`;
  }).join("");
  return pagehead("Approvals", "Items awaiting your decision — copy variance, refunds, settlements") + cards;
};
window.decide = (id, verdict) => {
  const d = store.get("approvalsDecided", {}); d[id] = verdict; store.set("approvalsDecided", d);
  toast(verdict === "approved" ? "Approved ✓ — requester notified" : "Rejected — sent back with note"); render();
};

/* ---- Dashboard: Reports ---- */
/* ── Supply Issues helpers ─────────────────────────────────────────────────── */
async function fetchSupplyIssues(from, to) {
  S.live._siLoading = true; S.live.supplyIssues = null; render();
  const data = await api.get(`/api/reports/supply-issues?from=${from}&to=${to}`);
  S.live.supplyIssues = data || null;
  S.live._siLoading = false;
  if (S.screen === "reports" || S.screen === "supply_issues") render();
}

function fmtColDate(d) {
  const [, m, day] = d.split('-');
  return `${parseInt(day,10)}/${parseInt(m,10)}`;
}

function renderSupplyPivot(rows, dates, valueKey, label, colorFn) {
  if (!rows.length) return `<div style="color:var(--muted);font-size:13px;padding:8px 0">No ${label} issues in this period.</div>`;

  // Build row map: "unit|||route|||sub" → { state, zone, unit, route, sub, byDate }
  const map = {};
  const order = [];
  rows.forEach(r => {
    const k = `${r.unit_name}|||${r.route_name}|||${r.sub_route_name}`;
    if (!map[k]) {
      // Fallback: RP units without hierarchy → RAJASTHAN; unknown zone → unit_name
      const rawState = r.state_name && r.state_name !== 'State Unknown' ? r.state_name : null;
      const rawZone  = r.zone_name  && r.zone_name  !== 'Zone Unknown'  ? r.zone_name  : null;
      map[k] = {
        state: rawState ? 'VP: ' + rawState
              : r.unit_name?.endsWith(' RP') ? 'RAJASTHAN' : (r.unit_name || 'Unassigned'),
        zone:  rawZone ? 'ZH: ' + rawZone : (r.unit_name || 'Unassigned'),
        unit: r.unit_name, route: r.route_name, sub: r.sub_route_name,
        byDate: {}
      };
      order.push(k);
    }
    map[k].byDate[r.rpt_date] = r[valueKey] || (valueKey === 'last_late' ? r.last_late : '✗');
  });

  // Build 3-level index: state → zone → [keys]
  const stateIndex = {};
  order.forEach(k => {
    const { state, zone } = map[k];
    if (!stateIndex[state])        stateIndex[state] = {};
    if (!stateIndex[state][zone])  stateIndex[state][zone] = [];
    stateIndex[state][zone].push(k);
  });

  const colCount = 3 + dates.length + 2;
  const colW = `${Math.min(80, Math.floor(300 / Math.max(dates.length, 1)))}px`;

  let html = `<div style="overflow-x:auto;margin-bottom:24px">
    <table style="border-collapse:collapse;font-size:12px;min-width:700px;width:100%">
      <thead>
        <tr style="background:var(--navy);color:#fff">
          <th style="text-align:left;padding:7px 10px;white-space:nowrap">Unit Name</th>
          <th style="text-align:left;padding:7px 10px;white-space:nowrap">Route Name</th>
          <th style="text-align:left;padding:7px 10px;white-space:nowrap">Sub Route</th>
          ${dates.map(d => `<th style="text-align:center;padding:7px 6px;min-width:${colW};white-space:nowrap">${fmtColDate(d)}</th>`).join('')}
          <th style="text-align:center;padding:7px 8px;white-space:nowrap">📧 Email</th>
          <th style="text-align:center;padding:7px 8px;white-space:nowrap">📱 WA</th>
        </tr>
      </thead><tbody>`;

  Object.keys(stateIndex).sort().forEach(stateName => {
    const zoneMap = stateIndex[stateName];
    const stateTotalRoutes = Object.values(zoneMap).reduce((s, v) => s + v.length, 0);

    // State header — stateName already has "VP: ..." or "RAJASTHAN" prefix from map build
    html += `<tr>
      <td colspan="${colCount}" style="padding:8px 12px;background:#0f1f36;color:#93c5fd;font-size:12px;font-weight:700;letter-spacing:0.3px">
        📍 ${esc(stateName)}&ensp;<span style="font-weight:400;font-size:11px;color:#60a5fa">${stateTotalRoutes} route${stateTotalRoutes !== 1 ? 's' : ''}</span>
      </td></tr>`;

    Object.keys(zoneMap).sort().forEach(zoneName => {
      const zoneKeys = zoneMap[zoneName];

      // Zone header — zoneName already has "ZH: ..." or unit_name prefix from map build
      html += `<tr>
        <td colspan="${colCount}" style="padding:6px 12px 6px 24px;background:#1C2B45;color:#bfdbfe;font-size:11px;font-weight:700">
          🗺 ${esc(zoneName)}&ensp;<span style="font-weight:400">${zoneKeys.length} route${zoneKeys.length !== 1 ? 's' : ''}</span>
        </td></tr>`;

      // Group by unit within zone
      const unitsInZone = [...new Set(zoneKeys.map(k => map[k].unit))];
      unitsInZone.forEach((unit, ui) => {
        const unitKeys = zoneKeys.filter(k => map[k].unit === unit);
        const unitBg = ui % 2 === 0 ? 'var(--surf)' : 'var(--surf2)';

        unitKeys.forEach((k, ri) => {
          const row = map[k];
          const cells = dates.map(d => {
            const val = row.byDate[d];
            if (!val) return `<td style="text-align:center;padding:5px 6px;border-bottom:1px solid var(--border)">—</td>`;
            return `<td style="text-align:center;padding:5px 6px;border-bottom:1px solid var(--border);${colorFn(val)}">${val}</td>`;
          }).join('');
          const latestDate = Object.keys(row.byDate).sort().pop() || '';
          const uJ = JSON.stringify(row.unit), rJ = JSON.stringify(row.route),
                sJ = JSON.stringify(row.sub),  dJ = JSON.stringify(latestDate);
          html += `<tr style="background:${unitBg}">
            <td style="padding:5px 10px 5px 32px;border-bottom:1px solid var(--border);font-weight:${ri===0?'700':'400'};white-space:nowrap">${ri===0?esc(unit):''}</td>
            <td style="padding:5px 10px;border-bottom:1px solid var(--border);white-space:nowrap">${esc(row.route)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid var(--border);color:var(--muted);white-space:nowrap">${esc(row.sub)}</td>
            ${cells}
            <td style="text-align:center;padding:4px 6px;border-bottom:1px solid var(--border)">
              <button class="btn sm" title="Email admin for ${esc(row.route)} on ${latestDate}"
                onclick="sendRouteAlert(${uJ},${rJ},${sJ},${dJ},'email')"
                style="font-size:11px;padding:2px 7px;line-height:1.4">📧 Email</button>
            </td>
            <td style="text-align:center;padding:4px 6px;border-bottom:1px solid var(--border)">
              <button class="btn sm" title="WhatsApp driver for ${esc(row.route)} on ${latestDate}"
                onclick="sendRouteAlert(${uJ},${rJ},${sJ},${dJ},'whatsapp')"
                style="font-size:11px;padding:2px 7px;line-height:1.4">📱 WA</button>
            </td>
          </tr>`;
        });

        // Unit subtotal
        const subCells = dates.map(d => {
          const cnt = unitKeys.filter(k => map[k].byDate[d]).length;
          return `<td style="text-align:center;padding:4px 6px;background:var(--navy-l);font-size:11px;color:var(--navy);font-weight:700">${cnt||'—'}</td>`;
        }).join('');
        html += `<tr style="background:var(--navy-l)">
          <td colspan="3" style="padding:4px 10px 4px 32px;font-size:11px;font-weight:700;color:var(--navy)">${esc(unit)} — ${unitKeys.length} route${unitKeys.length!==1?'s':''}</td>
          ${subCells}<td colspan="2"></td></tr>`;
      });
    });
  });

  html += `</tbody></table></div>`;
  return html;
}

VIEWS.reports = () => {
  const si = S.live.supplyIssues;
  const loading = S.live._siLoading;

  // Default date range: last 7 days
  const today = new Date(); today.setHours(0,0,0,0);
  const d7 = new Date(today); d7.setDate(d7.getDate() - 6);
  const fmt = d => d.toISOString().slice(0,10);
  const curFrom = S.live._siFrom || fmt(d7);
  const curTo   = S.live._siTo   || fmt(today);

  const dateBar = `<div class="card pad" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
    <b style="font-size:13px">Supply Issues Report</b>
    <label style="font-size:12px">From <input type="date" id="si_from" value="${curFrom}" style="margin-left:4px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surf)"></label>
    <label style="font-size:12px">To <input type="date" id="si_to" value="${curTo}" style="margin-left:4px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surf)"></label>
    <button class="btn sm" onclick="loadSI()" style="font-size:12px">🔍 Load</button>
    ${si ? `<span style="font-size:11px;color:var(--muted);margin-left:auto">${si.dates.length} date${si.dates.length!==1?'s':''} · ${si.late.length + si.app_not_running.length} total issues · use 📧/📱 buttons per row to notify</span>` : ''}
  </div>`;

  let body = '';
  if (loading) {
    body = `<div style="text-align:center;padding:40px;color:var(--muted)">Loading report…</div>`;
  } else if (!si) {
    body = `<div class="card pad" style="text-align:center;padding:32px;color:var(--muted)">Select a date range and click Load to generate the report.</div>`;
  } else {
    const dates = si.dates;
    const title = (lbl, sub) => `<div style="margin-bottom:8px">
      <h3 style="margin:0;font-size:14px;font-weight:700">${lbl}</h3>
      <div style="font-size:11px;color:var(--muted)">${sub}</div></div>`;

    // Section 1: Late taxis
    const lateTitle = `SUPPLY TAXI REACHED AFTER 6 AM · ${si.from.split('-').reverse().join('/')} to ${si.to.split('-').reverse().join('/')}`;
    body += `<div class="card pad" style="margin-bottom:16px">
      ${title(lateTitle, `${si.late.length} route-date combinations with late delivery`)}
      ${renderSupplyPivot(si.late, dates, 'last_late', 'late',
        val => 'color:#dc2626;font-weight:700;'
      )}
    </div>`;

    // Section 2: App not running
    body += `<div class="card pad">
      ${title('APP NOT RUNNING (App KM = 0)', `${si.app_not_running.length} route-date combinations with zero app km`)}
      ${renderSupplyPivot(si.app_not_running, dates, 'vehicle_no', 'app-not-running',
        val => 'color:#d97706;font-weight:700;'
      )}
    </div>`;
  }

  return pagehead("Reports", "Supply issues, late taxis, app not running") + dateBar + body;
};

window.loadSI = function() {
  const from = document.getElementById('si_from')?.value;
  const to   = document.getElementById('si_to')?.value;
  if (!from || !to) { toast("Select date range"); return; }
  S.live._siFrom = from; S.live._siTo = to;
  fetchSupplyIssues(from, to);
};

window.sendRouteAlert = async function(unit, route, sub, date, channel) {
  if (!date) { toast("No date available for this route"); return; }
  const icon  = channel === 'email' ? '📧' : '📱';
  const label = channel === 'email' ? 'email' : 'WhatsApp';
  toast(`${icon} Sending ${label} — ${route} (${date})…`);
  const result = await api.post('/api/alerts/supply-issues',
    { date, unit_name: unit, route_name: route, sub_route_name: sub, channel });
  if (!result) { toast(`${icon} Failed — check server logs`); return; }
  const { sent } = result;
  const count = channel === 'email' ? sent.emails : sent.whatsapp;
  const err   = sent.errors.length ? ` · ${sent.errors[0]}` : '';
  toast(`${icon} ${count} ${label}${count !== 1 ? 's' : ''} sent${err}`.slice(0, 120));
};

/* ════════════════════════════════════════════════════════════
   AGENCY OUTSTANDING DASHBOARD
   ════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────
const ouState = () => S.live.ou || (S.live.ou = {
  tab: 'overview', filters: {}, filterOpts: null, kpis: null,
  ageing: null, agencies: null, top: null, trend: null, unitSummary: null,
  topLimit: 10, topSort: 'outstanding', agSort: 'outstanding',
  agPage: 1, agSearch: '', agBucket: null, _loading: {},
});

function ouApi(path) { return `${location.protocol}//${location.hostname}:8001/api/outstanding/${path}`; }

function ouQS(extra = '') {
  const st = ouState();
  const f = st.filters;
  const p = new URLSearchParams();
  if (f.state)     p.set('state',     f.state);
  if (f.unit_code) p.set('unit_code', f.unit_code);
  if (f.ag_status) p.set('ag_status', f.ag_status);
  if (f.ag_type)   p.set('ag_type',   f.ag_type);
  if (f.zh_name)   p.set('zh_name',   f.zh_name);
  const base = p.toString();
  return (base || extra) ? '?' + [base, extra].filter(Boolean).join('&') : '';
}

function ouFetch(key, path, extra) {
  const st = ouState();
  if (st._loading[key] || st[key]) return;
  st._loading[key] = true;
  api.get('/api/outstanding/' + path + ouQS(extra))
    .then(d => { st[key] = d; st._loading[key] = false; if (S.screen === 'outstanding') render(); })
    .catch(() => { st._loading[key] = false; });
}

function ouClearCache(keepFilters = true) {
  const f = keepFilters ? (S.live.ou?.filters || {}) : {};
  const filterOpts = S.live.ou?.filterOpts;
  S.live.ou = null;
  ouState();
  S.live.ou.filters = f;
  S.live.ou.filterOpts = filterOpts;
}

function ouTriggerSync(monthly) {
  const st = ouState();
  if (st._syncing) { toast('Sync already in progress…'); return; }
  st._syncing = true;
  toast(monthly ? 'Starting sync (CURRENT + monthly)…' : 'Starting sync (CURRENT)…');
  fetch(`${location.protocol}//${location.hostname}:8001/api/sync/outstanding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ monthly }),
  }).then(r => r.json()).then(d => {
    if (d.error) { st._syncing = false; toast('Sync error: ' + d.error); return; }
    toast('Sync started — this takes 2-5 min. Data will refresh when done.');
    ouPollSyncStatus();
  }).catch(e => { st._syncing = false; toast('Could not start sync: ' + e.message); });
}

function ouPollSyncStatus() {
  fetch(`${location.protocol}//${location.hostname}:8001/api/sync/outstanding/status`)
    .then(r => r.json()).then(d => {
      const st = ouState();
      if (d.running) {
        toast('Sync in progress… (' + (d.recentLog?.slice(-1)[0] || '') + ')');
        setTimeout(ouPollSyncStatus, 10000);
      } else {
        st._syncing = false;
        if (d.status === 'success') {
          toast(`Sync complete — ${d.result?.totalRows?.toLocaleString()||'?'} rows. Refreshing…`);
          ouClearCache(true);
          if (S.screen === 'outstanding') render();
        } else if (d.status === 'error') {
          toast('Sync failed: ' + (d.error || 'unknown error'));
        }
      }
    }).catch(() => { ouState()._syncing = false; });
}

window.ouClickBucket = function(days) {
  const st = ouState();
  st.agBucket = days;
  st.agencies = null;
  st._agCacheKey = null;
  st.tab = 'agencies';
  render();
};

window.ouClickUnit = function(unitCode) {
  const st = ouState();
  st.filters = Object.assign({}, st.filters, { unit_code: unitCode });
  st.agencies = null;
  st.kpis = null;
  st.ageing = null;
  st.unitSummary = null;
  st._agCacheKey = null;
  st.tab = 'agencies';
  render();
};

// ── Formatters ──────────────────────────────────────────────
const ouFmtC = n => { if (!n && n !== 0) return '—'; const a = Math.abs(n); let s; if (a >= 1e7) s = (a/1e7).toFixed(2)+' Cr'; else if (a >= 1e5) s = (a/1e5).toFixed(2)+' L'; else s = fmtN(Math.round(a)); return (n < 0 ? '-' : '') + '₹' + s; };
const ouFmtN = n => (!n && n !== 0) ? '—' : fmtN(Math.round(n));
const ouRiskColor = r => ({ Critical:'var(--red)', High:'#e67e22', Medium:'#f1c40f', Low:'var(--grn)', Clear:'var(--grn-l)' }[r] || 'var(--ink-2)');
const ouRiskBg    = r => ({ Critical:'var(--red-l)', High:'#fef3e2', Medium:'#fef9e7', Low:'var(--grn-l)', Clear:'var(--grn-l)' }[r] || 'var(--surface-2)');

// ── Render helpers ──────────────────────────────────────────
function ouKpiCard(icon, label, value, sub, color) {
  return `<div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:4px">
    <div style="font-size:18px">${icon}</div>
    <div style="font-size:20px;font-weight:800;color:${color||'var(--text)'};line-height:1">${value}</div>
    <div style="font-size:11px;font-weight:700;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em">${label}</div>
    ${sub ? `<div style="font-size:10px;color:var(--muted)">${sub}</div>` : ''}
  </div>`;
}

function ouBar(pct, color) {
  return `<div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;min-width:60px">
    <div style="height:100%;width:${Math.min(100,pct||0).toFixed(1)}%;background:${color};border-radius:3px;transition:width .4s"></div>
  </div>`;
}

function ouAgeingChart(buckets) {
  if (!buckets?.length) return '';
  const max = Math.max(...buckets.map(b => b.amt), 1);
  const colors = ['#2ecc71','#f39c12','#e67e22','#e74c3c','#8e44ad'];
  const bars = buckets.map((b, i) => {
    const w = (b.amt / max * 100).toFixed(1);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:0">
      <div style="font-size:10px;font-weight:700;color:${colors[i]}">${ouFmtC(b.amt)}</div>
      <div style="width:100%;background:var(--surface-2);border-radius:4px;height:80px;display:flex;align-items:flex-end;overflow:hidden">
        <div style="width:100%;height:${w}%;background:${colors[i]};border-radius:4px 4px 0 0;transition:height .5s"></div>
      </div>
      <div style="font-size:10px;text-align:center;color:var(--ink-2)">${b.label}</div>
      <div style="font-size:9px;color:var(--muted)">${b.cnt} agencies</div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:8px;align-items:flex-end;padding:12px 0">${bars}</div>`;
}

function ouTrendChart(months) {
  if (!months?.length) return `<div style="text-align:center;color:var(--muted);padding:24px;font-size:12px">Run sync with <code>--monthly</code> flag to enable trend data.</div>`;
  const max = Math.max(...months.flatMap(m => [m.bill_amt, m.collected, m.cl_amt]), 1);
  const W = 100 / months.length;
  const labels = months.map(m => m.month.slice(5)); // MM
  const MON = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `<div style="overflow-x:auto">
    <div style="min-width:${Math.max(400, months.length * 80)}px;padding:8px 0">
      <div style="display:flex;gap:6px;margin-bottom:8px;font-size:10px;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:var(--navy);border-radius:2px;display:inline-block"></span>Billing</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#2ecc71;border-radius:2px;display:inline-block"></span>Collected</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#e74c3c;border-radius:2px;display:inline-block"></span>Outstanding</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:4px;height:120px">
        ${months.map(m => {
          const bH = (m.bill_amt/max*100).toFixed(1), cH = (m.collected/max*100).toFixed(1), oH = (m.cl_amt/max*100).toFixed(1);
          const mon = MON[parseInt(m.month.slice(5),10)] || m.month.slice(5);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px">
            <div style="width:100%;display:flex;gap:1px;align-items:flex-end;height:100px">
              <div style="flex:1;background:var(--navy);height:${bH}%;border-radius:2px 2px 0 0;min-height:2px" title="Billing: ${ouFmtC(m.bill_amt)}"></div>
              <div style="flex:1;background:#2ecc71;height:${cH}%;border-radius:2px 2px 0 0;min-height:2px" title="Collected: ${ouFmtC(m.collected)}"></div>
              <div style="flex:1;background:#e74c3c;height:${oH}%;border-radius:2px 2px 0 0;min-height:2px" title="Outstanding: ${ouFmtC(m.cl_amt)}"></div>
            </div>
            <div style="font-size:9px;color:var(--muted)">${mon}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

// ── Tab: Overview ───────────────────────────────────────────
function ouOverviewTab() {
  const st = ouState();
  if (!st.kpis) ouFetch('kpis', 'kpis');
  if (!st.ageing) ouFetch('ageing', 'ageing');
  if (!st.unitSummary) ouFetch('unitSummary', 'unit-summary');

  const k = st.kpis, loading = !k;
  const spin = `<span style="color:var(--muted)">Loading…</span>`;

  // KPI grid
  const kpiGrid = loading ? spin : `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon:'💰', label:'Total Outstanding',   value:ouFmtC(k.total_outstanding),   status:'dn' })}
    ${vzKpi({ icon:'📅', label:'Current Outstanding', value:ouFmtC(k.current_outstanding), sub:'Within 30 days', status:'dn' })}
    ${vzKpi({ icon:'⚠️', label:'Overdue Outstanding', value:ouFmtC(k.overdue_outstanding),  sub:'31+ days', status:'dn' })}
    ${vzKpi({ icon:'🏢', label:'Total Agencies',      value:ouFmtN(k.total_agencies),       status:'fl' })}
    ${vzKpi({ icon:'📌', label:'With Outstanding',    value:ouFmtN(k.agencies_with_outstanding), sub:'of '+ouFmtN(k.total_agencies), status:'dn' })}
    ${vzKpi({ icon:'📋', label:'Total Billed',        value:ouFmtC(k.total_billed),         status:'fl' })}
    ${vzKpi({ icon:'✅', label:'Amount Collected',    value:ouFmtC(k.total_collected),      status:'up' })}
    ${vzKpi({ icon:'📊', label:'Collection %',        value:k.collection_pct+'%', status:k.collection_pct>=80?'up':k.collection_pct>=60?'fl':'dn' })}
    ${vzKpi({ icon:'🚨', label:'Overdue Agencies',    value:ouFmtN(k.overdue_ag_count),     sub:'31+ days no supply', status:'dn' })}
    ${vzKpi({ icon:'🔴', label:'Critical (₹2L+)',     value:ouFmtN(k.critical_count)+' agencies', sub:ouFmtC(k.critical_outstanding), status:'dn' })}
  </div>`;

  // Ageing section
  const ag = st.ageing;
  const agSection = !ag ? spin : `
    <div class="vz-sec" style="margin-bottom:12px">
      <div class="sdv-sec-head" style="border-left-color:var(--chart-1)">
        <div class="sdv-sec-title">Outstanding Ageing Analysis</div>
        <div class="sdv-sec-sub">Distribution of outstanding by age — based on last supply date</div>
      </div>
      ${ouAgeingChart(ag.buckets)}
      <div style="overflow-x:auto;margin-top:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--navy);color:#fff">
            ${['Bucket','Amount','Agencies','% of Total'].map(h => `<th style="padding:6px 10px;text-align:left">${h}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${ag.buckets.map((b, i) => {
              const pct = k ? (b.amt / k.total_outstanding * 100).toFixed(1) : '—';
              const colors = ['#2ecc71','#f39c12','#e67e22','#e74c3c','#8e44ad'];
              const bg = i%2 ? 'background:var(--surface-2);' : '';
              return `<tr style="${bg}cursor:pointer" onclick="ouClickBucket('${b.days}')" title="Click to view agencies in this bucket">
                <td style="padding:6px 10px;font-weight:600"><span style="display:inline-block;width:10px;height:10px;background:${colors[i]};border-radius:2px;margin-right:6px;vertical-align:middle"></span>${b.label} <span style="font-size:10px;color:var(--muted);font-weight:400">↗</span></td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums;font-weight:700">${ouFmtC(b.amt)}</td>
                <td style="padding:6px 10px">${b.cnt}</td>
                <td style="padding:6px 10px">${pct}%${ouBar(parseFloat(pct), colors[i])}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  // Unit-wise summary
  const us = st.unitSummary;
  const unitSection = !us ? spin : `
    <div class="vz-sec" style="margin-bottom:12px">
      <div class="sdv-sec-head" style="border-left-color:var(--chart-1)">
        <div class="sdv-sec-title">Unit-wise Outstanding Summary</div>
        <div class="sdv-sec-sub">Branch-level outstanding breakdown</div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:700px">
          <thead><tr style="background:var(--navy);color:#fff">
            ${['Unit','Zonal Head','Agencies','With O/S','Billing','Collected','Outstanding','Coll%'].map(h => `<th style="padding:6px 10px;text-align:left;white-space:nowrap">${h}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${(() => {
              const stateLabel = s => s === 'RPPL' ? 'Rajasthan' : (s || 'Other');
              const byState = {};
              (us.rows || []).forEach(r => { const s = stateLabel(r.group_unit_name); if (!byState[s]) byState[s] = []; byState[s].push(r); });
              const stateEntries = Object.entries(byState);
              let html = '', ri = 0;
              stateEntries.forEach(([state, srows]) => {
                const sCl = srows.reduce((t, r) => t + Number(r.cl_amt || 0), 0);
                html += '<tr style="background:var(--navy);color:#fff"><td colspan="8" style="padding:5px 10px;font-size:11px;font-weight:700;letter-spacing:.3px">📍 ' + esc(state) + ' &nbsp;·&nbsp; O/S: ' + ouFmtC(sCl) + ' &nbsp;·&nbsp; ' + srows.length + ' units</td></tr>';
                srows.forEach(r => {
                  const bg = (ri++ % 2) ? 'background:var(--surface-2);' : '';
                  html += '<tr style="' + bg + 'cursor:pointer" onclick="ouClickUnit(\'' + r.unit_code + '\')" title="View agencies for ' + esc(r.unit_name || r.unit_code) + '">'
                    + '<td style="padding:6px 10px;font-weight:600">' + esc(r.unit_name || r.unit_code) + '</td>'
                    + '<td style="padding:6px 10px;color:var(--muted);font-size:11px">' + esc(r.zh_name || '—') + '</td>'
                    + '<td style="padding:6px 10px">' + r.agencies + '</td>'
                    + '<td style="padding:6px 10px">' + r.with_outstanding + '</td>'
                    + '<td style="padding:6px 10px;font-variant-numeric:tabular-nums">' + ouFmtC(r.bill_amt) + '</td>'
                    + '<td style="padding:6px 10px;font-variant-numeric:tabular-nums">' + ouFmtC(r.collected) + '</td>'
                    + '<td style="padding:6px 10px;font-variant-numeric:tabular-nums;font-weight:700;color:' + (Number(r.cl_amt) > 0 ? 'var(--red)' : 'var(--grn)') + '">' + ouFmtC(r.cl_amt) + '</td>'
                    + '<td style="padding:6px 10px">' + r.coll_pct + '%' + ouBar(Number(r.coll_pct), Number(r.coll_pct) >= 80 ? '#2ecc71' : '#e74c3c') + '</td>'
                    + '</tr>';
                });
              });
              return html;
            })()}
          </tbody>
        </table>
      </div>
    </div>`;

  return kpiGrid + agSection + unitSection;
}

// ── Tab: Agencies ───────────────────────────────────────────
function ouAgenciesTab() {
  const st = ouState();
  const page = st.agPage, sort = st.agSort, bucket = st.agBucket;
  const qExtra = `sort=${sort}&page=${page}&limit=50${st.agSearch ? '&search=' + encodeURIComponent(st.agSearch) : ''}${bucket ? '&bucket=' + encodeURIComponent(bucket) : ''}`;

  // Bust cache when sort/page/search/bucket changes
  const cacheKey = `agencies_${sort}_${page}_${st.agSearch}_${bucket||''}`;
  if (st._agCacheKey !== cacheKey) { st.agencies = null; st._agCacheKey = cacheKey; }
  if (!st.agencies) ouFetch('agencies', 'agencies', qExtra);

  const d = st.agencies;

  const sortBtn = (s, label) =>
    `<button class="btn sm${sort === s ? ' navy' : ''}" style="font-size:11px" onclick="ouState().agSort='${s}';ouState().agencies=null;ouState().agPage=1;render()">${label}</button>`;

  const bucketChip = bucket ? `<div style="display:inline-flex;align-items:center;gap:5px;background:var(--navy);color:#fff;border-radius:14px;padding:3px 10px;font-size:11px;font-weight:600">
    Bucket: ${bucket} Days
    <span onclick="ouState().agBucket=null;ouState().agencies=null;render()" style="cursor:pointer;opacity:.7;font-size:14px;line-height:1" title="Clear bucket filter">✕</span>
  </div>` : '';

  const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
    <div style="flex:1;min-width:160px">
      <input class="inp" placeholder="Search agency / city…" value="${esc(st.agSearch||'')}" style="font-size:12px;padding:5px 8px;width:100%"
        oninput="ouState().agSearch=this.value;ouState().agencies=null;ouState().agPage=1;if(S.screen==='outstanding')render()">
    </div>
    ${bucketChip}
    <div style="display:flex;gap:4px;flex-wrap:wrap">
      ${sortBtn('outstanding','Highest Outstanding')}
      ${sortBtn('collection','Lowest Collection %')}
      ${sortBtn('overdue','Most Overdue')}
      ${sortBtn('billing','Highest Billing')}
      ${sortBtn('name','Name A–Z')}
    </div>
  </div>`;

  if (!d) return controls + `<div style="text-align:center;color:var(--muted);padding:32px">Loading agencies…</div>`;

  const { total, rows = [] } = d;
  const pages = Math.ceil(total / 50);

  const tbl = `<div style="overflow:auto;max-height:65vh;border:1px solid var(--brd);border-radius:8px">
    <table style="border-collapse:collapse;font-size:11px;min-width:1100px;width:100%">
      <thead><tr style="position:sticky;top:0;background:var(--navy);color:#fff;z-index:2">
        ${['Code','Agency Name','Unit','City','Type','Billing','Collected','Curr. O/S','Overdue O/S','Total O/S','Last Payment','Days','Coll%','Risk'].map(h=>`<th style="padding:6px 8px;text-align:left;white-space:nowrap">${h}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${rows.map((r,i)=>{
          const risk = r.risk_status || 'Low';
          const days = Number(r.days_since_supply)||0;
          const overdueAmt = days > 30 ? Number(r.cl_amt)||0 : 0;
          const currAmt   = days <= 30 ? Number(r.cl_amt)||0 : 0;
          return `<tr style="${i%2?'background:var(--surface-2)':''}">
            <td style="padding:5px 8px;color:var(--muted);white-space:nowrap">${esc(r.ag_code)}</td>
            <td style="padding:5px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.ag_name)}">${esc(r.ag_name)}</td>
            <td style="padding:5px 8px;white-space:nowrap">${esc(r.unit_name||r.unit_code||'')}</td>
            <td style="padding:5px 8px;white-space:nowrap">${esc(r.city_name||'')}</td>
            <td style="padding:5px 8px">${esc(r.ag_type||'')}</td>
            <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right">${ouFmtC(r.bill_amt)}</td>
            <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right;color:#2ecc71">${ouFmtC(Number(r.rec_amt)+Number(r.other_cr))}</td>
            <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right;color:${currAmt>0?'#e67e22':'var(--text)'}">${ouFmtC(currAmt)}</td>
            <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right;color:${overdueAmt>0?'var(--red)':'var(--text)'}">${ouFmtC(overdueAmt)}</td>
            <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right;font-weight:700;color:${Number(r.cl_amt)>0?'var(--red)':'var(--grn)'}">${ouFmtC(r.cl_amt)}</td>
            <td style="padding:5px 8px;white-space:nowrap">${r.last_supply_date||'—'}</td>
            <td style="padding:5px 8px;text-align:right;font-weight:${days>30?700:400};color:${days>60?'var(--red)':days>30?'#e67e22':'var(--text)'}">${days||'—'}</td>
            <td style="padding:5px 8px;text-align:right">${r.coll_pct!=null?r.coll_pct+'%':'—'}</td>
            <td style="padding:5px 8px"><span style="background:${ouRiskBg(risk)};color:${ouRiskColor(risk)};border-radius:10px;padding:2px 7px;font-size:10px;font-weight:700">${risk}</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;

  const pager = pages > 1 ? `<div style="display:flex;gap:6px;margin-top:8px;justify-content:center;flex-wrap:wrap">
    ${page>1?`<button class="btn sm" onclick="ouState().agPage=${page-1};ouState().agencies=null;render()">← Prev</button>`:''}
    <span style="font-size:12px;align-self:center">Page ${page} of ${pages} · ${total} agencies</span>
    ${page<pages?`<button class="btn sm" onclick="ouState().agPage=${page+1};ouState().agencies=null;render()">Next →</button>`:''}
  </div>` : `<div style="font-size:11px;color:var(--muted);margin-top:6px">${total} agencies</div>`;

  return controls + tbl + pager;
}

// ── Tab: Top Agencies ───────────────────────────────────────
function ouTopTab() {
  const st = ouState();
  const limit = st.topLimit, sort = st.topSort;
  const cacheKey = `top_${limit}_${sort}`;
  if (st._topKey !== cacheKey) { st.top = null; st._topKey = cacheKey; }
  if (!st.top) ouFetch('top', 'top', `limit=${limit}&sort=${sort}`);

  const sortBtn = (s, label) =>
    `<button class="btn sm${sort===s?' navy':''}" style="font-size:11px" onclick="ouState().topSort='${s}';ouState().top=null;render()">${label}</button>`;
  const limBtn = (n) =>
    `<button class="btn sm${limit===n?' navy':''}" style="font-size:11px" onclick="ouState().topLimit=${n};ouState().top=null;render()">Top ${n}</button>`;

  const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <div style="display:flex;gap:4px">${limBtn(10)}${limBtn(20)}${limBtn(50)}</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap">
      ${sortBtn('outstanding','Highest Outstanding')}
      ${sortBtn('overdue','Most Overdue')}
      ${sortBtn('oldest','Oldest Outstanding')}
      ${sortBtn('collection','Lowest Collection %')}
    </div>
  </div>`;

  if (!st.top) return controls + `<div style="text-align:center;color:var(--muted);padding:32px">Loading…</div>`;

  const rows = st.top.rows || [];
  const maxAmt = Math.max(...rows.map(r => Number(r.cl_amt)||0), 1);

  const list = rows.map((r, i) => {
    const risk = r.risk_status || 'Low';
    const pct  = (Number(r.cl_amt) / maxAmt * 100).toFixed(1);
    const days = Number(r.days_since_supply) || 0;
    return `<div class="card" style="padding:12px 14px;margin-bottom:6px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="font-size:18px;font-weight:800;color:var(--muted);min-width:28px;text-align:right">#${i+1}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px">
            <div>
              <div style="font-weight:700;font-size:13px">${esc(r.ag_name)}</div>
              <div style="font-size:11px;color:var(--muted)">${esc(r.unit_name||'')} · ${esc(r.city_name||'')} · ${esc(r.ag_type||'')}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:800;color:var(--red)">${ouFmtC(r.cl_amt)}</div>
              <span style="background:${ouRiskBg(risk)};color:${ouRiskColor(risk)};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700">${risk}</span>
            </div>
          </div>
          ${ouBar(parseFloat(pct), ouRiskColor(risk))}
          <div style="display:flex;gap:12px;margin-top:6px;flex-wrap:wrap;font-size:11px;color:var(--muted)">
            <span>Billed: <b style="color:var(--text)">${ouFmtC(r.bill_amt)}</b></span>
            <span>Collected: <b style="color:#2ecc71">${ouFmtC(Number(r.rec_amt)+Number(r.other_cr))}</b></span>
            <span>Coll%: <b style="color:${Number(r.coll_pct)>=80?'#2ecc71':'var(--red)'}">${r.coll_pct}%</b></span>
            <span>Last Supply: <b style="color:${days>30?'var(--red)':'var(--text)'}">${r.last_supply_date||'—'} ${days?`(${days}d ago)`:''}</b></span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  return controls + (rows.length ? list : `<div style="text-align:center;color:var(--muted);padding:32px">No data. Run oracle_outstanding_sync.js first.</div>`);
}

// ── Tab: Trend ──────────────────────────────────────────────
function ouTrendTab() {
  const st = ouState();
  if (!st.trend) ouFetch('trend', 'trend');
  if (!st.trend) return `<div style="text-align:center;color:var(--muted);padding:32px">Loading trend data…</div>`;
  const { months = [], note } = st.trend;
  if (note && !months.length) return `<div class="card" style="padding:20px;text-align:center">
    <div style="font-size:24px;margin-bottom:8px">📅</div>
    <div style="font-weight:700">Monthly trend data not yet available</div>
    <div style="color:var(--muted);font-size:12px;margin-top:6px">Run: <code>node api/oracle_outstanding_sync.js --monthly</code></div>
  </div>`;
  const MON = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `
    <div class="card" style="padding:14px 16px;margin-bottom:12px">
      <div class="sdv-sec-head" style="border-left-color:var(--navy)">
        <div class="sdv-sec-title">Monthly Outstanding Trend</div>
        <div class="sdv-sec-sub">Opening → Billing → Collection → Closing outstanding each month</div>
      </div>
      ${ouTrendChart(months)}
    </div>
    <div class="card" style="padding:14px 16px">
      <div style="overflow-x:auto">
        <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:500px">
          <thead><tr style="background:var(--navy);color:#fff">
            ${['Month','Opening O/S','Billing','Collected','Closing O/S','Net Change'].map(h=>`<th style="padding:6px 10px;text-align:left">${h}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${months.map((m,i)=>{
              const net = (m.cl_amt - m.op_amt);
              return `<tr style="${i%2?'background:var(--surface-2)':''}">
                <td style="padding:6px 10px;font-weight:600">${MON[parseInt(m.month.slice(5),10)]||m.month} 2026</td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(m.op_amt)}</td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(m.bill_amt)}</td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums;color:#2ecc71">${ouFmtC(m.collected)}</td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums;font-weight:700;color:${m.cl_amt>0?'var(--red)':'var(--grn)'}">${ouFmtC(m.cl_amt)}</td>
                <td style="padding:6px 10px;font-variant-numeric:tabular-nums;color:${net>0?'var(--red)':'#2ecc71'}">${net>0?'+':''}${ouFmtC(net)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ── Filter panel ────────────────────────────────────────────
function ouFilterPanel() {
  const st = ouState();
  if (!st.filterOpts) {
    api.get('/api/outstanding/filters').then(d => { st.filterOpts = d; if (S.screen==='outstanding') render(); });
    return '';
  }
  const { states=[], units=[], statuses=[], types=[], zh_names=[], synced_at, period_to } = st.filterOpts;
  const f = st.filters;
  const STATE_LABEL = { RPPL:'Rajasthan', MP:'Madhya Pradesh', CG:'Chhattisgarh', NATIONAL:'National' };

  // Cascade: filter units and ZHs by selected state
  const activeUnits = f.state ? units.filter(u => u.state === f.state) : units;
  const activeZHs   = f.state ? zh_names.filter(z => z.state === f.state) : zh_names;

  const sel = (name, opts, val, label, onChange) => {
    const change = onChange || `ouState().filters['${name}']=this.value;ouClearCache();render()`;
    return `<select class="inp" style="font-size:12px;padding:5px 6px" onchange="${change}">
      <option value="">${label}</option>
      ${opts.map(o => typeof o==='string'
        ? `<option value="${esc(o)}" ${val===o?'selected':''}>${esc(STATE_LABEL[o]||o)}</option>`
        : `<option value="${esc(o.code)}" ${val===o.code?'selected':''}>${esc(o.name||o.code)}</option>`).join('')}
    </select>`;
  };

  // When state changes, also reset unit_code and zh_name (they may not exist in new state)
  const onStateChange = `ouState().filters.state=this.value;ouState().filters.unit_code='';ouState().filters.zh_name='';ouClearCache();render()`;

  const syncInfo = synced_at ? `<span style="font-size:10px;color:var(--muted)">Synced: ${new Date(synced_at).toLocaleDateString('en-IN')} · Period to: ${period_to||'—'}</span>` : '';
  const hasFilter = Object.values(f).some(Boolean);
  return `<div class="card" style="padding:10px 14px;margin-bottom:10px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      ${sel('state',     states,      f.state,     '🗺 All States', onStateChange)}
      ${sel('unit_code', activeUnits, f.unit_code, 'All Units')}
      ${sel('zh_name',   activeZHs,   f.zh_name,   'All ZH')}
      ${sel('ag_status', statuses,    f.ag_status, 'All Statuses')}
      ${sel('ag_type',   types,       f.ag_type,   'All Types')}
      ${hasFilter ? `<button class="btn sm" style="color:var(--red)" onclick="ouState().filters={};ouClearCache();render()">✕ Clear</button>` : ''}
      ${syncInfo}
      <div style="flex:1"></div>
      <button class="btn sm navy" style="font-size:11px" onclick="ouTriggerSync(false)">🔄 Sync Now</button>
      <button class="btn sm" style="font-size:11px" onclick="ouTriggerSync(true)">📅 Sync + Monthly</button>
    </div>
  </div>`;
}

// ── Main view ───────────────────────────────────────────────
VIEWS.outstanding = () => {
  const st = ouState();
  const tab = st.tab;

  const tabBtn = (id, lbl) =>
    `<button onclick="ouState().tab='${id}';render()"
      style="padding:10px 18px;border:none;border-bottom:3px solid ${tab===id?'var(--chart-1)':'transparent'};background:none;font-size:13px;font-weight:${tab===id?'700':'500'};color:${tab===id?'var(--chart-1)':'var(--muted)'};cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s">${lbl}</button>`;

  const tabs = `<div style="display:flex;border-bottom:1px solid var(--brd);margin-bottom:16px;overflow-x:auto">
    ${tabBtn('overview','📊 Overview')}
    ${tabBtn('agencies','🏢 Agencies')}
    ${tabBtn('top','🏆 Top Outstanding')}
    ${tabBtn('trend','📈 Trend')}
  </div>`;

  let content = '';
  if (tab === 'overview') content = ouOverviewTab();
  else if (tab === 'agencies') content = ouAgenciesTab();
  else if (tab === 'top') content = ouTopTab();
  else if (tab === 'trend') content = ouTrendTab();

  return pagehead('Agency Outstanding', 'Outstanding · Collection · Ageing · Recovery status') +
    `<style>
      .ou-chip{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700}
    </style>` +
    ouFilterPanel() + tabs + content;
};

/* ════════════════════════════════════════════════════════
   SHORT PAYMENT / BILL-WISE COLLECTION REPORT
   ════════════════════════════════════════════════════════ */

const spApi = path => `${location.protocol}//${location.hostname}:8001/api/shortpayment/${path}`;

const spState = () => S.live.sp || (S.live.sp = {
  fromMonth: '', toMonth: '',
  availMonths: null,
  filterOpts: null,   // loaded once from /api/outstanding/filters
  filters: { state: '', unit_code: '', zh_name: '', ag_status: '', payment_status: '' },
  data: null, page: 1, summaryTab: 'state',
  drillState: null, drillZH: null, _loading: false,
});

const spFmtM = label => {
  const [y, m] = label.split('-');
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)-1] + "'" + y.slice(2);
};

function spLoad(pg) {
  const sp = spState();
  if (sp._loading) return;
  if (pg !== undefined) sp.page = pg;
  sp._loading = true; sp.data = null; render();
  const f = sp.filters;
  const p = new URLSearchParams();
  if (sp.fromMonth) p.set('from_month', sp.fromMonth);
  if (sp.toMonth)   p.set('to_month',   sp.toMonth);
  if (f.state || sp.drillState) p.set('state', f.state || sp.drillState);
  if (f.unit_code)      p.set('unit_code',      f.unit_code);
  if (f.zh_name || sp.drillZH) p.set('zh_name', f.zh_name || sp.drillZH);
  if (f.ag_status)      p.set('ag_status',      f.ag_status);
  if (f.payment_status) p.set('payment_status', f.payment_status);
  p.set('page', sp.page);
  fetch(spApi('report') + '?' + p.toString(), { headers: api.h() })
    .then(r => r.json())
    .then(d => { sp.data = d; sp._loading = false; if (S.screen === 'short_payment') render(); })
    .catch(() => { sp._loading = false; if (S.screen === 'short_payment') render(); });
}

window.spDrillState = function(state) {
  const sp = spState();
  sp.drillState = state; sp.drillZH = null; sp.data = null; sp.page = 1;
  spLoad();
};
window.spDrillZH = function(zh) {
  const sp = spState(); sp.drillZH = zh; sp.data = null; sp.page = 1; spLoad();
};
window.spClearDrill = function() {
  const sp = spState(); sp.drillState = null; sp.drillZH = null; sp.data = null; sp.page = 1; spLoad();
};
window.spExport = function() {
  const sp = spState(), f = sp.filters;
  const p = new URLSearchParams();
  if (sp.fromMonth) p.set('from_month', sp.fromMonth);
  if (sp.toMonth)   p.set('to_month',   sp.toMonth);
  if (f.state || sp.drillState) p.set('state', f.state || sp.drillState);
  if (f.unit_code)      p.set('unit_code',      f.unit_code);
  if (f.zh_name || sp.drillZH) p.set('zh_name', f.zh_name || sp.drillZH);
  if (f.ag_status)      p.set('ag_status',      f.ag_status);
  if (f.payment_status) p.set('payment_status', f.payment_status);
  p.set('export', 'csv');
  window.location.href = spApi('report') + '?' + p.toString();
};

VIEWS.short_payment = function() {
  const sp = spState();

  // Bootstrap: load available months first
  if (!sp.availMonths) {
    fetch(spApi('months'), { headers: api.h() }).then(r=>r.json()).then(d => {
      sp.availMonths = d.months || [];
      if (sp.availMonths.length) {
        sp.toMonth   = sp.availMonths[sp.availMonths.length - 1];
        const fi = Math.max(0, sp.availMonths.length - 6);
        sp.fromMonth = sp.availMonths[fi];
      }
      if (S.screen === 'short_payment') spLoad();
    });
    return pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis') +
      `<div style="text-align:center;padding:40px;color:var(--muted)">Loading…</div>`;
  }

  const d = sp.data;
  const months = d?.months || [];

  // ── Filter options (loaded once, stable — not from filtered response) ──
  if (!sp.filterOpts) {
    api.get('/api/outstanding/filters').then(d => { sp.filterOpts = d; if (S.screen==='short_payment') render(); });
  }
  const { states: allStates=[], units: allUnits=[], zh_names: allZHs=[] } = sp.filterOpts || {};
  const STATE_LABEL_SP = { RPPL:'Rajasthan', MP:'Madhya Pradesh', CG:'Chhattisgarh', NATIONAL:'National' };

  // Cascade: filter units and ZHs to selected state
  const spActiveUnits = sp.filters.state ? allUnits.filter(u => u.state === sp.filters.state) : allUnits;
  const spActiveZHs   = sp.filters.state ? allZHs.filter(z => z.state === sp.filters.state) : allZHs;

  const monthOpts   = sp.availMonths.map(m => `<option value="${m}"${m===sp.fromMonth?' selected':''}>${spFmtM(m)}</option>`).join('');
  const monthOptsTo = sp.availMonths.map(m => `<option value="${m}"${m===sp.toMonth?' selected':''}>${spFmtM(m)}</option>`).join('');

  const spSel = (key, opts, cur, placeholder, onChange) => {
    const change = onChange || `spState().filters.${key}=this.value;spState().data=null;spLoad(1)`;
    return `<select class="inp" style="font-size:12px;padding:4px 6px" onchange="${change}">
      <option value="">${placeholder}</option>
      ${opts.map(o => typeof o==='string'
        ? `<option value="${esc(o)}"${cur===o?' selected':''}>${esc(STATE_LABEL_SP[o]||o)}</option>`
        : `<option value="${esc(o.code)}"${cur===o.code?' selected':''}>${esc(o.name||o.code)}</option>`).join('')}
    </select>`;
  };
  const onSpStateChange = `spState().filters.state=this.value;spState().filters.unit_code='';spState().filters.zh_name='';spState().drillState=null;spState().data=null;spLoad(1)`;

  const filtersBar = `<div class="card" style="padding:10px 12px;margin-bottom:10px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">From Month</div>
        <select class="inp" style="font-size:12px;padding:4px 6px" onchange="spState().fromMonth=this.value;spState().data=null;spLoad(1)">
          ${monthOpts}
        </select>
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">To Month</div>
        <select class="inp" style="font-size:12px;padding:4px 6px" onchange="spState().toMonth=this.value;spState().data=null;spLoad(1)">
          ${monthOptsTo}
        </select>
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">State</div>
        ${spSel('state', allStates, sp.filters.state, 'All States', onSpStateChange)}
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Unit</div>
        ${spSel('unit_code', spActiveUnits, sp.filters.unit_code, 'All Units')}
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Zonal Head</div>
        ${spSel('zh_name', spActiveZHs, sp.filters.zh_name, 'All ZH', `spState().filters.zh_name=this.value;spState().drillZH=null;spState().data=null;spLoad(1)`)}
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Payment Status</div>
        <select class="inp" style="font-size:12px;padding:4px 6px" onchange="spState().filters.payment_status=this.value;spState().data=null;spLoad(1)">
          <option value="">All</option>
          <option value="Fully Paid"${sp.filters.payment_status==='Fully Paid'?' selected':''}>Fully Paid</option>
          <option value="Short Paid"${sp.filters.payment_status==='Short Paid'?' selected':''}>Short Paid</option>
          <option value="Unpaid"${sp.filters.payment_status==='Unpaid'?' selected':''}>Unpaid</option>
        </select>
      </div>
      <div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Agency Status</div>
        <select class="inp" style="font-size:12px;padding:4px 6px" onchange="spState().filters.ag_status=this.value;spState().data=null;spLoad(1)">
          <option value="">All</option>
          <option value="Active"${sp.filters.ag_status==='Active'?' selected':''}>Active</option>
          <option value="Inactive"${sp.filters.ag_status==='Inactive'?' selected':''}>Inactive</option>
          <option value="Closed"${sp.filters.ag_status==='Closed'?' selected':''}>Closed</option>
          <option value="Suspended"${sp.filters.ag_status==='Suspended'?' selected':''}>Suspended</option>
        </select>
      </div>
      <button class="btn navy sm" style="font-size:11px" onclick="spExport()" title="Download CSV">⬇ CSV Export</button>
      ${(sp.drillState||sp.drillZH) ? `<button class="btn sm" style="font-size:11px" onclick="spClearDrill()">✕ Clear Drill-down</button>` : ''}
    </div>
  </div>`;

  if (sp._loading || !d) {
    return pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis') + filtersBar +
      `<div style="text-align:center;padding:40px;color:var(--muted)">Loading report…</div>`;
  }

  if (d.error === 'no_monthly_data') {
    return pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis') + filtersBar +
      `<div class="card" style="padding:24px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">📅</div>
        <div style="font-weight:700">Monthly snapshot data not found</div>
        <div style="color:var(--muted);font-size:12px;margin-top:6px">Run: <code>node api/oracle_outstanding_sync.js --monthly</code></div>
      </div>`;
  }

  const sm = d.summary || {};
  const fmtC = n => { if (!n && n!==0) return '—'; const a=Math.abs(n); let s; if(a>=1e7) s=(a/1e7).toFixed(2)+' Cr'; else if(a>=1e5) s=(a/1e5).toFixed(2)+' L'; else s=Math.round(a).toLocaleString(); return (n<0?'-':'')+'₹'+s; };
  const fmtN = n => (!n&&n!==0)?'—':Number(n).toLocaleString();
  const pctBar = (p,clr) => `<div style="height:3px;background:var(--surface-2);border-radius:2px;margin-top:3px"><div style="height:3px;width:${Math.min(100,p)}%;background:${clr};border-radius:2px"></div></div>`;

  // ── Drill-down breadcrumb ──
  const breadcrumb = (sp.drillState || sp.drillZH) ? `
    <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px;flex-wrap:wrap">
      <span style="cursor:pointer;color:var(--navy);text-decoration:underline" onclick="spClearDrill()">All States</span>
      ${sp.drillState ? `<span>›</span><span style="font-weight:700">${sp.drillState}</span>` : ''}
      ${sp.drillZH ? `<span>›</span><span style="font-weight:700">${sp.drillZH}</span>` : ''}
    </div>` : '';

  // ── Management Summary KPI strip ──
  const kpiCard = (icon, label, val, sub, clr) => `<div class="card" style="padding:12px 14px;flex:1;min-width:130px">
    <div style="font-size:16px">${icon}</div>
    <div style="font-size:20px;font-weight:800;color:${clr||'var(--text)'};line-height:1.1">${val}</div>
    <div style="font-size:10px;font-weight:700;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em">${label}</div>
    ${sub?`<div style="font-size:10px;color:var(--muted)">${sub}</div>`:''}
  </div>`;

  const kpis = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
    ${kpiCard('📊','Total Agencies', fmtN(sm.total_agencies),'','var(--navy)')}
    ${kpiCard('⚠️','Short Paid',     fmtN(sm.short_agencies), sm.short_pct+'% of billing','#e74c3c')}
    ${kpiCard('🚫','Unpaid',         fmtN(sm.unpaid_agencies),'No payment received','#8e44ad')}
    ${kpiCard('✅','Fully Paid',      fmtN(sm.fully_paid),'','#2ecc71')}
    ${kpiCard('💰','Total Billed',    fmtC(sm.total_billed),months.map(spFmtM).join('→'),'var(--navy)')}
    ${kpiCard('📥','Total Received',  fmtC(sm.total_received),sm.coll_pct+'% collection','#2ecc71')}
    ${kpiCard('📉','Short / Unpaid',  fmtC(sm.total_short),sm.short_pct+'% of billing','#e74c3c')}
  </div>`;

  // ── Summary Table (State or ZH) ──
  const summTab = sp.summaryTab;
  const summData = summTab === 'state' ? (sm.by_state||[]) : (sm.by_zh||[]);
  const summTable = `
    <div class="card" style="padding:12px 14px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
        <div style="font-weight:700;font-size:13px">Management Summary · ${months.length > 0 ? spFmtM(months[0]) + ' to ' + spFmtM(months[months.length-1]) : ''}</div>
        <div style="display:flex;gap:4px">
          <button class="btn sm${summTab==='state'?' navy':''}" style="font-size:11px" onclick="spState().summaryTab='state';render()">State-wise</button>
          <button class="btn sm${summTab==='zh'?' navy':''}" style="font-size:11px" onclick="spState().summaryTab='zh';render()">Zonal Head-wise</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:520px">
          <thead><tr style="background:var(--navy);color:#fff">
            <th style="padding:6px 10px;text-align:left">${summTab==='state'?'State':'Zonal Head'}</th>
            ${summTab==='zh'?'<th style="padding:6px 10px;text-align:left">State</th>':''}
            <th style="padding:6px 10px;text-align:right">Agencies</th>
            <th style="padding:6px 10px;text-align:right">Short/Unpaid</th>
            <th style="padding:6px 10px;text-align:right">Total Billed</th>
            <th style="padding:6px 10px;text-align:right">Total Received</th>
            <th style="padding:6px 10px;text-align:right">Diff</th>
            <th style="padding:6px 10px;text-align:right">Coll%</th>
          </tr></thead>
          <tbody>
            ${summData.map((r,i) => {
              const isShort = r.diff > 100;
              const clk = summTab==='state' ? `onclick="spDrillState('${r.state}')"` : `onclick="spDrillZH('${r.zh_name}')"`;
              return `<tr style="${i%2?'background:var(--surface-2)':''};cursor:pointer" ${clk} title="Click to drill down">
                <td style="padding:6px 10px;font-weight:600">${esc(summTab==='state'?r.state:r.zh_name)}</td>
                ${summTab==='zh'?`<td style="padding:6px 10px;color:var(--muted)">${esc(r.state)}</td>`:''}
                <td style="padding:6px 10px;text-align:right">${r.agencies}</td>
                <td style="padding:6px 10px;text-align:right;color:${r.short_ag>0?'#e74c3c':'var(--grn)'}">${r.short_ag}</td>
                <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(r.billed)}</td>
                <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(r.received)}</td>
                <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:${isShort?'#e74c3c':'var(--grn)'}">${fmtC(r.diff)}</td>
                <td style="padding:6px 10px;text-align:right">${r.coll_pct}%${pctBar(r.coll_pct, r.coll_pct>=80?'#2ecc71':'#e74c3c')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  // ── Agency Detail Table ──
  const agRows = d.agencies || [];
  const total  = d.total || 0;
  const page   = d.page || 1;
  const pages  = Math.ceil(total / (d.limit||50));

  const payChip = status => {
    const cfg = { 'Fully Paid': ['#2ecc71','#e8f8f0'], 'Short Paid': ['#e74c3c','#fdecea'], 'Unpaid': ['#8e44ad','#f5eefb'] };
    const [c,bg] = cfg[status] || ['var(--muted)','var(--surface-2)'];
    return `<span style="background:${bg};color:${c};border-radius:10px;padding:2px 7px;font-size:10px;font-weight:700;white-space:nowrap">${status}</span>`;
  };

  const tbl = agRows.length === 0
    ? `<div class="card" style="padding:24px;text-align:center;color:var(--muted)">No agencies match the selected filters.</div>`
    : `<div class="card" style="padding:12px 14px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
      <div style="font-weight:700;font-size:13px">Agency Detail · ${total.toLocaleString()} agencies · Page ${page}/${pages}</div>
    </div>
    <div style="overflow-x:auto;max-height:60vh;border:1px solid var(--brd);border-radius:6px">
      <table style="border-collapse:collapse;font-size:11px;min-width:${900 + months.length*210}px;width:100%">
        <thead>
          <tr style="position:sticky;top:0;background:var(--navy);color:#fff;z-index:3">
            <th rowspan="2" style="padding:5px 8px;text-align:left;white-space:nowrap;position:sticky;left:0;background:var(--navy);z-index:4;min-width:160px">Agency</th>
            <th rowspan="2" style="padding:5px 8px;text-align:left;white-space:nowrap">State / ZH</th>
            <th rowspan="2" style="padding:5px 8px;text-align:left;white-space:nowrap">City</th>
            <th rowspan="2" style="padding:5px 8px;text-align:left;white-space:nowrap">Executive</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Op.Bal</th>
            ${months.map(m => `<th colspan="3" style="padding:5px 8px;text-align:center;border-left:1px solid rgba(255,255,255,.2)">${spFmtM(m)}</th>`).join('')}
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap;border-left:2px solid rgba(255,255,255,.3)">Tot Bill</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Tot Rcpt</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Diff</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Coll%</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap;border-left:2px solid rgba(255,255,255,.3)">Cur Bill</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Cur Rcpt</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">OS</th>
            <th rowspan="2" style="padding:5px 8px;text-align:right;white-space:nowrap">Status</th>
          </tr>
          <tr style="position:sticky;top:29px;background:var(--navy);color:rgba(255,255,255,.75);font-weight:400;z-index:3">
            ${months.map(() => `
              <th style="padding:3px 6px;text-align:right;font-size:10px;border-left:1px solid rgba(255,255,255,.2)">Bill</th>
              <th style="padding:3px 6px;text-align:right;font-size:10px">Rcpt</th>
              <th style="padding:3px 6px;text-align:right;font-size:10px">Diff</th>
            `).join('')}
          </tr>
        </thead>
        <tbody>
          ${agRows.map((ag, ri) => {
            const rowBg = ri%2 ? 'background:var(--surface-2)' : '';
            const cells = ag.monthly.map(m => {
              const isShort = m.diff > 100;
              const isOver  = m.diff < -100;
              const diffClr = isShort ? 'color:#e74c3c;font-weight:700' : isOver ? 'color:#27ae60' : 'color:var(--muted)';
              return `<td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums;border-left:1px solid var(--brd)">${fmtC(m.bill)}</td>
                <td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(m.rcpt)}</td>
                <td style="padding:4px 6px;text-align:right;font-variant-numeric:tabular-nums;${diffClr}">${m.diff!==0?fmtC(m.diff):'—'}</td>`;
            }).join('');
            const totDiffShort = ag.tot_diff > 100;
            return `<tr style="${rowBg}">
              <td style="padding:4px 8px;font-weight:600;position:sticky;left:0;background:${ri%2?'var(--surface-2)':'var(--surface)'};z-index:2;white-space:nowrap">
                ${esc(ag.ag_name)}<br><span style="font-size:10px;font-weight:400;color:var(--muted)">${ag.ag_code} · ${ag.unit_name}</span>
              </td>
              <td style="padding:4px 8px;white-space:nowrap">${esc(ag.state)}<br><span style="font-size:10px;color:var(--muted)">${esc(ag.zh_name)}</span></td>
              <td style="padding:4px 8px;white-space:nowrap;font-size:10px">${esc(ag.city_name)}</td>
              <td style="padding:4px 8px;white-space:nowrap;font-size:10px">${esc(ag.exec_name)}</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(ag.op_bal)}</td>
              ${cells}
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;border-left:2px solid var(--brd)">${fmtC(ag.tot_bill)}</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(ag.tot_rcpt)}</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;${totDiffShort?'color:#e74c3c':'color:var(--grn)'}">${fmtC(ag.tot_diff)}</td>
              <td style="padding:4px 8px;text-align:right">${ag.coll_pct}%</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;border-left:2px solid var(--brd)">${fmtC(ag.cur_bill)}</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${fmtC(ag.cur_rcpt)}</td>
              <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;${ag.cur_os>0?'color:#e74c3c':'color:var(--grn)'}">${fmtC(ag.cur_os)}</td>
              <td style="padding:4px 8px;text-align:center">${payChip(ag.pay_status)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${pages > 1 ? `<div style="display:flex;gap:6px;justify-content:center;margin-top:8px;flex-wrap:wrap">
      ${page>1?`<button class="btn sm" onclick="spLoad(${page-1})">← Prev</button>`:''}
      <span style="font-size:12px;align-self:center">Page ${page} of ${pages} · ${total.toLocaleString()} agencies</span>
      ${page<pages?`<button class="btn sm" onclick="spLoad(${page+1})">Next →</button>`:''}
    </div>` : `<div style="font-size:11px;color:var(--muted);margin-top:4px">${total.toLocaleString()} agencies</div>`}
  </div>`;

  return pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis') +
    filtersBar + breadcrumb + kpis + summTable + tbl;
};

/* ---- Dashboard: Masters & Admin ---- */
VIEWS.admin = () => pagehead("Masters & Admin", "Configuration masters — maintained by the admin team") +
  `<div class="applist">${MASTERS.map(m => `<button class="card appcard" onclick="toast('${m.title} — read-only in demo')">
    <div class="aico" style="background:var(--navy-l)">${m.icon}</div><b>${m.title}</b><small>${m.desc}</small></button>`).join("")}</div>`;

/* ---- Admin: User Management ---- */
const UM_LEVELS = [
  { v: 1,  l: 'Admin — Board View (L1)' },
  { v: 2,  l: 'Edition Incharge (L2)' },
  { v: 3,  l: 'Circulation Incharge (L3)' },
  { v: 4,  l: 'Zonal Head (L4)' },
  { v: 5,  l: 'VP Circulation (L5)' },
  { v: 7,  l: 'Field Executive (L7)' },
  { v: 9,  l: 'Newspaper Agent (L9)' },
  { v: 10, l: 'Hawker (L10)' },
];
const UM_TYPES = ['circulation', 'agent', 'taxi_driver', 'dcr', 'other'];
const umLevelLabel = (v) => (UM_LEVELS.find(x => x.v === Number(v)) || {}).l || (v ? 'Level ' + v : '—');
const umLevelOpts = (sel) => UM_LEVELS.map(x => `<option value="${x.v}" ${Number(sel) === x.v ? 'selected' : ''}>${x.l}</option>`).join('');
const umTypeOpts  = (sel) => UM_TYPES.map(t => `<option value="${t}" ${sel === t ? 'selected' : ''}>${t}</option>`).join('');

async function fetchAdminUsers(force) {
  if (S.live._admLoading) return;
  if (S.live.adminUsers && !force) return;
  S.live._admLoading = true;
  const d = await api.get('/api/admin/users');
  if (d && d.users) S.live.adminUsers = d.users;
  S.live._admLoading = false;
  if (S.screen === 'user_mgmt') render();
}
window.umSearch = (v) => {
  S.live.umSearch = v; render();
  const inp = document.getElementById('umSearch'); if (inp) { inp.focus(); inp.setSelectionRange(v.length, v.length); }
};
window.umNew = () => {
  modal(`<h3>Create user</h3><div id="umErr"></div>
    <div class="fld"><label>Full name *</label><input id="umName" type="text"></div>
    <div class="fld"><label>Mobile number</label><input id="umMobile" type="tel" maxlength="10" inputmode="numeric" placeholder="10-digit mobile"></div>
    <div class="fld"><label>User ID (optional — for non-mobile logins like admins)</label><input id="umUsername" type="text" placeholder="e.g. admin"></div>
    <div class="fld"><label>Designation / Level</label><select id="umLevel">${umLevelOpts(2)}</select></div>
    <div class="fld"><label>User type</label><select id="umType">${umTypeOpts('circulation')}</select></div>
    <div class="fld"><label>Email (optional)</label><input id="umEmail" type="email"></div>
    <div class="fld"><label>Person code (optional — links to hierarchy master)</label><input id="umPerson" type="text"></div>
    <div class="fld"><label>Initial password (blank = auto temp)</label><input id="umPwd" type="text" placeholder="Leave blank to auto-generate"></div>
    <div style="display:flex;gap:9px;margin-top:16px"><button class="btn pri block" onclick="umCreate()">Create user</button><button class="btn" onclick="closeModals()">Cancel</button></div>`);
};
window.umCreate = async () => {
  const b = { name: gv('umName'), mobile: gv('umMobile'), username: gv('umUsername'),
    hierarchy_level: gv('umLevel'), user_type: gv('umType'), email: gv('umEmail'),
    person_code: gv('umPerson') || null, password: gv('umPwd') || undefined };
  const err = document.getElementById('umErr');
  if (!b.name || (!b.mobile && !b.username)) { err.innerHTML = `<div class="err">Name and a mobile number or User ID are required.</div>`; return; }
  const r = await apiCall('POST', '/api/admin/users', b);
  if (!r.ok) { err.innerHTML = `<div class="err">${esc(r.detail || 'Create failed')}</div>`; return; }
  closeModals();
  if (r.tempPassword) umShowTempPassword(b.name, r.tempPassword);
  else toast('✅ User created');
  fetchAdminUsers(true);
};
window.umEdit = (id) => {
  const u = (S.live.adminUsers || []).find(x => x.id === id); if (!u) return;
  modal(`<h3>Edit user</h3><div id="umErr"></div>
    <div class="fld"><label>Full name</label><input id="umName" value="${esc(u.name || '')}"></div>
    <div class="fld"><label>Mobile number</label><input id="umMobile" maxlength="10" inputmode="numeric" value="${esc(u.mobile || '')}"></div>
    <div class="fld"><label>User ID</label><input id="umUsername" value="${esc(u.username || '')}"></div>
    <div class="fld"><label>Designation / Level</label><select id="umLevel">${umLevelOpts(u.hierarchy_level)}</select></div>
    <div class="fld"><label>User type</label><select id="umType">${umTypeOpts(u.user_type)}</select></div>
    <div class="fld"><label>Email</label><input id="umEmail" value="${esc(u.email || '')}"></div>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 0;cursor:pointer"><input type="checkbox" id="umActive" ${u.is_active ? 'checked' : ''}> Active</label>
    <div style="display:flex;gap:9px;margin-top:12px"><button class="btn pri block" onclick="umUpdate(${u.id})">Save changes</button><button class="btn" onclick="closeModals()">Cancel</button></div>`);
};
window.umUpdate = async (id) => {
  const b = { name: gv('umName'), mobile: gv('umMobile'), username: gv('umUsername'),
    hierarchy_level: gv('umLevel'), user_type: gv('umType'), email: gv('umEmail'),
    is_active: document.getElementById('umActive').checked };
  const r = await apiCall('PATCH', '/api/admin/users/' + id, b);
  if (!r.ok) { document.getElementById('umErr').innerHTML = `<div class="err">${esc(r.detail || 'Update failed')}</div>`; return; }
  closeModals(); toast('✅ User updated'); fetchAdminUsers(true);
};
window.umToggleActive = async (id, active) => {
  const r = await apiCall('PATCH', '/api/admin/users/' + id, { is_active: !active });
  if (r.ok) { toast(active ? 'User deactivated' : 'User activated'); fetchAdminUsers(true); } else toast('❌ ' + (r.detail || 'Failed'));
};
window.umUnlock = async (id) => {
  const r = await apiCall('PATCH', '/api/admin/users/' + id, { locked_until: null });
  if (r.ok) { toast('🔓 Account unlocked'); fetchAdminUsers(true); } else toast('❌ ' + (r.detail || 'Failed'));
};
window.umResetPwd = async (id, name) => {
  if (!confirm('Reset password for ' + name + '? A temporary password will be generated.')) return;
  const r = await apiCall('POST', '/api/admin/users/' + id + '/reset-password', {});
  if (r.ok) { umShowTempPassword(name, r.tempPassword); fetchAdminUsers(true); } else toast('❌ ' + (r.detail || 'Failed'));
};
window.umShowTempPassword = (name, pwd) => {
  modal(`<h3>Temporary password</h3>
    <p class="mint">Share this with <b>${esc(name)}</b>. They will be asked to change it on next login.</p>
    <div style="font-size:22px;font-weight:800;letter-spacing:1px;text-align:center;padding:14px;background:var(--surface-2);border-radius:10px;margin:12px 0;user-select:all">${esc(pwd || '—')}</div>
    <div style="display:flex;gap:9px"><button class="btn pri block" onclick="closeModals()">Done</button></div>`);
};
VIEWS.user_mgmt = () => {
  fetchAdminUsers();
  const users = S.live.adminUsers || [];
  const search = (S.live.umSearch || '').toLowerCase();
  const filtered = users.filter(u =>
    (u.name || '').toLowerCase().includes(search) ||
    (u.mobile || '').includes(search) ||
    (u.username || '').toLowerCase().includes(search) ||
    umLevelLabel(u.hierarchy_level).toLowerCase().includes(search) ||
    (u.user_type || '').includes(search));

  const rows = filtered.map(u => {
    const locked = u.locked_until && new Date(u.locked_until) > new Date();
    const status = !u.is_active ? `<span class="chip" style="background:var(--red-l);color:var(--red)">Inactive</span>`
      : locked ? `<span class="chip" style="background:#fde68a;color:#92400e">Locked</span>`
      : `<span class="chip" style="background:var(--grn-l);color:var(--grn)">Active</span>`;
    const nmeSafe = (u.name || '').replace(/'/g, "\\'");
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 10px"><b>${esc(u.name || '')}</b>${u.person_code ? `<div style="font-size:10px;color:var(--ink-2)">${esc(u.person_code)}</div>` : ''}</td>
      <td style="padding:8px 10px">${esc(u.username || u.mobile || '—')}</td>
      <td style="padding:8px 10px;font-size:12px">${esc(umLevelLabel(u.hierarchy_level))}</td>
      <td style="padding:8px 10px;font-size:12px">${esc(u.user_type || '')}</td>
      <td style="padding:8px 10px;text-align:center">${status}${!u.has_password ? `<div style="font-size:10px;color:var(--red)">no password</div>` : ''}</td>
      <td style="padding:8px 10px;font-size:11px;color:var(--ink-2)">${u.last_login_at ? esc(String(u.last_login_at).slice(0, 16).replace('T', ' ')) : 'never'}</td>
      <td style="padding:8px 10px;white-space:nowrap;text-align:right">
        <button class="btn sm" onclick="umEdit(${u.id})">Edit</button>
        <button class="btn sm" onclick="umResetPwd(${u.id}, '${esc(nmeSafe)}')">Reset PW</button>
        ${locked ? `<button class="btn sm" onclick="umUnlock(${u.id})">Unlock</button>` : ''}
        <button class="btn sm" onclick="umToggleActive(${u.id}, ${u.is_active ? 1 : 0})">${u.is_active ? 'Deactivate' : 'Activate'}</button>
      </td></tr>`;
  }).join('');

  const body = !S.live.adminUsers
    ? `<div style="padding:24px;text-align:center;color:var(--ink-2)">Loading users…</div>`
    : `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--surface-2);text-align:left">
          <th style="padding:8px 10px">Name</th><th style="padding:8px 10px">Login (ID/Mobile)</th>
          <th style="padding:8px 10px">Designation</th><th style="padding:8px 10px">Type</th>
          <th style="padding:8px 10px;text-align:center">Status</th><th style="padding:8px 10px">Last login</th>
          <th style="padding:8px 10px;text-align:right">Actions</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--ink-2)">No users match</td></tr>`}</tbody>
      </table></div>`;

  return pagehead('User Management', `${users.length} users · create, activate, assign designation, reset passwords`) +
    `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input id="umSearch" placeholder="Search name / mobile / User ID / role…" value="${esc(S.live.umSearch || '')}" oninput="umSearch(this.value)" style="flex:1;min-width:200px;padding:9px 12px;border:1px solid var(--border);border-radius:8px">
      <button class="btn navy" onclick="umNew()">+ New User</button>
      <button class="btn" onclick="fetchAdminUsers(true)">↻ Refresh</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">${body}</div>`;
};

/* ---- Admin: Audit Trail ---- */
async function fetchAudit(force) {
  if (S.live._auditLoading) return;
  if (S.live.audit && !force) return;
  S.live._auditLoading = true;
  const d = await api.get('/api/admin/audit?limit=300');
  if (d && d.audit) S.live.audit = d.audit;
  S.live._auditLoading = false;
  if (S.screen === 'audit_log') render();
}
const AUDIT_LABEL = {
  login_success: 'Login', login_fail: 'Failed login', locked: 'Account locked', logout: 'Logout',
  password_change: 'Password changed', admin_reset: 'Admin password reset',
  user_create: 'User created', user_update: 'User updated',
  perms_update: 'Rights updated', perms_reset: 'Rights reset',
};
VIEWS.audit_log = () => {
  fetchAudit();
  const rows = S.live.audit || [];
  const body = !S.live.audit
    ? `<div style="padding:24px;text-align:center;color:var(--ink-2)">Loading audit trail…</div>`
    : `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--surface-2);text-align:left">
          <th style="padding:7px 10px">Time</th><th style="padding:7px 10px">Action</th>
          <th style="padding:7px 10px">By</th><th style="padding:7px 10px">Target</th>
          <th style="padding:7px 10px">Detail</th><th style="padding:7px 10px">IP</th></tr></thead>
        <tbody>${rows.map(r => `<tr style="border-top:1px solid var(--border)">
          <td style="padding:6px 10px;white-space:nowrap">${esc(String(r.ts || '').slice(0, 19).replace('T', ' '))}</td>
          <td style="padding:6px 10px">${esc(AUDIT_LABEL[r.action] || r.action)}</td>
          <td style="padding:6px 10px">${esc(r.actor_name || r.actor_person_code || '—')}</td>
          <td style="padding:6px 10px">${esc(r.target_person_code || '—')}</td>
          <td style="padding:6px 10px;color:var(--ink-2)">${esc(r.detail || '')}</td>
          <td style="padding:6px 10px;color:var(--ink-2)">${esc(r.ip || '')}</td>
        </tr>`).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--ink-2)">No audit records yet</td></tr>`}</tbody>
      </table></div>`;
  return pagehead('Audit Trail', 'Logins, password changes and administrator actions') +
    `<div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn" onclick="fetchAudit(true)">↻ Refresh</button></div>
     <div class="card" style="padding:0;overflow:hidden">${body}</div>`;
};

/* ---- Manage Rights ---- */
const MR_ALL_MODULES = [
  { key: 'agent',  label: 'Agent App',   icon: '🏢' },
  { key: 'hawker', label: 'Hawker App',  icon: '🛵' },
  { key: 'dcr',    label: 'DCR Forms',   icon: '📋' },
  { key: 'survey', label: 'Survey Form', icon: '📝' },
  { key: 'taxi',   label: 'Taxi Fleet',  icon: '🚛' },
];

/* Per-form rights matrix — dashboards/forms × actions */
const RIGHT_FORMS = [
  { key: 'command',     label: 'Command Centre' },
  { key: 'supply_dash', label: 'Supply Dashboard' },
  { key: 'collections', label: 'Collection Dashboard' },
  { key: 'outstanding', label: 'Outstanding Dashboard' },
  { key: 'transport',   label: 'Taxi Dashboard' },
  { key: 'agent',       label: 'Agent App' },
  { key: 'hawker',      label: 'Hawker App' },
  { key: 'survey_dash', label: 'Reports / Survey' },
  { key: 'ai_insights', label: 'AI Insights' },
  { key: 'user_mgmt',   label: 'User Management' },
];
const RIGHT_ACTIONS = ['view', 'add', 'edit', 'delete', 'export'];

/* Returns true/false if an explicit override exists for form.action, else null */
function permAllows(form, action) {
  const p = S.user && S.user.perms;
  if (p && p[form] && (action in p[form])) return !!p[form][action];
  return null;
}
/* can(form, action) — explicit override wins; otherwise designation default
   (L1 admin = all; everyone else = view only for write actions) */
window.can = (form, action = 'view') => {
  const o = permAllows(form, action);
  if (o !== null) return o;
  return (S.user && S.user.hierarchyLevel === 1) ? true : (action === 'view');
};

window.mrSelectUser = (pc) => {
  const u = (S.live.dbUsers || []).find(u => u.person_code === pc);
  if (!u) return;
  const hl = u.hierarchyLevel || 99;
  const fieldIds = ["routes", "collections", "complaints", "partners"];
  const defaultScreens = DASH_MENU.map(([id]) => id).filter(id => hl <= 4 || fieldIds.includes(id));
  if (!S.live.mr) S.live.mr = {};
  S.live.mr.sel  = pc;
  S.live.mr.edit = {
    dashboard:  u.dashboard,
    navScreens: u.navScreens ? [...u.navScreens] : [...defaultScreens],
    modules:    [...(u.modules || [])],
    perms:      u.perms ? JSON.parse(JSON.stringify(u.perms)) : {},
  };
  render();
};
window.mrTogglePerm = (form, action) => {
  if (!S.live.mr?.edit) return;
  const pm = S.live.mr.edit.perms;
  pm[form] = pm[form] || {};
  pm[form][action] = !pm[form][action];
  render();
};

window.mrSearch = (v) => {
  if (!S.live.mr) S.live.mr = {};
  S.live.mr.search = v;
  render();
  const inp = document.querySelector('input[placeholder="Search users…"]');
  if (inp) { inp.focus(); inp.setSelectionRange(v.length, v.length); }
};

window.mrToggleDash = () => {
  if (!S.live.mr?.edit) return;
  S.live.mr.edit.dashboard = !S.live.mr.edit.dashboard;
  render();
};

window.mrToggleScreen = (id) => {
  if (!S.live.mr?.edit) return;
  const ns = S.live.mr.edit.navScreens;
  const idx = ns.indexOf(id);
  if (idx >= 0) ns.splice(idx, 1); else ns.push(id);
  render();
};

window.mrToggleModule = (k) => {
  if (!S.live.mr?.edit) return;
  const ms = S.live.mr.edit.modules;
  const idx = ms.indexOf(k);
  if (idx >= 0) ms.splice(idx, 1); else ms.push(k);
  render();
};

window.mrSave = async () => {
  const mr = S.live.mr;
  if (!mr?.sel || !mr?.edit) return;
  const btn = document.getElementById('mrSaveBtn');
  if (btn) btn.disabled = true;
  const res = await api.post('/api/admin/permissions', {
    person_code: mr.sel,
    dashboard:   mr.edit.dashboard,
    nav_screens: mr.edit.navScreens,
    modules:     mr.edit.modules,
    perms:       mr.edit.perms,
  });
  if (res && res.ok) {
    toast('✅ Permissions saved — user will see changes on next login');
    S.live.dbUsers = null; // force refresh
    fetchHierarchyUsers();
  } else {
    toast('❌ Save failed — check API');
  }
  if (btn) btn.disabled = false;
};

window.mrReset = async () => {
  const mr = S.live.mr;
  if (!mr?.sel) return;
  if (!confirm('Reset this user to their default level permissions?')) return;
  const res = await api.post('/api/admin/permissions', { person_code: mr.sel, reset: true });
  if (res && res.ok) {
    toast('↩️ Reset to level defaults');
    S.live.dbUsers = null;
    S.live.mr.sel  = null;
    S.live.mr.edit = null;
    fetchHierarchyUsers();
  } else {
    toast('❌ Reset failed');
  }
};

VIEWS.manage_rights = () => {
  if (!S.live.dbUsers) fetchHierarchyUsers();
  const users  = S.live.dbUsers || [];
  const mr     = S.live.mr || {};
  const search = (mr.search || '').toLowerCase();
  const sel    = mr.sel;
  const edit   = mr.edit;

  const filtered = users.filter(u =>
    u.name.toLowerCase().includes(search) ||
    (u.unit_code || '').toLowerCase().includes(search) ||
    (u.roleLabel  || '').toLowerCase().includes(search)
  );

  const loadingOrEmpty = !S.live.dbUsers
    ? `<div style="padding:20px;color:var(--ink-2);text-align:center;font-size:13px">Loading users…</div>`
    : `<div style="padding:20px;color:var(--ink-2);text-align:center">No users match</div>`;

  const userList = filtered.length
    ? filtered.map(u => {
        const active = sel === u.person_code;
        const hasOverride = !!u.hasOverride;
        return `<button class="card" onclick="mrSelectUser('${esc(u.person_code)}')"
          style="display:flex;align-items:center;gap:10px;padding:10px 12px;text-align:left;
                 border-left:3px solid ${active ? 'var(--accent)' : 'transparent'}">
          <span style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                       background:var(--blue-l);color:var(--blue-d);font-weight:700;font-size:13px;flex:none">
            ${esc(u.avatar)}
          </span>
          <span style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.name)}</div>
            <div style="font-size:11px;color:var(--ink-2)">${esc(u.roleLabel)} · ${esc(u.unit_code||'')}</div>
          </span>
          ${hasOverride ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--gold-l);color:var(--gold-d);flex:none">Custom</span>` : ''}
        </button>`;
      }).join('')
    : loadingOrEmpty;

  const chk = (on) => `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;border:2px solid ${on ? '#1C2B45' : '#94a3b8'};background:${on ? '#1C2B45' : '#fff'};color:#fff;font-size:11px;font-weight:700;flex:none">${on ? '✓' : ''}</span>`;

  let editor = `<div style="padding:32px;color:var(--ink-2);text-align:center;font-size:13px">
    ← Select a user from the list to edit their permissions</div>`;

  if (sel && edit) {
    const selUser = users.find(u => u.person_code === sel);
    editor = `
    <div style="padding:16px">
      <div style="font-weight:700;font-size:15px;margin-bottom:2px">${esc(selUser?.name || sel)}</div>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:16px">${esc(selUser?.roleLabel||'')} · Level ${selUser?.hierarchyLevel||'?'} · ${esc(selUser?.unit_code||'')}</div>

      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin-bottom:8px">Dashboard Access</div>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 10px;border-radius:8px;background:var(--surface-2);margin-bottom:16px"
             onclick="mrToggleDash()">
        ${chk(edit.dashboard)}
        <span style="font-size:13px">Can view Vitran OS dashboard (Transport, Reports, etc.)</span>
      </label>

      ${edit.dashboard ? `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin-bottom:8px">Visible Dashboard Screens</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:16px">
        ${DASH_MENU.map(([id, label, icon]) => `
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:7px 10px;border-radius:7px;background:var(--surface-2)"
                 onclick="mrToggleScreen('${id}')">
            ${chk(edit.navScreens.includes(id))}
            <span style="font-size:12px">${icon} ${esc(label)}</span>
          </label>`).join('')}
      </div>` : ''}

      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin-bottom:8px">Field App Access</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:20px">
        ${MR_ALL_MODULES.map(m => `
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:7px 10px;border-radius:7px;background:var(--surface-2)"
                 onclick="mrToggleModule('${m.key}')">
            ${chk(edit.modules.includes(m.key))}
            <span style="font-size:12px">${m.icon} ${esc(m.label)}</span>
          </label>`).join('')}
      </div>

      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin:4px 0 8px">Form / Dashboard Rights</div>
      <div style="overflow-x:auto;margin-bottom:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr>
            <th style="text-align:left;padding:6px 8px">Form</th>
            ${RIGHT_ACTIONS.map(a => `<th style="padding:6px 8px;text-transform:capitalize">${a}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${RIGHT_FORMS.map(f => `<tr style="border-top:1px solid var(--border)">
              <td style="padding:6px 8px">${esc(f.label)}</td>
              ${RIGHT_ACTIONS.map(a => `<td style="padding:6px 8px;text-align:center">
                <span onclick="mrTogglePerm('${f.key}','${a}')" style="cursor:pointer;display:inline-flex">${chk(!!(edit.perms[f.key] && edit.perms[f.key][a]))}</span>
              </td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:11px;color:var(--ink-2);margin-bottom:16px">Leave a row untouched to use the designation default. Check to grant, or toggle on-then-off to explicitly deny a specific action.</div>

      <div style="display:flex;gap:8px">
        <button id="mrSaveBtn" class="btn-primary" onclick="mrSave()" style="flex:1;padding:10px">
          💾 Save Permissions
        </button>
        <button onclick="mrReset()" style="padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;cursor:pointer;font-size:13px;color:var(--ink-2)">
          ↩ Reset
        </button>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--ink-2)">Changes take effect on the user's next login.</div>
    </div>`;
  }

  return pagehead("Manage Rights", "Control dashboard screens and field app access per user") +
    `<div style="display:grid;grid-template-columns:280px 1fr;gap:0;border:1px solid var(--border);border-radius:12px;overflow:hidden;min-height:420px">
      <div style="border-right:1px solid var(--border)">
        <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
          <input type="search" placeholder="Search users…" value="${esc(mr.search||'')}"
            oninput="mrSearch(this.value)"
            style="width:100%;padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--ink);font-size:13px;box-sizing:border-box">
        </div>
        <div style="overflow-y:auto;max-height:480px">${userList}</div>
      </div>
      <div>${editor}</div>
    </div>`;
};

/* ═══════════ FIELD APPS ═══════════ */

/* ---- Agent App ---- */
VIEWS.agent_day = () => {
  const rows = ROUTES.map(r => `<tr><td><b>${r.id}</b></td><td>${r.hawker}</td>
    <td class="r num">${r.copies}</td><td>${chip(r.status === "Completed" ? "good" : "info", r.status)}</td></tr>`).join("");
  return pagehead("Agent App — My Day", "Shree Ganesh News Agency · Malviya Nagar") + `
    <div class="grid kpis">
      ${kpi("Today's allocation", "4,820", "6 routes", "fl", "var(--red-l)", "📦")}
      ${kpi("Routes done", "4 / 6", "", "", "var(--grn-l)", "🛣️")}
      ${kpi("Collection due", fmtC(184200), "23 households", "fl", "var(--gold-l)", "₹")}
      ${kpi("June settlement", fmtC(6620), "awaiting approval", "fl", "var(--blue-l)", "🧾")}
    </div>` +
    table(["Route", "Hawker", ">Copies", "Status"], [rows]);
};
VIEWS.agent_supply = () => {
  const saved = store.get("returns", null);
  const rows = SUPPLY.map((s, i) => {
    const ret = saved ? saved[i] : 0;
    return `<tr><td><b>${s.pub}</b></td><td class="r num">${fmtN(s.supply)}</td>
      <td class="r num">₹${s.rate.toFixed(2)}</td>
      <td class="r"><input data-ret="${i}" type="number" min="0" max="${s.supply}" value="${ret}" ${saved ? "disabled" : ""}
        style="width:84px;text-align:right;background:var(--surf2);border:1px solid var(--brd);border-radius:8px;padding:6px 8px"></td>
      <td class="r num" data-net="${i}">${fmtN(s.supply - ret)}</td></tr>`;
  }).join("");
  return pagehead("Supply & Net Sales", "Enter unsold returns to compute today's net sale") + `
    <div class="card"><div class="cardhead"><h3>Today's supply — ${TODAY}</h3>${saved ? chip("good", "Returns saved") : chip("warn", "Returns pending")}</div>
      <div class="tablewrap"><table><thead><tr><th>Publication</th><th class="r">Supply</th><th class="r">Rate</th><th class="r">Returns</th><th class="r">Net sale</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      ${saved ? "" : `<div style="padding:14px 16px"><button class="btn pri" onclick="saveReturns()">Save returns & lock</button></div>`}</div>
    <div style="height:13px"></div>
    <div class="card pad"><div class="cardhead" style="padding:0 0 9px;border:none"><h3>Competitor copies in my area</h3></div>
      <div class="stat-pair"><span>Dainik Bhaskar</span><b>1,240 <span class="chip good">▼ 40 this month</span></b></div>
      <div class="stat-pair"><span>Times of India</span><b>310 <span class="chip crit">▲ 10 this month</span></b></div>
      <div class="stat-pair"><span>Dainik Navjyoti</span><b>180 <span class="chip mut">flat</span></b></div></div>`;
};
window.saveReturns = () => {
  const vals = [...document.querySelectorAll("[data-ret]")].map(el => Math.max(0, Number(el.value) || 0));
  store.set("returns", vals); toast("Returns saved — net sale updated ✓"); render();
};
VIEWS.agent_ledger = () => {
  const rows = LEDGER.map(l => `<tr><td class="num">${l[0]}</td><td>${l[1]}</td>
    <td class="r num">${l[2]}</td><td class="r num up">${l[3]}</td><td class="r num"><b>${l[4]}</b></td></tr>`).join("");
  return pagehead("Bills & Ledger", "Agency account with Patrika — running balance",
    `<button class="btn pri" onclick="toast('Statement sent on WhatsApp ✓')">Send on WhatsApp</button>`) + `
    <div class="grid kpis">
      ${kpi("Current balance", "₹1,84,200 Dr", "", "", "var(--red-l)", "🧾")}
      ${kpi("June bill", lakh(545420), "1,41,300 copies", "fl", "var(--gold-l)", "📰")}
      ${kpi("June commission", fmtC(41180), "12.4% blended", "up", "var(--grn-l)", "💰")}
    </div>` +
    table(["Date", "Particulars", ">Debit", ">Credit", ">Balance"], [rows]);
};
VIEWS.agent_complaints = () => {
  const mine = COMPLAINTS.filter(c => c.route.startsWith("MN") || c.route.startsWith("CS"));
  const rows = mine.map(c => `<tr><td><b>${c.id}</b></td>
    <td><b>${c.cust}</b><br><small style="color:var(--muted)">${c.cat}</small></td>
    <td>${c.route}</td><td>${chip(c.slaState === "crit" ? "crit" : c.slaState === "warn" ? "warn" : "good", c.sla)}</td>
    <td class="r"><button class="btn sm" onclick="toast('Marked resolved — pending customer confirmation')">Resolve</button></td></tr>`).join("");
  return pagehead("Complaints — My Territory", "Tickets on my agency routes") +
    table(["Ticket", "Customer", "Route", "SLA", ">"], [rows]);
};

/* ---- Hawker App ---- */
function stopState() { return store.get("stops", STOPS.map(s => s.st)); }
VIEWS.hawker_day = () => {
  const st = stopState();
  const done = st.filter(x => x === "done").length, miss = st.filter(x => x === "miss").length;
  const checked = store.get("checkin", null);
  return `<div class="field-col">` + pagehead("Hawker App — My Day", "Route MN-04 · Malviya Nagar") + `
    <div class="bigstat">
      <div class="card"><div class="lbl">Today's copies</div><div class="v num">365</div></div>
      <div class="card"><div class="lbl">Stops</div><div class="v num">${STOPS.length}</div></div>
      <div class="card"><div class="lbl">Delivered</div><div class="v num up">${done}</div></div>
      <div class="card"><div class="lbl">Missed</div><div class="v num ${miss ? "dn" : ""}">${miss}</div></div>
    </div>
    <div class="card pad" style="margin-bottom:13px">
      <div class="cardhead" style="padding:0 0 9px;border:none"><h3>Duty</h3>${checked ? chip("good", "Checked in · " + checked) : chip("warn", "Not checked in")}</div>
      ${checked ? `<p style="color:var(--muted);font-size:12.5px">Bundle verified — RP City 342 + Plus 23. Have a good run! 🛵</p>`
        : `<button class="btn pri block" onclick="store.set('checkin', new Date().toTimeString().slice(0,5));toast('Checked in — GPS stamped ✓');render()">✋ Check in & verify bundle</button>`}
    </div>
    <div class="card pad"><div class="cardhead" style="padding:0 0 9px;border:none"><h3>To collect today</h3></div>
      <div class="stat-pair"><span>Pending amount</span><b class="num">${fmtC(STOPS.filter((s, i) => s.collect && st[i] !== "done").reduce((a, s) => a + s.collect, 0) || 3355)}</b></div>
      <div class="stat-pair"><span>Households</span><b class="num">${STOPS.filter(s => s.collect > 0).length}</b></div>
      <button class="btn navy block" style="margin-top:10px" onclick="go('hawker_collect')">Open collect list →</button>
    </div></div>`;
};
VIEWS.hawker_route = () => {
  const st = stopState();
  const items = STOPS.map((s, i) => `<div class="stop ${st[i] === "done" ? "done" : st[i] === "miss" ? "miss" : ""}">
    <div class="n">${s.n}</div>
    <div class="info"><b>${s.name}</b><small>${s.addr} · ${s.pubs}${s.collect ? " · collect " + fmtC(s.collect) : ""}</small></div>
    ${st[i] === "pending"
      ? `<button class="tapbtn ok" aria-label="delivered" onclick="markStop(${i},'done')">✓</button>
         <button class="tapbtn no" aria-label="missed" onclick="markStop(${i},'miss')">✕</button>`
      : `<span class="chip ${st[i] === "done" ? "good" : "crit"}">${st[i] === "done" ? "Delivered" : "Missed"}</span>`}
  </div>`).join("");
  const done = st.filter(x => x === "done").length;
  return `<div class="field-col">` + pagehead("My Route — MN-04", `${done}/${STOPS.length} stops done · window 05:00–07:30`) + `
    <div class="card">${items}</div>
    <button class="btn block" style="margin-top:12px" onclick="store.set('stops', null);toast('Route reset (demo)');render()">Reset demo route</button></div>`;
};
window.markStop = (i, v) => {
  const st = stopState(); st[i] = v; store.set("stops", st);
  toast(v === "done" ? "Delivered ✓" : "Marked missed — customer notified"); render();
};
VIEWS.hawker_readers = () => {
  const rows = CUSTOMERS.filter(c => c.route === "MN-04").map(c => `<tr class="rowbtn" onclick='custDetail("${c.id}")'>
    <td><b>${c.name}</b><br><small style="color:var(--muted)">${c.addr.split(",")[0]}</small></td>
    <td>${c.plan.split(" · ")[0]}</td><td class="r num">${c.out ? fmtC(c.out) : "—"}</td>
    <td>${chip(c.status === "Active" ? "good" : "warn", c.status)}</td></tr>`).join("");
  return pagehead("My Readers", "126 households on route MN-04") +
    table(["Reader", "Plan", ">Due", "Status"], [rows]);
};
VIEWS.hawker_collect = () => {
  const collected = store.get("hawkerCollected", []);
  const items = PAYMENTS.map((p, i) => {
    const isDone = collected.includes(p.id);
    return `<div class="stop ${isDone ? "done" : ""}">
      <div class="n">₹</div>
      <div class="info"><b>${p.cust}</b><small>${p.id} · ${p.due}</small></div>
      <b class="num" style="margin-right:6px">${fmtC(p.amt)}</b>
      ${isDone ? `<span class="chip good">Collected</span>` : `<button class="btn good sm" onclick="hawkerCollect(${i})">Collect</button>`}</div>`;
  }).join("");
  const total = PAYMENTS.filter(p => collected.includes(p.id)).reduce((a, p) => a + p.amt, 0);
  return `<div class="field-col">` + pagehead("Collect", "Payments due on my route") + `
    <div class="bigstat">
      <div class="card"><div class="lbl">Collected today</div><div class="v num up">${fmtC(1440 + total)}</div></div>
      <div class="card"><div class="lbl">Still pending</div><div class="v num">${fmtC(PAYMENTS.filter(p => !collected.includes(p.id)).reduce((a, p) => a + p.amt, 0))}</div></div>
    </div><div class="card">${items}</div></div>`;
};
window.hawkerCollect = i => {
  const p = PAYMENTS[i];
  formModal("Record payment", `${p.cust} · ${fmtC(p.amt)}`,
    [{ k: "mode", label: "Mode", type: "select", opts: ["UPI (show QR)", "Cash"] }],
    "Confirm received", v => {
      const c = store.get("hawkerCollected", []); c.push(p.id); store.set("hawkerCollected", c);
      store.push("receipts", { no: "R-" + Math.floor(99150 + Math.random() * 800), cust: p.cust, amt: p.amt, mode: v.mode || "UPI", by: S.user.name, at: "just now" });
      api.post("/api/payments", { customer_name: p.cust, amount: p.amt, method: v.mode || "UPI", notes: "hawker collect" });
      toast(`Receipt sent to customer — ${fmtC(p.amt)} ✓`); render();
    });
};
VIEWS.hawker_earn = () => `<div class="field-col">` + pagehead("Earnings — July", "Delivery + incentives + referrals") + `
    <div class="bigstat">
      <div class="card"><div class="lbl">Month so far</div><div class="v num">₹4,318</div></div>
      <div class="card"><div class="lbl">Projected</div><div class="v num up">₹9,860</div></div>
    </div>
    <div class="card pad">
      <div class="stat-pair"><span>Delivery (₹0.35 × 12,336 copies)</span><b class="num">₹4,318</b></div>
      <div class="stat-pair"><span>On-time streak bonus (26 days)</span><b class="num">₹150 on track</b></div>
      <div class="stat-pair"><span>Referrals (2 × ₹100)</span><b class="num">₹200</b></div>
      <div class="stat-pair"><span>Collection incentive</span><b class="num">₹312</b></div>
      <div class="stat-pair"><span>June payout</span><b class="num up">₹9,214 · paid 05 Jul</b></div>
    </div></div>`;

/* ---- DCR Forms ---- */
VIEWS.dcr_att = () => {
  const att = store.get("dcrAtt", null);
  return `<div class="field-col">` + pagehead("DCR — Attendance", "Daily Collection Register · field attendance") + `
    <div class="card pad" style="text-align:center">
      <div style="font-size:44px;margin-bottom:6px">${att ? "✅" : "🕘"}</div>
      <h3 class="serif" style="font-size:18px">${att ? "Checked in at " + att : "You have not checked in"}</h3>
      <p style="color:var(--muted);font-size:12.5px;margin:6px 0 14px">${TODAY} · GPS + selfie stamped on check-in</p>
      ${att
        ? `<button class="btn crit" onclick="store.set('dcrAtt',null);toast('Checked out — day summary saved');render()">Check out</button>`
        : `<button class="btn pri" onclick="store.set('dcrAtt', new Date().toTimeString().slice(0,5));toast('Checked in ✓ GPS 26.85, 75.81');render()">✋ Check in now</button>`}
    </div>
    <div style="height:13px"></div>
    <div class="card"><div class="cardhead"><h3>Today's visit plan</h3><span class="chip mut">${TOUR.length} visits</span></div>
      ${TOUR.map(v => `<div class="exc"><div class="sev" style="background:var(--gold)"></div>
        <div style="flex:1;min-width:0"><b>${v.time} · ${v.type}</b><small>${v.target}<br>${v.why}</small></div></div>`).join("")}</div></div>`;
};
VIEWS.dcr_visit = () => {
  const visits = store.get("dcrVisits", []);
  return `<div class="field-col">` + pagehead("DCR — Visit Entry", "Record each field visit with outcome & collections") + `
    <button class="btn pri block" onclick="newVisit()" style="margin-bottom:13px">＋ New visit entry</button>
    <div class="card">${visits.length ? visits.slice().reverse().map(v => `<div class="exc">
        <div class="sev" style="background:var(--grn)"></div>
        <div style="flex:1;min-width:0"><b>${esc(v.type)} — ${esc(v.target)}</b>
        <small>${esc(v.outcome)}${Number(v.amt) ? " · collected " + fmtC(Number(v.amt)) : ""}${v.notes ? " · " + esc(v.notes) : ""}</small></div>
        <small style="color:var(--muted)">${v.at}</small></div>`).join("")
      : `<div style="padding:22px;text-align:center;color:var(--muted)">No visits recorded yet today.</div>`}</div></div>`;
};
window.newVisit = () => formModal("New visit entry", "GPS and time are stamped automatically.",
  [{ k: "type", label: "Visit type", type: "select", opts: ["Agency visit", "Hawker visit", "Reader visit", "New area survey", "Collection visit"] },
   { k: "target", label: "Visited whom / where", ph: "e.g. Shivam Distributors — Mansarovar" },
   { k: "outcome", label: "Outcome", type: "select", opts: ["Completed — positive", "Completed — follow-up needed", "Payment collected", "Not available", "Rescheduled"] },
   { k: "amt", label: "Amount collected (₹, if any)", type: "number", val: 0 },
   { k: "notes", label: "Notes", type: "textarea", ph: "key points, commitments, issues" }],
  "Save visit", v => {
    if (!v.target) { toast("Enter whom you visited"); return false; }
    store.push("dcrVisits", { ...v, at: new Date().toTimeString().slice(0, 5) });
    api.post("/api/visits", { visit_type: v.type, target: v.target, outcome: v.outcome, amount: Number(v.amt) || 0, notes: v.notes || "" });
    toast("Visit saved ✓"); render();
  });
VIEWS.dcr_report = () => {
  const visits = store.get("dcrVisits", []);
  const total = visits.reduce((a, v) => a + (Number(v.amt) || 0), 0);
  const submitted = store.get("dcrSubmitted", false);
  return `<div class="field-col">` + pagehead("DCR — Day Report", "Submit once at end of day · locks the register") + `
    <div class="bigstat">
      <div class="card"><div class="lbl">Visits logged</div><div class="v num">${visits.length}</div></div>
      <div class="card"><div class="lbl">Collected on visits</div><div class="v num up">${fmtC(total)}</div></div>
    </div>
    <div class="card pad">
      <div class="stat-pair"><span>Attendance</span><b>${store.get("dcrAtt", null) ? "Checked in ✓" : "Missing ✕"}</b></div>
      <div class="stat-pair"><span>Planned visits covered</span><b class="num">${Math.min(visits.length, TOUR.length)} / ${TOUR.length}</b></div>
      <div class="stat-pair"><span>Status</span><b>${submitted ? "Submitted to DMO ✓" : "Draft"}</b></div>
      ${submitted ? "" : `<button class="btn pri block" style="margin-top:12px" onclick="store.set('dcrSubmitted',true);toast('Day report submitted to DMO ✓');render()">Submit day report</button>`}
    </div>
    ${submitted ? `<button class="btn block" style="margin-top:12px" onclick="store.set('dcrSubmitted',false);store.set('dcrVisits',[]);toast('Demo reset');render()">Reset demo</button>` : ""}</div>`;
};

/* ---- Survey Form ---- */
VIEWS.survey_new = () => `<div class="field-col">` + pagehead("Survey — New Lead", "Field lead capture · takes under a minute") + `
    <div class="card pad">
      <div class="fld"><label>Respondent name *</label><input id="sv_name" placeholder="Full name"></div>
      <div class="fld"><label>Mobile *</label><input id="sv_phone" type="tel" maxlength="10" placeholder="10-digit mobile"></div>
      <div class="fld"><label>Area / colony</label><input id="sv_area" placeholder="e.g. Nirman Nagar B"></div>
      <div class="fld"><label>Currently reads</label><select id="sv_current">
        <option>No newspaper</option><option>Rajasthan Patrika</option><option>Dainik Bhaskar</option><option>Times of India</option><option>Other</option></select></div>
      <div class="fld"><label>Interested in</label><select id="sv_pub">
        <option>Rajasthan Patrika City</option><option>RP City + Patrika Plus</option><option>Catch (weekly)</option><option>Trial 14-day (free)</option></select></div>
      <div class="fld"><label>Interest level</label><select id="sv_interest">
        <option>High — start immediately</option><option>Medium — needs follow-up</option><option>Low — revisit later</option></select></div>
      <div class="fld"><label>Remarks</label><textarea id="sv_notes" placeholder="preferences, best time to visit…"></textarea></div>
      <div class="stat-pair" style="border:none"><span>📍 GPS</span><b class="num">26.8512, 75.8125 (auto)</b></div>
      <button class="btn pri block" onclick="submitSurvey()">Submit survey ✓</button>
    </div></div>`;
window.submitSurvey = () => {
  const g = id => document.getElementById(id).value.trim();
  const name = g("sv_name"), phone = g("sv_phone").replace(/\D/g, "");
  if (!name || !/^\d{10}$/.test(phone)) { toast("Name and a valid 10-digit mobile are required"); return; }
  const interest = g("sv_interest");
  store.push("leads", { name, phone, area: g("sv_area") || "—", pub: g("sv_pub"), stage: "Surveyed",
    next: interest.startsWith("High") ? "Start subscription" : "Follow up",
    score: interest.startsWith("High") ? 85 : interest.startsWith("Medium") ? 60 : 35,
    notes: g("sv_notes"), at: TODAY });
  api.post("/api/leads", { name, mobile: phone, area: g("sv_area") || "—", publication: g("sv_pub"), interest, notes: g("sv_notes") });
  toast("Survey submitted ✓ Lead added"); go("survey_leads");
};
VIEWS.survey_leads = () => {
  const mine = store.get("leads", []);
  const all = [...mine.slice().reverse(), ...LEADLIST];
  const rows = all.map(l => `<tr>
    <td><b>${esc(l.name)}</b><br><small style="color:var(--muted)">${esc(l.area)} · ${esc(l.phone)}</small></td>
    <td>${esc(l.pub)}</td>
    <td>${chip(l.stage === "Converted" ? "good" : "info", l.stage)}</td>
    <td><div class="bar"><i style="width:${l.score}%;background:${l.score >= 75 ? "var(--grn)" : "var(--gold)"}"></i></div></td></tr>`).join("");
  return pagehead("My Leads", `${all.length} leads · ${mine.length} captured by you`,
    `<button class="btn pri" onclick="go('survey_new')">＋ New survey</button>`) +
    table(["Lead", "Publication", "Stage", "Score"], [rows]);
};

/* ---- Taxi Fleet ---- */
VIEWS.taxi_trips = () => {
  const mine = store.get("trips", []);
  const rows = [...mine.slice().reverse(), ...TRIPS].map(tp => `<tr>
    <td><b>${tp.id}</b><br><small style="color:var(--muted)">${esc(tp.veh)}</small></td>
    <td>${esc(tp.driver)}</td><td>${esc(tp.route)}</td><td class="r num">${tp.load}</td>
    <td>${chip(tp.status === "Completed" ? "good" : tp.status === "Delayed" ? "crit" : "info", tp.status)}</td></tr>`).join("");
  return pagehead("Taxi Fleet — Today's Trips", "Press dispatch runs · " + TODAY,
    `<button class="btn pri" onclick="go('taxi_log')">＋ Log trip</button>`) +
    table(["Trip", "Driver", "Route", ">Load", "Status"], [rows]);
};
VIEWS.taxi_log = () => `<div class="field-col">` + pagehead("Log Trip", "Record a dispatch run") + `
    <div class="card pad">
      <div class="fld"><label>Vehicle *</label><select id="tx_veh">${VEHICLES.map(v => `<option>${v.no} — ${v.type}</option>`).join("")}</select></div>
      <div class="fld"><label>Route *</label><input id="tx_route" placeholder="e.g. Press → Chomu → Samod"></div>
      <div class="fld"><label>Copies loaded</label><input id="tx_load" type="number" placeholder="e.g. 4200"></div>
      <div class="fld"><label>Departure time</label><input id="tx_dep" type="time" value="04:30"></div>
      <div class="fld"><label>Notes</label><textarea id="tx_notes" placeholder="checkpoints, handover details…"></textarea></div>
      <button class="btn pri block" onclick="logTrip()">Start trip ✓</button>
    </div></div>`;
window.logTrip = () => {
  const g = id => document.getElementById(id).value.trim();
  if (!g("tx_route")) { toast("Enter the route"); return; }
  const vehNo = g("tx_veh").split(" — ")[0];
  store.push("trips", { id: "T-" + Math.floor(4480 + Math.random() * 400), veh: vehNo, driver: S.user.name,
    load: fmtN(Number(g("tx_load")) || 0), route: g("tx_route"), dep: g("tx_dep"), eta: "—", status: "In transit", delay: 0 });
  api.post("/api/trips", { vehicle_no: vehNo, route: g("tx_route"), bundles: Number(g("tx_load")) || 0, departure: g("tx_dep") });
  toast("Trip started — live tracking on ✓"); go("taxi_trips");
};
VIEWS.taxi_vehicles = () => {
  const rows = VEHICLES.map(v => `<tr><td><b>${v.no}</b></td><td>${v.type}</td><td>${v.driver}</td>
    <td class="num">${v.fitness}</td><td class="num">${v.insurance}</td>
    <td>${chip(v.status === "Idle" ? "mut" : v.status === "Delayed" ? "crit" : "good", v.status)}</td></tr>`).join("");
  return pagehead("Vehicles", "Fleet register & compliance") +
    table(["Vehicle", "Type", "Driver", "Fitness", "Insurance", "Status"], [rows]);
};

/* ═══════════ READERS CONNECT ═══════════ */

let _rcMap = null, _rcCluster = null, _rcMapEl = null;
const RC_COLORS = ['#E91E63','#9C27B0','#3F51B5','#2196F3','#00BCD4','#4CAF50','#FF9800','#F44336','#795548','#607D8B','#FF5722','#8BC34A','#CDDC39','#00ACC1','#7CB342','#FB8C00','#E53935','#8E24AA','#1E88E5','#43A047','#6D4C41'];
const RC_STATE_NAMES = {'RA0':'Rajasthan','MP0':'Madhya Pradesh','CG0':'Chhattisgarh'};
const RC_STATUS_LABELS = {'NEW':'New Lead','RP_READER':'RP Reader','NOT_INTERESTED':'Other Reader','FOLLOW_UP':'Follow-up','REPLACE':'Replace'};
const RC_STATUS_ORDER = ['NEW','RP_READER','NOT_INTERESTED','FOLLOW_UP','REPLACE'];

/* Inject minimal RC styles once */
(function() {
  const s = document.createElement('style');
  s.textContent = `.rc-news-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;cursor:pointer;transition:all .15s;user-select:none}.rc-news-chip:hover{opacity:.85}.rc-tabs .btn{border-radius:0}.rc-tabs .btn:first-child{border-radius:var(--r-sm) 0 0 var(--r-sm)}.rc-tabs .btn:last-child{border-radius:0 var(--r-sm) var(--r-sm) 0}.rc-reader-pin{background:none;border:none}.rc-reader-pin svg{display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))}.rc-cluster{background:none;border:none}`;
  document.head.appendChild(s);
})();

/* --- QS builder from current rc filter state --- */
function rcQS(extras) {
  const f = S.live.rcFilters || {};
  const p = [];
  if (f.from && f.to)        { p.push('from=' + f.from, 'to=' + f.to); }
  if (f.state_name)            p.push('state_name=' + encodeURIComponent(f.state_name));
  if (f.unit_code)             p.push('unit_code=' + encodeURIComponent(f.unit_code));
  if (f.locality_code)         p.push('locality_code=' + encodeURIComponent(f.locality_code));
  if (f.unprod_reasons?.length) p.push('unprod_reasons=' + encodeURIComponent(f.unprod_reasons.join(',')));
  if (f.newspapers?.length)     p.push('newspapers=' + encodeURIComponent(f.newspapers.join(',')));
  if (extras) p.push(...extras);
  return p.length ? '?' + p.join('&') : '';
}

/* --- Fetch functions --- */
async function rcFetchFilterOpts() {
  const f = S.live.rcFilters || {};
  const p = [];
  // Only pass unit_code — state filtering is done client-side on the full units list
  if (f.unit_code) p.push('unit_code=' + encodeURIComponent(f.unit_code));
  const d = await api.get('/api/readers/filters' + (p.length ? '?' + p.join('&') : ''));
  if (d) {
    // Preserve allUnits across requests so state cascade can filter locally
    d.allUnits = S.live.rcFilterOpts?.allUnits || d.units;
    // Apply current state filter to displayed units
    const state = f.state_name;
    if (state && d.allUnits) d.units = d.allUnits.filter(u => u.state === state);
    S.live.rcFilterOpts = d;
  }
  S.live._rcFOLoading = false;
  if (S.screen === 'readers_connect' || (S.screen === 'survey_dash' && S.live.sdvTab === 'map')) render();
}

async function rcFetchNewspapers(force) {
  if (S.live.rcNews && !force) return;
  // Counts follow the active filters (dates/state/unit/locality — never the paper selection)
  const f = S.live.rcFilters || {};
  const p = [];
  if (f.from && f.to)    p.push('from=' + f.from, 'to=' + f.to);
  if (f.state_name)      p.push('state_name='    + encodeURIComponent(f.state_name));
  if (f.unit_code)       p.push('unit_code='     + encodeURIComponent(f.unit_code));
  if (f.locality_code)   p.push('locality_code=' + encodeURIComponent(f.locality_code));
  const d = await api.get('/api/readers/newspapers' + (p.length ? '?' + p.join('&') : ''));
  if (d) {
    // New format: { units: [...], papers: [...] }; fall back to old array format
    S.live.rcNews   = d.units   || (Array.isArray(d) ? d : []);
    S.live.rcPapers = d.papers  || [];
  }
  if (S.screen === 'readers_connect') render();
}

async function rcFetchSummary() {
  S.live._rcSumLoad = true;
  const d = await api.get('/api/readers/summary' + rcQS());
  S.live.rcSummary = d;
  S.live._rcSumLoad = false;
  if (S.screen === 'readers_connect') render();
}

async function rcFetchMarkers() {
  S.live._rcMkLoad = true;
  // Always fetch ALL markers (no newspaper filter) — newspaper is applied client-side
  // so toggling newspaper buttons never triggers a server round-trip.
  const f = S.live.rcFilters || {};
  const p = [];
  if (f.from && f.to)           p.push('from=' + f.from, 'to=' + f.to);
  if (f.state_name)              p.push('state_name=' + encodeURIComponent(f.state_name));
  if (f.unit_code)               p.push('unit_code=' + encodeURIComponent(f.unit_code));
  if (f.locality_code)           p.push('locality_code=' + encodeURIComponent(f.locality_code));
  if (f.unprod_reasons?.length)  p.push('unprod_reasons=' + encodeURIComponent(f.unprod_reasons.join(',')));
  const qs = p.length ? '?' + p.join('&') : '';
  const d = await api.get('/api/readers/markers' + qs);
  S.live.rcMarkers = d ? d.markers : [];
  S.live._rcMkLoad = false;
  if (S.screen === 'readers_connect') {
    render();
    if ((S.live.rcTab || 'map') === 'map') setTimeout(rcInitMap, 40);
  } else if (S.screen === 'survey_dash' && S.live.sdvTab === 'map') {
    render();
    setTimeout(rcInitMap, 40);
  }
}

async function rcFetchReaders(page) {
  S.live._rcRdrLoad = true;
  const d = await api.get('/api/readers/locality-readers' + rcQS(['page=' + (page || 1)]));
  S.live.rcReaders = d;
  S.live._rcRdrLoad = false;
  if (S.screen === 'readers_connect') render();
}

async function rcFetchTemplates() {
  const d = await api.get('/api/readers/templates');
  S.live.rcTemplates = d ? (d.templates || []) : [];
  if (S.screen === 'readers_connect') render();
}

async function rcFetchHistory(page) {
  const d = await api.get('/api/readers/msg-history?page=' + (page || 1));
  S.live.rcHistory = d;
  S.live._rcHistLoad = false;
  if (S.screen === 'readers_connect') render();
}

/* --- Map initialisation --- */
function rcInitMap() {
  const el = document.getElementById('rc-map');
  if (!el) return;
  if (!window.L) {
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;padding:20px;text-align:center">Map library not loaded — ensure internet access and reload the page.</div>';
    return;
  }
  // Reuse the live map across renders. render() rewrites the page DOM, so the freshly
  // rendered #rc-map is an empty placeholder — swap it for the original container node
  // (which still holds Leaflet's tiles, zoom and layers) instead of rebuilding the map.
  // Tearing the map down on every render made it look stuck loading forever.
  if (_rcMap && _rcMapEl) {
    if (el !== _rcMapEl) { try { el.replaceWith(_rcMapEl); } catch (_) {} }
    try { _rcMap.invalidateSize(); } catch (_) {}
    rcLoadMapMarkers();
    return;
  }
  _rcMapEl = el;
  _rcMap = L.map(el, { preferCanvas: true }).setView([23.5, 76.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(_rcMap);
  rcLoadMapMarkers();
}

/* Colour for an INDIVIDUAL reader marker — BHASKAR check before NOT_INTERESTED */
function rcNewsColor(marker) {
  const reason = String(marker.unprod_reason || '');
  const paper  = String(marker.newspaper_name || '').toUpperCase();
  // Newspaper data (primary_newspaper) takes priority over surveyor's survey-outcome label
  if (paper === 'RP+DB')           return '#6A1B9A';  // Purple — reads both RP and DB
  if (paper.includes('BHASKAR'))   return '#C62828';  // Red    — DB reader
  if (paper.includes('PATRIKA'))   return '#2E7D32';  // Green  — RP reader (RAJASTHAN PATRIKA or PATRIKA)
  // Fallback: no matching newspaper data — use survey outcome
  if (reason === 'RP_READER')      return '#2E7D32';  // Green  — surveyor confirmed RP
  if (reason === 'NOT_INTERESTED') return '#1565C0';  // Blue   — other competitor
  if (reason === 'FOLLOW_UP')      return '#E65100';  // Orange — follow-up pending
  if (reason === 'REPLACE')        return '#00897B';  // Teal   — replace
  return '#607D8B';                                   // Grey   — new lead
}

/* Colour for a NEWSPAPER NAME string (dropdown filter and reader list) */
function rcNwColor(name) {
  const n = String(name || '').toUpperCase();
  if (n === 'NONE' || n === '')    return 'var(--muted)';
  if (n === 'RP+DB')               return '#6A1B9A';  // Purple — both RP+DB
  if (n.includes('PATRIKA'))       return '#2E7D32';  // Green  — RP
  if (n.includes('BHASKAR'))       return '#C62828';  // Red    — DB
  return '#1565C0';                                   // Blue   — other competitor
}

/* Newspaper display label: NONE → "None", NULL → em-dash */
function rcNewsLabel(name) {
  if (!name) return '—';
  return String(name).toUpperCase() === 'NONE' ? 'None' : name;
}

/* Distinctive teardrop map-pin for a reader (coloured per newspaper) — stands out from
   the OpenStreetMap POI glyphs (hospital, restaurant, etc.) that plain dots blended into. */
const _rcIconCache = {};
function rcReaderIcon(color) {
  if (_rcIconCache[color]) return _rcIconCache[color];
  const html =
    `<svg width="14" height="19" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M11 0C5 0 0 4.7 0 10.6 0 18.6 11 30 11 30s11-11.4 11-19.4C22 4.7 17 0 11 0z" fill="${color}" stroke="#fff" stroke-width="2"/>` +
    `<circle cx="11" cy="10.4" r="3.7" fill="#fff"/></svg>`;
  const icon = L.divIcon({
    className: 'rc-reader-pin',
    html,
    iconSize: [14, 19],
    iconAnchor: [7, 19],        // tip sits on the exact GPS point
    tooltipAnchor: [0, -17],
  });
  _rcIconCache[color] = icon;
  return icon;
}

/* Clean, on-brand cluster bubble (navy circle + white count) shown when many readers overlap */
function rcClusterIcon(cluster) {
  const n = cluster.getChildCount();
  const size = n < 10 ? 30 : n < 100 ? 36 : n < 1000 ? 42 : 48;
  const fs   = n < 1000 ? 12 : 11;
  return L.divIcon({
    className: 'rc-cluster',
    html: `<div style="width:${size}px;height:${size}px;line-height:${size}px;border-radius:50%;` +
          `background:rgba(28,43,69,.92);color:#fff;text-align:center;font-weight:700;font-size:${fs}px;` +
          `border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)">${n >= 1000 ? (n/1000).toFixed(1) + 'k' : n}</div>`,
    iconSize: [size, size],
  });
}

function rcLoadMapMarkers() {
  if (!_rcMap || !window.L) return;
  const mks = S.live.rcMarkers || [];
  const selNw = S.live.rcFilters?.newspapers || [];
  const nwKey = selNw.join(',');
  if (_rcCluster && _rcCluster._mksRef === mks && _rcCluster._nwRef === nwKey) return;
  if (_rcCluster) { try { _rcMap.removeLayer(_rcCluster); } catch (_) {} }

  // Cluster overlapping readers into clean count-bubbles (expand on zoom) — avoids the
  // cluttered pile-up of hundreds of pins at wide zoom. Falls back to a plain group.
  const layer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        chunkedLoading: true,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 45,
        disableClusteringAtZoom: 12,   // zoomed into an area → show every reader's actual location
        iconCreateFunction: rcClusterIcon,
      })
    : L.layerGroup();
  layer._mksRef = mks;
  layer._nwRef  = nwKey;
  _rcCluster = layer;

  // Client-side newspaper filter
  const displayMks = selNw.length ? mks.filter(m => selNw.includes(m.newspaper_name || '')) : mks;

  // One dot per reader at their actual GPS coordinates — click opens full detail modal
  const bounds = [];
  displayMks.forEach(m => {
    const lat = parseFloat(m.lat), lng = parseFloat(m.lng);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
    const col = rcNewsColor(m);
    const mk  = L.marker([lat, lng], { icon: rcReaderIcon(col) });
    mk.on('click', () => { if (m.r_id) window.rcViewReader(m.r_id); });
    const ttHtml = `<b>${esc(m.r_name || m.r_id || '—')}</b><br>` +
      `${esc(m.unit_name || '')} · ${esc(m.locality_name || ('Zone ' + (m.locality_code || '?')))}<br>` +
      `<span style="color:${rcNwColor(m.newspaper_name)}">${esc(rcNewsLabel(m.newspaper_name))}</span>`;
    mk.bindTooltip(ttHtml, { sticky: true, direction: 'top', offset: [0, 0] });
    layer.addLayer(mk);
    bounds.push([lat, lng]);
  });

  _rcMap.addLayer(layer);
  if (bounds.length > 0) {
    try { _rcMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); } catch (_) {}
  }
}

/* --- Sub-render helpers --- */

function rcSummaryCards(summary) {
  const t = summary?.totals || {};
  const n = x => summary ? fmtN(Number(x) || 0) : '…';
  return `<div class="grid kpis" style="margin-bottom:12px">
    ${kpi('Total Surveyed', n(t.total), 'all surveyed', 'fl', 'var(--blue-l)', '👥')}
    ${kpi('New Leads', n(t.new_leads), 'potential subscribers', 'fl', 'var(--gold-l)', '✨')}
    ${kpi('RP Readers', n(t.rp_readers), 'already subscribed', 'up', 'var(--teal-l)', '📰')}
    ${kpi('DB Readers', n(t.db_readers), 'reading Dainik Bhaskar', 'dn', 'var(--red-l)', '📄')}
    ${kpi('Other Readers', n(t.other_readers), 'competitor / not interested', 'dn', 'var(--red-l)', '🗞️')}
    ${kpi('Follow-ups', n(t.follow_up), 'pending follow-up', 'fl', 'var(--gold-l)', '🔔')}
  </div>`;
}

function rcFilterPanel(f, opts, news) {
  const stOpts = (opts.states || []).map(s =>
    `<option value="${esc(s.code)}" ${f.state_name === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const uOpts = (opts.units || []).map(u =>
    `<option value="${esc(u.code)}" ${f.unit_code === u.code ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const lOpts = (opts.localities || []).map(l => {
    const code = typeof l === 'object' ? l.code : l;
    const name = typeof l === 'object' ? (l.name || 'Zone ' + l.code) : ('Zone ' + l);
    return `<option value="${esc(String(code))}" ${f.locality_code === String(code) ? 'selected' : ''}>${esc(name)}</option>`;
  }).join('');
  // Status chips
  const statusChips = RC_STATUS_ORDER.map(key => {
    const sel = (f.unprod_reasons || []).includes(key);
    const label = RC_STATUS_LABELS[key] || key;
    const colors = {'NEW':'#4CAF50','RP_READER':'#2196F3','NOT_INTERESTED':'#F44336','FOLLOW_UP':'#FF9800','REPLACE':'#9C27B0'};
    const col = colors[key] || '#607D8B';
    return `<label class="rc-news-chip" style="background:${sel ? col : 'var(--surf2)'};color:${sel ? '#fff' : 'var(--ink)'};border:1.5px solid ${col}">
      <input type="checkbox" class="rc-status-chk" value="${key}" ${sel ? 'checked' : ''} style="display:none">
      ${esc(label)}
    </label>`;
  }).join('');
  // Newspaper multi-select dropdown — checkboxes live in a collapsible panel;
  // panel stays in the DOM (display:none) so Apply/capture can always read them.
  const papers = S.live.rcPapers || [];
  const selNews = f.newspapers || [];
  const nwLabel = selNews.length ? selNews.length + ' selected' : 'All Newspapers';
  const nwItems = papers.map(p => {
    const nm   = p.newspaper_name || p;
    const sel  = selNews.includes(nm);
    const col  = rcNwColor(nm);
    const chkId = 'nwc-' + String(nm).replace(/\W+/g,'_');
    const cntTxt = p.cnt ? ' (' + fmtN(p.cnt) + ')' : '';
    return `<div style="padding:7px 12px;cursor:pointer;white-space:nowrap;line-height:1.6"
      onclick="var c=document.getElementById('${chkId}');c.checked=!c.checked;rcNwCount()"
      onmouseover="this.style.background='var(--surf2)'" onmouseout="this.style.background=''">
      <input type="checkbox" id="${chkId}" class="rc-news-filter-chk" value="${esc(nm)}" ${sel ? 'checked' : ''} onchange="" onclick="event.stopPropagation()" style="margin:0 6px 0 0;vertical-align:middle;cursor:pointer">
      <b style="color:${col};font-size:13px;font-weight:600;vertical-align:middle">${esc(nm)}</b><span style="color:var(--muted);font-size:11px;vertical-align:middle">${cntTxt}</span>
    </div>`;
  }).join('');
  const nwPos  = S.live.rcNwPos || {};
  const nwDropdown = papers.length ? `
    <div class="fld" style="margin:0;flex:1;min-width:150px"><label>Newspaper</label>
      <button type="button" id="rc-nw-btn" onclick="rcNwToggleOpen(event)"
        style="width:100%;text-align:left;cursor:pointer;padding:8px 10px;border:1px solid var(--brd);border-radius:8px;background:var(--surf);color:var(--ink);font-size:13px">
        🗞️ ${nwLabel} ▾</button>
      <div id="rc-nw-panel" style="display:${S.live.rcNwOpen ? 'block' : 'none'};position:fixed;top:${nwPos.top||0}px;right:${nwPos.right||0}px;z-index:9999;background:var(--surf);border:1px solid var(--brd);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-height:260px;overflow-y:auto;min-width:260px;max-width:360px;margin-top:4px">
        ${nwItems}
      </div>
    </div>` : '';

  return `<div class="card pad" style="margin-bottom:12px;position:relative;z-index:500;overflow:visible">
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px">
      <div class="fld" style="margin:0;flex:0 0 125px"><label>From Date</label><input id="rc-from" type="date" value="${f.from || ''}"></div>
      <div class="fld" style="margin:0;flex:0 0 125px"><label>To Date</label><input id="rc-to" type="date" value="${f.to || ''}"></div>
      <div class="fld" style="margin:0;flex:1;min-width:130px"><label>State</label>
        <select id="rc-state" onchange="rcCascadeState()"><option value="">All States</option>${stOpts}</select></div>
      <div class="fld" style="margin:0;flex:1;min-width:130px"><label>Unit / Branch</label>
        <select id="rc-unit" onchange="rcCascadeUnit()"><option value="">All Units</option>${uOpts}</select></div>
      <div class="fld" style="margin:0;flex:1;min-width:110px"><label>Locality</label>
        <select id="rc-loc" onchange="rcCascadeLocality()"><option value="">All Localities</option>${lOpts}</select></div>
      ${nwDropdown}
      <div style="display:flex;gap:8px;flex-shrink:0;padding-bottom:2px">
        <button class="btn pri" onclick="rcApplyFilters()">Apply</button>
        <button class="btn" onclick="rcClearFilters()">Reset</button>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px">
      <div>
        <div style="font-size:10.5px;font-weight:700;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">Reader Status</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${statusChips}</div>
      </div>
    </div>
  </div>`;
}

function rcMapTab(markers, summary) {
  const loading = S.live._rcMkLoad;
  const f = S.live.rcFilters || {};
  const selNw = f.newspapers || [];
  const nwAll = S.live.rcFilterOpts?.newspapers || [];

  // Newspaper filter applied client-side to individual reader markers
  const displayedMks = selNw.length
    ? (markers || []).filter(m => selNw.includes(m.newspaper_name || ''))
    : (markers || []);
  const cnt = displayedMks.length;

  // Count by dot colour — must mirror rcNewsColor() priority exactly
  let cRP = 0, cDB = 0, cOther = 0, cNone = 0, cRPDB = 0;
  displayedMks.forEach(m => {
    const col = rcNewsColor(m);
    if      (col === '#6A1B9A') cRPDB++;
    else if (col === '#C62828') cDB++;
    else if (col === '#2E7D32') cRP++;
    else if (col === '#1565C0') cOther++;
    else                        cNone++;
  });
  const kpiTotal = summary?.totals?.total;
  const legItem = (col, label, n) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:0 14px 4px 0">
      <span style="width:11px;height:11px;border-radius:50%;background:${col};flex-shrink:0;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2)"></span>
      ${label} <b class="num">${fmtN(n)}</b>
    </span>`;
  const legend =
    legItem('#2E7D32', 'RP Readers', cRP) +
    (cRPDB > 0 ? legItem('#6A1B9A', 'RP+DB', cRPDB) : '') +
    legItem('#C62828', 'DB Readers', cDB) +
    legItem('#1565C0', 'Other Readers', cOther) +
    legItem('#607D8B', 'New / Follow-up', cNone);

  const nwNote = selNw.length
    ? `<span style="font-size:11px;color:var(--acc);font-weight:600">🗞️ ${selNw.map(esc).join(', ')}</span>` : '';
  const gpsNote = kpiTotal
    ? `<span style="font-size:11px;color:var(--muted)"> · GPS available for ${fmtN(cnt)} of ${fmtN(kpiTotal)} readers</span>` : '';

  return `<div class="card" style="margin-bottom:12px;overflow:visible">
    <div style="padding:8px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--brd);gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--muted)">${loading ? 'Loading map…' : fmtN(cnt) + ' readers on map' + (cnt >= 10000 ? ' (max 10000)' : '')}${gpsNote} ${nwNote}</span>
      <button class="btn sm" onclick="window.rcRefreshMap()">↻ Refresh</button>
    </div>
    <div id="rc-map" style="height:480px;background:var(--surf2)"></div>
    <div style="padding:8px 14px;border-top:1px solid var(--brd);display:flex;flex-wrap:wrap;align-items:center">${legend}</div>
  </div>`;
}

function rcListTab(readers, loading) {
  if (loading) return `<div class="card pad" style="text-align:center;padding:32px;color:var(--muted)">Loading readers…</div>`;
  if (!readers) return `<div class="card pad" style="text-align:center;padding:24px;color:var(--muted)">Apply filters above and click Apply to load the reader list.</div>`;
  const { readers: rows = [], total = 0, page = 1, pages = 1 } = readers;
  const hl = S.user?.hierarchyLevel || 9;
  const hasMobile = hl <= 4;
  const rhtml = rows.map(r => {
    const rData = esc(JSON.stringify({ r_id: r.r_id, r_name: r.r_name, mobile: r.mobile || '', unit_code: r.unit_code, unit_name: r.unit_name, locality_code: r.locality_code, scheme_name: r.scheme_name }));
    const statusLabel = RC_STATUS_LABELS[r.unprod_reason] || r.unprod_reason || '—';
    const statusChip = chip(r.unprod_reason === 'NEW' ? 'good' : r.unprod_reason === 'RP_READER' ? 'mut' : r.unprod_reason === 'NOT_INTERESTED' ? 'crit' : 'warn', esc(statusLabel));
    const locDisplay = r.locality_name || (r.locality_code ? 'Zone ' + r.locality_code : '—');
    const addrLine = [r.house_no ? 'H.No.'+r.house_no : '', r.r_block_street && r.r_block_street !== '.' ? r.r_block_street : ''].filter(Boolean).join(', ');
    return `<tr>
      <td style="width:32px"><input type="checkbox" class="rc-sel-chk" value="${esc(r.r_id||r.id||'')}" data-r="${rData}"></td>
      <td><b>${esc(r.r_name || '—')}</b><small style="display:block;color:var(--muted)">${esc(r.gender || '')} · ${esc(r.r_id || '')}</small></td>
      <td><small>${esc(locDisplay)}${addrLine ? '<br><span style="color:var(--muted)">' + esc(addrLine.slice(0,30)) + (addrLine.length>30?'…':'') + '</span>' : ''}</small></td>
      <td><small>${esc(r.unit_name || r.unit_code || '—')}</small></td>
      <td>${statusChip}</td>
      <td><small style="color:${rcNwColor(r.newspaper_name)};font-weight:600">${esc(rcNewsLabel(r.newspaper_name))}</small></td>
      <td><small>${r.bookdate || '—'}</small></td>
      ${hasMobile ? `<td><small>${esc(r.mobile || '—')}</small></td>` : ''}
      <td style="white-space:nowrap">
        <button class="btn sm" data-r="${rData}" onclick="window.rcSendOneBtn(this)" title="Send WhatsApp/SMS">💬</button>
        <button class="btn sm" onclick="window.rcViewReader('${esc(r.r_id||'')}')">👁</button>
      </td>
    </tr>`;
  }).join('');
  const th = s => `<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--brd);color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">${s}</th>`;
  const hdrs = ['', 'Name', 'Locality / Address', 'Unit', 'Status', 'Newspaper', 'Date', ...(hasMobile ? ['Mobile'] : []), 'Act.'].map(th).join('');
  return `<div class="card" style="margin-bottom:12px">
    <div style="padding:8px 12px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;border-bottom:1px solid var(--brd)">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="rc-sel-all" onchange="window.rcToggleAll(this.checked)"> Select all shown
      </label>
      <button class="btn pri sm" onclick="window.rcBulkSend()">Bulk Send Message</button>
      <span style="font-size:12px;color:var(--muted)">Page ${page} of ${pages} · ${fmtN(total)} total</span>
      <div style="margin-left:auto;display:flex;gap:6px">
        ${page > 1 ? `<button class="btn sm" onclick="rcFetchReaders(${page - 1})">← Prev</button>` : ''}
        ${page < pages ? `<button class="btn sm" onclick="rcFetchReaders(${page + 1})">Next →</button>` : ''}
      </div>
    </div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>${hdrs}</tr></thead><tbody>${rhtml}</tbody>
    </table></div>
  </div>`;
}

function rcMessagesTab(templates, history) {
  const tpl = templates || [];
  const tRows = tpl.map(t => `<tr>
    <td>${chip(t.template_type === 'wa' ? 'good' : 'mut', t.template_type === 'wa' ? '📱 WA' : '📩 SMS')}</td>
    <td><b>${esc(t.template_name)}</b></td>
    <td style="max-width:280px"><small style="color:var(--muted)">${esc(t.template_body.slice(0, 90))}${t.template_body.length > 90 ? '…' : ''}</small></td>
    <td><small>${esc(t.wa_template_id || t.sms_dlt_id || '—')}</small></td>
    <td style="white-space:nowrap">
      <button class="btn sm" onclick="window.rcEditTemplate(${t.id})">Edit</button>
      <button class="btn crit sm" onclick="window.rcDelTemplate(${t.id})">Del</button>
    </td>
  </tr>`).join('');
  const th = s => `<th style="text-align:left;padding:5px 8px;border-bottom:1px solid var(--brd);color:var(--muted);font-size:11px;text-transform:uppercase">${s}</th>`;
  const hist = history || { history: [], total: 0, page: 1 };
  const hRows = hist.history.map(h => `<tr>
    <td><small>${(h.sent_at || '').slice(0, 16).replace('T', ' ')}</small></td>
    <td>${esc(h.r_name || '—')}</td>
    <td><small>${esc(h.mobile || '—')}</small></td>
    <td>${chip(h.msg_type === 'wa' ? 'good' : 'mut', (h.msg_type || '').toUpperCase())}</td>
    <td style="max-width:200px"><small style="color:var(--muted)">${esc((h.message_body || '').slice(0, 60))}…</small></td>
    <td>${chip(h.status === 'sent' || h.status === 'delivered' ? 'good' : h.status === 'failed' ? 'crit' : 'warn', esc(h.status || 'queued'))}</td>
    <td><small>${esc(h.sent_by || '—')}</small></td>
  </tr>`).join('');
  return `
    <div class="card pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px">Message Templates</div>
        <button class="btn pri sm" onclick="window.rcNewTemplate()">+ New Template</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
        Variables: <b>{ReaderName}</b> · <b>{Locality}</b> · <b>{UnitName}</b> · <b>{SchemeName}</b> · <b>{Date}</b>
      </div>
      ${tpl.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>${['Type','Name','Preview','Template ID','Actions'].map(th).join('')}</tr></thead>
        <tbody>${tRows}</tbody>
      </table></div>` : `<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">No templates yet — create one to start messaging readers.</div>`}
    </div>
    <div class="card pad">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px">Communication History</div>
        <span style="font-size:12px;color:var(--muted)">${fmtN(hist.total || 0)} messages</span>
      </div>
      ${hist.history.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>${['Time','Reader','Mobile','Channel','Message','Status','Sent By'].map(th).join('')}</tr></thead>
        <tbody>${hRows}</tbody>
      </table></div>
      <div style="display:flex;gap:8px;padding:10px 0 2px">
        ${hist.page > 1 ? `<button class="btn sm" onclick="rcFetchHistory(${hist.page - 1})">← Prev</button>` : ''}
        <span style="font-size:12px;color:var(--muted);margin:auto 0">Page ${hist.page}</span>
        ${hist.total > hist.page * 30 ? `<button class="btn sm" onclick="rcFetchHistory(${hist.page + 1})">Next →</button>` : ''}
      </div>` : `<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">No messages sent yet.</div>`}
    </div>`;
}

/* --- Main VIEWS entry --- */
function rcMonthDefault() {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

VIEWS.readers_connect = () => {
  // If dates are absent (first entry OR after Reset), apply current-month defaults
  if (!S.live.rcFilters) S.live.rcFilters = {};
  if (!S.live.rcFilters.from && !S.live.rcFilters.to) {
    const d = rcMonthDefault();
    S.live.rcFilters.from = d.from;
    S.live.rcFilters.to   = d.to;
  }
  const tab = S.live.rcTab || 'list';
  const f   = S.live.rcFilters || {};
  const opts = S.live.rcFilterOpts || { states: [], units: [], localities: [] };
  const news = S.live.rcNews || [];
  const summary  = S.live.rcSummary;
  const readers  = S.live.rcReaders;
  const templates = S.live.rcTemplates || null;
  const history   = S.live.rcHistory;

  /* Bootstrap loads on first entry */
  if (!S.live.rcFilterOpts && !S.live._rcFOLoading) {
    S.live._rcFOLoading = true;
    setTimeout(() => { rcFetchFilterOpts(); rcFetchNewspapers(); }, 0);
  }
  if (!summary && !S.live._rcSumLoad) {
    S.live._rcSumLoad = true;
    setTimeout(rcFetchSummary, 0);
  }
  if (!readers && !S.live._rcRdrLoad) {
    S.live._rcRdrLoad = true;
    setTimeout(() => rcFetchReaders(1), 0);
  }
  if (tab === 'messages') {
    if (!history && !S.live._rcHistLoad)     { S.live._rcHistLoad = true; setTimeout(() => rcFetchHistory(1), 0); }
    if (templates === null)                   setTimeout(rcFetchTemplates, 0);
  }

  const tabBtn = (id, lbl, ico) =>
    `<button class="btn${tab === id ? ' navy' : ''} sm" onclick="window.rcSetTab('${id}')" style="flex:1">${ico} ${lbl}</button>`;

  return pagehead('Readers Connect', 'Survey database · ' + (summary ? fmtN(Number(summary.totals?.total) || 0) : '…') + ' entries') +
    rcFilterPanel(f, opts, news) +
    rcSummaryCards(summary) +
    `<div class="rc-tabs" style="display:flex;gap:0;margin-bottom:12px;border:1px solid var(--brd);border-radius:var(--r-sm);overflow:hidden">
      ${tabBtn('list', 'Reader List', '📋')}
      ${tabBtn('messages', 'Messages', '💬')}
    </div>` +
    (tab === 'list'     ? rcListTab(readers, S.live._rcRdrLoad) : '') +
    (tab === 'messages' ? rcMessagesTab(templates, history) : '');
};

/* --- Interactive window handlers --- */

window.rcSetTab = (tab) => {
  S.live.rcTab = tab;
  render();
  if (tab === 'map') setTimeout(rcInitMap, 40);
};

window.rcApplyFilters = () => {
  const f = {};
  const fv = document.getElementById('rc-from')?.value;
  const tv = document.getElementById('rc-to')?.value;
  if (fv) f.from = fv; if (tv) f.to = tv;
  f.state_name    = document.getElementById('rc-state')?.value || '';
  f.unit_code     = document.getElementById('rc-unit')?.value  || '';
  f.locality_code = document.getElementById('rc-loc')?.value   || '';
  f.unprod_reasons = [...document.querySelectorAll('.rc-status-chk:checked')].map(el => el.value);
  f.newspapers     = [...document.querySelectorAll('.rc-news-filter-chk:checked')].map(el => el.value);
  S.live.rcNwOpen  = false;
  S.live.rcFilters = f;
  S.live.rcSummary = null; S.live.rcMarkers = null; S.live.rcReaders = null;
  S.live._rcSumLoad = S.live._rcMkLoad = S.live._rcRdrLoad = false;
  rcFetchNewspapers(true);   // refresh dropdown counts for the new filter range
  render();   // bootstrap in VIEWS.readers_connect schedules each fetch exactly once
};

window.rcClearFilters = () => {
  S.live.rcNwOpen = false;
  S.live.rcFilters = rcMonthDefault();   // reset to current month, not all-time
  S.live.rcSummary = null; S.live.rcMarkers = null; S.live.rcReaders = null;
  S.live.rcFilterOpts = null; S.live._rcFOLoading = S.live._rcSumLoad = S.live._rcMkLoad = S.live._rcRdrLoad = false;
  rcFetchNewspapers(true);   // refresh dropdown counts for the reset range
  render();   // bootstrap schedules all fetches
};

/* Persist filter inputs that live only in the DOM (dates, status chips) so a
   cascade re-render doesn't wipe them before the user presses Apply */
function rcCaptureDomFilters() {
  if (!S.live.rcFilters) S.live.rcFilters = {};
  const f = S.live.rcFilters;
  const fromEl = document.getElementById('rc-from'), toEl = document.getElementById('rc-to');
  if (fromEl) f.from = fromEl.value || '';
  if (toEl)   f.to   = toEl.value   || '';
  const chks = document.querySelectorAll('.rc-status-chk');
  if (chks.length) f.unprod_reasons = [...document.querySelectorAll('.rc-status-chk:checked')].map(el => el.value);
  const nwChks = document.querySelectorAll('.rc-news-filter-chk');
  if (nwChks.length) f.newspapers = [...document.querySelectorAll('.rc-news-filter-chk:checked')].map(el => el.value);
}

// Immediately refresh the map + lists for the current geo selection (no "Apply" click needed),
// so selecting a State / Unit / Locality zooms the map straight to that area.
function rcApplyGeo() {
  S.live.rcSummary = null; S.live.rcMarkers = null; S.live.rcReaders = null;
  S.live._rcSumLoad = S.live._rcMkLoad = S.live._rcRdrLoad = false;
  render();   // VIEWS.readers_connect bootstrap re-fetches markers → rcLoadMapMarkers fitBounds → zoom
}

window.rcCascadeState = () => {
  rcCaptureDomFilters();
  S.live.rcFilters.state_name = document.getElementById('rc-state')?.value || '';
  S.live.rcFilters.unit_code = '';
  S.live.rcFilters.locality_code = '';
  // Filter units locally — no API call needed (units already loaded with state field)
  const state = S.live.rcFilters.state_name;
  const allUnits = S.live.rcFilterOpts?.allUnits || S.live.rcFilterOpts?.units || [];
  if (S.live.rcFilterOpts) {
    S.live.rcFilterOpts.units      = state ? allUnits.filter(u => u.state === state) : allUnits;
    S.live.rcFilterOpts.localities = [];
    // newspapers list is global — keep it for the map dropdown
  }
  rcApplyGeo();   // zoom the map to the selected state immediately
};

window.rcCascadeUnit = () => {
  rcCaptureDomFilters();
  S.live.rcFilters.unit_code = document.getElementById('rc-unit')?.value || '';
  S.live.rcFilters.locality_code = '';
  const unitCode = S.live.rcFilters.unit_code;
  if (unitCode) {
    // Fetch localities for the selected unit; preserve allUnits and state-filtered units
    api.get('/api/readers/filters?unit_code=' + encodeURIComponent(unitCode)).then(d => {
      if (d && S.live.rcFilterOpts) {
        const allUnits  = S.live.rcFilterOpts.allUnits;
        const curUnits  = S.live.rcFilterOpts.units;
        S.live.rcFilterOpts = { ...d, allUnits, units: curUnits };
        if (S.screen === 'readers_connect') render();
      }
    });
  } else if (S.live.rcFilterOpts) {
    // Unit cleared — clear localities; keep unit list and global newspaper list as-is
    S.live.rcFilterOpts.localities = [];
  }
  rcApplyGeo();   // zoom the map to the selected unit immediately
};

window.rcCascadeLocality = () => {
  rcCaptureDomFilters();
  S.live.rcFilters.locality_code = document.getElementById('rc-loc')?.value || '';
  rcApplyGeo();   // zoom the map to the selected locality immediately
};

window.rcRefreshMap = () => {
  S.live.rcMarkers = null; S.live._rcMkLoad = false;
  if (S.screen === 'survey_dash') S.live.rcFilters = { from: S.live.sdvFrom || '', to: S.live.sdvTo || '', state_name: S.live.sdvState || '', unit_code: S.live.sdvUnit || '', locality_code: S.live.sdvLocality || '' };
  rcFetchMarkers();
};

/* Newspaper multi-select dropdown in the filter panel */
window.rcNwToggleOpen = (ev) => {
  ev.stopPropagation();
  rcCaptureDomFilters();
  S.live.rcNwOpen = !S.live.rcNwOpen;
  if (S.live.rcNwOpen) {
    const btn = document.getElementById('rc-nw-btn');
    if (btn) {
      const r = btn.getBoundingClientRect();
      S.live.rcNwPos = { top: r.bottom + 4, right: window.innerWidth - r.right };
    }
  }
  render();
};
window.rcNwCount = () => {
  // Update button label live as boxes are ticked (no re-render → panel stays open)
  const n = document.querySelectorAll('.rc-news-filter-chk:checked').length;
  const b = document.getElementById('rc-nw-btn');
  if (b) b.innerHTML = '🗞️ ' + (n ? n + ' selected' : 'All Newspapers') + ' ▾';
};

/* Newspaper toggle buttons on the map card — click to select/deselect, empty = All */
window.rcNwToggle = (name) => {
  rcCaptureDomFilters();   // keep dates/status chips through the re-render
  let sel = S.live.rcFilters.newspapers || [];
  if (!name) sel = [];
  else if (sel.includes(name)) sel = sel.filter(n => n !== name);
  else sel = [...sel, name];
  S.live.rcFilters.newspapers = sel;
  // Map markers are filtered client-side in rcLoadMapMarkers — no re-fetch, no freeze.
  // Only the reader list needs a server round-trip (it's paginated and shows names).
  S.live.rcReaders = null;
  S.live._rcRdrLoad = false;
  render();
};

window.rcToggleAll = (checked) => { document.querySelectorAll('.rc-sel-chk').forEach(el => el.checked = checked); };

const RC_CALL_OUTCOMES = {
  INTERESTED:    '✅ Interested in Subscription',
  NOT_INTERESTED:'❌ Not Interested',
  NO_ANSWER:     '📵 No Answer / Phone Off',
  CALL_BACK:     '🔄 Will Call Back',
  CONVERTED:     '🎉 Converted to Subscriber',
  WRONG_NUMBER:  '⚠️ Wrong Number',
};

window.rcViewReader = (r_id) => {
  if (!r_id) return;
  if (_rcMap) try { _rcMap.closePopup(); } catch (_) {}

  Promise.all([
    api.get('/api/readers/reader/' + encodeURIComponent(r_id)),
    api.get('/api/readers/call-log/' + encodeURIComponent(r_id)),
  ]).then(([d, callData]) => {
    if (!d) { toast('Reader not found'); return; }
    const hl = S.user?.hierarchyLevel || 9;
    const stateName   = RC_STATE_NAMES[d.state_name] || d.state_name || '—';
    const statusLabel = RC_STATUS_LABELS[d.unprod_reason] || d.unprod_reason || '—';
    const statusType  = d.unprod_reason === 'NEW' ? 'good' : d.unprod_reason === 'RP_READER' ? 'mut' : d.unprod_reason === 'NOT_INTERESTED' ? 'crit' : 'warn';

    const localityDisplay = d.locality_name || (d.locality_code ? 'Zone ' + d.locality_code : '');
    const addrParts = [];
    if (d.house_no) addrParts.push('H.No. ' + d.house_no);
    if (d.r_block_street && d.r_block_street !== '.') addrParts.push(d.r_block_street);
    if (localityDisplay) addrParts.push(localityDisplay);
    if (d.pin) addrParts.push('PIN ' + d.pin);
    const addrHTML = addrParts.length
      ? `<tr><td style="color:var(--muted);padding:3px 0;vertical-align:top">Address</td><td style="line-height:1.6">${addrParts.map(esc).join(', ')}</td></tr>` : '';
    const canContact = hl <= 4 && d.mobile;
    const contactHTML = hl <= 4 ? `
      ${d.mobile ? `<tr><td style="color:var(--muted);padding:3px 0">Mobile</td><td>📱 ${esc(d.mobile)}${d.alternate_mobile ? `  &nbsp;📱 ${esc(d.alternate_mobile)}` : ''}</td></tr>` : ''}
      ${d.email  ? `<tr><td style="color:var(--muted);padding:3px 0">Email</td><td>✉️ ${esc(d.email)}</td></tr>` : ''}` : '';

    // Call history
    const logs = callData?.logs || [];
    const historyHTML = logs.length ? `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--brd)">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Call History</div>
        ${logs.map(l => `<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--brd)">
          <span style="font-size:11px;color:var(--muted);white-space:nowrap;min-width:80px;padding-top:2px">${esc((l.called_at||'').slice(0,10))}</span>
          <div style="flex:1">
            <span style="font-size:12px;font-weight:600">${esc(RC_CALL_OUTCOMES[l.outcome] || l.outcome)}</span>
            ${l.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:1px">${esc(l.notes)}</div>` : ''}
            ${l.follow_up_date ? `<div style="font-size:11px;color:var(--muted)">Follow-up: ${esc(l.follow_up_date)}</div>` : ''}
            ${l.called_by ? `<div style="font-size:10px;color:var(--muted)">by ${esc(l.called_by)}</div>` : ''}
          </div>
        </div>`).join('')}
      </div>` : '';

    const inp = s => `style="width:100%;padding:7px 9px;border:1px solid var(--brd);border-radius:6px;font-size:13px;background:var(--surf2);color:var(--ink);box-sizing:border-box;${s||''}"`;
    const m = modal(`<div style="font-size:13px;line-height:1.7;width:min(460px,90vw)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:15px">${esc(d.r_name || '—')}</h3>
        ${chip(statusType, esc(statusLabel))}
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:var(--muted);padding:3px 0;width:110px">Reader ID</td><td>${esc(d.r_id || '—')}</td></tr>
        <tr><td style="color:var(--muted);padding:3px 0">Gender</td><td>${esc(d.gender || '—')}</td></tr>
        <tr><td style="color:var(--muted);padding:3px 0">Edition</td><td>${esc(d.unit_name || d.unit_code || '—')}</td></tr>
        <tr><td style="color:var(--muted);padding:3px 0">State</td><td>${esc(stateName)}</td></tr>
        ${d.newspaper_name ? `<tr><td style="color:var(--muted);padding:3px 0">Reads</td><td>${esc(rcNewsLabel(d.newspaper_name))}</td></tr>` : ''}
        ${addrHTML}${contactHTML}
        <tr><td style="color:var(--muted);padding:3px 0">Survey Date</td><td>${esc(d.bookdate || '—')}</td></tr>
        ${d.followup_date ? `<tr><td style="color:var(--muted);padding:3px 0">Follow-up</td><td>${esc(d.followup_date)}</td></tr>` : ''}
        ${d.lat && d.lng ? `<tr><td style="color:var(--muted);padding:3px 0">GPS</td><td style="font-size:11px">${d.lat}, ${d.lng}</td></tr>` : ''}
      </table>

      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        ${canContact ? `<button class="btn good sm" id="rc-wa-btn">📱 WhatsApp</button>
          <button class="btn sm" id="rc-sms-btn">📩 SMS</button>
          <button class="btn sm" id="rc-call-btn" style="background:#1C2B45;color:#fff;border-color:#1C2B45">📞 Call</button>` : ''}
        <button class="btn block sm" onclick="closeModals()">Close</button>
      </div>

      <!-- Call log form — shown after clicking Call -->
      <div id="rc-call-form" style="display:none;margin-top:16px;padding:14px;background:var(--surf2);border-radius:8px;border:1px solid var(--brd)">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📋 Log This Call</div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <select id="rc-outcome" ${inp()}>
            <option value="">— Select outcome —</option>
            <option value="INTERESTED">✅ Interested in Subscription</option>
            <option value="NOT_INTERESTED">❌ Not Interested</option>
            <option value="NO_ANSWER">📵 No Answer / Phone Off</option>
            <option value="CALL_BACK">🔄 Will Call Back</option>
            <option value="CONVERTED">🎉 Converted to Subscriber</option>
            <option value="WRONG_NUMBER">⚠️ Wrong Number</option>
          </select>
          <textarea id="rc-notes" placeholder="Conversation notes…" ${inp('resize:vertical;min-height:64px;font-family:inherit')}></textarea>
          <div id="rc-fu-row" style="display:none;align-items:center;gap:8px">
            <label style="font-size:12px;color:var(--muted);white-space:nowrap">Follow-up date</label>
            <input type="date" id="rc-fu-date" ${inp('flex:1')}>
          </div>
          <button class="btn pri" id="rc-save-call" style="width:100%">Save Call Log</button>
        </div>
      </div>

      ${historyHTML}
    </div>`);

    // Wire buttons
    const waBtn   = m.querySelector('#rc-wa-btn');
    const smsBtn  = m.querySelector('#rc-sms-btn');
    const callBtn = m.querySelector('#rc-call-btn');
    const callForm = m.querySelector('#rc-call-form');
    const outcomeEl = m.querySelector('#rc-outcome');
    const fuRow   = m.querySelector('#rc-fu-row');
    const saveBtn = m.querySelector('#rc-save-call');

    if (waBtn)   waBtn.onclick  = () => { closeModals(); rcOpenSendModal([d], 'wa'); };
    if (smsBtn)  smsBtn.onclick = () => { closeModals(); rcOpenSendModal([d], 'sms'); };
    if (callBtn) callBtn.onclick = () => {
      if (d.mobile) window.open('tel:' + String(d.mobile).replace(/\D/g, ''), '_self');
      if (callForm) {
        callForm.style.display = 'block';
        setTimeout(() => callForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
      }
    };
    if (outcomeEl) outcomeEl.onchange = () => {
      if (fuRow) fuRow.style.display = ['INTERESTED', 'CALL_BACK'].includes(outcomeEl.value) ? 'flex' : 'none';
    };
    if (saveBtn) saveBtn.onclick = async () => {
      const outcome = outcomeEl?.value;
      if (!outcome) { toast('Please select a call outcome'); return; }
      const notes  = m.querySelector('#rc-notes')?.value?.trim() || '';
      const fuDate = m.querySelector('#rc-fu-date')?.value || '';
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      const result = await api.post('/api/readers/call-log', {
        r_id: d.r_id, unit_code: d.unit_code, outcome, notes, follow_up_date: fuDate || null,
      });
      if (result?.ok) { toast('Call logged ✓'); closeModals(); }
      else { toast('Failed to save — try again'); saveBtn.disabled = false; saveBtn.textContent = 'Save Call Log'; }
    };
  });
};

window.rcSendOneBtn = (btn) => {
  const r = JSON.parse(btn.dataset.r);
  rcOpenSendModal([r], 'wa');
};

window.rcBulkSend = () => {
  const checked = [...document.querySelectorAll('.rc-sel-chk:checked')];
  if (!checked.length) { toast('Select at least one reader first'); return; }
  const readers = checked.map(el => JSON.parse(el.dataset.r));
  rcOpenSendModal(readers, 'wa');
};

function rcOpenSendModal(readers, defaultType) {
  S.live.rcBulkReaders = readers;
  const tpl = S.live.rcTemplates || [];
  const typeOpts = [['wa','📱 WhatsApp'],['sms','📩 SMS']].map(([v, l]) =>
    `<option value="${v}" ${v === defaultType ? 'selected' : ''}>${l}</option>`).join('');
  const tmplOpts = tpl.length
    ? tpl.map(t => `<option value="${t.id}" data-body="${esc(t.template_body)}">[${t.template_type.toUpperCase()}] ${esc(t.template_name)}</option>`).join('')
    : '<option value="">No templates saved</option>';
  const m = modal(`
    <h3 style="margin-top:0;font-size:15px">Send Message — ${readers.length} reader${readers.length !== 1 ? 's' : ''}</h3>
    <div class="fld"><label>Channel</label><select id="rc-send-type">${typeOpts}</select></div>
    <div class="fld"><label>Template (optional)</label>
      <select id="rc-send-tmpl" onchange="window.rcFillTemplate(this)">
        <option value="">— Custom message —</option>${tmplOpts}
      </select></div>
    <div class="fld"><label>Message body</label>
      <textarea id="rc-send-body" rows="5" placeholder="Type message or pick a template above…&#10;Use {ReaderName}, {Locality}, {UnitName}, {SchemeName}, {Date}" style="resize:vertical"></textarea></div>
    <div class="fld"><label>Preview (first reader: ${esc(readers[0]?.r_name || '—')})</label>
      <div id="rc-send-preview" style="background:var(--surf2);padding:10px;border-radius:6px;font-size:13px;min-height:38px;white-space:pre-wrap;color:var(--ink)"></div></div>
    <div style="display:flex;gap:9px;margin-top:14px">
      <button class="btn pri" id="rc-preview-btn">Preview &amp; Confirm →</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
  const bodyEl = m.querySelector('#rc-send-body');
  if (bodyEl) bodyEl.addEventListener('input', () => window.rcUpdatePreview());
  m.querySelector('#rc-preview-btn').onclick = () => {
    const body = bodyEl?.value.trim();
    const type = m.querySelector('#rc-send-type')?.value || 'wa';
    const tmplId = m.querySelector('#rc-send-tmpl')?.value || '';
    if (!body) { toast('Enter a message'); return; }
    window.rcConfirmSend(readers, body, type, tmplId);
  };
}

window.rcFillTemplate = (sel) => {
  const body = sel.options[sel.selectedIndex]?.getAttribute('data-body') || '';
  const bodyEl = document.getElementById('rc-send-body');
  if (bodyEl) { bodyEl.value = body; window.rcUpdatePreview(); }
};

window.rcUpdatePreview = () => {
  const body = document.getElementById('rc-send-body')?.value || '';
  const r = (S.live.rcBulkReaders || [])[0] || {};
  const preview = body
    .replace(/\{ReaderName\}/g, r.r_name || 'Reader')
    .replace(/\{Locality\}/g, String(r.locality_code || ''))
    .replace(/\{UnitName\}/g, r.unit_name || r.unit_code || '')
    .replace(/\{SchemeName\}/g, r.scheme_name || '')
    .replace(/\{Date\}/g, new Date().toLocaleDateString('en-IN'));
  const el = document.getElementById('rc-send-preview');
  if (el) el.textContent = preview;
};

window.rcConfirmSend = (readers, body, type, tmplId) => {
  closeModals();
  const sample = readers[0] || {};
  const preview = body
    .replace(/\{ReaderName\}/g, sample.r_name || 'Reader')
    .replace(/\{Locality\}/g, String(sample.locality_code || ''))
    .replace(/\{UnitName\}/g, sample.unit_name || sample.unit_code || '')
    .replace(/\{SchemeName\}/g, sample.scheme_name || '')
    .replace(/\{Date\}/g, new Date().toLocaleDateString('en-IN'));
  const m = modal(`
    <h3 style="margin-top:0;font-size:15px">Confirm ${type === 'wa' ? 'WhatsApp' : 'SMS'} Send</h3>
    <div style="margin-bottom:12px">${chip('warn', '⚠️ Sending to ' + readers.length + ' reader' + (readers.length !== 1 ? 's' : ''))}</div>
    <div class="fld"><label>Preview for: ${esc(sample.r_name || 'first reader')}</label>
      <div style="background:var(--surf2);padding:10px;border-radius:6px;font-size:13px;white-space:pre-wrap">${esc(preview)}</div></div>
    <div style="font-size:12px;color:var(--muted);margin:8px 0">Channel: <b>${type === 'wa' ? '📱 WhatsApp' : '📩 SMS'}</b> · Recipients: <b>${readers.length}</b></div>
    <div style="display:flex;gap:9px;margin-top:14px">
      <button class="btn good"
        data-rs="${esc(JSON.stringify(readers))}"
        data-type="${esc(type)}"
        data-tmpl="${esc(tmplId || '')}"
        data-body="${esc(body)}"
        onclick="window.rcExecuteSend(this)">Confirm &amp; Send ✓</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window.rcExecuteSend = async (btn) => {
  const rs = JSON.parse(btn.dataset.rs);
  const body = btn.dataset.body;
  const type = btn.dataset.type;
  const tmplId = btn.dataset.tmpl || null;
  closeModals();
  toast('Sending ' + rs.length + ' message' + (rs.length !== 1 ? 's' : '') + '…');
  const result = await api.post('/api/readers/send-message', {
    readers: rs, msg_type: type, template_id: tmplId || null,
    message_body: body, sent_by: S.user?.name || ''
  });
  if (result?.ok) {
    toast(result.sent + ' message' + (result.sent !== 1 ? 's' : '') + ' queued ✓');
    S.live.rcHistory = null; S.live._rcHistLoad = false;
    if (S.live.rcTab === 'messages') rcFetchHistory(1);
  } else {
    toast('Send failed — check server connection');
  }
};

window.rcNewTemplate = () => {
  formModal('New Message Template', '', [
    { label: 'Type', k: 'template_type', type: 'select', opts: ['wa', 'sms'], val: 'wa' },
    { label: 'Template Name', k: 'template_name', ph: 'e.g. Welcome Offer', val: '' },
    { label: 'Message Body (use {ReaderName}, {Locality} etc.)', k: 'template_body', type: 'textarea', ph: 'Dear {ReaderName}, …', val: '' },
    { label: 'WhatsApp Template ID (from Meta Business Manager)', k: 'wa_template_id', ph: 'Optional', val: '' },
    { label: 'SMS DLT Template ID', k: 'sms_dlt_id', ph: 'Optional', val: '' },
    { label: 'SMS Sender ID', k: 'sms_sender_id', ph: 'e.g. PATRIK', val: '' },
  ], 'Save Template', async (vals) => {
    if (!vals.template_name || !vals.template_body) { toast('Name and body required'); return false; }
    const r = await api.post('/api/readers/templates', vals);
    if (r?.ok) { toast('Template saved ✓'); S.live.rcTemplates = null; rcFetchTemplates(); }
    else toast('Save failed');
  });
};

window.rcEditTemplate = (id) => {
  const t = (S.live.rcTemplates || []).find(x => x.id === id);
  if (!t) return;
  formModal('Edit Template — ' + t.template_name, '', [
    { label: 'Type', k: 'template_type', type: 'select', opts: ['wa', 'sms'], val: t.template_type },
    { label: 'Template Name', k: 'template_name', val: t.template_name },
    { label: 'Message Body', k: 'template_body', type: 'textarea', val: t.template_body },
    { label: 'WhatsApp Template ID', k: 'wa_template_id', ph: 'Optional', val: t.wa_template_id || '' },
    { label: 'SMS DLT Template ID', k: 'sms_dlt_id', ph: 'Optional', val: t.sms_dlt_id || '' },
    { label: 'SMS Sender ID', k: 'sms_sender_id', ph: '', val: t.sms_sender_id || '' },
  ], 'Update Template', async (vals) => {
    const r = await api.post('/api/readers/templates', { id, ...vals });
    if (r?.ok) { toast('Template updated ✓'); S.live.rcTemplates = null; rcFetchTemplates(); }
    else toast('Update failed');
  });
};

window.rcDelTemplate = async (id) => {
  if (!confirm('Delete this template?')) return;
  try {
    const r = await fetch(api.base + '/api/readers/templates/' + id, { method: 'DELETE', headers: api.h() });
    if (r.ok) { toast('Deleted ✓'); S.live.rcTemplates = null; rcFetchTemplates(); }
    else toast('Delete failed');
  } catch { toast('Delete failed'); }
};

/* ═══════════ Survey Intelligence Dashboard (sdv) ═══════════ */

function sdvQS(path) {
  const p = [];
  if (S.live.sdvFrom)       p.push('from='         + S.live.sdvFrom);
  if (S.live.sdvTo)         p.push('to='           + S.live.sdvTo);
  if (S.live.sdvState)      p.push('state_name='   + encodeURIComponent(S.live.sdvState));
  if (S.live.sdvUnit)       p.push('unit_code='    + encodeURIComponent(S.live.sdvUnit));
  if (S.live.sdvLocality)   p.push('locality_code='+ encodeURIComponent(S.live.sdvLocality));
  if (S.live.sdvSupervisor) p.push('tl_id='        + encodeURIComponent(S.live.sdvSupervisor));
  if (S.live.sdvSurveyor)   p.push('created_by='   + encodeURIComponent(S.live.sdvSurveyor));
  const qs = p.join('&');
  return qs ? (path + (path.includes('?') ? '&' : '?') + qs) : path;
}
function sdvClearCache() {
  const keep = ['dbUsers', 'sdvFilters', 'sdvState', 'sdvUnit', 'sdvLocality',
                'sdvSupervisor', 'sdvSurveyor', 'sdvFrom', 'sdvTo', 'sdvTab', 'sdvReport'];
  const fresh = {};
  keep.forEach(k => { if (S.live[k] !== undefined) fresh[k] = S.live[k]; });
  S.live = fresh;
  // Reset area drill-down on every filter change
  S.live.sdvDrillUnit     = null;
  S.live.sdvDrillUnitName = null;
  S.live.sdvByLocality    = null;
}
let _sdvFltSeq = 0;
function sdvFetchFiltersNow() {
  // Builds filter URL with current unit to get cascading locality/supervisor/surveyor options.
  // NOTE: state_name is deliberately NOT sent — units are filtered client-side, and a
  // state-scoped supervisor/surveyor GROUP BY on the server takes 10+ seconds.
  const seq = ++_sdvFltSeq;
  S.live._sdvFltLoading = true;
  const qs = S.live.sdvUnit ? '?unit_code=' + encodeURIComponent(S.live.sdvUnit) : '';
  return api.get('/api/readers/filters' + qs).then(d => {
    if (seq !== _sdvFltSeq) return;   // a newer request superseded this one — discard
    S.live.sdvFilters = d;
    S.live._sdvFltLoading = false;
    if (S.screen === 'survey_dash') render();
  }).catch(() => { if (seq === _sdvFltSeq) S.live._sdvFltLoading = false; });
}
async function sdvFetchFilters() {
  await sdvFetchFiltersNow();
}
async function sdvFetchKpis() {
  const url = sdvQS('/api/survey/kpis');
  S.live._sdvKpisLoad = true;
  const d = await api.get(url);
  if (url !== sdvQS('/api/survey/kpis')) return;   // filters changed mid-flight — discard
  S.live.sdvKpis = d; S.live._sdvKpisLoad = false;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchByUnit() {
  const url = sdvQS('/api/survey/by-unit');
  S.live._sdvByUnitLoad = true;
  const d = await api.get(url);
  if (url !== sdvQS('/api/survey/by-unit')) return;
  S.live.sdvByUnit = d;
  S.live._sdvByUnitLoad = false;
  if (S.screen === 'survey_dash') render();
}

async function sdvFetchByLocality() {
  S.live._sdvLocLoading = true;
  let url = sdvQS('/api/survey/by-locality');
  // If the user drilled into a unit that isn't already in the global filter, add it
  if (S.live.sdvDrillUnit && !S.live.sdvUnit) {
    url += (url.includes('?') ? '&' : '?') + 'unit_code=' + encodeURIComponent(S.live.sdvDrillUnit);
  }
  const d = await api.get(url);
  S.live.sdvByLocality = d;
  S.live._sdvLocLoading = false;
  if (S.screen === 'survey_dash') render();
}

window.sdvDrillArea = (unitCode, unitName) => {
  S.live.sdvDrillUnit     = unitCode;
  S.live.sdvDrillUnitName = unitName;
  S.live.sdvByLocality    = null;
  S.live._sdvLocLoading   = false;
  setTimeout(sdvFetchByLocality, 0);
  render();
  const m = $('.main'); if (m) m.scrollTop = 0;
};
async function sdvFetchStaff() {
  const d = await api.get(sdvQS('/api/survey/staff'));
  S.live.sdvStaff = d;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchTeams() {
  const url = sdvQS('/api/survey/teams');
  S.live._sdvTeamsLoad = true;
  const d = await api.get(url);
  if (url !== sdvQS('/api/survey/teams')) return;
  S.live.sdvTeams = d;
  S.live._sdvTeamsLoad = false;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchDaily() {
  const url = sdvQS('/api/survey/daily');
  S.live._sdvDailyLoad = true;
  const d = await api.get(url);
  if (url !== sdvQS('/api/survey/daily')) return;
  S.live.sdvDaily = d;
  S.live._sdvDailyLoad = false;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchFollowups() {
  const base = sdvQS('/api/survey/followups');
  const url = base + (base.includes('?') ? '&' : '?') + 'page=' + (S.live.sdvFuPage || 1);
  S.live._sdvFuLoad = true;
  const d = await api.get(url);
  if (sdvQS('/api/survey/followups') !== base) return;
  S.live.sdvFollowups = d;
  S.live._sdvFuLoad = false;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchOrders() {
  const base = sdvQS('/api/survey/orders');
  const url = base + (base.includes('?') ? '&' : '?') + 'page=' + (S.live.sdvOrdPage || 1);
  S.live._sdvOrdLoad = true;
  const d = await api.get(url);
  if (sdvQS('/api/survey/orders') !== base) return;
  S.live.sdvOrders = d;
  S.live._sdvOrdLoad = false;
  if (S.screen === 'survey_dash') render();
}
async function sdvFetchReaders() {
  const url = sdvQS('/api/survey/readers');
  S.live._sdvRdrsLoad = true;
  const d = await api.get(url);
  if (url !== sdvQS('/api/survey/readers')) return;
  S.live.sdvReaders = d;
  S.live._sdvRdrsLoad = false;
  if (S.screen === 'survey_dash') render();
}

/* --- sdv sub-tab renderers --- */

function sdvSummaryTab() {
  const d = S.live.sdvKpis;
  const daily = S.live.sdvDaily;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">${S.live._sdvKpisLoad ? 'Loading KPIs…' : 'No data'}</p></div>`;
  const br = d.by_reason || {};
  const total = d.total || 1;
  const newCnt = br.NEW || 0;
  const rpReader = br.RP_READER || 0;
  const notInt = br.NOT_INTERESTED || 0;
  const followUp = br.FOLLOW_UP || 0;
  const ordCnt = d.order_count || 0;
  const productive = newCnt + rpReader + followUp + (br.REPLACE || 0);
  const convPct = (newCnt / total * 100).toFixed(1);
  const prodPct = (productive / total * 100).toFixed(1);

  let trendHtml = '<div class="card" style="margin-bottom:12px"><p class="muted" style="padding:12px;text-align:center;font-size:12px">Loading trend…</p></div>';
  if (daily && daily.days && daily.days.length) {
    const days = daily.days;
    const maxT = Math.max(...days.map(x => x.total), 1);
    const BAR_H = 80;
    const bars = days.map(x => {
      const h = Math.max(2, Math.round(x.total / maxT * BAR_H));
      const tot = x.total || 1;
      const gH = Math.round(x.new_cnt / tot * h);
      const bH = Math.round(x.rp_reader / tot * h);
      const yH = Math.round(x.follow_up / tot * h);
      const mH = Math.max(0, h - gH - bH - yH);
      return `<div class="sdv-bar-col" title="${x.day}&#10;Total: ${fmtN(x.total)}&#10;New: ${fmtN(x.new_cnt)}&#10;RP Reader: ${fmtN(x.rp_reader)}&#10;Follow-up: ${fmtN(x.follow_up)}">
        <div class="sdv-bar" style="height:${h}px">
          <div style="height:${gH}px;background:var(--grn)"></div>
          <div style="height:${bH}px;background:var(--blue)"></div>
          <div style="height:${yH}px;background:var(--gold)"></div>
          <div style="height:${mH}px;background:var(--muted)"></div>
        </div>
        <div class="sdv-day-lbl">${x.day.slice(5)}</div>
      </div>`;
    }).join('');
    trendHtml = `<div class="vz-sec" style="margin-bottom:16px">
      <div class="lbl" style="margin-bottom:10px">Daily Survey Activity · ${days.length} days</div>
      <div class="sdv-trend">${bars}</div>
      <div class="sdv-legend">
        <span><span class="sdv-dot" style="background:var(--grn)"></span>New Subscription</span>
        <span><span class="sdv-dot" style="background:var(--blue)"></span>Existing Reader</span>
        <span><span class="sdv-dot" style="background:var(--gold)"></span>Follow-up</span>
        <span><span class="sdv-dot" style="background:var(--muted)"></span>Not Interested</span>
      </div>
    </div>`;
  }

  return `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon:"📋", label:"Total Surveys",     value:fmtN(total), sub:d.areas+' areas · '+d.surveyors+' surveyors', status:"fl" })}
    ${vzKpi({ icon:"⭐", label:"New Subscriptions", value:fmtN(newCnt), sub:convPct+"% conversion", status:"up" })}
    ${vzKpi({ icon:"📰", label:"Existing Readers",  value:fmtN(rpReader), sub:(rpReader/total*100).toFixed(1)+"% of total", status:"fl" })}
    ${vzKpi({ icon:"📅", label:"Follow-up Needed",  value:fmtN(followUp), sub:d.followup_pending+" pending today", status:d.followup_pending>0?"dn":"fl" })}
    ${vzKpi({ icon:"✖",  label:"Not Interested",    value:fmtN(notInt), sub:(notInt/total*100).toFixed(1)+"% of total", status:"dn" })}
    ${vzKpi({ icon:"✔",  label:"Productive Rate",   value:prodPct+"%", sub:fmtN(productive)+" productive visits", status:"up" })}
    ${vzKpi({ icon:"📦", label:"Orders Booked",     value:fmtN(ordCnt), sub:(ordCnt/Math.max(newCnt,1)*100).toFixed(1)+"% of new subs", status:ordCnt>0?"up":"fl" })}
  </div>${trendHtml}`;
}

function sdvAreaTab() {
  // ── Drill-down: locality detail for a clicked unit ────────────────────────
  if (S.live.sdvDrillUnit) {
    const loc     = S.live.sdvByLocality;
    const loading = S.live._sdvLocLoading;
    const backBtn = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <button class="btn sm" onclick="S.live.sdvDrillUnit=null;S.live.sdvDrillUnitName=null;S.live.sdvByLocality=null;render()">← All Units</button>
      <span style="font-weight:700;font-size:14px">${esc(S.live.sdvDrillUnitName || S.live.sdvDrillUnit)}</span>
      <span style="font-size:12px;color:var(--muted)">— Area (Locality) wise detail</span>
    </div>`;
    if (!loc && !loading) setTimeout(sdvFetchByLocality, 0);
    if (loading || !loc) {
      return backBtn + `<div class="card pad" style="text-align:center;padding:32px;color:var(--muted)">Loading area detail…</div>`;
    }
    if (!loc.localities || !loc.localities.length) {
      return backBtn + `<div class="card pad" style="text-align:center;padding:24px;color:var(--muted)">No area data found for this unit.</div>`;
    }
    const rows = loc.localities.map(a => {
      const cls = a.conversion_pct >= 55 ? 'up' : a.conversion_pct >= 40 ? 'fl' : 'dn';
      return `<tr>
        <td><b>${esc(a.locality_name)}</b><small style="display:block;color:var(--muted)">${esc(a.locality_code)}</small></td>
        <td class="r num">${fmtN(a.total)}</td>
        <td class="r num up">${fmtN(a.new_cnt)}</td>
        <td class="r num" style="color:var(--blue)">${fmtN(a.db_readers || 0)}</td>
        <td class="r num fl">${fmtN(a.rp_reader)}</td>
        <td class="r num">${fmtN(a.follow_up)}</td>
        <td class="r num dn">${fmtN(a.not_interested)}</td>
        <td class="r num ${cls}">${a.conversion_pct}%</td>
      </tr>`;
    }).join('');
    return backBtn + table(["Area (Locality)", ">Total", ">New Sub", ">DB Readers", ">RP Reader", ">Follow-up", ">Not Interested", ">Conv%"], [rows]);
  }

  // ── Default: unit list, each row clickable to drill into localities ────────
  const d = S.live.sdvByUnit;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">Loading area data…</p></div>`;
  if (!d.units || !d.units.length) return `<div class="card"><p class="muted" style="padding:16px">No area data for selected filters.</p></div>`;
  const rows = d.units.map(u => {
    const cls = u.conversion_pct >= 55 ? 'up' : u.conversion_pct >= 40 ? 'fl' : 'dn';
    return `<tr class="rowbtn" onclick="sdvDrillArea(${esc(JSON.stringify(u.unit_code))},${esc(JSON.stringify(u.unit_name))})">
      <td><b>${esc(u.unit_name)}</b><small style="display:block;color:var(--muted)">${esc(u.unit_code)}</small></td>
      <td class="r num">${fmtN(u.total)}</td>
      <td class="r num up">${fmtN(u.new_cnt)}</td>
      <td class="r num fl">${fmtN(u.rp_reader)}</td>
      <td class="r num">${fmtN(u.follow_up)}</td>
      <td class="r num dn">${fmtN(u.not_interested)}</td>
      <td class="r num ${cls}">${u.conversion_pct}%</td>
      <td class="r" style="color:var(--acc)">▶</td>
    </tr>`;
  }).join('');
  return table(["Area / Unit", ">Total", ">New Sub", ">RP Reader", ">Follow-up", ">Not Interested", ">Conv%", ""], [rows]);
}

function sdvFunnelTab() {
  const d = S.live.sdvKpis;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">Loading…</p></div>`;
  const br = d.by_reason || {};
  const total = d.total || 1;
  const newCnt   = br.NEW  || 0;
  const rpReader = br.RP_READER || 0;
  const notInt   = br.NOT_INTERESTED || 0;
  const followUp = br.FOLLOW_UP || 0;
  const replCnt  = br.REPLACE || 0;
  const productive = total - notInt;
  const interested = newCnt + followUp;
  const pct = (v, base) => base > 0 ? (v / base * 100).toFixed(1) : '0.0';

  const steps = [
    { label: 'Total Surveys', sub: 'All households visited', value: total,       color: '#1C2B45', w: 100  },
    { label: 'Productive Contact', sub: 'Engaged — not declined', value: productive, color: '#1565C0', w: Math.max(40, pct(productive, total)) },
    { label: 'Interested',  sub: 'New subscription + Follow-up',  value: interested, color: '#00695C', w: Math.max(30, pct(interested, total)) },
    { label: 'New Subscriptions', sub: 'Converted this period',   value: newCnt,     color: '#2E7D32', w: Math.max(20, pct(newCnt, total)) },
  ];

  const funnelHtml = steps.map((s, i) => {
    const dropVal  = i > 0 ? steps[i-1].value - s.value : 0;
    const dropPct  = i > 0 ? pct(dropVal, steps[i-1].value) : '';
    const dropLine = i > 0 ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 0">
      <span style="color:var(--red);font-size:18px;line-height:1">▼</span>
      <span style="font-size:11px;color:var(--muted)">${fmtN(dropVal)} dropped &nbsp;(${dropPct}%)</span>
    </div>` : '';
    return `${dropLine}<div style="
        width:${s.w}%;background:${s.color};color:#fff;
        padding:14px 20px;text-align:center;border-radius:10px;
        box-shadow:0 3px 10px rgba(0,0,0,.18);position:relative">
      <div style="font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.65;margin-bottom:6px">${s.label}</div>
      <div class="num" style="font-size:30px;font-weight:800;letter-spacing:-1px;line-height:1">${fmtN(s.value)}</div>
      <div style="font-size:13px;font-weight:700;margin-top:4px">${pct(s.value, total)}<span style="font-size:11px;font-weight:400;opacity:.7">% of all surveys</span></div>
      <div style="font-size:10px;opacity:.55;margin-top:3px">${s.sub}</div>
    </div>`;
  }).join('');

  const outcomes = [
    { label: 'New Subscription', value: newCnt,   color: '#2E7D32', emoji: '⭐' },
    { label: 'Existing Reader',  value: rpReader,  color: 'var(--blue)', emoji: '📰' },
    { label: 'Follow-up Pending',value: followUp,  color: 'var(--gold)', emoji: '📅' },
    { label: 'Not Interested',   value: notInt,    color: 'var(--red)',  emoji: '✖' },
    { label: 'Replacement',      value: replCnt,   color: 'var(--muted)',emoji: '🔄' },
  ];
  const outMax = Math.max(...outcomes.map(o => o.value), 1);
  const outHtml = outcomes.map(o => {
    const p = pct(o.value, total);
    const bw = (o.value / outMax * 100).toFixed(1);
    return `<div class="sdv-hbar">
      <div style="font-size:12px;display:flex;align-items:center;gap:5px">${o.emoji} <span>${o.label}</span></div>
      <div class="sdv-hbar-track"><div class="sdv-hbar-fill" style="width:${bw}%;background:${o.color}"></div></div>
      <div style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums">
        <b>${fmtN(o.value)}</b> <span class="muted" style="font-size:11px">${p}%</span></div>
    </div>`;
  }).join('');

  return `<div class="card" style="margin-bottom:14px">
    <div class="sdv-sec-head" style="border-left-color:#1C2B45">
      <div class="sdv-sec-title">Conversion Funnel</div>
      <div class="sdv-sec-sub">From first contact to subscription — how many converted at each stage</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:0;padding:8px 0 4px">${funnelHtml}</div>
  </div>
  <div class="card">
    <div class="sdv-sec-head" style="border-left-color:var(--navy)">
      <div class="sdv-sec-title">Outcome Breakdown</div>
      <div class="sdv-sec-sub">All survey outcomes · bars scaled to highest value</div>
    </div>
    ${outHtml}
  </div>`;
}

function sdvReadersTab() {
  const d = S.live.sdvReaders;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">Loading reader profile…</p></div>`;

  // Bar chart: bar width relative to the MAX value so the top item always fills fully
  const hBar = (items, totalCnt, colorFn, highlightFn) => {
    const maxV = Math.max(...items.map(x => x.cnt), 1);
    return items.map((item, i) => {
      const pct  = totalCnt > 0 ? (item.cnt / totalCnt * 100).toFixed(1) : '0.0';
      const barW = (item.cnt / maxV * 100).toFixed(1);
      const hl   = highlightFn ? highlightFn(item) : false;
      return `<div class="sdv-hbar">
        <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${hl ? 'font-weight:700;color:var(--navy)' : ''}">${esc(item.label)}</div>
        <div class="sdv-hbar-track">
          <div class="sdv-hbar-fill" style="width:${barW}%;background:${colorFn(item, i)};${hl ? 'box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)' : ''}"></div>
        </div>
        <div style="text-align:right;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums">
          <b>${fmtN(item.cnt)}</b>&ensp;<span class="muted" style="font-size:11px">${pct}%</span>
        </div>
      </div>`;
    }).join('');
  };

  // Gender
  const gList  = (d.gender || []).map(g => ({ label: g.gender === 'MALE' ? 'Male' : g.gender === 'FEMALE' ? 'Female' : g.gender, cnt: g.cnt }));
  const gTotal = gList.reduce((s, g) => s + g.cnt, 0);
  const genderHtml = hBar(gList, gTotal, g => g.label === 'Female' ? '#7B1FA2' : '#1565C0');

  // Category — only A+/A/B/C
  const catColors = { 'A+': '#F9A825', 'A': '#2E7D32', 'B': '#00695C', 'C': '#1565C0' };
  const allCatTotal = (d.category || []).reduce((s, c) => s + c.cnt, 0);
  const ratedCats   = (d.category || []).filter(c => ['A+', 'A', 'B', 'C'].includes(c.cat));
  const catTotal    = ratedCats.reduce((s, c) => s + c.cnt, 0);
  const catCovPct   = allCatTotal > 0 ? (catTotal / allCatTotal * 100).toFixed(1) : '0';
  const catHtml     = hBar(ratedCats.map(c => ({ label: c.cat, cnt: c.cnt })), catTotal,
                        c => catColors[c.label] || 'var(--navy)');

  // Newspapers
  const nwList    = d.newspapers || [];
  const nwTotal   = nwList.reduce((s, n) => s + n.cnt, 0);
  const nwPalette = ['#C62828','#2E7D32','#1565C0','#F9A825','#00695C','#6A1B9A','#BF360C','#283593','#00838F','#558B2F'];
  const isOurs    = n => /RAJASTHAN PATRIKA|^PATRIKA$/i.test(n.label);
  const nwHtml    = hBar(nwList.map(n => ({ label: n.name, cnt: n.cnt })), nwTotal,
                      (item, i) => isOurs(item) ? '#1C2B45' : nwPalette[i % nwPalette.length],
                      item => isOurs(item));

  const secHead = (icon, title, sub, color) =>
    `<div class="sdv-sec-head" style="border-left-color:${color}">
       <div class="sdv-sec-title">${icon} ${title}</div>
       ${sub ? `<div class="sdv-sec-sub">${sub}</div>` : ''}
     </div>`;

  return `
    <div class="card" style="margin-bottom:14px">
      ${secHead('👤', 'Gender Distribution', `${fmtN(gTotal)} readers surveyed`, '#1565C0')}
      ${genderHtml || '<p class="muted">No data</p>'}
    </div>
    <div class="card" style="margin-bottom:14px">
      ${secHead('🏅', 'Reader Category', `Rated readers: ${fmtN(catTotal)} of ${fmtN(allCatTotal)} (${catCovPct}%) have a category (A+, A, B, C)`, '#F9A825')}
      ${ratedCats.length ? catHtml : '<p class="muted" style="font-size:12px">No rated readers in this selection</p>'}
    </div>
    <div class="card">
      ${secHead('📰', 'Newspaper Market Share', `${fmtN(nwTotal)} readers across surveyed areas · bars scaled to largest · <b>Patrika highlighted</b>`, '#C62828')}
      ${nwHtml || '<p class="muted">No newspaper data available</p>'}
    </div>`;
}

function sdvTeamsTab() {
  const d = S.live.sdvTeams;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">Loading team data…</p></div>`;
  if (!d.teams || !d.teams.length) return `<div class="card"><p class="muted" style="padding:16px">No team data for selected filters. Please select a Unit or State to view team performance.</p></div>`;

  const convCls = p => p >= 50 ? 'up' : p >= 30 ? 'fl' : 'dn';

  return d.teams.map(team => {
    const verPct = team.total > 0 ? Math.round(team.verified / team.total * 100) : 0;
    const teamConvCls = convCls(team.conversion_pct);

    const svrRows = team.surveyors.map(s => {
      const vp = s.total > 0 ? Math.round(s.verified / s.total * 100) : 0;
      return `<tr>
        <td style="padding-left:24px"><span style="font-size:11px">👤</span> ${esc(s.surveyor_name)}</td>
        <td class="r num" style="font-size:12px">${fmtN(s.days_active)}</td>
        <td class="r num" style="font-size:12px">${fmtN(s.total)}</td>
        <td class="r num up" style="font-size:12px">${fmtN(s.new_cnt)}</td>
        <td class="r num" style="font-size:12px">${fmtN(s.rp_reader)}</td>
        <td class="r num" style="font-size:12px">${fmtN(s.follow_up)}</td>
        <td class="r num ${convCls(s.conversion_pct)}" style="font-size:12px">${s.conversion_pct}%</td>
        <td class="r num fl" style="font-size:12px">${vp}%</td>
      </tr>`;
    }).join('');

    return `<div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
      <div style="background:var(--navy);color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <div>
          <span style="font-size:13px;font-weight:700">👥 ${esc(team.supervisor_name)}</span>
          <small style="display:block;opacity:.75;font-size:11px">${esc(team.unit_name)} · ${team.surveyors.length} surveyor${team.surveyors.length !== 1 ? 's' : ''}</small>
        </div>
        <div style="display:flex;gap:16px;font-size:12px">
          <span>Total <b>${fmtN(team.total)}</b></span>
          <span>New <b class="${teamConvCls}">${fmtN(team.new_cnt)}</b></span>
          <span>Conv <b class="${teamConvCls}">${team.conversion_pct}%</b></span>
          <span>Verified <b>${verPct}%</b></span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--surf2);color:var(--muted)">
            <th style="text-align:left;padding:6px 10px 6px 24px">Surveyor Name</th>
            <th style="text-align:right;padding:6px 8px">Days</th>
            <th style="text-align:right;padding:6px 8px">Surveys</th>
            <th style="text-align:right;padding:6px 8px">New</th>
            <th style="text-align:right;padding:6px 8px">RP Reader</th>
            <th style="text-align:right;padding:6px 8px">Follow-up</th>
            <th style="text-align:right;padding:6px 8px">Conv%</th>
            <th style="text-align:right;padding:6px 8px">Verified%</th>
          </tr></thead>
          <tbody>${svrRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function sdvFollowupsTab() {
  const d = S.live.sdvFollowups;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">Loading follow-ups…</p></div>`;
  if (!d.followups || !d.followups.length) return `<div class="card"><p class="muted" style="padding:16px">No follow-ups found.</p></div>`;
  const today = new Date().toISOString().slice(0, 10);
  const rows = d.followups.map(f => {
    const fu = f.followup_date || '';
    const dc = fu < today ? chip('crit', '⚠ Overdue') : fu === today ? chip('warn', '📅 Today') : chip('good', 'Upcoming');
    return `<tr>
      <td><b>${esc(f.r_name || '—')}</b><small style="display:block;color:var(--muted)">${esc(f.mobile || '')}</small></td>
      <td><small>${esc(f.unit_name || '—')}</small></td>
      <td>${dc} <span class="num" style="font-size:12px">${esc(fu)}</span></td>
      <td><small class="muted">${esc(f.survey_date || '—')}</small></td>
      <td><small class="muted" style="font-size:11px">${esc(f.surveyor_name || f.created_by || '—')}</small></td>
    </tr>`;
  }).join('');
  return `<div class="muted" style="font-size:11px;padding:4px 0 8px">${fmtN(d.total)} total follow-ups · page ${d.page || 1}</div>` +
    table(["Reader · Mobile", "Unit", "Follow-up Date", "Survey Date", "Surveyor"], [rows]);
}

function sdvOrdersTab() {
  const d = S.live.sdvOrders;
  if (!d) return `<div class="card"><p class="muted" style="padding:16px;text-align:center">${S.live._sdvOrdLoad ? 'Loading orders…' : 'No data'}</p></div>`;
  if (!d.orders || !d.orders.length) return `<div class="card"><p class="muted" style="padding:16px">No orders found for selected filters.</p></div>`;
  const rows = d.orders.map(o => `<tr>
    <td><b class="num" style="font-family:monospace;font-size:12px">${esc(o.order_id || '—')}</b></td>
    <td><b>${esc(o.r_name || '—')}</b><small style="display:block;color:var(--muted)">${esc(o.mobile || '')}</small></td>
    <td><small>${esc(o.unit_name || o.unit_code || '—')}</small></td>
    <td><small class="muted">${esc(o.survey_date || '—')}</small></td>
    <td><small class="muted" style="font-size:11px">${esc(o.created_by || '—')}</small></td>
  </tr>`).join('');
  const pageNav = d.pages > 1 ? `<div style="display:flex;gap:8px;align-items:center;margin-top:10px">
    ${d.page > 1 ? `<button class="btn sm" onclick="S.live.sdvOrdPage=${d.page-1};S.live.sdvOrders=null;render()">← Prev</button>` : ''}
    <span class="muted" style="font-size:12px">Page ${d.page} of ${d.pages}</span>
    ${d.page < d.pages ? `<button class="btn sm" onclick="S.live.sdvOrdPage=${d.page+1};S.live.sdvOrders=null;render()">Next →</button>` : ''}
  </div>` : '';
  return `<div class="muted" style="font-size:11px;padding:4px 0 8px">${fmtN(d.total)} total orders · page ${d.page || 1} of ${d.pages || 1}</div>` +
    table(["Order No.", "Reader · Mobile", "Unit", "Survey Date", "Surveyor Code"], [rows]) + pageNav;
}

const SDV_REPORTS = [
  { id: 'area-orders',          icon: '🏙️', title: 'Center Wise Orders',    desc: 'Area-wise daily order count with date columns' },
  { id: 'surveyor-performance', icon: '🎯', title: 'Executive Performance', desc: 'Surveyor-wise daily orders, present days, avg/day' },
  { id: 'surveyor-daily',       icon: '📋', title: 'Surveyor Wise Details', desc: 'Daily surveys per surveyor — "A" marks absent days' },
  { id: 'summary',              icon: '📊', title: 'Summary Report',        desc: 'Supervisor → Area rollup with orders and conversion %' },
];

function sdvReportUrl(endpoint) {
  return 'http://localhost:8001' + sdvQS('/api/survey/report/' + endpoint);
}

function sdvFetchReport() {
  const id = S.live.sdvReport || 'area-orders';
  S.live._sdvRptLoad = true;
  api.get(sdvQS('/api/survey/report/' + id) + (sdvQS('/api/survey/report/' + id).includes('?') ? '&' : '?') + 'format=json')
    .then(d => { S.live.sdvReportData = d; S.live._sdvRptLoad = false; if (S.screen === 'survey_dash') render(); })
    .catch(() => { S.live._sdvRptLoad = false; S.live.sdvReportData = { header: [], rows: [], error: true }; if (S.screen === 'survey_dash') render(); });
}

function sdvReportTable(d) {
  if (!d.header || !d.header.length) return `<p class="muted" style="padding:16px;text-align:center">No data for this selection.</p>`;
  // First text columns stay left-aligned; date + number columns right-aligned
  const numStart = d.header.findIndex(h => /^\d{2}\.\d{2}\.\d{2}$/.test(String(h)));
  const textCols = numStart === -1 ? 2 : numStart;
  const th = d.header.map((h, i) =>
    `<th style="position:sticky;top:0;background:var(--navy);color:#fff;padding:6px 8px;font-size:10px;white-space:nowrap;z-index:2;
        text-align:${i < textCols ? 'left' : 'right'};${i === 0 ? 'border-radius:6px 0 0 0' : ''}${i === d.header.length-1 ? 'border-radius:0 6px 0 0' : ''}">${esc(String(h))}</th>`).join('');
  const trs = d.rows.map(r => {
    const isTotal = String(r[1] || '').includes('Total') || String(r[2] || '') === 'Total';
    const tds = r.map((c, i) => {
      const v = c == null ? '' : String(c);
      const isAbsent = v === 'A';
      return `<td style="padding:4px 8px;font-size:11px;white-space:nowrap;border-bottom:1px solid var(--brd);
          text-align:${i < textCols ? 'left' : 'right'};font-variant-numeric:tabular-nums;
          ${isAbsent ? 'color:var(--red);font-weight:700;' : ''}
          ${i >= d.header.length - 3 ? 'font-weight:600;' : ''}">${esc(v)}</td>`;
    }).join('');
    return `<tr style="${isTotal ? 'background:var(--navy-l);font-weight:700' : ''}">${tds}</tr>`;
  }).join('');
  return `<div style="overflow:auto;max-height:65vh;border:1px solid var(--brd);border-radius:8px">
    <table style="border-collapse:collapse;width:max-content;min-width:100%">
      <thead><tr>${th}</tr></thead><tbody>${trs}</tbody>
    </table>
  </div>
  <div style="font-size:11px;color:var(--muted);margin-top:6px">${d.rows.length} rows · scroll table sideways for all dates</div>`;
}

function sdvReportsTab() {
  const hasRange = S.live.sdvFrom && S.live.sdvTo;
  const cur = S.live.sdvReport || 'area-orders';
  const curMeta = SDV_REPORTS.find(r => r.id === cur) || SDV_REPORTS[0];

  if (!hasRange) {
    return `<div class="card" style="padding:14px 16px">
      <div class="sdv-sec-head" style="border-left-color:var(--navy)">
        <div class="sdv-sec-title">Reports</div>
        <div class="sdv-sec-sub">On-screen view + CSV download, using the filters above</div>
      </div>
      <div style="background:var(--gold-l);border:1px solid var(--gold);padding:12px 16px;border-radius:var(--r-sm);font-size:13px">
        ⚠️ <b>Select a date range</b> (From & To) above, then press Apply. Reports need a date range.
      </div>
    </div>`;
  }

  if (!S.live.sdvReportData && !S.live._sdvRptLoad) setTimeout(sdvFetchReport, 0);

  const pick = SDV_REPORTS.map(r =>
    `<button class="btn sm${r.id === cur ? ' navy' : ''}" style="font-size:12px;white-space:nowrap"
       onclick="S.live.sdvReport='${r.id}';S.live.sdvReportData=null;render()">${r.icon} ${r.title}</button>`).join('');

  const body = S.live._sdvRptLoad || !S.live.sdvReportData
    ? `<p class="muted" style="padding:24px;text-align:center">Generating report… (up to 15 seconds)</p>`
    : (S.live.sdvReportData.error
        ? `<p style="padding:16px;color:var(--red)">Could not load report — try again.</p>`
        : sdvReportTable(S.live.sdvReportData));

  return `<div class="card" style="padding:14px 16px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
      <div style="flex:1;min-width:200px">
        <div class="sdv-sec-head" style="border-left-color:var(--navy);margin-bottom:0">
          <div class="sdv-sec-title">${curMeta.icon} ${curMeta.title}</div>
          <div class="sdv-sec-sub">${curMeta.desc}</div>
        </div>
      </div>
      <a href="${sdvReportUrl(cur)}" download
         style="background:var(--navy);color:#fff;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap">
         ⬇ Download CSV
      </a>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${pick}</div>
    ${body}
  </div>`;
}

VIEWS.survey_dash = () => {
  // Default date range: 1st of current month → today (only on first load; Clear resets to empty)
  if (S.live.sdvFrom === undefined || S.live.sdvTo === undefined) {
    const now = new Date();
    const y = now.getFullYear(), mo = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
    if (S.live.sdvFrom === undefined) S.live.sdvFrom = `${y}-${mo}-01`;
    if (S.live.sdvTo   === undefined) S.live.sdvTo   = `${y}-${mo}-${d}`;
  }

  const tab = S.live.sdvTab || 'summary';

  if (!S.live.sdvFilters && !S.live._sdvFltLoading)                  setTimeout(sdvFetchFilters, 0);
  if (!S.live.sdvKpis && !S.live._sdvKpisLoad)                       setTimeout(sdvFetchKpis, 0);
  if (tab === 'summary'  && !S.live.sdvDaily     && !S.live._sdvDailyLoad)  setTimeout(sdvFetchDaily, 0);
  if (tab === 'area'     && !S.live.sdvByUnit    && !S.live._sdvByUnitLoad) setTimeout(sdvFetchByUnit, 0);
  if (tab === 'readers'  && !S.live.sdvReaders   && !S.live._sdvRdrsLoad)   setTimeout(sdvFetchReaders, 0);
  if (tab === 'teams'    && !S.live.sdvTeams     && !S.live._sdvTeamsLoad)  setTimeout(sdvFetchTeams, 0);
  if (tab === 'followups'&& !S.live.sdvFollowups && !S.live._sdvFuLoad)     setTimeout(sdvFetchFollowups, 0);
  if (tab === 'orders'  && !S.live.sdvOrders   && !S.live._sdvOrdLoad)     setTimeout(sdvFetchOrders,    0);
  if (tab === 'map' && S.live.rcMarkers == null && !S.live._rcMkLoad) {
    S.live._rcMkLoad = true;
    // Sync Survey Intelligence filter state so map respects the selected date/unit/state
    S.live.rcFilters = { from: S.live.sdvFrom || '', to: S.live.sdvTo || '', state_name: S.live.sdvState || '', unit_code: S.live.sdvUnit || '', locality_code: S.live.sdvLocality || '' };
    setTimeout(rcFetchMarkers, 0);
  }
  if (tab === 'map' && !S.live.rcFilterOpts && !S.live._rcFOLoading) {
    S.live._rcFOLoading = true;
    setTimeout(() => { rcFetchFilterOpts(); rcFetchNewspapers(); }, 0);
  }

  const tabBtn = (id, lbl) =>
    `<button onclick="S.live.sdvTab='${id}';render()" style="padding:10px 14px;border:none;border-bottom:3px solid ${tab===id?'var(--chart-1)':'transparent'};background:none;font-size:12px;font-weight:${tab===id?'700':'500'};color:${tab===id?'var(--chart-1)':'var(--muted)'};cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s">${lbl}</button>`;

  // ── filter bar ──
  const flt = S.live.sdvFilters || {};
  const states      = flt.states      || [];
  const units       = (flt.units      || []).filter(u => !S.live.sdvState || u.state === S.live.sdvState);
  const localities  = flt.localities  || [];
  const supervisors = flt.supervisors || [];
  const surveyors   = (flt.surveyors  || []).filter(s => !S.live.sdvSupervisor || true); // all, supervisor filter applied server-side

  const curState      = S.live.sdvState      || '';
  const curUnit       = S.live.sdvUnit       || '';
  const curLocality   = S.live.sdvLocality   || '';
  const curSupervisor = S.live.sdvSupervisor || '';
  const curSurveyor   = S.live.sdvSurveyor   || '';
  const curFrom       = S.live.sdvFrom       || '';
  const curTo         = S.live.sdvTo         || '';
  const hasFilter = curState || curUnit || curLocality || curSupervisor || curSurveyor || curFrom || curTo;

  const opt = (val, lbl, cur) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(lbl)}</option>`;

  const stateOpts  = states.map(s => opt(s.code, s.name, curState)).join('');
  const unitOpts   = units.map(u => opt(u.code, u.name, curUnit)).join('');
  const locOpts    = localities.map(l => opt(l.code, l.name, curLocality)).join('');
  const supOpts    = supervisors.map(s => opt(s.code, s.name + (s.cnt ? ` (${fmtN(s.cnt)})` : ''), curSupervisor)).join('');
  const svrOpts    = surveyors.map(s => opt(s.code, s.name + (s.cnt ? ` (${fmtN(s.cnt)})` : ''), curSurveyor)).join('');

  const sel = (label, onchg, placeholder, opts) =>
    `<div style="display:flex;flex-direction:column;gap:3px;min-width:130px;flex:1">
       <label style="font-size:11px;color:var(--muted);font-weight:600">${label}</label>
       <select class="inp" style="font-size:12px;padding:5px 6px" onchange="${onchg}">
         <option value="">${placeholder}</option>${opts}
       </select>
     </div>`;

  // State change is pure client-side (units filter locally — no server call).
  // Unit change fetches unit-scoped locality/supervisor/surveyor lists (fast, indexed).
  const onStateChange = `S.live.sdvState=this.value;S.live.sdvUnit='';S.live.sdvLocality='';S.live.sdvSupervisor='';S.live.sdvSurveyor='';sdvClearCache();render()`;
  const onUnitChange  = `S.live.sdvUnit=this.value;S.live.sdvLocality='';S.live.sdvSupervisor='';S.live.sdvSurveyor='';sdvClearCache();sdvFetchFiltersNow();render()`;
  const onLocChange   = `S.live.sdvLocality=this.value;sdvClearCache();render()`;
  const onSupChange   = `S.live.sdvSupervisor=this.value;S.live.sdvSurveyor='';sdvClearCache();render()`;
  const onSvrChange   = `S.live.sdvSurveyor=this.value;sdvClearCache();render()`;

  const clearAll = `S.live.sdvState='';S.live.sdvUnit='';S.live.sdvLocality='';S.live.sdvSupervisor='';S.live.sdvSurveyor='';S.live.sdvFrom='';S.live.sdvTo='';sdvClearCache();sdvFetchFiltersNow();render()`;

  // Active filter chips
  const fltLabels = [
    curState      && (states.find(s=>s.code===curState)?.name || curState),
    curUnit       && (units.find(u=>u.code===curUnit)?.name || curUnit),
    curLocality   && (localities.find(l=>l.code===curLocality)?.name || ('Area '+curLocality)),
    curSupervisor && (supervisors.find(s=>s.code===curSupervisor)?.name || curSupervisor),
    curSurveyor   && (surveyors.find(s=>s.code===curSurveyor)?.name || curSurveyor),
    curFrom       && 'From: ' + curFrom,
    curTo         && 'To: ' + curTo,
  ].filter(Boolean);

  const filterBar = `<div class="vz-sec" style="margin-bottom:14px;padding:12px 16px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
      ${sel('STATE', onStateChange, 'All States', stateOpts)}
      ${sel('UNIT', onUnitChange, curState ? 'All Units in State' : 'All Units', unitOpts)}
      ${curUnit ? sel('AREA (Locality)', onLocChange, 'All Areas', locOpts) : ''}
      ${curUnit ? sel('SUPERVISOR', onSupChange, 'All Supervisors', supOpts) : ''}
      ${curUnit ? sel('SURVEYOR', onSvrChange, curSupervisor ? 'All in Team' : 'All Surveyors', svrOpts) : ''}
      <div style="display:flex;flex-direction:column;gap:3px">
        <label style="font-size:11px;color:var(--muted);font-weight:600">FROM</label>
        <input type="date" class="inp" style="font-size:12px;padding:5px 6px" value="${curFrom}" id="sdv-from">
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">
        <label style="font-size:11px;color:var(--muted);font-weight:600">TO</label>
        <input type="date" class="inp" style="font-size:12px;padding:5px 6px" value="${curTo}" id="sdv-to">
      </div>
      <div style="display:flex;gap:6px;align-items:flex-end">
        <button class="btn navy sm" style="height:34px;padding:0 14px"
          onclick="S.live.sdvFrom=document.getElementById('sdv-from')?.value||'';S.live.sdvTo=document.getElementById('sdv-to')?.value||'';sdvClearCache();render()">Apply</button>
        ${hasFilter ? `<button class="btn sm" style="height:34px;padding:0 12px;color:var(--red)" onclick="${clearAll}">✕ Clear</button>` : ''}
      </div>
    </div>
    ${fltLabels.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
      ${fltLabels.map(l => `<span style="background:var(--navy-l);color:var(--navy);border-radius:12px;padding:2px 10px;font-size:11px;font-weight:600">${esc(l)}</span>`).join('')}
    </div>` : ''}
  </div>`;

  if (tab === 'map') setTimeout(rcInitMap, 40);

  let content;
  switch (tab) {
    case 'map':      content = rcMapTab(S.live.rcMarkers, S.live.rcSummary); break;
    case 'area':      content = sdvAreaTab(); break;
    case 'funnel':    content = sdvFunnelTab(); break;
    case 'readers':   content = sdvReadersTab(); break;
    case 'teams':     content = sdvTeamsTab(); break;
    case 'orders':    content = sdvOrdersTab();    break;
    case 'followups': content = sdvFollowupsTab(); break;
    case 'reports':   content = sdvReportsTab(); break;
    default:          content = sdvSummaryTab(); break;
  }

  return `<style>
    .sdv-trend{display:flex;align-items:flex-end;gap:2px;height:90px;overflow-x:auto;padding:4px 0}
    .sdv-bar-col{display:flex;flex-direction:column;align-items:center;min-width:18px;flex:0 0 auto}
    .sdv-bar{width:14px;display:flex;flex-direction:column-reverse;border-radius:2px 2px 0 0;overflow:hidden}
    .sdv-day-lbl{font-size:9px;color:var(--muted);transform:rotate(-45deg);transform-origin:top left;margin-top:5px;white-space:nowrap;width:0}
    .sdv-hbar{display:grid;grid-template-columns:150px 1fr 110px;align-items:center;gap:10px;margin:8px 0}
    .sdv-hbar-track{background:var(--surf2);border-radius:6px;height:24px;overflow:hidden;border:1px solid var(--brd)}
    .sdv-hbar-fill{height:100%;border-radius:6px;transition:width .5s cubic-bezier(.4,0,.2,1)}
    .sdv-legend{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0;font-size:12px;align-items:center}
    .sdv-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:3px;vertical-align:middle}
    .sdv-sec-head{display:flex;flex-direction:column;gap:3px;border-left:4px solid var(--navy);padding-left:10px;margin-bottom:16px}
    .sdv-sec-title{font-size:13px;font-weight:700;color:var(--text)}
    .sdv-sec-sub{font-size:11px;color:var(--muted)}
  </style>
  ${pagehead("Survey Intelligence", "Reader Connect — Field Survey Analytics")}
  ${filterBar}
  <div style="display:flex;border-bottom:1px solid var(--brd);margin:0 0 16px;overflow-x:auto">
    ${tabBtn('summary', '📊 Summary')}
    ${tabBtn('map', '🗺️ Map')}
    ${tabBtn('area', '📍 Area')}
    ${tabBtn('funnel', '🎯 Funnel')}
    ${tabBtn('readers', '📰 Readers')}
    ${tabBtn('teams', '👥 Teams')}
    ${tabBtn('orders', '📦 Orders')}
    ${tabBtn('followups', '📅 Follow-ups')}
    ${tabBtn('reports', '📥 Reports')}
  </div>
  ${content}`;
};

/* ═══════════ RENDER ═══════════ */
function navGroups() {
  const u = S.user, groups = [], hl = u.hierarchyLevel || 99;
  if (u.dashboard) {
    const fieldIds = ["routes", "collections", "complaints", "partners"];
    // mgmtIds are always shown to hl≤4 regardless of saved navScreens (handles screens added after a user's navScreens was last saved)
    const mgmtIds  = ["command", "ai_insights", "supply_dash"];
    const items = DASH_MENU
      .filter(([id]) => (hl <= 4 && mgmtIds.includes(id)) || (u.navScreens ? u.navScreens.includes(id) : (hl <= 4 || fieldIds.includes(id))))
      .filter(([id]) => permAllows(id, 'view') !== false)   // explicit rights-matrix deny hides the screen
      .map(([id, l, ic]) => ({ id, label: l, icon: ic, badge: id === "approvals" ? APPROVALS.length : 0 }));
    groups.push({ label: "Dashboard — Vitran OS", items });
  }
  if (u.modules.includes('survey')) {
    groups.push({ label: "Reader Intelligence", items: [
      { id: "readers_connect", label: "Readers Connect", icon: "📍", badge: 0 }
    ]});
  }
  const apps = u.modules.filter(k => permAllows(k, 'view') !== false).map(k => ({ key: k, ...APP_MENU[k] }));
  if (apps.length) groups.push({ label: "Field Apps", apps });
  if (hl === 1) groups.push({ label: "Administration", items: [
    { id: "user_mgmt",     label: "User Management", icon: "👥" },
    { id: "manage_rights", label: "Manage Rights",   icon: "🔐" },
    { id: "audit_log",     label: "Audit Trail",     icon: "📜" },
  ]});
  return groups;
}

function sideHTML() {
  const groups = navGroups();
  let html = `<button class="nav-item ${S.screen === "home" ? "on" : ""}" onclick="go('home')" style="margin-top:10px"><span class="nico">🏠</span><span>Home — My Modules</span></button>`;
  for (const g of groups) {
    html += `<div class="sb-lbl">${g.label}</div>`;
    if (g.items) html += g.items.map(i => `<button class="nav-item ${S.screen === i.id ? "on" : ""}" onclick="go('${i.id}')">
      <span class="nico">${i.icon}</span><span>${i.label}</span>${i.badge ? `<span class="cnt num">${i.badge}</span>` : ""}</button>`).join("");
    if (g.apps) html += g.apps.map(a => {
      const active = a.sub.some(s => s[0] === S.screen);
      const open = S.openGroups[a.key] ?? active;
      return `<button class="nav-item ${active ? "on" : ""}" onclick="toggleGroup('${a.key}')" aria-expanded="${open}">
        <span class="nico" style="background:${a.tint}">${a.icon}</span><span>${a.label}</span><span class="chev ${open ? "open" : ""}">▶</span></button>
        ${open ? `<div class="subnav">${a.sub.map(s => `<button class="nav-item ${S.screen === s[0] ? "on" : ""}" onclick="go('${s[0]}')"><span>${s[1]}</span></button>`).join("")}</div>` : ""}`;
    }).join("");
  }
  html += `<div class="side-foot">Patrika Vitran Suite · v1.0</div>`;
  return html;
}

function bottomHTML() {
  const u = S.user, hl = u.hierarchyLevel || 99;
  const items = [["home", "Home", "🏠"]];
  if (u.dashboard) {
    if (hl <= 4) items.push(["command", "Dashboard", "📊"], ["approvals", "Approvals", "✅"]);
    else         items.push(["routes",  "Routes",    "🛣️"], ["collections", "Collect", "₹"]);
  } else {
    const first = APP_MENU[u.modules[0]];
    items.push([first.sub[0][0], first.label.split(" ")[0], first.icon]);
    if (u.modules[1]) { const b = APP_MENU[u.modules[1]]; items.push([b.sub[0][0], b.label.split(" ")[0], b.icon]); }
  }
  items.push(["__menu", "Menu", "☰"]);
  return items.map(([id, label, ico]) => `<button class="${S.screen === id ? "on" : ""}"
    onclick="${id === "__menu" ? "toggleSide()" : `go('${id}')`}"><span class="bico">${ico}</span>${label}</button>`).join("");
}

function paintSide() {
  const side = $("#side"), ov = $("#sbOverlay");
  if (side) side.classList.toggle("open", S.sideOpen);
  if (ov) ov.classList.toggle("show", S.sideOpen);
}

function loginHTML() {
  return `<div class="login">
    <div class="login-brand">
      <img class="login-logo" src="assets/patrika-logo.png" alt="Patrika Group">
      <h1>Patrika <b>Vitran</b> Suite</h1>
      <p>One platform for the print circulation network — dashboards for leadership, field apps for agents, hawkers, surveyors and fleet.</p>
      <div class="rule"></div>
      <small>Rajasthan Patrika · Circulation Operating System</small>
    </div>
    <div class="login-pane"><div class="login-card">
      <h2>Sign in</h2><p>Use your registered mobile number and password. Only modules assigned to your role will be visible.</p>
      <div id="loginErr"></div>
      <div class="fld"><label>Mobile number / User ID</label><input id="loginMob" type="text" maxlength="50" placeholder="10-digit mobile or User ID" autocomplete="username" onkeydown="if(event.key==='Enter')document.getElementById('loginPwd').focus()"></div>
      <div class="fld"><label>Password</label><input id="loginPwd" type="password" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
      <button class="btn navy block" id="loginBtn" onclick="doLogin()">Sign in →</button>
      <div style="text-align:center;margin-top:14px">
        <a href="#" onclick="forgotPassword();return false" style="font-size:13px;color:var(--muted);text-decoration:none">Forgot / reset password?</a>
      </div>
    </div></div></div>`;
}
window.forgotPassword = () => {
  modal(`<h3>Reset your password</h3>
    <p class="mint">For security, passwords are reset by your administrator.</p>
    <p style="font-size:13px;line-height:1.6">Please contact your <b>Circulation IT Administrator</b>. They will set a temporary password, which you'll be asked to change the next time you sign in.</p>
    <div style="display:flex;gap:9px;margin-top:16px"><button class="btn pri block" onclick="closeModals()">Got it</button></div>`);
};
window.doLogin = async () => {
  const errEl = $("#loginErr");
  const ident = $("#loginMob").value.trim(), pwd = $("#loginPwd").value;
  if (!ident || !pwd) { errEl.innerHTML = `<div class="err">Enter your mobile number / User ID and password.</div>`; return; }
  const btn = $("#loginBtn"); if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
  let data = null, detail = "Invalid mobile number / User ID or password";
  try {
    const r = await fetch(api.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mobile: ident, password: pwd }) });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.token) data = j; else detail = (j && j.detail) || detail;
  } catch { detail = "Cannot reach the server. Check your connection and try again."; }
  if (btn) { btn.disabled = false; btn.textContent = "Sign in →"; }
  if (!data) { errEl.innerHTML = `<div class="err">${esc(detail)}</div>`; return; }
  setLoggedIn(data.user, data.token);   // render() routes to the forced-change screen if required
};

/* ---------- password change (forced on first login, or voluntary from account menu) ---------- */
function changePasswordHTML(forced) {
  return `<div class="login">
    <div class="login-brand">
      <img class="login-logo" src="assets/patrika-logo.png" alt="Patrika Group">
      <h1>Set a new password</h1>
      <p>For your security, please choose a new password before continuing to the dashboard.</p>
      <div class="rule"></div><small>Patrika Vitran Suite</small>
    </div>
    <div class="login-pane"><div class="login-card">
      <h2>Change password</h2>
      <p>Signed in as <b>${esc(S.user.name)}</b>. Your account requires a password change.</p>
      <div id="cpErr"></div>
      <div class="fld"><label>Current / temporary password</label><input id="cpCur" type="password" placeholder="••••••••" autocomplete="current-password"></div>
      <div class="fld"><label>New password</label><input id="cpNew" type="password" placeholder="At least 6 characters" autocomplete="new-password"></div>
      <div class="fld"><label>Confirm new password</label><input id="cpNew2" type="password" placeholder="Re-enter new password" autocomplete="new-password" onkeydown="if(event.key==='Enter')doChangePassword(true)"></div>
      <button class="btn navy block" id="cpBtn" onclick="doChangePassword(true)">Update password →</button>
      <div style="text-align:center;margin-top:12px"><a href="#" onclick="logout();return false" style="font-size:12px;color:var(--muted)">Cancel and sign out</a></div>
    </div></div></div>`;
}
window.openChangePassword = () => {
  modal(`<h3>Change password</h3>
    <div id="cpErr"></div>
    <div class="fld"><label>Current password</label><input id="cpCur" type="password" autocomplete="current-password"></div>
    <div class="fld"><label>New password</label><input id="cpNew" type="password" placeholder="At least 6 characters" autocomplete="new-password"></div>
    <div class="fld"><label>Confirm new password</label><input id="cpNew2" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')doChangePassword(false)"></div>
    <div style="display:flex;gap:9px;margin-top:16px"><button class="btn pri block" id="cpBtn" onclick="doChangePassword(false)">Update</button><button class="btn" onclick="closeModals()">Cancel</button></div>`);
};
window.doChangePassword = async (forced) => {
  const errEl = $("#cpErr");
  const cur = ($("#cpCur")?.value) || "", nw = ($("#cpNew")?.value) || "", nw2 = ($("#cpNew2")?.value) || "";
  if (nw.length < 6) { errEl.innerHTML = `<div class="err">New password must be at least 6 characters.</div>`; return; }
  if (nw !== nw2)    { errEl.innerHTML = `<div class="err">New passwords do not match.</div>`; return; }
  const btn = $("#cpBtn"); if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  let ok = false, detail = "Could not update password";
  try {
    const r = await fetch(api.base + "/api/auth/change-password", { method: "POST", headers: api.h(), body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
    if (r.status === 401) { onAuthExpired(); return; }
    const j = await r.json().catch(() => null);
    ok = r.ok && j && j.ok; if (!ok) detail = (j && j.detail) || detail;
  } catch { detail = "Cannot reach the server."; }
  if (btn) { btn.disabled = false; btn.textContent = forced ? "Update password →" : "Update"; }
  if (!ok) { errEl.innerHTML = `<div class="err">${esc(detail)}</div>`; return; }
  if (S.user) { S.user.mustChangePassword = false; saveSession(S.user, AUTH_TOKEN); }
  closeModals();
  toast("Password updated successfully");
  S.screen = "home"; render();
};
window.userMenu = () => {
  modal(`<h3>${esc(S.user.name)}</h3>
    <p class="mint">${esc(S.user.roleLabel)}${S.user.scopeLabel ? " · " + esc(S.user.scopeLabel) : ""}</p>
    <div style="display:flex;flex-direction:column;gap:9px;margin-top:16px">
      <button class="btn block" onclick="closeModals();openChangePassword()">🔑 Change password</button>
      <button class="btn navy block" onclick="logout()">↪ Logout</button>
    </div>`);
};

function render() {
  const app = $("#app");
  if (!S.user) { app.innerHTML = loginHTML(); return; }
  if (S.user.mustChangePassword) { app.innerHTML = changePasswordHTML(true); return; }
  const view = VIEWS[S.screen] || VIEWS.home;
  app.innerHTML = `<div class="shell">
    <header class="topbar">
      <button class="menu-btn" onclick="toggleSide()" aria-label="Menu">☰</button>
      <div class="brand"><img src="assets/patrika-logo.png" alt="Patrika"><div class="bt"><b>Patrika Vitran</b><small>Circulation Suite</small></div></div>
      <div class="top-sp"></div>
      <button class="iconbtn" onclick="toggleTheme()" title="Toggle theme">◐</button>
      <button class="iconbtn" onclick="toast('3 notifications — vehicle delay, SLA risk, settlement ready')" title="Notifications">🔔<span class="dot"></span></button>
      <button class="me" onclick="userMenu()" title="Account"><span class="av">${S.user.avatar}</span>
        <span class="mi"><b>${S.user.name}</b><small>${S.user.roleLabel} · tap for account</small></span></button>
    </header>
    <aside class="side" id="side">${sideHTML()}</aside>
    <div class="sb-overlay" id="sbOverlay" onclick="S.sideOpen=false;paintSide()"></div>
    <main class="main">${view()}</main>
    <nav class="bottombar">${bottomHTML()}</nav>
  </div>`;
  paintSide();
  // Re-attach the live Leaflet map synchronously — timers are throttled in background
  // tabs, so a setTimeout-based re-attach can leave the map detached for seconds
  if (S.screen === 'readers_connect' && (S.live.rcTab || 'map') === 'map') rcInitMap();
}

restoreSession();
render();
/* Validate any restored token in the background; refresh the profile or force re-login on 401 */
if (S.user && AUTH_TOKEN) {
  api.get("/api/auth/me").then(d => {
    if (d && d.user) { S.user = d.user; saveSession(d.user, AUTH_TOKEN); render(); }
  });
}
