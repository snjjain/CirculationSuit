/* ═══════════ Patrika Vitran Suite — SPA ═══════════ */
"use strict";

/* ---------- navigation model (menus & submenus from both references) ---------- */
const DASH_MENU = [
  ["command",          "Command Centre",              "📊"],
  ["ai_nexus",         "Strategic AI Nexus",          "🧭"],
  ["supply_dash",      "Supply",                      "📦"],
  ["collections",      "Collections",                 "₹"],
  ["outstanding",      "Outstanding",                 "💰"],
  ["exec_perf",        "Executive Performance",       "👤"],
  ["dcr_analytics",    "DCR - Field Visit Analysis",  "📍"],
  ["agency_rating",    "Agency Rating Engine",        "⭐"],
  // "short_payment" is deliberately NOT listed here — it lives as a tab inside the
  // Collections dashboard, which renders the very same VIEWS.short_payment via
  // colShortPayTab(). The screen and its route stay registered so that tab (and any
  // saved deep link) keeps working; only the duplicate sidebar entry is gone.
  ["transport",        "Taxi Dashboard",              "🚕"],
  ["survey_dash",      "Survey Intelligence",         "📊"],
];

/* How the DASH_MENU screens are grouped in the sidebar. DASH_MENU stays the flat list
   because the rights machinery keys off it (navScreens defaults + the Manage Rights
   "Visible Dashboard Screens" checklist); this only controls presentation, so a screen
   can be regrouped without touching anyone's saved permissions. Any DASH_MENU id not
   listed here still renders, under the last section — so adding a screen can never
   make it silently disappear from the menu. */
const DASH_SECTIONS = [
  ["⌂ Dashboard",             ["command", "ai_nexus"]],
  ["◈ Business Intelligence", ["supply_dash", "collections", "outstanding", "agency_rating"]],
  ["◉ Field & Performance",   ["exec_perf", "dcr_analytics", "survey_dash", "transport"]],
];

// Admin-gated screens — visible only to isAdmin users (see [[project auth]]).
// A "limited admin" (isAdmin=true but hierarchyLevel>1) sees only the ones granted via
// their navScreens override; a real Level-1 admin always sees all of them.
// This stays ONE list because it is what Manage Rights' "Visible Administration
// Screens" checklist grants against — the sidebar splits it across two sections below
// purely for readability, which does not change who may open what.
const ADMIN_MENU = [
  ["user_mgmt",       "User Management",  "👥"],
  ["manage_rights",   "Manage Rights",    "🔐"],
  ["audit_log",       "Audit Trail",      "📜"],
  ["email_config",    "Email Config",     "✉"],
  ["competitor_data", "Competitor Data",  "📊"],
  ["exec_targets",    "Monthly Targets",  "🎯"],
];
// Planning screens are admin-gated like the rest of ADMIN_MENU, but read as planning
// work rather than system administration, so they get their own heading.
const PLANNING_IDS = ["exec_targets", "competitor_data"];

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

/* ---------- launcher display metadata: the app's short name + target audience (user type) ---------- */
const APP_META = {
  agent:  { name: "Agent App",  audience: "Circulation Agents" },
  hawker: { name: "Hawker App", audience: "Hawkers" },
  dcr:    { name: "DCR",        audience: "Circulation Staff" },
  survey: { name: "Survey",     audience: "Surveyors & Team Leads" },
  taxi:   { name: "Taxi",       audience: "Taxi Drivers" },
};

/* ---------- state & persistence ---------- */
let S = { user: null, screen: "home", openGroups: {}, sideOpen: false, drill: {}, live: {}, range: null };
const $ = s => document.querySelector(s);

/* ---------- default dashboard date range: 1st of current month → today ---------- */
function _pad2(n) { return String(n).padStart(2, "0"); }
function todayISO()      { const d = new Date(); return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate()); }
function monthStartISO()  { const d = new Date(); return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-01"; }
function defaultRange()  { return { from: monthStartISO(), to: todayISO() }; }
function prevMonthRange() {
  const n = new Date(), m = n.getMonth(); // 0=Jan
  const year = m === 0 ? n.getFullYear() - 1 : n.getFullYear();
  const mon  = m === 0 ? 12 : m; // 1-based prev month
  const last = new Date(year, mon, 0).getDate();
  const mm   = String(mon).padStart(2, '0'), ll = String(last).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${ll}` };
}

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
  get base() { return location.origin; },
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
    try { S.user = JSON.parse(prof); AUTH_TOKEN = token; S.screen = defaultScreen(S.user); }
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
// Remarks from Oracle contain Hindi as HTML entities (&#2310; etc.) — keep & intact, only strip < >
function remHtml(s) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// Oracle purpose fields store numeric call-type IDs — only show if text present
function fmtPurpose(p) { return (!p || /^[\d,\s]+$/.test(String(p))) ? null : remHtml(p); }

function go(screen) {
  S.screen = screen; S.sideOpen = false; render();
  const m = $(".main"); if (m) m.scrollTop = 0;
}
/* Dashboard users land straight on Command Centre; field-app users on the launcher */
function defaultScreen(u) { return u && u.dashboard ? "command" : "home"; }

function setLoggedIn(profile, token) {
  S = { user: profile, screen: defaultScreen(profile), openGroups: {}, sideOpen: false, live: {}, range: null };
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

/* Sidebar section collapse. Persisted in its own localStorage key (not the session
   store) so the layout a user settles on survives logout and reload — a menu that
   re-expands every visit is worse than one that never collapsed. Sections are OPEN by
   default: only an explicit collapse is recorded, so adding a new section later shows
   it rather than hiding it behind a stale preference. */
const NAV_COLLAPSE_KEY = 'patrika_nav_collapsed';
function navCollapsedMap() {
  try { return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY)) || {}; } catch { return {}; }
}
window.toggleNavSection = (label) => {
  const m = navCollapsedMap();
  if (m[label]) delete m[label]; else m[label] = 1;
  try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(m)); } catch (_) {}
  // Repaint only the sidebar. paintSide() just toggles the drawer classes, and a full
  // render() would rebuild the main view — needlessly re-running its fetches and
  // losing scroll position — for what is purely a menu change.
  const side = document.getElementById('side');
  if (side) { const y = side.scrollTop; side.innerHTML = sideHTML(); side.scrollTop = y; }
  else render();
};
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
  // The old "Admin — Board View · PAN India · <date>" crumb is gone: the role already
  // sits in the header account chip and the date now sits in the top bar, so it was
  // repeating both on every screen.
  return `<div class="pagehead"><div>
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

/* ---- Home (SSO app launcher) ----
   Builds the set of applications this user may open — the dashboard(s) plus the field apps
   in their assigned `modules` — gated by existing rights (dashboard flag + modules + perms).
   Everything is DB-driven; nothing is hard-coded per user. */
function _launcherAppCard(c) {
  return `<button class="card appcard" onclick="go('${c.screen}')" aria-label="Open ${c.name}">
      <div class="app-top">
        <div class="aico" style="background:${c.tint}">${c.icon}</div>
        <span class="app-status"><i></i>Live</span>
      </div>
      <b>${c.name}</b>
      ${c.audience ? `<span class="app-aud">${c.audience}</span>` : ""}
      <small>${c.desc}</small>
      <div class="tagrow">${c.tags.slice(0, 3).map(t => chip("mut", t)).join("")}</div>
      <span class="app-launch">Launch <span aria-hidden="true">→</span></span>
    </button>`;
}
VIEWS.home = () => {
  const u = S.user, hl = u.hierarchyLevel || 99;
  const cards = [];

  // Dashboard application (management / field-ops), shown only when the user has dashboard rights
  if (u.dashboard) {
    cards.push(hl <= 4
      ? { screen:"command", name:"Circulation Dashboard", audience:"Management & Circulation Staff", icon:"🗞️", tint:"var(--navy-l)",
          desc:"Command centre — supply, collections, outstanding, transport, approvals & reports.", tags:["Command Centre","Collections","Reports"] }
      : { screen:"routes",  name:"Field Operations", audience:"Field Staff", icon:"🗞️", tint:"var(--navy-l)",
          desc:"Operational view — routes, deliveries, collections and complaints in your territory.", tags:["Routes","Collections","Complaints"] });
  }

  // Field applications from the user's assigned modules (respecting per-app view rights)
  (u.modules || []).forEach(k => {
    const a = APP_MENU[k]; if (!a) return;
    if (typeof permAllows === "function" && permAllows(k, "view") === false) return;
    const m = APP_META[k] || {};
    cards.push({ screen:"app_" + k, name:m.name || a.label, audience:m.audience || "",
      icon:a.icon, tint:a.tint, desc:a.desc, tags:a.sub.map(s => s[1]) });
  });

  const stats = homeStats(u);
  const statsHtml = stats.map(([v, l]) => `<div><b class="num">${v}</b><small>${l}</small></div>`).join("");
  const grid = cards.length
    ? `<div class="applist">${cards.map(_launcherAppCard).join("")}</div>`
    : `<div class="card pad" style="color:var(--muted)">No applications have been assigned to your account yet. Please contact your administrator.</div>`;

  return `
    <div class="hero"><h2>Namaste, ${u.name.split(" ")[0]} 🙏</h2>
      <p>${u.roleLabel}${u.scopeLabel ? " · " + u.scopeLabel : ""} · Level ${hl} of 10</p>
      <div class="hstats">${statsHtml}</div></div>
    <div class="sb-lbl" style="padding-left:2px">Your Applications</div>
    ${grid}`;
};

/* ---- Field apps served as their real standalone HTML, opened inside the authenticated
        shell (SSO — the app auto-skips its own login using the shared session). ---- */
function appFrameView(key) {
  const title = (APP_META[key] && APP_META[key].name) || (APP_MENU[key] && APP_MENU[key].label) || key;
  return `<div class="appframe-bar">
      <button class="btn sm" onclick="go('home')" aria-label="Back to applications">← Apps</button>
      <b>${title}</b>
      <button class="btn sm" onclick="var f=document.querySelector('.appframe'); if(f) f.contentWindow.location.reload();" aria-label="Reload app">↻</button>
    </div>
    <div class="appframe-wrap"><iframe class="appframe" src="apps/${key}.html" title="${title}" allow="geolocation; clipboard-write"></iframe></div>`;
}
/* ═══════════ Agent (Agency) app — feature-complete responsive web app on live ERP data ═══════════ */
function _inr(n, dec) { n = Number(n) || 0; return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0 }); }
function _n(n) { return (Number(n) || 0).toLocaleString("en-IN"); }

/* Every feature from the original mobile app, as icon modules */
const AGENT_MODULES = [
  { key: "supply",     screen: "agent_supply",     icon: "📦", tint: "var(--blue-l)",   label: "Today's Supply",   desc: "Copies supplied by publication & edition." },
  { key: "history",    screen: "agent_history",    icon: "📅", tint: "var(--teal-l)",   label: "Supply History",   desc: "Month-wise supply — current + last 6 months." },
  { key: "billing",    screen: "agent_billing",    icon: "🧾", tint: "var(--gold-l)",   label: "Billing",          desc: "Monthly bill, outstanding & account status." },
  { key: "ledger",     screen: "agent_ledger",     icon: "📒", tint: "var(--purple-l)", label: "Bills & Ledger",   desc: "Every debit & credit on your account." },
  { key: "payments",   screen: "agent_payments",   icon: "💳", tint: "var(--grn-l)",    label: "Payment History",  desc: "Receipts / payments made in." },
  { key: "netsales",   screen: "agent_netsales",   icon: "📈", tint: "var(--red-l)",    label: "Net Sales",        desc: "Sale value net of commission." },
  { key: "competitor", screen: "agent_competitor", icon: "📊", tint: "var(--gold-l)",   label: "Competitor Copies",desc: "Report competitor circulation." },
  { key: "feedback",   screen: "agent_feedback",   icon: "💬", tint: "var(--grn-l)",    label: "Feedback",         desc: "Share issues or suggestions." },
  { key: "profile",    screen: "agent_profile",    icon: "👤", tint: "var(--navy-l)",   label: "User Profile",     desc: "Agency & contact details." },
  { key: "pay",        screen: "agent_pay",        icon: "💰", tint: "var(--teal-l)",   label: "Make Payment",     desc: "How to pay your outstanding." },
];

/* Date window: current + last 6 months only */
let AGENT_MONTH = null;
function agentMonthList() { const out = [], d = new Date(); for (let i = 0; i <= 6; i++) { const dd = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(dd.getFullYear() + "-" + String(dd.getMonth() + 1).padStart(2, "0")); } return out; }
function agentMonthLabel(ym) { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleString("en-IN", { month: "short", year: "numeric" }); }
function agentCurMonth() { return AGENT_MONTH || agentMonthList()[0]; }
window.agentSetMonth = ym => { AGENT_MONTH = ym; render(); };
window.agentRefresh = () => { Object.keys(S.live).forEach(k => { if (k.indexOf("ag") === 0 || k === "agent") delete S.live[k]; }); render(); };
window.agentSelectAgency = v => { const list = (S.live.agent && S.live.agent.context && S.live.agent.context.agencies) || []; S.live.agentSel = list[+v] || null; window.agentRefresh(); };
function agentKey() { const s = S.live.agentSel; return s ? s.unit_code + s.agcd : "me"; }
function agentSelQS() { const s = S.live.agentSel; return s ? "unit=" + encodeURIComponent(s.unit_code) + "&agcd=" + encodeURIComponent(s.agcd) : ""; }
function agentPath(base, params) { const all = [agentSelQS(), params].filter(Boolean).join("&"); return base + (all ? "?" + all : ""); }

/* Lazy per-(module,agency,month) loader. Returns undefined while loading. */
const _agentInflight = new Set();
function agentGet(cacheKey, path) {
  if (cacheKey in S.live) return S.live[cacheKey];
  if (!_agentInflight.has(cacheKey)) {
    _agentInflight.add(cacheKey);
    api.get(path).then(d => { S.live[cacheKey] = d || null; _agentInflight.delete(cacheKey); if (S.screen === "app_agent" || String(S.screen).indexOf("agent_") === 0) render(); });
  }
  return undefined;
}
/* Base bundle (context + summary + billing) loaded once */
async function fetchAgent() {
  if (S.live._agentLoading) return;
  S.live._agentLoading = true;
  const sel = S.live.agentSel;
  const p = sel ? `?unit=${encodeURIComponent(sel.unit_code)}&agcd=${encodeURIComponent(sel.agcd)}` : "";
  const [context, summary, billing] = await Promise.all([
    api.get("/api/agent/context"), api.get("/api/agent/summary" + p), api.get("/api/agent/billing" + p),
  ]);
  S.live.agent = { context, summary, billing };
  S.live._agentLoading = false;
  if (S.screen === "app_agent" || String(S.screen).indexOf("agent_") === 0) render();
}
function agentAgency() { const d = S.live.agent; return d && ((d.summary && d.summary.agency) || (d.context && d.context.primary)); }
function agentAgencies() { const d = S.live.agent; return (d && d.context && d.context.agencies) || []; }

function agentHeaderBar() {
  const ag = agentAgency(), list = agentAgencies();
  if (!ag) return "";
  const sel = list.length > 1
    ? `<select onchange="agentSelectAgency(this.value)" style="margin-left:auto;max-width:100%">${list.map((a, i) => `<option value="${i}" ${a.agcd === ag.agcd && a.unit_code === ag.unit_code ? "selected" : ""}>${a.ag_name} · ${a.unit_code}</option>`).join("")}</select>`
    : "";
  return `<div class="pagehead"><div>
    <div class="crumbs">${ag.unit_name || ag.unit_code}${ag.city_name ? " · " + ag.city_name : ""}${ag.state_name ? " · " + ag.state_name : ""}</div>
    <h2>${ag.ag_name}</h2>
    <div class="sub">Agency ${ag.agcd}${ag.ag_class_name ? " · " + ag.ag_class_name : ""}${ag.executive_name ? " · Exec: " + ag.executive_name : ""}</div>
    </div>${sel}</div>`;
}
function agentModuleBar() {
  return `<div class="seg" style="margin-bottom:12px">${AGENT_MODULES.map(m => `<button class="${S.screen === m.screen ? "on" : ""}" onclick="go('${m.screen}')" title="${m.label}">${m.icon} ${m.label}</button>`).join("")}</div>`;
}
function agentMonthPicker() {
  const cur = agentCurMonth();
  return `<div class="filters" style="margin-bottom:13px">
    <span class="lbl" style="align-self:center">📅 Period</span>
    <select onchange="agentSetMonth(this.value)">${agentMonthList().map(m => `<option value="${m}" ${m === cur ? "selected" : ""}>${agentMonthLabel(m)}</option>`).join("")}</select>
    <span class="lbl" style="align-self:center;color:var(--muted)">current + last 6 months</span></div>`;
}
function agentBackBar() {
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <button class="btn sm" onclick="go('app_agent')">← Dashboard</button>
    <button class="btn sm" onclick="agentRefresh()">↻ Refresh</button></div>`;
}
/* wrapper for every module screen: back + agency header + module menu (+ optional month picker) + content */
function agentScreen(inner, withMonth) {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + `<div class="card pad">Loading…</div>`; }
  if (!agentAgency()) return agentBackBar() + `<div class="card pad" style="color:var(--muted)">No active agency is linked to your login. Please contact your administrator.</div>`;
  return agentBackBar() + agentHeaderBar() + agentModuleBar() + (withMonth ? agentMonthPicker() : "") + inner;
}
const _agLoad = `<div class="card pad">Loading…</div>`;

/* ── Icon dashboard (landing) ── */
VIEWS.app_agent = () => {
  const d = S.live.agent;
  if (!d) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + `<div class="card pad">Loading your agency…</div>`; }
  const ag = agentAgency(), sum = d.summary || {};
  if (!ag) return agentBackBar() + `<div class="card pad" style="color:var(--muted)">No active agency is linked to your login. Please contact your administrator.</div>`;
  const kpis = `<div class="grid kpis">
    ${kpi("Today's Supply", _n(sum.today_copies) + " cp", sum.latest_supply_date || "", "fl", "var(--blue-l)", "📦")}
    ${kpi("Outstanding", _inr(sum.outstanding), "Current", "fl", "var(--red-l)", "💰")}
    ${kpi("This Month Bill", d.billing && d.billing.month_bill != null ? _inr(d.billing.month_bill) : "—", (d.billing && d.billing.month_bill_label) || "", "fl", "var(--gold-l)", "🧾")}
    ${kpi("Collected (MTD)", _inr(sum.collection_this_month), sum.last_collection_date ? "last " + sum.last_collection_date : "", "fl", "var(--grn-l)", "₹")}
  </div>`;
  const tiles = AGENT_MODULES.map(m => `<button class="card appcard" onclick="go('${m.screen}')" aria-label="${m.label}">
    <div class="app-top"><div class="aico" style="background:${m.tint}">${m.icon}</div></div>
    <b>${m.label}</b><small>${m.desc}</small></button>`).join("");
  return agentBackBar() + agentHeaderBar() + kpis + `<div class="sb-lbl" style="padding-left:2px">Modules</div><div class="applist">${tiles}</div>`;
};

/* ── Today's Supply (month/day) ── */
VIEWS.agent_supply = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const month = agentCurMonth();
  const data = agentGet("agSup_" + agentKey() + month, agentPath("/api/agent/supply", "month=" + month));
  let inner;
  if (data === undefined) inner = _agLoad;
  else {
    const trend = data.days || [], maxc = Math.max(1, ...trend.map(t => t.copies));
    const spark = trend.map(t => `<div title="${t.date}: ${_n(t.copies)} copies" style="flex:1;min-width:3px;height:${Math.max(4, Math.round(t.copies / maxc * 60))}px;background:var(--blue);border-radius:2px 2px 0 0;opacity:.85"></div>`).join("");
    const tot = trend.reduce((a, t) => a + t.copies, 0);
    const brk = (data.breakdown || []).map(b => `<tr><td>${b.publication}</td><td>${b.edition || ""}</td><td>${b.type || ""}</td><td class="r num">${_n(b.copies)}</td><td class="r num">${_inr(b.rate, true)}</td><td class="r num">${_n(b.commission)}%</td></tr>`);
    inner = `<div class="card pad"><div class="cardhead" style="padding:0 0 10px;border:0"><h3>Daily supply — ${agentMonthLabel(month)}</h3><span class="lbl">${_n(tot)} copies · latest ${data.breakdown_date || "—"}</span></div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:66px">${spark || '<span class="lbl">No supply this month</span>'}</div></div>
      <div class="card"><div class="cardhead"><h3>Breakdown · ${data.breakdown_date || month}</h3></div>
        <div class="tablewrap"><table><thead><tr><th>Publication</th><th>Edition</th><th>Type</th><th class="r">Copies</th><th class="r">Rate</th><th class="r">Comm</th></tr></thead>
        <tbody>${brk.join("") || `<tr><td colspan="6" style="color:var(--muted)">No supply found</td></tr>`}</tbody></table></div></div>`;
  }
  return agentScreen(inner, true);
};

/* ── Supply History (6 months) ── */
VIEWS.agent_history = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const data = agentGet("agHist_" + agentKey(), agentPath("/api/agent/supply-history", "months=6"));
  let inner;
  if (data === undefined) inner = _agLoad;
  else {
    const months = data.months || [], maxc = Math.max(1, ...months.map(m => m.copies));
    const rows = months.slice().reverse().map(m => `<tr class="rowbtn" onclick="agentSetMonth('${m.month}');go('agent_supply')">
      <td><b>${agentMonthLabel(m.month)}</b></td>
      <td><div class="bar"><i style="width:${Math.round(m.copies / maxc * 100)}%"></i></div></td>
      <td class="r num">${_n(m.copies)}</td><td class="r num">${_inr(m.value)}</td><td class="r num">${_n(m.avg_commission)}%</td></tr>`);
    inner = `<div class="card"><div class="cardhead"><h3>Monthly Supply — current + last 6 months</h3><span class="lbl">tap a month for daily detail</span></div>
      <div class="tablewrap"><table><thead><tr><th>Month</th><th></th><th class="r">Copies</th><th class="r">Value</th><th class="r">Avg Comm</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="5" style="color:var(--muted)">No supply history</td></tr>`}</tbody></table></div></div>`;
  }
  return agentScreen(inner, false);
};

/* ── Billing (current snapshot + monthly trend) ── */
VIEWS.agent_billing = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const b = (S.live.agent.billing) || {};
  const hist = agentGet("agBillH_" + agentKey(), agentPath("/api/agent/bill-history", "months=6"));
  const snap = `<div class="two">
    <div class="card pad"><div class="lbl" style="margin-bottom:8px">Outstanding Breakdown</div>
      <div class="stat-pair"><span>Opening balance</span><span class="num">${_inr(b.opening)}</span></div>
      <div class="stat-pair"><span>Billed (cumulative)</span><span class="num">${_inr(b.billed_cumulative)}</span></div>
      <div class="stat-pair"><span>Other debit</span><span class="num">${_inr(b.other_debit)}</span></div>
      <div class="stat-pair"><span>Received</span><span class="num" style="color:var(--grn)">${_inr(b.received)}</span></div>
      <div class="stat-pair"><span>Other credit</span><span class="num">${_inr(b.other_credit)}</span></div>
      <div class="stat-pair"><span>Outstanding</span><span class="num" style="color:var(--red);font-weight:800">${_inr(b.outstanding)}</span></div></div>
    <div class="card pad"><div class="lbl" style="margin-bottom:8px">This Month &amp; Security</div>
      <div class="stat-pair"><span>${b.month_bill_label || "Month"} bill</span><span class="num">${b.month_bill != null ? _inr(b.month_bill) : "—"}</span></div>
      <div class="stat-pair"><span>Security balance</span><span class="num">${_inr(b.security_balance)}</span></div>
      <div class="stat-pair"><span>Total copies (period)</span><span class="num">${_n(b.total_copies)}</span></div>
      <div class="stat-pair"><span>Day copies</span><span class="num">${_n(b.day_copies)}</span></div></div></div>`;
  let trend = "";
  if (hist === undefined) trend = _agLoad;
  else { const rows = ((hist.months) || []).slice().reverse().map(m => `<tr><td>${agentMonthLabel(m.month)}</td><td class="r num">${_inr(m.billing)}</td><td class="r num">${m.outstanding != null ? _inr(m.outstanding) : "—"}</td></tr>`);
    trend = `<div class="card"><div class="cardhead"><h3>Monthly Billing — last 6 months</h3></div>
      <div class="tablewrap"><table><thead><tr><th>Month</th><th class="r">Billed</th><th class="r">Outstanding</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="3" style="color:var(--muted)">No history</td></tr>`}</tbody></table></div>`; }
  return agentScreen(snap + trend, false);
};

/* ── Bills & Ledger ── */
VIEWS.agent_ledger = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const data = agentGet("agLed_" + agentKey(), agentPath("/api/agent/ledger", "limit=80"));
  let inner;
  if (data === undefined) inner = _agLoad;
  else { const rows = ((data.rows) || []).map(r => `<tr><td>${r.date || ""}</td><td>${r.doc_no || ""}</td><td>${r.mode || r.category || ""}</td>
      <td class="r num" style="color:${r.is_receipt ? "var(--grn)" : "var(--red)"}">${_inr(Math.abs(r.amount), true)}${r.is_receipt ? " cr" : " dr"}</td></tr>`);
    inner = `<div class="card"><div class="cardhead"><h3>Bills &amp; Ledger</h3><span class="lbl">receipts &amp; charges</span></div>
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>Voucher</th><th>Mode</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="4" style="color:var(--muted)">No transactions</td></tr>`}</tbody></table></div>`; }
  return agentScreen(inner, false);
};

/* ── Payment History (month) ── */
VIEWS.agent_payments = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const month = agentCurMonth();
  const data = agentGet("agPay_" + agentKey() + month, agentPath("/api/agent/payments", "month=" + month));
  let inner;
  if (data === undefined) inner = _agLoad;
  else { const rows = ((data.rows) || []).map(r => `<tr><td>${r.date || ""}</td><td>${r.doc_no || ""}</td><td>${r.mode || ""}</td><td>${r.category || ""}</td><td class="r num" style="color:var(--grn)">${_inr(r.amount, true)}</td></tr>`);
    inner = `<div class="card"><div class="cardhead"><h3>Payments — ${agentMonthLabel(month)}</h3><span class="lbl">total ${_inr(data.total || 0)}</span></div>
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>Receipt</th><th>Mode</th><th>Category</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="5" style="color:var(--muted)">No payments this month</td></tr>`}</tbody></table></div>`; }
  return agentScreen(inner, true);
};

/* ── Net Sales (month) ── */
VIEWS.agent_netsales = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const month = agentCurMonth();
  const data = agentGet("agNet_" + agentKey() + month, agentPath("/api/agent/netsales", "month=" + month));
  let inner;
  if (data === undefined) inner = _agLoad;
  else { const t = data.total || {};
    const rows = ((data.by_publication) || []).map(r => `<tr><td>${r.publication}</td><td class="r num">${_n(r.copies)}</td><td class="r num">${_inr(r.gross)}</td><td class="r num" style="color:var(--red)">${_inr(r.commission)}</td><td class="r num" style="font-weight:800">${_inr(r.net)}</td></tr>`);
    inner = `<div class="grid kpis">
        ${kpi("Copies", _n(t.copies), agentMonthLabel(month), "fl", "var(--blue-l)", "📦")}
        ${kpi("Gross Value", _inr(t.gross), "", "fl", "var(--gold-l)", "🧾")}
        ${kpi("Commission", _inr(t.commission), "", "fl", "var(--red-l)", "％")}
        ${kpi("Net Sales", _inr(t.net), "", "fl", "var(--grn-l)", "📈")}</div>
      <div class="card"><div class="cardhead"><h3>Net Sales by Publication — ${agentMonthLabel(month)}</h3></div>
      <div class="tablewrap"><table><thead><tr><th>Publication</th><th class="r">Copies</th><th class="r">Gross</th><th class="r">Commission</th><th class="r">Net</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="5" style="color:var(--muted)">No sales this month</td></tr>`}</tbody></table></div></div>`; }
  return agentScreen(inner, true);
};

/* ── Competitor Copies (report + history) ── */
window.agentSubmitCompetitor = async () => {
  const competitor = gv("agcp-name"), copies = gv("agcp-copies"), remarks = gv("agcp-remarks");
  if (!competitor) { toast("Enter competitor name"); return; }
  const r = await api.post(agentPath("/api/agent/competitor"), { competitor, copies, remarks });
  if (r && r.ok) { toast("✓ Competitor report saved"); delete S.live["agCmp_" + agentKey()]; render(); }
  else toast((r && r.detail) || "Could not submit");
};
VIEWS.agent_competitor = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const data = agentGet("agCmp_" + agentKey(), agentPath("/api/agent/competitor"));
  const list = data === undefined ? _agLoad
    : `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Competitor</th><th class="r">Copies</th><th>Remarks</th></tr></thead>
       <tbody>${(((data && data.rows) || []).map(r => `<tr><td>${r.date || ""}</td><td>${r.competitor || ""}</td><td class="r num">${_n(r.copies)}</td><td>${r.remarks || ""}</td></tr>`).join("")) || `<tr><td colspan="4" style="color:var(--muted)">No reports yet</td></tr>`}</tbody></table></div>`;
  const form = `<div class="card pad">
    <div class="lbl" style="margin-bottom:8px">Report Competitor Copies</div>
    <div class="fld"><label>Competitor</label><input id="agcp-name" placeholder="e.g. Dainik Bhaskar"></div>
    <div class="fld"><label>Estimated copies</label><input id="agcp-copies" type="number" inputmode="numeric" placeholder="0"></div>
    <div class="fld"><label>Remarks</label><textarea id="agcp-remarks" placeholder="Area, notes…"></textarea></div>
    <button class="btn pri block" onclick="agentSubmitCompetitor()">Submit report</button></div>`;
  return agentScreen(`<div class="two">${form}<div class="card"><div class="cardhead"><h3>Recent Reports</h3></div>${list}</div></div>`, false);
};

/* ── Feedback ── */
window.agentSubmitFeedback = async () => {
  const category = gv("agfb-cat"), rating = gv("agfb-rating"), message = gv("agfb-msg");
  if (!message) { toast("Please type your feedback"); return; }
  const r = await api.post(agentPath("/api/agent/feedback"), { category, rating, message });
  if (r && r.ok) { toast("✓ Feedback submitted — thank you"); go("app_agent"); }
  else toast((r && r.detail) || "Could not submit");
};
VIEWS.agent_feedback = () => agentScreen(`<div class="card pad field-col">
    <div class="lbl" style="margin-bottom:8px">Share Feedback</div>
    <div class="fld"><label>Category</label><select id="agfb-cat"><option>Supply</option><option>Billing</option><option>Delivery</option><option>App</option><option>Other</option></select></div>
    <div class="fld"><label>Rating</label><select id="agfb-rating"><option value="5">★★★★★ Excellent</option><option value="4">★★★★ Good</option><option value="3">★★★ Average</option><option value="2">★★ Poor</option><option value="1">★ Bad</option></select></div>
    <div class="fld"><label>Message</label><textarea id="agfb-msg" placeholder="Tell us what's working or what needs attention…"></textarea></div>
    <button class="btn pri block" onclick="agentSubmitFeedback()">Submit feedback</button></div>`, false);

/* ── User Profile ── */
VIEWS.agent_profile = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const ag = agentAgency() || {};
  const row = (l, v) => `<div class="stat-pair"><span>${l}</span><span>${v || "—"}</span></div>`;
  return agentScreen(`<div class="two">
    <div class="card pad"><div class="lbl" style="margin-bottom:8px">Agency</div>
      ${row("Name", ag.ag_name)}${row("Agency code", ag.agcd)}${row("Unit", (ag.unit_name || "") + " (" + ag.unit_code + ")")}
      ${row("Class", ag.ag_class_name)}${row("Type", ag.ag_type_name)}${row("Depot", ag.dpcd)}</div>
    <div class="card pad"><div class="lbl" style="margin-bottom:8px">Location & Contact</div>
      ${row("City", ag.city_name)}${row("District", ag.dist_name)}${row("State", ag.state_name)}
      ${row("Mobile", ag.mobile)}${row("Executive", ag.executive_name)}</div></div>`, false);
};

/* ── Make Payment (info only — no live payment processing) ── */
VIEWS.agent_pay = () => {
  if (!S.live.agent) { if (!S.live._agentLoading) fetchAgent(); return agentBackBar() + _agLoad; }
  const sum = S.live.agent.summary || {};
  return agentScreen(`<div class="field-col">
    <div class="card pad" style="text-align:center">
      <div class="lbl">Current Outstanding</div>
      <div class="num" style="font-size:30px;font-weight:800;color:var(--red);margin:6px 0">${_inr(sum.outstanding)}</div>
      <div class="lbl" style="color:var(--muted)">as of latest posting</div></div>
    <div class="card pad" style="margin-top:13px">
      <div class="lbl" style="margin-bottom:8px">How to pay</div>
      <p style="font-size:13.5px;line-height:1.6;color:var(--ink)">Pay your outstanding via NEFT/RTGS to the Patrika circulation account, or hand over a cheque/UPI at your branch office. Quote your <b>agency code</b> in the payment reference so the receipt is matched to your account. Payments reflect in <b>Payment History</b> after the branch posts them.</p>
      <div class="vz-alert" style="margin-top:10px"><span class="ai">ℹ️</span><span>Online payment from the app will be enabled once the payment gateway is integrated. This screen is informational for now.</span></div>
    </div></div>`, false);
};

/* ═══════════ DCR app — circulation-staff agent/hawker visits (branch-scoped, live) ═══════════ */
/* Generic lazy loader (re-renders on completion) — shared by DCR screens */
const _liveInflight = new Set();
function liveGet(cacheKey, path) {
  if (cacheKey in S.live) return S.live[cacheKey];
  if (!_liveInflight.has(cacheKey)) {
    _liveInflight.add(cacheKey);
    api.get(path).then(d => { S.live[cacheKey] = d || null; _liveInflight.delete(cacheKey); render(); });
  }
  return undefined;
}

const DCR_MODULES = [
  { key: "visit",  screen: "dcr_visit",  icon: "📝", tint: "var(--gold-l)",   label: "Record Visit",  desc: "Agent, hawker or office visit." },
  { key: "plan",   screen: "dcr_plan",   icon: "🗓️", tint: "var(--purple-l)", label: "Tour Planning", desc: "Plan visits ahead." },
  { key: "today",  screen: "dcr_today",  icon: "📋", tint: "var(--blue-l)",   label: "Today's Visits", desc: "Visits you've submitted today." },
  { key: "report", screen: "dcr_report", icon: "📊", tint: "var(--grn-l)",    label: "Day Report",     desc: "Your visit summary for the day." },
];
function dcrCtx() { return S.live.dcr && S.live.dcr.context; }
async function fetchDcr() {
  if (S.live._dcrLoading) return; S.live._dcrLoading = true;
  const context = await api.get("/api/dcr/context");
  S.live.dcr = { context }; S.live._dcrLoading = false;
  if (S.screen === "app_dcr" || String(S.screen).indexOf("dcr_") === 0) render();
}
function dcrBackBar() {
  return `<div style="display:flex;gap:8px;margin-bottom:12px">
    <button class="btn sm" onclick="go('app_dcr')">← DCR Home</button>
    <button class="btn sm" onclick="go('home')">Apps</button></div>`;
}
function dcrHeader() {
  const ctx = dcrCtx(); const s = ctx && ctx.staff; if (!s) return "";
  const units = ((ctx.unit_codes) || []).join(", ") || "all branches";
  return `<div class="pagehead"><div>
    <div class="crumbs">DCR · Daily Collection Register</div>
    <h2>${s.name || "Staff"}</h2>
    <div class="sub">Emp ${s.employee_code || "—"} · Branch ${units}</div></div></div>`;
}
function dcrModuleBar() {
  return `<div class="seg" style="margin-bottom:12px">${DCR_MODULES.map(m => `<button class="${S.screen === m.screen ? "on" : ""}" onclick="go('${m.screen}')">${m.icon} ${m.label}</button>`).join("")}</div>`;
}
function dcrScreen(inner) {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  return dcrBackBar() + dcrHeader() + dcrModuleBar() + inner;
}

/* ── DCR icon dashboard ── */
VIEWS.app_dcr = () => {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  const rep = liveGet("dcrRep_" + todayISO(), "/api/dcr/day-report");
  const kpis = `<div class="grid kpis">
    ${kpi("Today's Visits", rep ? _n(rep.total) : "—", todayISO(), "fl", "var(--gold-l)", "📝")}
    ${kpi("Agent Visits", rep ? _n(rep.agent_visits) : "—", "", "fl", "var(--blue-l)", "🏢")}
    ${kpi("Hawker Visits", rep ? _n(rep.hawker_visits) : "—", "", "fl", "var(--teal-l)", "🛵")}</div>`;
  const tiles = DCR_MODULES.map(m => `<button class="card appcard" onclick="go('${m.screen}')">
    <div class="app-top"><div class="aico" style="background:${m.tint}">${m.icon}</div></div>
    <b>${m.label}</b><small>${m.desc}</small></button>`).join("");
  return dcrBackBar() + dcrHeader() + kpis + `<div class="sb-lbl" style="padding-left:2px">Modules</div><div class="applist">${tiles}</div>`;
};

/* ── Record a Visit ── */
function dcrSelectedHTML(sel) {
  const ic = (S.live.dcrType || "agent") === "hawker" ? "🛵" : "🏢";
  return `<div class="card pad" style="background:var(--surf2);margin-bottom:12px;display:flex;align-items:center;gap:10px">
    <div class="aico" style="background:var(--gold-l);width:34px;height:34px;font-size:16px">${ic}</div>
    <div style="flex:1;min-width:0"><b>${sel.name || sel.code}</b><small style="display:block;color:var(--muted)">${sel.code} · ${sel.extra || ""} · ${sel.unit_code}</small></div>
    <button class="btn sm" onclick="dcrClearSel()">✕</button></div>`;
}
window.dcrSetType = t => { S.live.dcrType = t; S.live.dcrSelected = null; S.live.dcrTargets = null; render(); };
window.dcrClearSel = () => { S.live.dcrSelected = null; render(); };
window.dcrSearch = async () => {
  const el = document.getElementById("dcr-q"); const res = document.getElementById("dcr-results");
  if (!el || !res) return;
  const q = el.value || "", type = S.live.dcrType || "agent";
  if (q.trim().length < 1) { res.innerHTML = ""; return; }
  res.innerHTML = `<div class="lbl" style="padding:6px">Searching…</div>`;
  const data = await api.get(`/api/dcr/targets?type=${type}&q=${encodeURIComponent(q)}&limit=20`);
  S.live.dcrTargets = (data && data.targets) || [];
  res.innerHTML = S.live.dcrTargets.length
    ? S.live.dcrTargets.map((t, i) => `<button class="dcr-opt" onclick="dcrPick(${i})"><b>${t.name || t.code}</b><small>${t.code} · ${t.extra || ""}</small></button>`).join("")
    : `<div class="lbl" style="padding:6px;color:var(--muted)">No matches in your branch</div>`;
};
window.dcrPick = i => {
  const t = (S.live.dcrTargets || [])[i]; if (!t) return;
  S.live.dcrSelected = t;
  const res = document.getElementById("dcr-results"); if (res) res.innerHTML = "";
  const q = document.getElementById("dcr-q"); if (q) q.value = "";
  const sc = document.getElementById("dcr-selected"); if (sc) sc.innerHTML = dcrSelectedHTML(t);
};
window.dcrGeo = () => {
  if (!navigator.geolocation) { toast("Location not available"); return; }
  navigator.geolocation.getCurrentPosition(
    p => { S.live.dcrGeo = { lat: p.coords.latitude, lng: p.coords.longitude }; const g = document.getElementById("dcr-geo"); if (g) g.textContent = "✓ " + S.live.dcrGeo.lat.toFixed(4) + ", " + S.live.dcrGeo.lng.toFixed(4); toast("Location captured"); },
    () => toast("Could not get location"));
};
const DCR_PURPOSES = ["Routine visit", "Collection", "Supply issue", "Complaint", "Growth / new copies", "Dues follow-up", "New agency/hawker", "Other"];
const DCR_OUTCOMES = ["Met", "Not available", "Resolved", "Pending", "Escalated"];
const dcrOpts = arr => arr.map(o => `<option>${o}</option>`).join("");
window.dcrSetKind = k => { S.live.dcrKind = k; if (k !== "office") S.live.dcrType = k; S.live.dcrSelected = null; S.live.dcrTargets = null; render(); };
window.dcrSubmitVisit = async () => {
  const kind = S.live.dcrKind || "agent";
  const body = { target_type: kind, purpose: gv("dcr-purpose"), outcome: gv("dcr-outcome"), remarks: gv("dcr-remarks"), check_in: gv("dcr-checkin"), check_out: gv("dcr-checkout") };
  if (kind === "office") {
    body.work_type = gv("dcr-worktype"); body.location = gv("dcr-location"); body.assigned_by = gv("dcr-assigned");
    body.attendees = gv("dcr-attendees"); body.subject = gv("dcr-subject");
    const dt = gv("dcr-date"); if (dt) body.visit_date = dt;
  } else {
    const sel = S.live.dcrSelected; if (!sel) { toast("Please select an " + kind); return; }
    body.unit_code = sel.unit_code; body.target_code = sel.code; body.target_name = sel.name; body.target_extra = sel.extra;
    body.amount_collected = gv("dcr-amount");
    if (kind === "agent") { body.payment_mode = gv("dcr-paymode"); body.payment_type = gv("dcr-paytype"); body.copies_committed = gv("dcr-copies"); body.growth_start = gv("dcr-growth"); body.dues_clear_by = gv("dcr-dues"); }
    if (kind === "hawker") { body.outstanding_amount = gv("dcr-outstanding"); }
  }
  if (S.live.dcrGeo) { body.lat = S.live.dcrGeo.lat; body.lng = S.live.dcrGeo.lng; }
  const r = await api.post("/api/dcr/visit", body);
  if (r && r.ok) { toast("✓ Visit recorded"); S.live.dcrSelected = null; S.live.dcrGeo = null; delete S.live["dcrToday_" + todayISO()]; delete S.live["dcrRep_" + todayISO()]; go("dcr_today"); }
  else toast((r && r.detail) || "Could not submit");
};
window.dcrSubmitTour = async () => {
  const sel = S.live.dcrSelected; if (!sel) { toast("Select an agent or hawker to plan"); return; }
  const tour_date = gv("dcrp-date"); if (!tour_date) { toast("Pick a tour date"); return; }
  const body = { target_type: S.live.dcrType || "agent", unit_code: sel.unit_code, target_code: sel.code, target_name: sel.name, target_extra: sel.extra, tour_date, visit_time: gv("dcrp-time"), purpose: gv("dcrp-purpose"), description: gv("dcrp-desc") };
  const r = await api.post("/api/dcr/tour", body);
  if (r && r.ok) { toast("✓ Visit planned"); S.live.dcrSelected = null; delete S.live["dcrTours"]; go("dcr_plan"); }
  else toast((r && r.detail) || "Could not save");
};
VIEWS.dcr_visit = () => {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  const kind = S.live.dcrKind || "agent", sel = S.live.dcrSelected;
  const two = (a, b) => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${a}${b}</div>`;
  const fld = (label, inner) => `<div class="fld"><label>${label}</label>${inner}</div>`;
  const roleSeg = `<div class="seg" style="margin-bottom:12px">
    <button class="${kind === "agent" ? "on" : ""}" onclick="dcrSetKind('agent')">🏢 Agent</button>
    <button class="${kind === "hawker" ? "on" : ""}" onclick="dcrSetKind('hawker')">🛵 Hawker</button>
    <button class="${kind === "office" ? "on" : ""}" onclick="dcrSetKind('office')">🗂️ Office</button></div>`;
  const picker = kind === "office" ? "" : `
    <div class="fld"><label>Find ${kind}</label><input id="dcr-q" placeholder="Search name or code…" oninput="dcrSearch()" autocomplete="off"></div>
    <div id="dcr-results" class="dcr-results"></div>
    <div id="dcr-selected">${sel ? dcrSelectedHTML(sel) : ""}</div>`;
  let fields = "";
  if (kind === "agent") {
    fields = two(fld("Check-In", `<input id="dcr-checkin" type="time">`), fld("Check-Out", `<input id="dcr-checkout" type="time">`))
      + fld("Visit Purpose", `<select id="dcr-purpose">${dcrOpts(DCR_PURPOSES)}</select>`)
      + two(fld("Payment Mode", `<select id="dcr-paymode"><option>None</option><option>Cash</option><option>Cheque</option><option>UPI</option><option>NEFT/RTGS</option></select>`),
            fld("Payment Type", `<select id="dcr-paytype"><option>—</option><option>Full</option><option>Partial</option><option>Advance</option></select>`))
      + two(fld("Amount Collected (₹)", `<input id="dcr-amount" type="number" inputmode="numeric" placeholder="0">`),
            fld("New Copies Committed", `<input id="dcr-copies" type="number" inputmode="numeric" placeholder="0">`))
      + two(fld("Growth Start Date", `<input id="dcr-growth" type="date">`), fld("Agent will clear dues by", `<input id="dcr-dues" type="date">`))
      + fld("Outcome", `<select id="dcr-outcome">${dcrOpts(DCR_OUTCOMES)}</select>`)
      + fld("Notes / Remarks", `<textarea id="dcr-remarks" placeholder="Meeting notes, agent feedback, next steps…"></textarea>`);
  } else if (kind === "hawker") {
    fields = fld("Visit Time", `<input id="dcr-checkin" type="time">`)
      + two(fld("Outstanding (₹)", `<input id="dcr-outstanding" type="number" inputmode="numeric" placeholder="0">`),
            fld("Collected (₹)", `<input id="dcr-amount" type="number" inputmode="numeric" placeholder="0">`))
      + fld("Visit Purpose", `<select id="dcr-purpose">${dcrOpts(DCR_PURPOSES)}</select>`)
      + fld("Outcome", `<select id="dcr-outcome">${dcrOpts(DCR_OUTCOMES)}</select>`)
      + fld("Remarks / Notes", `<textarea id="dcr-remarks" placeholder="Area observations, hawker feedback, issue if any…"></textarea>`);
  } else {
    fields = fld("Work Type", `<select id="dcr-worktype"><option>Meeting</option><option>Report / MIS</option><option>Training</option><option>Admin work</option><option>Field coordination</option><option>Other</option></select>`)
      + two(fld("Date", `<input id="dcr-date" type="date" value="${todayISO()}">`), fld("Location", `<input id="dcr-location" placeholder="Office / venue">`))
      + two(fld("Start Time", `<input id="dcr-checkin" type="time">`), fld("End Time", `<input id="dcr-checkout" type="time">`))
      + fld("Permitted / Assigned By", `<input id="dcr-assigned" placeholder="Name & designation">`)
      + fld("Attendees / Others", `<input id="dcr-attendees" placeholder="Names of others present (optional)">`)
      + fld("Subject / Topic", `<input id="dcr-subject" placeholder="Brief subject line">`)
      + fld("Detailed Description", `<textarea id="dcr-remarks" placeholder="Work done, decisions, outcomes…"></textarea>`);
  }
  const geo = `<div style="display:flex;gap:8px;align-items:center;margin:4px 0 12px">
    <button class="btn sm" onclick="dcrGeo()">📍 Use my location</button>
    <span id="dcr-geo" class="lbl" style="color:var(--muted)">${S.live.dcrGeo ? "✓ " + S.live.dcrGeo.lat.toFixed(4) + ", " + S.live.dcrGeo.lng.toFixed(4) : "optional"}</span></div>`;
  const inner = `<div class="card pad field-col">
    <div class="lbl" style="margin-bottom:8px">Record a Visit</div>
    ${roleSeg}${picker}${fields}${geo}
    <button class="btn pri block" onclick="dcrSubmitVisit()">Submit ${kind} visit</button></div>`;
  return dcrScreen(inner);
};

/* ── Tour Planning ── */
VIEWS.dcr_plan = () => {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  const type = S.live.dcrType || "agent", sel = S.live.dcrSelected;
  const tours = liveGet("dcrTours", "/api/dcr/tours");
  const form = `<div class="card pad field-col">
    <div class="lbl" style="margin-bottom:8px">Plan a Visit</div>
    <div class="seg" style="margin-bottom:12px">
      <button class="${type === "agent" ? "on" : ""}" onclick="dcrSetType('agent')">🏢 Agent</button>
      <button class="${type === "hawker" ? "on" : ""}" onclick="dcrSetType('hawker')">🛵 Hawker</button></div>
    <div class="fld"><label>Find ${type}</label><input id="dcr-q" placeholder="Search name or code…" oninput="dcrSearch()" autocomplete="off"></div>
    <div id="dcr-results" class="dcr-results"></div>
    <div id="dcr-selected">${sel ? dcrSelectedHTML(sel) : ""}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fld"><label>Date of Tour</label><input id="dcrp-date" type="date" value="${todayISO()}"></div>
      <div class="fld"><label>Tentative Time</label><input id="dcrp-time" type="time"></div></div>
    <div class="fld"><label>Visit Purpose</label><select id="dcrp-purpose">${dcrOpts(DCR_PURPOSES)}</select></div>
    <div class="fld"><label>Purpose Description</label><textarea id="dcrp-desc" placeholder="Reason for visit and expected outcome…"></textarea></div>
    <button class="btn pri block" onclick="dcrSubmitTour()">Save plan</button></div>`;
  let list;
  if (tours === undefined) list = `<div class="card pad">Loading…</div>`;
  else {
    const rows = ((tours && tours.tours) || []).map(t => `<tr><td>${t.tour_date}${t.visit_time ? " " + t.visit_time : ""}</td><td><span class="chip ${t.target_type === "hawker" ? "teal" : "info"}">${t.target_type}</span></td><td>${t.target_name || t.target_code}</td><td>${t.purpose || ""}</td><td>${t.status || ""}</td></tr>`);
    list = `<div class="card"><div class="cardhead"><h3>Upcoming Tours</h3></div><div class="tablewrap"><table><thead><tr><th>When</th><th>Type</th><th>Target</th><th>Purpose</th><th>Status</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="5" style="color:var(--muted)">No planned visits</td></tr>`}</tbody></table></div></div>`;
  }
  return dcrScreen(`<div class="two">${form}${list}</div>`);
};

/* ── Today's Visits ── */
VIEWS.dcr_today = () => {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  const data = liveGet("dcrToday_" + todayISO(), "/api/dcr/visits?date=" + todayISO());
  let inner;
  if (data === undefined) inner = `<div class="card pad">Loading…</div>`;
  else {
    const rows = ((data && data.visits) || []).map(v => `<tr>
      <td>${(v.created_at || "").slice(11, 16)}</td>
      <td><span class="chip ${v.target_type === "hawker" ? "teal" : "info"}">${v.target_type}</span></td>
      <td>${v.target_name || v.target_code}</td><td>${v.purpose || ""}</td><td>${v.outcome || ""}</td></tr>`);
    inner = `<div class="card"><div class="cardhead"><h3>Today's Visits</h3><span class="lbl">${todayISO()}</span></div>
      <div class="tablewrap"><table><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Purpose</th><th>Outcome</th></tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="5" style="color:var(--muted)">No visits yet — record one from the DCR home</td></tr>`}</tbody></table></div></div>`;
  }
  return dcrScreen(inner);
};

/* ── Day Report ── */
VIEWS.dcr_report = () => {
  if (!S.live.dcr) { if (!S.live._dcrLoading) fetchDcr(); return dcrBackBar() + `<div class="card pad">Loading…</div>`; }
  const rep = liveGet("dcrRep_" + todayISO(), "/api/dcr/day-report");
  let inner;
  if (rep === undefined) inner = `<div class="card pad">Loading…</div>`;
  else inner = `<div class="grid kpis">
      ${kpi("Total Visits", _n(rep && rep.total), todayISO(), "fl", "var(--gold-l)", "📝")}
      ${kpi("Agent Visits", _n(rep && rep.agent_visits), "", "fl", "var(--blue-l)", "🏢")}
      ${kpi("Hawker Visits", _n(rep && rep.hawker_visits), "", "fl", "var(--teal-l)", "🛵")}</div>
    <div class="card pad"><p style="color:var(--muted);font-size:13px;line-height:1.6">Your submitted visits for ${todayISO()}, branch-scoped. Tour planning (plan visits ahead) is the next DCR addition.</p></div>`;
  return dcrScreen(inner);
};

/* Remaining field apps still open their standalone prototype in an iframe (redesigned one-by-one). */
Object.keys(APP_META).forEach(k => { if (!VIEWS["app_" + k]) VIEWS["app_" + k] = () => appFrameView(k); });

/* ═══════════ DCR / Field Visit Intelligence ═══════════ */
/* ── State ── */
let _dcrA = { tab: 'summary', summary: null, monthly: null, execs: null, mapData: null,
               from: monthStartISO(), to: todayISO(), unit_code: '', state: '',
               units: null, _loadUnits: false,
               _loadS: false, _loadM: false, _loadE: false, _loadMap: false,
               // Tour Route state
               tourExecs: null, _loadTE: false,
               tourEmpCode: '', tourDate: todayISO(),
               tourData: null, _loadTour: false,
               tourDays: null, _loadDays: false,
               // New tabs state
               analysis: null, _loadAn: false,
               coverage: null, _loadCov: false,
               remarks: null, _loadRem: false, remEmpCode: '', aiResults: null, _analyzing: false,
               planExecs: null, _loadPlanExecs: false,
               planEmpCode: '', planDate: '', plan: null, _loadingPlan: false,
               teamPlan: null, _loadingTeam: false, teamUnit: '' };
let _dcrMap = null;     // Leaflet map — agency map tab
let _dcrTourMap = null; // Leaflet map — tour route tab
let _dcrTeamMap = null; // Leaflet map — team live tab

/* ── Data loaders ── */
function _dcrAUrl(path) {
  let qs = `from=${_dcrA.from}&to=${_dcrA.to}`;
  if (_dcrA.unit_code) qs += `&unit_code=${encodeURIComponent(_dcrA.unit_code)}`;
  if (_dcrA.state)     qs += `&state=${encodeURIComponent(_dcrA.state)}`;
  return `${location.origin}/api/dcr-analytics/${path}?${qs}`;
}
function _dcrALoadSummary(force) {
  if (_dcrA._loadS || (_dcrA.summary && !force)) return;
  _dcrA._loadS = true; _dcrA.summary = null;
  fetch(_dcrAUrl('summary'), { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.summary=d; _dcrA._loadS=false; if(S.screen==='dcr_analytics') render(); })
    .catch(()=>{ _dcrA.summary={_err:true}; _dcrA._loadS=false; if(S.screen==='dcr_analytics') render(); });
}
function _dcrALoadMonthly(force) {
  if (_dcrA._loadM || (_dcrA.monthly && !force)) return;
  _dcrA._loadM = true; _dcrA.monthly = null;
  const qs = `months=6${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
  fetch(`${location.origin}/api/dcr-analytics/monthly?${qs}`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.monthly=d; _dcrA._loadM=false; if(S.screen==='dcr_analytics') render(); })
    .catch(()=>{ _dcrA.monthly={_err:true}; _dcrA._loadM=false; if(S.screen==='dcr_analytics') render(); });
}
function _dcrALoadExecs(force) {
  if (_dcrA._loadE || (_dcrA.execs && !force)) return;
  _dcrA._loadE = true; _dcrA.execs = null;
  fetch(_dcrAUrl('executives'), { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.execs=d; _dcrA._loadE=false; if(S.screen==='dcr_analytics') render(); })
    .catch(()=>{ _dcrA.execs={_err:true}; _dcrA._loadE=false; if(S.screen==='dcr_analytics') render(); });
}
function _dcrALoadMap(force) {
  if (_dcrA._loadMap || (_dcrA.mapData && !force)) return;
  _dcrA._loadMap = true; _dcrA.mapData = null;
  const qs = `${_dcrA.unit_code?'unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
  fetch(`${location.origin}/api/dcr-analytics/agency-map?${qs}`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.mapData=d; _dcrA._loadMap=false; if(S.screen==='dcr_analytics'&&_dcrA.tab==='map') { render(); } })
    .catch(()=>{ _dcrA.mapData={_err:true}; _dcrA._loadMap=false; if(S.screen==='dcr_analytics') render(); });
}

function _dcrALoadUnits() {
  if (_dcrA._loadUnits || _dcrA.units) return;
  _dcrA._loadUnits = true;
  fetch(`${location.origin.replace(':8123',':8001')}/api/dcr-analytics/units`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.units=d.units||[]; _dcrA._loadUnits=false; if(S.screen==='dcr_analytics') render(); })
    .catch(()=>{ _dcrA.units=[]; _dcrA._loadUnits=false; });
}

/* ── Team Live loaders ── */
function _dcrALoadTeam(force) {
  if (_dcrA._loadTeam || (_dcrA.teamData && !force)) return;
  _dcrA._loadTeam = true; _dcrA.teamData = null;
  if (_dcrTeamMap) { _dcrTeamMap.remove(); _dcrTeamMap = null; }
  const qs = `date=${_dcrA.teamDate||new Date().toISOString().slice(0,10)}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
  fetch(`${location.origin}/api/dcr-analytics/team-live?${qs}`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.teamData=d; _dcrA._loadTeam=false; if(S.screen==='dcr_analytics'&&_dcrA.tab==='team') { render(); setTimeout(_initTeamMap, 80); } })
    .catch(()=>{ _dcrA.teamData={_err:true}; _dcrA._loadTeam=false; if(S.screen==='dcr_analytics') render(); });
}

function _initTeamMap() {
  if (!window.L) return;
  const d = _dcrA.teamData;
  if (!d || d._err) return;
  if (_dcrTeamMap) { _dcrTeamMap.remove(); _dcrTeamMap = null; }
  const el = document.getElementById('dcrTeamMapEl');
  if (!el) return;
  const execs = d.execs_with_gps || [];
  if (!execs.length) { el.innerHTML = '<div style="padding:20px;color:var(--ink-2);font-size:13px;text-align:center">No GPS-tagged visits for this date</div>'; return; }
  const allPts = execs.map(e => [e.lat, e.lng]);
  const ctr = allPts.reduce((a,p)=>[a[0]+p[0]/allPts.length,a[1]+p[1]/allPts.length],[0,0]);
  _dcrTeamMap = L.map(el, { zoomControl: true }).setView(ctr, 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(_dcrTeamMap);
  _dcrTeamMap.fitBounds(L.latLngBounds(allPts).pad(0.15));
  // Color palette for executives
  const palette = ['#2563eb','#16a34a','#dc2626','#d97706','#7c3aed','#0891b2','#db2777','#65a30d','#ea580c','#0284c7'];
  execs.forEach((e, i) => {
    const col = palette[i % palette.length];
    const initials = (e.exec_name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
    const popup = `<b style="color:${col}">${esc(e.exec_name||e.emp_code)}</b><br>
      <span style="font-size:11px;color:#6b7280">${esc(e.unit_name||e.unit_code)}</span><br>
      <span style="font-size:11px">Last visit: <b>${esc(e.last_ag_name||e.last_agcd||'—')}</b></span><br>
      <span style="font-size:11px;color:#6b7280">${e.last_time||''} · ${esc(e.last_city||'')} · ${e.visit_count} visits</span><br>
      ${e.last_purpose?`<span style="font-size:11px;color:#2563eb">${esc(e.last_purpose)}</span><br>`:''}
      <button onclick="dcrASetTab('tour');_dcrA.tourEmpCode='${esc(e.emp_code)}';_dcrA.tourDate='${esc(d.date)}';_dcrA.tourData=null;_dcrA._loadTour=false;_dcrA.tourDays=null;_dcrA._loadDays=false;_dcrALoadTour();render();" style="font-size:11px;margin-top:4px;padding:2px 8px;border:1px solid #2563eb;border-radius:4px;color:#2563eb;background:none;cursor:pointer">View Tour Route →</button>`;
    L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: `<div style="background:${col};color:#fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff">${initials}</div>`, iconAnchor:[15,15] }) })
      .addTo(_dcrTeamMap).bindPopup(popup);
  });
}

function _dcrATeamTab() {
  if (!_dcrA.teamDate) _dcrA.teamDate = new Date().toISOString().slice(0, 10);
  _dcrALoadTeam();
  const d = _dcrA.teamData;

  const filterRow = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
    <label style="font-size:12px;color:var(--ink-2)">Date:</label>
    <input type="date" id="teamDateIn" value="${_dcrA.teamDate}" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
    <button class="btn sm pri" onclick="window._dcrATeamLoad()">Refresh</button>
    ${_dcrA._loadTeam ? '<span style="font-size:12px;color:var(--ink-2)">Loading…</span>' : ''}
    <span style="font-size:12px;color:var(--ink-2);margin-left:auto">📡 Last GPS punch per executive · Click marker for details</span>
  </div>`;

  if (!d && !_dcrA._loadTeam) return filterRow + '<div style="color:var(--ink-2);font-size:13px;padding:20px 0;text-align:center">Select date and click Refresh</div>';
  if (_dcrA._loadTeam) return filterRow + '<div style="color:var(--ink-2);font-size:13px;padding:20px 0;text-align:center">⏳ Loading team locations…</div>';
  if (d?._err) return filterRow + '<div style="color:var(--red);font-size:13px">Failed to load team data</div>';

  const withGps = d.execs_with_gps || [];
  const noGps   = d.execs_no_gps || [];
  const totalExecs = withGps.length + noGps.length;

  const summaryRow = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    ${_dcrKpi(withGps.length, 'GPS Located', 'var(--grn)')}
    ${_dcrKpi(noGps.length, 'No GPS', 'var(--red)')}
    ${_dcrKpi(totalExecs, 'Total Active', 'var(--ink)')}
    ${_dcrKpi(withGps.reduce((s,e)=>s+e.visit_count,0), 'Total Visits', 'var(--blue)')}
  </div>`;

  const mapDiv = `<div id="dcrTeamMapEl" style="height:350px;border-radius:10px;overflow:hidden;background:var(--surface-2);margin-bottom:14px"></div>`;

  // Executive list
  const execList = withGps.length ? `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--grn);margin-bottom:6px">📍 ${withGps.length} Executives Located</div>
    <div style="overflow-x:auto"><table class="tbl" style="font-size:12px;min-width:480px">
      <thead><tr><th style="text-align:left">Executive</th><th style="text-align:left">Unit</th><th>Last Visit</th><th>Time</th><th class="r">Visits</th><th onclick="event.stopPropagation()" style="cursor:pointer">Route</th></tr></thead>
      <tbody>${withGps.map(e=>`<tr>
        <td><b style="color:var(--primary)">${esc(e.exec_name||e.emp_code)}</b></td>
        <td style="color:var(--ink-2);font-size:11px">${esc(e.unit_name||e.unit_code)}</td>
        <td><span style="font-size:11px">${esc(e.last_ag_name||e.last_agcd||'—')}</span>${e.last_city?`<span style="font-size:10px;color:var(--ink-2)"> ${esc(e.last_city)}</span>`:''}</td>
        <td style="color:var(--ink-2)">${e.last_time||'—'}</td>
        <td class="r">${e.visit_count}</td>
        <td><button class="btn sm" onclick="dcrASetTab('tour');_dcrA.tourEmpCode='${esc(e.emp_code)}';_dcrA.tourDate='${esc(d.date)}';_dcrA.tourData=null;_dcrA._loadTour=false;_dcrA.tourDays=null;_dcrA._loadDays=false;_dcrALoadTour();render();" style="font-size:10px;padding:2px 8px">Route →</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  const noGpsList = noGps.length ? `
    <div style="margin-top:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--red);margin-bottom:6px">No GPS — ${noGps.length} Executives (visits punched without location)</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${noGps.map(e=>`<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11.5px">
        <b>${esc(e.exec_name||e.emp_code)}</b> <span style="color:var(--ink-2)">${e.visit_count}v</span>
      </div>`).join('')}
    </div>` : '';

  return filterRow + summaryRow + mapDiv + execList + noGpsList;
}

window._dcrATeamLoad = () => {
  const dt = document.getElementById('teamDateIn')?.value;
  if (dt) _dcrA.teamDate = dt;
  _dcrA.teamData = null; _dcrA._loadTeam = false;
  if (_dcrTeamMap) { _dcrTeamMap.remove(); _dcrTeamMap = null; }
  _dcrALoadTeam();
  render();
};

/* ── Tour Route loaders ── */
function _dcrALoadTourExecs(force) {
  if (_dcrA._loadTE || (_dcrA.tourExecs && !force)) return;
  _dcrA._loadTE = true;
  const qs = `${_dcrA.unit_code?'unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
  fetch(`${location.origin}/api/dcr-analytics/executive-list?${qs}`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.tourExecs=d; _dcrA._loadTE=false; if(S.screen==='dcr_analytics'&&_dcrA.tab==='tour') render(); })
    .catch(()=>{ _dcrA.tourExecs={_err:true}; _dcrA._loadTE=false; if(S.screen==='dcr_analytics') render(); });
}
function _dcrALoadTour() {
  if (_dcrA._loadTour || !_dcrA.tourEmpCode || !_dcrA.tourDate) return;
  _dcrA._loadTour = true; _dcrA.tourData = null;
  if (_dcrTourMap) { _dcrTourMap.remove(); _dcrTourMap = null; }
  const qs = `emp_code=${encodeURIComponent(_dcrA.tourEmpCode)}&date=${_dcrA.tourDate}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}`;
  fetch(`${location.origin}/api/dcr-analytics/tour-route?${qs}`, { headers: api.h() })
    .then(r=>r.json()).then(d=>{ _dcrA.tourData=d; _dcrA._loadTour=false; if(S.screen==='dcr_analytics'&&_dcrA.tab==='tour') { render(); setTimeout(_initTourMap, 80); } })
    .catch(()=>{ _dcrA.tourData={_err:true}; _dcrA._loadTour=false; if(S.screen==='dcr_analytics') render(); });
}

/* ── Tour Route map init ── */
function _initTourMap() {
  if (!window.L) return;
  const d = _dcrA.tourData;
  if (!d || d._err) return;
  if (_dcrTourMap) { _dcrTourMap.remove(); _dcrTourMap = null; }
  const el = document.getElementById('dcrTourMapEl');
  if (!el) return;

  const gpsVisits = (d.visits || []).filter(v => v.lat && v.lng);
  const office = d.office;   // unit office — primary start point
  const center = d.center;   // center check-in GPS (fallback / secondary info)
  const missed  = d.missed_agencies || [];

  const startPt = office || center; // prefer office
  if (!gpsVisits.length && !startPt) { el.innerHTML = '<div style="padding:20px;color:var(--ink-2);font-size:13px;text-align:center">No GPS data for this date</div>'; return; }

  const allPts = [];
  if (startPt?.lat) allPts.push([startPt.lat, startPt.lng]);
  gpsVisits.forEach(v => allPts.push([v.lat, v.lng]));

  const ctr = allPts.length ? allPts.reduce((a,p)=>[a[0]+p[0]/allPts.length,a[1]+p[1]/allPts.length],[0,0]) : [23, 80];
  _dcrTourMap = L.map(el, { zoomControl: true }).setView(ctr, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(_dcrTourMap);

  // Draw route polyline: start → visit1 → visit2 → ... → visitN (solid line)
  if (allPts.length >= 2) {
    L.polyline(allPts, { color: '#2563eb', weight: 3, opacity: 0.8 }).addTo(_dcrTourMap);
    // Return-to-office dashed line
    if (startPt && gpsVisits.length) {
      const last = gpsVisits[gpsVisits.length - 1];
      L.polyline([[last.lat, last.lng], [startPt.lat, startPt.lng]], { color: '#2563eb', weight: 2, opacity: 0.5, dashArray: '6 4' }).addTo(_dcrTourMap);
    }
    _dcrTourMap.fitBounds(L.latLngBounds(allPts).pad(0.15));
  }

  // Office / start-point marker (red house icon)
  if (office?.lat) {
    const officePopup = `<b style="color:#ef4444">🏢 ${esc(office.name||'Office')}</b><br><span style="font-size:11px;color:#666">Unit Start Point</span>${office.address?`<br><span style="font-size:11px;color:#666">${esc(office.address)}</span>`:''}`;
    L.marker([office.lat, office.lng], { icon: L.divIcon({ className: '', html: '<div style="background:#ef4444;color:#fff;border-radius:6px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 6px rgba(0,0,0,.45)">🏢</div>', iconAnchor:[15,15] }) })
      .addTo(_dcrTourMap).bindPopup(officePopup);
  } else if (center?.lat) {
    // Fallback: show center check-in as start
    L.marker([center.lat, center.lng], { icon: L.divIcon({ className: '', html: '<div style="background:#6366f1;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.4)">📍</div>', iconAnchor:[14,14] }) })
      .addTo(_dcrTourMap)
      .bindPopup(`<b>${esc(center.name||'Center Check-in')}</b><br><span style="font-size:11px;color:#666">Center check-in GPS</span>`);
  }

  // Visit markers (numbered, blue)
  gpsVisits.forEach((v, i) => {
    const num = v.seq || (i+1);
    const durMin = (()=>{const s=v.from_time?parseInt(v.from_time)*60+parseInt((v.from_time||'').split(':')[1]||0):null; const e=v.till_time?parseInt(v.till_time)*60+parseInt((v.till_time||'').split(':')[1]||0):null; return (s&&e&&e>s)?(e-s):null;})();
    const popup = `<b>${esc(v.ag_name||v.agcd||'Agency')}</b> <span style="color:#6b7280;font-size:11px">(${esc(v.agcd||'')})</span>
      <br><span style="font-size:11px">${v.from_time||''}${v.till_time?' – '+v.till_time:''} ${durMin?'('+durMin+'m)':''}</span>
      ${fmtPurpose(v.purpose)?`<br><span style="font-size:11px;color:#2563eb">${esc(fmtPurpose(v.purpose))}</span>`:''}
      ${v.remarks?`<br><span style="font-size:11px;color:#374151;font-style:italic">"${remHtml((v.remarks||'').slice(0,120))}"</span>`:''}
      ${v.distance_from_prev!=null?`<br><span style="font-size:11px;color:#6b7280">📏 ${v.distance_from_prev} km from prev stop</span>`:''}
      ${v.agcd?`<br><a href="#" onclick="event.preventDefault();openAgencyProfile('${esc(v.unit_code||'').replace(/'/g,"\\'")}','${esc(v.agcd).replace(/'/g,"\\'")}','${esc(v.ag_name||v.agcd||'').replace(/'/g,"\\'")}')" style="font-size:11px;color:#2563eb;font-weight:600">View profile →</a>`:''}`;
    L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: `<div style="background:#2563eb;color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4)">${num}</div>`, iconAnchor:[13,13] }) })
      .addTo(_dcrTourMap).bindPopup(popup);
  });

  // Missed agency markers (orange)
  missed.forEach(ag => {
    L.marker([ag.lat, ag.lng], { icon: L.divIcon({ className: '', html: '<div style="background:#f59e0b;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;box-shadow:0 2px 4px rgba(0,0,0,.3)">!</div>', iconAnchor:[10,10] }) })
      .addTo(_dcrTourMap)
      .bindPopup(`<b style="color:#f59e0b">⚠ Missed Nearby</b><br>${esc(ag.ag_name)}<br><span style="font-size:11px;color:#6b7280">${esc(ag.city||'')} · ${ag.nearest_dist_km} km away</span>
        <br><a href="#" onclick="event.preventDefault();openAgencyProfile('${esc(ag.unit_code||'').replace(/'/g,"\\'")}','${esc(ag.agcd).replace(/'/g,"\\'")}','${esc(ag.ag_name||ag.agcd||'').replace(/'/g,"\\'")}')" style="font-size:11px;color:#2563eb;font-weight:600">View profile →</a>`);
  });
}

/* ── Tour Route tab renderer ── */
function _dcrATourTab() {
  _dcrALoadTourExecs();
  // A tour was opened from another tab (View Tour Route →): load its day list too
  if (_dcrA.tourEmpCode && !_dcrA.tourDays && !_dcrA._loadDays) _dcrALoadTourDays();
  const execs = _dcrA.tourExecs?.executives || [];
  const d = _dcrA.tourData;
  const stats = d?.stats || {};

  const execOpts = execs.map(e => `<option value="${esc(e.emp_code)}" ${_dcrA.tourEmpCode===e.emp_code?'selected':''}>${esc(e.name||e.emp_code)} [${esc(e.unit_name||e.unit_code)}]</option>`).join('');

  const filterRow = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <select id="tourExecSel" onchange="_dcrATourPickExec()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink);max-width:260px">
        <option value="">— Select Executive —</option>${execOpts}
      </select>
      <span style="font-size:11px;color:var(--ink-2)">Tour days in ${_dcrA.from.split('-').reverse().join('/')} – ${_dcrA.to.split('-').reverse().join('/')} (top date filter)</span>
      ${_dcrA._loadDays ? '<span style="font-size:12px;color:var(--ink-2)">⏳ Finding tour days…</span>' : ''}
      ${_dcrA._loadTour ? '<span style="font-size:12px;color:var(--ink-2)">⏳ Loading route…</span>' : ''}
    </div>`;

  // Clickable tour-day list from the date-range filter
  let daysRow = '';
  if (_dcrA.tourEmpCode && _dcrA.tourDays) {
    if (!_dcrA.tourDays.length) {
      daysRow = `<div style="color:var(--ink-2);font-size:12.5px;padding:8px 0 14px">No field tours found for this executive between ${_dcrA.from.split('-').reverse().join('/')} and ${_dcrA.to.split('-').reverse().join('/')} — widen the date filter above and press Apply.</div>`;
    } else {
      const fmtDay = ds => {
        const dt = new Date(ds + 'T00:00:00');
        return { d: dt.getDate() + ' ' + dt.toLocaleDateString('en-IN', { month: 'short' }), w: dt.toLocaleDateString('en-IN', { weekday: 'short' }) };
      };
      daysRow = `<div style="display:flex;gap:8px;overflow-x:auto;padding:2px 0 12px;margin-bottom:12px;border-bottom:1px solid var(--border)">
        ${_dcrA.tourDays.map(td => {
          const ds = String(td.tour_date).slice(0, 10);
          const f = fmtDay(ds);
          const active = _dcrA.tourDate === ds;
          const gps = Number(td.gps_count || 0);
          return `<div onclick="_dcrATourPickDay('${ds}')" role="button"
            style="flex:none;min-width:96px;padding:8px 12px;border-radius:10px;cursor:pointer;border:1.5px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--surface-2)'};color:${active ? '#fff' : 'var(--ink)'}"
            onmouseenter="if(!${active})this.style.borderColor='var(--primary)'" onmouseleave="this.style.borderColor='${active ? 'var(--primary)' : 'var(--border)'}'">
            <div style="font-size:13px;font-weight:700">${f.d} <span style="font-weight:400;font-size:10.5px;opacity:.8">${f.w}</span></div>
            <div style="font-size:10.5px;margin-top:3px;opacity:.85">${td.visits} visit${td.visits != 1 ? 's' : ''} · ${gps > 0 ? '📍' + gps : 'no GPS'}</div>
            ${td.first_time ? `<div style="font-size:10px;margin-top:1px;opacity:.7">${td.first_time}${td.last_time ? '–' + td.last_time : ''}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }
  }

  if (!_dcrA.tourEmpCode) return filterRow + `<div style="color:var(--ink-2);font-size:13px;padding:30px 0;text-align:center">Select an executive — their tour days in the selected date range will appear here</div>`;
  if (!d && !_dcrA._loadTour) return filterRow + daysRow + (_dcrA._loadDays ? '' : `<div style="color:var(--ink-2);font-size:13px;padding:20px 0;text-align:center">Click a tour day above to see the route on the map</div>`);
  if (_dcrA._loadTour) return filterRow + daysRow + `<div style="color:var(--ink-2);font-size:13px;padding:30px 0;text-align:center">⏳ Analysing tour route…</div>`;
  if (d?._err) return filterRow + daysRow + `<div style="color:var(--red);font-size:13px;padding:20px 0">Failed to load tour route data</div>`;

  // Stats strip
  const statsStrip = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      ${_dcrKpi(stats.total_visits||0,'Visits','var(--ink)')}
      ${_dcrKpi(stats.gps_visits||0,'GPS Tagged','var(--blue)')}
      ${_dcrKpi((stats.total_distance_km||0)+'km','Distance','var(--grn)')}
      ${_dcrKpi(stats.field_hours!=null?stats.field_hours+'h':'—','Field Hours','var(--purple)')}
      ${_dcrKpi(stats.geographic_spread_km!=null?stats.geographic_spread_km+'km':'—','Coverage','var(--gold)')}
      ${_dcrKpi(stats.missed_nearby_count||0,'Missed Nearby','var(--orange)')}
    </div>
    ${stats.first_visit_time?`<div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">⏰ ${stats.first_visit_time} → ${stats.last_visit_time||'?'}&nbsp;&nbsp;·&nbsp;&nbsp;📏 Total route: ${stats.total_distance_km} km&nbsp;&nbsp;·&nbsp;&nbsp;⏱ In meetings: ${stats.total_time_in_meetings_min||0} min</div>`:''}`;

  // Office location banner / missing warning
  const isAdmin = S.user?.isAdmin;
  let officeBanner = '';
  if (d.office) {
    officeBanner = `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--grn-l);border-radius:8px;font-size:12px;margin-bottom:10px;border:1px solid var(--grn)">
      <span style="font-size:16px">🏢</span>
      <span><b>Start point:</b> ${esc(d.office.name)} ${d.office.address?'— '+esc(d.office.address.slice(0,60)):''}</span>
    </div>`;
  } else if (d.office_missing) {
    officeBanner = `<div style="padding:10px 14px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:12px;margin-bottom:10px">
      <b>⚠ Start location not set</b> — no base location for this executive and no office for unit ${esc(d.executive?.unit_code||'')}; km calculation starts from first GPS visit.
      ${isAdmin ? `&nbsp;<a href="${location.origin.replace(':8123',':8001')}/api/admin/unit-locations/export" style="color:#d97706;font-weight:700" onclick="event.preventDefault();_dcrULDownload()">Download Units Excel</a>
      &nbsp;·&nbsp;<button class="btn sm" onclick="_dcrULUploadModal()" style="font-size:11px;padding:3px 10px">Upload Filled Excel</button>` : ''}
    </div>`;
  }

  // Map
  const mapDiv = `<div id="dcrTourMapEl" style="height:360px;border-radius:10px;overflow:hidden;background:var(--surface-2);margin-bottom:14px"></div>`;

  // Visit timeline table
  const visits = d.visits || [];
  const missedAg = d.missed_agencies || [];
  const visitTable = visits.length ? `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:6px">Visit Timeline</div>
    <div style="overflow-x:auto">
    <table class="tbl" style="font-size:12px;min-width:560px">
      <thead><tr>
        <th style="width:32px">#</th><th style="text-align:left">Agency</th><th>Time</th>
        <th>Duration</th><th>Purpose</th><th class="r">Dist prev</th><th style="font-size:10px">GPS</th>
      </tr></thead>
      <tbody>
      ${visits.map(v=>{
        const sm=v.from_time?parseInt(v.from_time)*60+parseInt((v.from_time||'').split(':')[1]||0):null;
        const em=v.till_time?parseInt(v.till_time)*60+parseInt((v.till_time||'').split(':')[1]||0):null;
        const dur=(sm&&em&&em>sm)?((em-sm)+'m'):'—';
        const purpose = fmtPurpose(v.purpose);
        return `<tr onclick="${v.agcd?`_dcrADrillAgency('${esc(v.agcd)}','${esc(v.ag_name||v.agcd||'')}','${esc(v.unit_code||'')}')`:''}" style="cursor:${v.agcd?'pointer':'default'}" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="color:var(--ink-2);text-align:center">${v.seq}</td>
          <td><b style="color:var(--primary)">${esc(v.ag_name||v.agcd||'—')}</b>${v.city?`<span style="font-size:10px;color:var(--ink-2)"> ${esc(v.city)}</span>`:''}</td>
          <td style="white-space:nowrap;color:var(--ink-2)">${v.from_time||'—'}${v.till_time?' – '+v.till_time:''}</td>
          <td style="color:var(--ink-2)">${dur}</td>
          <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${remHtml(v.remarks||v.purpose||'')}">${purpose?esc(purpose):remHtml((v.remarks||'').slice(0,40))||'—'}</td>
          <td class="r" style="color:var(--ink-2)">${v.distance_from_prev!=null?v.distance_from_prev+' km':'—'}</td>
          <td style="text-align:center">${v.lat?'📍':'—'}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table></div>` : `<div style="color:var(--ink-2);font-size:13px">No visits recorded for this date</div>`;

  // Missed agencies
  const missedSection = missedAg.length ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--orange);margin-bottom:8px">⚠ ${missedAg.length} Nearby Unvisited Agencies (within 5 km of route)</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${missedAg.map(ag=>`<div onclick="_dcrADrillAgency('${esc(ag.agcd)}','${esc(ag.ag_name||ag.agcd||'')}','${esc(ag.unit_code||'')}')" role="button" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:11.5px;cursor:pointer" onmouseenter="this.style.borderColor='var(--orange)'" onmouseleave="this.style.borderColor='var(--border)'">
        <b>${esc(ag.ag_name||ag.agcd)}</b>&nbsp;<span style="color:var(--ink-2)">${esc(ag.city||'')}</span>
        <span style="color:var(--orange);margin-left:6px">${ag.nearest_dist_km} km</span>
      </div>`).join('')}
      </div>
    </div>` : '';

  return filterRow + daysRow + officeBanner + statsStrip + mapDiv + visitTable + missedSection;
}

function _dcrALoadTourDays() {
  if (_dcrA._loadDays || !_dcrA.tourEmpCode) return;
  _dcrA._loadDays = true;
  const qs = `emp_code=${encodeURIComponent(_dcrA.tourEmpCode)}&from=${_dcrA.from}&to=${_dcrA.to}${_dcrA.unit_code ? '&unit_code=' + encodeURIComponent(_dcrA.unit_code) : ''}`;
  fetch(`${location.origin.replace(':8123', ':8001')}/api/dcr-analytics/tour-days?${qs}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => {
      _dcrA.tourDays = d.days || [];
      _dcrA._loadDays = false;
      // Auto-open the most recent tour day if nothing is loaded yet
      if (_dcrA.tourDays.length && !_dcrA.tourData && !_dcrA._loadTour) {
        _dcrA.tourDate = String(_dcrA.tourDays[0].tour_date).slice(0, 10);
        _dcrALoadTour();
      }
      if (S.screen === 'dcr_analytics') render();
    })
    .catch(() => { _dcrA.tourDays = []; _dcrA._loadDays = false; if (S.screen === 'dcr_analytics') render(); });
}

window._dcrATourPickExec = () => {
  const ec = document.getElementById('tourExecSel')?.value || '';
  _dcrA.tourEmpCode = ec;
  _dcrA.tourDays = null; _dcrA._loadDays = false;
  _dcrA.tourData = null; _dcrA._loadTour = false;
  if (_dcrTourMap) { _dcrTourMap.remove(); _dcrTourMap = null; }
  if (ec) _dcrALoadTourDays();
  render();
};

window._dcrATourPickDay = (ds) => {
  if (_dcrA.tourDate === ds && _dcrA.tourData) return;
  _dcrA.tourDate = ds;
  _dcrA.tourData = null; _dcrA._loadTour = false;
  if (_dcrTourMap) { _dcrTourMap.remove(); _dcrTourMap = null; }
  _dcrALoadTour();
  render();
};

// Unit location Excel download
window._dcrULDownload = async () => {
  try {
    const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/admin/unit-locations/export`, { headers: api.h() });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('spreadsheetml')) {
      let msg = 'Download failed (' + r.status + ')';
      try { msg = (await r.json()).detail || msg; } catch (_) {}
      toast('⚠ ' + msg);
      return;
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'unit_locations.xlsx'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast('⚠ Download failed: ' + e.message); }
};

// Upload modal for filled Excel
window._dcrULUploadModal = () => {
  modal(`<h3>Upload Locations Excel</h3>
    <p style="font-size:12px;color:var(--ink-2)">Fill latitude &amp; longitude in the downloaded Excel — sheet <b>Unit Locations</b> for branch offices, sheet <b>Executive Locations</b> for executives working from a remote base (their km calculation then starts there instead of the unit office). Leave rows blank to skip.</p>
    <input type="file" id="ulFile" accept=".xlsx,.xls" style="margin:10px 0;display:block">
    <div id="ulErr" style="color:var(--red);font-size:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn pri block" onclick="_dcrULDoUpload()">Upload &amp; Save</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window._dcrULDoUpload = async () => {
  const file = document.getElementById('ulFile')?.files?.[0];
  const errEl = document.getElementById('ulErr');
  if (!file) { errEl.textContent = 'Please select a file'; return; }
  const buf = await file.arrayBuffer();
  try {
    const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/admin/unit-locations/import`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.detail || 'Upload failed'; return; }
    closeModals();
    toast(`✅ Saved ${d.updated} unit + ${d.exec_updated || 0} executive locations (blank rows skipped)`);
    _dcrA.tourData = null; _dcrALoadTour(); // refresh current tour data
  } catch (e) { errEl.textContent = 'Upload error: ' + e.message; }
};

/* ── KPI cell helper ── */
function _dcrKpi(val, lbl, color, sub, onclick) {
  const clickAttr = onclick ? `onclick="${onclick}" role="button" tabindex="0" onmouseenter="this.style.outline='2px solid var(--primary)'" onmouseleave="this.style.outline='none'"` : '';
  return `<div ${clickAttr} style="background:var(--surface-2);border-radius:10px;padding:12px 14px;min-width:100px${onclick?';cursor:pointer':''}">
    <div style="font-size:20px;font-weight:700;color:${color||'var(--ink)'};line-height:1.2">${val}</div>
    <div style="font-size:10.5px;color:var(--ink-2);margin-top:3px;text-transform:uppercase;letter-spacing:.04em;font-weight:600">${lbl}</div>
    ${sub?`<div style="font-size:11px;color:var(--ink-2);margin-top:2px">${sub}</div>`:''}
    ${onclick?`<div style="font-size:10px;color:var(--primary);margin-top:4px">tap for details →</div>`:''}
  </div>`;
}

/* ── Summary tab ── */
function _dcrASummaryTab() {
  _dcrALoadSummary(); _dcrALoadMonthly();
  const s = _dcrA.summary;
  const m = _dcrA.monthly;

  // KPIs
  let kpiHtml = '';
  if (!s) {
    kpiHtml = `<div style="color:var(--ink-2);font-size:13px;padding:20px 0">Loading…</div>`;
  } else if (s._err) {
    kpiHtml = `<div style="color:var(--red);font-size:13px">Failed to load summary data</div>`;
  } else {
    const v = s.visits||{}, ex = s.executives||{}, ag = s.agencies||{};
    kpiHtml = `
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:8px">Visits</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px">
          ${_dcrKpi(fmtN(v.total||0), 'Total Visits', 'var(--primary)', null, "_dcrADrillVisitList()")}
          ${_dcrKpi(fmtN((v.agency_oracle||0)+(v.app_agent||0)), 'Agency Visits', 'var(--gold)', null, "_dcrADrillVisitList()")}
          ${_dcrKpi(fmtN(v.center_attendance||0), 'Center Attendance', 'var(--blue)')}
          ${_dcrKpi(fmtN((v.app_hawker||0)), 'Hawker Visits', 'var(--teal)')}
        </div>
      </div>
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:8px">Executives</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px">
          ${_dcrKpi(fmtN(ex.total||0), 'Total Execs', 'var(--ink)', null, "dcrASetTab('execs')")}
          ${_dcrKpi(fmtN(ex.with_dcr||0), 'With DCR', 'var(--grn)', null, "dcrASetTab('execs')")}
          ${_dcrKpi(fmtN(ex.without_dcr||0), 'Without DCR', 'var(--red)', null, '_dcrADrillWithoutDcr()')}
          ${_dcrKpi(fmtN(ex.active_in_period||0), 'Active in Period', 'var(--ink)', null, "dcrASetTab('execs')")}
        </div>
      </div>
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:8px">Agency Coverage</div>
        <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px;margin-bottom:8px">
          <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:8px">Total Agencies &nbsp;<span style="font-size:20px;color:var(--primary)">${fmtN(ag.total||0)}</span><span style="font-size:11px;color:var(--ink-2);margin-left:4px">(with supply or outstanding)</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
            <div style="display:flex;justify-content:space-between;padding:5px 8px;background:var(--surface-3,var(--surface-2));border-radius:6px;border-left:3px solid var(--grn)">
              <span style="color:var(--ink-2)">Active (supply running)</span>
              <b style="color:var(--grn)">${fmtN(ag.active||0)}</b>
            </div>
            <div style="display:flex;justify-content:space-between;padding:5px 8px;background:var(--surface-3,var(--surface-2));border-radius:6px;border-left:3px solid var(--red)">
              <span style="color:var(--ink-2)">Closed (stopped/suspended)</span>
              <b style="color:var(--red)">${fmtN(ag.closed||0)}</b>
            </div>
            <div onclick="_dcrADrillUnvisited()" role="button" style="display:flex;justify-content:space-between;padding:5px 8px;background:var(--surface-3,var(--surface-2));border-radius:6px;border-left:3px solid var(--gold);cursor:pointer" onmouseenter="this.style.outline='1px solid var(--gold)'" onmouseleave="this.style.outline=''">
              <span style="color:var(--ink-2)">Active with Outstanding</span>
              <b style="color:var(--gold)">${fmtN(ag.active_with_os||0)}</b>
            </div>
            <div style="display:flex;justify-content:space-between;padding:5px 8px;background:var(--surface-3,var(--surface-2));border-radius:6px;border-left:3px solid var(--orange,#f97316)">
              <span style="color:var(--ink-2)">Closed with Outstanding</span>
              <b style="color:var(--orange,#f97316)">${fmtN(ag.closed_with_os||0)}</b>
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px">
          ${_dcrKpi(fmtN(ag.visited||0), 'Visited This Period', 'var(--grn)', null, "_dcrADrillVisitList()")}
          ${_dcrKpi(fmtN(ag.not_visited||0), 'Not Visited', 'var(--red)', `of ${fmtN(ag.active||0)} active`, '_dcrADrillUnvisited()')}
          ${(()=>{const pct=(ag.visited||0)/(ag.active||1)*100;const s=pct===0?'0%':pct<1?'<1%':Math.round(pct)+'%';return ag.active?_dcrKpi(s,'Active Coverage',pct>60?'var(--grn)':pct>30?'var(--gold)':'var(--red)'):''})()}
        </div>
      </div>
      ${(()=>{
        const outcomes = s.outcomes||[];
        const isNumericPurpose = p => /^[\d,\s]+$/.test(String(p||''));
        const named = outcomes.filter(o=>o.purpose&&!isNumericPurpose(o.purpose));
        const unspecifiedCnt = outcomes.filter(o=>!o.purpose).reduce((a,o)=>a+(o.count||0),0);
        const unclassifiedCnt = outcomes.filter(o=>isNumericPurpose(o.purpose)).reduce((a,o)=>a+(o.count||0),0);
        const chips = [
          ...named.slice(0,6).map(o=>`<span onclick="_dcrADrillPurpose(${JSON.stringify(o.purpose)})" role="button" style="background:var(--surface-2);border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer;border:1px solid transparent" onmouseenter="this.style.borderColor='var(--primary)'" onmouseleave="this.style.borderColor='transparent'"><b>${fmtN(o.count)}</b> &nbsp; ${esc(o.purpose)}</span>`),
          unspecifiedCnt?`<span style="background:var(--surface-2);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--ink-2)"><b>${fmtN(unspecifiedCnt)}</b> &nbsp; Not specified</span>`:'',
          unclassifiedCnt?`<span style="background:var(--surface-2);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--ink-2)" title="Oracle system call-type IDs — no text description available"><b>${fmtN(unclassifiedCnt)}</b> &nbsp; Unclassified</span>`:'',
        ].filter(Boolean);
        return chips.length ? `
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:8px">Top Visit Purposes</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${chips.join('')}</div>
      </div>` : '';
      })()}
    `;
  }

  // Monthly trend table
  let monthlyHtml = '';
  if (!m) {
    monthlyHtml = `<div style="color:var(--ink-2);font-size:13px;padding:12px 0">Loading monthly data…</div>`;
  } else if (m._err) {
    monthlyHtml = `<div style="color:var(--red);font-size:12px">Monthly data unavailable</div>`;
  } else {
    const rows = (m.months || []).slice().reverse();
    monthlyHtml = `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:8px">Monthly Trend (Last 6 Months)</div>
      <div style="overflow-x:auto">
      <table class="tbl" style="font-size:12px;min-width:560px">
        <thead><tr>
          <th>Month</th><th class="r">Agency Visits</th><th class="r">Attendance</th>
          <th class="r">Hawker Visits</th><th class="r">Total</th><th class="r">Uniq. Agencies</th><th class="r">Execs</th>
        </tr></thead>
        <tbody>
        ${rows.map(r=>`<tr onclick="_dcrADrillMonth('${r.month}')" style="cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="font-weight:600;color:var(--primary)">${r.month} →</td>
          <td class="r">${fmtN(r.agency_visits)}</td>
          <td class="r">${fmtN(r.center_attendance)}</td>
          <td class="r">${fmtN(r.app_hawker)}</td>
          <td class="r" style="font-weight:600">${fmtN(r.total)}</td>
          <td class="r">${fmtN(r.uniq_agencies)}</td>
          <td class="r">${fmtN(r.exec_count)}</td>
        </tr>`).join('')||`<tr><td colspan="7" style="text-align:center;color:var(--ink-2)">No data</td></tr>`}
        </tbody>
      </table></div>`;
  }

  return kpiHtml + monthlyHtml;
}

/* ── Map tab ── */
function _dcrAMapTab() {
  _dcrALoadMap();
  const d = _dcrA.mapData;
  const status = !d ? 'Loading GPS agency data…'
    : d._err ? 'Failed to load map data'
    : `${d.count || 0} agencies mapped (GPS captured during DCR visits)`;
  const mapHtml = `
    <div style="font-size:12px;color:var(--ink-2);margin-bottom:10px">${status}</div>
    <div id="dcr-agency-map" style="height:520px;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);overflow:hidden"></div>
  `;
  if (d && !d._err && d.agencies?.length) {
    setTimeout(_initDcrAgencyMap, 100);
  }
  return mapHtml;
}

function _initDcrAgencyMap() {
  const el = document.getElementById('dcr-agency-map');
  if (!el || !window.L) return;

  // Destroy existing map
  if (_dcrMap) { _dcrMap.remove(); _dcrMap = null; }

  _dcrMap = L.map(el, { preferCanvas: true }).setView([26.0, 75.5], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom: 18
  }).addTo(_dcrMap);

  const agencies = (_dcrA.mapData?.agencies || []);
  const markerGroup = window.L.markerClusterGroup ? L.markerClusterGroup({ maxClusterRadius: 40 }) : L.layerGroup();

  agencies.forEach(a => {
    if (!a.lat || !a.lng) return;
    const isInactive = a.status === 'Inactive';
    const color = isInactive ? '#9ca3af' : '#2563eb';
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};border-radius:50%;width:10px;height:10px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
      iconSize: [10,10], iconAnchor: [5,5], popupAnchor: [0,-8]
    });
    const supply = a.supply != null ? `<b>${fmtN(a.supply)}</b> copies` : '—';
    const lastVisit = a.last_visit_date ? `${a.last_visit_date} by ${esc(a.last_exec_name||'—')}` : 'No visit recorded';
    const marker = L.marker([a.lat, a.lng], { icon });
    marker.bindTooltip(`<b>${esc(a.ag_name)}</b><br>${esc(a.city||a.district||'')}`, { permanent:false, direction:'top', opacity:0.95 });
    marker.bindPopup(`
      <div style="min-width:220px;font-size:12px;line-height:1.6">
        <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#1e293b">${esc(a.ag_name)}</div>
        <div><b>Code:</b> ${esc(a.agcd)}</div>
        <div><b>Unit:</b> ${esc(a.unit_code)} ${esc(a.unit_name||'')}</div>
        <div><b>District:</b> ${esc(a.district||'—')} &nbsp; <b>City:</b> ${esc(a.city||'—')}</div>
        <div><b>Class:</b> ${esc(a.ag_class||'—')}</div>
        <div><b>Supply:</b> ${supply}</div>
        <div><b>Status:</b> <span style="color:${isInactive?'#ef4444':'#16a34a'};font-weight:600">${esc(a.status)}</span></div>
        <div><b>Assigned to:</b> ${esc(a.field_officer||a.assigned_exec||'—')}</div>
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0"><b>Last DCR Visit:</b><br>${esc(lastVisit)}</div>
        ${fmtPurpose(a.last_purpose)?`<div><b>Purpose:</b> ${esc(fmtPurpose(a.last_purpose))}</div>`:''}
        ${a.last_remarks?`<div><b>Remarks:</b> ${remHtml(a.last_remarks).slice(0,160)}</div>`:''}
        <div style="margin-top:8px"><a href="#" onclick="event.preventDefault();_dcrADrillAgency('${esc(a.agcd)}','${esc(a.ag_name)}','${esc(a.unit_code||'')}')" style="color:#2563eb;font-size:11px;font-weight:600">View visit history →</a></div>
      </div>`, { maxWidth: 280 }
    );
    markerGroup.addLayer(marker);
  });

  _dcrMap.addLayer(markerGroup);
  if (agencies.length) {
    const bounds = agencies.filter(a=>a.lat&&a.lng).map(a=>[a.lat,a.lng]);
    if (bounds.length) _dcrMap.fitBounds(bounds, { padding: [30,30], maxZoom: 10 });
  }

  // Legend
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div');
    d.style.cssText = 'background:white;padding:8px 12px;border-radius:8px;font-size:11px;box-shadow:0 2px 8px rgba(0,0,0,.15)';
    d.innerHTML = `<div style="font-weight:700;margin-bottom:4px">Agency Status</div>
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2563eb;margin-right:6px;vertical-align:middle"></span>Active</div>
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#9ca3af;margin-right:6px;vertical-align:middle"></span>Inactive</div>
      <div style="margin-top:4px;color:#64748b">${agencies.filter(a=>a.lat&&a.lng).length} with GPS</div>`;
    return d;
  };
  legend.addTo(_dcrMap);
}

/* ── Executive Performance tab ── */
function _dcrAExecsTab() {
  _dcrALoadExecs();
  const d = _dcrA.execs;
  if (!d) return `<div style="color:var(--ink-2);font-size:13px;padding:20px 0">Loading executive data…</div>`;
  if (d._err) return `<div style="color:var(--red);font-size:13px">Failed to load executive data</div>`;
  const execs = d.executives || [];
  if (!execs.length) return `<div style="color:var(--ink-2);font-size:13px">No executive DCR data for this period</div>`;
  return `
    <div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">${execs.length} executives · ${d.period?.from} to ${d.period?.to}</div>
    <div style="overflow-x:auto">
    <table class="tbl" style="font-size:12px;min-width:640px">
      <thead><tr>
        <th style="text-align:left">Executive</th><th>Unit</th><th class="r">Agency Visits</th>
        <th class="r">Uniq. Agencies</th><th class="r">Working Days</th><th class="r">Avg/Day</th>
        <th class="r" title="Center check-in records (dcr_center_attendance) — a separate system from field-visit Working Days, so counts need not match">Center Attendance</th><th>Last Visit</th>
      </tr></thead>
      <tbody>
      ${execs.map((e,i)=>`<tr onclick="_dcrADrillExecutive('${esc(e.emp_code)}','${esc(e.name||e.emp_code||'')}')" style="${i<3?'font-weight:600;':''}cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
        <td style="color:var(--primary)">${esc(e.name||e.emp_code||'—')}</td>
        <td style="color:var(--ink-2)">${esc(e.unit_name||e.unit_code||'—')}</td>
        <td class="r">${fmtN(e.agency_visits)}</td>
        <td class="r">${fmtN(e.uniq_agencies)}</td>
        <td class="r">${fmtN(e.working_days)}</td>
        <td class="r" style="color:${e.avg_per_day>=3?'var(--grn)':e.avg_per_day>=1?'var(--gold)':'var(--red)'}"><b>${e.avg_per_day.toFixed(1)}</b></td>
        <td class="r">${fmtN(e.attendance)}</td>
        <td style="color:var(--ink-2);font-size:11px">${e.last_visit||'—'}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
}

/* ── Agency drill-down modal ── */
// Every "agency name" click in the app routes through the Agency 360° Profile
// page (see openAgencyProfile below) — this DCR-specific name is kept as a
// thin alias since ~7 call sites across DCR views still call it directly.
window._dcrADrillAgency = (agcd, name, unitCode) => {
  if (!unitCode) { toast('Cannot open profile — unit unknown for this agency'); return; }
  window.openAgencyProfile(unitCode, agcd, name);
};

/* ══════════════════ Agency 360° Profile — one landing page per agency,
   the single entry point every "agency name" click in the app routes
   through (DCR, Supply Dashboard, Collections, Agency Outstanding). ══ */
function apState() {
  S.agencyProfile = S.agencyProfile || { unitCode: null, agcd: null, name: null, data: null, loading: false, err: null, returnScreen: 'command' };
  return S.agencyProfile;
}
window.openAgencyProfile = (unitCode, agcd, name) => {
  if (!unitCode || !agcd) { toast('Agency code or unit missing'); return; }
  const st = apState();
  if (st.unitCode !== unitCode || st.agcd !== agcd) { st.data = null; st.err = null; }
  if (S.screen !== 'agency_profile') st.returnScreen = S.screen;
  st.unitCode = unitCode; st.agcd = agcd; st.name = name || agcd;
  go('agency_profile');
};
window.apBack = () => go(apState().returnScreen || 'command');
window.apRetry = () => { const st = apState(); st.err = null; st.data = null; render(); };

function _apFmtC(n) {
  n = Number(n) || 0; const a = Math.abs(n);
  let s; if (a >= 1e7) s = (a / 1e7).toFixed(2) + ' Cr'; else if (a >= 1e5) s = (a / 1e5).toFixed(2) + ' L'; else s = Math.round(a).toLocaleString('en-IN');
  return (n < 0 ? '-' : '') + '₹' + s;
}
function _apFmtN(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }
function _apDaysAgo(n) { return n == null ? 'Never' : n === 0 ? 'Today' : n === 1 ? '1 day ago' : n + ' days ago'; }

const AP_STATUS_STYLE = {
  'Healthy':            { color: 'var(--grn)',    bg: 'var(--grn-l, #e8f8ee)',  icon: '✅' },
  'Growth Opportunity': { color: 'var(--blue)',   bg: 'var(--blue-l, #e8f1fc)', icon: '🚀' },
  'Risk':               { color: 'var(--red)',    bg: '#fde8e8',                icon: '⚠️' },
  'Underperforming':    { color: 'var(--gold-d)', bg: '#fef3c7',                icon: '📉' },
};
const AP_TAG_LABEL = {
  URGENT_ACTION: 'Urgent Action', WIN_BACK: 'Win-back Opportunity', SUPPLY_AT_RISK: 'Supply At Risk',
  VISIT_OVERDUE: 'Visit Overdue', COLLECTION_RECOVERY: 'Collection Recovery',
  NO_VISIT_HISTORY: 'No Visit History', MONITOR: 'Monitor',
};

function _apFetch() {
  const st = apState();
  if (st.loading || st.data || st.err) return;
  st.loading = true;
  fetch(`${api.base}/api/agency-profile/${encodeURIComponent(st.unitCode)}/${encodeURIComponent(st.agcd)}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => {
      st.loading = false;
      if (d && d.detail) { st.err = d.detail; } else { st.data = d; }
      if (S.screen === 'agency_profile') render();
    })
    .catch(() => { st.err = 'Network error'; st.loading = false; if (S.screen === 'agency_profile') render(); });
}

function _apMonthBars(rows, key, color, unitLabel) {
  const asc = [...rows].reverse(); // API gives DESC by month; show chronologically
  const max = Math.max(1, ...asc.map(r => Number(r[key]) || 0));
  return asc.map(r => {
    const v = Number(r[key]) || 0;
    const pct = Math.round(v / max * 100);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px">
      <span style="width:52px;color:var(--ink-2)">${esc(r.month)}</span>
      <div style="flex:1;height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color}"></div></div>
      <span style="width:76px;text-align:right;font-weight:600">${_apFmtN(v)}${unitLabel || ''}</span>
    </div>`;
  }).join('') || `<div style="color:var(--ink-2);font-size:12px">No data</div>`;
}

function _apCard(icon, title, bodyHtml) {
  return `<div class="card" style="padding:16px">
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);margin-bottom:10px">${icon} ${title}</div>
    ${bodyHtml}
  </div>`;
}

function _apVisitRow(v) {
  const purpose = fmtPurpose(v.purpose);
  const amt = [];
  if (v.amount_collected) amt.push(`<span style="color:var(--grn)">✓ ${_apFmtC(v.amount_collected)} collected</span>`);
  if (v.commitment_amount) amt.push(`<span style="color:var(--gold-d)">↻ ${_apFmtC(v.commitment_amount)} promised${v.commitment_date ? ' by ' + esc(v.commitment_date) : ''}</span>`);
  if (v.copies_committed) amt.push(`<span style="color:var(--blue)">+${v.copies_committed} copies committed</span>`);
  return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
    <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px">
      <b>${esc(v.date || '—')}</b>
      <span style="color:var(--ink-2)">${esc(v.executive || '—')}${v.time ? ' · ' + esc(v.time) : ''}</span>
    </div>
    ${purpose ? `<div style="font-size:11px;color:var(--ink-2);margin-top:2px">${esc(purpose)}</div>` : ''}
    ${v.remarks ? `<div style="font-size:12px;margin-top:3px">${remHtml(v.remarks)}</div>` : ''}
    ${amt.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;font-size:11px;font-weight:600">${amt.join('')}</div>` : ''}
  </div>`;
}

VIEWS.agency_profile = () => {
  const st = apState();
  _apFetch();
  const header = `<div style="margin-bottom:10px"><button class="btn sm" onclick="apBack()">← Back</button></div>`;
  if (st.err) return header + `<div class="card pad" style="color:var(--red)">${esc(st.err)} <button class="btn sm" style="margin-left:8px" onclick="apRetry()">Retry</button></div>`;
  if (!st.data) return header + `<div class="card pad" style="color:var(--ink-2)">Loading ${esc(st.name || 'agency')} profile…</div>`;

  const d = st.data, id = d.identity, m = d.metrics, orisk = d.opportunity_risk;
  const ss = AP_STATUS_STYLE[d.status] || AP_STATUS_STYLE.Healthy;
  const idLine = [id.dist_name, id.city_name, id.unit_name, id.exec_name].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');

  const identityCard = `<div class="card" style="padding:18px;margin-bottom:14px">
    <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:flex-start">
      <div>
        <div style="font-size:20px;font-weight:800">${esc(id.ag_name)}</div>
        <div style="font-size:12px;color:var(--ink-2);margin-top:3px">${idLine}</div>
        <div style="font-size:11px;color:var(--ink-3);margin-top:2px">Code ${esc(id.agcd)} · ${esc(id.unit_code)}${(id.station_name || id.station_code) ? ' · Station ' + esc(id.station_name || id.station_code) : ''}${id.mobile_no1 ? ' · 📞 ' + esc(id.mobile_no1) : ''}</div>
        ${id.exec_location ? `<div style="font-size:11px;color:var(--ink-3);margin-top:2px">👔 Executive base: ${esc(id.exec_location.address || (id.exec_location.lat + ', ' + id.exec_location.lng))}</div>` : ''}
      </div>
      <div style="background:${ss.bg};color:${ss.color};border-radius:10px;padding:8px 16px;font-weight:700;font-size:13px;white-space:nowrap">${ss.icon} ${esc(d.status)}</div>
    </div>
  </div>`;

  const trendArrow = m.supply_trend_pct == null ? '' : m.supply_trend_pct >= 0 ? '▲' : '▼';
  const trendStatus = m.supply_trend_pct == null ? 'mute' : m.supply_trend_pct >= 0 ? 'good' : 'bad';
  const collStatus = m.collection_efficiency_pct == null ? 'mute' : m.collection_efficiency_pct >= 80 ? 'good' : m.collection_efficiency_pct >= 50 ? 'warn' : 'bad';
  const visitStatus = m.last_visit_days_ago == null ? 'bad' : m.last_visit_days_ago <= 7 ? 'good' : m.last_visit_days_ago <= 21 ? 'warn' : 'bad';
  const chips = `<div class="vz-kgrid" style="margin-bottom:14px">
    ${vzKpi({ icon: '📦', label: 'Current Supply', value: _apFmtN(m.current_supply) + ' cp', status: 'info' })}
    ${vzKpi({ icon: '📈', label: 'Supply Trend', value: (m.supply_trend_pct == null ? '—' : trendArrow + ' ' + Math.abs(m.supply_trend_pct) + '%'), sub: 'vs last month', status: trendStatus })}
    ${vzKpi({ icon: '💳', label: 'Collection Efficiency', value: (m.collection_efficiency_pct == null ? '—' : m.collection_efficiency_pct + '%'), status: collStatus })}
    ${vzKpi({ icon: '💰', label: 'Outstanding', value: _apFmtC(m.outstanding), status: m.outstanding > 100000 ? 'bad' : m.outstanding > 0 ? 'warn' : 'good' })}
    ${vzKpi({ icon: '🎯', label: 'Growth Potential', value: '+' + _apFmtN(m.growth_potential_copies) + ' cp', status: m.growth_potential_copies > 0 ? 'info' : 'mute' })}
    ${vzKpi({ icon: '🗓', label: 'Last Visit', value: _apDaysAgo(m.last_visit_days_ago), sub: m.last_visit_date || '', status: visitStatus })}
  </div>`;

  const brief = `<div class="card" style="padding:16px;margin-bottom:14px;border-left:4px solid ${ss.color}">
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);margin-bottom:8px">🤖 AI Agency Brief</div>
    <div style="font-size:13.5px;line-height:1.5">${esc(d.ai_brief.summary)}</div>
  </div>`;

  const perfBody = `<div style="font-size:11px;color:var(--ink-2);margin-bottom:6px">Supply (copies/month)</div>
    ${_apMonthBars(d.trends.supply_history, 'total_supply', 'var(--blue)')}
    <div style="font-size:11px;color:var(--ink-2);margin:10px 0 6px">Collection (₹/month)</div>
    ${_apMonthBars(d.trends.collection_history, 'collection', 'var(--grn)')}`;

  const riskBody = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${orisk.tags.map(t => `<span style="background:var(--surface-2);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600">${AP_TAG_LABEL[t] || t}</span>`).join('')}
    </div>
    <div style="font-size:12.5px"><b>Expected outcome:</b> ${esc(orisk.expected_outcome)}</div>
    ${orisk.decline_pct != null ? `<div style="font-size:12px;color:var(--ink-2);margin-top:6px">30-day peak: ${_apFmtN(orisk.peak30_supply)} cp · change ${orisk.decline_pct}%</div>` : ''}`;

  const visitBody = d.visits.length
    ? `<div style="max-height:280px;overflow-y:auto">${d.visits.slice(0, 15).map(_apVisitRow).join('')}</div>`
    : `<div style="color:var(--ink-2);font-size:12px">No visits recorded in the last 6 months</div>`;

  const nearbyBody = d.nearby.length
    ? d.nearby.map(n => `<div onclick="openAgencyProfile('${esc(id.unit_code)}','${esc(n.agcd).replace(/'/g, "\\'")}','${esc(n.ag_name).replace(/'/g, "\\'")}')" style="cursor:pointer;padding:6px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px">
        <span><b style="color:var(--primary)">${esc(n.ag_name)}</b> <span style="color:var(--ink-2)">${n.distance_km} km</span></span>
        <span style="color:${n.outstanding > 0 ? 'var(--red)' : 'var(--ink-2)'}">${n.outstanding > 0 ? _apFmtC(n.outstanding) : ''}</span>
      </div>`).join('')
    : `<div style="color:var(--ink-2);font-size:12px">No agencies within 5km with a GPS fix on record</div>`;

  const issuesBody = d.issues.length
    ? d.issues.map(i => `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
        <b>${esc(i.date || '—')}</b> <span style="color:var(--ink-2)">${esc(i.executive || '')}</span>
        <div style="margin-top:2px">${remHtml((i.remarks || '').slice(0, 140))}</div>
      </div>`).join('')
    : `<div style="color:var(--ink-2);font-size:12px">No complaint-flagged remarks in the last 6 months</div>`;

  const collBody = d.collection_recent.length
    ? `<div style="max-height:220px;overflow-y:auto"><table class="tbl" style="font-size:12px;width:100%">
        <thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Mode</th><th class="r">Amount</th></tr></thead>
        <tbody>${d.collection_recent.map(c => `<tr><td>${esc(c.date)}</td><td style="color:var(--ink-2)">${esc(c.payment_mode || '—')}</td><td class="r">${_apFmtC(c.amount)}</td></tr>`).join('')}</tbody>
      </table></div>`
    : `<div style="color:var(--ink-2);font-size:12px">No collection transactions in the last 90 days</div>`;

  const sixCards = `<div class="two" style="margin-bottom:14px">
      ${_apCard('📈', 'Performance Trends', perfBody)}
      ${_apCard('🚀', 'Opportunity &amp; Risk', riskBody)}
    </div>
    <div class="two" style="margin-bottom:14px">
      ${_apCard('🎯', 'Visit Intelligence', visitBody)}
      ${_apCard('📍', 'Nearby Agency Intelligence', nearbyBody)}
    </div>
    <div class="two" style="margin-bottom:14px">
      ${_apCard('⚠️', 'Issues &amp; Complaints', issuesBody)}
      ${_apCard('💰', 'Collection Insights', collBody)}
    </div>`;

  const nba = `<div class="card" style="padding:16px;border-left:4px solid var(--gold-d)">
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);margin-bottom:8px">🧠 AI Next Best Action</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">
      ${d.next_best_action.map(a => `<li>${esc(a)}</li>`).join('')}
    </ul>
  </div>`;

  return header + identityCard + chips + brief + sixCards + nba;
};

/* ── DCR drill-down modals ── */

// Generic visit list modal (all visits in period, or filtered by emp_code)
window._dcrADrillVisitList = async (empCode, empName) => {
  const label = empName ? `visits for ${esc(empName)}` : 'all visits';
  modal(`<div style="color:var(--ink-2);font-size:13px;padding:24px 0;text-align:center">Loading ${label}…</div>`);
  try {
    const qs = `from=${_dcrA.from}&to=${_dcrA.to}${empCode?'&emp_code='+encodeURIComponent(empCode):''}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
    const d = await api.get(`/api/dcr-analytics/visit-list?${qs}`);
    if (!d) return;
    const visits = d.visits || [];
    modal(`<h3 style="margin-bottom:4px">${empName ? esc(empName) : 'All DCR Visits'}</h3>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">${d.period?.from} to ${d.period?.to} · ${visits.length} visits</div>
      <div style="max-height:420px;overflow-y:auto">
      <table class="tbl" style="font-size:12px;min-width:560px">
        <thead><tr><th>Date</th><th>Time</th><th>Agency</th><th>Executive</th><th>Remarks</th><th>GPS</th></tr></thead>
        <tbody>
        ${visits.map(v=>`<tr onclick="_dcrADrillAgency('${esc(v.agcd)}','${esc(v.ag_name||v.agcd||'')}','${esc(v.unit_code||'')}')" style="cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="white-space:nowrap">${esc(v.visit_date||'—')}</td>
          <td style="color:var(--ink-2);font-size:11px;white-space:nowrap">${esc(v.from_time||'—')}</td>
          <td style="color:var(--primary)"><b>${esc(v.ag_name||v.agcd||'—')}</b>${v.city?` <span style="font-size:10px;color:var(--ink-2)">${esc(v.city)}</span>`:''}</td>
          <td style="font-size:11px">${esc(v.executive_name||'—')}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${remHtml(v.visit_remarks||'')}">${remHtml((v.visit_remarks||'').slice(0,60))||'—'}</td>
          <td style="text-align:center">${v.lat?'📍':'—'}</td>
        </tr>`).join('')||`<tr><td colspan="6" style="text-align:center;color:var(--ink-2)">No visits</td></tr>`}
        </tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn" onclick="closeModals()">Close</button></div>`);
  } catch(e) { console.error(e); }
};

// Executive drill-down: agency visits AND center check-in attendance side by side —
// these are two separate DCR data sources (see "Center Attendance" column tooltip).
window._dcrADrillExecutive = async (empCode, empName) => {
  modal(`<div style="color:var(--ink-2);font-size:13px;padding:24px 0;text-align:center">Loading ${esc(empName||'executive')}…</div>`);
  try {
    const baseQs = `from=${_dcrA.from}&to=${_dcrA.to}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
    const [vd, cd] = await Promise.all([
      api.get(`/api/dcr-analytics/visit-list?${baseQs}&emp_code=${encodeURIComponent(empCode)}`),
      api.get(`/api/dcr-analytics/center-attendance-list?${baseQs}&emp_code=${encodeURIComponent(empCode)}`),
    ]);
    const visits = (vd && vd.visits) || [];
    const attn = (cd && cd.records) || [];
    const fmtDt = t => t ? String(t).slice(11,16) : '—';

    const attnTable = `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin:14px 0 6px">🏢 Center Attendance — ${attn.length} check-in${attn.length===1?'':'s'}</div>
      <div style="max-height:180px;overflow-y:auto">
      <table class="tbl" style="font-size:12px;min-width:520px">
        <thead><tr><th>Date</th><th>Center</th><th>Check-in</th><th>Check-out</th><th>Remarks</th><th>GPS</th></tr></thead>
        <tbody>
        ${attn.map(r=>`<tr>
          <td style="white-space:nowrap">${esc(r.attn_date||'—')}</td>
          <td>${esc(r.center_name||'—')}</td>
          <td style="color:var(--ink-2);font-size:11px;white-space:nowrap">${fmtDt(r.check_in)}</td>
          <td style="color:var(--ink-2);font-size:11px;white-space:nowrap">${fmtDt(r.check_out)}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${remHtml(r.remarks||'')}">${remHtml((r.remarks||'').slice(0,50))||'—'}</td>
          <td style="text-align:center">${r.lat?'📍':'—'}</td>
        </tr>`).join('')||`<tr><td colspan="6" style="text-align:center;color:var(--ink-2)">No center check-ins this period</td></tr>`}
        </tbody>
      </table></div>`;

    const visitTable = `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin:14px 0 6px">📍 Agency Visits — ${visits.length}</div>
      <div style="max-height:320px;overflow-y:auto">
      <table class="tbl" style="font-size:12px;min-width:560px">
        <thead><tr><th>Date</th><th>Time</th><th>Agency</th><th>Remarks</th><th>GPS</th></tr></thead>
        <tbody>
        ${visits.map(v=>`<tr onclick="_dcrADrillAgency('${esc(v.agcd)}','${esc(v.ag_name||v.agcd||'')}','${esc(v.unit_code||'')}')" style="cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="white-space:nowrap">${esc(v.visit_date||'—')}</td>
          <td style="color:var(--ink-2);font-size:11px;white-space:nowrap">${esc(v.from_time||'—')}</td>
          <td style="color:var(--primary)"><b>${esc(v.ag_name||v.agcd||'—')}</b>${v.city?` <span style="font-size:10px;color:var(--ink-2)">${esc(v.city)}</span>`:''}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${remHtml(v.visit_remarks||'')}">${remHtml((v.visit_remarks||'').slice(0,60))||'—'}</td>
          <td style="text-align:center">${v.lat?'📍':'—'}</td>
        </tr>`).join('')||`<tr><td colspan="5" style="text-align:center;color:var(--ink-2)">No agency visits this period</td></tr>`}
        </tbody>
      </table></div>`;

    modal(`<h3 style="margin-bottom:4px">${esc(empName||empCode)}</h3>
      <div style="font-size:12px;color:var(--ink-2)">${vd?.period?.from||_dcrA.from} to ${vd?.period?.to||_dcrA.to}</div>
      ${attnTable}
      ${visitTable}
      <div style="margin-top:12px"><button class="btn" onclick="closeModals()">Close</button></div>`);
  } catch(e) { console.error(e); }
};

window._dcrADrillPurpose = async (purpose) => {
  modal(`<div style="color:var(--ink-2);font-size:13px;padding:24px 0;text-align:center">Loading visits…</div>`);
  try {
    const qs = `from=${_dcrA.from}&to=${_dcrA.to}&purpose=${encodeURIComponent(purpose)}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}`;
    const d = await api.get(`/api/dcr-analytics/visit-list?${qs}`);
    if (!d) return;
    const visits = d.visits || [];
    modal(`<h3 style="margin-bottom:4px">Visits — Purpose: ${esc(purpose||'Not specified')}</h3>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">${d.period?.from} to ${d.period?.to} · ${visits.length} visits</div>
      <div style="max-height:420px;overflow-y:auto">
      <table class="tbl" style="font-size:12px;min-width:500px">
        <thead><tr><th>Date</th><th>Agency</th><th>Executive</th><th>Remarks</th></tr></thead>
        <tbody>
        ${visits.map(v=>`<tr onclick="_dcrADrillAgency('${esc(v.agcd)}','${esc(v.ag_name||v.agcd||'')}','${esc(v.unit_code||'')}')" style="cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="white-space:nowrap">${esc(v.visit_date||'—')}</td>
          <td style="color:var(--primary)">${esc(v.ag_name||v.agcd||'—')}</td>
          <td style="font-size:11px">${esc(v.executive_name||'—')}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${remHtml(v.visit_remarks||'')}">${remHtml((v.visit_remarks||'').slice(0,70))||'—'}</td>
        </tr>`).join('')||`<tr><td colspan="4" style="text-align:center;color:var(--ink-2)">No visits</td></tr>`}
        </tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn" onclick="closeModals()">Close</button></div>`);
  } catch(e) { console.error(e); }
};

window._dcrADrillWithoutDcr = async () => {
  modal(`<div style="color:var(--ink-2);font-size:13px;padding:24px 0;text-align:center">Loading executives without DCR…</div>`);
  try {
    const qs = `from=${_dcrA.from}&to=${_dcrA.to}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
    const d = await api.get(`/api/dcr-analytics/execs-without-dcr?${qs}`);
    if (!d) return;
    const execs = d.executives || [];
    modal(`<h3 style="margin-bottom:4px">Executives Without DCR</h3>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">${d.period?.from} to ${d.period?.to} · ${execs.length} executives</div>
      <div style="max-height:420px;overflow-y:auto">
      <table class="tbl" style="font-size:12px">
        <thead><tr><th style="text-align:left">Name</th><th>Unit</th><th>Emp Code</th></tr></thead>
        <tbody>
        ${execs.map(e=>`<tr>
          <td>${esc(e.name||'—')}</td>
          <td style="color:var(--ink-2)">${esc(e.unit_name||e.unit_code||'—')}</td>
          <td style="color:var(--ink-2);font-size:11px">${esc(e.employee_code||'—')}</td>
        </tr>`).join('')||`<tr><td colspan="3" style="text-align:center;color:var(--ink-2)">All executives have DCR this period</td></tr>`}
        </tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn" onclick="closeModals()">Close</button></div>`);
  } catch(e) { console.error(e); }
};

window._dcrADrillUnvisited = async () => {
  modal(`<div style="color:var(--ink-2);font-size:13px;padding:24px 0;text-align:center">Loading unvisited agencies…</div>`);
  try {
    const qs = `from=${_dcrA.from}&to=${_dcrA.to}${_dcrA.unit_code?'&unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
    const d = await api.get(`/api/dcr-analytics/unvisited-agencies?${qs}`);
    if (!d) return;
    const agencies = d.agencies || [];
    modal(`<h3 style="margin-bottom:4px">Active Agencies — No Visit This Period</h3>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">${d.period?.from} to ${d.period?.to} · ${agencies.length} agencies (sorted by outstanding ↓)</div>
      <div style="max-height:420px;overflow-y:auto">
      <table class="tbl" style="font-size:12px;min-width:560px">
        <thead><tr><th style="text-align:left">Agency</th><th>Unit</th><th>District</th><th>Class</th><th class="r">Outstanding</th><th style="text-align:left">Assigned</th></tr></thead>
        <tbody>
        ${agencies.map(a=>`<tr onclick="_dcrADrillAgency('${esc(a.agcd)}','${esc(a.ag_name||a.agcd||'')}','${esc(a.unit_code||'')}')" style="cursor:pointer" onmouseenter="this.style.background='var(--surface-2)'" onmouseleave="this.style.background=''">
          <td style="color:var(--primary)"><b>${esc(a.ag_name||a.agcd||'—')}</b> <span style="font-size:10px;color:var(--ink-2)">${esc(a.city||'')}</span></td>
          <td style="color:var(--ink-2)">${esc(a.unit_code||'—')}</td>
          <td style="color:var(--ink-2)">${esc(a.district||'—')}</td>
          <td style="font-size:11px">${esc(a.ag_class||'—')}</td>
          <td class="r" style="color:var(--red)">${a.outstanding?fmtC(Number(a.outstanding)):'—'}</td>
          <td style="font-size:11px">${esc(a.assigned_exec||'—')}</td>
        </tr>`).join('')||`<tr><td colspan="6" style="text-align:center;color:var(--ink-2)">All active agencies visited</td></tr>`}
        </tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn" onclick="closeModals()">Close</button></div>`);
  } catch(e) { console.error(e); }
};

window._dcrADrillMonth = (month) => {
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  _dcrA.from = `${month}-01`;
  _dcrA.to   = `${month}-${String(lastDay).padStart(2,'0')}`;
  const fromEl = document.getElementById('dcrA-from');
  const toEl   = document.getElementById('dcrA-to');
  if (fromEl) fromEl.value = _dcrA.from;
  if (toEl)   toEl.value   = _dcrA.to;
  _dcrA.execs = null; _dcrA._loadE = false;
  _dcrA.tab = 'execs';
  render();
};

/* ── Apply filter ── */
window._dcrAStateChange = () => {
  const state = document.getElementById('dcrA-state')?.value || '';
  const unitSel = document.getElementById('dcrA-unit');
  const allUnits = _dcrA.units || [];
  const filtered = state ? allUnits.filter(u => u.state === state) : allUnits;
  const current = unitSel?.value || '';
  if (unitSel) {
    unitSel.innerHTML = `<option value="">All Units</option>` +
      filtered.map(u => `<option value="${esc(u.unit_code)}" ${u.unit_code===current&&filtered.some(f=>f.unit_code===current)?'selected':''}>${esc(u.unit_name)}</option>`).join('');
    if (current && !filtered.some(u => u.unit_code === current)) unitSel.value = '';
  }
};

function _dcrALoadAnalysis(force) {
  if (_dcrA._loadAn || (_dcrA.analysis && !force)) return;
  _dcrA._loadAn = true; _dcrA.analysis = null;
  fetch(_dcrAUrl('visit-analysis'), { headers: api.h() })
    .then(r => r.json()).then(d => { _dcrA.analysis = d; _dcrA._loadAn = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.analysis = { _err: true }; _dcrA._loadAn = false; if (S.screen === 'dcr_analytics') render(); });
}
function _dcrALoadCoverage(force) {
  if (_dcrA._loadCov || (_dcrA.coverage && !force)) return;
  _dcrA._loadCov = true; _dcrA.coverage = null;
  fetch(_dcrAUrl('agency-coverage'), { headers: api.h() })
    .then(r => r.json()).then(d => { _dcrA.coverage = d; _dcrA._loadCov = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.coverage = { _err: true }; _dcrA._loadCov = false; if (S.screen === 'dcr_analytics') render(); });
}
/* Tour Plan Analysis — verdict on each executive's submitted plan for one date.
   Keyed by date+unit so switching either refetches; the sweep runs one executive at a
   time server-side (~0.3s each), so a full 45-executive day takes a few seconds. */
window.dcrATpDate = v => { _dcrA.tpDate = v; _dcrA.tourPlanChk = null; _dcrA._loadTpc = false; _dcrA.tpOpen = ''; render(); };
window.dcrATpToggle = k => { _dcrA.tpOpen = (_dcrA.tpOpen === k ? '' : k); render(); };
function _dcrALoadTourPlanCheck(force) {
  const date = _dcrA.tpDate || todayISO();
  const key  = date + '|' + (_dcrA.unit_code || '');
  if (_dcrA._loadTpc || (_dcrA.tourPlanChk && _dcrA._tpcKey === key && !force)) return;
  _dcrA._loadTpc = true; _dcrA.tourPlanChk = null; _dcrA._tpcKey = key;
  const qs = 'date=' + encodeURIComponent(date) + (_dcrA.unit_code ? '&unit_code=' + encodeURIComponent(_dcrA.unit_code) : '');
  fetch(`${location.origin}/api/tour-plan-validation?${qs}`, { headers: api.h() })
    .then(r => r.json()).then(d => { _dcrA.tourPlanChk = d; _dcrA._loadTpc = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.tourPlanChk = { _err: true }; _dcrA._loadTpc = false; if (S.screen === 'dcr_analytics') render(); });
}
function _dcrALoadRemarks(force) {
  if (_dcrA._loadRem || (_dcrA.remarks && !force)) return;
  _dcrA._loadRem = true; _dcrA.remarks = null; _dcrA.aiResults = null;
  const url = _dcrAUrl('visit-remarks') + (_dcrA.remEmpCode ? '&emp_code=' + encodeURIComponent(_dcrA.remEmpCode) : '');
  fetch(url, { headers: api.h() })
    .then(r => r.json()).then(d => { _dcrA.remarks = d; _dcrA._loadRem = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.remarks = { _err: true }; _dcrA._loadRem = false; if (S.screen === 'dcr_analytics') render(); });
}
function _dcrALoadPlanExecs() {
  if (_dcrA._loadPlanExecs || _dcrA.planExecs) return;
  // Reuse tourExecs if already loaded
  if (_dcrA.tourExecs?.executives) { _dcrA.planExecs = _dcrA.tourExecs.executives; return; }
  _dcrA._loadPlanExecs = true;
  const qs = `${_dcrA.unit_code?'unit_code='+encodeURIComponent(_dcrA.unit_code):''}${_dcrA.state?'&state='+encodeURIComponent(_dcrA.state):''}`;
  fetch(`${location.origin}/api/dcr-analytics/executive-list?${qs}`, { headers: api.h() })
    .then(r => r.json()).then(d => { _dcrA.planExecs = d.executives || []; _dcrA._loadPlanExecs = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.planExecs = []; _dcrA._loadPlanExecs = false; });
}
window.dcrAAnalyzeRemarks = async () => {
  const visits = (_dcrA.remarks?.visits || []).map(v => ({
    visit_date: v.visit_date, executive_name: v.executive_name,
    ag_name: v.ag_name || v.ag_code, purpose: v.visit_purpose,
    remarks: v.visit_remarks,
  }));
  if (!visits.length) return;
  _dcrA._analyzing = true; render();
  try {
    const r = await fetch('/api/dcr-analytics/analyze-remarks', {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ visits }),
    });
    const d = await r.json();
    if (!r.ok) {
      _dcrA.aiResults = null;
      toast(r.status === 503
        ? '⚠ AI not configured — set ANTHROPIC_API_KEY in the server .env'
        : '⚠ AI analysis failed: ' + (d.detail || r.status));
    } else if (!(d.results || []).length) {
      _dcrA.aiResults = null;
      toast('⚠ AI returned no results — try again');
    } else {
      _dcrA.aiResults = d.results;
      _dcrA.aiModel   = d.model || 'Claude';
    }
  } catch (e) { _dcrA.aiResults = null; toast('⚠ AI analysis failed: ' + e.message); }
  _dcrA._analyzing = false;
  if (S.screen === 'dcr_analytics') render();
};
window.dcrAGenPlan = async () => {
  const code = _dcrA.planEmpCode;
  if (!code) return;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const planDate = _dcrA.planDate || tomorrow;
  _dcrA._loadingPlan = true; _dcrA.plan = null; _dcrA._planGenStart = Date.now(); render();
  const ticker = setInterval(() => { if (S.screen === 'dcr_analytics') render(); }, 1000);
  try {
    const r = await fetch('/api/dcr-analytics/next-day-plan', {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ emp_code: code, plan_date: planDate }),
    });
    const d = await r.json();
    _dcrA.plan = d;
  } catch (_) { _dcrA.plan = { _err: true }; }
  clearInterval(ticker);
  _dcrA._loadingPlan = false;
  if (S.screen === 'dcr_analytics') render();
};

/* ── DCR live sync (triggers oracle_dcr_sync.js → yesterday+today) ── */
let _dcrSyncing = false;
function dcrTriggerSync() {
  if (_dcrSyncing) { toast('Sync already in progress…'); return; }
  _dcrSyncing = true;
  toast('Starting DCR sync (latest visits + attendance)…');
  fetch(`${location.origin.replace(':8123',':8001')}/api/sync/dcr`, {
    method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json()).then(d => {
    if (d.error) { _dcrSyncing = false; toast('Sync error: ' + d.error); return; }
    toast('DCR sync started — Oracle→MySQL takes ~1 min');
    dcrPollSyncStatus();
  }).catch(e => { _dcrSyncing = false; toast('Could not start sync: ' + e.message); });
}
function dcrPollSyncStatus() {
  fetch(`${location.origin.replace(':8123',':8001')}/api/sync/dcr/status`, { headers: api.h() })
    .then(r => r.json()).then(d => {
      if (d.running) {
        const last = d.recentLog?.slice(-1)[0] || '…';
        toast('DCR sync: ' + last);
        setTimeout(dcrPollSyncStatus, 8000);
      } else {
        _dcrSyncing = false;
        if (d.status === 'success') {
          toast('✅ DCR sync complete. Refreshing…');
          // Refresh all DCR data
          _dcrA.summary=_dcrA.monthly=_dcrA.execs=_dcrA.mapData=_dcrA.tourExecs=_dcrA.tourData=_dcrA.teamData=null;
          _dcrA._loadS=_dcrA._loadM=_dcrA._loadE=_dcrA._loadMap=_dcrA._loadTE=_dcrA._loadTour=_dcrA._loadTeam=false;
          if (S.screen === 'dcr_analytics') render();
        } else if (d.status === 'error') {
          toast('Sync failed: ' + (d.error || 'unknown error'));
        }
      }
    }).catch(() => { _dcrSyncing = false; });
}
window.dcrTriggerSync = dcrTriggerSync;

window.dcrAApplyFilter = () => {
  _dcrA.from = document.getElementById('dcrA-from')?.value || _dcrA.from;
  _dcrA.to   = document.getElementById('dcrA-to')?.value   || _dcrA.to;
  _dcrA.unit_code = document.getElementById('dcrA-unit')?.value || '';
  _dcrA.state     = document.getElementById('dcrA-state')?.value || '';
  _dcrA.summary = _dcrA.monthly = _dcrA.execs = _dcrA.mapData = null;
  _dcrA._loadS = _dcrA._loadM = _dcrA._loadE = _dcrA._loadMap = false;
  _dcrA.tourExecs = null; _dcrA._loadTE = false;
  _dcrA.tourDays = null; _dcrA._loadDays = false;
  _dcrA.analysis = null; _dcrA._loadAn = false;
  _dcrA.coverage = null; _dcrA._loadCov = false;
  _dcrA.remarks = null; _dcrA._loadRem = false; _dcrA.aiResults = null;
  _dcrA.plan = null; _dcrA.planExecs = null; _dcrA._loadPlanExecs = false;
  if (_dcrMap) { _dcrMap.remove(); _dcrMap = null; }
  if (_dcrTourMap) { _dcrTourMap.remove(); _dcrTourMap = null; }
  render();
};

window.dcrASetTab = t => { _dcrA.tab = t; render(); };

/* ── Main view ── */
VIEWS.dcr_analytics = () => {
  // _dcrA is a plain module-level object created before login, so the PAN-India admin
  // default (see _isPanIndiaAdmin) is applied once here instead, on first render.
  if (!_dcrA._defaultsApplied) {
    _dcrA._defaultsApplied = true;
    if (_isPanIndiaAdmin() && !_dcrA.state && !_dcrA.unit_code) { _dcrA.state = 'Rajasthan'; _dcrA.unit_code = 'JA0'; }
  }
  const tab = _dcrA.tab;
  const hdr = pagehead('DCR - Field Visit Analysis', 'DCR analytics — agency visits, center attendance, GPS mapping & executive performance');

  _dcrALoadUnits();
  const allUnits = _dcrA.units || [];
  const filteredUnits = _dcrA.state ? allUnits.filter(u => u.state === _dcrA.state) : allUnits;
  const unitOpts = `<option value="">All Units</option>` +
    filteredUnits.map(u => `<option value="${esc(u.unit_code)}" ${_dcrA.unit_code===u.unit_code?'selected':''}>${esc(u.unit_name)}</option>`).join('');
  const sel = s => `font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)`;

  const filterBar = `
    <div class="card" style="padding:10px 14px;margin-bottom:12px">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px">
          <label style="color:var(--ink-2);white-space:nowrap">From</label>
          <input type="date" id="dcrA-from" value="${_dcrA.from}" style="${sel()}">
          <label style="color:var(--ink-2)">To</label>
          <input type="date" id="dcrA-to" value="${_dcrA.to}" style="${sel()}">
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px">
          <label style="color:var(--ink-2)">State</label>
          <select id="dcrA-state" onchange="_dcrAStateChange()" style="${sel()}">
            ${(() => { const ss=[...new Set(allUnits.map(u=>u.state))].sort(); return (ss.length>1?'<option value="">All States</option>':'')+ss.map(s=>`<option value="${esc(s)}" ${_dcrA.state===s?'selected':''}>${esc(s)}</option>`).join(''); })()}
          </select>
          <label style="color:var(--ink-2)">Unit</label>
          <select id="dcrA-unit" style="${sel()};max-width:180px">${unitOpts}</select>
        </div>
        <button class="btn sm pri" onclick="dcrAApplyFilter()">Apply</button>
        <button class="btn sm" onclick="_dcrA.from=monthStartISO();_dcrA.to=todayISO();_dcrA.unit_code='';_dcrA.state='';_dcrA.summary=_dcrA.monthly=_dcrA.execs=_dcrA.mapData=_dcrA.tourExecs=_dcrA.tourData=null;_dcrA._loadS=_dcrA._loadM=_dcrA._loadE=_dcrA._loadMap=_dcrA._loadTE=_dcrA._loadTour=false;if(_dcrMap){_dcrMap.remove();_dcrMap=null;}if(_dcrTourMap){_dcrTourMap.remove();_dcrTourMap=null;}render()">Reset</button>
        <button class="btn sm" onclick="dcrTriggerSync()" style="background:var(--navy);color:#fff;margin-left:auto" title="Sync latest DCR visits from Oracle">🔄 Sync Live Data</button>
      </div>
    </div>`;

  const tabs = `<div class="seg" style="margin-bottom:12px;flex-wrap:wrap;gap:4px">
    <button class="${tab==='summary'?'on':''}"  onclick="dcrASetTab('summary')">📊 Summary</button>
    <button class="${tab==='map'?'on':''}"      onclick="dcrASetTab('map')">📍 Agency Map</button>
    <button class="${tab==='execs'?'on':''}"    onclick="dcrASetTab('execs')">👤 Executives</button>
    <button class="${tab==='team'?'on':''}"     onclick="dcrASetTab('team')">📡 Team Live</button>
    <button class="${tab==='tour'?'on':''}"     onclick="dcrASetTab('tour')">🗺 Tour Route</button>
    <button class="${tab==='analysis'?'on':''}" onclick="dcrASetTab('analysis')">📈 Visit Analysis</button>
    <button class="${tab==='coverage'?'on':''}" onclick="dcrASetTab('coverage')">⚠️ Agency Coverage</button>
    <button class="${tab==='remarks'?'on':''}"  onclick="dcrASetTab('remarks')">💬 AI Remarks</button>
    <button class="${tab==='tpcheck'?'on':''}"  onclick="dcrASetTab('tpcheck')">🧭 Tour Plan Analysis</button>
    <button class="${tab==='plan'?'on':''}"     onclick="dcrASetTab('plan')">📋 Next Day Plan</button>
    <button class="${tab==='weekplan'?'on':''}" onclick="dcrASetTab('weekplan')">📅 7-Day Tour Plan</button>
  </div>`;

  let body = '';
  if (tab === 'summary')  body = _dcrASummaryTab();
  else if (tab === 'map') body = _dcrAMapTab();
  else if (tab === 'execs') body = _dcrAExecsTab();
  else if (tab === 'team') body = _dcrATeamTab();
  else if (tab === 'tour') body = _dcrATourTab();
  else if (tab === 'analysis') body = _dcrAAnalysisTab();
  else if (tab === 'coverage') body = _dcrACoverageTab();
  else if (tab === 'remarks') body = _dcrARemarksTab();
  else if (tab === 'tpcheck') body = _dcrATourPlanCheckTab();
  else if (tab === 'plan') body = _dcrANextPlanTab();
  else if (tab === 'weekplan') body = _dcrAWeekPlanTab();

  return hdr + filterBar + tabs + `<div class="card pad">${body}</div>`;
};

/* ── SVG mini chart helpers ── */
function _dcrSvgBars(data, maxW, h) {
  if (!data.length) return '';
  const maxV = Math.max(...data.map(d => d.v), 1);
  const rowH = Math.min(22, Math.floor(h / data.length));
  const labelW = 140, barArea = maxW - labelW - 48;
  const svgH = rowH * data.length;
  const bars = data.map((d, i) => {
    const bw = Math.round(d.v / maxV * barArea);
    const y = i * rowH + 2;
    const color = d.color || 'var(--chart-1)';
    const label = (d.label || '').slice(0, 22);
    return `<text x="${labelW - 6}" y="${y + rowH/2 + 4}" text-anchor="end" font-size="10" fill="var(--ink-2)">${esc(label)}</text>
      <rect x="${labelW}" y="${y}" width="${Math.max(2, bw)}" height="${rowH - 4}" rx="3" fill="${color}" opacity=".85"/>
      <text x="${labelW + bw + 4}" y="${y + rowH/2 + 4}" font-size="10" fill="var(--ink)">${d.v}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${maxW} ${svgH}" style="width:100%;max-width:${maxW}px;height:${svgH}px;display:block">${bars}</svg>`;
}
function _dcrSvgLine(points, maxW, svgH) {
  if (!points.length) return '';
  const maxV = Math.max(...points.map(p => p.v), 1);
  const pad = 16;
  const W = maxW - pad * 2, H = svgH - pad * 2;
  const px = (i) => pad + i / Math.max(points.length - 1, 1) * W;
  const py = (v) => pad + H - Math.round(v / maxV * H);
  const pts = points.map((p, i) => `${px(i)},${py(p.v)}`).join(' ');
  const fill = points.map((p, i) => `${px(i)},${py(p.v)}`).join(' ') + ` ${px(points.length-1)},${pad+H} ${pad},${pad+H}`;
  const lastPt = points[points.length - 1];
  const labels = points.filter((_, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 5) === 0)
    .map(p => `<text x="${px(points.indexOf(p))}" y="${pad + H + 12}" text-anchor="middle" font-size="9" fill="var(--ink-2)">${(p.label||'').slice(5)}</text>`).join('');
  return `<svg viewBox="0 0 ${maxW} ${svgH}" style="width:100%;height:${svgH}px;display:block">
    <defs><linearGradient id="dcrLG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--chart-1)" stop-opacity=".25"/><stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${fill}" fill="url(#dcrLG)"/>
    <polyline points="${pts}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${labels}
    <circle cx="${px(points.length-1)}" cy="${py(lastPt.v)}" r="4" fill="var(--chart-1)"/>
    <text x="${px(points.length-1)}" y="${py(lastPt.v)-7}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--chart-1)">${lastPt.v}</text>
  </svg>`;
}

/* ── Analysis tab ── */
function _dcrAAnalysisTab() {
  _dcrALoadAnalysis();
  const d = _dcrA.analysis;
  if (_dcrA._loadAn) return '<div style="color:var(--ink-2);padding:40px 0;text-align:center">⏳ Loading visit analysis…</div>';
  if (!d) return '<div style="color:var(--ink-2);padding:40px 0;text-align:center">No data yet — apply a filter</div>';
  if (d._err) return '<div style="color:var(--red);padding:20px 0">Failed to load analysis data.</div>';

  const execs = d.executives || [];
  const purposes = d.purposes || [];
  const daily = d.daily_trend || [];

  const totalVisits = execs.reduce((s, e) => s + +e.total_visits, 0);
  const totalExecs  = execs.length;
  const totalAg     = execs.reduce((s, e) => s + +e.agencies_visited, 0);
  const avgPerDay   = daily.length ? Math.round(totalVisits / daily.length) : 0;

  const kpis = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
    ${[['Total Visits', totalVisits, 'var(--chart-1)'], ['Active Execs', totalExecs, 'var(--grn)'], ['Agencies Covered', totalAg, 'var(--blue)'], ['Avg/Day', avgPerDay, 'var(--purple)']].map(([l,v,c]) =>
      `<div style="flex:1;min-width:100px;background:var(--surface-2);border-radius:10px;padding:12px 14px">
        <div style="font-size:10px;font-weight:700;color:var(--ink-2);text-transform:uppercase;letter-spacing:.05em">${l}</div>
        <div style="font-size:24px;font-weight:800;color:${c};margin-top:2px">${v}</div>
      </div>`).join('')}
  </div>`;

  const execBars = execs.slice(0, 12).map(e => ({ label: e.exec_name || e.emp_code, v: +e.total_visits, color: 'var(--chart-1)' }));
  const purposeBars = purposes.map(p => ({ label: p.purpose.slice(0, 30), v: +p.cnt, color: 'var(--chart-2,#f59e0b)' }));
  const linePts = daily.map(d => ({ label: String(d.visit_day).slice(0,10), v: +d.cnt }));

  const charts = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <div style="background:var(--surface-2);border-radius:10px;padding:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:10px">Visits by Executive</div>
      ${execBars.length ? _dcrSvgBars(execBars, 380, execBars.length * 22) : '<div style="color:var(--ink-2);font-size:12px">No executive data</div>'}
    </div>
    <div style="background:var(--surface-2);border-radius:10px;padding:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:10px">Visit Purpose Breakdown</div>
      ${purposeBars.length ? _dcrSvgBars(purposeBars, 380, purposeBars.length * 22) : '<div style="color:var(--ink-2);font-size:12px">No purpose data</div>'}
    </div>
  </div>
  <div style="background:var(--surface-2);border-radius:10px;padding:14px;margin-bottom:16px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:10px">Daily Visit Trend</div>
    ${linePts.length ? _dcrSvgLine(linePts, 760, 100) : '<div style="color:var(--ink-2);font-size:12px">No daily data</div>'}
  </div>`;

  const execTable = execs.length ? `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:8px">Executive Scorecard</div>
    <div style="overflow-x:auto">
    <table class="tbl" style="font-size:12px;min-width:560px">
      <thead><tr><th>#</th><th style="text-align:left">Executive</th><th>Unit</th><th class="r">Visits</th><th class="r">Agencies</th><th class="r">Active Days</th><th>Last Visit</th></tr></thead>
      <tbody>
      ${execs.map((e,i) => `<tr>
        <td style="color:var(--ink-2)">${i+1}</td>
        <td><b>${esc(e.exec_name || e.emp_code)}</b></td>
        <td style="font-size:11px;color:var(--ink-2)">${esc(e.unit_code||'')}</td>
        <td class="r" style="font-weight:700;color:var(--chart-1)">${e.total_visits}</td>
        <td class="r">${e.agencies_visited}</td>
        <td class="r">${e.active_days}</td>
        <td style="color:var(--ink-2);font-size:11px">${e.last_visit_date ? String(e.last_visit_date).slice(0,10) : '—'}</td>
      </tr>`).join('')}
      </tbody></table></div>` : '';

  return kpis + charts + execTable;
}

/* ── Agency Coverage tab ── */
/* ── Tour Plan Analysis ──────────────────────────────────────────────────────
   Was the plan the executive submitted the right one, and what should it have been?
   Scores the submitted plan against the same outstanding / follow-up / visit-recency
   ranking the Next Day Plan uses, then lists the priority agencies left out. Plans are
   attributed by AGENCY OWNERSHIP, not by who keyed the entry — an Incharge often files
   on an executive's behalf, but the territory still belongs to the agency's owner. */
function _dcrATourPlanCheckTab() {
  const date = _dcrA.tpDate || todayISO();
  _dcrALoadTourPlanCheck();
  const d = _dcrA.tourPlanChk;

  const picker = `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px">
    <label style="font-size:12px;color:var(--ink-2)">Plan date</label>
    <input type="date" value="${esc(date)}" onchange="dcrATpDate(this.value)"
      style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)">
    <button class="btn sm" onclick="_dcrALoadTourPlanCheck(true);render()">↻ Re-check</button>
    <span style="font-size:11px;color:var(--ink-2)">Plans are matched to the executive who <b>owns</b> the agency, not whoever keyed them in.</span>
  </div>`;

  if (_dcrA._loadTpc) return picker + '<div style="color:var(--ink-2);padding:40px 0;text-align:center">⏳ Checking submitted tour plans…</div>';
  if (!d) return picker + '<div style="color:var(--ink-2);padding:40px 0;text-align:center">Pick a date to analyse.</div>';
  if (d._err || d.detail) return picker + `<div style="color:var(--red);padding:20px 0">Could not load tour plan analysis.</div>`;

  const rows = d.results || [], s = d.summary || {};
  if (!rows.length) {
    // "No plan" is a normal answer here, so point at where the plans actually are
    // rather than dead-ending — otherwise this reads as a broken screen.
    const ctx = d.context || {};
    const dts = (ctx.recent_dates || []).filter(x => x.date !== date);
    const uns = (ctx.units_on_date || []).filter(u => !_dcrA.unit_code || u.unit_code !== _dcrA.unit_code);
    const chip = (label, sub, onclick) => `<button class="btn sm" onclick="${onclick}" style="margin:0 6px 6px 0">${esc(label)}<span style="color:var(--ink-2);font-weight:400"> · ${esc(sub)}</span></button>`;
    return picker + `<div style="background:var(--surface-2);border-radius:10px;padding:24px 22px">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px">No tour plan filed for ${esc(date)}</div>
      <div style="font-size:12px;color:var(--ink-2);margin-bottom:${dts.length || uns.length ? '16px' : '0'}">Nothing was submitted${_dcrA.unit_code ? ' by this unit' : ''} on this date, so there is nothing to score. Not every unit files a plan every day.</div>
      ${dts.length ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:6px">Recent dates ${_dcrA.unit_code ? 'this unit' : 'anyone'} did file</div>
        <div style="margin-bottom:14px">${dts.map(x => chip(x.date, x.planned + ' planned', `dcrATpDate('${x.date}')`)).join('')}</div>` : ''}
      ${uns.length ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:6px">Units that filed on ${esc(date)}</div>
        <div>${uns.map(u => chip(u.unit_name || u.unit_code, u.planned + ' planned', `_dcrA.unit_code='${esc(u.unit_code).replace(/'/g,"\\'")}';_dcrA.tourPlanChk=null;_dcrA._loadTpc=false;render()`)).join('')}</div>` : ''}
    </div>`;
  }

  const kpis = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
    ${[[s.executives, 'Executives Planned', 'var(--ink)'],
       [s.plans_correct, 'Plan On Target', 'var(--grn)'],
       [s.plans_need_work, 'Needs Rework', 'var(--red)'],
       [(s.avg_overlap_pct == null ? '—' : s.avg_overlap_pct + '%'), 'Avg Priority Match', '#f59e0b'],
       [s.planned_visits, 'Visits Planned', 'var(--blue)'],
       [s.missed_priority, 'Priority Agencies Missed', 'var(--red)']].map(([v, l, c]) =>
      `<div style="flex:1;min-width:120px;background:var(--surface-2);border-radius:10px;padding:12px 14px">
        <div style="font-size:10px;font-weight:700;color:var(--ink-2);text-transform:uppercase">${l}</div>
        <div style="font-size:24px;font-weight:800;color:${c};margin-top:2px">${v}</div>
      </div>`).join('')}
  </div>`;

  const money = v => { const n = Number(v) || 0; return n >= 1e7 ? '₹' + (n/1e7).toFixed(2) + ' Cr' : n >= 1e5 ? '₹' + (n/1e5).toFixed(2) + ' L' : '₹' + Math.round(n).toLocaleString('en-IN'); };

  const cards = rows.slice().sort((a, b) => a.overlap_pct - b.overlap_pct).map(v => {
    const k = (v.unit_code || '') + '|' + (v.exec_name || '');
    const open = _dcrA.tpOpen === k;
    const col = v.is_correct ? 'var(--grn)' : v.overlap_pct >= 25 ? '#f59e0b' : 'var(--red)';
    const verdict = v.is_correct ? '✓ On target' : v.overlap_pct >= 25 ? '△ Partly right' : '✗ Needs rework';

    // The suggested plan is the whole recommended trip in stop order, with the stops
    // the executive already had marked — so it reads as "here is the day", not just a
    // list of misses. Falls back to the missing-only list on older API responses.
    const route = (v.suggested_route && v.suggested_route.length) ? v.suggested_route : (v.missing || []);
    const missList = route.map((a, i) => {
      const bits = [];
      if (a.outstanding > 0) bits.push('outstanding ' + money(a.outstanding));
      if (a.fup_amt > 0) bits.push('promised ' + money(a.fup_amt));
      bits.push(a.days_since_visit == null ? 'never visited' : a.days_since_visit + 'd since visit');
      const where = a.station_name || a.city;
      return `<tr onclick="openAgencyProfile('${esc(a.unit_code||v.unit_code||'').replace(/'/g,"\\'")}','${esc(a.agcd).replace(/'/g,"\\'")}','${esc(a.ag_name||'').replace(/'/g,"\\'")}')" style="cursor:pointer${a.in_plan ? ';opacity:.6' : ''}" title="View agency profile">
        <td style="color:var(--ink-2);width:22px">${a.stop_no || i + 1}</td>
        <td><b style="font-size:12px">${esc(a.ag_name)}</b>${a.in_plan ? ' <span style="font-size:9px;background:var(--grn);color:#fff;border-radius:8px;padding:1px 6px">in plan</span>' : ''}${where ? `<br><span style="font-size:10px;color:var(--ink-2)">${esc(where)}</span>` : ''}</td>
        <td style="font-size:11px;color:var(--ink-2)">${bits.join(' · ')}</td>
        <td class="r" style="font-weight:700;color:${a.outstanding > 0 ? 'var(--red)' : 'var(--ink)'}">${money(a.outstanding)}</td>
      </tr>`;
    }).join('');
    const routeHdr = v.route_label
      ? `<div style="font-size:11px;color:var(--ink-2);margin-bottom:8px">Grouped on the <b>${esc(v.route_label)}</b> route${v.route_total_km ? ` · about ${v.route_total_km} km end to end` : ''} — stops are in travel order.</div>`
      : '';

    const nearList = (v.nearby_gaps || []).map(a =>
      `<li style="margin-bottom:3px">${esc(a.ag_name)} — <span style="color:var(--ink-2)">${a.distance_km} km from ${esc(a.near_agency)} on the plan</span></li>`).join('');

    const detail = !open ? '' : `<div style="border-top:1px solid var(--brd2);padding:12px 14px;background:var(--bg)">
      ${missList ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--red);margin-bottom:6px">Suggested plan for the day — ${(v.missing||[]).length} of these were missed</div>
        ${routeHdr}
        <div style="overflow-x:auto;margin-bottom:12px"><table class="tbl" style="font-size:12px;min-width:520px">
          <thead><tr><th>Stop</th><th style="text-align:left">Agency</th><th style="text-align:left">Why it ranks higher</th><th class="r">Outstanding</th></tr></thead>
          <tbody>${missList}</tbody></table></div>` : ''}
      ${nearList ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f59e0b;margin-bottom:6px">Nearby, could be added to the same trip</div>
        <ul style="font-size:12px;margin:0 0 12px 16px;padding:0">${nearList}</ul>` : ''}
      ${(v.low_priority || []).length ? `<div style="font-size:11px;color:var(--ink-2);margin-bottom:10px"><b>${v.low_priority.length}</b> planned visit${v.low_priority.length > 1 ? 's are' : ' is'} not in the current priority list — fine if there is a specific reason, otherwise consider swapping.</div>` : ''}
      ${v.hindi_message ? `<div style="background:var(--surface-2);border-radius:8px;padding:10px 12px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin-bottom:5px">Message for the executive (Hindi)</div>
        <div style="font-size:12px;white-space:pre-wrap;line-height:1.55">${esc(v.hindi_message)}</div>
      </div>` : ''}
    </div>`;

    return `<div style="border:1px solid var(--brd2);border-left:4px solid ${col};border-radius:10px;margin-bottom:10px;overflow:hidden">
      <div onclick="dcrATpToggle('${esc(k).replace(/'/g,"\\'")}')" style="cursor:pointer;padding:12px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
        <div style="min-width:200px">
          <div style="font-weight:700;font-size:13px">${esc(v.exec_name)}</div>
          <div style="font-size:11px;color:var(--ink-2)">${esc(v.unit_name || v.unit_code || '')}</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;font-size:11px">
          <div><span style="color:var(--ink-2)">Planned</span> <b>${v.submitted_count}</b></div>
          <div><span style="color:var(--ink-2)">Priority match</span> <b style="color:${col}">${v.overlap_pct}%</b></div>
          <div><span style="color:var(--ink-2)">Missed</span> <b style="color:var(--red)">${(v.missing||[]).length}</b></div>
          <span style="background:${col};color:#fff;border-radius:10px;padding:2px 9px;font-weight:700">${verdict}</span>
          <span style="color:var(--ink-2);font-size:14px">${open ? '▲' : '▼'}</span>
        </div>
      </div>
      ${detail}
    </div>`;
  }).join('');

  return picker + kpis
    + `<div style="font-size:11px;color:var(--ink-2);margin-bottom:8px">Ranked worst match first · tap a row to see what should have been planned instead.</div>`
    + cards;
}

function _dcrACoverageTab() {
  _dcrALoadCoverage();
  const d = _dcrA.coverage;
  if (_dcrA._loadCov) return '<div style="color:var(--ink-2);padding:40px 0;text-align:center">⏳ Loading coverage data…</div>';
  if (!d) return '<div style="color:var(--ink-2);padding:40px 0;text-align:center">No data — apply filter</div>';
  if (d._err) return '<div style="color:var(--red);padding:20px 0">Failed to load coverage data.</div>';

  const nv = d.not_visited || [], rv = d.rarely_visited || [];
  const total = d.total || 1;
  const pct = d.coverage_pct || 0;
  const barColor = pct >= 80 ? 'var(--grn)' : pct >= 50 ? '#f59e0b' : 'var(--red)';

  const kpis = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
    ${[[total,'Total Agencies','var(--ink)'],[nv.length,'Not Visited','var(--red)'],[rv.length,'Rarely Visited (<2x)','#f59e0b'],[d.well_covered||0,'Well Covered','var(--grn)']].map(([v,l,c]) =>
      `<div style="flex:1;min-width:110px;background:var(--surface-2);border-radius:10px;padding:12px 14px">
        <div style="font-size:10px;font-weight:700;color:var(--ink-2);text-transform:uppercase">${l}</div>
        <div style="font-size:24px;font-weight:800;color:${c};margin-top:2px">${v}</div>
      </div>`).join('')}
  </div>
  <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px;margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px">
      <div style="font-size:12px;font-weight:700;min-width:60px">Coverage</div>
      <div style="flex:1;height:12px;background:var(--brd2);border-radius:6px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:6px;transition:width .4s"></div>
      </div>
      <div style="font-size:14px;font-weight:800;color:${barColor};min-width:40px">${pct}%</div>
    </div>
    <div style="font-size:11px;color:var(--ink-2);margin-top:6px">${d.from} to ${d.to} · ${total} active agencies in scope</div>
  </div>`;

  const agRow = (ag, badge) => `<tr onclick="openAgencyProfile('${esc(ag.unit_code||'').replace(/'/g,"\\'")}','${esc(ag.agcd).replace(/'/g,"\\'")}','${esc(ag.ag_name||ag.agcd||'').replace(/'/g,"\\'")}')" style="cursor:pointer" title="View agency profile">
    <td><b style="font-size:12px">${esc(ag.ag_name)}</b><br><span style="font-size:10px;color:var(--ink-2)">${esc(ag.agcd)} · ${esc(ag.city||'')}</span></td>
    <td style="font-size:11px;color:var(--ink-2)">${esc(ag.unit_name||'')}</td>
    <td style="font-size:11px">${esc(ag.exec||'—')}</td>
    <td style="color:var(--ink-2);font-size:11px">${ag.last_visit ? String(ag.last_visit).slice(0,10) : '<span style="color:var(--red);font-weight:700">Never</span>'}</td>
    <td class="r" style="font-size:11px">${ag.visit_count}</td>
    <td class="r" style="font-size:11px;color:var(--blue)">${ag.avg_supply > 0 ? ag.avg_supply : '—'}</td>
    <td class="r" style="font-weight:700;color:${ag.outstanding > 0 ? 'var(--red)' : 'var(--ink)'}">₹${(ag.outstanding||0).toLocaleString('en-IN')}</td>
    <td>${badge}</td>
  </tr>`;

  const tblHead = `<thead><tr><th style="text-align:left">Agency</th><th>Unit</th><th>Executive</th><th>Last Visit</th><th class="r">Visits</th><th class="r">Avg Supply</th><th class="r">Outstanding</th><th>Status</th></tr></thead>`;

  const nvTable = nv.length ? `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--red);margin-bottom:8px">🔴 Not Visited in Period (${nv.length})</div>
    <div style="overflow-x:auto;margin-bottom:20px">
    <table class="tbl" style="font-size:12px;min-width:680px">
      ${tblHead}
      <tbody>${nv.slice(0,50).map(ag => agRow(ag, '<span style="background:#fee2e2;color:#991b1b;font-size:10px;padding:2px 7px;border-radius:10px;font-weight:700">NO VISIT</span>')).join('')}</tbody>
    </table></div>` : '';

  const rvTable = rv.length ? `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#f59e0b;margin-bottom:8px">🟡 Rarely Visited (${rv.length})</div>
    <div style="overflow-x:auto">
    <table class="tbl" style="font-size:12px;min-width:680px">
      ${tblHead}
      <tbody>${rv.slice(0,30).map(ag => agRow(ag, '<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:2px 7px;border-radius:10px;font-weight:700">RARE</span>')).join('')}</tbody>
    </table></div>` : '';

  return kpis + nvTable + rvTable;
}

/* ── AI Remarks tab ── */
function _dcrARemarksTab() {
  const execs = (_dcrA.tourExecs?.executives || []);
  if (!_dcrA.tourExecs) _dcrALoadTourExecs();

  const execOpts = `<option value="">All Executives</option>` + execs.map(e =>
    `<option value="${esc(e.emp_code)}" ${_dcrA.remEmpCode===e.emp_code?'selected':''}>${esc(e.name||e.emp_code)} [${esc(e.unit_name||'')}]</option>`
  ).join('');

  const filterBar = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--brd2)">
    <select id="remExecSel" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:260px">${execOpts}</select>
    <button class="btn sm pri" onclick="_dcrA.remEmpCode=document.getElementById('remExecSel').value;_dcrA.remarks=null;_dcrA._loadRem=false;_dcrA.aiResults=null;_dcrALoadRemarks();render()">Load Remarks</button>
    ${(_dcrA.remarks?.visits||[]).length ? `<button class="btn sm" onclick="dcrAAnalyzeRemarks()" style="background:#7c3aed;color:#fff;border:none" ${_dcrA._analyzing?'disabled':''}>🤖 ${_dcrA._analyzing?'Analyzing…':'Analyze with AI'}</button>` : ''}
    ${_dcrA._loadRem ? '<span style="font-size:12px;color:var(--ink-2)">Loading…</span>' : ''}
    ${_dcrA._analyzing ? '<span style="font-size:12px;color:#7c3aed">⏳ AI is reading the remarks — local model can take 2–3 minutes…</span>' : ''}
  </div>`;

  if (!_dcrA.remarks) return filterBar + `<div style="color:var(--ink-2);font-size:13px;padding:30px 0;text-align:center">Select an executive (or leave blank for all), then click Load Remarks</div>`;
  if (_dcrA.remarks._err) return filterBar + `<div style="color:var(--red)">Failed to load remarks.</div>`;

  const visits = _dcrA.remarks.visits || [];
  if (!visits.length) return filterBar + `<div style="color:var(--ink-2);padding:20px 0">No visits with remarks found for this filter.</div>`;

  const aiMap = {};
  if (_dcrA.aiResults) _dcrA.aiResults.forEach((r, i) => { if (r) aiMap[r.idx != null ? +r.idx : i + 1] = r; });

  const statusBadge = s => {
    const colors = { productive: ['#d1fae5','#065f46'], partial: ['#dbeafe','#1e40af'], 'follow-up': ['#fef3c7','#92400e'], 'no-response': ['#fee2e2','#991b1b'], 'info-only': ['#f3f4f6','#374151'] };
    const [bg, fg] = colors[s] || ['#f3f4f6','#374151'];
    return `<span style="background:${bg};color:${fg};font-size:10px;padding:2px 7px;border-radius:10px;font-weight:700;white-space:nowrap">${(s||'').toUpperCase()}</span>`;
  };

  const rows = visits.map((v, i) => {
    const ai = aiMap[i + 1] || {};
    const hasAi = Object.keys(ai).length > 0;
    return `<tr style="vertical-align:top">
      <td style="white-space:nowrap;font-size:11px;color:var(--ink-2)">${String(v.visit_date||'').slice(0,10)}</td>
      <td style="font-size:11px"><b>${esc(v.executive_name||v.emp_code||'')}</b><br><span style="color:var(--ink-2)">${esc(v.unit_name||v.unit_code||'')}</span></td>
      <td style="font-size:11px;white-space:normal">${v.ag_code?`<b style="cursor:pointer;color:var(--chart-1)" onclick="openAgencyProfile('${esc(v.unit_code||'').replace(/'/g,"\\'")}','${esc(v.ag_code).replace(/'/g,"\\'")}','${esc(v.ag_name||v.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">${esc(v.ag_name||v.ag_code||'')}</b>`:`<b>${esc(v.ag_name||'')}</b>`}</td>
      <td style="font-size:10px;color:var(--ink-2)">${esc((v.visit_purpose||'').slice(0,25))}</td>
      <td style="font-size:11px;min-width:200px;max-width:260px;white-space:normal;word-break:break-word;color:var(--ink)">${esc((v.visit_remarks||'').slice(0,160))}${(v.visit_remarks||'').length > 160 ? '…' : ''}</td>
      ${hasAi ? `
        <td class="r" style="font-size:12px;font-weight:700;color:${ai.payment_received>0?'var(--grn)':'var(--ink-2)'}">₹${(ai.payment_received||0).toLocaleString('en-IN')}</td>
        <td style="font-size:11px;color:var(--chart-1)">${ai.commitment_amount ? `₹${ai.commitment_amount.toLocaleString('en-IN')} ${ai.commitment_date ? '('+ai.commitment_date+')' : ''}` : '—'}</td>
        <td style="font-size:11px;color:var(--grn)">${ai.growth_commitment > 0 ? '+'+ai.growth_commitment+' copies' : '—'}</td>
        <td style="font-size:10px;color:var(--red)">${esc(ai.issue||'—')}</td>
        <td>${statusBadge(ai.status)}</td>
      ` : `<td colspan="5" style="font-size:11px;color:var(--ink-2);font-style:italic">Click "Analyze with AI"</td>`}
    </tr>`;
  });

  return filterBar + `
    <div style="overflow-x:auto">
    <table class="tbl" style="font-size:12px;min-width:800px">
      <thead><tr>
        <th>Date</th><th style="text-align:left">Executive</th><th style="text-align:left">Agency</th>
        <th>Purpose</th><th style="text-align:left;min-width:200px">Remarks</th>
        ${_dcrA.aiResults ? '<th class="r">Received</th><th>Commitment</th><th>Growth</th><th>Issue</th><th>Status</th>' : '<th colspan="5" style="color:#7c3aed">← AI Analysis (click button above)</th>'}
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>
    ${_dcrA.aiResults ? `<div style="margin-top:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:11px;color:var(--ink-2)">🤖 Analyzed by ${esc(_dcrA.aiModel || 'Claude')} · ${visits.length} visits · Hindi/English remarks parsed</div>` : ''}`;
}

/* ── Next Day Plan tab ── */
function _dcrANextPlanTab() {
  _dcrALoadPlanExecs();
  const execs = _dcrA.tourExecs?.executives || _dcrA.planExecs || [];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);

  const execOpts = `<option value="">— Select Executive —</option>` + execs.map(e =>
    `<option value="${esc(e.emp_code)}" ${_dcrA.planEmpCode===e.emp_code?'selected':''}>${esc(e.name||e.emp_code)} [${esc(e.unit_name||e.unit_code||'')}]</option>`
  ).join('');

  const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--brd2)">
    <select id="planExecSel" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:280px">${execOpts}</select>
    <input type="date" id="planDateIn" value="${_dcrA.planDate || tomorrow}" min="${tomorrow}" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink)">
    <button class="btn sm pri" style="background:#7c3aed;color:#fff;border:none" onclick="_dcrA.planEmpCode=document.getElementById('planExecSel').value;_dcrA.planDate=document.getElementById('planDateIn').value;dcrAGenPlan()" ${_dcrA._loadingPlan?'disabled':''}>
      ${_dcrA._loadingPlan ? `⏱ ${_dcrAElapsed(_dcrA._planGenStart)}` : '🤖 Generate AI Plan'}
    </button>
    ${_dcrA._loadingPlan ? '<span style="font-size:12px;color:#7c3aed">AI is analyzing agency data — usually well under a minute…</span>' : ''}
  </div>`;

  if (!_dcrA.plan && !_dcrA._loadingPlan) {
    return controls + `<div style="color:var(--ink-2);font-size:13px;padding:30px 0;text-align:center">
      <div style="font-size:32px;margin-bottom:10px">📋</div>
      <div>Select an executive and plan date, then click "Generate AI Plan"</div>
      <div style="font-size:11px;margin-top:6px">AI considers outstanding balance, pending followups, last visit dates, and past remarks to prioritize agencies</div>
    </div>`;
  }
  if (_dcrA._loadingPlan) return controls + `<div style="color:var(--ink-2);padding:40px 0;text-align:center">
      <div style="font-size:28px;margin-bottom:8px">⏱ ${_dcrAElapsed(_dcrA._planGenStart)}</div>
      <div>Generating smart visit plan…</div>
    </div>`;
  if (_dcrA.plan?._err) return controls + `<div style="color:var(--red);padding:20px 0">Failed to generate plan.</div>`;

  const p = _dcrA.plan?.plan || {};
  const visits = p.visits || [];
  const prioColor = s => s === 'high' ? '#ef4444' : s === 'medium' ? '#f59e0b' : '#6b7280';

  const totalTarget = visits.reduce((s, v) => s + (v.target_amount || 0), 0);

  const planCard = `
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.8">AI Visit Plan for ${esc(p.exec||'')} · ${esc(p.unit||'')}</div>
      <div style="font-size:18px;font-weight:700;margin:6px 0">${esc(p.date||'')}</div>
      <div style="font-size:13px;opacity:.9;font-style:italic">"${esc(p.focus_message||'')}"</div>
      <div style="display:flex;gap:20px;margin-top:12px">
        <div><div style="font-size:10px;opacity:.7">PLANNED VISITS</div><div style="font-size:22px;font-weight:800">${visits.length}</div></div>
        <div><div style="font-size:10px;opacity:.7">COLLECTION TARGET</div><div style="font-size:22px;font-weight:800">₹${totalTarget.toLocaleString('en-IN')}</div></div>
      </div>
    </div>`;

  const visitCards = visits.map((v, i) => `
    <div style="border:1px solid var(--brd2);border-left:4px solid ${prioColor(v.priority)};border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--bg)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="background:${prioColor(v.priority)};color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0">${v.rank||i+1}</div>
        <div style="flex:1">
          <b style="font-size:13px">${esc(v.ag_name||'')}</b>
          <span style="font-size:11px;color:var(--ink-2);margin-left:6px">${esc(v.ag_code||'')} · ${esc(v.city||'')}</span>
        </div>
        <span style="background:${prioColor(v.priority)}22;color:${prioColor(v.priority)};font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;text-transform:uppercase">${v.priority||''}</span>
        ${v.target_amount > 0 ? `<span style="background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px">₹${v.target_amount.toLocaleString('en-IN')}</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div style="font-size:11px"><span style="color:var(--ink-2)">Action: </span>${esc(v.action||'')}</div>
        <div style="font-size:11px"><span style="color:var(--ink-2)">Key Point: </span><b>${esc(v.key_point||'')}</b></div>
      </div>
    </div>`).join('');

  const emailBtn = _dcrA.planEmpCode ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--brd2);display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn sm" onclick="epDrillExec('${esc(_dcrA.planEmpCode)}','');setTimeout(()=>epOpenEmailFromDetail(),500)">📧 Email Plan to Executive's Reporting Chain</button>
      <button class="btn sm" style="background:#229ED9;color:#fff;border:none" onclick="dcrAPlanTelegram()">✈️ Send Plan on Telegram</button>
    </div>` : '';

  return controls + planCard + visitCards + emailBtn + _dcrATeamPlanSection();
}

/* ── Team Plan (all executives reporting to a Circulation Incharge) ── */
function _dcrALoadIncharges() {
  if (_dcrA._loadInch || _dcrA.incharges) return;
  _dcrA._loadInch = true;
  fetch(`${location.origin.replace(':8123', ':8001')}/api/dcr-analytics/incharges`, { headers: api.h() })
    .then(r => r.json())
    .then(d => { _dcrA.incharges = d.incharges || []; _dcrA._loadInch = false; if (S.screen === 'dcr_analytics') render(); })
    .catch(() => { _dcrA.incharges = []; _dcrA._loadInch = false; });
}

function _dcrATeamPlanSection() {
  _dcrALoadIncharges();
  const inchs = _dcrA.incharges || [];
  const inchOpts = `<option value="">— Select Circulation Incharge —</option>` +
    inchs.map(c => `<option value="${esc(c.code)}" ${_dcrA.teamUnit === c.code ? 'selected' : ''}>${esc(c.name)} (${c.exec_count} exec · ${esc(String(c.units || '').split(',').slice(0, 3).join(','))})</option>`).join('');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const head = `
    <div style="margin-top:26px;padding-top:16px;border-top:2px solid var(--brd2)">
      <div style="font-size:13px;font-weight:700;margin-bottom:3px">👥 Team Plan — Circulation Incharge के लिए</div>
      <div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">Incharge को report करने वाले सभी Executives का combined suggested tour plan (top 3 agencies each) — Telegram पर भेजें ताकि उन्हें पता रहे कि team को क्या करना है</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
        <select id="teamInchSel" onchange="if(this.value)document.getElementById('teamUnitSel').value=''" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:300px">${inchOpts}</select>
        <span style="font-size:11px;color:var(--ink-2)">या Unit से:</span>
        <select id="teamUnitSel" onchange="if(this.value)document.getElementById('teamInchSel').value=''" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:200px">
          <option value="">— Unit —</option>${(_dcrA.units || []).map(u => `<option value="${esc(u.unit_code)}">${esc(u.unit_name)}</option>`).join('')}
        </select>
        <input type="date" id="teamDateIn" value="${_dcrA.planDate || tomorrow}" min="${tomorrow}" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink)">
        <button class="btn sm pri" onclick="dcrAGenTeamPlan()" ${_dcrA._loadingTeam ? 'disabled' : ''}>${_dcrA._loadingTeam ? '⏳ Generating…' : '👥 Generate Team Plan'}</button>
        ${_dcrA._loadInch ? '<span style="font-size:11px;color:var(--ink-2)">Loading…</span>' : ''}
      </div>`;

  const tp = _dcrA.teamPlan;
  if (!tp && !_dcrA._loadingTeam) return head + `</div>`;
  if (_dcrA._loadingTeam) return head + `<div style="color:var(--ink-2);font-size:12px;padding:10px 0">⏳ पूरी team का plan बन रहा है…</div></div>`;
  if (tp?._err) return head + `<div style="color:var(--red);font-size:12px;padding:10px 0">Team plan failed: ${esc(tp._err)}</div></div>`;
  if (!(tp.execs || []).length) return head + `<div style="color:var(--ink-2);font-size:12px;padding:10px 0">इस unit में last 60 दिनों में कोई active executive नहीं मिला.</div></div>`;

  const blocks = tp.execs.map(t => `
    <div style="border:1px solid var(--brd2);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="font-size:12.5px">👤 ${esc(t.exec_name)}</b>
        ${t.total_target > 0 ? `<span style="background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">Target ₹${t.total_target.toLocaleString('en-IN')}</span>` : ''}
      </div>
      ${(t.visits || []).map((v, i) => `
        <div style="font-size:11.5px;padding:3px 0;border-top:${i ? '1px dashed var(--brd2)' : 'none'}">
          ${i + 1}. <b>${esc(v.name)}</b>${v.city ? ' (' + esc(v.city) + ')' : ''}
          ${v.os > 0 ? ` — Outstanding ₹${v.os.toLocaleString('en-IN')}` : ''}
          <span style="color:var(--ink-2)"> · ${esc(v.note)}</span>
          ${v.growth_ask > 0 ? `<span style="color:#15803d;font-weight:600"> · +${v.growth_ask} copies growth</span>` : ''}
        </div>`).join('')}
    </div>`).join('');

  return head + `
    <div style="font-size:12px;margin-bottom:10px">
      <b>${tp.unit_name}</b> · ${tp.execs.length} Executives · Total Recovery Target: <b>₹${(tp.grand_total || 0).toLocaleString('en-IN')}</b>
    </div>
    ${blocks}
    <button class="btn sm" style="background:#229ED9;color:#fff;border:none;margin-top:6px" onclick="dcrATeamTelegram()">✈️ Send to Incharge on Telegram</button>
  </div>`;
}

window.dcrAGenTeamPlan = async () => {
  const ci = document.getElementById('teamInchSel')?.value;
  const uc = document.getElementById('teamUnitSel')?.value;
  const dt = document.getElementById('teamDateIn')?.value;
  if (!ci && !uc) { toast('Circulation Incharge या Unit चुनें'); return; }
  _dcrA.teamUnit = ci || uc; _dcrA._loadingTeam = true; _dcrA.teamPlan = null; render();
  try {
    const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/dcr-analytics/team-plan`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify(ci ? { circ_incharge: ci, plan_date: dt } : { unit_code: uc, plan_date: dt }),
    });
    const d = await r.json();
    _dcrA.teamPlan = r.ok ? d : { _err: d.detail || r.status };
  } catch (e) { _dcrA.teamPlan = { _err: e.message }; }
  _dcrA._loadingTeam = false;
  if (S.screen === 'dcr_analytics') render();
};

function _dcrATeamPlanText() {
  const tp = _dcrA.teamPlan || {};
  const dt = tp.date ? tp.date.split('-').reverse().join('/') : '';
  const withVisits = (tp.execs || []).filter(t => (t.visits || []).length);
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — Team Visit Plan`);
  L.push(`📅 ${dt}${tp.incharge?.name ? ' · 👔 ' + tp.incharge.name + ' की Team' : ' · 🏢 ' + (tp.unit_name || '')}`);
  L.push(`👥 ${withVisits.length} Executives · Total Recovery Target: ₹${(tp.grand_total || 0).toLocaleString('en-IN')}`);
  withVisits.forEach(t => {
    L.push('');
    L.push(`👤 ${t.exec_name}${t.total_target > 0 ? ' — Target ₹' + t.total_target.toLocaleString('en-IN') : ''}`);
    (t.visits || []).forEach((v, i) => {
      L.push(`${i + 1}. ${v.name}${v.city ? ' (' + v.city + ')' : ''}${v.os > 0 ? ' — Outstanding ₹' + v.os.toLocaleString('en-IN') : ''}`);
      L.push(`   ${v.note}${v.growth_ask > 0 ? ' · कम से कम ' + v.growth_ask + ' Copies Growth का Commitment लें' : ''}`);
    });
  });
  L.push('');
  L.push(`📈 Special Focus:`);
  L.push(`हर Executive हर Visit पर Recovery के साथ Copy Growth का clear Commitment ज़रूर ले — यही हमारा मुख्य लक्ष्य है! 💪`);
  return L.join('\n');
}

window.dcrATeamTelegram = async () => {
  const text = _dcrATeamPlanText();
  const tp = _dcrA.teamPlan || {};
  let pre = { mobile: '' };
  try {
    const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/telegram/resolve?person_code=${encodeURIComponent(tp.incharge?.code || '')}&name=${encodeURIComponent(tp.incharge?.name || '')}`, { headers: api.h() });
    pre = await r.json();
  } catch (_) {}
  modal(`<h3>✈️ Send Team Plan on Telegram</h3>
    <p style="font-size:12px;color:var(--ink-2)">To: <b>${esc(tp.incharge?.name || 'Circulation Incharge')}</b>${pre.linked ? ' · <span style="color:var(--grn)">✓ Telegram linked</span>' : ''} (Incharge को पहले bot से link होना ज़रूरी है — /start भेजकर number share करें).</p>
    <input id="tgMob" type="tel" maxlength="10" value="${esc(pre.mobile || '')}" placeholder="Incharge का 10-digit mobile" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;margin-bottom:8px;background:var(--bg);color:var(--ink)">
    <textarea id="tgText" rows="12" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">${esc(text)}</textarea>
    <div id="tgErr" style="color:var(--red);font-size:12px;margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn pri block" onclick="_dcrATgTeamSend()">Send</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window._dcrATgTeamSend = async () => {
  const mob = document.getElementById('tgMob')?.value?.replace(/\D/g, '').slice(-10);
  const full = document.getElementById('tgText')?.value || '';
  const errEl = document.getElementById('tgErr');
  if (!mob || mob.length !== 10) { errEl.textContent = 'Valid 10-digit mobile डालें'; return; }
  // Telegram limit 4096 chars — split at executive blocks if needed
  const parts = [];
  if (full.length <= 3800) parts.push(full);
  else {
    const chunks = full.split('\n\n👤 ');
    let cur = chunks.shift();
    for (const c of chunks) {
      if ((cur + '\n\n👤 ' + c).length > 3600) { parts.push(cur); cur = '👤 ' + c; }
      else cur += '\n\n👤 ' + c;
    }
    parts.push(cur);
  }
  errEl.textContent = 'Sending…';
  try {
    for (let i = 0; i < parts.length; i++) {
      const text = parts.length > 1 ? `${parts[i]}\n\n(भाग ${i + 1}/${parts.length})` : parts[i];
      const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/telegram/send`, {
        method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mob, text }),
      });
      const d = await r.json();
      if (r.status === 404 && d.detail === 'not_linked') {
        errEl.innerHTML = `यह number अभी link नहीं है.<br><b>Incharge से कहें:</b> Telegram में <b>@${esc(d.bot_username || 'bot')}</b> खोलें → <b>Start</b> दबाएँ → <b>📱 Share my number</b> पर tap करें. फिर दोबारा भेजें.`;
        return;
      }
      if (!r.ok) { errEl.textContent = d.detail || 'Send failed'; return; }
    }
    closeModals();
    toast('✈️ Team plan sent to Incharge ✓');
  } catch (e) { errEl.textContent = 'Send failed: ' + e.message; }
};

/* ── Send AI plan to the executive on Telegram ── */
function _dcrAPlanText() {
  const p = _dcrA.plan?.plan || {};
  const visits = p.visits || [];
  const pri = s => s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '⚪';
  const total = visits.reduce((s, v) => s + (v.target_amount || 0), 0);
  const dt = p.date ? p.date.split('-').reverse().join('/') : '';
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — कल का Visit Plan`);
  L.push(`📅 ${dt} · 👤 ${p.exec || ''} (${p.unit || ''})`);
  if (p.focus_message) L.push(`\n🎯 ${p.focus_message}`);
  if (total > 0) L.push(`\n💰 Total Recovery Target: ₹${total.toLocaleString('en-IN')}`);
  L.push('');
  visits.forEach((v, i) => {
    L.push(`${v.rank || i + 1}. ${pri(v.priority)} ${v.ag_name || ''}${v.city ? ' (' + v.city + ')' : ''}`);
    if (v.action) L.push(`${v.action}${v.target_amount > 0 ? ' · Recovery Target: ₹' + v.target_amount.toLocaleString('en-IN') : ''}`);
    if (v.key_point) L.push(`⚠️ ${v.key_point}`);
    L.push('');
  });
  L.push(`📈 Special Focus:`);
  L.push(`हर Visit में सिर्फ Recovery ही नहीं, बल्कि Copy Growth का clear Commitment लेना भी ज़रूरी है। 💪`);
  return L.join('\n');
}

window.dcrAPlanTelegram = async () => {
  const p = _dcrA.plan?.plan || {};
  const execName = _dcrA.plan?.exec_name || p.exec || '';
  let pre = { mobile: '', linked: false, enabled: true, bot_username: null };
  try {
    const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/telegram/resolve?emp_code=${encodeURIComponent(_dcrA.planEmpCode || '')}&name=${encodeURIComponent(execName)}`, { headers: api.h() });
    pre = await r.json();
  } catch (_) {}
  if (!pre.enabled) { toast('⚠ Telegram bot not configured — set TELEGRAM_BOT_TOKEN in server .env'); return; }
  const text = _dcrAPlanText();
  modal(`<h3>✈️ Send Plan on Telegram</h3>
    <p style="font-size:12px;color:var(--ink-2)">To <b>${esc(execName)}</b>. ${pre.linked ? '<span style="color:var(--grn)">✓ Telegram linked</span>' : pre.mobile ? '<span style="color:#d97706">Number found — link status will be checked on send</span>' : 'Enter executive mobile number.'}</p>
    <input id="tgMob" type="tel" maxlength="10" value="${esc(pre.mobile || '')}" placeholder="10-digit mobile" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;margin-bottom:8px;background:var(--bg);color:var(--ink)">
    <textarea id="tgText" rows="10" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">${esc(text.replace(/<\/?b>/g, ''))}</textarea>
    <div id="tgErr" style="color:var(--red);font-size:12px;margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn pri block" onclick="_dcrATgSend()">Send</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window._dcrATgSend = async () => {
  const mob = document.getElementById('tgMob')?.value?.replace(/\D/g, '').slice(-10);
  const text = document.getElementById('tgText')?.value || '';
  const errEl = document.getElementById('tgErr');
  if (!mob || mob.length !== 10) { errEl.textContent = 'Enter a valid 10-digit mobile'; return; }
  errEl.textContent = 'Sending…';
  try {
    const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/telegram/send`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: mob, text, emp_code: _dcrA.planEmpCode || '' }),
    });
    const d = await r.json();
    if (r.status === 404 && d.detail === 'not_linked') {
      errEl.innerHTML = `This number is not linked yet.<br><b>Ask the executive to:</b> open Telegram → search <b>@${esc(d.bot_username || 'the bot')}</b> → press <b>Start</b> → tap <b>📱 Share my number</b>. Then send again.`;
      return;
    }
    if (!r.ok) { errEl.textContent = d.detail || 'Send failed'; return; }
    closeModals();
    toast('✈️ Plan sent on Telegram ✓');
  } catch (e) { errEl.textContent = 'Send failed: ' + e.message; }
};

/* ── 7-Day Tour Plan tab — same process as Next Day Plan, spread over a week ── */
window.dcrAGenWeekPlan = async () => {
  const code = _dcrA.weekEmpCode;
  if (!code) return;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const startDate = _dcrA.weekStartDate || tomorrow;
  _dcrA._loadingWeek = true; _dcrA.weekPlan = null; _dcrA._weekGenStart = Date.now(); render();
  const ticker = setInterval(() => { if (S.screen === 'dcr_analytics') render(); }, 1000);
  try {
    const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/dcr-analytics/week-plan`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ emp_code: code, start_date: startDate }),
    });
    const d = await r.json();
    _dcrA.weekPlan = d;
  } catch (_) { _dcrA.weekPlan = { _err: true }; }
  clearInterval(ticker);
  _dcrA._loadingWeek = false;
  if (S.screen === 'dcr_analytics') render();
};

function _dcrAElapsed(startTs) {
  const secs = Math.max(0, Math.floor((Date.now() - (startTs || Date.now())) / 1000));
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _dcrADateRange(fromIso, toIso) {
  if (!fromIso) return '';
  const opts = { day: 'numeric', month: 'short' };
  const from = new Date(fromIso).toLocaleDateString('en-IN', opts);
  if (!toIso || toIso === fromIso) return new Date(fromIso).toLocaleDateString('en-IN', { ...opts, year: 'numeric' });
  const to = new Date(toIso).toLocaleDateString('en-IN', { ...opts, year: 'numeric' });
  return `${from} – ${to}`;
}

function _dcrAWeekPlanTab() {
  _dcrALoadPlanExecs();
  const execs = _dcrA.tourExecs?.executives || _dcrA.planExecs || [];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);

  const execOpts = `<option value="">— Select Executive —</option>` + execs.map(e =>
    `<option value="${esc(e.emp_code)}" ${_dcrA.weekEmpCode===e.emp_code?'selected':''}>${esc(e.name||e.emp_code)} [${esc(e.unit_name||e.unit_code||'')}]</option>`
  ).join('');

  const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--brd2)">
    <select id="weekExecSel" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:280px">${execOpts}</select>
    <input type="date" id="weekStartIn" value="${_dcrA.weekStartDate || tomorrow}" min="${tomorrow}" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink)">
    <button class="btn sm pri" style="background:#7c3aed;color:#fff;border:none" onclick="_dcrA.weekEmpCode=document.getElementById('weekExecSel').value;_dcrA.weekStartDate=document.getElementById('weekStartIn').value;dcrAGenWeekPlan()" ${_dcrA._loadingWeek?'disabled':''}>
      ${_dcrA._loadingWeek ? `⏱ ${_dcrAElapsed(_dcrA._weekGenStart)}` : '🤖 Generate 7-Day Plan'}
    </button>
    ${_dcrA._loadingWeek ? '<span style="font-size:12px;color:#7c3aed">AI is planning a full week — local model can take a minute or two; falls back to the instant rule engine if it\'s slow…</span>' : ''}
  </div>`;

  if (!_dcrA.weekPlan && !_dcrA._loadingWeek) {
    return controls + `<div style="color:var(--ink-2);font-size:13px;padding:30px 0;text-align:center">
      <div style="font-size:32px;margin-bottom:10px">📅</div>
      <div>Select an executive and start date, then click "Generate 7-Day Plan"</div>
      <div style="font-size:11px;margin-top:6px">Same prioritization as Next Day Plan — outstanding, followups, visit recency — spread across the week</div>
    </div>` + _dcrAWeekTeamPlanSection();
  }
  if (_dcrA._loadingWeek) return controls + `<div style="color:var(--ink-2);padding:40px 0;text-align:center">
      <div style="font-size:28px;margin-bottom:8px">⏱ ${_dcrAElapsed(_dcrA._weekGenStart)}</div>
      <div>पूरे हफ़्ते की योजना बन रही है…</div>
    </div>`;
  if (_dcrA.weekPlan?._err) return controls + `<div style="color:var(--red);padding:20px 0">Failed to generate plan.</div>`;

  const p = _dcrA.weekPlan?.plan || {};
  const daysArr = p.days || [];
  const prioColor = s => s === 'high' ? '#ef4444' : s === 'medium' ? '#f59e0b' : '#6b7280';
  const weekTotal = daysArr.reduce((s, d) => s + (d.total_target || 0), 0);
  const weekVisits = daysArr.reduce((s, d) => s + (d.visits || []).length, 0);

  const rangeLabel = _dcrADateRange(p.start_date, daysArr.length ? daysArr[daysArr.length - 1].date : null);
  const planCard = `
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.8">AI 7-Day Tour Plan for ${esc(p.exec||'')} · ${esc(p.unit||'')}</div>
      <div style="font-size:18px;font-weight:700;margin:6px 0">${esc(rangeLabel)}</div>
      <div style="display:flex;gap:20px;margin-top:12px">
        <div><div style="font-size:10px;opacity:.7">PLANNED VISITS</div><div style="font-size:22px;font-weight:800">${weekVisits}</div></div>
        <div><div style="font-size:10px;opacity:.7">WEEK TARGET</div><div style="font-size:22px;font-weight:800">₹${weekTotal.toLocaleString('en-IN')}</div></div>
      </div>
    </div>`;

  const dayBlocks = daysArr.map(day => `
    <div style="border:1px solid var(--brd2);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--bg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:13px">Day ${day.day} — ${esc(day.date||'')}</b>
        ${day.total_target > 0 ? `<span style="background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px">₹${day.total_target.toLocaleString('en-IN')}</span>` : ''}
      </div>
      ${day.focus_message ? `<div style="font-size:11.5px;font-style:italic;color:var(--ink-2);margin-bottom:8px">"${esc(day.focus_message)}"</div>` : ''}
      ${(day.visits||[]).map((v,i) => `
        <div style="border-left:3px solid ${prioColor(v.priority)};padding:6px 10px;margin-bottom:6px;background:var(--card)">
          <div style="display:flex;align-items:center;gap:8px">
            <b style="font-size:12.5px">${i+1}. ${esc(v.ag_name||'')}</b>
            <span style="font-size:10.5px;color:var(--ink-2)">${esc(v.city||'')}</span>
            <span style="margin-left:auto;background:${prioColor(v.priority)}22;color:${prioColor(v.priority)};font-size:9.5px;padding:1px 7px;border-radius:9px;font-weight:700;text-transform:uppercase">${v.priority||''}</span>
          </div>
          <div style="font-size:11px;margin-top:3px"><span style="color:var(--ink-2)">Action: </span>${esc(v.action||'')}${v.target_amount > 0 ? ` · ₹${v.target_amount.toLocaleString('en-IN')}` : ''}</div>
          <div style="font-size:11px"><span style="color:var(--ink-2)">Key Point: </span><b>${esc(v.key_point||'')}</b></div>
        </div>`).join('')}
    </div>`).join('');

  const tgBtn = _dcrA.weekEmpCode ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--brd2)">
      <button class="btn sm" style="background:#229ED9;color:#fff;border:none" onclick="dcrAWeekPlanTelegram()">✈️ Send Week Plan on Telegram</button>
    </div>` : '';

  return controls + planCard + dayBlocks + tgBtn + _dcrAWeekTeamPlanSection();
}

function _dcrAWeekPlanText() {
  const p = _dcrA.weekPlan?.plan || {};
  const pri = s => s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '⚪';
  const total = (p.days||[]).reduce((s,d) => s + (d.total_target||0), 0);
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — अगले 7 दिनों का Visit Plan`);
  L.push(`👤 ${p.exec || ''} (${p.unit || ''}) · शुरू: ${p.start_date || ''}`);
  if (total > 0) L.push(`💰 Week Recovery Target: ₹${total.toLocaleString('en-IN')}`);
  (p.days || []).forEach(day => {
    L.push(`\n📅 Day ${day.day} — ${day.date}`);
    if (day.focus_message) L.push(`🎯 ${day.focus_message}`);
    (day.visits || []).forEach((v, i) => {
      L.push(`${i+1}. ${pri(v.priority)} ${v.ag_name||''}${v.city ? ' ('+v.city+')' : ''}`);
      if (v.action) L.push(`${v.action}${v.target_amount > 0 ? ' · Target: ₹'+v.target_amount.toLocaleString('en-IN') : ''}`);
      if (v.key_point) L.push(`⚠️ ${v.key_point}`);
    });
  });
  return L.join('\n');
}

window.dcrAWeekPlanTelegram = async () => {
  const p = _dcrA.weekPlan?.plan || {};
  const execName = _dcrA.weekPlan?.exec_name || p.exec || '';
  let pre = { mobile: '', linked: false, enabled: true, bot_username: null };
  try {
    const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/telegram/resolve?emp_code=${encodeURIComponent(_dcrA.weekEmpCode || '')}&name=${encodeURIComponent(execName)}`, { headers: api.h() });
    pre = await r.json();
  } catch (_) {}
  if (!pre.enabled) { toast('⚠ Telegram bot not configured — set TELEGRAM_BOT_TOKEN in server .env'); return; }
  const text = _dcrAWeekPlanText();
  modal(`<h3>✈️ Send 7-Day Plan on Telegram</h3>
    <p style="font-size:12px;color:var(--ink-2)">To <b>${esc(execName)}</b>. ${pre.linked ? '<span style="color:var(--grn)">✓ Telegram linked</span>' : pre.mobile ? '<span style="color:#d97706">Number found — link status will be checked on send</span>' : 'Enter executive mobile number.'}</p>
    <input id="tgMob" type="tel" maxlength="10" value="${esc(pre.mobile || '')}" placeholder="10-digit mobile" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;margin-bottom:8px;background:var(--bg);color:var(--ink)">
    <textarea id="tgText" rows="12" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">${esc(text)}</textarea>
    <div id="tgErr" style="color:var(--red);font-size:12px;margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn pri block" onclick="_dcrATgWeekSend()">Send</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window._dcrATgWeekSend = async () => {
  const mob = document.getElementById('tgMob')?.value?.replace(/\D/g, '').slice(-10);
  const full = document.getElementById('tgText')?.value || '';
  const errEl = document.getElementById('tgErr');
  if (!mob || mob.length !== 10) { errEl.textContent = 'Enter a valid 10-digit mobile'; return; }
  // Telegram limit 4096 chars — split by day if the week plan is long
  const parts = [];
  if (full.length <= 3800) parts.push(full);
  else {
    const chunks = full.split('\n📅 Day ');
    let cur = chunks.shift();
    for (const c of chunks) {
      const withDay = '📅 Day ' + c;
      if ((cur + '\n' + withDay).length > 3600) { parts.push(cur); cur = withDay; }
      else cur += '\n' + withDay;
    }
    parts.push(cur);
  }
  errEl.textContent = 'Sending…';
  try {
    for (let i = 0; i < parts.length; i++) {
      const text = parts.length > 1 ? `${parts[i]}\n\n(भाग ${i + 1}/${parts.length})` : parts[i];
      const r = await fetch(`${location.origin.replace(':8123',':8001')}/api/telegram/send`, {
        method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mob, text, emp_code: _dcrA.weekEmpCode || '' }),
      });
      const d = await r.json();
      if (r.status === 404 && d.detail === 'not_linked') {
        errEl.innerHTML = `This number is not linked yet.<br><b>Ask the executive to:</b> open Telegram → search <b>@${esc(d.bot_username || 'the bot')}</b> → press <b>Start</b> → tap <b>📱 Share my number</b>. Then send again.`;
        return;
      }
      if (!r.ok) { errEl.textContent = d.detail || 'Send failed'; return; }
    }
    closeModals();
    toast('✈️ 7-day plan sent on Telegram ✓');
  } catch (e) { errEl.textContent = 'Send failed: ' + e.message; }
};

/* ── Week Team Plan (all executives reporting to a Circulation Incharge) ── */
function _dcrAWeekTeamPlanSection() {
  _dcrALoadIncharges();
  const inchs = _dcrA.incharges || [];
  const inchOpts = `<option value="">— Select Circulation Incharge —</option>` +
    inchs.map(c => `<option value="${esc(c.code)}" ${_dcrA.weekTeamUnit === c.code ? 'selected' : ''}>${esc(c.name)} (${c.exec_count} exec · ${esc(String(c.units || '').split(',').slice(0, 3).join(','))})</option>`).join('');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const head = `
    <div style="margin-top:26px;padding-top:16px;border-top:2px solid var(--brd2)">
      <div style="font-size:13px;font-weight:700;margin-bottom:3px">👥 7-Day Team Plan — Circulation Incharge के लिए</div>
      <div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">Incharge को report करने वाले सभी Executives का combined 7-दिन का tour plan (top ~21 agencies each, spread over the week)</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
        <select id="weekTeamInchSel" onchange="if(this.value)document.getElementById('weekTeamUnitSel').value=''" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:300px">${inchOpts}</select>
        <span style="font-size:11px;color:var(--ink-2)">या Unit से:</span>
        <select id="weekTeamUnitSel" onchange="if(this.value)document.getElementById('weekTeamInchSel').value=''" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink);max-width:200px">
          <option value="">— Unit —</option>${(_dcrA.units || []).map(u => `<option value="${esc(u.unit_code)}">${esc(u.unit_name)}</option>`).join('')}
        </select>
        <input type="date" id="weekTeamStartIn" value="${_dcrA.weekStartDate || tomorrow}" min="${tomorrow}" style="font-size:12px;padding:5px 8px;border:1px solid var(--brd2);border-radius:6px;background:var(--bg);color:var(--ink)">
        <button class="btn sm pri" onclick="dcrAGenWeekTeamPlan()" ${_dcrA._loadingWeekTeam ? 'disabled' : ''}>${_dcrA._loadingWeekTeam ? '⏳ Generating…' : '👥 Generate 7-Day Team Plan'}</button>
      </div>`;

  const tp = _dcrA.weekTeamPlan;
  if (!tp && !_dcrA._loadingWeekTeam) return head + `</div>`;
  if (_dcrA._loadingWeekTeam) return head + `<div style="color:var(--ink-2);font-size:12px;padding:10px 0">⏳ पूरी team का week plan बन रहा है…</div></div>`;
  if (tp?._err) return head + `<div style="color:var(--red);font-size:12px;padding:10px 0">Week team plan failed: ${esc(tp._err)}</div></div>`;
  if (!(tp.execs || []).length) return head + `<div style="color:var(--ink-2);font-size:12px;padding:10px 0">इस unit में last 60 दिनों में कोई active executive नहीं मिला.</div></div>`;

  const blocks = tp.execs.map(t => `
    <div style="border:1px solid var(--brd2);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="font-size:12.5px">👤 ${esc(t.exec_name)}</b>
        ${t.total_target > 0 ? `<span style="background:#d1fae5;color:#065f46;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">Week Target ₹${t.total_target.toLocaleString('en-IN')}</span>` : ''}
      </div>
      ${(t.days || []).map(day => `
        <div style="font-size:11px;font-weight:700;color:var(--ink-2);margin-top:6px">Day ${day.day} — ${esc(day.date)}${day.total_target ? ' · ₹' + day.total_target.toLocaleString('en-IN') : ''}</div>
        ${(day.visits || []).map((v, i) => `
          <div style="font-size:11.5px;padding:3px 0;border-top:${i ? '1px dashed var(--brd2)' : 'none'}">
            ${i + 1}. <b>${esc(v.name)}</b>${v.city ? ' (' + esc(v.city) + ')' : ''}
            ${v.os > 0 ? ` — Outstanding ₹${v.os.toLocaleString('en-IN')}` : ''}
            <span style="color:var(--ink-2)"> · ${esc(v.note)}</span>
            ${v.growth_ask > 0 ? `<span style="color:#15803d;font-weight:600"> · +${v.growth_ask} copies growth</span>` : ''}
          </div>`).join('')}`).join('')}
    </div>`).join('');

  return head + `
    <div style="font-size:12px;margin-bottom:10px">
      <b>${esc(tp.unit_name)}</b> · ${tp.execs.length} Executives · Total Week Recovery Target: <b>₹${(tp.grand_total || 0).toLocaleString('en-IN')}</b>
    </div>
    ${blocks}
    <button class="btn sm" style="background:#229ED9;color:#fff;border:none;margin-top:6px" onclick="dcrAWeekTeamTelegram()">✈️ Send to Incharge on Telegram</button>
  </div>`;
}

window.dcrAGenWeekTeamPlan = async () => {
  const ci = document.getElementById('weekTeamInchSel')?.value;
  const uc = document.getElementById('weekTeamUnitSel')?.value;
  const dt = document.getElementById('weekTeamStartIn')?.value;
  if (!ci && !uc) { toast('Circulation Incharge या Unit चुनें'); return; }
  _dcrA.weekTeamUnit = ci || uc; _dcrA._loadingWeekTeam = true; _dcrA.weekTeamPlan = null; render();
  try {
    const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/dcr-analytics/week-team-plan`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify(ci ? { circ_incharge: ci, start_date: dt } : { unit_code: uc, start_date: dt }),
    });
    const d = await r.json();
    _dcrA.weekTeamPlan = r.ok ? d : { _err: d.detail || r.status };
  } catch (e) { _dcrA.weekTeamPlan = { _err: e.message }; }
  _dcrA._loadingWeekTeam = false;
  if (S.screen === 'dcr_analytics') render();
};

function _dcrAWeekTeamPlanText() {
  const tp = _dcrA.weekTeamPlan || {};
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — 7-दिन Team Tour Plan`);
  L.push(`👥 ${tp.unit_name || ''} · शुरू: ${tp.start_date || ''}`);
  if (tp.grand_total) L.push(`💰 Week Recovery Target: ₹${tp.grand_total.toLocaleString('en-IN')}`);
  (tp.execs || []).forEach(t => {
    L.push(`\n👤 ${t.exec_name}${t.total_target ? ' · ₹' + t.total_target.toLocaleString('en-IN') : ''}`);
    (t.days || []).forEach(day => {
      L.push(`Day ${day.day} (${day.date}):`);
      (day.visits || []).forEach((v, i) => L.push(`  ${i+1}. ${v.name}${v.city ? ' ('+v.city+')' : ''} — ${v.note}`));
    });
  });
  return L.join('\n');
}

window.dcrAWeekTeamTelegram = async () => {
  const text = _dcrAWeekTeamPlanText();
  const tp = _dcrA.weekTeamPlan || {};
  let pre = { mobile: '' };
  try {
    const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/telegram/resolve?person_code=${encodeURIComponent(tp.incharge?.code || '')}&name=${encodeURIComponent(tp.incharge?.name || '')}`, { headers: api.h() });
    pre = await r.json();
  } catch (_) {}
  modal(`<h3>✈️ Send 7-Day Team Plan on Telegram</h3>
    <p style="font-size:12px;color:var(--ink-2)">To: <b>${esc(tp.incharge?.name || 'Circulation Incharge')}</b>${pre.linked ? ' · <span style="color:var(--grn)">✓ Telegram linked</span>' : ''}.</p>
    <input id="tgMob" type="tel" maxlength="10" value="${esc(pre.mobile || '')}" placeholder="Incharge का 10-digit mobile" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;margin-bottom:8px;background:var(--bg);color:var(--ink)">
    <textarea id="tgText" rows="12" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">${esc(text)}</textarea>
    <div id="tgErr" style="color:var(--red);font-size:12px;margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn pri block" onclick="_dcrATgWeekTeamSend()">Send</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window._dcrATgWeekTeamSend = async () => {
  const mob = document.getElementById('tgMob')?.value?.replace(/\D/g, '').slice(-10);
  const full = document.getElementById('tgText')?.value || '';
  const errEl = document.getElementById('tgErr');
  if (!mob || mob.length !== 10) { errEl.textContent = 'Valid 10-digit mobile डालें'; return; }
  const parts = [];
  if (full.length <= 3800) parts.push(full);
  else {
    const chunks = full.split('\n\n👤 ');
    let cur = chunks.shift();
    for (const c of chunks) {
      if ((cur + '\n\n👤 ' + c).length > 3600) { parts.push(cur); cur = '👤 ' + c; }
      else cur += '\n\n👤 ' + c;
    }
    parts.push(cur);
  }
  errEl.textContent = 'Sending…';
  try {
    for (let i = 0; i < parts.length; i++) {
      const text = parts.length > 1 ? `${parts[i]}\n\n(भाग ${i + 1}/${parts.length})` : parts[i];
      const r = await fetch(`${location.origin.replace(':8123', ':8001')}/api/telegram/send`, {
        method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: mob, text }),
      });
      const d = await r.json();
      if (r.status === 404 && d.detail === 'not_linked') {
        errEl.innerHTML = `यह number अभी link नहीं है.<br><b>Incharge से कहें:</b> Telegram में <b>@${esc(d.bot_username || 'bot')}</b> खोलें → <b>Start</b> दबाएँ → <b>📱 Share my number</b> पर tap करें. फिर दोबारा भेजें.`;
        return;
      }
      if (!r.ok) { errEl.textContent = d.detail || 'Send failed'; return; }
    }
    closeModals();
    toast('✈️ 7-day team plan sent to Incharge ✓');
  } catch (e) { errEl.textContent = 'Send failed: ' + e.message; }
};

/* PAN-India (hierarchyLevel 1) admins land on Rajasthan / Jaipur RP on every dashboard,
   rather than a blank "All States/Units" view. Everyone else already sees only their
   own branch server-side (scope is enforced by req.auth, not by these UI filters)
   regardless of what these default to, so they're left blank for them. Every
   dashboard below has its own state/unit value convention (full name vs abbreviation
   vs code vs title-case, unit code vs unit name) — verified live against each
   dashboard's own /filters endpoint rather than assumed. */
function _isPanIndiaAdmin() { return !!(S.user && S.user.hierarchyLevel === 1); }

/* ---- Dashboard: Command Centre ---- */
/* ── Command Centre helpers ─────────────────────────────── */
function _cmdBase() { return location.origin; }

/* ── Filter bar: period (this/last month · quarter), branch, agency search.
   "Revenue Line" and "Role" from the reference mockup don't map to this app's
   data model (no per-line revenue split; scoping is already enforced per
   logged-in user, not user-switchable) — intentionally omitted. ── */
function _cmdFilterState() {
  if (!S.live.cmdFilters) {
    const isPanIndia = _isPanIndiaAdmin();
    S.live.cmdFilters = {
      period: 'month',
      state: isPanIndia ? 'RAJASTHAN' : '',
      unit_code: isPanIndia ? 'JA0' : '',
      unit_name: isPanIndia ? 'JAIPUR RP' : '',
      district: '', exec_name: '',
    };
  }
  return S.live.cmdFilters;
}
function _cmdPeriodRange(period) {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth();
  const iso = d => d.toISOString().slice(0, 10);
  if (period === 'today')      return { from: todayISO(), to: todayISO() };
  if (period === 'yesterday')  { const y1 = new Date(today); y1.setDate(y1.getDate() - 1); return { from: iso(y1), to: iso(y1) }; }
  if (period === 'last_month') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (period === 'quarter')    return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: todayISO() };
  return { from: monthStartISO(), to: todayISO() };
}
window.cmdSetPeriod = p => { _cmdFilterState().period = p; S.live.cmd = {}; render(); };
window.cmdSetState = s => { const f = _cmdFilterState(); f.state = s; f.unit_code = ''; f.unit_name = ''; f.district = ''; f.exec_name = ''; S.live.cmd = {}; render(); };
window.cmdSetUnit = (code, name) => { const f = _cmdFilterState(); f.unit_code = code; f.unit_name = name || ''; f.district = ''; f.exec_name = ''; S.live.cmd = {}; render(); };
window.cmdSetDistrict = d => { const f = _cmdFilterState(); f.district = d; S.live.cmd = {}; render(); };
window.cmdSetExec = e => { const f = _cmdFilterState(); f.exec_name = e; S.live.cmd = {}; render(); };
// Districts and executives are both fetched per-unit, on demand (a whole-table version
// of the districts query ran 40s+ — see /api/supply-dash/districts/:unit's comment).
function _cmdLoadCascade(unitCode) {
  if (!unitCode) return;
  const grab = (bucket, path, pick) => {
    S.live[bucket] = S.live[bucket] || {};
    const loadKey = '_l_' + bucket + '_' + unitCode;
    if (S.live[bucket][unitCode] || S.live[loadKey]) return;
    S.live[loadKey] = true;
    fetch(_cmdBase() + path + encodeURIComponent(unitCode), { headers: api.h() })
      .then(r => r.json())
      .then(d => { S.live[bucket][unitCode] = pick(d) || []; S.live[loadKey] = false; if (S.screen === 'command') render(); })
      .catch(() => { S.live[bucket][unitCode] = []; S.live[loadKey] = false; if (S.screen === 'command') render(); });
  };
  grab('cmdDistrictsByUnit', '/api/supply-dash/districts/',  d => d.districts);
  grab('cmdExecsByUnit',     '/api/supply-dash/executives/', d => d.executives);
}
window.cmdResetFilters = () => { S.live.cmdFilters = null; S.live.cmd = {}; render(); };
function _cmdLoadUnits() {
  if (S.live.cmdUnits || S.live._cmdUnitsLoading) return;
  S.live._cmdUnitsLoading = true;
  fetch(_cmdBase() + '/api/supply-dash/filters', { headers: api.h() })
    .then(r => r.json())
    .then(d => { S.live.cmdUnits = d.units || []; S.live.cmdStates = d.states || []; S.live._cmdUnitsLoading = false; if (S.screen === 'command') render(); })
    .catch(() => { S.live.cmdUnits = []; S.live.cmdStates = []; S.live._cmdUnitsLoading = false; });
}

function _cmdLoad() {
  const c = S.live.cmd || (S.live.cmd = {});
  const f = _cmdFilterState();
  _cmdLoadUnits();
  const period = _cmdPeriodRange(f.period);
  const uP = f.unit_code ? 'unit_code=' + encodeURIComponent(f.unit_code) : '';
  // State is Rajasthan/MP/Chhattisgarh/National (matches the regionOf() bucketing used
  // everywhere else in the app). "National" is an umbrella for everything else with no
  // literal row to match, so it only narrows the Unit dropdown (below) — never sent as a
  // filter param. For the 3 real states, every endpoint here was individually verified
  // against live data (several looked "supported" by their code but silently returned
  // zero rows for the obvious param):
  //   - collection/kpis, supply-dash/sale-summary|day-compare|trend: full name works
  //     (state_name columns store "RAJASTHAN" etc.)
  //   - exec-perf/alerts|dcr: needs the ABBREVIATED code (agency_master.unit_state_nm
  //     stores "RJ"/"MP"/"CG", not the full name)
  //   - outstanding/kpis: its `state` param is actually `group_unit_name`, an unrelated
  //     zonal grouping — there is no way to filter this endpoint by geographic state
  //   - survey/kpis: state_name column didn't match any tested format (full name,
  //     abbreviation, or lowercase) — left unfiltered by state rather than risk a
  //     confident-looking zero
  const CMD_STATE_ABBR = { 'RAJASTHAN': 'RJ', 'MADHYA PRADESH': 'MP', 'CHHATTISGARH': 'CG' };
  const isCoreState = f.state && f.state !== 'NATIONAL';
  const sPFull = isCoreState ? 'state=' + encodeURIComponent(f.state) + '&state_name=' + encodeURIComponent(f.state) : '';
  const sPAbbr = isCoreState ? 'state=' + encodeURIComponent(CMD_STATE_ABBR[f.state] || f.state) : '';
  const dP = 'from=' + period.from + '&to=' + period.to;
  // District / Executive. Where the source table lacks the column it is reached through
  // agency_master's (unit, agcd) key server-side:
  //   - collection/kpis:  district native, executive via agency_master
  //   - outstanding/kpis: executive native, district via agency_master
  //   - supply-dash/*:    district native on supply_data, executive via agency_master;
  //     the Cash (hawker_supply) half of sale-summary has NEITHER and no agency key to
  //     reach one, so that endpoint returns Agent-only when either filter is set and
  //     flags it as agent_only rather than adding a scoped figure to an unscoped one.
  // Still genuinely unfilterable by both: survey/kpis (no district or exec data) and the
  // taxi supply-issues feed (a today-only vehicle snapshot with no agency dimension).
  const distP = f.district  ? 'district='  + encodeURIComponent(f.district)  : '';
  const exP   = f.exec_name ? 'exec_name=' + encodeURIComponent(f.exec_name) : '';
  // Outstanding is a balance, not a flow, so it follows the period by SNAPSHOT rather
  // than by date range. Only month-end snapshots exist (plus the live CURRENT one), so
  // a period that closed in an earlier month reads that month's snapshot; anything
  // running up to today — Today, This month, Quarter — is the live balance. Yesterday
  // is also live: no daily outstanding history is kept, and inventing one would be worse
  // than a figure that legitimately does not move for a one-day step.
  const ouSnapP = (() => {
    if (f.period !== 'last_month') return '';
    const t = new Date(period.to);
    return 'period_label=' + t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  })();
  const qs = (...parts) => { const s = parts.filter(Boolean).join('&'); return s ? '?' + s : ''; };

  if (!c.ou && !c._ouLoading) {
    c._ouLoading = true;
    fetch(_cmdBase() + '/api/outstanding/kpis' + qs(uP, distP, exP, ouSnapP), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.ou = d; c._ouLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._ouLoading = false; c.ou = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.co && !c._coLoading) {
    c._coLoading = true;
    const branchP = f.unit_name ? 'branch=' + encodeURIComponent(f.unit_name) : '';
    fetch(_cmdBase() + '/api/collection/kpis' + qs(dP, branchP, sPFull, distP, exP), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.co = d; c._coLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._coLoading = false; c.co = { _err: true }; if (S.screen === 'command') render(); });
  }
  // Taxi delivery issues: today's snapshot only — no unit/branch or period param exists on this endpoint.
  if (!c.si && !c._siLoading) {
    c._siLoading = true;
    fetch(_cmdBase() + '/api/reports/supply-issues', { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.si = d; c._siLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._siLoading = false; c.si = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.sv && !c._svLoading) {
    c._svLoading = true;
    fetch(_cmdBase() + '/api/survey/kpis' + qs(uP, dP), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.sv = d; c._svLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._svLoading = false; c.sv = { _err: true }; if (S.screen === 'command') render(); });
  }
  // Supply is a daily copies figure, so sale-summary reads the period's endpoints
  // rather than summing it: current = last supply day in range, previous = first.
  // Sending the range makes the card follow the period. Note supply syncs overnight,
  // so picking "Today" before the sync lands legitimately returns no_data — the card
  // says so rather than showing a stale yesterday figure under today's heading.
  if (!c.sup && !c._supLoading) {
    c._supLoading = true;
    fetch(_cmdBase() + '/api/supply-dash/sale-summary' + qs(uP, sPFull, distP, exP, dP), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.sup = d; c._supLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._supLoading = false; c.sup = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.fa && !c._faLoading) {
    c._faLoading = true;
    fetch(_cmdBase() + '/api/exec-perf/alerts' + qs(uP, dP, sPAbbr), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.fa = d; c._faLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._faLoading = false; c.fa = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.dcr && !c._dcrLoading) {
    c._dcrLoading = true;
    fetch(_cmdBase() + '/api/exec-perf/dcr' + qs(uP, dP, sPAbbr), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.dcr = d; c._dcrLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._dcrLoading = false; c.dcr = { _err: true }; if (S.screen === 'command') render(); });
  }
  const _grp  = S.live.cmdGrp  || 'state';
  const _mode = S.live.cmdMode || 'prev';
  const _dcK  = 'dc_' + _grp + '_' + _mode;
  if (!c[_dcK] && !c['_l' + _dcK]) {
    c['_l' + _dcK] = true;
    fetch(_cmdBase() + '/api/supply-dash/day-compare?group=' + _grp + '&mode=' + _mode + [uP, sPFull, distP, exP].filter(Boolean).map(p => '&' + p).join(''), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c[_dcK] = d; c['_l' + _dcK] = false; if (S.screen === 'command') render(); })
      .catch(() => { c['_l' + _dcK] = false; c[_dcK] = { _err: true }; if (S.screen === 'command') render(); });
  }
  if (!c.tr && !c._trLoading) {
    c._trLoading = true;
    fetch(_cmdBase() + '/api/supply-dash/trend?granularity=daily&days=90' + [uP, sPFull, distP, exP].filter(Boolean).map(p => '&' + p).join(''), { headers: api.h() })
      .then(r => r.json())
      .then(d => { c.tr = d; c._trLoading = false; if (S.screen === 'command') render(); })
      .catch(() => { c._trLoading = false; c.tr = { _err: true }; if (S.screen === 'command') render(); });
  }
}

window.cmdSetGrp  = g => { S.live.cmdGrp  = g; render(); };
window.cmdSetMode = m => { S.live.cmdMode = m; render(); };
window.cmdSetTab  = (k, v) => { (S.live.cmdTabs || (S.live.cmdTabs = {}))[k] = v; render(); };

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

// 'YYYY-MM-DD' -> '31 Jul 2026' (used to date the Outstanding snapshot on its card)
function _cmdD(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(iso).slice(0, 10);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
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
  // No leading emoji — the coloured accent bar already identifies the card, and the
  // section reads cleaner without it. `icon` stays in the signature so call sites
  // are untouched.
  return `<div class="_cmd-card" ${clickAttr}>
    <div style="display:flex;align-items:flex-start;gap:11px;margin-bottom:10px">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:15px;color:var(--ink)">${title}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:1px">${period||''}</div>
      </div>
      ${badgeHtml}
    </div>
    ${body}
  </div>`;
}

/* ── Command Centre analytics: cur-vs-baseline charts ───── */
function _cmdSeg(opts, active, fn) {
  return `<div style="display:inline-flex;background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:2px;gap:2px;flex-wrap:wrap">
    ${opts.map(([v, l]) => `<button onclick="${fn}('${v}')" style="border:none;cursor:pointer;font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;background:${v === active ? 'var(--surf)' : 'transparent'};color:${v === active ? 'var(--ink)' : 'var(--muted)'};box-shadow:${v === active ? '0 1px 3px rgba(0,0,0,.15)' : 'none'}">${l}</button>`).join('')}
  </div>`;
}

function _cmdChip(diff, pctv) {
  if (!diff) return `<span style="font-size:10.5px;font-weight:700;color:var(--muted);background:var(--bg);padding:1px 7px;border-radius:9px;white-space:nowrap">0</span>`;
  const up = diff > 0;
  return `<span style="font-size:10.5px;font-weight:700;color:${up ? 'var(--grn)' : 'var(--red)'};background:${up ? 'var(--grn-l)' : 'var(--red-l)'};padding:1px 7px;border-radius:9px;white-space:nowrap">${up ? '▲' : '▼'} ${VZ.fmt(Math.abs(diff))}${pctv != null ? ' · ' + Math.abs(pctv) + '%' : ''}</span>`;
}

function _cmdBullet(rows, curLbl, baseLbl) {
  const max = Math.max(...rows.map(r => Math.max(r.cur, r.prev)), 1);
  const body = rows.map(r => {
    const cw = (r.cur / max * 100).toFixed(1), pw = (r.prev / max * 100).toFixed(1);
    const color = r.diff > 0 ? 'var(--grn)' : r.diff < 0 ? 'var(--red)' : 'var(--chart-1)';
    const tip = `<b>${esc(r.label)}</b><br>${curLbl}: ${VZ.full(r.cur)}<br>${baseLbl}: ${VZ.full(r.prev)}<br>Δ ${r.diff >= 0 ? '+' : ''}${VZ.full(r.diff)}${r.pct != null ? ' (' + (r.pct >= 0 ? '+' : '') + r.pct + '%)' : ''}`;
    return `<div data-tip="${esc(tip)}" style="display:grid;grid-template-columns:minmax(62px,108px) 1fr auto;gap:10px;align-items:center;padding:5px 0">
      <span style="font-size:11px;font-weight:600;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
      <div style="position:relative;height:15px;background:var(--bg);border-radius:8px">
        <div style="position:absolute;top:0;bottom:0;left:0;width:${pw}%;background:var(--brd);border-radius:8px"></div>
        <div style="position:absolute;top:2px;bottom:2px;left:0;width:${cw}%;background:${color};border-radius:7px;opacity:.92"></div>
        <div style="position:absolute;top:-2px;bottom:-2px;left:${pw}%;width:2px;background:var(--ink-2)"></div>
      </div>
      <span style="display:flex;gap:7px;align-items:center;justify-content:flex-end;min-width:118px">
        <b class="num" style="font-size:12px;color:var(--ink)">${VZ.fmt(r.cur)}</b>${_cmdChip(r.diff, r.pct)}
      </span>
    </div>`;
  }).join('');
  return body + `<div style="display:flex;gap:14px;font-size:10px;color:var(--muted);margin-top:8px;flex-wrap:wrap">
    <span><i style="display:inline-block;width:16px;height:8px;background:var(--chart-1);border-radius:4px;vertical-align:middle;margin-right:4px"></i>current (green ▲ / red ▼ vs baseline)</span>
    <span><i style="display:inline-block;width:16px;height:8px;background:var(--brd);border-radius:4px;vertical-align:middle;margin-right:4px"></i>baseline track</span>
    <span><i style="display:inline-block;width:2px;height:10px;background:var(--ink-2);vertical-align:middle;margin-right:4px"></i>baseline mark</span>
  </div>`;
}

function _cmdDiverge(rows, o) {
  const max = Math.max(...rows.map(r => Math.max(r[o.l], r[o.r])), 1);
  const head = `<div style="display:grid;grid-template-columns:minmax(62px,108px) 44px 1fr 1fr 44px;gap:6px;font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding-bottom:5px">
    <span></span><span style="text-align:right;color:${o.lColor}">${o.lLbl}</span><span></span><span></span><span style="color:${o.rColor}">${o.rLbl}</span></div>`;
  const body = rows.map(r => {
    const lv = r[o.l], rv = r[o.r];
    const lw = Math.max(lv / max * 100, lv > 0 ? 2 : 0).toFixed(1);
    const rw = Math.max(rv / max * 100, rv > 0 ? 2 : 0).toFixed(1);
    return `<div data-tip="${esc(o.tip(r))}" style="display:grid;grid-template-columns:minmax(62px,108px) 44px 1fr 1fr 44px;gap:6px;align-items:center;padding:4px 0">
      <span style="font-size:11px;font-weight:600;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
      <span class="num" style="font-size:11px;font-weight:700;text-align:right;color:${lv ? o.lColor : 'var(--muted)'}">${o.fmt(lv)}</span>
      <div style="height:13px;background:var(--bg);border-radius:7px 0 0 7px;position:relative;border-right:1px solid var(--brd)">
        <div style="position:absolute;right:0;top:1.5px;bottom:1.5px;width:${lw}%;background:${o.lColor};border-radius:6px 0 0 6px;opacity:.88"></div>
      </div>
      <div style="height:13px;background:var(--bg);border-radius:0 7px 7px 0;position:relative">
        <div style="position:absolute;left:0;top:1.5px;bottom:1.5px;width:${rw}%;background:${o.rColor};border-radius:0 6px 6px 0;opacity:.88"></div>
      </div>
      <span class="num" style="font-size:11px;font-weight:700;color:${rv ? o.rColor : 'var(--muted)'}">${o.fmt(rv)}</span>
    </div>`;
  }).join('');
  return head + body;
}

function _cmdDataTable(cols, rows) {
  const th = cols.map((cName, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid var(--brd);white-space:nowrap">${cName}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map((v, i) => `<td class="num" style="text-align:${i ? 'right' : 'left'};padding:6px 8px;font-size:12px;border-bottom:1px solid var(--brd);white-space:nowrap">${v}</td>`).join('')}</tr>`).join('');
  return `<div style="overflow-x:auto;max-height:340px;overflow-y:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function _cmdChartCard(o) {
  const tab = (S.live.cmdTabs || {})[o.key] || 'chart';
  const tabBtn = (v, l) => `<button onclick="cmdSetTab('${o.key}','${v}')" style="border:none;cursor:pointer;font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;background:${tab === v ? 'var(--bg)' : 'transparent'};color:${tab === v ? 'var(--ink)' : 'var(--muted)'}">${l}</button>`;
  let body;
  if (o.loading)      body = _cmdSkel();
  else if (o.error)   body = `<p style="color:var(--red);font-size:13px;margin:8px 0">Failed to load. <a href="#" onclick="S.live.cmd=null;render();return false" style="color:var(--acc)">Retry</a></p>`;
  else if (o.empty)   body = `<p style="color:var(--muted);font-size:12.5px;margin:8px 0">${o.empty}</p>`;
  else                body = tab === 'data' && o.data ? o.data : o.chart;
  return `<div class="_cmd-card" style="${o.span ? 'grid-column:1/-1' : ''}">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;flex-wrap:wrap">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:13.5px;color:var(--ink)">${o.title}</div>
        ${o.sub ? `<div style="font-size:11px;color:var(--muted)">${o.sub}</div>` : ''}
      </div>
      ${o.data && !o.loading && !o.error && !o.empty ? `<div style="display:inline-flex;border:1px solid var(--brd);border-radius:7px;padding:2px;gap:2px">${tabBtn('chart', '📊 Chart')}${tabBtn('data', '▦ Data')}</div>` : ''}
    </div>
    ${body}
    ${o.foot && tab === 'chart' ? `<div style="font-size:10.5px;color:var(--muted);margin-top:7px">${o.foot}</div>` : ''}
  </div>`;
}

function _cmdAnalyticsSection(c) {
  const grp   = S.live.cmdGrp  || 'state';
  const mode  = S.live.cmdMode || 'prev';
  const dc    = c['dc_' + grp + '_' + mode];
  const tr    = c.tr;
  const dmy   = iso => iso ? String(iso).split('-').reverse().join('/') : '—';
  const modeL = { prev: 'Previous Day', d7: '7 Days Ago', d30: '30 Days Ago', covid: 'Pre-Covid (18/03/2020)' }[mode];

  const loading = !dc, err = dc?._err;
  const noData  = dc && !err && dc.no_data;
  const all     = (!loading && !err && !noData) ? dc.rows : null;
  let chartRows = all, moreNote = '';
  if (all && all.length > 14) {
    chartRows = all.slice(0, 14);
    moreNote = `Top 14 of ${all.length} ${grp === 'unit' ? 'units' : 'groups'} by current copies — full list in the Data tab`;
  }
  const curL  = all ? 'Current · ' + dmy(dc.cur_date)  : 'Current';
  const baseL = all ? 'Baseline · ' + dmy(dc.base_date) : 'Baseline';
  const emptyMsg = noData
    ? (mode === 'covid' ? 'No supply data loaded on/before 18/03/2020 yet — historical sync still in progress.' : 'No comparison data available for this selection.')
    : null;

  /* totals strip */
  let totals = '';
  if (all) {
    const t = all.reduce((a, r) => ({
      cur: a.cur + r.cur, prev: a.prev + r.prev,
      inc: a.inc + r.inc_agents, dec: a.dec + r.dec_agents,
      nw: a.nw + r.new_agents, cl: a.cl + r.closed_agents,
    }), { cur: 0, prev: 0, inc: 0, dec: 0, nw: 0, cl: 0 });
    const td = t.cur - t.prev;
    const tp = t.prev ? Math.round(td / t.prev * 1000) / 10 : null;
    totals = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px;margin-bottom:12px">
      ${[[VZ.full(t.cur), 'Net Paid Sale · ' + dmy(dc.cur_date), 'var(--ink)'],
         [VZ.full(t.prev), 'Baseline · ' + dmy(dc.base_date), 'var(--muted)'],
         [(td >= 0 ? '+' : '−') + VZ.fmt(Math.abs(td)) + (tp != null ? ' (' + (tp >= 0 ? '+' : '') + tp + '%)' : ''), 'Net Change', td >= 0 ? 'var(--grn)' : 'var(--red)'],
         ['▲ ' + VZ.full(t.inc), 'Agents Grew', 'var(--grn)'],
         ['▼ ' + VZ.full(t.dec), 'Agents Declined', 'var(--red)'],
         [VZ.full(t.nw) + ' / ' + VZ.full(t.cl), 'New / Closed Agencies', t.cl > t.nw ? 'var(--red)' : 'var(--grn)']]
        .map(([v, l, col]) => `<div style="background:var(--surf);border:1px solid var(--brd);border-radius:9px;padding:9px 11px">
          <div class="num" style="font-size:15px;font-weight:700;color:${col};line-height:1.2">${v}</div>
          <div style="font-size:9.5px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.04em">${l}</div>
        </div>`).join('')}
    </div>`;
  }

  /* data tables */
  const npsData = all ? _cmdDataTable(
    [grp === 'unit' ? 'Unit' : 'State', 'Baseline', 'Current', 'Δ Copies', 'Δ %'],
    all.map(r => [esc(r.label), VZ.full(r.prev), VZ.full(r.cur), _cmdChip(r.diff, null), r.pct != null ? (r.pct >= 0 ? '+' : '') + r.pct + '%' : '—'])) : null;
  const movData = all ? _cmdDataTable(
    [grp === 'unit' ? 'Unit' : 'State', '▲ Grew', '▼ Declined', 'No Change', 'New', 'Closed'],
    all.map(r => [esc(r.label), VZ.full(r.inc_agents), VZ.full(r.dec_agents), VZ.full(r.same_agents), VZ.full(r.new_agents), VZ.full(r.closed_agents)])) : null;
  const copData = all ? _cmdDataTable(
    [grp === 'unit' ? 'Unit' : 'State', 'Copies ▲', 'Copies ▼', 'Lost (Closed)', 'Gained (New)', 'Net'],
    all.map(r => [esc(r.label), VZ.full(r.inc_copies), VZ.full(r.dec_copies), VZ.full(r.closed_copies), VZ.full(r.new_copies), _cmdChip(r.diff, null)])) : null;
  const chnData = all ? _cmdDataTable(
    [grp === 'unit' ? 'Unit' : 'State', 'Closed Agencies', 'Copies Lost', 'New Agencies', 'Copies Gained'],
    all.map(r => [esc(r.label), VZ.full(r.closed_agents), VZ.full(r.closed_copies), VZ.full(r.new_agents), VZ.full(r.new_copies)])) : null;

  const common = { loading, error: err, empty: emptyMsg };
  const movTip = r => `<b>${esc(r.label)}</b><br>▲ grew: ${VZ.full(r.inc_agents)} · ▼ declined: ${VZ.full(r.dec_agents)}<br>no change: ${VZ.full(r.same_agents)}<br>new: ${VZ.full(r.new_agents)} · closed: ${VZ.full(r.closed_agents)}`;
  const copTip = r => `<b>${esc(r.label)}</b><br>copies gained ▲: ${VZ.full(r.inc_copies)} · lost ▼: ${VZ.full(r.dec_copies)}<br>closed −${VZ.full(r.closed_copies)} · new +${VZ.full(r.new_copies)}<br><b>net Δ ${r.diff >= 0 ? '+' : ''}${VZ.full(r.diff)}</b>`;
  const chnTip = r => `<b>${esc(r.label)}</b><br>closed: ${VZ.full(r.closed_agents)} agencies (−${VZ.full(r.closed_copies)} copies)<br>introduced: ${VZ.full(r.new_agents)} agencies (+${VZ.full(r.new_copies)} copies)`;

  return `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0 10px">
      <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.07em;text-transform:uppercase;padding-left:2px;flex:1;min-width:180px">
        Supply Analytics — Current vs ${modeL}${all ? ' · ' + dmy(dc.cur_date) + ' vs ' + dmy(dc.base_date) : ''}
      </div>
      ${_cmdSeg([['state', 'By State'], ['unit', 'By Unit']], grp, 'cmdSetGrp')}
      ${_cmdSeg([['prev', 'Prev Day'], ['d7', '7 Days'], ['d30', '30 Days'], ['covid', 'Covid 18/03/20']], mode, 'cmdSetMode')}
    </div>
    ${totals}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      ${_cmdChartCard({ ...common, key: 'nps', icon: '📰', title: 'Net Paid Sale', sub: curL + ' vs ' + baseL,
        chart: chartRows ? _cmdBullet(chartRows, curL, baseL) : '', data: npsData, foot: moreNote })}
      ${_cmdChartCard({ ...common, key: 'mov', icon: '🧭', title: 'Agent Movement', sub: 'Agencies whose copies moved vs baseline',
        chart: chartRows ? _cmdDiverge(chartRows, { l: 'dec_agents', r: 'inc_agents', lColor: 'var(--red)', rColor: 'var(--grn)', lLbl: '▼ Declined', rLbl: '▲ Grew', fmt: VZ.full, tip: movTip }) : '',
        data: movData, foot: moreNote })}
      ${_cmdChartCard({ ...common, key: 'cop', icon: '⚖️', title: 'Copies Variance', sub: 'Copies gained vs lost among running agencies',
        chart: chartRows ? _cmdDiverge(chartRows, { l: 'dec_copies', r: 'inc_copies', lColor: 'var(--red)', rColor: 'var(--grn)', lLbl: '▼ Lost', rLbl: '▲ Gained', fmt: VZ.fmt, tip: copTip }) : '',
        data: copData, foot: moreNote })}
      ${_cmdChartCard({ ...common, key: 'chn', icon: '🔄', title: 'Agency Churn', sub: 'Closed vs newly introduced agencies',
        chart: chartRows ? _cmdDiverge(chartRows, { l: 'closed_agents', r: 'new_agents', lColor: 'var(--red)', rColor: 'var(--grn)', lLbl: 'Closed', rLbl: 'New', fmt: VZ.full, tip: chnTip }) : '',
        data: chnData, foot: moreNote })}
      ${_cmdChartCard({
        key: 'trend', icon: '📈', title: 'Net Sale Trend', sub: 'Daily copies · last 90 days', span: true,
        loading: !tr, error: tr?._err,
        empty: tr && !tr._err && !(tr.rows || []).length ? 'No trend data available.' : null,
        chart: tr && !tr._err && (tr.rows || []).length
          ? vzLine({ values: tr.rows.map(r => r.copies), labels: tr.rows.map(r => r.label), valueLabel: 'Copies' })
          : '',
      })}
    </div>`;
}

/* ── Command Centre — CURRENT design (stable). Left untouched so it can be
   restored at any time: the switcher below flips between this and the new
   layout, and defaulting to this means a half-finished redesign can never
   reach users by accident. ── */
function _cmdViewLegacy() {
  _cmdLoad();
  const c = S.live.cmd || {};
  const ou = c.ou, co = c.co, si = c.si, sv = c.sv, sup = c.sup, fa = c.fa, dcr = c.dcr;
  const cf = _cmdFilterState();
  const cmdPeriodLabel = { today: 'Today', yesterday: 'Yesterday', month: 'This Month', last_month: 'Last Month', quarter: 'Quarter' }[cf.period] || 'This Month';
  const cmdPeriod = _cmdPeriodRange(cf.period);

  // Header subtitle: Supply/Collections/Field Intelligence are Oracle-synced overnight, so
  // they reflect through yesterday (D-1), not today — labeling that "Live · <today>" reads
  // as same-day data when it isn't. Outstanding is a genuine point-in-time snapshot (already
  // says "As on Today" on its own card) and Taxi tracks in near-real-time, so only note the
  // exception rather than pretend everything lags.
  const _cmdFmtDate = iso => {
    if (!iso) return '';
    const [y, m, dd] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  const cmdDataDate = (sup && !sup._err && !sup.no_data && sup.data_upto) ? _cmdFmtDate(sup.data_upto) : null;
  const cmdSubtitle = cmdDataDate
    ? `Data as of ${cmdDataDate} · Outstanding &amp; Taxi update in real-time`
    : 'Loading latest data…';

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
      [_cmdFmtC(co.total_collection),                       cmdPeriodLabel + ' Total', 'var(--grn)'],
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

  /* ── Field Intelligence (DCR Activity) ─────────────────── */
  let faKpis, faFooter, faBadge, faBadgeColor;
  if (fa && !fa._err) {
    const dcrData    = dcr && !dcr._err ? dcr : null;
    const activeToday = fa.active_today  || 0;
    const totalExecs  = fa.total_execs   || 0;
    const activePct   = totalExecs > 0 ? Math.round(activeToday / totalExecs * 100) : 0;
    const totalVisits = dcrData?.total_visits  || 0;
    const execsActive = dcrData?.execs_active  || 0;
    const pctColor    = activePct >= 80 ? 'var(--grn)' : activePct >= 50 ? 'var(--gold)' : 'var(--red)';
    const noVisit     = (fa.alerts || []).find(a => a.key === 'no_visit_today');
    const neverVis    = (fa.alerts || []).find(a => a.key === 'never_visited');
    const declining   = (fa.alerts || []).find(a => a.key === 'supply_declining');
    const osAlert     = (fa.alerts || []).find(a => a.key === 'os_outstanding');
    faKpis = [
      [activeToday + ' / ' + totalExecs,                                       'Active in Field (Prev Day)',   pctColor],
      [activePct + '%',                                                          'Team Coverage',               pctColor],
      [(totalVisits||0).toLocaleString('en-IN'),                                 'Agency Visits This Month',    'var(--ink)'],
      [(execsActive||0).toLocaleString('en-IN'),                                 'Execs with Visits',           'var(--acc)'],
      [noVisit  ? String(noVisit.count)  : '0',  'Not in Field Prev Day',        noVisit?.count  > 0 ? 'var(--red)'  : 'var(--grn)'],
      [neverVis ? String(neverVis.count) : '0',  'Agencies Never Visited',       neverVis?.count > 0 ? 'var(--red)'  : 'var(--grn)'],
    ];
    const parts = [];
    if (declining) parts.push(`<b style="color:var(--red)">${declining.count} execs</b> with supply decline`);
    if (osAlert  ) parts.push(`<b style="color:var(--gold)">${osAlert.count} agencies</b> with outstanding`);
    faFooter = parts.length
      ? parts.join(' &nbsp;·&nbsp; ')
      : `<span style="color:var(--grn)">✓ No critical field activity alerts</span>`;
    faBadge      = activeToday + ' / ' + totalExecs + ' active';
    faBadgeColor = pctColor;
  }

  /* ── Top KPI strip data ─────────────────────────────────── */
  // Supply, Outstanding and Collections all honour District / Executive-CI now. Two
  // sources still genuinely cannot: Reader Surveys (survey_data has neither column) and
  // Taxi Alerts (a today-only vehicle snapshot with no agency dimension at all) — they
  // say so rather than sitting there looking stuck. Cash supply is filterable by Centre
  // Incharge but NOT by district (hawker data has no district anywhere), so a district
  // selection alone drops Cash server-side (agent_only) and the Supply card says so.
  const narrowed  = !!(cf.district || cf.exec_name);
  const naNote    = narrowed ? ' · not filterable by district / executive' : '';
  // Cash Sale is CITY sale — hawker centres carry no district, and only 9 branches run
  // one at all. So the caption depends on which of those two is true, not on a generic
  // "unavailable": a district pick genuinely cannot split city sale, whereas a branch
  // with no centres simply has none to show.
  const hasCashCentres = !sup || sup.cash_centres == null ? true : sup.cash_centres > 0;
  const cashNote  = sup && sup.agent_only && hasCashCentres
    ? ' · Agent Sale only — Cash is city sale, not split by district' : '';
  const cashVal   = sup && sup.cash ? (Number(sup.cash.current) || 0).toLocaleString('en-IN') : null;
  const supHead   = 'Supply · ' + cmdPeriodLabel;
  const supLbl    = !sup || sup._err || sup.no_data ? supHead
    : (!hasCashCentres ? supHead + ' · Agent (credit sale branch)'
      : sup.agent_only ? supHead + ' · Agent' : supHead + ' · Agent+Cash');
  // Supply syncs overnight, so "Today" has no row until it lands. Say that rather than
  // falling back to the last synced day under a "Today" heading.
  const supPending = sup && !sup._err && sup.no_data;
  // Outstanding is a balance: as_on is null for the live CURRENT snapshot, else the
  // month-end date of the snapshot actually used (server decides and reports back).
  const ouAsOn    = ou && !ou._err && ou.as_on ? _cmdD(ou.as_on) : null;
  const strip = [
    { val: sup && !sup._err && !sup.no_data ? (Number(sup.total.current) || 0).toLocaleString('en-IN') : (c._supLoading ? '…' : (supPending ? '—' : '—')),
      lbl: supLbl, icon: '📦', color: 'var(--blue)', goto: "go('supply_dash')",
      sub: supPending ? 'Not synced yet for this period — supply loads overnight'
        : (sup && !sup._err ? 'Agent ' + (Number(sup.agent.current) || 0).toLocaleString('en-IN') + (cashVal != null && hasCashCentres ? ' · Cash ' + cashVal : '') + ' · ' + sup.data_upto + cashNote : '') },
    { val: ou && !ou._err ? _cmdFmtC(ou.total_outstanding)      : (c._ouLoading ? '…' : '—'),
      lbl: 'Outstanding · ' + (ouAsOn ? 'As on ' + ouAsOn : 'As on Today'), icon: '💰', color: 'var(--red)', goto: "go('outstanding')",
      sub: ou && !ou._err ? (ou.critical_count||0).toLocaleString('en-IN') + ' critical agencies'
        + (!ouAsOn && (cf.period === 'today' || cf.period === 'yesterday') ? ' · live balance, no daily history' : '') : '' },
    { val: co && !co._err ? _cmdFmtC(co.total_collection)        : (c._coLoading ? '…' : '—'),
      lbl: cmdPeriodLabel + ' Collections', icon: '₹',  color: 'var(--grn)', goto: "go('collections')",
      sub: co && !co._err ? (co.total_txn||0).toLocaleString('en-IN') + ' transactions' : '' },
    { val: si && !si._err ? String((si.late?.length||0) + (si.app_not_running?.length||0)) : (c._siLoading ? '…' : '—'),
      lbl: 'Taxi Alerts Today',  icon: '🚕', color: si && !si._err && (si.late?.length||0)+(si.app_not_running?.length||0)>0 ? 'var(--red)' : 'var(--grn)', goto: "go('transport')",
      sub: si && !si._err ? (si.late?.length||0)+' late · '+(si.app_not_running?.length||0)+' offline' + naNote : '' },
    { val: sv && !sv._err ? fmtN(sv.total||0)                   : (c._svLoading ? '…' : '—'),
      lbl: 'Reader Surveys',     icon: '📋', color: 'var(--acc)', goto: "go('survey_dash')",
      sub: sv && !sv._err ? fmtN(sv.order_count||0) + ' orders booked' + naNote : '' },
  ];

  /* ── Pending modules ────────────────────────────────────── */
  const pending = [
    { icon:'🛵', title:'Hawker Operations',      desc:'Route coverage, reader database, earnings, missed drops' },
    { icon:'🚚', title:'Vehicle Tracking',       desc:'Delays, breakdowns, real-time location, compliance' },
  ];

  /* ── Supply (Agent + Cash), current vs previous business day ─────────── */
  let supKpis, supFooter, supBadge;
  if (sup && !sup._err && !sup.no_data) {
    const cp = n => (Number(n) || 0).toLocaleString('en-IN');
    const g = sup.total.growth_pct;
    // The Cash tile is dropped in two different situations: sup.cash is null when a
    // district is selected (city sale has no district split), and cash_centres is 0 for
    // the ~30 branches that are pure credit sale and have no hawker centre at all.
    // Showing "Cash 0 cp" in either case would read as a real zero rather than N/A.
    supKpis = [
      [cp(sup.total.current) + ' cp', (sup.agent_only || !hasCashCentres ? 'Agent Supply · ' : 'Total Supply · ') + sup.data_upto, 'var(--ink)'],
      [cp(sup.agent.current) + ' cp', 'Agent Sale (' + (sup.agent_share_pct != null ? sup.agent_share_pct + '%' : '—') + ')', 'var(--blue)'],
      ...(sup.cash && hasCashCentres ? [[cp(sup.cash.current) + ' cp', 'Cash Sale · city (' + (sup.cash_share_pct != null ? sup.cash_share_pct + '%' : '—') + ')', 'var(--gold)']] : []),
      [(g >= 0 ? '+' : '') + (g != null ? g : 0) + '%', 'Day-over-Day', g >= 0 ? 'var(--grn)' : 'var(--red)'],
    ];
    supFooter = `Prev day <b>${cp(sup.total.previous)}</b> cp · change <b style="color:${sup.total.diff >= 0 ? 'var(--grn)' : 'var(--red)'}">${sup.total.diff >= 0 ? '+' : ''}${cp(sup.total.diff)}</b> · ${sup.cur_label} vs ${sup.prev_label}`;
    supBadge = cp(sup.total.current) + ' copies';
  }

  /* ── Filter bar ──────────────────────────────────────────── */
  const CMD_STATE_OPTS = [['RAJASTHAN','Rajasthan'],['MADHYA PRADESH','Madhya Pradesh'],['CHHATTISGARH','Chhattisgarh'],['NATIONAL','National']];
  const CMD_CORE_STATES = new Set(['RAJASTHAN','MADHYA PRADESH','CHHATTISGARH']);
  const cmdRegionOf = s => { const u = String(s || '').toUpperCase(); return CMD_CORE_STATES.has(u) ? u : 'NATIONAL'; };
  const cmdUnits = S.live.cmdUnits || [];
  const cmdUnitsInState = cf.state ? cmdUnits.filter(u => cmdRegionOf(u.state_name) === cf.state) : cmdUnits;
  _cmdLoadCascade(cf.unit_code);
  const cmdDistricts = (cf.unit_code && S.live.cmdDistrictsByUnit && S.live.cmdDistrictsByUnit[cf.unit_code]) || [];
  const cmdExecs     = (cf.unit_code && S.live.cmdExecsByUnit     && S.live.cmdExecsByUnit[cf.unit_code])     || [];
  const periodBtn = (p, label, edge) => `<button onclick="cmdSetPeriod('${p}')" style="padding:7px 16px;border:1px solid var(--brd);${edge === 'l' ? 'border-radius:8px 0 0 8px;border-right:none' : edge === 'r' ? 'border-radius:0 8px 8px 0' : 'border-left:none;border-right:none'};background:${cf.period === p ? 'var(--navy,#1C2B45)' : 'var(--card)'};color:${cf.period === p ? '#fff' : 'var(--ink)'};font-size:12.5px;font-weight:600;cursor:pointer">${label}</button>`;
  const filterBar = `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;padding:12px 0 18px;border-bottom:1px solid var(--brd);margin-bottom:18px">
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:5px">Period</div>
      <div style="display:flex">${periodBtn('today', 'Today', 'l')}${periodBtn('yesterday', 'Yesterday')}${periodBtn('month', 'This month')}${periodBtn('last_month', 'Last month')}${periodBtn('quarter', 'Quarter', 'r')}</div>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:5px">State</div>
      <select onchange="cmdSetState(this.value)" style="padding:7px 10px;border:1px solid var(--brd);border-radius:8px;background:var(--card);color:var(--ink);font-size:12.5px;min-width:150px">
        <option value="">All States</option>
        ${CMD_STATE_OPTS.map(([v, l]) => `<option value="${v}" ${cf.state === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:5px">Unit</div>
      <select onchange="cmdSetUnit(this.value, this.selectedOptions[0].dataset.name||'')" style="padding:7px 10px;border:1px solid var(--brd);border-radius:8px;background:var(--card);color:var(--ink);font-size:12.5px;min-width:170px">
        <option value="">All Units</option>
        ${cmdUnitsInState.map(u => `<option value="${esc(u.unit_code)}" data-name="${esc(u.unit_name || u.unit_code)}" ${cf.unit_code === u.unit_code ? 'selected' : ''}>${esc(u.unit_name || u.unit_code)}</option>`).join('')}
      </select>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:5px">District</div>
      <select onchange="cmdSetDistrict(this.value)" ${!cf.unit_code ? 'disabled' : ''} style="padding:7px 10px;border:1px solid var(--brd);border-radius:8px;background:var(--card);color:var(--ink);font-size:12.5px;min-width:150px${!cf.unit_code ? ';opacity:.55;cursor:not-allowed' : ''}">
        <option value="">${cf.unit_code ? 'All Districts' : 'Pick a unit first'}</option>
        ${cmdDistricts.map(d => `<option value="${esc(d)}" ${cf.district === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
      </select>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:5px">Executive / Centre Incharge</div>
      <select onchange="cmdSetExec(this.value)" ${!cf.unit_code ? 'disabled' : ''} style="padding:7px 10px;border:1px solid var(--brd);border-radius:8px;background:var(--card);color:var(--ink);font-size:12.5px;min-width:230px${!cf.unit_code ? ';opacity:.55;cursor:not-allowed' : ''}">
        <option value="">${cf.unit_code ? 'All Executives & CIs' : 'Pick a unit first'}</option>
        ${(() => {
          // Executives run credit-sale agencies (Agent supply); Centre Incharges run
          // hawker centres (Cash supply). Grouped and CI-suffixed so it is obvious which
          // half of the business a name will narrow — see /executives/:unit.
          const grp = (role, label, cnt) => {
            const list = cmdExecs.filter(e => e.role === role);
            if (!list.length) return '';
            return `<optgroup label="${label} (${list.length})">` + list.map(e =>
              `<option value="${esc(e.name)}" ${cf.exec_name === e.name ? 'selected' : ''}>${esc(e.name)}${role === 'CI' ? ' · CI' : ''}${cnt(e) ? ` (${cnt(e)})` : ''}</option>`).join('') + `</optgroup>`;
          };
          return grp('EXEC', 'Executives', e => e.agencies)
               + grp('CI',   'Centre Incharges', e => e.hawkers);
        })()}
      </select>
    </div>
    ${cf.state || cf.unit_code || cf.district || cf.exec_name || cf.period !== 'month' ? `<button onclick="cmdResetFilters()" style="padding:7px 14px;border:1px solid var(--brd);border-radius:8px;background:var(--card);color:var(--muted);font-size:12px;cursor:pointer">✕ Reset filters</button>` : ''}
  </div>`;

  return pagehead('Command Centre', cmdSubtitle) + _cmdDesignSwitch('legacy') + filterBar + `
    <style>
      ._cmd-card{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:16px 18px;transition:box-shadow .15s,border-color .15s}
      ._cmd-card[onclick]:hover{box-shadow:0 4px 20px rgba(0,0,0,.11);border-color:var(--acc)}
      ._cmd-strip-item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}
      @keyframes _cmdPulse{0%,100%{opacity:1}50%{opacity:.45}}
    </style>

    <!-- Top KPI summary strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:14px">
      ${strip.map(s => `
        <div class="_cmd-strip-item" style="border-left:4px solid ${s.color}${s.goto ? ';cursor:pointer' : ''}"
          ${s.goto ? `onclick="${s.goto}" role="button" tabindex="0" title="Open ${s.lbl}"` : ''}>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.lbl}</span>
          </div>
          <div style="font-size:24px;font-weight:800;color:${s.color};line-height:1.1;font-variant-numeric:tabular-nums;margin-top:2px">${s.val}</div>
          ${s.sub ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">${s.sub}</div>` : '<div style="height:14px"></div>'}
        </div>
      `).join('')}
    </div>

    <!-- main card grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      ${_cmdModuleCard({
        icon:'💰', title:'Agency Outstanding', period: ouAsOn ? 'Month-end balance as on ' + ouAsOn : 'Balance as on today',
        onClick:"go('outstanding')", accent:'var(--red)',
        kpis: ouKpis, footer: ouFooter,
        loading: !ou && !c._ouError, error: ou?._err,
        badge: ou && !ou._err ? _cmdFmtC(ou.total_outstanding) + ' outstanding' : null,
        badgeColor: 'var(--red)',
      })}
      ${_cmdModuleCard({
        icon:'₹', title:'Collections', period: cmdPeriodLabel + ' (' + cmdPeriod.from + ' to ' + cmdPeriod.to + ') · ' + (co && !co._err ? (co.total_txn||0).toLocaleString('en-IN') : '…') + ' transactions',
        onClick:"go('collections')", accent:'var(--grn)',
        kpis: coKpis, footer: coFooter,
        loading: !co && !c._coError, error: co?._err,
        badge: co && !co._err ? _cmdFmtC(co.total_collection) + ' collected' : null,
        badgeColor: 'var(--grn)',
      })}
      ${_cmdModuleCard({
        icon:'📦', title:'Supply', period: supPending ? cmdPeriodLabel + ' · not synced yet (supply loads overnight)'
          : (sup && (sup.agent_only || !hasCashCentres) ? 'Agent only · ' : 'Agent + Cash · ') + (sup && !sup._err && !sup.no_data ? sup.data_upto : '…') + cashNote,
        onClick:"go('supply_dash')", accent:'var(--blue)',
        kpis: supKpis, footer: supFooter,
        loading: !sup && c._supLoading, error: sup?._err,
        badge: supBadge, badgeColor: 'var(--blue)',
      })}
      ${_cmdModuleCard({
        icon:'🚕', title:'Taxi Deliveries', period:"Today's supply alerts",
        onClick:"go('transport')", accent: siBadgeColor || 'var(--gold)',
        kpis: siKpis, footer: siFooter,
        loading: !si && !c._siError, error: si?._err,
        badge: siBadge, badgeColor: siBadgeColor,
      })}
      ${_cmdModuleCard({
        icon:'📍', title:'Field Intelligence', period: 'DCR activity · ' + cmdPeriodLabel.toLowerCase() + naNote,
        onClick:"go('dcr_analytics')", accent: faBadgeColor || 'var(--acc)',
        kpis: faKpis, footer: faFooter,
        loading: !fa, error: fa?._err,
        badge: faBadge, badgeColor: faBadgeColor,
      })}
      ${_cmdModuleCard({
        icon:'📋', title:'Survey Intelligence', period: 'Reader survey outcomes · ' + cmdPeriodLabel.toLowerCase() + naNote,
        onClick:"go('survey_dash')", accent:'var(--acc)',
        kpis: svKpis, footer: svFooter,
        loading: !sv && !c._svError, error: sv?._err,
        badge: sv && !sv._err ? fmtN(sv.total||0) + ' surveyed' : null,
        badgeColor: 'var(--acc)',
      })}
    </div>

    ${_cmdAnalyticsSection(c)}`;
    /* Pending Oracle Sync cards (Hawker Operations, Vehicle Tracking) hidden
       until those syncs go live — restore by re-adding the pending.map block */
}

/* ── Command Centre — NEW design (work in progress). Starts as an exact copy of
   the current dashboard so the redesign begins from something that already works;
   change this freely, the stable version above is unaffected. ── */
/* ═══════════ Circulation Command Centre — state-wise management view ═══════════
   Built to the Circulation Dashboard Redesign brief: compare states first, surface
   risk and opportunity, then drill. Every number on this screen comes from ONE
   endpoint (/api/command/state-performance) so the cards, the alerts and the market
   share can never disagree with each other. */

function _ccState() {
  return S.live.cc || (S.live.cc = { asOn: '', compare: 'prev_day', range: 'mtd', state: '', unit: '', district: '', data: null, _loading: false, drill: null });
}
window.ccSet = (k, v) => {
  const st = _ccState();
  st[k] = v;
  if (k === 'state') { st.unit = ''; st.district = ''; }
  if (k === 'unit') st.district = '';
  st.data = null; st._loading = false;
  render();
};
window.ccReset = () => { S.live.cc = null; render(); };
window.ccDrill = (screen, stateKey) => {
  // Hand the destination dashboard the same state the card was showing, so the
  // drill lands already filtered instead of dumping the user at an all-India view.
  try {
    if (screen === 'supply_dash') { const s = _supdState(); s.state = stateKey; s.unit = ''; _supdClearData(s); }
    else if (screen === 'collections') { const s = colState(); s.filters.state = stateKey; s.filters.branch = ''; s.kpis = null; }
    else if (screen === 'outstanding') { const s = ouState(); s.filters.state = _ccOsCode(stateKey); s.filters.unit_code = ''; if (typeof ouClearCache === 'function') ouClearCache(); }
    else if (screen === 'dcr_analytics') { _dcrA.state = _ccDcrName(stateKey); _dcrA.unit_code = ''; _dcrA.summary = _dcrA.execs = _dcrA.analysis = _dcrA.coverage = null; }
  } catch (_) {}
  go(screen);
};
const _ccOsCode  = k => ({ 'RAJASTHAN': 'RPPL', 'MADHYA PRADESH': 'MP', 'CHHATTISGARH': 'CG' }[k] || 'NATIONAL');
const _ccDcrName = k => ({ 'RAJASTHAN': 'Rajasthan', 'MADHYA PRADESH': 'Madhya Pradesh', 'CHHATTISGARH': 'Chhattisgarh' }[k] || 'National');

function _ccLoad() {
  const st = _ccState();
  if (st._loading || st.data) return;
  st._loading = true;
  const p = new URLSearchParams();
  if (st.asOn) p.set('as_on', st.asOn);
  if (st.compare) p.set('compare', st.compare);
  if (st.range) p.set('range', st.range);
  if (st.unit) p.set('unit_code', st.unit);
  fetch(`${location.origin}/api/command/state-performance?${p}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.data = d; st._loading = false; if (S.screen === 'command') render(); })
    .catch(() => { st.data = { _err: true }; st._loading = false; if (S.screen === 'command') render(); });
}

/* ── small formatters ── */
const _ccINR = v => { const n = Number(v) || 0, a = Math.abs(n);
  return a >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString('en-IN')}`; };
const _ccN = v => (Number(v) || 0).toLocaleString('en-IN');
const _CC_STATUS = {
  healthy:  { bg: '#dcfce7', fg: '#15803d', label: 'Healthy' },
  watch:    { bg: '#fef3c7', fg: '#b45309', label: 'Watch' },
  critical: { bg: '#fee2e2', fg: '#b91c1c', label: 'Critical' },
};
const _CC_PRI = {
  critical: { bg: '#fef2f2', bar: '#dc2626', fg: '#b91c1c', label: 'Critical' },
  high:     { bg: '#fff7ed', bar: '#ea580c', fg: '#c2410c', label: 'High' },
  medium:   { bg: '#fffbeb', bar: '#d97706', fg: '#b45309', label: 'Medium' },
  low:      { bg: '#eff6ff', bar: '#2563eb', fg: '#1d4ed8', label: 'Low' },
};
function _ccTrend(pct, invert) {
  if (pct == null) return `<span style="color:var(--muted);font-size:11px">—</span>`;
  const up = pct >= 0, good = invert ? !up : up;
  const col = pct === 0 ? 'var(--muted)' : good ? '#15803d' : '#b91c1c';
  return `<span style="color:${col};font-weight:700;font-size:11.5px;white-space:nowrap">${pct === 0 ? '' : up ? '▲' : '▼'} ${up && pct !== 0 ? '+' : ''}${pct}%</span>`;
}
function _ccBar(pctVal, color) {
  const w = Math.max(0, Math.min(100, Number(pctVal) || 0));
  return `<div style="height:6px;background:#eef2f7;border-radius:4px;overflow:hidden;margin-top:5px">
    <div style="height:100%;width:${w}%;background:${color};border-radius:4px"></div></div>`;
}

/* ── Right-side flyout for an alert / opportunity ──
   Opening a card used to jump to another dashboard, which lost the context of WHY it
   was flagged. The flyout keeps the user on the Command Centre and pulls the actual
   rows behind the headline, with a link out only if they want the full screen. */
window.ccFly = (kind, idx) => {
  const st = _ccState();
  const src = kind === 'alert' ? (st.data && st.data.alerts) : (st.data && st.data.opportunities);
  const item = (src || [])[idx];
  if (!item) return;
  st.fly = { kind, item, rows: null, loading: true };
  render();
  const p = new URLSearchParams({ kpi: item.kpi || item.type || '', state: item.state || '' });
  if (st.asOn) p.set('as_on', st.asOn);
  if (st.compare) p.set('compare', st.compare);
  fetch(`${location.origin}/api/command/alert-detail?${p}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => { if (st.fly) { st.fly.rows = d.rows || []; st.fly.columns = d.columns || []; st.fly.loading = false; } if (S.screen === 'command') render(); })
    .catch(() => { if (st.fly) { st.fly.rows = []; st.fly.loading = false; } if (S.screen === 'command') render(); });
};
window.ccFlyClose = () => { const st = _ccState(); st.fly = null; render(); };

function _ccFlyout() {
  const st = _ccState();
  const f = st.fly;
  if (!f) return '';
  const it = f.item;
  const isAlert = f.kind === 'alert';
  const accent = isAlert ? (_CC_PRI[it.priority] || _CC_PRI.medium).bar : '#16a34a';
  const q = v => String(v).replace(/'/g, "\\'");
  const num = v => (Number(v) || 0).toLocaleString('en-IN');
  const money = v => _ccINR(v);

  const body = f.loading
    ? `<div style="padding:26px;text-align:center;color:#64748b;font-size:13px">Loading detail…</div>`
    : !(f.rows || []).length
      ? `<div style="padding:20px;color:#64748b;font-size:13px">No supporting rows found for this item.</div>`
      : `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em">
            ${(f.columns || []).map((c, i) => `<th style="text-align:${i === 0 ? 'left' : 'right'};padding:6px 8px;position:sticky;top:0;background:#f8fafc">${esc(c)}</th>`).join('')}
          </tr></thead>
          <tbody>${f.rows.map(r => {
            const cells = r.amount != null
              ? [`<b>${esc(r.label)}</b>`, esc(r.unit_name || r.unit_code || ''), esc(r.exec || '—'), `<b style="color:#b91c1c">${money(r.amount)}</b>`]
              : [`<b>${esc(r.label)}</b>`, num(r.a), num(r.b),
                 `<b style="color:${r.delta < 0 ? '#b91c1c' : '#15803d'}">${r.delta > 0 ? '+' : ''}${num(r.delta)}</b>`];
            return `<tr style="border-top:1px solid #eef2f7">${cells.map((c, i) =>
              `<td style="padding:7px 8px;text-align:${i === 0 ? 'left' : 'right'};${i === 0 ? 'max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' : 'font-variant-numeric:tabular-nums'}">${c}</td>`).join('')}</tr>`;
          }).join('')}</tbody></table>`;

  return `<div onclick="ccFlyClose()" style="position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:300"></div>
  <aside role="dialog" aria-modal="true" style="position:fixed;top:0;right:0;bottom:0;width:min(560px,94vw);background:#fff;z-index:301;box-shadow:-8px 0 30px rgba(15,23,42,.18);display:flex;flex-direction:column;animation:ccSlide .18s ease-out">
    <div style="border-top:4px solid ${accent};padding:14px 18px 12px;border-bottom:1px solid #e2e8f0">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="min-width:0;flex:1">
          <div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${accent}">
            ${isAlert ? esc((_CC_PRI[it.priority] || _CC_PRI.medium).label) + ' · ' + esc(it.kpi || '') : esc(it.type || 'Opportunity')}
          </div>
          <div style="font-size:16px;font-weight:800;color:#0f172a;margin-top:3px">${esc(it.title)}</div>
        </div>
        <button onclick="ccFlyClose()" aria-label="Close"
          style="flex:none;width:30px;height:30px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#64748b;font-size:17px;line-height:1;cursor:pointer">×</button>
      </div>
      <div style="font-size:12px;color:#475569;margin-top:8px">${esc(it.impact)}</div>
      <div style="font-size:12px;color:#0f172a;background:#f8fafc;border-radius:7px;padding:8px 10px;margin-top:9px"><b>Recommended action:</b> ${esc(it.action)}</div>
    </div>
    <div style="flex:1;overflow:auto;padding:12px 14px">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:7px">Behind this number</div>
      ${body}
    </div>
    <div style="border-top:1px solid #e2e8f0;padding:11px 16px;display:flex;gap:9px;justify-content:flex-end">
      <button onclick="ccFlyClose()" style="padding:8px 15px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#475569;font-size:12.5px;cursor:pointer">Close</button>
      <button onclick="ccFlyClose();ccDrill('${it.drill.screen}','${q(it.drill.state)}')"
        style="padding:8px 15px;border:none;border-radius:8px;background:#1e3a8a;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer">Open full dashboard →</button>
    </div>
  </aside>
  <style>@keyframes ccSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}
  @media(prefers-reduced-motion:reduce){aside[role=dialog]{animation:none}}</style>`;
}

/* ── Grouped bar chart: base FY vs current FY, by quarter ──
   Inline SVG so it needs no chart library and prints/exports cleanly. */
function _ccQuarterChart(rows, baseLabel, curLabel, fmt, color) {
  const max = Math.max(1, ...rows.flatMap(r => [Number(r.base) || 0, Number(r.current) || 0]));
  const W = 100, gap = 3, bw = (W / rows.length - gap) / 2;
  const bars = rows.map((r, i) => {
    const x = i * (W / rows.length) + gap / 2;
    const hb = Math.max(0, (Number(r.base) || 0) / max * 100);
    const hc = Math.max(0, (Number(r.current) || 0) / max * 100);
    return `<g>
      <rect x="${x}" y="${100 - hb}" width="${bw}" height="${hb}" fill="#cbd5e1" rx="0.6"></rect>
      <rect x="${x + bw + 0.4}" y="${100 - hc}" width="${bw}" height="${hc}" fill="${color}" rx="0.6"></rect>
    </g>`;
  }).join('');
  return `<div>
    <div style="display:flex;gap:14px;font-size:11px;color:#64748b;margin-bottom:7px">
      <span><i style="display:inline-block;width:9px;height:9px;background:#cbd5e1;border-radius:2px;margin-right:5px"></i>${esc(baseLabel)}</span>
      <span><i style="display:inline-block;width:9px;height:9px;background:${color};border-radius:2px;margin-right:5px"></i>${esc(curLabel)}</span>
    </div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:150px;display:block">${bars}</svg>
    <div style="display:grid;grid-template-columns:repeat(${rows.length},1fr);margin-top:5px">
      ${rows.map(r => `<div style="text-align:center">
        <div style="font-size:11px;font-weight:700;color:#0f172a">${r.q}</div>
        <div style="font-size:10px;color:#94a3b8">${fmt(r.current)}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

/* ── headline card for the all-India strip ──
   The coloured top rule is what separates one card from the next; no icons, per the
   "simple and clear" direction. Every card states the window it covers, because they
   deliberately do NOT all follow the date range — supply is a point-in-time count and
   outstanding is a balance, so only collection and field visits move with it. */
function _ccTopCard(o) {
  return `<div ${o.onClick ? `onclick="${o.onClick}" ` : ''}style="background:#fff;border:1px solid #e2e8f0;border-top:3px solid ${o.color};border-radius:11px;padding:12px 14px;${o.onClick ? 'cursor:pointer;' : ''}display:flex;flex-direction:column;gap:2px">
    <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:#64748b;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.label)}</div>
    <div style="display:flex;align-items:baseline;gap:7px;flex-wrap:wrap">
      <span style="font-size:22px;font-weight:800;color:#1e3a8a;line-height:1.15;font-variant-numeric:tabular-nums">${o.value}</span>
      ${o.trend || ''}
    </div>
    <div style="font-size:10.5px;color:#94a3b8">${o.sub || ''}</div>
    ${o.barPct != null ? _ccBar(o.barPct, o.color) : ''}
  </div>`;
}

/* ── one KPI row inside a state card ── */
function _ccKpiRow(label, value, sub, trendHtml, barPct, barColor, onClick) {
  return `<div onclick="${onClick}" style="cursor:pointer;padding:8px 0;border-top:1px solid #eef2f7"
      onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
      <span style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:.02em">${label}</span>
      ${trendHtml}
    </div>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:2px">
      <span style="font-size:16px;font-weight:800;color:#0f172a;font-variant-numeric:tabular-nums">${value}</span>
      <span style="font-size:10.5px;color:#94a3b8;text-align:right">${sub || ''}</span>
    </div>
    ${barPct != null ? _ccBar(barPct, barColor) : ''}
  </div>`;
}

/* ── state performance card ── */
function _ccStateCard(s) {
  const st = _CC_STATUS[s.supply.status] || _CC_STATUS.watch;
  // Card-level status is the worst of the four, so a card can never look calm while
  // one of its KPIs is critical.
  const rank = { healthy: 0, watch: 1, critical: 2 };
  const worst = [s.supply.status, s.collection.status, s.os.status, s.dcr.status]
    .reduce((a, b) => (rank[b] > rank[a] ? b : a), 'healthy');
  const w = _CC_STATUS[worst];
  const q = v => String(v).replace(/'/g, "\\'");

  return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px">
      <div style="min-width:0">
        <div onclick="ccDrill('supply_dash','${q(s.key)}')" style="cursor:pointer;font-size:16px;font-weight:800;color:#1e3a8a">${esc(s.name)}</div>
        <div style="font-size:11px;color:#64748b;margin-top:1px">${s.head ? esc(s.head) : 'State Head —'}</div>
      </div>
      <span style="flex:none;background:${w.bg};color:${w.fg};font-size:10.5px;font-weight:800;padding:3px 10px;border-radius:11px">${w.label}</span>
    </div>

    ${_ccKpiRow('SUPPLY', _ccN(s.supply.current) + ' cp',
      `Agent ${_ccN(s.supply.agent)} · Cash ${_ccN(s.supply.cash)}`,
      _ccTrend(s.supply.growth_pct),
      null, null, `ccDrill('supply_dash','${q(s.key)}')`)}

    ${_ccKpiRow('COLLECTION', _ccINR(s.collection.current),
      `of ${_ccINR(s.collection.prev_month_billing)} billed ${esc(s.collection.prev_month_label || '')}`,
      `<span style="font-size:11.5px;font-weight:800;color:${s.collection.collection_pct >= 85 ? '#15803d' : s.collection.collection_pct >= 60 ? '#b45309' : '#b91c1c'}">${s.collection.collection_pct == null ? '—' : s.collection.collection_pct + '%'}</span>`,
      s.collection.collection_pct, s.collection.collection_pct >= 85 ? '#22c55e' : s.collection.collection_pct >= 60 ? '#f59e0b' : '#ef4444',
      `ccDrill('collections','${q(s.key)}')`)}

    ${_ccKpiRow('OUTSTANDING', _ccINR(s.os.current),
      `${_ccN(s.os.critical_agencies)} agencies above ₹1 L`,
      _ccTrend(s.os.growth_pct, true),
      null, null, `ccDrill('outstanding','${q(s.key)}')`)}

    ${_ccKpiRow('DCR — FIELD VISITS', _ccN(s.dcr.current),
      `${_ccN(s.dcr.agencies_visited)} of ${_ccN(s.dcr.agencies_total)} agencies`,
      `<span style="font-size:11.5px;font-weight:800;color:${s.dcr.coverage_pct >= 5 ? '#15803d' : s.dcr.coverage_pct >= 2 ? '#b45309' : '#b91c1c'}">${s.dcr.coverage_pct == null ? '—' : s.dcr.coverage_pct + '%'}</span>`,
      s.dcr.coverage_pct, s.dcr.coverage_pct >= 5 ? '#22c55e' : s.dcr.coverage_pct >= 2 ? '#f59e0b' : '#ef4444',
      `ccDrill('dcr_analytics','${q(s.key)}')`)}
  </div>`;
}

function _ccAlertCard(a, idx) {
  const p = _CC_PRI[a.priority] || _CC_PRI.medium;
  return `<div onclick="ccFly('alert',${idx})"
      style="cursor:pointer;background:${p.bg};border-left:4px solid ${p.bar};border-radius:8px;padding:10px 13px;margin-bottom:8px">
    <div style="display:flex;align-items:baseline;gap:8px">
      <span style="flex:none;width:19px;height:19px;border-radius:50%;background:${p.bar}22;color:${p.fg};font-size:10.5px;font-weight:800;display:inline-flex;align-items:center;justify-content:center">${idx + 1}</span>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:700;color:${p.fg}">${esc(a.title)}</div>
        <div style="font-size:11.5px;color:#475569;margin-top:2px">${esc(a.impact)}</div>
        <div style="font-size:11px;color:#64748b;margin-top:3px"><b>Action:</b> ${esc(a.action)}</div>
      </div>
      <span style="flex:none;font-size:9.5px;font-weight:800;color:${p.fg};background:#fff;border:1px solid ${p.bar}44;padding:2px 7px;border-radius:9px">${p.label}</span>
    </div>
  </div>`;
}

function _ccOppCard(o, idx) {
  return `<div onclick="ccFly('opp',${idx})"
      style="cursor:pointer;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:8px;padding:10px 13px;margin-bottom:8px">
    <div style="display:flex;align-items:baseline;gap:8px">
      <span style="flex:none;width:19px;height:19px;border-radius:50%;background:#16a34a22;color:#15803d;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center">✓</span>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:700;color:#15803d">${esc(o.title)}</div>
        <div style="font-size:11.5px;color:#475569;margin-top:2px">${esc(o.impact)}</div>
        <div style="font-size:11px;color:#64748b;margin-top:3px"><b>Action:</b> ${esc(o.action)}</div>
      </div>
      <span style="flex:none;font-size:9.5px;font-weight:800;color:#15803d;background:#fff;border:1px solid #16a34a44;padding:2px 7px;border-radius:9px">${esc(o.type)}</span>
    </div>
  </div>`;
}

function _cmdViewNew() {
  const st = _ccState();
  _ccLoad();
  const d = st.data;

  const sel = (label, key, value, opts) => `<div>
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:5px">${label}</div>
    <select onchange="ccSet('${key}',this.value)" style="padding:7px 10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0f172a;font-size:12.5px;min-width:150px">
      ${opts.map(([v, l]) => `<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select></div>`;

  /* The old filter strip is gone. Only the date range remains, floated top-right as a
     single control — state and unit are reached by clicking a state card instead, which
     is the drill path the dashboard is built around. Snapshot date sits beside it so the
     figures are always dated without a separate crumb line. */
  const bar = `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:14px;flex-wrap:wrap">
    <div style="font-size:12px;color:#64748b">
      ${d && !d._err ? `Snapshot: <b style="color:#0f172a">${esc(d.as_on)}</b> · compared with <b style="color:#0f172a">${esc(d.previous)}</b>` : ''}
      ${st.state ? ` · <b style="color:#1e3a8a">${esc(st.state)}</b> <a onclick="ccSet('state','')" style="cursor:pointer;color:#64748b;text-decoration:underline">clear</a>` : ''}
    </div>
    <div style="display:flex;align-items:flex-end;gap:9px">
      ${sel('Date range', 'range', st.range, [['today','Today'],['mtd','This Month'],['last_month','Last Month'],['fytd','Current FY (YTD)'],['last_90','Last 90 Days']])}
    </div>
  </div>`;

  if (st._loading || !d) return _cmdDesignSwitch('new') + bar + _cmdSkel() + _cmdSkel();
  if (d._err || d.detail) return _cmdDesignSwitch('new') + bar
    + `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:18px;color:#b91c1c">Could not load state performance.</div>`;

  const shown = (d.states || []).filter(s => !st.state || s.key === st.state);

  // ── All-India headline strip ──
  const t = d.totals || {};
  const q = v => String(v).replace(/'/g, "\\'");
  const anyState = st.state || (shown[0] && shown[0].key) || 'RAJASTHAN';
  // Fixed 4 columns so the eight cards read as a balanced 4-over-4 block rather than
  // auto-fitting into a ragged 5/3 split at common widths.
  const topStrip = !t.supply ? '' : `<div class="cc-strip" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;margin-bottom:18px">
    ${_ccTopCard({ label: st.state ? esc(shown[0] ? shown[0].name : '') + ' Supply' : 'Total Supply', color: '#3b82f6',
      value: _ccN(t.supply.value) + ' <span style="font-size:12px;font-weight:600;color:#64748b">cp</span>',
      trend: _ccTrend(t.supply.growth_pct), sub: `Agent + Cash · ${esc(t.supply.window)}`,
      onClick: `ccDrill('supply_dash','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Agent Sale', color: '#6366f1',
      value: _ccN(t.agent.value) + ' <span style="font-size:12px;font-weight:600;color:#64748b">cp</span>',
      sub: `${t.agent.share_pct == null ? '' : t.agent.share_pct + '% of supply · '}credit agencies`,
      barPct: t.agent.share_pct, onClick: `ccDrill('supply_dash','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Cash Sale', color: '#f59e0b',
      value: _ccN(t.cash.value) + ' <span style="font-size:12px;font-weight:600;color:#64748b">cp</span>',
      sub: `${t.cash.share_pct == null ? '' : t.cash.share_pct + '% of supply · '}city / hawker`,
      barPct: t.cash.share_pct, onClick: `ccDrill('supply_dash','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Collection', color: '#22c55e',
      value: _ccINR(t.collection.value), sub: `${_ccN(t.collection.txn)} receipts · ${esc(t.collection.window)}`,
      onClick: `ccDrill('collections','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Collection vs Billing', color: '#10b981',
      value: (t.collection_pct.value == null ? '—' : t.collection_pct.value + '%'),
      sub: `${_ccINR(t.collection_pct.collected)} of ${_ccINR(t.collection_pct.billed)} · ${esc(t.collection_pct.window)}`,
      barPct: t.collection_pct.value, onClick: `ccDrill('collections','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Outstanding', color: '#ef4444',
      value: _ccINR(t.outstanding.value), trend: _ccTrend(t.outstanding.growth_pct, true),
      sub: `balance ${esc(t.outstanding.window)}`, onClick: `ccDrill('outstanding','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Critical Agencies', color: '#dc2626',
      value: _ccN(t.critical.value), sub: `of ${_ccN(t.critical.of)} · ${esc(t.critical.window)}`,
      barPct: t.critical.of ? (t.critical.value / t.critical.of) * 100 : null,
      onClick: `ccDrill('outstanding','${q(anyState)}')` })}
    ${_ccTopCard({ label: 'Field Coverage', color: '#8b5cf6',
      value: (t.coverage.pct == null ? '—' : t.coverage.pct + '%'),
      sub: `${_ccN(t.coverage.value)} of ${_ccN(t.coverage.of)} agencies · ${esc(t.coverage.window)}`,
      barPct: t.coverage.pct, onClick: `ccDrill('dcr_analytics','${q(anyState)}')` })}
  </div>
  <style>@media(max-width:1180px){.cc-strip{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
  @media(max-width:560px){.cc-strip{grid-template-columns:1fr!important}}</style>`;

  // ── Quarterly base-vs-current charts ──
  const Q = d.quarterly;
  const charts = !Q ? '' : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px" class="cc-two">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
      <div style="font-size:14.5px;font-weight:800;color:#0f172a">Quarterly Collection</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:10px">${esc(Q.fy_base)} (Base) vs ${esc(Q.fy_current)} · receipts banked</div>
      ${_ccQuarterChart(Q.collection, Q.fy_base, Q.fy_current, _ccINR, '#22c55e')}
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
      <div style="font-size:14.5px;font-weight:800;color:#0f172a">Quarterly Supply</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:10px">${esc(Q.fy_base)} (Base) vs ${esc(Q.fy_current)} · average copies per day</div>
      ${_ccQuarterChart(Q.supply, Q.fy_base, Q.fy_current, v => _ccN(v) + ' cp', '#3b82f6')}
    </div>
  </div>`;

  const cards = `<div style="font-size:11px;font-weight:800;letter-spacing:.06em;color:#64748b;text-transform:uppercase;margin:0 0 8px 2px">State-wise Performance</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));gap:12px;margin-bottom:18px">
    ${shown.map(_ccStateCard).join('')}
  </div>`;

  const alerts = (d.alerts || []).filter(a => !st.state || a.state === st.state);
  const opps   = (d.opportunities || []).filter(o => !st.state || o.state === st.state);

  const twoCol = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px" class="cc-two">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
      <div style="font-size:15px;font-weight:800;color:#b91c1c;margin-bottom:2px">Key Alerts &amp; Critical Risks</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:11px">Auto-derived from the ${esc(String(d.compare_label || '').toLowerCase())} comparison · click to drill down</div>
      ${alerts.length ? alerts.map(_ccAlertCard).join('')
        : `<div style="font-size:12.5px;color:#15803d;background:#f0fdf4;border-radius:8px;padding:14px">No alerts triggered for this selection.</div>`}
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
      <div style="font-size:15px;font-weight:800;color:#15803d;margin-bottom:2px">Key Opportunities</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:11px">Growth and recovery with estimated impact · click to drill down</div>
      ${opps.length ? opps.map(_ccOppCard).join('')
        : `<div style="font-size:12.5px;color:#64748b;background:#f8fafc;border-radius:8px;padding:14px">No opportunities flagged for this selection.</div>`}
    </div>
  </div>
  <style>@media(max-width:900px){.cc-two{grid-template-columns:1fr!important}}</style>`;

  const ms = (d.market_share || []).filter(m => !st.state || m.state === st.state);
  const topGain = ms.slice().sort((a, b) => (b.change_pp ?? -99) - (a.change_pp ?? -99))[0];
  const topLose = ms.slice().sort((a, b) => (a.change_pp ?? 99) - (b.change_pp ?? 99))[0];
  const market = `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
    <div style="font-size:15px;font-weight:800;color:#1e3a8a;margin-bottom:2px">Market Share Intelligence</div>
    <div style="font-size:11px;color:#64748b;margin-bottom:12px">Share of total circulation · movement vs ${esc(String(d.compare_label || '').toLowerCase())}</div>
    ${ms.length > 1 && topGain && topLose && topGain.state !== topLose.state ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      <div style="flex:1;min-width:180px;background:#f0fdf4;border-radius:8px;padding:9px 12px">
        <div style="font-size:10px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.04em">Top gaining</div>
        <div style="font-size:14px;font-weight:800;color:#0f172a">${esc(topGain.state_name)} <span style="color:#15803d">${topGain.change_pp >= 0 ? '+' : ''}${topGain.change_pp} pp</span></div>
      </div>
      <div style="flex:1;min-width:180px;background:#fef2f2;border-radius:8px;padding:9px 12px">
        <div style="font-size:10px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.04em">Losing ground</div>
        <div style="font-size:14px;font-weight:800;color:#0f172a">${esc(topLose.state_name)} <span style="color:#b91c1c">${topLose.change_pp >= 0 ? '+' : ''}${topLose.change_pp} pp</span></div>
      </div>
    </div>` : ''}
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:420px">
      <thead><tr style="color:#64748b;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em">
        <th style="text-align:left;padding:6px 8px">Rank</th><th style="text-align:left;padding:6px 8px">State</th>
        <th style="text-align:right;padding:6px 8px">Copies</th><th style="text-align:right;padding:6px 8px">Share</th>
        <th style="text-align:right;padding:6px 8px">Movement</th></tr></thead>
      <tbody>${ms.map(m => `<tr onclick="ccDrill('supply_dash','${String(m.state).replace(/'/g, "\\'")}')" style="cursor:pointer;border-top:1px solid #eef2f7">
        <td style="padding:7px 8px;color:#94a3b8;font-weight:700">#${m.rank}</td>
        <td style="padding:7px 8px;font-weight:700;color:#1e3a8a">${esc(m.state_name)}</td>
        <td style="padding:7px 8px;text-align:right;font-variant-numeric:tabular-nums">${_ccN(m.copies)}</td>
        <td style="padding:7px 8px;text-align:right;font-weight:800">${m.share_pct}%</td>
        <td style="padding:7px 8px;text-align:right">${_ccTrend(m.change_pp)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;

  // No pagehead — the sidebar already names the screen, and the snapshot bar dates it.
  return _cmdDesignSwitch('new') + bar + topStrip + cards + charts + twoCol + market + _ccFlyout();
}


/* Which Command Centre a user sees. Persisted per browser, defaults to the current
   design, and only offered to admins — so the redesign can be previewed against live
   data in production without any other user seeing it, and reverted in one click. */
const CMD_DESIGN_KEY = 'patrika_cmd_design';
/* Switcher shown only to admins. Rendered by BOTH designs, so whichever is on screen
   can always get back to the other — a redesign you cannot escape from is a trap. */
function _cmdDesignSwitch(which) {
  if (!(S.user && S.user.isAdmin)) return '';
  const btn = (d, label) => `<button onclick="cmdSetDesign('${d}')" style="padding:4px 12px;border:1px solid var(--brd);border-radius:${d === 'legacy' ? '7px 0 0 7px' : '0 7px 7px 0'};${d === 'new' ? 'border-left:none;' : ''}background:${which === d ? 'var(--navy,#1C2B45)' : 'var(--card)'};color:${which === d ? '#fff' : 'var(--ink)'};font-size:11.5px;font-weight:600;cursor:pointer">${label}</button>`;
  return `<div style="display:flex;align-items:center;gap:9px;margin:-4px 0 12px">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Layout</span>
    <div style="display:flex">${btn('legacy', 'Current')}${btn('new', 'New')}</div>
    ${which === 'new' ? `<span style="font-size:11px;color:var(--gold-d);font-weight:600">Preview — visible only to you</span>` : ''}
  </div>`;
}
function cmdDesign() { try { return localStorage.getItem(CMD_DESIGN_KEY) === 'new' ? 'new' : 'legacy'; } catch (_) { return 'legacy'; } }
window.cmdSetDesign = (d) => {
  try { d === 'new' ? localStorage.setItem(CMD_DESIGN_KEY, 'new') : localStorage.removeItem(CMD_DESIGN_KEY); } catch (_) {}
  S.live.cmd = {};   // designs may request different data — start clean
  render();
};
VIEWS.command = () => (cmdDesign() === 'new' ? _cmdViewNew() : _cmdViewLegacy());


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
  const clickAttrs = o.onclick ? ` onclick="${esc(o.onclick)}" title="Click to drill down"` : '';
  // KPI cards are label + number only — the icon is accepted and ignored so the ~90
  // existing call sites keep working unchanged.
  return `<div class="vz-kpi" style="--kpi-c:${c}${o.onclick ? ';cursor:pointer' : ''}"${clickAttrs} ${o.tip ? `data-tip="${esc(o.tip)}"` : ''}>
    <span class="kl">${esc(o.label)}</span>
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
  const isPanIndia = _isPanIndiaAdmin();
  return S.live.supd || (S.live.supd = { tab: 'sale', state: isPanIndia ? 'RAJASTHAN' : '', unit: isPanIndia ? 'JA0' : '', from: '', to: '', agentOrder: 'supply', trendGran: 'daily', trendDays: 30, drillMode: null, drillState: '', drillUnit: '', drillBy: 'district' });
}
const _supdN = v => v == null ? '—' : Number(v).toLocaleString('en-IN');
const _supdINR = v => v == null ? '—' : (Math.abs(v) >= 1e7 ? '₹' + (v / 1e7).toFixed(2) + ' Cr' : Math.abs(v) >= 1e5 ? '₹' + (v / 1e5).toFixed(2) + ' L' : '₹' + Math.round(v).toLocaleString('en-IN'));
const _supdPct = p => p == null ? '—' : `${p >= 0 ? '+' : ''}${p}%`;
const _supdDelta = v => v == null ? '—' : `<span style="color:${v > 0 ? 'var(--grn)' : v < 0 ? 'var(--red)' : 'var(--muted)'}">${v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}${Math.abs(v).toLocaleString('en-IN')}</span>`;

function _supdQS(st) {
  const p = [];
  if (st.state) p.push('state_name=' + encodeURIComponent(st.state));
  if (st.unit)  p.push('unit_code='  + encodeURIComponent(st.unit));
  if (st.from)  p.push('from=' + st.from);
  if (st.to)    p.push('to='   + st.to);
  return p.length ? '?' + p.join('&') : '';
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
const _supdClearData = (st) => ['kpis', 'branches', 'agents', 'execs', 'trend', 'exceptions', 'insights', 'receipt', 'saleSummary', 'agentStates', 'cashStates', 'drillStates', 'drillBranches', 'drillL2', 'drillHawkers', 'drillMatrix', 'drillAgencies', 'execBreakdown', 'execAgencies', 'covidSummary', 'covidAgentStates', 'covidCashStates', 'covidDrillState', 'covidDrillUnit', 'covidDrillUnitName', 'covidSummaryState', 'covidAgentBranches', 'covidCashBranches', 'covidSummaryUnit', 'covidAgentBranch', 'covidCashBranch', 'brStates', 'brBranches', 'brL2', 'brStations'].forEach(k => { st[k] = null; });
// State dropdown: cascade the Unit list to that state (data refreshes when Apply is pressed)
window.supdSetState = (v) => {
  const st = _supdState();
  st.state = v; st.unit = '';
  render();
};
// Apply the State / Unit / date-range filters
window.supdApply = () => {
  const st = _supdState();
  st.state = (document.getElementById('supd-state') || {}).value || '';
  st.unit  = (document.getElementById('supd-unit')  || {}).value || '';
  st.from  = (document.getElementById('supd-from')  || {}).value || '';
  st.to    = (document.getElementById('supd-to')    || {}).value || '';
  if ((st.from && !st.to) || (!st.from && st.to)) { toast('Pick both From and To dates (or leave both blank for the latest day)'); return; }
  if (st.from && st.to && st.from > st.to) { const t = st.from; st.from = st.to; st.to = t; }
  _supdClearData(st);
  render();
};
window.supdResetFilters = () => {
  const st = _supdState();
  st.state = ''; st.unit = ''; st.from = ''; st.to = '';
  _supdClearData(st);
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

const _errCard = (msg) => `<div class="card pad" style="color:var(--muted)">${esc(msg || 'No data.')}</div>`;
function _supdKpiCard(icon, label, value, sub, color) {   // icon accepted, not rendered
  return `<div class="_cmd-strip-item" style="${color ? `border-left:4px solid ${color}` : ''}">
    <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600">${label}</span>
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

// Branches tab: State (Rajasthan / MP / CG / National) → Unit → Executive/District/Station, fully drillable.
window.supdBrDrill = (state, unit, unitName) => {
  const st = _supdState();
  st.brState = state || ''; st.brUnit = unit || ''; st.brUnitName = unitName || '';
  st.brStates = st.brBranches = st.brL2 = null;
  st.brDistrict = ''; st.brStations = null;
  render();
};
window.supdBrBy = by => { const st = _supdState(); st.brBy = by; st.brL2 = null; st.brDistrict = ''; st.brStations = null; render(); };
window.supdBrDistrict = district => { const st = _supdState(); st.brDistrict = district || ''; st.brStations = null; render(); };
function _supdBrCrumb(st) {
  const link = (txt, fn, active) => `<span onclick="${fn}" style="cursor:pointer;color:${active ? 'var(--ink)' : 'var(--gold-d)'};font-weight:${active ? 700 : 500}">${txt}</span>`;
  const parts = [link('States', "supdBrDrill('')", !st.brState)];
  if (st.brState) parts.push(link(esc(st.brState), `supdBrDrill('${esc(st.brState)}')`, !st.brUnit));
  if (st.brUnit) parts.push(link(esc(st.brUnitName || st.brUnit), '', !st.brDistrict));
  if (st.brDistrict) parts.push(link(esc(st.brDistrict), '', true));
  return `<div style="font-size:12.5px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${parts.join('<span style="color:var(--muted)">›</span>')}</div>`;
}
function _supdBranches(st) {
  const qs = _supdQS(st), amp = qs ? '&' : '?';
  let body, csvKey;
  if (!st.brState) {
    _supdFetch('brStates', '/api/supply-dash/agent/states' + qs);
    const dd = st.brStates; csvKey = 'brStates';
    body = !dd ? _cmdSkel() : dd._err ? _errCard('No state data.') : _supdDrillTable(dd, 'State',
      r => `<td><span onclick="supdBrDrill('${esc(r.state)}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.state)}</span> <small style="color:var(--muted)">${r.branches} units</small></td>`, 'agent', dd.total);
  } else if (!st.brUnit) {
    _supdFetch('brBranches', `/api/supply-dash/agent/branches${qs}${amp}state=${encodeURIComponent(st.brState)}`);
    const dd = st.brBranches; csvKey = 'brBranches';
    body = !dd ? _cmdSkel() : dd._err ? _errCard('No unit data.') : _supdDrillTable(dd, 'Unit',
      r => `<td><span onclick="supdBrDrill('${esc(st.brState)}','${esc(r.unit_code)}','${esc(r.branch).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.branch)}</span> <small style="color:var(--muted)">${_supdN(r.agents)} ag</small></td>`, 'agent', dd.total);
  } else if (st.brBy === 'district' && st.brDistrict) {
    // Level 3: stations/drop-points within the selected district
    const dqs = qs ? '&' + qs.slice(1) : '';
    _supdFetch('brStations', `/api/supply-dash/agent/branch/${encodeURIComponent(st.brUnit)}?by=station${dqs}&district=${encodeURIComponent(st.brDistrict)}`);
    const dd = st.brStations; csvKey = 'brStations';
    const back = `<div style="margin-bottom:8px"><span onclick="supdBrDistrict('')" style="cursor:pointer;color:var(--gold-d);font-size:12.5px">← Back to districts</span></div>`;
    body = back + (!dd ? _cmdSkel() : dd._err ? _errCard('No data.') : _supdDrillTable(dd, 'Station / Drop-Point', r => `<td>${esc(r.label)}</td>`, 'agent', dd.total));
  } else {
    const by = st.brBy || 'executive';
    const opts = [['executive', '👔 Executive Wise'], ['district', '📍 District Wise'], ['station', '🏭 Station/Drop-Point Wise']];
    const toggle = `<div class="seg" style="margin-bottom:12px">${opts.map(([k, l]) => `<button class="${by === k ? 'on' : ''}" onclick="supdBrBy('${k}')">${l}</button>`).join('')}</div>`;
    const dqs = qs ? '&' + qs.slice(1) : '';
    _supdFetch('brL2', `/api/supply-dash/agent/branch/${encodeURIComponent(st.brUnit)}?by=${by}${dqs}`);
    const dd = st.brL2; csvKey = 'brL2';
    const colName = by === 'district' ? 'District' : by === 'station' ? 'Station / Drop-Point' : 'Executive';
    const cellFn = by === 'district'
      ? r => `<td><span onclick="supdBrDistrict('${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span></td>`
      : r => `<td>${esc(r.label)}</td>`;
    body = toggle + (!dd ? _cmdSkel() : dd._err ? _errCard('No data.') : _supdDrillTable(dd, colName, cellFn, 'agent', dd.total));
  }
  const csv = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn" onclick="supdCSV('${csvKey}')">⬇ Excel/CSV</button></div>`;
  return _supdBrCrumb(st) + csv + body;
}

function _supdAgents(st) {
  const base = _supdQS(st);
  const qs = base + (base ? '&' : '?') + `order=${st.agentOrder}&limit=100` + (st.agentQ ? `&search=${encodeURIComponent(st.agentQ)}` : '');
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
    <td style="cursor:pointer" onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.agcd).replace(/'/g,"\\'")}','${esc(r.agent||r.agcd||'').replace(/'/g,"\\'")}')" title="View agency profile"><b style="color:var(--gold-d)">${esc(r.agent)}</b><small style="display:block;color:var(--muted)">${esc(r.agcd)} · ${esc(r.city || '')}</small></td>
    <td>${esc(r.branch)}</td>
    <td><small>${esc(r.executive || '—')}</small></td>
    <td class="r num">${_supdN(r.supply)}</td>
    <td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td>
    <td class="r num">${_supdDelta(r.net_change)}</td>
    <td class="r num">${r.outstanding == null ? '—' : `<span style="color:${r.outstanding > 100000 ? 'var(--red)' : 'var(--fg)'}">${_supdINR(r.outstanding)}</span>`}</td>
    <td class="r"><small style="color:var(--muted)">${r.last_visit || 'DCR pending'}</small></td></tr>`);
  return bar + table(['Agent', 'Branch', 'Executive', '>Supply', '>Prev', '>Change', '>Outstanding', '>Last Visit'], rows);
}

window.supdExecDrill = (name, state, unit, unitName) => {
  const st = _supdState();
  st.execDrill = name || ''; st.execState = state || ''; st.execUnit = unit || ''; st.execUnitName = unitName || '';
  st.execBreakdown = null; st.execAgencies = null;
  render();
};
function _supdExecDrill(st) {
  const qs = _supdQS(st), state = st.execState, unit = st.execUnit;
  const link = (txt, fn, active) => `<span onclick="${fn}" style="cursor:pointer;color:${active ? 'var(--ink)' : 'var(--gold-d)'};font-weight:${active ? 700 : 500}">${txt}</span>`;
  const en = esc(st.execDrill).replace(/'/g, "\\'");
  const es_ = esc(state).replace(/'/g, "\\'");
  const crumbs = [link('Executives', "supdExecDrill('')"), link(esc(st.execDrill), `supdExecDrill('${en}')`, !state)];
  if (state) crumbs.push(link(esc(state), `supdExecDrill('${en}','${es_}')`, !unit));
  if (unit) crumbs.push(link(esc(st.execUnitName || unit), '', true));
  const bc = `<div style="font-size:12.5px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${crumbs.join('<span style="color:var(--muted)">›</span>')}</div>`;

  if (unit) {
    // Level 3: this executive's individual agencies within the selected branch
    const dqs = qs ? '&' + qs.slice(1) : '';
    _supdFetch('execAgencies', `/api/supply-dash/agent/branch/${encodeURIComponent(unit)}?by=agency&executive=${encodeURIComponent(st.execDrill)}${dqs}`);
    const dd = st.execAgencies;
    if (!dd) return bc + _cmdSkel();
    if (dd._err) return bc + `<div class="card pad" style="color:var(--muted)">No data.</div>`;
    const unitQ = esc(unit).replace(/'/g, "\\'");
    const cellFn = r => `<td>${r.agcd ? `<span onclick="openAgencyProfile('${unitQ}','${esc(r.agcd).replace(/'/g, "\\'")}','${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span>` : esc(r.label)}</td>`;
    return bc + _supdDrillTable(dd, 'Agency', cellFn, 'agent', dd.total);
  }

  const path = `/api/supply-dash/executive/${encodeURIComponent(st.execDrill)}${qs}${state ? (qs ? '&' : '?') + 'state=' + encodeURIComponent(state) : ''}`;
  _supdFetch('execBreakdown', path);
  const d = st.execBreakdown;
  if (!d) return bc + _cmdSkel();
  if (d._err) return bc + `<div class="card pad" style="color:var(--muted)">No data.</div>`;
  const cellFn = state
    ? r => `<td><span onclick="supdExecDrill('${en}','${es_}','${esc(r.code).replace(/'/g, "\\'")}','${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span></td>`
    : r => `<td><span onclick="supdExecDrill('${en}','${esc(r.code).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span></td>`;
  return bc + _supdDrillTable(d, state ? 'Branch' : 'State', cellFn, 'agent', d.total);
}
function _supdExecs(st) {
  if (st.execDrill) return _supdExecDrill(st);
  _supdFetch('execs', '/api/supply-dash/executives' + _supdQS(st));
  const d = st.execs;
  if (!d) return _cmdSkel();
  if (d._err || !d.rows || !d.rows.length) return `<div class="card pad" style="color:var(--muted)">No executive data.</div>`;
  const rows = d.rows.map(r => `<tr>
    <td>${r.rank}</td><td><span onclick="supdExecDrill('${esc(r.executive).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:700">${esc(r.executive)}</span></td>
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
    + `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:6px"><span class="lbl" style="align-self:center;color:var(--muted)">tap an executive for state → branch breakdown</span><button class="btn" onclick="supdCSV('execs')">⬇ Excel/CSV</button></div>`
    + table(['#', 'Executive', '>Agents', '>Supply', '>Growth', '>Reduction', '>Net', '>Visits'], rows);
}

function _supdTrend(st) {
  const base = _supdQS(st);
  const qs = base + (base ? '&' : '?') + `granularity=${st.trendGran}&days=${st.trendDays}`;
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
  if (d.detail) return `<div class="card pad" style="color:var(--red)">⚠️ Could not load exceptions: ${esc(String(d.detail).slice(0,120))} <button class="btn sm" style="margin-left:8px" onclick="_supdState().exceptions=null;render()">Retry</button></div>`;
  const sect = (title, color, rows, cols, mk) => `
    <div class="card pad" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:800;color:${color};margin-bottom:6px">${title} · ${rows.length}</div>
      ${rows.length ? `<div class="tablewrap"><table>
        <thead><tr>${cols.map(c => `<th${c.startsWith('>') ? ' class="r"' : ''}>${c.replace(/^>/, '')}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 25).map(mk).join('')}</tbody></table></div>` : `<small style="color:var(--muted)">None 🎉</small>`}
    </div>`;
  const agentCell = r => `<td style="cursor:pointer" onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.agcd).replace(/'/g,"\\'")}','${esc(r.ag_name||r.agcd||'').replace(/'/g,"\\'")}')" title="View agency profile"><b style="color:var(--gold-d)">${esc(r.ag_name)}</b></td>`;
  return sect('⚠️ Zero Supply (had copies previous day)', 'var(--gold)', d.zero_supply || [], ['Agent', 'Branch', '>Copies Lost'],
      r => `<tr>${agentCell(r)}<td>${esc(r.unit_name)}</td><td class="r num" style="color:var(--red)">${_supdN(r.copies_lost)}</td></tr>`)
    + sect('📉 Negative Growth >10% (14 days)', 'var(--red)', d.negative_growth || [], ['Agent', 'Branch', '>Before', '>Now', '>%'],
      r => `<tr>${agentCell(r)}<td>${esc(r.unit_name)}</td><td class="r num">${_supdN(r.prior)}</td><td class="r num">${_supdN(r.recent)}</td><td class="r num" style="color:var(--red)">${r.change_pct}%</td></tr>`)
    + sect('🚀 Abnormal Growth >20% (14 days)', 'var(--acc)', d.abnormal_growth || [], ['Agent', 'Branch', '>Before', '>Now', '>%'],
      r => `<tr>${agentCell(r)}<td>${esc(r.unit_name)}</td><td class="r num">${_supdN(r.prior)}</td><td class="r num">${_supdN(r.recent)}</td><td class="r num" style="color:var(--grn)">+${r.change_pct}%</td></tr>`)
    + sect('💰 High Outstanding (>₹1L) with Active Supply', 'var(--red)', d.high_outstanding || [], ['Agent', 'Branch', '>Outstanding', '>Last Supply'],
      r => `<tr>${agentCell(r)}<td>${esc(r.unit_name)}</td><td class="r num" style="color:var(--red)">${_supdINR(Number(r.outstanding))}</td><td class="r num">${_supdN(r.last_supply_copies)}</td></tr>`)
    + sect('🚶 No DCR Visit in Last 30 Days', 'var(--muted)', d.no_visit || [], ['Agent', 'Branch', '>Supply (14d)', 'Last Visit'],
      r => `<tr>${agentCell(r)}<td>${esc(r.unit_name)}</td><td class="r num">${_supdN(r.total_copies)}</td><td style="color:var(--red)">${r.last_visit ? esc(String(r.last_visit).slice(0, 10)) : '—'}</td></tr>`);
}

/* ── Sale view: Agent Sale vs Cash Sale (default) + drill-downs with breadcrumbs ── */
const _saleColor = m => m === 'agent' ? 'var(--blue)' : m === 'cash' ? 'var(--gold)' : 'var(--grn)';
window.supdDrill = (mode, state, unit, unitName) => {
  const st = _supdState();
  st.drillMode = mode || null; st.drillState = state || ''; st.drillUnit = unit || ''; st.drillUnitName = unitName || ''; st.drillCenter = ''; st.drillDistrict = '';
  if (mode && !st.drillBy) st.drillBy = mode === 'agent' ? 'district' : 'center';
  if (mode === 'agent' && (st.drillBy !== 'district' && st.drillBy !== 'executive')) st.drillBy = 'district';
  if (mode === 'cash' && !['center', 'edition', 'matrix', 'executive'].includes(st.drillBy)) st.drillBy = 'center';
  ['drillStates', 'drillBranches', 'drillL2', 'drillHawkers', 'drillMatrix', 'drillAgencies'].forEach(k => { st[k] = null; });
  render();
};
window.supdDrillBy = by => { const st = _supdState(); st.drillBy = by; st.drillCenter = ''; st.drillDistrict = ''; st.drillL2 = null; st.drillHawkers = null; st.drillMatrix = null; st.drillAgencies = null; render(); };
window.supdDrillCenter = center => { const st = _supdState(); st.drillCenter = center || ''; st.drillHawkers = null; render(); };
window.supdDrillDistrict = district => { const st = _supdState(); st.drillDistrict = district || ''; st.drillAgencies = null; render(); };

function _saleKpi(mode, icon, label, data, clickable) {
  const g = data.growth_pct, color = g == null ? 'var(--muted)' : g >= 0 ? 'var(--grn)' : 'var(--red)', arrow = g == null ? '' : g >= 0 ? '▲' : '▼';
  return `<div class="card pad" ${clickable ? `onclick="supdDrill('${mode}')" role="button" style="cursor:pointer;border-left:4px solid ${_saleColor(mode)}"` : `style="border-left:4px solid ${_saleColor('total')}"`}>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <span class="lbl">${icon} ${label}</span>${clickable ? '<span class="lbl" style="color:var(--gold-d)">Drill →</span>' : ''}</div>
    <div class="num" style="font-size:26px;font-weight:800;line-height:1.15">${_supdN(data.current)}</div>
    <div style="display:flex;gap:12px;font-size:12px;margin-top:4px;flex-wrap:wrap">
      <span style="color:var(--muted)">Prev: ${_supdN(data.previous)}</span>
      <span style="color:${color};font-weight:700">${arrow} ${_supdN(Math.abs(data.diff))} (${_supdPct(g)})</span></div></div>`;
}
function _supdSale(st) {
  const qs = _supdQS(st);
  _supdFetch('saleSummary', '/api/supply-dash/sale-summary' + qs);
  _supdFetch('agentStates', '/api/supply-dash/agent/states' + qs);
  _supdFetch('cashStates', '/api/supply-dash/cash/states' + qs);
  const s = st.saleSummary;
  if (!s) return _cmdSkel() + _cmdSkel();
  if (s._err || s.no_data) return `<div class="card pad" style="color:var(--muted)">Supply data not loaded yet — run the supply sync first.</div>`;
  const periodLabel = s.range ? `${s.cur_label} vs ${s.prev_label}` : `${s.data_upto} vs ${s.prev_day || '—'}`;
  const kpis = `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
    ${_saleKpi('agent', '🏢', 'Agent Sale', s.agent, true)}
    ${_saleKpi('cash', '🛵', 'Cash Sale', s.cash, true)}
    ${_saleKpi('total', '📊', 'Total Sale', s.total, false)}</div>`;
  const aPct = Math.max(0, Math.min(100, s.agent_share_pct || 0)), cPct = 100 - aPct;
  const split = `<div class="card pad" style="margin-top:13px"><div class="lbl" style="margin-bottom:8px">Agent vs Cash · ${periodLabel}</div>
    <div style="display:flex;height:28px;border-radius:8px;overflow:hidden;min-width:0">
      <div style="width:${aPct}%;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;min-width:0">${aPct >= 12 ? 'Agent ' + s.agent_share_pct + '%' : ''}</div>
      <div style="width:${cPct}%;background:var(--gold);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;min-width:0">${cPct >= 12 ? 'Cash ' + s.cash_share_pct + '%' : ''}</div></div></div>`;
  const stateMini = (title, data, mode) => {
    if (!data) return _cmdSkel();
    const rows = (data.rows || []).slice(0, 6), max = Math.max(1, ...rows.map(r => r.supply));
    return `<div class="card"><div class="cardhead"><h3>${title}</h3><span class="act" onclick="supdDrill('${mode}')" style="cursor:pointer">View all →</span></div>
      <div style="padding:12px 16px">${rows.map(r => `<div class="vz-hrow" onclick="supdDrill('${mode}','${esc(r.state)}')" style="cursor:pointer;grid-template-columns:minmax(88px,130px) 1fr 76px">
        <span class="hl">${esc(r.state)}</span>
        <div class="ht"><div class="hb" style="width:${Math.round(r.supply / max * 100)}%;background:${_saleColor(mode)}"></div></div>
        <span class="hv">${_supdN(r.supply)}</span></div>`).join('') || '<div class="lbl" style="color:var(--muted)">No data</div>'}</div></div>`;
  };
  return kpis + split + `<div class="two" style="margin-top:13px">${stateMini('Agent Sale by State', st.agentStates, 'agent')}${stateMini('Cash Sale by State', st.cashStates, 'cash')}</div>`;
}
function _supdBreadcrumb(st) {
  const modeLabel = st.drillMode === 'agent' ? 'Agent Sale' : 'Cash Sale';
  const link = (txt, fn, active) => `<span onclick="${fn}" style="cursor:pointer;color:${active ? 'var(--ink)' : 'var(--gold-d)'};font-weight:${active ? 700 : 500}">${txt}</span>`;
  const parts = [link('Supply', "supdDrill(null)"), link(modeLabel, `supdDrill('${st.drillMode}')`, !st.drillState)];
  if (st.drillState) parts.push(link(esc(st.drillState), `supdDrill('${st.drillMode}','${esc(st.drillState)}')`, !st.drillUnit));
  if (st.drillUnit) parts.push(link(esc(st.drillUnitName || st.drillUnit), st.drillCenter ? "supdDrillCenter('')" : st.drillDistrict ? "supdDrillDistrict('')" : '', !st.drillCenter && !st.drillDistrict));
  if (st.drillCenter) parts.push(link(esc(st.drillCenter), '', true));
  if (st.drillDistrict) parts.push(link(esc(st.drillDistrict), '', true));
  return `<div style="font-size:12.5px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${parts.join('<span style="color:var(--muted)">›</span>')}</div>`;
}
function _supdDrillTable(dd, firstCol, cellFn, mode, total) {
  const rows = dd.rows || [], max = Math.max(1, ...rows.map(r => r.supply));
  // Agencies column: shown whenever the endpoint returns a per-row agent count
  // (district/executive/branch breakdowns) — not meaningful at the single-agency leaf.
  const showAgents = firstCol !== 'Agency' && rows.some(r => r.agents != null);
  const diffCell = v => `<td class="r num" style="color:${v > 0 ? 'var(--grn)' : v < 0 ? 'var(--red)' : 'var(--muted)'}">${v > 0 ? '+' : ''}${_supdN(v)}</td>`;
  const body = rows.map(r => `<tr>${cellFn(r)}
    <td style="width:90px"><div class="bar"><i style="width:${Math.round(r.supply / max * 100)}%;background:${_saleColor(mode)}"></i></div></td>
    ${showAgents ? `<td class="r num">${_supdN(r.agents)}</td>` : ''}
    <td class="r num">${_supdN(r.supply)}</td><td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td>
    ${diffCell(r.net_change != null ? r.net_change : (r.supply - r.prev_supply))}
    <td class="r num" style="color:${r.growth_pct >= 0 ? 'var(--grn)' : 'var(--red)'}">${_supdPct(r.growth_pct)}</td>
    <td class="r num">${r.contribution_pct != null ? r.contribution_pct + '%' : '—'}</td></tr>`).join('');
  const tS = rows.reduce((a, r) => a + (r.supply || 0), 0), tP = rows.reduce((a, r) => a + (r.prev_supply || 0), 0), tD = tS - tP;
  const tA = rows.reduce((a, r) => a + (Number(r.agents) || 0), 0);
  const tG = tP ? Math.round((tD / Math.abs(tP)) * 1000) / 10 : null;
  const foot = rows.length ? `<tr style="font-weight:800;background:var(--surf2);border-top:2px solid var(--brd)">
    <td>Total</td><td></td>${showAgents ? `<td class="r num">${_supdN(tA)}</td>` : ''}<td class="r num">${_supdN(tS)}</td><td class="r num">${_supdN(tP)}</td>${diffCell(tD)}
    <td class="r num" style="color:${tG >= 0 ? 'var(--grn)' : 'var(--red)'}">${_supdPct(tG)}</td><td class="r num">100%</td></tr>` : '';
  const periodNote = dd.range ? `<div class="lbl" style="padding:8px 16px 0;color:var(--muted)">Supply = ${dd.cur_label} &nbsp;·&nbsp; Prev = ${dd.prev_label}</div>` : '';
  return `<div class="card"><div class="cardhead"><h3>Total ${_supdN(total)} copies</h3><span class="lbl" style="color:var(--muted)">${rows.length} rows</span></div>${periodNote}
    <div class="tablewrap"><table><thead><tr><th>${firstCol}</th><th></th>${showAgents ? '<th class="r">Agencies</th>' : ''}<th class="r">Supply</th><th class="r">Prev</th><th class="r">Diff</th><th class="r">Growth</th><th class="r">Share</th></tr></thead>
    <tbody>${body || `<tr><td colspan="${showAgents ? 8 : 7}" style="color:var(--muted)">No data</td></tr>`}${foot}</tbody></table></div></div>`;
}
function _cashMatrix(dd, unitName) {
  const eds = dd.editions || [], centers = dd.centers || [];
  const th2 = eds.map(e => `<th class="r">${esc(e)}</th>`).join('') + '<th class="r">Total</th>';
  const cells = (obj, tot) => eds.map(e => `<td class="r num">${_supdN(obj[e] || 0)}</td>`).join('') + `<td class="r num" style="font-weight:700">${_supdN(tot)}</td>`;
  const body = centers.map(c => `<tr>
    <td>${esc(unitName || dd.unit_code)}</td><td><b>${esc(c.center)}</b></td>
    ${cells(c.prev, c.prev_total)}${cells(c.cur, c.cur_total)}
    <td class="r num" style="color:${c.diff > 0 ? 'var(--grn)' : c.diff < 0 ? 'var(--red)' : 'var(--muted)'};font-weight:700">${c.diff > 0 ? '+' : ''}${_supdN(c.diff)}</td></tr>`).join('');
  const gp = {}, gc = {}; let gpt = 0, gct = 0;
  centers.forEach(c => { eds.forEach(e => { gp[e] = (gp[e] || 0) + (c.prev[e] || 0); gc[e] = (gc[e] || 0) + (c.cur[e] || 0); }); gpt += c.prev_total; gct += c.cur_total; });
  const gd = gct - gpt;
  const foot = centers.length ? `<tr style="font-weight:800;background:var(--surf2);border-top:2px solid var(--brd)"><td></td><td>Total</td>${cells(gp, gpt)}${cells(gc, gct)}<td class="r num" style="color:${gd >= 0 ? 'var(--grn)' : 'var(--red)'}">${gd > 0 ? '+' : ''}${_supdN(gd)}</td></tr>` : '';
  const edCols = eds.length + 1;
  return `<div class="card"><div class="cardhead"><h3>Center × Edition</h3><span class="lbl" style="color:var(--muted)">Date 1 = ${dd.prev_label} · Date 2 = ${dd.cur_label}</span></div>
    <div class="tablewrap"><table><thead>
      <tr><th rowspan="2">Unit</th><th rowspan="2">Center</th><th colspan="${edCols}" style="text-align:center;border-left:2px solid var(--brd)">Date 1 · ${dd.prev_label}</th><th colspan="${edCols}" style="text-align:center;border-left:2px solid var(--brd)">Date 2 · ${dd.cur_label}</th><th rowspan="2" class="r">Diff</th></tr>
      <tr>${th2}${th2}</tr></thead>
      <tbody>${body || `<tr><td colspan="${edCols * 2 + 3}" style="color:var(--muted)">No data</td></tr>`}${foot}</tbody></table></div></div>`;
}
function _supdSaleDrill(st) {
  const mode = st.drillMode, qs = _supdQS(st), amp = qs ? '&' : '?';
  let body;
  if (!st.drillState) {
    _supdFetch('drillStates', `/api/supply-dash/${mode}/states` + qs);
    const dd = st.drillStates;
    body = !dd ? _cmdSkel() : _supdDrillTable(dd, 'State',
      r => `<td><span onclick="supdDrill('${mode}','${esc(r.state)}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.state)}</span> <small style="color:var(--muted)">${r.branches} br</small></td>`, mode, dd.total);
  } else if (!st.drillUnit) {
    _supdFetch('drillBranches', `/api/supply-dash/${mode}/branches${qs}${amp}state=${encodeURIComponent(st.drillState)}`);
    const dd = st.drillBranches;
    body = !dd ? _cmdSkel() : _supdDrillTable(dd, 'Branch',
      r => `<td><span onclick="supdDrill('${mode}','${esc(st.drillState)}','${esc(r.unit_code)}','${esc(r.branch)}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.branch)}</span></td>`, mode, dd.total);
  } else if (mode === 'cash' && st.drillCenter) {
    // Cash Level 3: hawker-wise within a center
    const dqs = qs ? '&' + qs.slice(1) : '';
    _supdFetch('drillHawkers', `/api/supply-dash/cash/branch/${encodeURIComponent(st.drillUnit)}?by=hawker&center=${encodeURIComponent(st.drillCenter)}${dqs}`);
    const dd = st.drillHawkers;
    body = !dd ? _cmdSkel() : _supdDrillTable(dd, 'Hawker', r => `<td>${esc(r.label)}</td>`, mode, dd.total);
  } else if (mode === 'agent' && st.drillDistrict) {
    // Agent Level 3: agency-wise within a district
    const dqs = qs ? '&' + qs.slice(1) : '';
    _supdFetch('drillAgencies', `/api/supply-dash/agent/branch/${encodeURIComponent(st.drillUnit)}?by=agency&district=${encodeURIComponent(st.drillDistrict)}${dqs}`);
    const dd = st.drillAgencies;
    const unitQ = esc(st.drillUnit).replace(/'/g, "\\'");
    body = !dd ? _cmdSkel() : _supdDrillTable(dd, 'Agency',
      r => `<td>${r.agcd ? `<span onclick="openAgencyProfile('${unitQ}','${esc(r.agcd).replace(/'/g, "\\'")}','${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span>` : esc(r.label)}</td>`,
      mode, dd.total);
  } else {
    const opts = mode === 'agent'
      ? [['district', '📍 District Wise'], ['executive', '👔 Executive Wise']]
      : [['center', '🏬 Center Wise'], ['edition', '📰 Edition Wise'], ['matrix', '🧮 Center × Edition'], ['executive', '👔 Executive Wise']];
    const toggle = `<div class="seg" style="margin-bottom:12px">${opts.map(([k, l]) => `<button class="${st.drillBy === k ? 'on' : ''}" onclick="supdDrillBy('${k}')">${l}</button>`).join('')}</div>`;
    if (mode === 'cash' && st.drillBy === 'matrix') {
      _supdFetch('drillMatrix', `/api/supply-dash/cash/center-edition/${encodeURIComponent(st.drillUnit)}${qs}`);
      const dd = st.drillMatrix;
      body = toggle + (!dd ? _cmdSkel() : _cashMatrix(dd, st.drillUnitName));
    } else {
      const dqs = qs ? '&' + qs.slice(1) : '';
      _supdFetch('drillL2', `/api/supply-dash/${mode}/branch/${encodeURIComponent(st.drillUnit)}?by=${st.drillBy}${dqs}`);
      const dd = st.drillL2;
      const colName = st.drillBy === 'district' ? 'District' : st.drillBy === 'center' ? 'Center' : st.drillBy === 'edition' ? 'Edition' : 'Executive';
      // Cash Center Wise: each center drills into its hawkers; Agent District Wise: each district drills into its agencies
      const cellFn = (mode === 'cash' && st.drillBy === 'center')
        ? r => `<td><span onclick="supdDrillCenter('${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span></td>`
        : (mode === 'agent' && st.drillBy === 'district')
        ? r => `<td><span onclick="supdDrillDistrict('${esc(r.label).replace(/'/g, "\\'")}')" style="cursor:pointer;color:var(--gold-d);font-weight:600">${esc(r.label)}</span></td>`
        : r => `<td>${esc(r.label)}</td>`;
      body = toggle + (!dd ? _cmdSkel() : _supdDrillTable(dd, colName, cellFn, mode, dd.total));
    }
  }
  return _supdBreadcrumb(st) + body;
}

/* ── COVID-baseline comparison: user picks a date, compared to the fixed 18-Mar-2020 baseline ── */
function _supdCovidQS(st) {
  const p = ['covid=1'];
  if (st.covidDate) p.push('date=' + st.covidDate);
  if (st.state) p.push('state_name=' + encodeURIComponent(st.state));
  if (st.unit) p.push('unit_code=' + encodeURIComponent(st.unit));
  return '?' + p.join('&');
}
window.supdCovidDate = v => { const st = _supdState(); st.covidDate = v; ['covidSummary', 'covidAgentStates', 'covidCashStates', 'covidSummaryState', 'covidAgentBranches', 'covidCashBranches', 'covidSummaryUnit', 'covidAgentBranch', 'covidCashBranch'].forEach(k => { st[k] = null; }); render(); };
window.supdCovidDrillState = function(stateName) {
  const st = _supdState();
  st.covidDrillState = stateName; st.covidDrillUnit = null; st.covidDrillUnitName = null;
  ['covidSummaryState', 'covidAgentBranches', 'covidCashBranches', 'covidSummaryUnit', 'covidAgentBranch', 'covidCashBranch'].forEach(k => { st[k] = null; });
  render();
};
window.supdCovidDrillUnit = function(unitCode, unitName) {
  const st = _supdState();
  st.covidDrillUnit = unitCode; st.covidDrillUnitName = unitName;
  ['covidSummaryUnit', 'covidAgentBranch', 'covidCashBranch'].forEach(k => { st[k] = null; });
  render();
};
window.supdCovidDrillBack = function(level) {
  const st = _supdState();
  if (level === 0) { st.covidDrillState = null; st.covidDrillUnit = null; st.covidDrillUnitName = null; }
  else if (level === 1) { st.covidDrillUnit = null; st.covidDrillUnitName = null; ['covidSummaryUnit', 'covidAgentBranch', 'covidCashBranch'].forEach(k => { st[k] = null; }); }
  render();
};
function _covidKpi(icon, label, color, data) {
  const g = data.growth_pct, c = g == null ? 'var(--muted)' : g >= 0 ? 'var(--grn)' : 'var(--red)', arrow = g == null ? '' : g >= 0 ? '▲' : '▼';
  return `<div class="card pad" style="border-left:4px solid ${color}">
    <span class="lbl">${icon} ${label}</span>
    <div class="num" style="font-size:24px;font-weight:800;line-height:1.15">${_supdN(data.current)}</div>
    <div style="display:flex;gap:12px;font-size:12px;margin-top:4px;flex-wrap:wrap">
      <span style="color:var(--muted)">18-Mar-2020: ${_supdN(data.previous)}</span>
      <span style="color:${c};font-weight:700">${arrow} ${_supdN(Math.abs(data.diff))} (${_supdPct(g)})</span></div></div>`;
}
function _covidStateMini(title, data, clickable) {
  if (!data) return _cmdSkel();
  const rows = (data.rows || []).slice(0, 20);
  return `<div class="card"><div class="cardhead"><h3>${title}${clickable ? ' <span style="font-weight:400;font-size:11px;color:var(--muted)">(tap to drill)</span>' : ''}</h3></div>
    <div class="tablewrap"><table><thead><tr><th>State</th><th class="r">Selected</th><th class="r">COVID</th><th class="r">Change</th></tr></thead>
    <tbody>${rows.map(r => {
      const st = esc(r.state).replace(/'/g, "\\'");
      const trStyle = clickable ? ' style="cursor:pointer" onclick="supdCovidDrillState(\'' + st + '\')"' : '';
      return `<tr${trStyle}><td${clickable ? ' style="color:var(--blue-d);font-weight:600"' : ''}>${esc(r.state)}</td><td class="r num">${_supdN(r.supply)}</td><td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td><td class="r num" style="color:${r.growth_pct >= 0 ? 'var(--grn)' : 'var(--red)'}">${_supdPct(r.growth_pct)}</td></tr>`;
    }).join('') || `<tr><td colspan="4" style="color:var(--muted)">No data</td></tr>`}</tbody></table></div></div>`;
}
function _covidBranchMini(title, data) {
  if (!data) return _cmdSkel();
  const rows = (data.rows || []).slice(0, 30);
  return `<div class="card"><div class="cardhead"><h3>${title} <span style="font-weight:400;font-size:11px;color:var(--muted)">(tap to drill)</span></h3></div>
    <div class="tablewrap"><table><thead><tr><th>Unit</th><th class="r">Selected</th><th class="r">COVID</th><th class="r">Change</th></tr></thead>
    <tbody>${rows.map(r => {
      const codeQ = esc(r.unit_code).replace(/'/g, "\\'");
      const nameQ = esc(r.branch || r.unit_name || r.unit_code).replace(/'/g, "\\'");
      return `<tr style="cursor:pointer" onclick="supdCovidDrillUnit('${codeQ}','${nameQ}')"><td style="color:var(--blue-d);font-weight:600">${esc(r.branch || r.unit_name || r.unit_code)}</td><td class="r num">${_supdN(r.supply)}</td><td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td><td class="r num" style="color:${r.growth_pct >= 0 ? 'var(--grn)' : 'var(--red)'}">${_supdPct(r.growth_pct)}</td></tr>`;
    }).join('') || `<tr><td colspan="4" style="color:var(--muted)">No data</td></tr>`}</tbody></table></div></div>`;
}
function _covidDistrictMini(title, data) {
  if (!data) return _cmdSkel();
  const rows = (data.rows || []).slice(0, 40);
  const colLabel = data.by === 'center' ? 'Center / Hawker Area' : 'District';
  return `<div class="card"><div class="cardhead"><h3>${title}</h3></div>
    <div class="tablewrap"><table><thead><tr><th>${colLabel}</th><th class="r">Selected</th><th class="r">COVID</th><th class="r">Change</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="r num">${_supdN(r.supply)}</td><td class="r num" style="color:var(--muted)">${_supdN(r.prev_supply)}</td><td class="r num" style="color:${r.growth_pct >= 0 ? 'var(--grn)' : 'var(--red)'}">${_supdPct(r.growth_pct)}</td></tr>`).join('') || `<tr><td colspan="4" style="color:var(--muted)">No data</td></tr>`}</tbody></table></div></div>`;
}
function _supdCovid(st) {
  const baseQS = '?covid=1' + (st.covidDate ? '&date=' + encodeURIComponent(st.covidDate) : '');
  const dState = st.covidDrillState || null;
  const dUnit  = st.covidDrillUnit  || null;
  const dUnitName = st.covidDrillUnitName || dUnit || '';

  _supdFetch('covidSummary', '/api/supply-dash/sale-summary' + baseQS);
  const s = st.covidSummary;
  const maxDate = (st.filters && st.filters.data_upto) ? String(st.filters.data_upto).slice(0, 10) : '';
  const curDate = st.covidDate || (s ? s.data_upto : maxDate);
  const picker = `<div class="filters" style="margin-bottom:13px">
    <span class="lbl" style="align-self:center">🦠 Compare date</span>
    <input type="date" id="supd-covid-date" value="${curDate || ''}" ${maxDate ? `max="${maxDate}"` : ''} min="2020-03-18" onchange="supdCovidDate(this.value)" style="background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--fg)">
    <span class="lbl" style="align-self:center;color:var(--muted)">vs fixed COVID baseline <b>18-Mar-2020</b></span></div>`;
  if (!s) return picker + _cmdSkel();
  if (s._err || s.no_data) return picker + `<div class="card pad" style="color:var(--muted)">No supply data for this date.</div>`;

  // Breadcrumb
  let breadcrumb = '';
  if (dState || dUnit) {
    const crumbs = [];
    crumbs.push(`<a onclick="supdCovidDrillBack(0)" style="cursor:pointer;color:var(--blue-d)">All States</a>`);
    if (dState) {
      if (dUnit) crumbs.push(`<a onclick="supdCovidDrillBack(1)" style="cursor:pointer;color:var(--blue-d)">${esc(dState)}</a>`);
      else crumbs.push(`<span style="font-weight:600">${esc(dState)}</span>`);
    }
    if (dUnit) crumbs.push(`<span style="font-weight:600">${esc(dUnitName)}</span>`);
    breadcrumb = `<div style="margin-bottom:10px;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${crumbs.join('<span style="color:var(--muted)"> › </span>')}</div>`;
  }

  if (dState && dUnit) {
    // Level 2: District breakdown within a unit
    _supdFetch('covidSummaryUnit', '/api/supply-dash/sale-summary' + baseQS + '&unit_code=' + encodeURIComponent(dUnit));
    _supdFetch('covidAgentBranch', '/api/supply-dash/agent/branch/' + encodeURIComponent(dUnit) + baseQS + '&by=district');
    _supdFetch('covidCashBranch', '/api/supply-dash/cash/branch/' + encodeURIComponent(dUnit) + baseQS);
    const su = st.covidSummaryUnit;
    const kpis = su && !su._err && !su.no_data
      ? `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">${_covidKpi('🏢', 'Agent Sale', 'var(--blue)', su.agent)}${_covidKpi('🛵', 'Cash Sale', 'var(--gold)', su.cash)}${_covidKpi('📊', 'Total Sale', 'var(--grn)', su.total)}</div>`
      : _cmdSkel();
    return picker + breadcrumb + kpis
      + `<div class="lbl" style="margin:14px 0 6px;color:var(--muted)">${esc(dUnitName)} — ${s.cur_label} vs 18-Mar-2020</div>
      <div class="two">${_covidDistrictMini('Agent Sale by District', st.covidAgentBranch)}${_covidDistrictMini('Cash Sale by Center', st.covidCashBranch)}</div>`;
  }

  if (dState) {
    // Level 1: Unit breakdown within a state
    const stQS = baseQS + '&state_name=' + encodeURIComponent(dState);
    _supdFetch('covidSummaryState', '/api/supply-dash/sale-summary' + stQS);
    _supdFetch('covidAgentBranches', '/api/supply-dash/agent/branches' + stQS);
    _supdFetch('covidCashBranches', '/api/supply-dash/cash/branches' + stQS);
    const ss = st.covidSummaryState;
    const kpis = ss && !ss._err && !ss.no_data
      ? `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">${_covidKpi('🏢', 'Agent Sale', 'var(--blue)', ss.agent)}${_covidKpi('🛵', 'Cash Sale', 'var(--gold)', ss.cash)}${_covidKpi('📊', 'Total Sale', 'var(--grn)', ss.total)}</div>`
      : _cmdSkel();
    return picker + breadcrumb + kpis
      + `<div class="lbl" style="margin:14px 0 6px;color:var(--muted)">${esc(dState)} — ${s.cur_label} vs 18-Mar-2020 — click a unit to drill further</div>
      <div class="two">${_covidBranchMini('Agent Sale by Unit', st.covidAgentBranches)}${_covidBranchMini('Cash Sale by Unit', st.covidCashBranches)}</div>`;
  }

  // Level 0: All states
  _supdFetch('covidAgentStates', '/api/supply-dash/agent/states' + baseQS);
  _supdFetch('covidCashStates', '/api/supply-dash/cash/states' + baseQS);
  const kpis = `<div class="vz-kgrid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
    ${_covidKpi('🏢', 'Agent Sale', 'var(--blue)', s.agent)}
    ${_covidKpi('🛵', 'Cash Sale', 'var(--gold)', s.cash)}
    ${_covidKpi('📊', 'Total Sale', 'var(--grn)', s.total)}</div>`;
  return picker + kpis
    + `<div class="lbl" style="margin:14px 0 6px;color:var(--muted)">${s.cur_label} vs 18-Mar-2020 — click a state row to drill down</div>
    <div class="two">${_covidStateMini('Agent Sale by State', st.covidAgentStates, true)}${_covidStateMini('Cash Sale by State', st.covidCashStates, true)}</div>`;
}

function _supdReceipt(st) {
  _supdFetch('receipt', '/api/supply-dash/cash/receipt-timing?days=7');
  const d = st.receipt;
  if (!d) return _cmdSkel();
  if (d.detail || d._err) return `<div class="card pad" style="color:var(--muted)">Could not load receipt timing data.</div>`;
  const { dates, rows } = d;
  if (!rows || !rows.length) return `<div class="card pad" style="color:var(--muted)">No cash sale data found for the last 7 days.</div>`;

  const fmtEntry = (entry) => {
    if (!entry || !entry.last_entry) return `<span style="color:var(--muted)">—</span>`;
    const t = String(entry.last_entry);
    const m = t.match(/(\d{1,2}):(\d{2})/);
    if (!m) return `<span style="color:var(--muted)">—</span>`;
    const h = parseInt(m[1], 10);
    const isLate = h >= 6;
    const color = isLate ? 'var(--red)' : 'var(--grn)';
    return `<span style="color:${color};font-weight:700;font-size:12px">${String(h).padStart(2,'0')}:${m[2]}</span>`;
  };

  const hdrCells = dates.map(date =>
    `<th style="padding:5px 8px;font-size:11px;text-align:center;color:var(--muted);white-space:nowrap">${esc(date.slice(5))}</th>`
  ).join('');

  const bodyRows = rows.map(r => {
    const cells = dates.map(date =>
      `<td style="text-align:center;padding:4px 6px">${fmtEntry(r.days[date])}</td>`
    ).join('');
    return `<tr>
      <td style="padding:4px 8px;white-space:nowrap"><b style="font-size:12px">${esc(r.unit_name || r.unit_code)}</b></td>
      <td style="padding:4px 8px;white-space:nowrap;color:var(--muted);font-size:11px">${esc(r.center_name || r.hwk_cent_code || '—')}</td>
      ${cells}
    </tr>`;
  }).join('');

  return `<div style="overflow-x:auto">
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
      Last entry time per cash sale center — <span style="color:var(--grn);font-weight:700">■ before 6 AM</span> on time &nbsp;·&nbsp;
      <span style="color:var(--red);font-weight:700">■ 6 AM or later</span> late (action needed)
    </div>
    <table class="data-tbl" style="min-width:640px;width:100%">
      <thead><tr>
        <th style="padding:5px 8px;text-align:left">Unit</th>
        <th style="padding:5px 8px;text-align:left">Hawker Center</th>
        ${hdrCells}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

VIEWS.supply_dash = () => {
  const st = _supdState();
  _supdFetch('filters', '/api/supply-dash/filters');
  const tabs = [['sale', '💰 Sale'], ['covid', '🦠 vs COVID'], ['overview', '📊 Overview'], ['branches', '🏢 Branches'], ['agents', '👤 Agents'],
                ['execs', '👔 Executives'], ['trend', '📈 Trends'], ['exceptions', '⚠️ Exceptions'], ['receipt', '⏰ Receipt Timing']];
  const allUnits  = (st.filters && st.filters.units)  || [];
  const states    = (st.filters && st.filters.states) || [];
  const dispUnits = st.state ? allUnits.filter(u => u.state_name === st.state) : allUnits;
  const selSty = 'background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--fg)';
  const stateSel = `<select id="supd-state" onchange="supdSetState(this.value)" style="${selSty}">
    <option value="">All States</option>
    ${states.map(s => `<option value="${esc(s.state_name)}" ${st.state === s.state_name ? 'selected' : ''}>${esc(s.state_name)}</option>`).join('')}
  </select>`;
  const unitSel = `<select id="supd-unit" style="${selSty}">
    <option value="">All Branches</option>
    ${dispUnits.map(u => `<option value="${esc(u.unit_code)}" ${st.unit === u.unit_code ? 'selected' : ''}>${esc(u.unit_name)}</option>`).join('')}
  </select>`;
  const hasFilter = !!(st.state || st.unit || st.from || st.to);
  const filterBar = `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
    <span style="font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Filters</span>
    ${stateSel}${unitSel}
    <span style="display:inline-flex;gap:6px;align-items:center;font-size:11px;color:var(--muted)">
      <input id="supd-from" type="date" value="${st.from || ''}" style="${selSty}"> to
      <input id="supd-to" type="date" value="${st.to || ''}" style="${selSty}">
    </span>
    <button class="btn pri" onclick="supdApply()">Apply</button>
    ${hasFilter ? `<button class="btn" onclick="supdResetFilters()">Reset</button>` : ''}
    <span style="margin-left:auto"></span>
    <button class="btn" title="Print / save as PDF" onclick="window.print()">🖨</button>
    <button class="btn" onclick="supdRefresh()">↻</button>
  </div>`;
  const tabBar = `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
    ${tabs.map(([k, l]) => `<button class="btn ${st.tab === k ? 'pri' : ''}" onclick="supdTab('${k}')">${l}</button>`).join('')}
  </div>`;
  const bodyMap = { sale: (s) => s.drillMode ? _supdSaleDrill(s) : _supdSale(s), covid: _supdCovid,
                    overview: _supdOverview, branches: _supdBranches, agents: _supdAgents,
                    execs: _supdExecs, trend: _supdTrend, exceptions: _supdExceptions,
                    receipt: _supdReceipt };
  const dataNote = st.filters && st.filters.data_upto
    ? `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:8px">Agent/Credit sale data up to <b>${esc(String(st.filters.data_upto).slice(0, 10))}</b> · Hawker/Cash sale &amp; DCR synced daily</div>`
    : '';
  return pagehead('Supply Dashboard', 'Agency supply · growth & reduction · exceptions — decision view for HO, ZH, Incharge & Executives') + `
    <style>._cmd-strip-item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:3px}</style>
    ${filterBar}${tabBar}${(bodyMap[st.tab] || _supdOverview)(st)}${dataNote}`;
};

/* ═══════════ AI Insights & Action Center ═══════════ */
const _AI_PRI = { P1: ['var(--red)',  'P1 · Act Today'],
                  P2: ['var(--gold)', 'P2 · This Week'],
                  P3: ['var(--acc)',  'P3 · Monitor'] };
const _AI_MOD = { outstanding: ['💰','Outstanding'], collection: ['₹','Collections'],
                  short_payment: ['⚠️','Short Payment'], taxi: ['🚕','Taxi'], app_usage: ['📵','App Usage'],
                  survey: ['📋','Survey'], digital: ['💳','Digital'],
                  supply: ['📦','Supply'], field_visit: ['🏃','Field Visit'] };
const _AI_DRILL = { outstanding:'outstanding', collection:'collections', short_payment:'outstanding',
                    taxi:'transport', app_usage:'transport', survey:'survey_dash', digital:'collections',
                    supply:'supply_dash', field_visit:'dcr_analytics' };

function _aiState() { return S.live.ins || (S.live.ins = {}); }

function _aiLoad(force) {
  const st = _aiState();
  if (st._loading || (st.data && !force)) return;
  st._loading = true; if (force) st.data = null;
  fetch(api.base + '/api/insights' + (force ? '?refresh=1' : ''), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.data = d; st._loading = false; st._err = false; if (S.screen === 'ai_nexus') render(); })
    .catch(() => { st._loading = false; st._err = true; if (S.screen === 'ai_nexus') render(); });
}
function _aiLoadActions(force) {
  const st = _aiState();
  if (st._actLoading || (st.actions && !force)) return;
  st._actLoading = true; if (force) st.actions = null;
  fetch(api.base + '/api/actions?limit=100', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.actions = d.actions || []; st._actLoading = false; if (S.screen === 'ai_nexus') render(); })
    .catch(() => { st._actLoading = false; st.actions = []; if (S.screen === 'ai_nexus') render(); });
}
function _aiLoadCfg(force) {
  const st = _aiState();
  if (st._cfgLoading || (st.cfg && !force)) return;
  st._cfgLoading = true; if (force) st.cfg = null;
  fetch(api.base + '/api/email-config', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.cfg = d; st._cfgLoading = false; if (S.screen === 'email_config') render(); })
    .catch(() => { st._cfgLoading = false; st.cfg = { units: [], contacts: [] }; if (S.screen === 'email_config') render(); });
}

window.aiFilterModule = v => { _aiState().fltModule = v || ''; render(); };
window.aiFilterPri = v => { _aiState().fltPriority = v || ''; render(); };
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
  'DCR visit summary by executive this month',
  'Agencies with outstanding above ₹50,000',
  'Executives with no field visits in last 7 days',
  'Agency visit coverage gap — not visited in 30 days',
  'Monthly circulation trend for the last 12 months',
  'Executive target achievement last month',
  'Top 20 agencies by copy supply',
  'New agencies added this month',
  'Outstanding recovery status branch-wise',
  'Agencies not visited in 30 days',
  'Compare supply with pre-COVID (18 March 2020)',
  'आज की कुल प्रसार संख्या',
  'शाखावार बकाया की स्थिति',
  'पिछले 7 दिन में visit नहीं किया',
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

function _aiSplitEmails(raw) {
  const seen = new Set();
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
    .filter(e => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Per-branch email modal: never merges recipients across units. Each row is
// addressed to that unit's own Circulation Incharge (Cc: Zonal Head), with
// its message scoped to just that unit's items — matches how /api/insights/draft
// now splits the response instead of returning one flat multi-branch draft.
function _aiEmailModal(ins, d) {
  const units = d.per_unit || [];

  if (!units.length) {
    // Org-wide insight, not tied to a specific branch — manual entry.
    const fb = d.fallback || { to: [], cc: [], subject: '', body: '' };
    const m = modal(`
      <h3>✉ Send Email — Review &amp; Edit</h3>
      <p class="mint" style="color:var(--gold)">This insight isn't tied to a specific branch — enter recipients manually.</p>
      <div class="fld"><label>To (comma-separated)</label><input data-k="to" value="${esc((fb.to || []).join(', '))}" placeholder="name@in.patrika.com"></div>
      <div class="fld"><label>Cc (comma-separated)</label><input data-k="cc" value="${esc((fb.cc || []).join(', '))}" placeholder="optional"></div>
      <div class="fld"><label>Subject</label><input data-k="subject" value="${esc(fb.subject || '')}"></div>
      <div class="fld"><label>Message (editable)</label><textarea data-k="body" rows="12" style="min-height:220px;font-size:13px">${esc(fb.body || '')}</textarea></div>
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn pri block" data-send>Send Email</button>
        <button class="btn" data-cancel>Cancel</button>
      </div>`);
    m.querySelector('[data-cancel]').onclick = () => m.remove();
    m.querySelector('[data-send]').onclick = async () => {
      const to = _aiSplitEmails(m.querySelector('[data-k=to]').value);
      const cc = _aiSplitEmails(m.querySelector('[data-k=cc]').value);
      const subject = m.querySelector('[data-k=subject]').value.trim();
      const body = m.querySelector('[data-k=body]').value;
      if (!to.length) { toast('Enter at least one email address'); return; }
      const btn = m.querySelector('[data-send]'); btn.disabled = true; btn.textContent = 'Sending…';
      const r = await api.post('/api/insights/send-email', {
        to, cc: cc.length ? cc : undefined, subject, body,
        insight_key: ins.id, module: ins.module, priority: ins.priority, created_by: S.user?.name || '' });
      if (r && r.ok) { m.remove(); toast('✓ Email sent'); _aiState().actions = null; }
      else { btn.disabled = false; btn.textContent = 'Send Email'; toast((r && r.detail) || 'Send failed'); }
    };
    return;
  }

  const rows = units.map((u, i) => {
    const statusBadge = !u.has_any_contact
      ? chip('crit', '⚠ No contact configured')
      : u.has_incharge
        ? chip('good', '✓ Circulation Incharge')
        : chip('warn', '⚠ No Incharge — using Zonal Head');
    return `<div class="_cmd-card" data-unit-row="${i}" style="margin-bottom:10px;padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <b style="font-size:13px">${esc(u.unit_name)}</b>
        ${statusBadge}
      </div>
      ${u.has_any_contact ? `
        <div class="fld" style="margin-bottom:6px"><label style="font-size:10.5px">To</label><input data-k="to" value="${esc((u.to || []).join(', '))}" style="font-size:12.5px"></div>
        <div class="fld" style="margin-bottom:6px"><label style="font-size:10.5px">Cc</label><input data-k="cc" value="${esc((u.cc || []).join(', '))}" style="font-size:12.5px" placeholder="optional"></div>
        <details style="margin-bottom:8px"><summary style="font-size:11.5px;color:var(--acc);cursor:pointer">✎ Edit subject &amp; message</summary>
          <div class="fld" style="margin-top:6px"><input data-k="subject" value="${esc(u.subject)}" style="font-size:12.5px"></div>
          <textarea data-k="body" rows="9" style="width:100%;font-size:12px;margin-top:6px">${esc(u.body)}</textarea>
        </details>
        <button class="btn sm pri" data-send-unit>Send</button>
        <span data-send-status style="font-size:11.5px;margin-left:8px;color:var(--muted)"></span>
      ` : `<div style="font-size:12px;color:var(--red)">No email configured for ${esc(u.unit_name)} — add one in Administration → Email Config.</div>`}
    </div>`;
  }).join('');

  const sendableCount = units.filter(u => u.has_any_contact).length;
  const m = modal(`
    <h3>✉ Send Email — Per Branch</h3>
    <p class="mint">${units.length} branch${units.length > 1 ? 'es' : ''} affected — each gets its own email addressed to that branch's Circulation Incharge (Cc: Zonal Head). Nothing is merged across branches.</p>
    <div style="display:flex;gap:9px;margin-bottom:12px">
      <button class="btn pri" data-send-all ${sendableCount ? '' : 'disabled'}>✈ Send All (${sendableCount})</button>
      <button class="btn" data-cancel>Close</button>
    </div>
    <div style="max-height:60vh;overflow-y:auto;padding-right:4px">${rows}</div>`);

  m.querySelector('[data-cancel]').onclick = () => m.remove();

  async function sendRow(rowEl) {
    const to = _aiSplitEmails(rowEl.querySelector('[data-k=to]').value);
    const cc = _aiSplitEmails(rowEl.querySelector('[data-k=cc]').value);
    const subject = rowEl.querySelector('[data-k=subject]').value.trim();
    const body = rowEl.querySelector('[data-k=body]').value;
    const btn = rowEl.querySelector('[data-send-unit]');
    const status = rowEl.querySelector('[data-send-status]');
    if (!to.length) { status.textContent = 'Enter a To address'; status.style.color = 'var(--red)'; return false; }
    btn.disabled = true; btn.textContent = 'Sending…';
    const r = await api.post('/api/insights/send-email', {
      to, cc: cc.length ? cc : undefined, subject, body,
      insight_key: ins.id, module: ins.module, priority: ins.priority, created_by: S.user?.name || '' });
    if (r && r.ok) { btn.textContent = '✓ Sent'; status.textContent = ''; _aiState().actions = null; return true; }
    btn.disabled = false; btn.textContent = 'Send'; status.textContent = (r && r.detail) || 'Send failed'; status.style.color = 'var(--red)';
    return false;
  }

  m.querySelectorAll('[data-unit-row]').forEach(rowEl => {
    const btn = rowEl.querySelector('[data-send-unit]');
    if (btn) btn.onclick = () => sendRow(rowEl);
  });

  m.querySelector('[data-send-all]').onclick = async () => {
    const allBtn = m.querySelector('[data-send-all]');
    allBtn.disabled = true;
    let sent = 0;
    for (const rowEl of m.querySelectorAll('[data-unit-row]')) {
      const sendBtn = rowEl.querySelector('[data-send-unit]');
      if (!sendBtn || sendBtn.disabled) continue; // no contact configured, or already sent
      if (await sendRow(rowEl)) sent++;
    }
    allBtn.textContent = `✓ Sent ${sent}`;
    toast(`✓ Sent ${sent} of ${sendableCount} branch emails`);
  };
}

/* — message drafting + send — */
window.aiDraft = async (idx, channel) => {
  const ins = _aiIns(idx); if (!ins) return;
  toast('Generating ' + channel + ' draft…');
  const d = await api.post('/api/insights/draft', { insight: ins, channel });
  if (!d) { toast('Draft failed — is the API running?'); return; }

  if (channel === 'email') { _aiEmailModal(ins, d); return; }

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

// Full P1/P2/P3 insights report (priority strip + module filter + action cards) —
// merged into Strategic AI Nexus's Overview tab; used to live in its own
// "AI Insights & Actions" screen, now folded in here.
function _aiInsightsReportBody() {
  const st = _aiState();
  _aiLoad();
  const d = st.data;
  if (st._err) return `<div class="card pad" style="color:var(--red)">Failed to load insights. <a href="#" onclick="aiRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  if (!d) return _cmdSkel() + _cmdSkel() + _cmdSkel();

  const all = d.insights || [];
  const counts = { P1: 0, P2: 0, P3: 0 };
  all.forEach(i => counts[i.priority] = (counts[i.priority] || 0) + 1);
  const fMod = st.fltModule || '', fPri = st.fltPriority || '';
  const MOD_LABEL = { outstanding: 'Outstanding', collection: 'Collections', short_payment: 'Short Payment', taxi: 'Taxi', app_usage: 'App Usage', survey: 'Survey', digital: 'Digital' };
  const modules = [...new Set(all.map(i => i.module).filter(Boolean))].sort();
  const priRank = { P1: 0, P2: 1, P3: 2 };
  const list = all.filter(i => (!fMod || i.module === fMod) && (!fPri || i.priority === fPri))
    .sort((a, b) => (priRank[a.priority] ?? 9) - (priRank[b.priority] ?? 9));
  // Priority strip — click a tile to filter to that priority (click again to clear)
  const strip = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
    ${['P1', 'P2', 'P3'].map(p => `<div class="_cmd-strip-item" role="button" onclick="aiFilterPri('${fPri === p ? '' : p}')" style="cursor:pointer;border-left:4px solid ${_AI_PRI[p][0]}${fPri === p ? ';box-shadow:0 0 0 2px ' + _AI_PRI[p][0] : ''}">
      <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600">${_AI_PRI[p][1]}</span>
      <div style="font-size:24px;font-weight:800;color:${_AI_PRI[p][0]}">${counts[p] || 0}</div>
    </div>`).join('')}
  </div>`;
  const selSty = 'background:var(--bg);border:1px solid var(--brd);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--fg)';
  const filterBar = `<div class="filters" style="margin-bottom:12px;align-items:center">
    <span class="lbl" style="align-self:center">Module</span>
    <select onchange="aiFilterModule(this.value)" style="${selSty}">
      <option value="">All modules</option>
      ${modules.map(m => `<option value="${m}" ${fMod === m ? 'selected' : ''}>${MOD_LABEL[m] || m}</option>`).join('')}
    </select>
    ${fPri ? `<span class="chip" style="background:${_AI_PRI[fPri][0]}22;color:${_AI_PRI[fPri][0]}">${_AI_PRI[fPri][1]}</span>` : ''}
    ${(fMod || fPri) ? `<button class="btn sm" onclick="aiFilterModule('');aiFilterPri('')">✕ Clear</button>` : ''}
    <span class="lbl" style="align-self:center;color:var(--muted);margin-left:auto">${list.length} of ${all.length} · sorted by priority</span>
    <button class="btn sm" onclick="aiRefresh()">↻ Refresh</button>
  </div>`;
  const cards = list.length
    ? list.map(i => _aiCard(i, all.indexOf(i))).join('')
    : (all.length
      ? `<div class="card pad" style="text-align:center;color:var(--muted);padding:28px">No insights match this filter. <a href="#" onclick="aiFilterModule('');aiFilterPri('');return false" style="color:var(--acc)">Clear</a></div>`
      : `<div class="card pad" style="text-align:center;color:var(--grn);padding:34px">✓ Nothing needs your attention right now — all monitored KPIs look normal for your scope.</div>`);
  const footer = d.generated_at ? `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:6px">Generated ${esc(String(d.generated_at).slice(0, 16).replace('T', ' '))} UTC${d.cached ? ' · cached (max 10 min old)' : ''} · computed from live database values</div>` : '';
  return strip + filterBar + cards + footer;
}

/* ═══════════ Strategic AI Nexus — proactive "AI Circulation Boss" briefing ═══════════ */
const _NEXUS_TAG = {
  URGENT_ACTION:       ['crit',   '🔴 Urgent Action'],
  WIN_BACK:            ['purple', '🔄 Win-Back Opportunity'],
  SUPPLY_AT_RISK:      ['warn',   '📉 Supply At Risk'],
  COLLECTION_RECOVERY: ['info',   '💰 Collection Recovery'],
  VISIT_OVERDUE:       ['mut',    '👀 Visit Overdue'],
  MONITOR:             ['good',  '🟢 Monitor'],
  NO_VISIT_HISTORY:    ['mut',   '📇 No Visit History Yet'],
};

function _nexusState() { return S.live.nexus || (S.live.nexus = { tab: 'overview' }); }

function _nexusLoadBriefing(force) {
  const st = _nexusState();
  if (st._brLoading || (st.briefing && !force) || (st._brErr && !force)) return;
  st._brLoading = true; st._brErr = false; if (force) st.briefing = null;
  fetch(api.base + '/api/ai-nexus/briefing' + (force ? '?refresh=1' : ''), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.briefing = d; st._brLoading = false; st._brErr = false; if (S.screen === 'ai_nexus') render(); })
    .catch(() => { st._brLoading = false; st._brErr = true; if (S.screen === 'ai_nexus') render(); });
}
function _nexusLoadNearby(force) {
  const st = _nexusState();
  if (st._nearLoading || (st.nearby && !force) || (st._nearErr && !force)) return;
  st._nearLoading = true; st._nearErr = false; if (force) st.nearby = null;
  fetch(api.base + '/api/ai-nexus/nearby-alerts', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.nearby = d; st._nearLoading = false; st._nearErr = false; if (S.screen === 'ai_nexus') render(); })
    .catch(() => { st._nearLoading = false; st._nearErr = true; if (S.screen === 'ai_nexus') render(); });
}
function _nexusLoadCompetitor(force) {
  const st = _nexusState();
  if (st._compLoading || (st.competitor && !force)) return;
  st._compLoading = true;
  fetch(api.base + '/api/ai-nexus/competitor', { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.competitor = d; st._compLoading = false; if (S.screen === 'ai_nexus') render(); })
    .catch(() => { st._compLoading = false; st.competitor = { available: false, message: 'Failed to load.' }; if (S.screen === 'ai_nexus') render(); });
}

window.nexusTab = t => { _nexusState().tab = t; render(); };
window.nexusRefresh = () => {
  const st = _nexusState();
  if (st.tab === 'nearby') _nexusLoadNearby(true);
  else if (st.tab === 'competitor') _nexusLoadCompetitor(true);
  else if (st.tab === 'actions') _aiLoadActions(true);
  else if (st.tab === 'overview') { _nexusLoadBriefing(true); _aiLoad(true); }
  else _nexusLoadBriefing(true);
  render();
};

function _nexusTagChips(tags) {
  return (tags || []).map(t => { const [c, l] = _NEXUS_TAG[t] || ['mut', t]; return chip(c, l); }).join(' ');
}

function _nexusAgCard(a) {
  const uc = esc(String(a.unit_code || '')), ac = esc(String(a.agcd || ''));
  return `<div class="_cmd-card" style="margin-bottom:10px;padding:13px 16px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
      <div role="button" style="min-width:0;cursor:pointer" onclick="nexusOpenAgency('${uc}','${ac}','${esc((a.ag_name||'').replace(/'/g,"\\'"))}')" title="Click for full agency detail">
        <div style="font-weight:700;font-size:14px;color:var(--ink)">${esc(a.ag_name || a.agcd)} <span style="color:var(--acc);font-size:11px">›</span></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:1px">${esc(a.unit_name || '')}${a.city_name ? ' · ' + esc(a.city_name) : ''} · Exec: ${esc(a.exec_name || '—')}</div>
        <div style="margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${a.ag_status ? `<span style="font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:8px;background:${a.ag_status==='Active'?'#D1FAE520':'#FEE2E220'};color:${a.ag_status==='Active'?'var(--grn,#22c55e)':'var(--red,#ef4444)'}">● ${esc(a.ag_status)}</span>` : ''}
          ${a.supply_start_dt ? `<span style="font-size:10.5px;color:var(--muted)">Since ${esc(a.supply_start_dt)}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">${_nexusTagChips(a.tags)}</div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:9px;font-size:12px">
      ${a.outstanding != null ? `<span><b style="color:var(--ink)">${_cmdFmtC(a.outstanding)}</b> <span style="color:var(--muted)">outstanding</span></span>` : ''}
      ${a.opportunity_copies ? `<span><b style="color:var(--purple,#7c4dff)">+${VZ.full(a.opportunity_copies)}</b> <span style="color:var(--muted)">copies recoverable</span></span>` : ''}
      ${a.peak30_supply != null && a.tags && a.tags.includes('SUPPLY_AT_RISK') ? `<span><b style="color:var(--ink)">${VZ.full(a.cur_supply)}</b> <span style="color:var(--muted)">of ${VZ.full(a.peak30_supply)} peak</span></span>` : ''}
      <span><span style="color:var(--muted)">Last visit:</span> <b style="color:var(--ink)">${a.last_visit ? esc(a.last_visit) + ' (' + a.days_since_visit + 'd ago)' : 'Never'}</b></span>
    </div>
    ${a.expected_outcome ? `<div style="margin-top:7px;font-size:11.5px;color:var(--muted)"><b style="color:var(--grn)">▶ अपेक्षित परिणाम:</b> ${esc(a.expected_outcome)}</div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      <button class="btn" style="font-size:11.5px" onclick="nexusDraftAgency('${uc}','${ac}','email')">✉ Email (Hindi)</button>
      <button class="btn" style="font-size:11.5px;background:#229ED9;color:#fff;border:none" onclick="nexusDraftAgency('${uc}','${ac}','telegram')">✈️ Telegram (Hindi)</button>
    </div>
  </div>`;
}

function _nexusOverview(st) {
  _nexusLoadBriefing();
  const d = st.briefing;
  if (st._brErr) return `<div class="card pad" style="color:var(--red)">Failed to load briefing. <a href="#" onclick="nexusRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  if (!d) return _cmdSkel() + _cmdSkel();
  const ei = d.expected_impact || {};
  return `
    <div class="_cmd-card" style="margin-bottom:14px;border-left:4px solid var(--acc)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <div style="font-size:11px;font-weight:800;color:var(--acc);letter-spacing:.06em">🤖 AI SUMMARY${d.engine === 'ollama' ? ' · Ollama' : d.engine === 'template' ? ' · rule-based (Ollama not detected — start it locally for AI narrative)' : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn" style="font-size:11.5px" onclick="nexusDraftBriefing('email')">✉ Email Briefing (Hindi)</button>
          <button class="btn" style="font-size:11.5px;background:#229ED9;color:#fff;border:none" onclick="nexusDraftBriefing('telegram')">✈️ Telegram Briefing (Hindi)</button>
        </div>
      </div>
      <div style="font-size:14.5px;line-height:1.5;color:var(--ink)">${esc(d.ai_summary || '')}</div>
    </div>
    ${_cmdKpiGrid([
      [ei.agencies_flagged ?? 0, 'Agencies Flagged', 'var(--red)'],
      ['+' + VZ.fmt(ei.supply_growth_copies || 0), 'Win-Back Copies/Day', 'var(--purple,#7c4dff)'],
      [ei.fmt_collection_recovery || '₹0', 'Collection Recoverable', 'var(--gold-d)'],
      [d.overdue_count ?? 0, 'Visits Overdue', 'var(--muted)'],
      [(d.nearby_alerts || []).length, 'Nearby Clusters', 'var(--blue)'],
      [ei.agencies_scoped ?? 0, 'Agencies In Scope', 'var(--ink)'],
    ])}
    <div class="_cmd-card" style="margin-top:14px">
      <div style="font-weight:700;font-size:14px;color:var(--ink);margin-bottom:10px">📋 AI Recommendations to Management</div>
      ${(d.recommendations || []).length
        ? `<ol style="margin:0;padding-left:20px;display:grid;gap:8px">${(d.recommendations || []).map(r => `<li style="font-size:13px;line-height:1.5;color:var(--ink-2)">${esc(r)}</li>`).join('')}</ol>`
        : `<div style="color:var(--muted);font-size:13px">No specific recommendations right now — scope looks healthy.</div>`}
    </div>
    ${(d.unaddressed_opportunities || []).length ? `<div style="margin-top:14px">
      <div style="font-weight:700;font-size:14px;color:var(--ink);margin-bottom:4px">🟡 Opportunities Not Being Acted Upon</div>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Flagged items with no email/task/escalation logged against them yet.</div>
      ${d.unaddressed_opportunities.map(i => `<div class="_cmd-card" style="margin-bottom:8px;border-left:3px solid var(--gold-d,#d97706)">
        <div style="font-weight:700;font-size:13px;color:var(--ink)">${esc(i.title)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px">${esc(i.impact || i.why || '')}</div>
      </div>`).join('')}
    </div>` : ''}
    <div style="font-size:11px;color:var(--muted);text-align:center;margin:10px 0">Generated ${esc(String(d.generated_at || '').slice(0, 16).replace('T', ' '))} UTC${d.cached ? ' · cached (max 10 min old)' : ''}</div>
    <div style="margin-top:18px;padding-top:16px;border-top:2px solid var(--brd)">
      <div style="font-weight:700;font-size:15px;color:var(--ink);margin-bottom:12px">🤖 Full Insights Report</div>
      ${_aiInsightsReportBody()}
    </div>`;
}

function _nexusOpportunities(st) {
  _nexusLoadBriefing();
  const d = st.briefing;
  if (st._brErr) return `<div class="card pad" style="color:var(--red)">Failed to load. <a href="#" onclick="nexusRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  if (!d) return _cmdSkel() + _cmdSkel();
  const opps = d.opportunities || [];
  return `<div style="font-size:12.5px;color:var(--muted);margin-bottom:12px">🚀 Agencies whose supply has dropped ≥30% from their own 30-day peak — recoverable business, ranked by copies at stake.</div>
    ${opps.length ? opps.map(_nexusAgCard).join('')
      : `<div class="card pad" style="text-align:center;color:var(--muted);padding:28px">No win-back opportunities detected in this scope right now.</div>`}`;
}

function _nexusRisks(st) {
  _nexusLoadBriefing();
  const d = st.briefing;
  if (st._brErr) return `<div class="card pad" style="color:var(--red)">Failed to load. <a href="#" onclick="nexusRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  if (!d) return _cmdSkel() + _cmdSkel();
  const col = d.collection_opportunities || [], sup = d.supply_risks || [];
  return `
    <div style="font-weight:700;font-size:14px;color:var(--ink);margin-bottom:4px">💰 Collection Recovery</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">High outstanding, overdue visit, or both — ranked by amount pending.</div>
    ${col.length ? col.map(_nexusAgCard).join('') : `<div class="card pad" style="text-align:center;color:var(--muted);padding:18px;margin-bottom:14px">No high-outstanding agencies flagged.</div>`}
    <div style="font-weight:700;font-size:14px;color:var(--ink);margin:18px 0 4px">📉 Supply At Risk</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Previously-supplying agencies now at zero — intervention required.</div>
    ${sup.length ? sup.map(_nexusAgCard).join('') : `<div class="card pad" style="text-align:center;color:var(--muted);padding:18px">No agencies at zero supply.</div>`}`;
}

function _nexusNearby(st) {
  _nexusLoadNearby();
  const d = st.nearby;
  if (st._nearErr) return `<div class="card pad" style="color:var(--red)">Failed to load. <a href="#" onclick="nexusRefresh();return false" style="color:var(--acc)">Retry</a></div>`;
  if (!d) return _cmdSkel() + _cmdSkel();
  const clusters = d.clusters || [];
  return `<div style="font-size:12.5px;color:var(--muted);margin-bottom:12px">📍 High-priority agencies within ${d.radius_km || 5} km of each other — combine into a single trip instead of separate visits.</div>
    ${clusters.length ? clusters.map(c => `<div class="_cmd-card" style="margin-bottom:10px">
      <div style="font-weight:700;font-size:13px;color:var(--ink);margin-bottom:8px">${esc(c.unit_name)} · ${c.agencies.length} agencies within ${d.radius_km || 5} km</div>
      ${c.agencies.map(a => `<div role="button" style="padding:4px 0;border-bottom:1px dashed var(--brd);font-size:12.5px;cursor:pointer" onclick="nexusOpenAgency('${esc(String(c.unit_code||''))}','${esc(String(a.agcd||''))}','${esc((a.ag_name||'').replace(/'/g,"\\'"))}')" title="Click for full agency detail">
        <b style="color:var(--ink)">${esc(a.ag_name)} <span style="color:var(--acc);font-size:11px">›</span></b> ${_nexusTagChips(a.tags)}
        <div style="color:var(--muted);font-size:11.5px">${a.exec_name ? 'Exec: ' + esc(a.exec_name) + ' · ' : ''}${a.outstanding ? _cmdFmtC(a.outstanding) + ' outstanding · ' : ''}${a.opportunity_copies ? '+' + a.opportunity_copies + ' copies · ' : ''}${a.days_since_visit != null ? a.days_since_visit + 'd since visit' : 'never visited'}</div>
      </div>`).join('')}
    </div>`).join('')
      : `<div class="card pad" style="text-align:center;color:var(--muted);padding:28px">No geographic clusters of flagged agencies found — either GPS coverage is sparse or flagged agencies are well spread out.</div>`}`;
}

function _nexusCompetitor(st) {
  _nexusLoadCompetitor();
  const d = st.competitor;
  if (!d) return _cmdSkel();
  if (!d.available) return `<div class="card pad" style="text-align:center;color:var(--muted);padding:34px">
    <div style="font-size:30px;margin-bottom:10px">📊</div>
    <div style="font-size:14px;color:var(--ink);font-weight:700;margin-bottom:6px">Competitor Intelligence — No Data Yet</div>
    <div style="font-size:13px;max-width:480px;margin:0 auto;margin-bottom:16px">${esc(d.message || 'No competitor data uploaded.')}</div>
    <button class="btn pri" onclick="go('competitor_data')">Upload Competitor Data →</button>
  </div>`;

  const N = v => (Number(v)||0).toLocaleString('en-IN');
  const pct = d.our_share_pct || 0;
  const pctColor = pct >= 60 ? 'var(--grn)' : pct >= 40 ? 'var(--gold)' : 'var(--red)';

  const kpis = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <div class="card pad" style="flex:1;min-width:130px">
      <div style="font-size:28px;font-weight:800;color:${pctColor}">${pct}%</div>
      <div style="font-size:11px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em">Our Market Share</div>
      <div style="font-size:11px;color:var(--ink-2)">Period: ${esc(d.period)}</div>
    </div>
    <div class="card pad" style="flex:1;min-width:130px">
      <div style="font-size:22px;font-weight:700;color:var(--primary)">${N(d.total_ours)}</div>
      <div style="font-size:11px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em">Our Copies (Patrika)</div>
    </div>
    <div class="card pad" style="flex:1;min-width:130px">
      <div style="font-size:22px;font-weight:700;color:var(--ink)">${N(d.total_market)}</div>
      <div style="font-size:11px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em">Total Market</div>
      <div style="font-size:11px;color:var(--ink-2)">${d.unit_count} unit(s)</div>
    </div>
  </div>`;

  const compRows = (d.competitors || []).map(c => {
    const share = d.total_market > 0 ? Math.round(c.total / d.total_market * 100) : 0;
    const bar = `<div style="background:var(--red);height:6px;border-radius:3px;width:${share}%;min-width:2px;max-width:100%"></div>`;
    return `<tr><td>${esc(c.name)}</td><td class="r num">${N(c.total)}</td>
      <td class="r num" style="color:var(--red)">${share}%</td>
      <td style="width:80px;padding-left:8px">${bar}</td></tr>`;
  }).join('');
  const compTable = `<div class="card" style="margin-bottom:14px">
    <div class="cardhead"><h3>Competitor Breakdown</h3></div>
    <div class="tablewrap"><table><thead><tr><th>Newspaper</th><th class="r">Copies</th><th class="r">Share</th><th></th></tr></thead>
    <tbody>${compRows || '<tr><td colspan="4" style="color:var(--muted)">No competitor data</td></tr>'}</tbody></table></div>
  </div>`;

  let losingHtml = '';
  if ((d.losing_units||[]).length) {
    const rows = d.losing_units.map(u =>
      `<tr style="background:var(--red-l)"><td>${esc(u.unit_name||u.unit_code)}</td>
        <td class="r num">${N(u.our_supply)}</td>
        <td class="r num">${N(u.total_market)}</td>
        <td class="r num" style="color:var(--red);font-weight:700">${u.share_pct}%</td></tr>`
    ).join('');
    losingHtml = `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--red)">
      <div class="cardhead"><h3 style="color:var(--red)">⚠ Units Where We're Losing (share below 50%)</h3></div>
      <div class="tablewrap"><table><thead><tr><th>Unit</th><th class="r">Our Copies</th><th class="r">Total Market</th><th class="r">Share</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    </div>`;
  }

  const actions = `<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:14px">
    <button class="btn sm" onclick="go('competitor_data')">Manage Competitor Data</button>
  </div>`;

  return actions + kpis + compTable + losingHtml;
}

/* ── Drill-down: open any AI Nexus agency in the full Agency Rating detail page ── */
window.nexusOpenAgency = (unitCode, agcd, agName) => window.openAgencyProfile(unitCode, agcd, agName);

/* ── Email / Telegram — Hindi drafts, reusing /api/insights/send-email + /api/telegram/send ── */
function _findNexusAgency(unitCode, agcd) {
  const b = _nexusState().briefing; if (!b) return null;
  const pools = [...(b.opportunities || []), ...(b.collection_opportunities || []), ...(b.supply_risks || [])];
  return pools.find(a => String(a.unit_code) === unitCode && String(a.agcd) === agcd) || null;
}

function _nexusEmailModal(d) {
  const recs = d.recipients || [];
  const emails = [], seen = new Set();
  recs.forEach(r => { const e = (r.email || '').trim(); if (e && !seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); emails.push(e); } });
  const m = modal(`
    <h3>✉ Send Email (Hindi) — Review &amp; Edit</h3>
    ${recs.length ? '' : `<p class="mint" style="color:var(--gold)">No emails configured for this unit — add them in AI Insights → Email Config, or type addresses below.</p>`}
    <div class="fld"><label>To (comma-separated)</label><input data-k="to" value="${esc(emails.join(', '))}" placeholder="name@in.patrika.com"></div>
    <div class="fld"><label>Subject</label><input data-k="subject" value="${esc(d.subject)}"></div>
    <div class="fld"><label>Message (editable, Hindi)</label><textarea data-k="body" rows="14" style="min-height:260px;font-size:13px">${esc(d.body)}</textarea></div>
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
    const r = await api.post('/api/insights/send-email', { to, subject, body, module: 'ai_nexus', created_by: S.user?.name || '' });
    if (r && r.ok) { m.remove(); toast('✓ Email sent to ' + r.sent_to.length + ' recipient' + (r.sent_to.length > 1 ? 's' : '')); }
    else { btn.disabled = false; btn.textContent = 'Send Email'; toast((r && r.detail) || 'Send failed'); }
  };
}

function _nexusTelegramModal(d, empCode) {
  const m = modal(`
    <h3>✈️ Send Telegram (Hindi)</h3>
    <p style="font-size:12px;color:var(--ink-2)">${d.mobile ? 'Mobile found from executive records — link status is checked on send.' : 'No mobile on record — enter one manually.'}</p>
    <input id="nxTgMob" type="tel" maxlength="10" value="${esc(d.mobile || '')}" placeholder="10-digit mobile" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;margin-bottom:8px;background:var(--bg);color:var(--ink)">
    <textarea id="nxTgText" rows="12" style="width:100%;padding:8px;border:1px solid var(--brd2);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">${esc(d.subject + '\n\n' + d.body)}</textarea>
    <div id="nxTgErr" style="color:var(--red);font-size:12px;margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn pri block" onclick="_nexusTgSend('${esc(empCode || '')}')">Send</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
  return m;
}

window._nexusTgSend = async (empCode) => {
  const mob = document.getElementById('nxTgMob')?.value?.replace(/\D/g, '').slice(-10);
  const text = document.getElementById('nxTgText')?.value || '';
  const errEl = document.getElementById('nxTgErr');
  if (!mob || mob.length !== 10) { errEl.textContent = 'Enter a valid 10-digit mobile'; return; }
  errEl.textContent = 'Sending…';
  try {
    const r = await fetch(api.base + '/api/telegram/send', {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: mob, text, emp_code: empCode || '' }),
    });
    const d = await r.json();
    if (r.status === 404 && d.detail === 'not_linked') {
      errEl.innerHTML = `This number is not linked yet.<br><b>Ask them to:</b> open Telegram → search <b>@${esc(d.bot_username || 'the bot')}</b> → press <b>Start</b> → tap <b>📱 Share my number</b>. Then send again.`;
      return;
    }
    if (!r.ok) { errEl.textContent = d.detail || 'Send failed'; return; }
    closeModals();
    toast('✈️ Sent on Telegram ✓');
  } catch (e) { errEl.textContent = 'Send failed: ' + e.message; }
};

window.nexusDraftAgency = async (unitCode, agcd, channel) => {
  const a = _findNexusAgency(unitCode, agcd);
  if (!a) { toast('Agency not found — refresh and try again'); return; }
  toast('Generating ' + channel + ' draft (Hindi)…');
  const d = await api.post('/api/ai-nexus/draft', { channel, kind: 'agency', agency: a });
  if (!d) { toast('Draft failed — is the API running?'); return; }
  if (channel === 'email') _nexusEmailModal(d);
  else _nexusTelegramModal(d, a.exec_code);
};

window.nexusDraftBriefing = async (channel) => {
  const st = _nexusState();
  if (!st.briefing) { toast('Briefing not loaded yet'); return; }
  toast('Generating ' + channel + ' draft (Hindi)…');
  const d = await api.post('/api/ai-nexus/draft', { channel, kind: 'briefing', briefing: st.briefing });
  if (!d) { toast('Draft failed — is the API running?'); return; }
  if (channel === 'email') _nexusEmailModal(d);
  else _nexusTelegramModal(d, null);
};

VIEWS.ai_nexus = () => {
  const st = _nexusState();
  const tabs = [['overview', '🤖 Overview'], ['opportunities', '🚀 Opportunities'], ['risks', '⚠️ Risks'],
                ['nearby', '📍 Nearby Alerts'], ['competitor', '📊 Competitor Intel'],
                ['ask', '💬 Ask AI'], ['actions', '⚡ Action Center']];
  const showRefresh = !['ask'].includes(st.tab);
  const tabBar = `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
    ${tabs.map(([k, l]) => `<button class="btn ${st.tab === k ? 'pri' : ''}" onclick="nexusTab('${k}')">${l}</button>`).join('')}
    ${showRefresh ? `<button class="btn" style="margin-left:auto" onclick="nexusRefresh()">↻ Refresh</button>` : ''}
  </div>`;

  let body;
  if (st.tab === 'opportunities') body = _nexusOpportunities(st);
  else if (st.tab === 'risks') body = _nexusRisks(st);
  else if (st.tab === 'nearby') body = _nexusNearby(st);
  else if (st.tab === 'competitor') body = _nexusCompetitor(st);
  else if (st.tab === 'ask') body = _aiAskTab(_askState());
  else if (st.tab === 'actions') body = _aiActionsTab(_aiState());
  else body = _nexusOverview(st);

  return pagehead('Strategic AI Nexus', 'Your AI Circulation Boss — insights, opportunities, risks, nearby-agency alerts and actions, computed from live data. 7-Day Tour Plan now lives in DCR - Field Visit Analysis.') + `
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
  const isPanIndia = _isPanIndiaAdmin();
  return window._colState || (window._colState = {
    tab: 'overview', gran: 'monthly', agSearch: '', bSearch: '', loading: false, error: null,
    filters: { from: prevMonthRange().from, to: prevMonthRange().to, state: isPanIndia ? 'RAJASTHAN' : '', branch: isPanIndia ? 'JAIPUR RP' : '', district:'', ag_code:'', payment_cat:'' },
    opts: { states:[], branches:[], districts:[], payment_cats:[], agencies:[] },
    kpis: null, trend: [], modes: [], agencies: [], appUsage: [],
    bhDrillState: null, bhDrillUnit: null, bhState: null, bhUnit: null, bhAgency: null,
  });
}

function colApi() { return `${location.origin}/api/collection`; }

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

// ── Collections State → Unit → Executive → Agency drill ──────────────────────
const COL_REGION_LABEL = { RAJASTHAN: 'Rajasthan', 'MADHYA PRADESH': 'Madhya Pradesh', CHHATTISGARH: 'Chhattisgarh', NATIONAL: 'National' };
const colRegionLabel = s => COL_REGION_LABEL[String(s || '').toUpperCase()] || (s || '—');
// Drill keeps the date range + payment category; geo (region/unit) comes from the drill itself.
function colGeoQS(extra) {
  const f = colState().filters, p = new URLSearchParams();
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.payment_cat) p.set('payment_cat', f.payment_cat);
  if (extra) Object.entries(extra).forEach(([k, v]) => { if (v) p.set(k, v); });
  const s = p.toString(); return s ? '?' + s : '';
}
function colGeoGet(key, path, extra) {
  const st = colState();
  if (st['_l_' + key] || st[key]) return;
  st['_l_' + key] = true;
  fetch(colApi() + '/' + path + colGeoQS(extra), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st[key] = d; st['_l_' + key] = false; if (S.screen === 'collections' && st.tab === 'geo') render(); })
    .catch(() => { st['_l_' + key] = false; if (S.screen === 'collections' && st.tab === 'geo') render(); });
}
window.colDrill = (region, unit, unitName, exec) => {
  const st = colState();
  st.drillRegion = region || ''; st.drillUnit = unit || ''; st.drillUnitName = unitName || ''; st.drillExec = exec || '';
  st.geoUnits = st.geoExecs = st.geoAgencies = null;
  render();
};

async function colFetch() {
  const st = colState();
  st.loading = true; st.error = null;
  // Reset behaviour drill-down so new filters apply cleanly
  st.bhState = null; st.bhUnit = null; st.bhAgency = null;
  st.bhDrillState = null; st.bhDrillUnit = null;
  ['_bh_l_State','_bh_l_Unit','_bh_l_Agency','_bh_err_State','_bh_err_Unit','_bh_err_Agency'].forEach(k => { st[k] = false; });
  render();
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
    const [kpis, trend, modes, agencies, appUsage] = await Promise.all([
      fetch(colApi() + '/kpis'          + colQS(), h).then(r=>r.json()),
      fetch(colApi() + '/trend'         + colQS({granularity:st.gran}), h).then(r=>r.json()),
      fetch(colApi() + '/payment-modes' + colQS(), h).then(r=>r.json()),
      fetch(colApi() + '/agencies'      + colQS({limit:300}), h).then(r=>r.json()),
      fetch(colApi() + '/app-usage'     + colQS(), h).then(r=>r.json()),
    ]);
    Object.assign(st, {
      kpis,
      trend:    trend.rows    || [],
      modes:    modes.rows    || [],
      agencies: agencies.rows || [],
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
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer" onclick="colState().tab='modes';render()" title="Click to see mode-wise breakdown">
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
    <button class="btn sm" onclick="const p=prevMonthRange();Object.assign(colState().filters,{from:p.from,to:p.to,state:'',branch:'',district:'',ag_code:'',payment_cat:''});colFetch()">✕ Reset to last month</button>
  </div>`;
}

function colOverviewTab() {
  const st = colState(), k = st.kpis;
  if (!k) return '<p style="color:var(--muted);padding:20px">Loading...</p>';
  const cashPct  = k.total_collection>0 ? (k.cash_collection/k.total_collection*100).toFixed(1) : 0;
  const digPct   = k.total_collection>0 ? (k.digital_collection/k.total_collection*100).toFixed(1) : 0;
  const topAg    = (st.agencies||[]).slice(0,5);
  const maxAgAmt = topAg.length ? Math.max(...topAg.map(r=>Number(r.total_amount)||0)) : 1;
  const goto = tab => `colState().tab='${tab}';render()`;
  const top5 = topAg.map((r,i) => {
    const nameQ = esc(r.ag_name||r.ag_code||'').replace(/'/g, "\\'");
    const codeQ = esc(r.ag_code).replace(/'/g, "\\'");
    const unitQ = esc(r.unit_code||'').replace(/'/g, "\\'");
    return `<tr style="cursor:pointer" onclick="openAgencyProfile('${unitQ}','${codeQ}','${nameQ}')" title="View agency profile">
    <td style="color:var(--muted);font-size:12px;width:28px">#${i+1}</td>
    <td><b style="font-size:13px;color:var(--chart-1)">${esc(r.ag_name||r.ag_code||'')}</b><br><small style="color:var(--muted)">${esc(r.branch_name||'')}</small></td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
    <td class="r" style="font-size:11px;color:var(--muted)">${(r.txn||0).toLocaleString()}</td>
    <td style="width:80px">${colBar2(Number(r.total_amount),maxAgAmt,'var(--acc)')}</td>
  </tr>`;
  }).join('');
  return `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon:'💰', label:'Total Collection', value:colFmtC(k.total_collection), status:'up', onclick:goto('geo') })}
    ${vzKpi({ icon:'📆', label:'MTD Collection',   value:colFmtC(k.mtd_collection),   status:'up', onclick:goto('trend') })}
    ${vzKpi({ icon:'📊', label:'YTD Collection',   value:colFmtC(k.ytd_collection),   status:'fl', onclick:goto('trend') })}
    ${vzKpi({ icon:'🔄', label:'Transactions',     value:(k.total_txn||0).toLocaleString(), status:'fl', onclick:goto('geo') })}
    ${vzKpi({ icon:'🏢', label:'Agencies Paid',    value:(k.agencies_paid||0).toLocaleString(), status:'up', onclick:goto('agencies') })}
    ${vzKpi({ icon:'📐', label:'Avg / Agency',     value:colFmtC(k.avg_per_agency), status:'fl', onclick:goto('agencies') })}
    ${vzKpi({ icon:'💵', label:'Cash',             value:colFmtC(k.cash_collection), sub:cashPct+'% of total', status:'fl', onclick:goto('modes') })}
    ${vzKpi({ icon:'📱', label:'Digital',          value:colFmtC(k.digital_collection), sub:digPct+'% of total', status:'up', onclick:goto('modes') })}
    ${vzKpi({ icon:'🏆', label:'Highest Single',   value:colFmtC(k.highest_collection), status:'fl', onclick:goto('agencies') })}
    ${vzKpi({ icon:'📅', label:'Latest Day',       value:colFmtC(k.today_collection), sub:k.last_date||'', status:'up', onclick:goto('trend') })}
  </div>
  <div class="two">
    <div class="vz-sec">
      <div class="cardhead"><h3>Payment Mode Mix <span style="font-weight:400;font-size:11px;color:var(--muted)">(tap to drill)</span></h3></div>
      ${colDonut(st.modes)}
    </div>
    <div class="vz-sec">
      <div class="cardhead" style="padding:0 0 12px"><h3>Top 5 Agencies <span style="font-weight:400;font-size:11px;color:var(--muted)">(tap to drill)</span></h3></div>
      <div class="tablewrap"><table>
        <thead><tr><th>#</th><th>Agency</th><th class="r">Collection</th><th class="r">Txn</th><th>Share</th></tr></thead>
        <tbody>${top5||'<tr><td colspan="5" style="text-align:center;color:var(--muted)">No data</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>`;
}

// Collections: State → Unit → Executive → Agency drill.
function colGeoTab() {
  const st = colState();
  const spin = '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--muted)">Loading…</td></tr>';
  const linkC = (txt, fn, active) => `<span onclick="${fn}" style="cursor:pointer;color:${active ? 'var(--ink)' : 'var(--chart-1)'};font-weight:${active ? 700 : 500}">${txt}</span>`;
  const crumbs = [linkC('States', "colDrill('')", !st.drillRegion)];
  if (st.drillRegion) crumbs.push(linkC(esc(colRegionLabel(st.drillRegion)), `colDrill('${esc(st.drillRegion)}')`, !st.drillUnit));
  if (st.drillUnit) crumbs.push(linkC(esc(st.drillUnitName || st.drillUnit), `colDrill('${esc(st.drillRegion)}','${esc(st.drillUnit)}','${esc((st.drillUnitName || '').replace(/'/g, "\\'"))}')`, !st.drillExec));
  if (st.drillExec) crumbs.push(linkC(esc(st.drillExec), '', true));
  const bc = `<div style="font-size:12px;margin:4px 0 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${crumbs.join('<span style="color:var(--muted)">›</span>')}</div>`;

  let title, sub, data, cols, rowFn;
  const un = (st.drillUnitName || '').replace(/'/g, "\\'");
  if (!st.drillRegion) {
    colGeoGet('geoStates', 'state-summary');
    title = 'State-wise Collection'; sub = 'Rajasthan · Madhya Pradesh · Chhattisgarh · National — click a state to drill in';
    data = st.geoStates; cols = ['State', '>Units', '>Agencies', '>Txn', '>Collection'];
    rowFn = r => `<td style="cursor:pointer;color:var(--chart-1);font-weight:600" onclick="colDrill('${esc(r.region)}')">📍 ${esc(colRegionLabel(r.region))}</td>
      <td class="r num">${(r.units||0)}</td><td class="r num">${(r.agencies||0).toLocaleString()}</td><td class="r num">${(r.txn||0).toLocaleString()}</td><td class="r num">${colFmtC(r.amount)}</td>`;
  } else if (!st.drillUnit) {
    colGeoGet('geoUnits', 'unit-summary', { region: st.drillRegion });
    title = colRegionLabel(st.drillRegion) + ' — Units'; sub = 'Click a unit to see its executives';
    data = st.geoUnits; cols = ['Unit', '>Agencies', '>Txn', '>Collection'];
    rowFn = r => `<td style="cursor:pointer;color:var(--chart-1);font-weight:600" onclick="colDrill('${esc(st.drillRegion)}','${esc(r.unit_code||r.unit_name)}','${esc((r.unit_name||'').replace(/'/g, "\\'"))}')">${esc(r.unit_name)}</td>
      <td class="r num">${(r.agencies||0).toLocaleString()}</td><td class="r num">${(r.txn||0).toLocaleString()}</td><td class="r num">${colFmtC(r.amount)}</td>`;
  } else if (!st.drillExec) {
    colGeoGet('geoExecs', 'exec-summary', { branch: st.drillUnitName || st.drillUnit });
    title = esc(st.drillUnitName || st.drillUnit) + ' — Executives'; sub = 'Click an executive to see their agencies';
    data = st.geoExecs;
    cols = ['Executive', 'District', '>Agencies', '>Txn', '>Total Bill', '>Total Receipt', '>Diff', '>Collection %', '>Collection'];
    rowFn = r => {
      const diffColor = r.diff == null ? 'var(--muted)' : r.diff >= 0 ? 'var(--grn)' : 'var(--red)';
      const pctColor = r.collection_pct == null ? 'var(--muted)' : r.collection_pct >= 80 ? 'var(--grn)' : r.collection_pct >= 50 ? 'var(--gold)' : 'var(--red)';
      return `<td style="cursor:pointer;color:var(--chart-1);font-weight:600" onclick="colDrill('${esc(st.drillRegion)}','${esc(st.drillUnit)}','${un}','${esc(r.exec_name).replace(/'/g, "\\'")}')">👔 ${esc(r.exec_name)}</td>
      <td style="font-size:12px">${esc(r.district || '—')}</td>
      <td class="r num">${(r.agencies||0).toLocaleString()}</td>
      <td class="r num">${(r.txn||0).toLocaleString()}</td>
      <td class="r num">${r.bill_amt!=null?colFmtC(r.bill_amt):'—'}</td>
      <td class="r num">${r.rec_amt!=null?colFmtC(r.rec_amt):'—'}</td>
      <td class="r num" style="color:${diffColor};font-weight:600">${r.diff!=null?(r.diff>=0?'+':'-')+colFmtC(r.diff):'—'}</td>
      <td class="r num" style="color:${pctColor};font-weight:600">${r.collection_pct!=null?r.collection_pct+'%':'—'}</td>
      <td class="r num">${colFmtC(r.amount)}</td>`;
    };
  } else {
    colGeoGet('geoAgencies', 'exec-agencies', { branch: st.drillUnitName || st.drillUnit, exec: st.drillExec });
    title = esc(st.drillExec) + ' — Agencies'; sub = esc(st.drillUnitName || st.drillUnit) + ' · collection by agency';
    data = st.geoAgencies;
    cols = ['Agency', 'Unit', 'District', 'Station', '>Last Paid', '>Txn', '>Last Month Bill', '>Receipt This Month', '>Diff', '>Collection'];
    rowFn = r => {
      const diffColor = r.diff == null ? 'var(--muted)' : r.diff >= 0 ? 'var(--grn)' : 'var(--red)';
      return `<td style="cursor:pointer" onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.ag_code).replace(/'/g,"\\'")}','${esc(r.ag_name||r.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">
        <b style="color:var(--chart-1)">${esc(r.ag_name || r.ag_code)}</b><small style="display:block;color:var(--muted);font-weight:400">${esc(r.ag_code)}</small></td>
      <td style="font-size:12px">${esc(r.unit_name || r.unit_code || '—')}</td>
      <td style="font-size:12px">${esc(r.district_name || '—')}</td>
      <td style="font-size:12px">${esc(r.station_code || '—')}</td>
      <td class="r" style="font-size:11px;color:var(--muted)">${r.last_date ? String(r.last_date).slice(0,10) : '—'}${r.days_since!=null?` · ${r.days_since}d`:''}</td>
      <td class="r num">${(r.txn||0).toLocaleString()}</td>
      <td class="r num">${r.last_month_bill!=null?colFmtC(r.last_month_bill):'—'}</td>
      <td class="r num">${r.receipt_this_month!=null?colFmtC(r.receipt_this_month):'—'}</td>
      <td class="r num" style="color:${diffColor};font-weight:600">${r.diff!=null?(r.diff>=0?'+':'-')+colFmtC(r.diff):'—'}</td>
      <td class="r num">${colFmtC(r.amount)}</td>`;
    };
  }

  const rows = (data && data.rows) || [];
  const nc = cols.length;
  let body;
  if (!data) body = spin.replace('colspan="5"', `colspan="${nc}"`);
  else if (!rows.length) body = `<tr><td colspan="${nc}" style="text-align:center;padding:16px;color:var(--muted)">No data</td></tr>`;
  else {
    body = rows.map(r => `<tr>${rowFn(r)}</tr>`).join('');
    // Totals — built to match each level's column layout exactly
    const tAmt = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
    const tTxn = rows.reduce((a, r) => a + Number(r.txn || 0), 0);
    const tAg  = rows.reduce((a, r) => a + Number(r.agencies || 0), 0);
    const tUnits = rows.reduce((a, r) => a + Number(r.units || 0), 0);
    const numCell = v => `<td class="r num">${v}</td>`;
    let midCells;
    if (!st.drillRegion)      midCells = numCell(tUnits) + numCell(tAg.toLocaleString()) + numCell(tTxn.toLocaleString());   // State
    else if (st.drillExec) {                                                                                                  // Agencies
      const tBill = rows.reduce((a, r) => a + (Number(r.last_month_bill) || 0), 0);
      const tRec  = rows.reduce((a, r) => a + (Number(r.receipt_this_month) || 0), 0);
      const tDiff = tRec - tBill;
      midCells = `<td></td><td></td><td></td><td></td>` + numCell(tTxn.toLocaleString()) + numCell(colFmtC(tBill)) + numCell(colFmtC(tRec))
        + `<td class="r num" style="color:${tDiff >= 0 ? 'var(--grn)' : 'var(--red)'}">${tDiff >= 0 ? '+' : '-'}${colFmtC(tDiff)}</td>`;
    }
    else if (st.drillUnit) {                                                                                                   // Executives
      const tBill = rows.reduce((a, r) => a + (Number(r.bill_amt) || 0), 0);
      const tRec  = rows.reduce((a, r) => a + (Number(r.rec_amt) || 0), 0);
      const tDiff = tRec - tBill;
      const tPct  = tBill > 0 ? Math.round(tRec / tBill * 1000) / 10 : null;
      midCells = `<td></td>` + numCell(tAg.toLocaleString()) + numCell(tTxn.toLocaleString()) + numCell(colFmtC(tBill)) + numCell(colFmtC(tRec))
        + `<td class="r num" style="color:${tDiff >= 0 ? 'var(--grn)' : 'var(--red)'}">${tDiff >= 0 ? '+' : '-'}${colFmtC(tDiff)}</td>`
        + `<td class="r num">${tPct != null ? tPct + '%' : '—'}</td>`;
    }
    else                      midCells = numCell(tAg.toLocaleString()) + numCell(tTxn.toLocaleString());                    // Unit
    body += `<tr style="font-weight:800;background:var(--navy);color:#fff"><td>Total</td>${midCells}${numCell(colFmtC(tAmt))}</tr>`;
  }

  const head = cols.map(c => c[0] === '>' ? `<th class="r">${c.slice(1)}</th>` : `<th>${c}</th>`).join('');
  return `<div class="vz-sec">
    <div class="cardhead" style="flex-direction:column;align-items:flex-start;gap:2px">
      <h3 style="margin:0">${esc(title)}</h3><small style="color:var(--muted)">${esc(sub)}</small>
    </div>
    ${bc}
    <div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
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

  const agRow = (r, i) => `<tr onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.ag_code).replace(/'/g,"\\'")}','${esc(r.ag_name||r.ag_code||'').replace(/'/g,"\\'")}')" style="cursor:pointer" title="View agency profile">
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

/* ── Behaviour drill-down: State → Unit → Agency with 6-month payment mode trend ── */
function _colBhLoad(key, level, stateQ, branchQ) {
  const st = colState();
  if (st['_bh_l_' + key] || st['bh' + key] || st['_bh_err_' + key]) return;
  st['_bh_l_' + key] = true;
  const p = new URLSearchParams({ level });
  if (stateQ)  p.set('state',  stateQ);
  if (branchQ) p.set('branch', branchQ);
  // Respect collection filter geo-scope when drill hasn't overridden it
  const f = st.filters || {};
  if (!stateQ  && f.state)  p.set('state',  f.state);
  if (!branchQ && f.branch) p.set('branch', f.branch);
  fetch(colApi() + '/behavior-trend?' + p.toString(), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st['bh' + key] = d; st['_bh_l_' + key] = false; if (S.screen === 'collections') render(); })
    .catch(() => { st['_bh_l_' + key] = false; st['_bh_err_' + key] = true; if (S.screen === 'collections') render(); });
}
window.colBhDrill = (state, branch) => {
  const st = colState();
  // '' = explicitly cleared by user (show state list); null = auto (use filter)
  st.bhDrillState = state != null ? state : '';
  st.bhDrillUnit  = branch != null ? branch : '';
  st.bhUnit = null; st.bhAgency = null;
  st['_bh_l_Unit'] = false; st['_bh_l_Agency'] = false;
  st['_bh_err_Unit'] = false; st['_bh_err_Agency'] = false;
  render();
};

function _colBhModeTag(type) {
  const map = { app:['App','var(--grn)'], digital:['Digital','var(--blue)'], cash:['Cash','var(--gold)'] };
  const [l, c] = map[type] || ['—','var(--muted)'];
  return `<span style="background:${c}22;color:${c};font-size:10px;font-weight:700;padding:1px 7px;border-radius:20px">${l}</span>`;
}

function _colBhSparkline(monthData) {
  const maxAmt = Math.max(...monthData.filter(Boolean).map(m => m.amount || 0), 1);
  return `<div style="display:flex;gap:2px;align-items:flex-end;height:22px">` +
    monthData.map(m => {
      if (!m || m.amount <= 0) return `<div style="width:9px;height:4px;background:var(--brd);border-radius:2px;opacity:.35"></div>`;
      const h = Math.max(4, Math.round(m.amount / maxAmt * 22));
      const c = m.app_amt > m.cash_amt && m.app_amt > m.dig_amt ? 'var(--grn)'
              : m.cash_amt > m.dig_amt ? 'var(--gold)' : 'var(--blue)';
      return `<div style="width:9px;height:${h}px;background:${c};border-radius:2px" title="${colFmtC(m.amount)}"></div>`;
    }).join('') + `</div>`;
}

function _colBhSummary(stData) {
  if (!stData || !stData.rows) return '';
  const t = stData.rows.reduce((acc, r) => { acc.agencies += r.agencies; acc.app += r.app_agencies; acc.cash += r.cash_agencies; acc.dig += r.dig_agencies; return acc; }, { agencies:0, app:0, cash:0, dig:0 });
  return `<div class="vz-kgrid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    ${vzKpi({ icon:'🏢', label:'Agencies · 6 Months', value: t.agencies.toLocaleString('en-IN'), status:'fl' })}
    ${vzKpi({ icon:'📱', label:'App Users',   value: t.app.toLocaleString('en-IN'), status:'up' })}
    ${vzKpi({ icon:'💳', label:'Digital Only', value: t.dig.toLocaleString('en-IN'), status:'up' })}
    ${vzKpi({ icon:'💵', label:'Cash Payers',  value: t.cash.toLocaleString('en-IN'), status:'dn' })}
  </div>`;
}

function _colBhStateTable(sd) {
  const STATE_ORDER = ['RAJASTHAN','MADHYA PRADESH','CHHATTISGARH','NATIONAL'];
  const rows = (sd.rows || []).slice().sort((a, b) => {
    const ia = STATE_ORDER.indexOf((a.grp||'').toUpperCase()), ib = STATE_ORDER.indexOf((b.grp||'').toUpperCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const tbl = rows.map(r => `<tr style="cursor:pointer" onclick="colBhDrill('${esc(r.grp).replace(/'/g,"\\'")}','')">
    <td><b style="color:var(--acc)">${esc(r.grp)}</b></td>
    <td class="r">${r.agencies.toLocaleString()}</td>
    <td class="r">${_colBhModeTag('app')} <b>${r.app_agencies}</b> <small style="color:var(--muted)">(${r.agencies?Math.round(r.app_agencies/r.agencies*100):0}%)</small></td>
    <td class="r">${_colBhModeTag('digital')} ${r.dig_agencies}</td>
    <td class="r">${_colBhModeTag('cash')} ${r.cash_agencies}</td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No data for last 6 months</td></tr>';
  return `<div class="vz-sec"><div class="cardhead"><h3>Payment Mode Behaviour — State wise
      <small style="font-weight:400;color:var(--muted);margin-left:6px">Rolling 6 months · click state to drill in</small></h3>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>State</th><th class="r">Agencies</th><th class="r">📱 App Users</th><th class="r">💳 Digital</th><th class="r">💵 Cash</th><th class="r">6M Collection</th></tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

function _colBhUnitTable(ud, drillState) {
  const rows = (ud.rows || []).slice().sort((a, b) => (b.total_amount||0) - (a.total_amount||0));
  const tbl = rows.map(r => `<tr style="cursor:pointer" onclick="colBhDrill('${esc(drillState).replace(/'/g,"\\'")}','${esc(r.grp).replace(/'/g,"\\'")}')">
    <td><b style="color:var(--acc)">${esc(r.grp)}</b></td>
    <td class="r">${r.agencies.toLocaleString()}</td>
    <td class="r">${_colBhModeTag('app')} <b>${r.app_agencies}</b> <small style="color:var(--muted)">(${r.agencies?Math.round(r.app_agencies/r.agencies*100):0}%)</small></td>
    <td class="r">${_colBhModeTag('digital')} ${r.dig_agencies}</td>
    <td class="r">${_colBhModeTag('cash')} ${r.cash_agencies}</td>
    <td class="r num">${colFmtC(r.total_amount)}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No data</td></tr>';
  return `<div class="vz-sec"><div class="cardhead"><h3>${esc(drillState)} — Unit wise
      <small style="font-weight:400;color:var(--muted);margin-left:6px">Click unit to see agencies</small></h3>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Unit</th><th class="r">Agencies</th><th class="r">📱 App Users</th><th class="r">💳 Digital</th><th class="r">💵 Cash</th><th class="r">6M Collection</th></tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

function _colBhAgencyTable(ad, drillState, drillUnit) {
  const { months, agencies } = ad;
  const mHdr = months.map(m => `<th style="min-width:52px;text-align:center;font-size:10px;color:var(--muted)">${m.slice(5)}</th>`).join('');
  const legnd = `<div style="display:flex;gap:12px;font-size:11px;color:var(--muted);margin-bottom:8px">
    <span>● Legend:</span>
    <span style="color:var(--grn);font-weight:600">█ App</span>
    <span style="color:var(--blue);font-weight:600">█ Digital</span>
    <span style="color:var(--gold);font-weight:600">█ Cash</span>
    <span style="color:var(--brd);font-weight:600">█ No payment</span>
  </div>`;
  const tbl = agencies.map(a => {
    const ds = Number(a.days_since);
    const dormant = ds > 60;
    const spark = _colBhSparkline(a.monthData);
    const lastDate = a.last_payment ? String(a.last_payment).slice(0, 10) : '—';
    return `<tr>
      <td style="max-width:180px;cursor:pointer" onclick="openAgencyProfile('${esc(a.unit_code||'').replace(/'/g,"\\'")}','${esc(a.ag_code||'').replace(/'/g,"\\'")}','${esc(a.ag_name||a.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">
        <b style="font-size:12px;color:var(--chart-1)">${esc(a.ag_name || a.ag_code || '')}</b>
        <br><small style="color:var(--muted)">${esc(a.ag_code||'')} · ${esc(a.branch_name||'')}</small>
      </td>
      <td style="text-align:center">${_colBhModeTag(a.dominant)}</td>
      <td style="font-size:11px">${lastDate}</td>
      <td class="r" style="color:${dormant?'var(--red)':'var(--grn)'};font-size:11px">${ds != null ? ds + 'd' : '—'}</td>
      <td>${spark}</td>
      ${a.monthData.map(m => {
        if (!m) return `<td style="text-align:center;color:var(--muted);font-size:11px">—</td>`;
        const c = m.app_amt > m.cash_amt && m.app_amt > m.dig_amt ? 'var(--grn)' : m.cash_amt > m.dig_amt ? 'var(--gold)' : 'var(--blue)';
        return `<td style="text-align:right;font-size:11px;color:${c};font-weight:600">${colFmtC(m.amount)}</td>`;
      }).join('')}
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--muted)">No data for this unit</td></tr>';
  return `<div class="vz-sec">
    <div class="cardhead"><h3>${esc(drillUnit)} — Agency wise payment trend
      <small style="font-weight:400;color:var(--muted);margin-left:6px">${agencies.length} agencies · rolling 6 months</small></h3>
    </div>
    ${legnd}
    <div class="tablewrap"><table>
      <thead><tr><th>Agency</th><th style="text-align:center">Mode</th><th>Last Payment</th><th class="r">Age</th><th>Trend</th>${mHdr}</tr></thead>
      <tbody>${tbl}</tbody>
    </table></div>
  </div>`;
}

function colBehaviorTab() {
  const st = colState();
  const fState  = (st.filters && st.filters.state)  || '';
  const fBranch = (st.filters && st.filters.branch) || '';

  // null = never drilled (auto-apply filter geo); '' = user explicitly cleared
  // string = user drilled into that state/unit
  const drillState = st.bhDrillState !== null ? st.bhDrillState : fState;
  const drillUnit  = st.bhDrillUnit  !== null ? st.bhDrillUnit  : (st.bhDrillState === null ? fBranch : '');

  // Pre-load whichever level we'll render
  _colBhLoad('State', 'state', '', '');
  if (drillState && !drillUnit) _colBhLoad('Unit',   'unit',   drillState, '');
  if (drillState &&  drillUnit) _colBhLoad('Agency', 'agency', drillState, drillUnit);

  const summary = _colBhSummary(st.bhState);
  const bhErr = msg => `<div class="card pad" style="color:var(--muted)">⚠️ ${msg} <button class="btn sm" style="margin-left:8px" onclick="colState()['_bh_err_State']=false;colState()['_bh_err_Unit']=false;colState()['_bh_err_Agency']=false;render()">Retry</button></div>`;
  const backAll   = `<button class="btn sm" style="margin-bottom:10px" onclick="colBhDrill('','')">← All States</button>`;
  const backState = `<button class="btn sm" style="margin-bottom:10px;margin-left:6px" onclick="colBhDrill('${esc(drillState).replace(/'/g,"\\'")}','')">← ${esc(drillState)}</button>`;

  // Level 0 — State list (filtered by collection state-filter if set)
  if (!drillState) {
    if (st['_bh_err_State']) return summary + bhErr('Could not load behaviour data.');
    if (!st.bhState) return summary + _cmdSkel();
    return summary + _colBhStateTable(st.bhState);
  }

  // Level 1 — Unit list within drillState
  if (!drillUnit) {
    if (st['_bh_err_Unit']) return summary + backAll + bhErr('Could not load unit data.');
    return summary + backAll + (!st.bhUnit ? _cmdSkel() : _colBhUnitTable(st.bhUnit, drillState));
  }

  // Level 2 — Agency list within drillState + drillUnit
  if (st['_bh_err_Agency']) return summary + backAll + backState + bhErr('Could not load agency data.');
  return summary + backAll + backState + (!st.bhAgency ? _cmdSkel() : _colBhAgencyTable(st.bhAgency, drillState, drillUnit));
}

VIEWS.collections = () => {
  const st = colState();
  const tabs = [['overview','📊 Overview'],['geo','🗺️ State-wise'],['trend','📈 Trend'],['modes','💳 Modes'],['agencies','🏢 Agencies'],['behavior','📋 Behaviour'],['billing','🧾 Bill vs Collection'],['short_payment','⚠️ Short Payment']];
  const OWN = st.tab === 'billing' || st.tab === 'short_payment';   // tabs with their own data source
  // Standard tabs load the shared collection dataset first; the "own-data" tabs skip that gate.
  if (!OWN && !st.kpis && !st.loading && !st.error) { colFetch(); return pagehead('Collections','Loading collection data...'); }
  const tabBar = `<div style="display:flex;border-bottom:1px solid var(--brd);margin-bottom:16px;overflow-x:auto">
    ${tabs.map(([id,lbl])=>`<button onclick="colState().tab='${id}';render()"
      style="padding:10px 18px;border:none;border-bottom:3px solid ${st.tab===id?'var(--chart-1)':'transparent'};background:none;font-size:13px;font-weight:${st.tab===id?'700':'500'};color:${st.tab===id?'var(--chart-1)':'var(--muted)'};cursor:pointer;white-space:nowrap;transition:color .2s,border-color .2s">${lbl}</button>`).join('')}
  </div>`;
  let content;
  if      (st.tab==='billing')       content = colBillingTab();
  else if (st.tab==='short_payment') content = colShortPayTab();
  else if (st.loading) content = '<div style="text-align:center;padding:60px;color:var(--muted)">⏳ Loading collection data...</div>';
  else if (st.error)   content = `<div class="card pad" style="color:var(--red)">⚠️ ${esc(st.error)} <button class="btn sm" style="margin-left:8px" onclick="colFetch()">Retry</button></div>`;
  else if (st.tab==='overview') content = colOverviewTab();
  else if (st.tab==='geo')      content = colGeoTab();
  else if (st.tab==='trend')    content = colTrendTab();
  else if (st.tab==='modes')    content = colModesTab();
  else if (st.tab==='agencies') content = colAgenciesTab();
  else                          content = colBehaviorTab();
  const sub = st.kpis ? (st.kpis.last_date ? `Jan–Jul 2026 · last payment ${st.kpis.last_date}` : 'Jan–Jul 2026') : 'Collections';
  // Bill-vs-Collection uses only the date range; Short Payment has its own filters — hide the shared panel there
  const showPanel = st.tab !== 'short_payment';
  return pagehead('Collections', sub) + (showPanel ? colFilterPanel() : '') + tabBar + content;
};

/* ---- Collections: Billing vs Collection tab ---- */
function _colBillSig() { const f = colState().filters; return [f.from, f.to, f.state].join('|'); }
function colBillingFetch() {
  const st = colState(), sig = _colBillSig();
  if (st._billSig === sig && (st.billing || st._billLoading)) return;
  st._billSig = sig; st._billLoading = true; st.billing = null;
  const f = st.filters, p = [];
  if (f.from)  p.push('from=' + f.from);
  if (f.to)    p.push('to=' + f.to);
  if (f.state) p.push('state_name=' + encodeURIComponent(f.state));
  fetch(colApi() + '/billing-vs-collection' + (p.length ? '?' + p.join('&') : ''), { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.billing = d; st._billLoading = false; if (S.screen === 'collections' && st.tab === 'billing') render(); })
    .catch(e => { st.billing = { _err: String(e) }; st._billLoading = false; if (S.screen === 'collections' && st.tab === 'billing') render(); });
}
function colBillingTab() {
  colBillingFetch();
  const st = colState(), d = st.billing;
  if (!d) return '<div style="text-align:center;padding:60px;color:var(--muted)">⏳ Loading billing vs collection…</div>';
  if (d._err) return `<div class="card pad" style="color:var(--red)">⚠️ ${esc(d._err)}</div>`;
  const money = v => fmtC(v);
  const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monLbl = m => { const [y, mm] = String(m).split('-'); return MONS[(+mm) - 1] + ' ' + y; };
  const pctCell = p => p == null ? '—' : `<span style="color:${p >= 80 ? 'var(--grn)' : p >= 50 ? 'var(--gold)' : 'var(--red)'};font-weight:700">${p}%</span>`;
  const cell = (v, extra = '') => `<td style="padding:7px 12px;text-align:right;font-variant-numeric:tabular-nums;${extra}">${money(v)}</td>`;
  const hdr = `<div class="card pad" style="margin-bottom:14px">
    <div style="font-size:13px;color:var(--muted)">Billing <b style="color:var(--ink)">${monLbl(d.bill_month)}</b> &nbsp;→&nbsp; Collection <b style="color:var(--ink)">${esc(d.coll_from)} to ${esc(d.coll_to)}</b></div>
    <div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:10px">
      <div><div class="lbl">Billing</div><b class="num" style="font-size:18px">${money(d.total_billing)}</b></div>
      <div><div class="lbl">Collection</div><b class="num" style="font-size:18px;color:var(--grn)">${money(d.total_collection)}</b></div>
      <div><div class="lbl">Outstanding</div><b class="num" style="font-size:18px;color:var(--red)">${money(d.total_outstanding)}</b></div>
      <div><div class="lbl">Collection %</div><b class="num" style="font-size:18px">${d.total_pct == null ? '—' : d.total_pct + '%'}</b></div>
    </div></div>`;
  const th = 'style="padding:8px 12px;text-align:right"', thl = 'style="padding:8px 12px;text-align:left"', thc = 'style="padding:8px 12px;text-align:center"';
  const stTable = `<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
    <div class="cardhead" style="padding:12px 14px;border:none"><h3>State-wise</h3></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:var(--surf2)"><th ${thl}>State</th><th ${th}>Billing</th><th ${th}>Collection</th><th ${th}>Outstanding</th><th ${thc}>Coll %</th><th ${th}>Units</th></tr></thead>
      <tbody>${d.states.map(s => `<tr style="border-top:1px solid var(--brd)">
        <td style="padding:7px 12px"><b>${esc(s.state)}</b></td>${cell(s.billing)}${cell(s.collection, 'color:var(--grn)')}${cell(s.outstanding, 'color:var(--red)')}
        <td style="padding:7px 12px;text-align:center">${pctCell(s.coll_pct)}</td><td style="padding:7px 12px;text-align:right">${s.units}</td></tr>`).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--muted)">No data for this period</td></tr>`}</tbody>
    </table></div></div>`;
  const unTable = `<div class="card" style="padding:0;overflow:hidden">
    <div class="cardhead" style="padding:12px 14px;border:none"><h3>Unit-wise (${d.units.length})</h3></div>
    <div style="overflow-x:auto;max-height:520px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:var(--surf2);position:sticky;top:0"><th ${thl}>Unit / Branch</th><th ${thl}>State</th><th ${th}>Billing</th><th ${th}>Collection</th><th ${th}>Outstanding</th><th ${thc}>Coll %</th></tr></thead>
      <tbody>${d.units.map(u => `<tr style="border-top:1px solid var(--brd)">
        <td style="padding:7px 12px"><b>${esc(u.unit_name)}</b></td><td style="padding:7px 12px;color:var(--muted)">${esc(u.state)}</td>
        ${cell(u.billing)}${cell(u.collection, 'color:var(--grn)')}${cell(u.outstanding, 'color:var(--red)')}
        <td style="padding:7px 12px;text-align:center">${pctCell(u.coll_pct)}</td></tr>`).join('') || `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--muted)">No data</td></tr>`}</tbody>
    </table></div></div>`;
  return hdr + stTable + unTable;
}

/* ---- Collections: Short Payment tab (embeds the existing Short Payment report) ---- */
let _spEmbed = false;
function _spVisible() { return S.screen === 'short_payment' || (S.screen === 'collections' && colState().tab === 'short_payment'); }
function colShortPayTab() {
  _spEmbed = true;
  let html; try { html = VIEWS.short_payment(); } finally { _spEmbed = false; }
  return html;
}

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
  tab: 'overview', filters: _isPanIndiaAdmin() ? { state: 'RPPL', unit_code: 'JA0' } : {}, filterOpts: null, kpis: null,
  ageing: null, agencies: null, top: null, trend: null, unitSummary: null,
  topLimit: 10, topSort: 'outstanding', agSort: 'outstanding',
  agPage: 1, agSearch: '', agBucket: null, _loading: {},
  drillState: '', drillUnit: '', drillUnitName: '', drStates: null, drUnits: null, drExecs: null,
});

// Outstanding region codes → friendly state names (data groups as RPPL/MP/CG/NATIONAL).
const OU_STATE_LABEL = { RPPL: 'Rajasthan', RP: 'Rajasthan', MP: 'Madhya Pradesh', CG: 'Chhattisgarh', NATIONAL: 'National' };
const ouStateLabel = s => OU_STATE_LABEL[String(s || '').toUpperCase()] || (s || 'Other');
// Drill query string: keep the bar's non-geo filters, override state/unit with the drill's own.
function ouDrillQS(extra) {
  const f = ouState().filters, p = new URLSearchParams();
  if (f.ag_status) p.set('ag_status', f.ag_status);
  if (f.ag_type)   p.set('ag_type', f.ag_type);
  if (f.zh_name)   p.set('zh_name', f.zh_name);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v) p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
}
function ouDrillGet(key, path, extra) {
  const st = ouState();
  if (st._loading[key] || st[key]) return;
  st._loading[key] = true;
  api.get('/api/outstanding/' + path + ouDrillQS(extra))
    .then(d => { st[key] = d; st._loading[key] = false; if (S.screen === 'outstanding') render(); })
    .catch(() => { st._loading[key] = false; if (S.screen === 'outstanding') render(); });
}
window.ouDrill = (state, unit, unitName) => {
  const st = ouState();
  st.drillState = state || ''; st.drillUnit = unit || ''; st.drillUnitName = unitName || '';
  st.drUnits = st.drExecs = null;
  render();
};
// Executive → jump to the Agencies tab, scoped to that unit + executive.
window.ouDrillExec = (unit, unitName, exec) => {
  const st = ouState();
  st.filters = Object.assign({}, st.filters, { unit_code: unit, exec_name: exec });
  st.agencies = null; st._agCacheKey = null; st.tab = 'agencies';
  render();
};

function ouApi(path) { return `${location.origin}/api/outstanding/${path}`; }

function ouQS(extra = '') {
  const st = ouState();
  const f = st.filters;
  const p = new URLSearchParams();
  if (f.state)     p.set('state',     f.state);
  if (f.unit_code) p.set('unit_code', f.unit_code);
  if (f.ag_status) p.set('ag_status', f.ag_status);
  if (f.ag_type)   p.set('ag_type',   f.ag_type);
  if (f.zh_name)   p.set('zh_name',   f.zh_name);
  if (f.exec_name) p.set('exec_name', f.exec_name);
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
  fetch(`${location.origin}/api/sync/outstanding`, {
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
  fetch(`${location.origin}/api/sync/outstanding/status`)
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
  st.filters = Object.assign({}, st.filters, { unit_code: unitCode, exec_name: '' });
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

  return kpiGrid + agSection + ouDrillSection(st);
}

// State → Unit → Executive drill for the Outstanding dashboard.
function ouDrillSection(st) {
  const spin = `<span style="color:var(--muted)">Loading…</span>`;
  const linkC = (txt, fn, active) => `<span onclick="${fn}" style="cursor:pointer;color:${active ? 'var(--ink)' : 'var(--chart-1)'};font-weight:${active ? 700 : 500}">${txt}</span>`;
  const crumbs = [linkC('States', "ouDrill('')", !st.drillState)];
  if (st.drillState) crumbs.push(linkC(esc(ouStateLabel(st.drillState)), `ouDrill('${esc(st.drillState)}')`, !st.drillUnit));
  if (st.drillUnit) crumbs.push(linkC(esc(st.drillUnitName || st.drillUnit), '', true));
  const bc = `<div style="font-size:12px;margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${crumbs.join('<span style="color:var(--muted)">›</span>')}</div>`;

  // Which level / data / columns
  let title, sub, data, firstCol, cellFn, clickHint;
  if (!st.drillState) {
    ouDrillGet('drStates', 'state-summary');
    title = 'State-wise Outstanding'; sub = 'Rajasthan · Madhya Pradesh · Chhattisgarh · National — click a state to drill into units';
    data = st.drStates; firstCol = 'State';
    cellFn = r => `<td style="padding:6px 10px;font-weight:600;cursor:pointer;color:var(--chart-1)" onclick="ouDrill('${esc(r.state_code)}')">📍 ${esc(ouStateLabel(r.state_code))} <small style="color:var(--muted);font-weight:400">${r.units} units</small></td>`;
  } else if (!st.drillUnit) {
    ouDrillGet('drUnits', 'unit-summary', { state: st.drillState });
    title = ouStateLabel(st.drillState) + ' — Units'; sub = 'Click a unit to see its executives';
    data = st.drUnits; firstCol = 'Unit';
    cellFn = r => `<td style="padding:6px 10px;font-weight:600;cursor:pointer;color:var(--chart-1)" onclick="ouDrill('${esc(st.drillState)}','${esc(r.unit_code)}','${esc((r.unit_name || r.unit_code)).replace(/'/g, "\\'")}')">${esc(r.unit_name || r.unit_code)} <small style="color:var(--muted);font-weight:400">${esc(r.zh_name || '')}</small></td>`;
  } else {
    ouDrillGet('drExecs', 'exec-summary', { unit_code: st.drillUnit });
    title = esc(st.drillUnitName || st.drillUnit) + ' — Executives'; sub = 'Click an executive to open their agencies';
    data = st.drExecs; firstCol = 'Executive';
    cellFn = r => `<td style="padding:6px 10px;font-weight:600;cursor:pointer;color:var(--chart-1)" onclick="ouDrillExec('${esc(st.drillUnit)}','${esc((st.drillUnitName || st.drillUnit)).replace(/'/g, "\\'")}','${esc(r.exec_name).replace(/'/g, "\\'")}')">👔 ${esc(r.exec_name)}</td>`;
  }

  const rows = (data && data.rows) || [];
  let bodyHtml;
  if (!data) bodyHtml = `<tr><td colspan="7" style="padding:16px;text-align:center">${spin}</td></tr>`;
  else if (!rows.length) bodyHtml = `<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--muted)">No data</td></tr>`;
  else {
    let ri = 0;
    bodyHtml = rows.map(r => {
      const bg = (ri++ % 2) ? 'background:var(--surface-2);' : '';
      return `<tr style="${bg}">${cellFn(r)}
        <td style="padding:6px 10px">${r.agencies}</td>
        <td style="padding:6px 10px">${r.with_outstanding}</td>
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(r.bill_amt)}</td>
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(r.collected)}</td>
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums;font-weight:700;color:${Number(r.cl_amt) > 0 ? 'var(--red)' : 'var(--grn)'}">${ouFmtC(r.cl_amt)}</td>
        <td style="padding:6px 10px">${r.coll_pct}%${ouBar(Number(r.coll_pct), Number(r.coll_pct) >= 80 ? '#2ecc71' : '#e74c3c')}</td></tr>`;
    }).join('');
    // Totals
    const T = rows.reduce((a, r) => ({ ag: a.ag + Number(r.agencies || 0), wo: a.wo + Number(r.with_outstanding || 0), bill: a.bill + Number(r.bill_amt || 0), col: a.col + Number(r.collected || 0), cl: a.cl + Number(r.cl_amt || 0) }), { ag: 0, wo: 0, bill: 0, col: 0, cl: 0 });
    const tPct = T.bill > 0 ? (T.col / T.bill * 100).toFixed(1) : '0.0';
    bodyHtml += `<tr style="font-weight:800;background:var(--navy);color:#fff">
      <td style="padding:6px 10px">Total</td><td style="padding:6px 10px">${T.ag}</td><td style="padding:6px 10px">${T.wo}</td>
      <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(T.bill)}</td>
      <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(T.col)}</td>
      <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${ouFmtC(T.cl)}</td>
      <td style="padding:6px 10px">${tPct}%</td></tr>`;
  }

  return `<div class="vz-sec" style="margin-bottom:12px">
    <div class="sdv-sec-head" style="border-left-color:var(--chart-1)">
      <div class="sdv-sec-title">${esc(title)}</div>
      <div class="sdv-sec-sub">${esc(sub)}</div>
    </div>
    ${bc}
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:700px">
        <thead><tr style="background:var(--navy);color:#fff">
          ${[firstCol, 'Agencies', 'With O/S', 'Billing', 'Collected', 'Outstanding', 'Coll%'].map(h => `<th style="padding:6px 10px;text-align:left;white-space:nowrap">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Tab: Agencies ───────────────────────────────────────────
function ouAgenciesTab() {
  const st = ouState();
  const page = st.agPage, sort = st.agSort, bucket = st.agBucket;
  const qExtra = `sort=${sort}&page=${page}&limit=50${st.agSearch ? '&search=' + encodeURIComponent(st.agSearch) : ''}${bucket ? '&bucket=' + encodeURIComponent(bucket) : ''}`;

  // Bust cache when sort/page/search/bucket changes
  const cacheKey = `agencies_${sort}_${page}_${st.agSearch}_${bucket||''}_${st.filters.exec_name||''}_${st.filters.unit_code||''}`;
  if (st._agCacheKey !== cacheKey) { st.agencies = null; st._agCacheKey = cacheKey; }
  if (!st.agencies) ouFetch('agencies', 'agencies', qExtra);

  const d = st.agencies;

  const sortBtn = (s, label) =>
    `<button class="btn sm${sort === s ? ' navy' : ''}" style="font-size:11px" onclick="ouState().agSort='${s}';ouState().agencies=null;ouState().agPage=1;render()">${label}</button>`;

  const bucketChip = bucket ? `<div style="display:inline-flex;align-items:center;gap:5px;background:var(--navy);color:#fff;border-radius:14px;padding:3px 10px;font-size:11px;font-weight:600">
    Bucket: ${bucket} Days
    <span onclick="ouState().agBucket=null;ouState().agencies=null;render()" style="cursor:pointer;opacity:.7;font-size:14px;line-height:1" title="Clear bucket filter">✕</span>
  </div>` : '';

  const execChip = st.filters.exec_name ? `<div style="display:inline-flex;align-items:center;gap:5px;background:var(--chart-1);color:#fff;border-radius:14px;padding:3px 10px;font-size:11px;font-weight:600">
    👔 ${esc(st.filters.exec_name)}
    <span onclick="ouState().filters.exec_name='';ouState().agencies=null;ouState()._agCacheKey=null;render()" style="cursor:pointer;opacity:.8;font-size:14px;line-height:1" title="Clear executive filter">✕</span>
  </div>` : '';

  const controls = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
    <div style="flex:1;min-width:160px">
      <input class="inp" placeholder="Search agency / city…" value="${esc(st.agSearch||'')}" style="font-size:12px;padding:5px 8px;width:100%"
        oninput="ouState().agSearch=this.value;ouState().agencies=null;ouState().agPage=1;if(S.screen==='outstanding')render()">
    </div>
    ${bucketChip}
    ${execChip}
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
          // Overdue = balance carried forward from prior periods (op_amt); Current =
          // net new billing since then. Matches /api/outstanding/ageing's model —
          // NOT a last-supply-date split, which would wrongly zero out Curr. O/S for
          // any agency whose last delivery was >30 days ago even if most of its
          // outstanding is fresh billing.
          const opAmt     = Number(r.op_amt)||0;
          const clAmt     = Number(r.cl_amt)||0;
          const overdueAmt = Math.min(opAmt, clAmt);
          const currAmt    = Math.max(0, clAmt - opAmt);
          return `<tr style="${i%2?'background:var(--surface-2)':''}cursor:pointer" onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.ag_code).replace(/'/g,"\\'")}','${esc(r.ag_name||r.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">
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
    return `<div class="card" style="padding:12px 14px;margin-bottom:6px;cursor:pointer" onclick="openAgencyProfile('${esc(r.unit_code||'').replace(/'/g,"\\'")}','${esc(r.ag_code||'').replace(/'/g,"\\'")}','${esc(r.ag_name||r.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">
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
   EXECUTIVE PERFORMANCE DASHBOARD
   Supply · Collection · Outstanding by executive
   Navigation: List → Executive Detail → Agency Detail
   ════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────────────────
const epState = () => S.live.ep || (S.live.ep = {
  filters: { from: prevMonthRange().from, to: prevMonthRange().to, state: _isPanIndiaAdmin() ? 'RAJASTHAN' : '', unit_code: _isPanIndiaAdmin() ? 'JA0' : '', metric: 'collection_pct', top_n: 10, period: 'month' },
  filterOpts: null, kpis: null, ranking: null,
  list: null, listPage: 1, listSearch: '', listSort: 'collection_pct', listSortDir: 'desc', _listKey: '',
  drillExec: '', drillExecName: '', drillExecData: null,
  drillAgency: '', drillUnitCode: '', drillAgencyName: '', drillAgencyData: null,
  growth: null, dcr: null, lastVisit: null, alerts: null,
  alertBucket: '', alertBucketData: null, alertBucketLoading: false,
  alertExpanded: '',
  emailCompose: null, emailSending: false, emailResult: null,
  _loading: {}, _error: {},
});

// ── API helpers ───────────────────────────────────────────────────────────────
function epApi(path) { return `/api/exec-perf/${path}`; }

function epQS(extra) {
  const f = epState().filters;
  const p = new URLSearchParams();
  if (f.from)      p.set('from',      f.from);
  if (f.to)        p.set('to',        f.to);
  if (f.state)     p.set('state',     f.state);
  if (f.unit_code) p.set('unit_code', f.unit_code);
  if (extra) Object.entries(extra).forEach(([k, v]) => { if (v != null && v !== '') p.set(k, String(v)); });
  return '?' + p.toString();
}

// Save live filter DOM values back to st.filters before any render() wipes them
function epSnapshotFilters() {
  const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const f = epState().filters;
  const from = g('ep-from'), to = g('ep-to'), state = g('ep-state'), unit = g('ep-unit');
  if (from  !== null) f.from      = from;
  if (to    !== null) f.to        = to;
  if (state !== null) f.state     = state;
  if (unit  !== null) f.unit_code = unit;
}

function epFetch(key, path, extra) {
  const st = epState();
  if (st._loading[key] || st[key] || st._error[key]) return;
  st._loading[key] = true;
  api.get(epApi(path) + epQS(extra))
    .then(d => {
      epSnapshotFilters();
      if (d) { st[key] = d; st._error[key] = false; }
      else    { st._error[key] = true; }
      st._loading[key] = false;
      if (S.screen === 'exec_perf') render();
    })
    .catch(() => { st._loading[key] = false; st._error[key] = true; if (S.screen === 'exec_perf') render(); });
}

function epClearCache() {
  const f    = epState().filters;
  const opts = epState().filterOpts;
  S.live.ep  = null; epState();
  S.live.ep.filters    = f;
  S.live.ep.filterOpts = opts;
}

// Period shortcut helpers
function epPeriodToday()  {
  const t = todayISO();
  return { from: t, to: t, period: 'today' };
}
function epPeriodWeek() {
  const d = new Date();
  const dow = d.getDay() || 7; // Mon=1..Sun=7
  const mon = new Date(d); mon.setDate(d.getDate() - (dow - 1));
  return { from: mon.toISOString().slice(0, 10), to: todayISO(), period: 'week' };
}
function epPeriodMonth()  { return { ...prevMonthRange(), period: 'month' }; }

window.epSetPeriod = preset => {
  const st = epState();
  const p  = preset === 'today' ? epPeriodToday() : preset === 'week' ? epPeriodWeek() : epPeriodMonth();
  epClearCache();
  S.live.ep.filters = { ...epState().filters, ...p };
  render();
};

// ── Formatters ────────────────────────────────────────────────────────────────
const epFmtN = v => (!v && v !== 0) ? '—' : Number(v).toLocaleString('en-IN');
const epFmtC = v => {
  if (!v && v !== 0) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(n) >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};
const epPct = v => (!v && v !== 0) ? '—' : `${Number(v).toFixed(1)}%`;
const epPctColor = v => {
  if (!v && v !== 0) return 'var(--muted)';
  const n = Number(v);
  return n >= 80 ? 'var(--grn)' : n >= 50 ? 'var(--gold)' : 'var(--red)';
};
const epMetricLabel = m => ({ supply: 'Supply (Copies)', collection: 'Collection (₹)', collection_pct: 'Collection %', outstanding: 'Outstanding (₹)' }[m] || m);
const epMetricVal = (r, m) => m === 'supply' ? epFmtN(r.total_supply) : m === 'collection' ? epFmtC(r.total_collection) : m === 'collection_pct' ? epPct(r.collection_pct) : epFmtC(r.total_outstanding);
const epMetricColor = (r, m) => m === 'collection_pct' ? epPctColor(r.collection_pct) : m === 'outstanding' ? 'var(--red)' : m === 'collection' ? 'var(--grn)' : 'var(--ink)';

// ── Drill / navigation functions (window-scoped for inline onclick) ───────────
window.epDrillExec = (code, name) => {
  if (!code) return;
  const st = epState();
  st.drillExec = code; st.drillExecName = name || code;
  st.drillExecData = null; st.drillAgency = ''; st.drillAgencyData = null;
  render();
  const f = st.filters;
  api.get(epApi(`executive/${encodeURIComponent(code)}`) + `?from=${f.from}&to=${f.to}`)
    .then(d => { if (d) { epState().drillExecData = d; } if (S.screen === 'exec_perf') render(); });
};

window.epDrillAgency = (unitCode, agCode, agName) => {
  if (!agCode) return;
  const st = epState();
  st.drillAgency = agCode; st.drillUnitCode = unitCode; st.drillAgencyName = agName || agCode;
  st.drillAgencyData = null;
  render();
  const f = st.filters;
  api.get(epApi(`agency/${encodeURIComponent(unitCode)}/${encodeURIComponent(agCode)}`) + `?from=${f.from}&to=${f.to}`)
    .then(d => { if (d) { epState().drillAgencyData = d; } if (S.screen === 'exec_perf') render(); });
};

window.epBack = () => {
  const st = epState();
  if (st.drillAgency) { st.drillAgency = ''; st.drillAgencyData = null; }
  else { st.drillExec = ''; st.drillExecData = null; }
  render();
};
window.epHome = () => { const st = epState(); st.drillExec = ''; st.drillExecData = null; st.drillAgency = ''; st.drillAgencyData = null; render(); };

window.epSetMetric = v => { epState().filters.metric = v; epState().ranking = null; render(); };
window.epSetTopN   = v => { epState().filters.top_n = parseInt(v, 10); epState().ranking = null; render(); };

window.epApplyFilters = () => {
  const st = epState();
  const f  = Object.assign({}, st.filters);
  const g  = id => { const el = document.getElementById(id); return el ? el.value : null; };
  if (g('ep-from') != null) f.from      = g('ep-from');
  if (g('ep-to')   != null) f.to        = g('ep-to');
  if (g('ep-state')!= null) f.state     = g('ep-state');
  if (g('ep-unit') != null) f.unit_code = g('ep-unit');
  epClearCache();
  S.live.ep.filters = f;
  render();
};
window.epClearFilters = () => {
  const st = epState();
  const metric = st.filters.metric;
  const top_n  = st.filters.top_n;
  epClearCache();
  S.live.ep.filters = { from: monthStartISO(), to: todayISO(), state: '', unit_code: '', metric, top_n };
  render();
};

window.epStateChange = v => { epSnapshotFilters(); epState().filters.state = v; epState().filters.unit_code = ''; render(); };
window.epSortList = (col, dir) => { const st = epState(); st.listSort = col; st.listSortDir = dir; st.list = null; st._listKey = ''; render(); };
window.epListPage = p => { const st = epState(); st.listPage = p; st.list = null; st._listKey = ''; render(); };
window.epSearchList = (() => {
  let t;
  return v => { const st = epState(); clearTimeout(t); t = setTimeout(() => { st.listSearch = v; st.list = null; st._listKey = ''; st.listPage = 1; render(); }, 380); };
})();

// ── Filter panel ──────────────────────────────────────────────────────────────
function epFilterPanel() {
  const st = epState();
  const f  = st.filters;

  if (!st.filterOpts && !st._loading.filterOpts) {
    st._loading.filterOpts = true;
    api.get(epApi('filters'))
      .then(d => { epSnapshotFilters(); if (d) st.filterOpts = d; st._loading.filterOpts = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { st._loading.filterOpts = false; });
  }
  const opts = st.filterOpts || { states: [], units: [] };
  const hasFilter = f.state || f.unit_code;

  // Units cascade: show only units belonging to selected state (if any)
  const visibleUnits = f.state ? (opts.units || []).filter(u => u.state_nm === f.state) : (opts.units || []);

  const selState = `<select id="ep-state" class="inp" style="font-size:12px;padding:5px 6px" onchange="epStateChange(this.value)">
    <option value="">🗺 All States</option>
    ${(opts.states || []).map(s => `<option value="${esc(s)}" ${f.state === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
  </select>`;

  const selUnit = `<select id="ep-unit" class="inp" style="font-size:12px;padding:5px 6px">
    <option value="">All Units${f.state ? ' in ' + esc(f.state) : ''}</option>
    ${visibleUnits.map(u => `<option value="${esc(u.unit_code)}" ${f.unit_code === u.unit_code ? 'selected' : ''}>${esc(u.unit_name)}</option>`).join('')}
  </select>`;

  const period = f.period || 'month';
  const btnSt = p => `font-size:11.5px;padding:4px 10px;border-radius:20px;cursor:pointer;font-weight:600;border:1.5px solid ${period===p?'var(--chart-1)':'var(--brd2)'};background:${period===p?'var(--chart-1)':'transparent'};color:${period===p?'#fff':'var(--ink)'}`;

  return `<div class="card" style="padding:10px 14px;margin-bottom:12px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
      <button style="${btnSt('today')}"  onclick="epSetPeriod('today')">Today</button>
      <button style="${btnSt('week')}"   onclick="epSetPeriod('week')">This Week</button>
      <button style="${btnSt('month')}"  onclick="epSetPeriod('month')">This Month</button>
      <span style="color:var(--brd2);margin:0 2px">|</span>
      <span style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Custom</span>
      <input id="ep-from" type="date" class="inp" value="${esc(f.from)}" style="font-size:12px;padding:5px 8px">
      <span style="color:var(--muted);font-size:12px">to</span>
      <input id="ep-to" type="date" class="inp" value="${esc(f.to)}" style="font-size:12px;padding:5px 8px">
      <button class="btn pri sm" onclick="epApplyFilters()">Apply</button>
      ${hasFilter ? `<button class="btn sm" onclick="epClearFilters()">✕ Clear</button>` : ''}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      ${selState}
      ${selUnit}
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--muted)">Rank by</span>
        <select class="inp" style="font-size:12px;padding:5px 6px" onchange="epSetMetric(this.value)">
          <option value="supply"         ${f.metric === 'supply'         ? 'selected' : ''}>Supply (Copies)</option>
          <option value="collection"     ${f.metric === 'collection'     ? 'selected' : ''}>Collection (₹)</option>
          <option value="collection_pct" ${f.metric === 'collection_pct' ? 'selected' : ''}>Collection %</option>
          <option value="outstanding"    ${f.metric === 'outstanding'    ? 'selected' : ''}>Outstanding (₹)</option>
        </select>
        <span style="font-size:11px;color:var(--muted)">Top</span>
        <select class="inp" style="font-size:12px;padding:5px 6px" onchange="epSetTopN(this.value)">
          ${[5, 10, 15, 20].map(n => `<option value="${n}" ${f.top_n == n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
    </div>
  </div>`;
}

// ── KPI grid ──────────────────────────────────────────────────────────────────
function epKpiGrid() {
  const st = epState();
  epFetch('kpis', 'kpis');
  if (!st.kpis) return `<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">Loading KPIs…</div>`;
  const k = st.kpis;
  return `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon: '👤', label: 'Executives',       value: epFmtN(k.exec_count),        status: 'info', sub: `${epFmtN(k.agency_count)} agencies` })}
    ${vzKpi({ icon: '📦', label: 'Supply (Copies)',  value: epFmtN(k.total_supply),       status: 'info', sub: `${esc(k.from)} – ${esc(k.to)}` })}
    ${epGrowthCard()}
    ${vzKpi({ icon: '₹',  label: 'Collection',       value: epFmtC(k.total_collection),   status: 'good', sub: 'Period total' })}
    ${vzKpi({ icon: '⚠',  label: 'Outstanding',      value: epFmtC(k.total_outstanding),  status: 'bad',  sub: 'Current balance' })}
    ${epDcrCard()}
  </div>`;
}

// ── Ranking cards ─────────────────────────────────────────────────────────────
window.epRetryRanking = () => { const st = epState(); st._error.ranking = false; render(); };
function epRankingCards() {
  const st = epState();
  const f  = st.filters;
  epFetch('ranking', 'ranking', { metric: f.metric, top_n: f.top_n });
  if (st._error.ranking) return `<div style="height:80px;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--muted);font-size:13px">
    <span>Rankings unavailable</span>
    <button class="btn sm" onclick="epRetryRanking()">Retry</button>
  </div>`;
  if (!st.ranking) return `<div style="height:100px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">Loading rankings…</div>`;

  const { top = [], bottom = [], total = 0, metric } = st.ranking;
  const ml = epMetricLabel(metric);

  const rankRow = (r, i, isGood) => {
    const dotC = isGood ? 'var(--grn)' : 'var(--red)';
    const val  = epMetricVal(r, metric);
    const vc   = epMetricColor(r, metric);
    return `<div class="rowbtn" onclick="epDrillExec('${esc(r.executive_code)}','${esc(r.exec_name)}')"
      style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--brd2);cursor:pointer">
      <div style="width:22px;height:22px;background:${dotC};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.exec_name)}">${esc(r.exec_name || '—')}</div>
        <div style="font-size:10.5px;color:var(--muted)">${esc(r.main_unit_name || r.units || '')} · ${epFmtN(r.agency_count)} ag.</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:13px;font-weight:700;color:${vc}">${val}</div>
        ${metric !== 'collection_pct' ? `<div style="font-size:10px;color:${epPctColor(r.collection_pct)}">${epPct(r.collection_pct)} coll.</div>` : ''}
      </div>
    </div>`;
  };

  const topTitle = metric === 'outstanding' ? '⚠ Most Outstanding' : '🏆 Top ' + f.top_n + ' · ' + ml;
  const topSub   = metric === 'outstanding' ? 'Highest risk — needs attention' : 'Higher is better';
  const botTitle = metric === 'outstanding' ? '✅ Lowest Outstanding' : '⚠ Bottom ' + f.top_n + ' · ' + ml;
  const botSub   = metric === 'outstanding' ? 'Safest accounts' : 'Needs attention';
  const topTC    = metric === 'outstanding' ? 'var(--red)' : 'var(--grn)';
  const botTC    = metric === 'outstanding' ? 'var(--grn)' : 'var(--red)';

  const card = (rows, title, sub, tc, isGood) =>
    `<div class="card" style="padding:14px 16px">
      <div style="font-size:11.5px;font-weight:800;color:${tc};text-transform:uppercase;letter-spacing:.04em;margin-bottom:1px">${title}</div>
      <div style="font-size:10.5px;color:var(--muted);margin-bottom:10px">${sub}</div>
      ${rows.length ? rows.map((r, i) => rankRow(r, i, isGood)).join('') : `<div style="font-size:12px;color:var(--muted);padding:16px 0;text-align:center">No data in this period</div>`}
    </div>`;

  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px">
    ${card(top,    topTitle, topSub, topTC, metric !== 'outstanding')}
    ${card(bottom, botTitle, botSub, botTC, metric === 'outstanding')}
  </div>
  <div style="font-size:11px;color:var(--muted);margin-bottom:14px;text-align:right">${total} executives ranked · min supply filter: ${f.top_n > 0 ? 'off' : 'on'}</div>`;
}

// ── Growth card ───────────────────────────────────────────────────────────────
function epGrowthCard() {
  const st = epState();
  const f  = st.filters;
  if (!st.growth && !st._loading.growth) {
    st._loading = st._loading || {};
    st._loading.growth = true;
    api.get(epApi('growth') + epQS())
      .then(d => { epSnapshotFilters(); st.growth = d; st._loading.growth = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { st._loading.growth = false; });
  }
  if (!st.growth) return `<div style="height:70px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">Loading growth…</div>`;
  const g = st.growth;
  const pctColor = (v) => v > 0 ? 'var(--grn)' : v < 0 ? 'var(--red)' : 'var(--muted)';
  const arrow = v => v > 0 ? '↑' : v < 0 ? '↓' : '→';
  return vzKpi({
    icon: '📈',
    label: 'Supply Growth',
    value: g.total_pct != null ? `${g.total_pct > 0 ? '+' : ''}${g.total_pct}%` : '—',
    status: g.total_pct > 0 ? 'good' : g.total_pct < 0 ? 'bad' : 'info',
    sub: `${arrow(g.total_diff)} ${Math.abs(g.total_diff || 0).toLocaleString('en-IN')} copies vs prev period`,
  });
}

// ── DCR summary card ──────────────────────────────────────────────────────────
function epDcrCard() {
  const st = epState();
  if (!st.dcr && !st._loading.dcr) {
    st._loading = st._loading || {};
    st._loading.dcr = true;
    api.get(epApi('dcr') + epQS())
      .then(d => { epSnapshotFilters(); st.dcr = d; st._loading.dcr = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { st._loading.dcr = false; });
  }
  if (!st.dcr) return `<div style="height:70px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">Loading DCR…</div>`;
  const d = st.dcr;
  return vzKpi({
    icon: '📍',
    label: 'DCR Visits',
    value: epFmtN(d.total_visits),
    status: d.total_visits > 0 ? 'good' : 'warn',
    sub: `${d.execs_active} execs active · ${d.execs_active_today} active prev day`,
  });
}

// ── Prev Day Pulse — who was/wasn't active yesterday ────────────────────────────
function epTodayPulse() {
  const st = epState();
  // Trigger parallel loads (epFetch deduplicates — safe to call multiple times)
  epFetch('alerts', 'alerts');
  epFetch('dcr',    'dcr');

  if (!st.alerts && !st.dcr) {
    return `<div class="card" style="padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <div style="font-size:13px;color:var(--muted)">⏳ Loading field activity…</div>
    </div>`;
  }

  const alerts   = st.alerts || {};
  const dcr      = st.dcr    || {};
  const active   = Number(alerts.active_today ?? dcr.execs_active_today ?? 0);
  const total    = Number(alerts.total_execs  ?? 0);
  const noVisit  = (alerts.alerts || []).find(a => a.key === 'no_visit_today');
  const inactive = noVisit?.detail || [];
  const pct      = total > 0 ? Math.round(active / total * 100) : 0;
  const barColor = pct >= 80 ? 'var(--grn)' : pct >= 50 ? '#f59e0b' : 'var(--red)';
  const today    = dcr.today || alerts.today || new Date().toISOString().slice(0, 10);
  const todayFmt = new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const inactiveChips = inactive.slice(0, 18).map(e =>
    `<span onclick="epDrillExec('${esc(e.exec_code)}','${esc(e.exec_name||e.exec_code)}')"
       title="Click to view ${esc(e.exec_name||e.exec_code)}"
       style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:600;cursor:pointer;margin:2px 2px">
      ❌ ${esc(e.exec_name || e.exec_code)}
    </span>`
  ).join('');

  return `<div class="card" style="padding:14px 16px;margin-bottom:12px">
    <div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:14px">
      <div style="min-width:150px">
        <div style="font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Prev Day — ${todayFmt}</div>
        <div style="display:flex;align-items:baseline;gap:5px;margin-top:4px">
          <span style="font-size:28px;font-weight:800;color:${barColor};line-height:1">${active}</span>
          <span style="font-size:13px;color:var(--muted)">/ ${total}</span>
        </div>
        <div style="font-size:11px;font-weight:600;margin-top:1px;color:${barColor}">
          ${pct >= 80 ? '✅ Good field coverage' : pct >= 50 ? '⚠ Partial coverage' : total === 0 ? '— No scope data' : '🔴 Low field activity'}
        </div>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <div style="flex:1;height:10px;background:var(--brd2);border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:5px;transition:width .4s"></div>
          </div>
          <span style="font-size:12px;font-weight:700;color:${barColor};min-width:34px">${pct}%</span>
        </div>
        ${inactive.length > 0
          ? `<div style="font-size:11px;font-weight:700;color:var(--red);margin-bottom:4px">Not active prev day (${inactive.length}):</div>
             <div style="line-height:1.8">${inactiveChips}${inactive.length > 18 ? `<span style="font-size:11px;color:var(--muted);margin-left:4px">+${inactive.length-18} more</span>` : ''}</div>`
          : active > 0
            ? `<div style="font-size:11px;color:var(--grn);margin-top:4px">✅ All executives were active prev day</div>`
            : `<div style="font-size:11px;color:var(--muted);margin-top:4px">No DCR activity found for prev day</div>`}
      </div>
    </div>
  </div>`;
}

// ── Smart Alerts panel ────────────────────────────────────────────────────────
window.epAlertBucket = (bucket) => {
  const st = epState();
  if (st.alertBucket === bucket && st.alertBucketData) {
    st.alertBucket = ''; st.alertBucketData = null;
  } else {
    st.alertBucket = bucket; st.alertBucketData = null; st.alertBucketLoading = true;
    api.get(epApi('last-visit/agencies') + epQS({ bucket }))
      .then(d => { const s2 = epState(); s2.alertBucketData = d; s2.alertBucketLoading = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { epState().alertBucketLoading = false; });
  }
  render();
};

window.epAlertDrillExec = (code) => epDrillExec(code, code);

function epAlertsSection() {
  const st = epState();
  if (!st.alerts && !st._loading.alerts) {
    st._loading = st._loading || {};
    st._loading.alerts = true;
    api.get(epApi('alerts') + epQS())
      .then(d => { epSnapshotFilters(); st.alerts = d; st._loading.alerts = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { st._loading.alerts = false; });
  }
  if (!st.alerts) return '';
  const { alerts = [], active_today, total_execs } = st.alerts;
  if (!alerts.length && active_today === total_execs) return '';

  const alertRow = a => {
    const hasDetail = a.key === 'no_visit_today' && a.detail?.length > 0;
    return `<div style="padding:8px 12px;border-bottom:1px solid var(--brd2)">
      <div style="display:flex;align-items:center;gap:8px;cursor:${hasDetail ? 'pointer' : 'default'}"
           ${hasDetail ? `onclick="epState().alertExpanded='${a.key}'===epState().alertExpanded?'':('${a.key}');render()"` : ''}>
        <span>${a.icon}</span>
        <span style="flex:1;font-size:13px">${esc(a.message)}</span>
        ${hasDetail ? `<span style="font-size:11px;color:var(--chart-1)">${st.alertExpanded===a.key?'▲':'▼'}</span>` : ''}
      </div>
      ${hasDetail && st.alertExpanded === a.key ? `<div style="margin-top:6px;padding:6px 0">
        ${a.detail.slice(0, 20).map(e => `<span onclick="epAlertDrillExec('${esc(e.exec_code)}')" class="chip warn" style="cursor:pointer;margin:2px;font-size:11px">${esc(e.exec_name||e.exec_code)}</span>`).join('')}
        ${a.detail.length > 20 ? `<span style="font-size:11px;color:var(--muted)">+${a.detail.length-20} more</span>` : ''}
      </div>` : ''}
    </div>`;
  };

  return `<div class="card" style="overflow:hidden;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--brd2);display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-weight:700;font-size:13px">⚡ Management Attention Required</div>
        <div style="font-size:10.5px;color:var(--muted)">Team active prev day: ${active_today || 0} / ${total_execs || 0} executives</div>
      </div>
    </div>
    ${alerts.length ? alerts.map(alertRow).join('') : `<div style="padding:12px 14px;font-size:12px;color:var(--grn)">✅ No critical alerts for this period</div>`}
  </div>`;
}

// ── Last Visit Analysis section ───────────────────────────────────────────────
function epLastVisitSection() {
  const st = epState();
  if (!st.lastVisit && !st._loading.lastVisit) {
    st._loading = st._loading || {};
    st._loading.lastVisit = true;
    api.get(epApi('last-visit') + epQS())
      .then(d => { epSnapshotFilters(); st.lastVisit = d; st._loading.lastVisit = false; if (S.screen === 'exec_perf') render(); })
      .catch(() => { st._loading.lastVisit = false; });
  }
  if (!st.lastVisit) return '';
  const { buckets = {}, total = 0 } = st.lastVisit;
  if (!total) return '';

  const BUCKET_CFG = [
    { key: 'today',   label: 'Today',       color: '#22c55e', icon: '🟢' },
    { key: 'd1_3',   label: '1–3 Days',     color: '#86efac', icon: '🟢' },
    { key: 'd4_7',   label: '4–7 Days',     color: '#fbbf24', icon: '🟡' },
    { key: 'd8_15',  label: '8–15 Days',    color: '#f97316', icon: '🟠' },
    { key: 'd15plus',label: '>15 Days',      color: '#ef4444', icon: '🔴' },
    { key: 'never',  label: 'Never Visited', color: '#7f1d1d', icon: '🔴' },
  ];

  const barRow = b => {
    const count = buckets[b.key] || 0;
    const pct   = total > 0 ? Math.round(count / total * 100) : 0;
    const active= st.alertBucket === b.key;
    return `<div style="cursor:pointer;padding:6px 12px;border-bottom:1px solid var(--brd2);background:${active?'var(--surface-2)':'transparent'}"
         onclick="epAlertBucket('${b.key}')">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
        <span style="width:60px;font-size:11.5px;font-weight:600">${b.icon} ${esc(b.label)}</span>
        <div style="flex:1;height:8px;background:var(--brd2);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${b.color};border-radius:4px;transition:width .3s"></div>
        </div>
        <span style="width:54px;text-align:right;font-size:12px;font-weight:700">${count.toLocaleString('en-IN')}</span>
        <span style="width:32px;text-align:right;font-size:10.5px;color:var(--muted)">${pct}%</span>
      </div>
    </div>`;
  };

  const bucketAgencies = st.alertBucketData?.agencies || [];
  const bucketLoading  = st.alertBucketLoading;

  return `<div class="card" style="overflow:hidden;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--brd2)">
      <div style="font-weight:700;font-size:13px">🗓 Agency Last Visit Analysis</div>
      <div style="font-size:10.5px;color:var(--muted)">${total.toLocaleString('en-IN')} active agencies · click a bucket to see agency list</div>
    </div>
    ${BUCKET_CFG.map(barRow).join('')}
    ${st.alertBucket && (bucketLoading || bucketAgencies.length > 0) ? `
    <div style="padding:10px 14px;border-top:1px solid var(--brd2)">
      ${bucketLoading ? `<div style="font-size:12px;color:var(--muted)">Loading agencies…</div>` : `
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">
        ${BUCKET_CFG.find(b=>b.key===st.alertBucket)?.label||''} — ${bucketAgencies.length} agencies</div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Agency</th><th>Unit</th><th>District</th><th>Executive</th><th class="r">Last Visit</th>
      </tr></thead><tbody>
        ${bucketAgencies.slice(0,50).map((a,i) => `<tr style="${i%2?'background:var(--surface-2)':''}">
          <td><div style="font-weight:600;font-size:12px">${esc(a.ag_name||'—')}</div><div style="font-size:10px;color:var(--muted)">${esc(a.agcd)}</div></td>
          <td style="font-size:11.5px;color:var(--muted)">${esc(a.unit_name||'—')}</td>
          <td style="font-size:11.5px;color:var(--muted)">${esc(a.dist_name||a.city_name||'—')}</td>
          <td><span onclick="epDrillExec('${esc(a.executive_code||'')}','${esc(a.executive_name||'')}')" style="cursor:pointer;color:var(--chart-1);font-size:12px">${esc(a.executive_name||'—')}</span></td>
          <td class="r" style="font-size:11.5px">${a.last_visit ? esc(a.last_visit) + (a.days_since ? ` <small style="color:var(--muted)">(${a.days_since}d)</small>` : '') : '<span style="color:var(--red);font-weight:600">Never</span>'}</td>
        </tr>`).join('')}
        ${bucketAgencies.length > 50 ? `<tr><td colspan="5" style="text-align:center;padding:8px;color:var(--muted);font-size:11px">+${bucketAgencies.length-50} more</td></tr>` : ''}
      </tbody></table></div>`}
    </div>` : ''}
  </div>`;
}

// ── Email compose modal ───────────────────────────────────────────────────────
window.epOpenEmailFromDetail = () => {
  const st = epState();
  const d  = st.drillExecData;
  if (!d) return;
  const exec = d.exec || {};
  st.emailCompose = {
    execCode: exec.executive_code, execName: exec.exec_name || exec.executive_code,
    hier: { edtn_incharge_name: exec.edtn_incharge_name||null, circ_incharge_name: exec.circ_incharge_name||null, zonal_head_name: exec.zonal_head_name||null, vp_circulation_name: exec.vp_circulation_name||null },
    roles: ['circ_incharge'], subject: '', message: '',
  };
  st.emailResult = null;
  render();
};
window.epOpenEmail = (execCode, execName, hier) => {
  epState().emailCompose = { execCode, execName, hier, roles: ['circ_incharge'], subject: '', message: '' };
  epState().emailResult  = null;
  render();
};
window.epEmailRoleToggle = role => {
  const ec = epState().emailCompose;
  if (!ec) return;
  const idx = ec.roles.indexOf(role);
  if (idx >= 0) ec.roles.splice(idx, 1); else ec.roles.push(role);
  render();
};
window.epSendEmail = async () => {
  const st = epState();
  const ec = st.emailCompose;
  if (!ec || !ec.subject || !ec.message) { alert('Please fill subject and message'); return; }
  st.emailSending = true; render();
  try {
    const r = await api.post('/api/exec-perf/email', { exec_code: ec.execCode, to_roles: ec.roles, subject: ec.subject, message: ec.message });
    st.emailResult = r; st.emailSending = false; render();
  } catch (e) { st.emailSending = false; st.emailResult = { error: String(e) }; render(); }
};
window.epCloseEmail = () => { epState().emailCompose = null; epState().emailResult = null; render(); };

function epEmailModal() {
  const st = epState();
  const ec = st.emailCompose;
  if (!ec) return '';

  const ROLES = [
    { key: 'edtn_incharge',  label: 'Edition Incharge',   name: ec.hier?.edtn_incharge_name  },
    { key: 'circ_incharge',  label: 'Circ Incharge',      name: ec.hier?.circ_incharge_name  },
    { key: 'zonal_head',     label: 'Zonal Head',          name: ec.hier?.zonal_head_name     },
    { key: 'vp_circulation', label: 'VP Circulation',     name: ec.hier?.vp_circulation_name },
  ].filter(r => r.name);

  const result = st.emailResult;
  const sending= st.emailSending;

  return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)epCloseEmail()">
    <div class="card" style="width:100%;max-width:540px;padding:20px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-weight:800;font-size:16px">📧 Send Performance Alert</div>
          <div style="font-size:12px;color:var(--muted)">Executive: ${esc(ec.execName)}</div>
        </div>
        <button class="btn sm" onclick="epCloseEmail()" style="flex-shrink:0">✕ Close</button>
      </div>
      ${result ? (result.error
        ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#b91c1c;margin-bottom:12px">❌ ${esc(result.error || result.detail || 'Send failed')}</div>`
        : `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;font-size:13px;color:#166534;margin-bottom:12px">✅ Email sent to: ${(result.sent_to||[]).join(', ')}</div>`) : ''}
      ${ROLES.length ? `<div style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Send To</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${ROLES.map(r => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12.5px">
            <input type="checkbox" ${ec.roles.includes(r.key)?'checked':''} onchange="epEmailRoleToggle('${r.key}')">
            ${esc(r.label)}${r.name ? ` — <span style="color:var(--muted)">${esc(r.name)}</span>` : ''}
          </label>`).join('')}
        </div>
      </div>` : `<div style="color:var(--red);font-size:12px;margin-bottom:12px">⚠ Hierarchy not found for this executive</div>`}
      <div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Subject</div>
        <input class="inp" style="width:100%;box-sizing:border-box" placeholder="Subject…"
          value="${esc(ec.subject)}" oninput="epState().emailCompose.subject=this.value">
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Message</div>
        <textarea class="inp" style="width:100%;box-sizing:border-box;height:120px;resize:vertical" placeholder="Message…"
          oninput="epState().emailCompose.message=this.value">${esc(ec.message)}</textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn pri" onclick="epSendEmail()" ${sending?'disabled':''} style="flex:1">
          ${sending ? '⏳ Sending…' : '📨 Send Email'}
        </button>
        <button class="btn" onclick="epCloseEmail()">Cancel</button>
      </div>
    </div>
  </div>`;
}

// ── Growth Direction — per-executive signal ────────────────────────────────────
// Returns { label, color, bg, icon, flags } based on supply trend + collection % + field presence
function epGrowthDir(execCode, collPct) {
  const st    = epState();
  const gExec = (st.growth?.by_exec || []).find(r => r.executive_code === execCode);
  const dExec = (st.dcr?.by_exec    || []).find(r => r.emp_code       === execCode);

  let score = 0;
  const flags = [];

  // Supply growth signal
  if (gExec != null) {
    const pct = gExec.pct ?? 0;
    if      (pct >  5) score += 2;
    else if (pct >  0) score += 1;
    else if (pct < -5) { score -= 2; flags.push('supply ↓' + Math.abs(Math.round(pct)) + '%'); }
    else if (pct <  0) { score -= 1; flags.push('supply ↘'); }
  }

  // Collection % signal
  const cp = Number(collPct || 0);
  if      (cp >= 85) score += 2;
  else if (cp >= 65) score += 1;
  else if (cp <  40) { score -= 2; flags.push('coll ' + cp.toFixed(0) + '%'); }
  else if (cp <  65) { score -= 1; flags.push('coll ' + cp.toFixed(0) + '%'); }

  // Field presence (prev day)
  if      ( dExec?.active_today) score += 1;
  else if (dExec && !dExec.active_today) { score -= 1; flags.push('absent prev day'); }

  if (score >= 3)  return { label: 'On Track',  color: '#15803d', bg: '#dcfce7', icon: '↑' };
  if (score >= 1)  return { label: 'Good',       color: '#1d4ed8', bg: '#dbeafe', icon: '→' };
  if (score === 0) return { label: 'Watch',      color: '#92400e', bg: '#fef3c7', icon: '→', flags };
  if (score >= -2) return { label: 'Review',     color: '#b91c1c', bg: '#fee2e2', icon: '↓', flags };
                   return { label: 'Critical',   color: '#7f1d1d', bg: '#fecaca', icon: '↓↓', flags };
}

// ── Growth Intelligence Panel ──────────────────────────────────────────────────
function epGrowthIntelPanel() {
  const st = epState();
  if (!st.list || !st.growth || !st.dcr) return '';

  const rows = st.list?.rows || [];
  if (!rows.length) return '';

  let onTrack = 0, watch = 0, review = 0;
  for (const r of rows) {
    const d = epGrowthDir(r.executive_code, r.collection_pct);
    if (d.label === 'On Track' || d.label === 'Good') onTrack++;
    else if (d.label === 'Watch') watch++;
    else review++;
  }
  const total      = rows.length;
  const pctGood    = total > 0 ? Math.round(onTrack / total * 100) : 0;
  const barColor   = pctGood >= 70 ? '#15803d' : pctGood >= 50 ? '#d97706' : '#dc2626';
  const borderColor= pctGood >= 70 ? '#15803d' : pctGood >= 50 ? '#d97706' : '#dc2626';

  const allAlerts = st.alerts?.alerts || [];
  const noVisit   = allAlerts.find(a => a.key === 'no_visit_today');
  const declining = allAlerts.find(a => a.key === 'supply_declining');
  const neverVis  = allAlerts.find(a => a.key === 'never_visited');
  const osAlert   = allAlerts.find(a => a.key === 'os_outstanding');

  const insights = [];
  if (noVisit  ) insights.push({ icon: '❌', text: `${noVisit.count} executives absent from field prev day`,         color: 'var(--red)' });
  if (declining) insights.push({ icon: '📉', text: `${declining.count} executives with declining supply`,             color: '#92400e'    });
  if (neverVis ) insights.push({ icon: '🚫', text: `${neverVis.count} agencies never visited`,                       color: 'var(--red)' });
  if (osAlert  ) insights.push({ icon: '💰', text: `${osAlert.count} agencies carrying outstanding balance`,         color: '#92400e'    });

  return `<div class="card" style="padding:14px 16px;margin-bottom:12px;border-left:4px solid ${borderColor}">
    <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
      Growth Direction Intelligence · ${total} Executives
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div style="display:flex;gap:16px">
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:800;color:#15803d;line-height:1">${onTrack}</div>
          <div style="font-size:9.5px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-top:2px">On Track</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:800;color:#d97706;line-height:1">${watch}</div>
          <div style="font-size:9.5px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Watch</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:800;color:#dc2626;line-height:1">${review}</div>
          <div style="font-size:9.5px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Review</div>
        </div>
      </div>
      <div style="flex:1;min-width:140px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <div style="flex:1;height:7px;background:var(--brd2);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${pctGood}%;background:${barColor};border-radius:4px"></div>
          </div>
          <span style="font-size:12px;font-weight:800;color:${barColor}">${pctGood}%</span>
        </div>
        <div style="font-size:10.5px;color:var(--muted)">team on growth track</div>
      </div>
      ${insights.length ? `<div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:2px">
        ${insights.slice(0,3).map(ins => `<div style="font-size:11.5px;color:${ins.color}">${ins.icon} ${esc(ins.text)}</div>`).join('')}
      </div>` : `<div style="font-size:11.5px;color:#15803d">✅ No critical growth gaps for this view</div>`}
    </div>
  </div>`;
}

// ── Full executive table ───────────────────────────────────────────────────────
function epExecTable() {
  const st  = epState();
  const qs  = epQS({ sort: st.listSort, dir: st.listSortDir, search: st.listSearch, page: st.listPage, per_page: 50 });

  if (!st.list || st._listKey !== qs) {
    if (!st._loading.list) {
      st._loading.list = true; st._listKey = qs;
      api.get(epApi('list') + qs)
        .then(d => { epSnapshotFilters(); if (d) st.list = d; st._loading.list = false; if (S.screen === 'exec_perf') render(); })
        .catch(() => { st._loading.list = false; });
    }
    if (!st.list) return `<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Loading executives…</div>`;
  }

  const data  = st.list;
  const rows  = data.rows || [];
  const total = data.total || 0;
  const pages = data.total_pages || 1;
  const page  = st.listPage;
  const sort  = st.listSort;
  const dir   = st.listSortDir;

  const th = (col, label, right) => {
    const active  = sort === col;
    const nextDir = (active && dir === 'desc') ? 'asc' : 'desc';
    const arrow   = active ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
    return `<th${right ? ' class="r"' : ''} style="cursor:pointer;user-select:none;white-space:nowrap;${active ? 'color:var(--chart-1)' : ''}" onclick="epSortList('${col}','${nextDir}')">${label}${arrow}</th>`;
  };

  const pager = pages > 1
    ? `<div style="display:flex;gap:6px;margin:10px 16px;justify-content:center;align-items:center;flex-wrap:wrap">
         ${page > 1     ? `<button class="btn sm" onclick="epListPage(${page - 1})">← Prev</button>` : ''}
         <span style="font-size:12px;color:var(--muted)">Page ${page} of ${pages} · ${total} executives</span>
         ${page < pages ? `<button class="btn sm" onclick="epListPage(${page + 1})">Next →</button>` : ''}
       </div>`
    : `<div style="font-size:11px;color:var(--muted);margin:8px 16px">${total} executives</div>`;

  // Build DCR lookup and growth direction for each executive
  const dcrByExec = {};
  (st.dcr?.by_exec || []).forEach(r => { dcrByExec[r.emp_code] = r; });
  const hasDcr = !!st.dcr;

  return `<div class="card" style="overflow:hidden;margin-bottom:16px">
    <div style="padding:12px 16px;border-bottom:1px solid var(--brd2);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-weight:700;font-size:13px">Executive Scorecard</div>
        <div style="font-size:10.5px;color:var(--muted)">Direction = supply trend + collection % + field presence · Click row for detail</div>
      </div>
      <div style="flex:1;min-width:180px">
        <input class="inp" placeholder="Search executive or unit…" value="${esc(st.listSearch || '')}"
          style="font-size:12px;padding:5px 8px;width:100%" oninput="epSearchList(this.value)">
      </div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th style="width:28px">#</th>
            <th style="white-space:nowrap">Direction</th>
            ${th('exec_name',      'Executive',   false)}
            <th>Unit</th>
            <th style="text-align:center;white-space:nowrap">Yesterday</th>
            <th class="r" style="white-space:nowrap">Visits</th>
            ${th('agencies',       'Agencies',    true)}
            ${th('supply',         'Supply',      true)}
            ${th('collection_pct', 'Coll %',      true)}
            ${th('outstanding',    'Outstanding', true)}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const dcrRow = dcrByExec[r.executive_code];
            const dir    = epGrowthDir(r.executive_code, r.collection_pct);
            const dirChip = `<td style="white-space:nowrap">
              <div title="${dir.flags?.join(' · ') || dir.label}"
                   style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:10px;font-size:10.5px;font-weight:700;background:${dir.bg};color:${dir.color}">
                ${dir.icon} ${esc(dir.label)}
              </div>
            </td>`;
            const todayCell = !hasDcr ? '<td style="text-align:center;color:var(--muted)">—</td>'
              : dcrRow?.active_today
                ? '<td style="text-align:center;font-size:15px" title="Active prev day">✅</td>'
                : '<td style="text-align:center;font-size:15px" title="No activity prev day">❌</td>';
            const visitsCell = !hasDcr || !dcrRow
              ? '<td class="r" style="color:var(--muted)">—</td>'
              : `<td class="r" style="font-weight:600;color:${dcrRow.visits>0?'var(--chart-1)':'var(--red)'}">
                  ${dcrRow.visits}
                  ${dcrRow.agencies_visited ? `<div style="font-size:9.5px;color:var(--muted);font-weight:400">${dcrRow.agencies_visited} ag.</div>` : ''}
                </td>`;
            return `<tr class="rowbtn" onclick="epDrillExec('${esc(r.executive_code)}','${esc(r.exec_name || '')}')" style="${i % 2 ? 'background:var(--surface-2)' : ''}">
              <td style="color:var(--muted);font-size:11px">${r.rank || i + 1}</td>
              ${dirChip}
              <td>
                <div style="font-weight:600;font-size:13px">${esc(r.exec_name || '—')}</div>
                <div style="font-size:10.5px;color:var(--muted)">${esc(r.state_name || '')}${r.executive_code ? ' · ' + esc(r.executive_code) : ''}</div>
              </td>
              <td style="font-size:12px;color:var(--muted)">${esc(r.main_unit_name || r.units || '—')}</td>
              ${todayCell}
              ${visitsCell}
              <td class="r">${epFmtN(r.agency_count)}</td>
              <td class="r" style="font-weight:600">${epFmtN(r.total_supply)}</td>
              <td class="r" style="color:${epPctColor(r.collection_pct)};font-weight:700">${epPct(r.collection_pct)}</td>
              <td class="r" style="color:var(--red);font-weight:600">${epFmtC(r.total_outstanding)}</td>
            </tr>`;
          }).join('')}
          ${!rows.length ? `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--muted)">No executives found for this period / filter</td></tr>` : ''}
        </tbody>
      </table>
    </div>
    ${pager}
  </div>`;
}

// ── Main (list) view ──────────────────────────────────────────────────────────
function epMainView() {
  return pagehead('Executive Performance', 'Real picture of what the team is doing — direction toward growth · click any row to drill down') +
    epFilterPanel() + epTodayPulse() + epKpiGrid() + epGrowthIntelPanel() + epExecTable() +
    epAlertsSection() + epLastVisitSection() + epEmailModal();
}

// ── Executive detail view ─────────────────────────────────────────────────────
function epExecDetailView() {
  const st = epState();
  const data = st.drillExecData;

  const bc = `<div style="font-size:12px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span onclick="epHome()" style="cursor:pointer;color:var(--chart-1);font-weight:500">Executive Performance</span>
    <span style="color:var(--muted)">›</span>
    <span style="color:var(--ink);font-weight:700">${esc(st.drillExecName)}</span>
  </div>`;

  if (!data) return pagehead('Executive Performance', '') +
    `<button class="btn sm" onclick="epBack()" style="margin-bottom:12px">← Back</button>` + bc +
    `<div style="padding:24px;text-align:center;color:var(--muted)">Loading…</div>`;

  const { exec, agencies = [] } = data;
  const pct = exec.collection_pct || 0;

  const chain = [
    ['Edition Incharge',  exec.edtn_incharge_name,  exec.edtn_incharge],
    ['Circ Incharge',     exec.circ_incharge_name,  exec.circ_incharge],
    ['Zonal Head',        exec.zonal_head_name,      exec.zonal_head],
    ['VP Circulation',    exec.vp_circulation_name,  exec.vp_circulation],
  ].filter(([, name]) => name);

  // DCR data for this exec from the preloaded dcr state (if available)
  const dcrState = epState().dcr;
  const dcrExec  = dcrState?.by_exec?.find(r => r.emp_code === exec.executive_code);

  const execInfoCard = `<div class="card" style="padding:14px 16px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
    <div style="flex:1;min-width:180px">
      <div style="font-size:17px;font-weight:800;margin-bottom:2px">${esc(exec.exec_name || exec.executive_code)}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${esc(exec.exec_designation || exec.executive_code)} · ${esc(exec.units || exec.state_name || '')}</div>
      ${chain.length ? `<div style="font-size:11.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Reports To</div>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px">
        ${chain.map(([role, name], i) => `
          ${i > 0 ? '<span style="color:var(--muted);font-size:11px">›</span>' : ''}
          <div style="display:inline-flex;flex-direction:column;align-items:flex-start">
            <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${esc(role)}</span>
            <span style="font-size:12.5px;font-weight:600">${esc(name)}</span>
          </div>`).join('')}
      </div>` : ''}
      ${dcrExec ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px">
        <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Agency Visits</div><div style="font-size:15px;font-weight:700;color:var(--chart-1)">${dcrExec.visits}</div></div>
        <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Agencies Covered</div><div style="font-size:15px;font-weight:700">${dcrExec.agencies_visited}</div></div>
        <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Active Days</div><div style="font-size:15px;font-weight:700">${dcrExec.active_days}</div></div>
        <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Prev Day</div>
          <div style="font-size:13px;font-weight:700;color:${dcrExec.active_today?'var(--grn)':'var(--red)'}">
            ${dcrExec.active_today?'✅ Active':'❌ No Activity'}</div></div>
      </div>` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
      ${chain.length ? `<button class="btn sm" onclick="epOpenEmailFromDetail()">📧 Email Incharge/ZH</button>` : ''}
    </div>
  </div>`;

  // Field activity data — prefer fresh detail endpoint data, fallback to preloaded DCR state
  const totalVisits     = exec.total_visits     ?? dcrExec?.visits            ?? 0;
  const activeDays      = exec.active_days      ?? dcrExec?.active_days       ?? 0;
  const agenciesVisited = exec.agencies_visited ?? dcrExec?.agencies_visited  ?? 0;
  const agencyCovPct    = exec.agency_count > 0 ? Math.round(agenciesVisited / exec.agency_count * 100) : 0;
  const covColor        = agencyCovPct >= 80 ? 'var(--grn)' : agencyCovPct >= 50 ? '#d97706' : 'var(--red)';

  const kpis = `<div class="vz-kgrid" style="margin-bottom:12px">
    ${vzKpi({ icon: '🏢', label: 'Agencies',        value: epFmtN(exec.agency_count),       status: 'info', sub: esc(exec.units || '') })}
    ${vzKpi({ icon: '📦', label: 'Supply (Period)', value: epFmtN(exec.total_supply),        status: 'info', sub: `${esc(data.from)} – ${esc(data.to)}` })}
    ${vzKpi({ icon: '₹',  label: 'Collection',      value: epFmtC(exec.total_collection),    status: 'good', sub: 'Period total' })}
    ${vzKpi({ icon: '⚠',  label: 'Outstanding',     value: epFmtC(exec.total_outstanding),   status: pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad', sub: `${epPct(pct)} recovery rate` })}
  </div>`;

  // Field Activity Intelligence card
  const notVisited = agencies.filter(a => !a.visit_count && a.status === 'Active');
  const fieldCard = `<div class="card" style="padding:14px 16px;margin-bottom:12px">
    <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Field Activity — ${esc(data.from)} to ${esc(data.to)}</div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:10px">
      <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--chart-1)">${totalVisits}</div><div style="font-size:9.5px;color:var(--muted);font-weight:700;text-transform:uppercase">Total Visits</div></div>
      <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:var(--chart-1)">${activeDays}</div><div style="font-size:9.5px;color:var(--muted);font-weight:700;text-transform:uppercase">Active Days</div></div>
      <div style="flex:1;min-width:160px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <span style="font-size:11px;color:var(--muted)">Agency Coverage</span>
          <span style="font-size:12px;font-weight:800;color:${covColor}">${agenciesVisited}/${exec.agency_count} (${agencyCovPct}%)</span>
        </div>
        <div style="height:7px;background:var(--brd2);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${agencyCovPct}%;background:${covColor};border-radius:4px"></div>
        </div>
        ${notVisited.length > 0
          ? `<div style="font-size:10.5px;color:var(--red);margin-top:4px">⚠ ${notVisited.length} active agencies not visited this period</div>`
          : agenciesVisited > 0 ? `<div style="font-size:10.5px;color:var(--grn);margin-top:4px">✅ All active agencies covered</div>` : ''}
      </div>
    </div>
    ${notVisited.length > 0 ? `<div style="border-top:1px solid var(--brd2);padding-top:8px;margin-top:4px">
      <div style="font-size:10px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Not Visited This Period (${notVisited.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${notVisited.slice(0,12).map(a => `<span onclick="epDrillAgency('${esc(a.unit_code)}','${esc(a.ag_code)}','${esc(a.ag_name||'')}')"
          style="cursor:pointer;padding:2px 8px;border-radius:10px;background:#fee2e2;color:#b91c1c;font-size:10.5px;font-weight:600">
          ${esc(a.ag_name || a.ag_code)}${a.total_outstanding > 0 ? ' 💰' : ''}
        </span>`).join('')}
        ${notVisited.length > 12 ? `<span style="font-size:10.5px;color:var(--muted)">+${notVisited.length-12} more</span>` : ''}
      </div>
    </div>` : ''}
  </div>`;

  const agTable = `<div class="card" style="overflow:hidden">
    <div style="padding:12px 16px;border-bottom:1px solid var(--brd2);display:flex;align-items:center;gap:8px">
      <div style="font-weight:700;font-size:13px">Agencies (${agencies.length})</div>
      <div style="font-size:10.5px;color:var(--muted)">Visits = field visits in selected period · Click row for agency detail</div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th style="width:32px">#</th>
            <th>Agency</th>
            <th>City</th>
            <th class="r" style="white-space:nowrap">Visits</th>
            <th class="r" style="white-space:nowrap">Last Visit</th>
            <th class="r">Supply</th>
            <th class="r">Coll %</th>
            <th class="r">Outstanding</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${agencies.map((a, i) => {
            const visitColor = a.visit_count > 0 ? 'var(--chart-1)' : a.status === 'Active' ? 'var(--red)' : 'var(--muted)';
            const lastVisitText = a.last_visit
              ? esc(a.last_visit)
              : a.status === 'Active' ? '<span style="color:var(--red);font-weight:700">Never</span>' : '—';
            return `<tr class="rowbtn" onclick="epDrillAgency('${esc(a.unit_code)}','${esc(a.ag_code)}','${esc(a.ag_name || '')}')" style="${i % 2 ? 'background:var(--surface-2)' : ''}">
              <td style="color:var(--muted);font-size:11px">${i + 1}</td>
              <td>
                <div style="font-weight:600;font-size:12.5px">${esc(a.ag_name || '—')}</div>
                <div style="font-size:10.5px;color:var(--muted)">${esc(a.ag_type_name || '')} · ${esc(a.ag_code)}</div>
              </td>
              <td style="font-size:11.5px;color:var(--muted)">${esc(a.city_name || '—')}</td>
              <td class="r" style="font-weight:700;color:${visitColor}">${a.visit_count || (a.status === 'Active' ? '0' : '—')}</td>
              <td class="r" style="font-size:11px">${lastVisitText}</td>
              <td class="r" style="font-weight:600">${epFmtN(a.total_supply)}</td>
              <td class="r" style="color:${epPctColor(a.collection_pct)};font-weight:700">${epPct(a.collection_pct)}</td>
              <td class="r" style="color:var(--red);font-weight:600">${epFmtC(a.total_outstanding)}</td>
              <td><span class="chip ${a.status === 'Active' ? 'good' : a.status === 'Suspended' ? 'crit' : 'warn'}" style="font-size:9.5px">${esc(a.status)}</span></td>
            </tr>`;
          }).join('')}
          ${!agencies.length ? `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted)">No agencies found</td></tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;

  return pagehead('Executive Performance', '') +
    `<button class="btn sm" onclick="epBack()" style="margin-bottom:10px">← Back</button>` +
    bc + execInfoCard + kpis + fieldCard + agTable + epEmailModal();
}

// ── Agency detail view ────────────────────────────────────────────────────────
function epAgencyDetailView() {
  const st   = epState();
  const data = st.drillAgencyData;

  const bc = `<div style="font-size:12px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span onclick="epHome()" style="cursor:pointer;color:var(--chart-1);font-weight:500">Executive Performance</span>
    <span style="color:var(--muted)">›</span>
    <span onclick="epBack()" style="cursor:pointer;color:var(--chart-1);font-weight:500">${esc(st.drillExecName)}</span>
    <span style="color:var(--muted)">›</span>
    <span style="color:var(--ink);font-weight:700">${esc(st.drillAgencyName)}</span>
  </div>`;

  if (!data) return pagehead('Executive Performance', '') +
    `<button class="btn sm" onclick="epBack()" style="margin-bottom:12px">← Back</button>` + bc +
    `<div style="padding:24px;text-align:center;color:var(--muted)">Loading…</div>`;

  const { agency: ag, metrics: m, supply_history = [], collection_history = [] } = data;
  const pct = m.collection_pct || 0;

  const infoCard = `<div class="card" style="padding:16px;margin-bottom:12px">
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <div style="flex:1;min-width:200px">
        <div style="font-size:16px;font-weight:800;margin-bottom:3px">${esc(ag.ag_name || '—')}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${esc(ag.ag_type_name || '')}${ag.ag_class_name ? ' · ' + esc(ag.ag_class_name) : ''}</div>
        <div style="display:flex;flex-wrap:wrap;gap:16px">
          ${[
            ['Unit',      ag.unit_name || ag.unit_code],
            ['City',      ag.city_name || ag.dist_name || '—'],
            ['Mobile',    ag.mobile_no1 || '—'],
            ['Executive', ag.executive_name || ag.executive_code || '—'],
            ['Supply Start', ag.supply_start_dt || '—'],
          ].map(([lbl, val]) => `<div>
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${lbl}</div>
            <div style="font-size:13px;font-weight:600">${esc(String(val))}</div>
          </div>`).join('')}
        </div>
      </div>
      <span class="chip ${ag.status === 'Active' ? 'good' : ag.status === 'Suspended' ? 'crit' : 'warn'}" style="font-size:12px;padding:4px 12px">${esc(ag.status)}</span>
    </div>
  </div>`;

  const kpis = `<div class="vz-kgrid" style="margin-bottom:16px">
    ${vzKpi({ icon: '📦', label: 'Supply (Period)',   value: epFmtN(m.total_supply),       status: 'info', sub: `Avg ${epFmtN(m.avg_daily_supply)} copies/day` })}
    ${vzKpi({ icon: '₹',  label: 'Collection',        value: epFmtC(m.total_collection),   status: 'good', sub: `${epFmtN(m.txn_count)} txn · Last: ${m.last_coll_date || '—'}` })}
    ${vzKpi({ icon: '📊', label: 'Recovery %',        value: epPct(pct),                   status: pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad', sub: 'collection ÷ (collection + outstanding)' })}
    ${vzKpi({ icon: '⚠',  label: 'Outstanding (Net)', value: epFmtC(m.total_outstanding),  status: m.total_outstanding > 0 ? 'bad' : 'good', sub: `Bill: ${epFmtC(m.bill_amt)} · Rec: ${epFmtC(m.rec_amt)}` })}
  </div>`;

  const histRow = (rows, cols, buildRow) => rows.length ? `<div style="overflow-x:auto"><table>
    <thead><tr>${cols.map(([l, r]) => `<th${r ? ' class="r"' : ''}>${l}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr style="${i % 2 ? 'background:var(--surface-2)' : ''}">${buildRow(r)}</tr>`).join('')}</tbody>
  </table></div>` : `<div style="padding:16px;color:var(--muted);font-size:12px;text-align:center">No data</div>`;

  const supHist = `<div class="card" style="overflow:hidden;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--brd2);font-weight:700;font-size:13px">Supply History — Last 6 Months</div>
    ${histRow(supply_history,
      [['Month', false], ['Supply Days', true], ['Total Supply', true], ['Avg / Day', true]],
      r => `<td style="font-weight:600">${esc(r.month)}</td><td class="r">${epFmtN(r.supply_days)}</td><td class="r" style="font-weight:600">${epFmtN(r.total_supply)}</td><td class="r" style="color:var(--muted)">${r.supply_days > 0 ? epFmtN(Math.round(Number(r.total_supply) / Number(r.supply_days))) : '—'}</td>`
    )}
  </div>`;

  const colHist = `<div class="card" style="overflow:hidden;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--brd2);font-weight:700;font-size:13px">Collection History — Last 6 Months</div>
    ${histRow(collection_history,
      [['Month', false], ['Transactions', true], ['Amount Collected', true]],
      r => `<td style="font-weight:600">${esc(r.month)}</td><td class="r" style="color:var(--muted)">${epFmtN(r.txn_count)}</td><td class="r" style="color:var(--grn);font-weight:600">${epFmtC(r.total_collection)}</td>`
    )}
  </div>`;

  return pagehead('Executive Performance', '') +
    `<button class="btn sm" onclick="epBack()" style="margin-bottom:10px">← Back</button>` +
    bc + infoCard + kpis + supHist + colHist;
}

// ── VIEWS entry ───────────────────────────────────────────────────────────────
VIEWS.exec_perf = () => {
  const st = epState();
  if (st.drillAgency) return epAgencyDetailView();
  if (st.drillExec)   return epExecDetailView();
  return epMainView();
};

/* ════════════════════════════════════════════════════════
   MONTHLY TARGET MANAGEMENT
   ════════════════════════════════════════════════════════ */

const etState = () => S.live.et || (S.live.et = {
  filters:      { month_year: '', state: '', unit_code: '' },
  filterOpts:   null,
  // unit-wise target entry: { unitCode: { supply_copies:'', collection:'', agency_visits:'', attendance_days:'' } }
  unitTargets:  {},
  targetsLoaded: false,
  achievement:  null,
  tab:          'entry',   // 'entry' | 'achievement'
  saving:       {},        // { unitCode: true }
  saved:        {},        // { unitCode: true } flash feedback
  saveError:    '',
  drill:        null,      // { unit_code, unit_name } — unit being drilled in achievement tab
  drillExecs:   null,      // exec data from /api/exec-perf/list for drilled unit
  _loading:     {},
});

const etApi  = p => `/api/targets/${p}`;
const etFmtN = v => (!v && v !== 0) ? '—' : Number(v).toLocaleString('en-IN');
const etFmtC = v => {
  if (!v && v !== 0) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e7) return '₹' + (n/1e7).toFixed(2) + ' Cr';
  if (Math.abs(n) >= 1e5) return '₹' + (n/1e5).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};
const etPct = v => (!v && v !== 0) ? '—' : Number(v).toFixed(1) + '%';
const etScoreColor = s => s >= 100 ? 'var(--grn)' : s >= 80 ? '#f59e0b' : s >= 60 ? '#f97316' : 'var(--red)';
const etScoreBg    = s => s >= 100 ? '#dcfce7'    : s >= 80 ? '#fef9c3'  : s >= 60 ? '#ffedd5'  : '#fee2e2';

function etLoadFilters() {
  const st = etState();
  if (st.filterOpts || st._loading.filters) return;
  st._loading.filters = true;
  api.get(etApi('filters')).then(d => {
    st.filterOpts = d;
    // Default state to first available if not set
    if (!st.filters.state && d.states?.length) st.filters.state = d.states[0];
    st._loading.filters = false;
    if (S.screen === 'exec_targets') render();
  }).catch(() => { st._loading.filters = false; });
}

function etLoadTargets() {
  const st = etState();
  const f  = st.filters;
  if (!f.state && !f.unit_code) { st.unitTargets = {}; st.targetsLoaded = true; return; }
  const qs = '?' + new URLSearchParams(Object.fromEntries(
    Object.entries({ month_year: f.month_year || currentMonthYear(), state: f.state, unit_code: f.unit_code }).filter(([, v]) => v)
  )).toString();
  st._loading.targets = true;
  api.get(etApi('list') + qs).then(d => {
    const st2 = etState();
    // Pre-fill form inputs from saved targets, keeping unsaved edits
    const saved = {};
    for (const u of (d.units || [])) saved[u.unit_code] = { ...u.targets };
    // Merge: saved values win, but preserve any in-flight edits not yet synced
    st2.unitTargets = saved;
    st2.targetsLoaded = true;
    st2._loading.targets = false;
    if (S.screen === 'exec_targets') render();
  }).catch(() => { etState()._loading.targets = false; });
}

function etLoadAchievement() {
  const st = etState();
  const f  = st.filters;
  const qs = '?' + new URLSearchParams(Object.fromEntries(
    Object.entries({ month_year: f.month_year || currentMonthYear(), state: f.state, unit_code: f.unit_code }).filter(([, v]) => v)
  )).toString();
  st._loading.achievement = true; st.achievement = null;
  api.get(etApi('achievement') + qs).then(d => {
    const s = etState(); s.achievement = d; s._loading.achievement = false;
    if (S.screen === 'exec_targets') render();
  }).catch(() => { etState()._loading.achievement = false; });
}

window.etSetTab = tab => {
  const st = etState(); st.tab = tab;
  if (tab === 'achievement') etLoadAchievement();
  render();
};
window.etStateChange = v => {
  const st = etState();
  st.filters.state = v; st.filters.unit_code = '';
  st.unitTargets = {}; st.targetsLoaded = false; st.achievement = null;
  render();
};
window.etUnitChange = v => {
  const st = etState();
  st.filters.unit_code = v;
  st.unitTargets = {}; st.targetsLoaded = false; st.achievement = null;
  render();
};
window.etMonthChange = v => {
  const st = etState();
  st.filters.month_year = v;
  st.unitTargets = {}; st.targetsLoaded = false; st.achievement = null;
  if (st.tab === 'achievement') etLoadAchievement();
  render();
};
window.etFieldChange = (unitCode, field, value) => {
  const st = etState();
  if (!st.unitTargets[unitCode]) st.unitTargets[unitCode] = {};
  st.unitTargets[unitCode][field] = value;
};
window.etSaveUnit = async (unitCode, stateName) => {
  const st = etState();
  const my = st.filters.month_year || currentMonthYear();
  st.saving[unitCode] = true; st.saveError = ''; render();
  try {
    await api.post('/api/targets', {
      unit_code: unitCode, state_code: stateName, month_year: my,
      targets: st.unitTargets[unitCode] || {},
    });
    st.saving[unitCode] = false; st.saved[unitCode] = true;
    st.achievement = null; render();
    setTimeout(() => { etState().saved[unitCode] = false; render(); }, 2500);
  } catch (e) {
    st.saving[unitCode] = false; st.saveError = String(e); render();
  }
};
window.etSaveAll = async () => {
  const st    = etState();
  const units = etVisibleUnits();
  for (const u of units) {
    if (!st.saving[u.unit_code]) await window.etSaveUnit(u.unit_code, st.filters.state);
  }
};
window.etRefreshAchievement = () => { etState().achievement = null; etLoadAchievement(); };

// ── Achievement tab drill-down: unit → executives ─────────────────────────────
window.etDrillUnit = (unitCode, unitName) => {
  const st  = etState();
  const row = (st.achievement?.results || []).find(r => r.unit_code === unitCode) || null;
  st.drill      = { unit_code: unitCode, unit_name: unitName, row };
  st.drillExecs = null;
  const f  = st.filters;
  const my = f.month_year || currentMonthYear();
  const from = my + '-01';
  const [y, m] = my.split('-').map(Number);
  const to = my === currentMonthYear() ? todayISO() : new Date(y, m, 0).toISOString().slice(0, 10);
  api.get(`/api/exec-perf/list?unit_code=${encodeURIComponent(unitCode)}&from=${from}&to=${to}&per_page=100&sort=collection&dir=desc`)
    .then(d => { const s2 = etState(); s2.drillExecs = d; if (S.screen === 'exec_targets') render(); })
    .catch(() => {});
  render();
};
window.etDrillBack = () => { const st = etState(); st.drill = null; st.drillExecs = null; render(); };

function currentMonthYear() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Returns the list of units to show in entry/achievement based on current state/unit filter
function etVisibleUnits() {
  const st   = etState();
  const f    = st.filters;
  const opts = st.filterOpts || { units: [] };
  let units  = opts.units || [];
  if (f.state)     units = units.filter(u => u.state_nm === f.state);
  if (f.unit_code) units = units.filter(u => u.unit_code === f.unit_code);
  return units;
}

function etMonthLabel(my) {
  const [y, mo] = (my || currentMonthYear()).split('-');
  return ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)] + ' ' + y;
}

function etFilterBar() {
  const st   = etState();
  const f    = st.filters;
  const opts = st.filterOpts || { states: [], units: [], months: [] };

  if (!st.filterOpts) etLoadFilters();

  const months   = opts.months?.length ? opts.months : [currentMonthYear()];
  const selMy    = f.month_year || currentMonthYear();
  const visUnits = f.state ? (opts.units || []).filter(u => u.state_nm === f.state) : (opts.units || []);

  return `<div class="card" style="padding:10px 14px;margin-bottom:12px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <select class="inp" style="font-size:12px;padding:5px 8px" onchange="etMonthChange(this.value)">
        ${months.map(m => `<option value="${esc(m)}" ${selMy===m?'selected':''}>${etMonthLabel(m)}</option>`).join('')}
      </select>
      <select class="inp" style="font-size:12px;padding:5px 8px" onchange="etStateChange(this.value)">
        <option value="">— Select State —</option>
        ${(opts.states || []).map(s => `<option value="${esc(s)}" ${f.state===s?'selected':''}>${esc(s)}</option>`).join('')}
      </select>
      <select class="inp" style="font-size:12px;padding:5px 8px" onchange="etUnitChange(this.value)" ${!f.state?'disabled':''}>
        <option value="">${f.state ? 'All Units in ' + esc(f.state) : '— Select State first —'}</option>
        ${visUnits.map(u => `<option value="${esc(u.unit_code)}" ${f.unit_code===u.unit_code?'selected':''}>${esc(u.unit_name)}</option>`).join('')}
      </select>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn${st.tab==='entry'?' pri':''} sm" onclick="etSetTab('entry')">📝 Entry</button>
        <button class="btn${st.tab==='achievement'?' pri':''} sm" onclick="etSetTab('achievement')">📊 Achievement</button>
      </div>
    </div>
  </div>`;
}

// Returns visible units based on current state/unit filter
function etVisibleUnits() {
  const st   = etState();
  const f    = st.filters;
  const opts = st.filterOpts || { units: [] };
  let units  = opts.units || [];
  if (f.state)     units = units.filter(u => u.state_nm === f.state);
  if (f.unit_code) units = units.filter(u => u.unit_code === f.unit_code);
  return units;
}

function etEntryTab() {
  const st    = etState();
  const f     = st.filters;
  const my    = f.month_year || currentMonthYear();
  const units = etVisibleUnits();

  if (f.state && !st.targetsLoaded && !st._loading.targets) etLoadTargets();

  if (!f.state) {
    return `<div class="card" style="padding:32px;text-align:center;color:var(--muted)">
      <div style="font-size:36px;margin-bottom:8px">🗺</div>
      <div style="font-weight:700;margin-bottom:4px">Select a State to enter targets</div>
      <div style="font-size:12px">Choose Rajasthan, MP, CG, or National from the filter above</div>
    </div>`;
  }

  const COLS = [
    { key: 'supply_copies',   label: 'Target Copies',  ph: 'e.g. 450000',  w: '130px' },
    { key: 'collection',      label: 'Collection (₹)', ph: 'e.g. 2500000', w: '140px' },
    { key: 'agency_visits',   label: 'Agency Visits',  ph: 'e.g. 800',     w: '110px' },
    { key: 'attendance_days', label: 'Man-Days',        ph: 'e.g. 520',     w: '100px' },
  ];

  const unitRow = u => {
    const uc       = u.unit_code;
    const tgts     = st.unitTargets[uc] || {};
    const isSaving = !!st.saving[uc];
    const isSaved  = !!st.saved[uc];
    return `<tr style="${isSaved ? 'background:#f0fdf4' : ''}">
      <td style="font-weight:600;font-size:12.5px;white-space:nowrap;min-width:140px">
        ${esc(u.unit_name || u.unit_code)}
        <div style="font-size:10px;color:var(--muted)">${esc(u.unit_code)}</div>
      </td>
      ${COLS.map(c => `<td style="padding:5px 6px">
        <input type="number" class="inp" style="width:${c.w};font-size:12px;padding:4px 7px"
          placeholder="${esc(c.ph)}"
          value="${tgts[c.key] != null ? tgts[c.key] : ''}"
          oninput="etFieldChange('${esc(uc)}','${c.key}',this.value)">
      </td>`).join('')}
      <td style="white-space:nowrap;padding:5px 8px">
        <button class="btn pri sm" onclick="etSaveUnit('${esc(uc)}','${esc(f.state)}')" ${isSaving?'disabled':''}>
          ${isSaving ? '⏳' : isSaved ? '✅ Saved' : '💾 Save'}
        </button>
      </td>
    </tr>`;
  };

  return `<div class="card" style="overflow:hidden">
    <div style="padding:10px 14px;border-bottom:1px solid var(--brd2);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="font-weight:700;font-size:13px">
        Monthly Targets — ${etMonthLabel(my)}
        <span style="font-weight:400;color:var(--muted)"> · ${esc(f.state)}${f.unit_code ? ' · ' + esc(units[0]?.unit_name || f.unit_code) : ''}</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        ${st.saveError ? `<span style="color:var(--red);font-size:11px">⚠ ${esc(st.saveError)}</span>` : ''}
        <button class="btn sm" onclick="etSaveAll()">💾 Save All</button>
        <button class="btn sm" onclick="etState().unitTargets={};etState().targetsLoaded=false;render()">↺ Reload</button>
      </div>
    </div>
    ${st._loading.targets
      ? `<div style="padding:32px;text-align:center;color:var(--muted)">Loading saved targets…</div>`
      : units.length === 0
        ? `<div style="padding:32px;text-align:center;color:var(--muted)">No units found for selected filter</div>`
        : `<div style="overflow-x:auto">
            <table>
              <thead><tr>
                <th style="white-space:nowrap">Branch / Unit</th>
                ${COLS.map(c => `<th style="white-space:nowrap">${esc(c.label)}</th>`).join('')}
                <th></th>
              </tr></thead>
              <tbody>${units.map(unitRow).join('')}</tbody>
            </table>
          </div>`}
  </div>`;
}

function etAchievementTab() {
  const st = etState();
  if (!st.achievement && !st._loading.achievement) etLoadAchievement();
  if (st._loading.achievement || !st.achievement) {
    return `<div style="padding:40px;text-align:center;color:var(--muted)">Loading achievement data…</div>`;
  }

  const { results = [], month_year: my, day_in_month, days_total } = st.achievement;
  const isCurrent = my === currentMonthYear();
  const moLabel   = etMonthLabel(my);

  const pBar = (actual, target, color) => {
    if (!target) return `<div style="color:var(--muted);font-size:11px">No target</div>`;
    const pct = Math.min(Math.round(actual / target * 100), 999);
    return `<div style="display:flex;align-items:center;gap:4px">
      <div style="flex:1;height:5px;background:var(--brd2);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};border-radius:3px"></div>
      </div>
      <span style="font-size:10px;color:${color};font-weight:700;width:34px;text-align:right">${pct}%</span>
    </div>`;
  };

  const unitRow = (r, idx) => {
    const a  = r.actuals     || {};
    const t  = r.targets     || {};
    const p  = r.pacing;
    const sc = r.overall_score;
    const safeName = (r.unit_name || r.unit_code).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<tr class="rowbtn" onclick="etDrillUnit('${esc(r.unit_code)}','${safeName}')" style="cursor:pointer;${idx % 2 ? 'background:var(--surface-2)' : ''}">
      <td style="font-weight:600;font-size:12.5px;white-space:nowrap;min-width:130px">
        <span style="color:var(--chart-1)">${esc(r.unit_name || r.unit_code)}</span>
        <div style="font-size:10px;color:var(--muted)">${esc(r.unit_code)} · click to drill ›</div>
      </td>
      <td style="min-width:140px">
        <div style="font-size:12px;font-weight:600">${etFmtN(a.supply_curr)}</div>
        <div style="font-size:10px;color:var(--muted)">Tgt: ${etFmtN(t.supply_copies)} · Prev: ${etFmtN(a.supply_prev)}</div>
        ${pBar(a.supply_curr || 0, t.supply_copies, '#22c55e')}
        ${a.growth_pct != null ? `<div style="font-size:10px;color:${a.growth_pct>=0?'var(--grn)':'var(--red)'}">${a.growth_pct>=0?'+':''}${etPct(a.growth_pct)} vs prev</div>` : ''}
        ${p && t.supply_copies ? `<div style="font-size:10px;color:var(--muted)">Proj: ${etFmtN(p.projected_supply)}</div>` : ''}
      </td>
      <td style="min-width:140px">
        <div style="font-size:12px;font-weight:600">${etFmtC(a.collection)}</div>
        <div style="font-size:10px;color:var(--muted)">Tgt: ${etFmtC(t.collection)}</div>
        ${pBar(a.collection || 0, t.collection, '#6366f1')}
        ${p && t.collection ? `<div style="font-size:10px;color:var(--muted)">Proj: ${etFmtC(p.projected_collection)}</div>` : ''}
      </td>
      <td style="min-width:120px">
        <div style="font-size:12px;font-weight:600">${etFmtN(a.agency_visits)}</div>
        <div style="font-size:10px;color:var(--muted)">Tgt: ${etFmtN(t.agency_visits)}</div>
        ${pBar(a.agency_visits || 0, t.agency_visits, '#f59e0b')}
      </td>
      <td style="min-width:110px">
        <div style="font-size:12px;font-weight:600">${etFmtN(a.attendance_days)} days</div>
        <div style="font-size:10px;color:var(--muted)">Tgt: ${etFmtN(t.attendance_days)}</div>
        ${pBar(a.attendance_days || 0, t.attendance_days, '#8b5cf6')}
      </td>
      <td style="text-align:center;width:54px">
        ${sc != null
          ? `<div style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:${etScoreBg(sc)};color:${etScoreColor(sc)};font-weight:800;font-size:13px">${sc}</div>`
          : `<span style="color:var(--muted);font-size:11px">—</span>`}
      </td>
      ${isCurrent && p
        ? `<td style="font-size:10.5px;color:var(--muted);white-space:nowrap">Day ${p.days_done}/${p.days_in_month}<br>${p.pct_days_done}% done</td>`
        : `<td style="color:var(--muted);font-size:11px">—</td>`}
      <td>${r.has_targets ? '' : '<span style="font-size:10.5px;color:var(--red)">No target</span>'}</td>
    </tr>`;
  };

  const noTarget = results.filter(r => !r.has_targets).length;

  return `<div>
    ${isCurrent && day_in_month ? `<div class="card" style="padding:10px 16px;margin-bottom:10px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Month Progress</div>
        <div style="font-size:14px;font-weight:700">${moLabel}</div>
      </div>
      <div style="flex:1;min-width:160px">
        <div style="height:8px;background:var(--brd2);border-radius:4px;overflow:hidden;margin-bottom:3px">
          <div style="height:100%;width:${Math.round(day_in_month/days_total*100)}%;background:var(--chart-1);border-radius:4px"></div>
        </div>
        <div style="font-size:11px;color:var(--muted)">Day ${day_in_month} of ${days_total} · ${Math.round(day_in_month/days_total*100)}% month complete</div>
      </div>
      ${noTarget > 0 ? `<div style="color:var(--red);font-size:12px">⚠ ${noTarget} unit${noTarget>1?'s':''} without targets</div>` : ''}
      <button class="btn sm" onclick="etRefreshAchievement()">↺ Refresh</button>
    </div>` : ''}
    <div class="card" style="overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--brd2);font-weight:700;font-size:13px">
        Target vs Achievement — ${moLabel} (${results.length} units)
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Branch / Unit</th>
            <th>Supply Copies</th>
            <th>Collection</th>
            <th>Agency Visits</th>
            <th>Man-Days</th>
            <th style="width:54px;text-align:center">Score</th>
            <th>${isCurrent ? 'Pace' : ''}</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${results.length
              ? results.map((r, i) => unitRow(r, i)).join('')
              : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted)">No data. Select a state above.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// ── Unit drill-down view (Achievement → Executives) ───────────────────────────
function etUnitDetailView() {
  const st = etState();
  const { unit_code, unit_name, row } = st.drill;
  const a  = (row && row.actuals) || {};
  const t  = (row && row.targets) || {};
  const sc = row && row.overall_score;
  const f  = st.filters;
  const my = f.month_year || currentMonthYear();

  const pBarMini = (actual, target, color) => {
    if (!target) return '';
    const pct = Math.min(Math.round(actual / target * 100), 100);
    return `<div style="height:4px;background:var(--brd2);border-radius:2px;overflow:hidden;margin-top:3px;width:70px">
      <div style="height:100%;width:${pct}%;background:${color}"></div>
    </div>`;
  };

  const bc = `<div style="font-size:12px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <span onclick="etDrillBack()" style="cursor:pointer;color:var(--chart-1);font-weight:500">Monthly Targets</span>
    <span style="color:var(--muted)">›</span>
    <span style="color:var(--ink);font-weight:700">${esc(unit_name)}</span>
  </div>`;

  const unitSummary = `<div class="card" style="padding:14px 16px;margin-bottom:12px">
    <div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px;margin-bottom:12px">
      <div style="flex:1;min-width:160px">
        <div style="font-size:17px;font-weight:800">${esc(unit_name)}</div>
        <div style="font-size:11px;color:var(--muted)">${esc(unit_code)} · ${etMonthLabel(my)}</div>
      </div>
      ${sc != null ? `<div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:${etScoreBg(sc)};color:${etScoreColor(sc)};font-weight:800;font-size:16px">Score<br style="display:none">${sc}</div>` : ''}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:20px">
      <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Supply Copies</div>
        <div style="font-size:16px;font-weight:700">${etFmtN(a.supply_curr)}</div>
        <div style="font-size:10px;color:var(--muted)">Target: ${etFmtN(t.supply_copies)}</div>
        ${pBarMini(a.supply_curr||0, t.supply_copies, '#22c55e')}</div>
      <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Collection</div>
        <div style="font-size:16px;font-weight:700">${etFmtC(a.collection)}</div>
        <div style="font-size:10px;color:var(--muted)">Target: ${etFmtC(t.collection)}</div>
        ${pBarMini(a.collection||0, t.collection, '#6366f1')}</div>
      <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Agency Visits</div>
        <div style="font-size:16px;font-weight:700">${etFmtN(a.agency_visits)}</div>
        <div style="font-size:10px;color:var(--muted)">Target: ${etFmtN(t.agency_visits)}</div>
        ${pBarMini(a.agency_visits||0, t.agency_visits, '#f59e0b')}</div>
      <div><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Man-Days</div>
        <div style="font-size:16px;font-weight:700">${etFmtN(a.attendance_days)}</div>
        <div style="font-size:10px;color:var(--muted)">Target: ${etFmtN(t.attendance_days)}</div>
        ${pBarMini(a.attendance_days||0, t.attendance_days, '#8b5cf6')}</div>
    </div>
  </div>`;

  const execData = st.drillExecs;
  let execCard = '';
  if (!execData) {
    execCard = `<div class="card" style="padding:32px;text-align:center;color:var(--muted)">Loading executives for ${esc(unit_name)}…</div>`;
  } else {
    const rows = execData.rows || [];
    execCard = `<div class="card" style="overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--brd2)">
        <div style="font-weight:700;font-size:13px">Executives — ${esc(unit_name)} (${rows.length})</div>
        <div style="font-size:10.5px;color:var(--muted)">Supply · Collection · Outstanding for ${etMonthLabel(my)}</div>
      </div>
      <div style="overflow-x:auto"><table>
        <thead><tr>
          <th style="width:28px">#</th>
          <th>Executive</th>
          <th class="r">Agencies</th>
          <th class="r">Supply</th>
          <th class="r">Collection</th>
          <th class="r">Coll %</th>
          <th class="r">Outstanding</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map((r, i) => `<tr style="${i%2?'background:var(--surface-2)':''}">
            <td style="color:var(--muted);font-size:11px">${i+1}</td>
            <td>
              <div style="font-weight:600;font-size:13px">${esc(r.exec_name||'—')}</div>
              <div style="font-size:10.5px;color:var(--muted)">${esc(r.executive_code)}</div>
            </td>
            <td class="r">${etFmtN(r.agency_count)}</td>
            <td class="r" style="font-weight:600">${etFmtN(r.total_supply)}</td>
            <td class="r" style="color:var(--grn);font-weight:600">${etFmtC(r.total_collection)}</td>
            <td class="r" style="color:${etScoreColor(r.collection_pct||0)};font-weight:700">${etPct(r.collection_pct)}</td>
            <td class="r" style="color:var(--red);font-weight:600">${etFmtC(r.total_outstanding)}</td>
          </tr>`).join('')
          : `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">No executive data found for this unit/period</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
  }

  return pagehead('Monthly Targets', '') +
    `<button class="btn sm" onclick="etDrillBack()" style="margin-bottom:10px">← Back to Units</button>` +
    bc + unitSummary + execCard;
}

VIEWS.exec_targets = () => {
  const st = etState();
  if (st.drill) return etUnitDetailView();
  return pagehead('Monthly Targets', 'State → branch level targets · supply copies · collection · visits · man-days') +
    etFilterBar() +
    (st.tab === 'achievement' ? etAchievementTab() : etEntryTab());
};

/* ════════════════════════════════════════════════════════
   SHORT PAYMENT / BILL-WISE COLLECTION REPORT
   ════════════════════════════════════════════════════════ */

const spApi = path => `${location.origin}/api/shortpayment/${path}`;

const spState = () => S.live.sp || (S.live.sp = {
  fromMonth: '', toMonth: '',
  availMonths: null,
  filterOpts: null,   // loaded once from /api/outstanding/filters
  filters: _isPanIndiaAdmin() ? { state: 'RPPL', unit_code: 'JA0', zh_name: '', ag_status: '', payment_status: '' } : { state: '', unit_code: '', zh_name: '', ag_status: '', payment_status: '' },
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
    .then(d => { sp.data = d; sp._loading = false; if (_spVisible()) render(); })
    .catch(() => { sp._loading = false; if (_spVisible()) render(); });
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

/* ════════════════════════════════════════════════════════
   AGENCY RATING ENGINE
   ════════════════════════════════════════════════════════ */

const arApi = p => `/api/agency-rating/${p}`;

const arState = () => S.live.ar || (S.live.ar = {
  // filters
  state: _isPanIndiaAdmin() ? 'RAJASTHAN' : '', unit_code: _isPanIndiaAdmin() ? 'JA0' : '', grade: '', search: '', exec: '',
  sort: 'composite', dir: 'desc', page: 1,
  // data
  summary: null, list: null, filters: null, config: null,
  // detail drill-down
  drillAgency: null,   // { unit_code, ag_code, ag_name }
  detail: null,
  // scoring panel
  showFormula: true,
  draftBW: null,       // draft business weight (0-100 integer)
  draftThresholds: null,
  // loading flags
  _loading: {}, _error: {},
});

function arInrLakh(v) {
  const n = Math.abs(Number(v));
  if (n >= 1e7) return (n < 0 ? '-' : '') + '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n < 0 ? '-' : '') + '₹' + (n / 1e5).toFixed(2) + ' L';
  return (v < 0 ? '-' : '') + '₹' + Math.abs(Math.round(Number(v))).toLocaleString('en-IN');
}
function arInr(v) { return '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN'); }
function arR1(v) { return v == null ? '—' : (Math.round(Number(v) * 10) / 10).toFixed(1); }

const AR_GRADE_COLOR = {
  AAA: '#166534', AA: '#15803d', A: '#16a34a',
  BBB: '#1e40af', BB: '#92400e', B: '#b45309',
  C: '#9a1616', 'High Risk': '#7f1d1d',
};
const AR_GRADE_BG = {
  AAA: '#f0fdf4', AA: '#f0fdf4', A: '#f0fdf4',
  BBB: '#eff6ff', BB: '#fffbeb', B: '#fff7ed',
  C: '#fef2f2', 'High Risk': '#FEE2E2',
};
// Plain-language name for each grade, so "BBB" does not have to be decoded from the
// threshold list. Ladder descends with the score bands set in agency_rating.js
// (AAA 90+, AA 80+, A 70+, BBB 60+, BB 50+, B 40+, C 28+).
const AR_GRADE_NAME = {
  AAA: 'Excellent', AA: 'Very Good', A: 'Good',
  BBB: 'Satisfactory', BB: 'Moderate', B: 'Weak',
  C: 'Poor', 'High Risk': 'High Risk',
};
const arGradeName = g => AR_GRADE_NAME[g] || '';

// withName: show the plain-language name beside the code. Off by default so dense
// tables stay narrow — there the name rides along as the hover title instead.
function arGradeBadge(g, withName) {
  const c = AR_GRADE_COLOR[g] || '#6B7280';
  const bg = AR_GRADE_BG[g] || '#F3F4F6';
  const nm = arGradeName(g);
  const tip = nm && nm !== g ? ` title="${esc(g + ' — ' + nm)}"` : '';
  return `<span${tip} style="display:inline-flex;align-items:baseline;gap:5px;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:800;letter-spacing:.5px;background:${bg};color:${c};border:1px solid ${c}40">${g}${withName && nm && nm !== g ? `<span style="font-weight:600;letter-spacing:0;opacity:.85">${esc(nm)}</span>` : ''}</span>`;
}

function arBar(value, color, max) {
  const pct = Math.min(100, Math.max(0, (value / (max || 100)) * 100));
  return `<div style="background:var(--card-bg,#f3f4f6);border-radius:6px;height:8px;overflow:hidden;margin-top:4px">
    <div style="background:${color};height:100%;width:${pct}%;border-radius:6px;transition:width .3s"></div></div>`;
}

function arFetch(key, path, extra) {
  const st = arState();
  if (st._loading[key] || st._error[key]) return;
  if (key === 'list' || key === 'summary') { /* always allow fresh load */ }
  else if (st[key]) return;
  st._loading[key] = true; st[key] = null;
  const qs = extra ? '?' + new URLSearchParams(extra).toString() : '';
  api.get(arApi(path) + qs)
    .then(d => {
      st._loading[key] = false;
      if (d) { st[key] = d; st._error[key] = false; }
      else   { st._error[key] = true; }
      if (S.screen === 'agency_rating') render();
    })
    .catch(() => { st._loading[key] = false; st._error[key] = true; if (S.screen === 'agency_rating') render(); });
}

function arLoadMain() {
  const st = arState();
  const flt = { state: st.state, unit_code: st.unit_code };
  // clear before reload
  st.summary = null; st.list = null;
  delete st._loading.summary; delete st._error.summary;
  delete st._loading.list; delete st._error.list;
  arFetch('summary', 'summary', flt);
  arFetch('list',    'list',    { ...flt, grade: st.grade, search: st.search,
    exec: st.exec, sort: st.sort, dir: st.dir, page: st.page, per_page: 50 });
}

function arLoadFilters() {
  arFetch('filters', 'filters');
}

function arLoadConfig() {
  const st = arState();
  if (st.config) return;
  api.get(arApi('config')).then(d => {
    if (!d) return;
    st.config = d;
    st.draftBW = Math.round((d.businessWeight || 0.4) * 100);
    st.draftThresholds = Object.assign({}, d.thresholds);
    if (S.screen === 'agency_rating') render();
  });
}

function arLoadDetail(unitCode, agCode) {
  const st = arState();
  st.detail = null; st._loading.detail = true; st._error.detail = false;
  api.get(arApi(`agency/${unitCode}/${agCode}`))
    .then(d => {
      st._loading.detail = false;
      if (d) { st.detail = d; st._error.detail = false; }
      else   { st._error.detail = true; }
      if (S.screen === 'agency_rating') render();
    })
    .catch(() => { st._loading.detail = false; st._error.detail = true; if (S.screen === 'agency_rating') render(); });
}

window.arDrillAgency = function(unitCode, agCode, agName) {
  const st = arState();
  st.drillAgency = { unit_code: unitCode, ag_code: agCode, ag_name: agName };
  st.detail = null;
  arLoadDetail(unitCode, agCode);
  render();
};
window.arBackToList = function() {
  const st = arState();
  st.drillAgency = null; st.detail = null;
  const back = st._returnScreen; st._returnScreen = null;
  if (back && back !== 'agency_rating') go(back);
  else render();
};
window.arFilterGrade = function(g) {
  const st = arState();
  st.grade = st.grade === g ? '' : g;
  st.page = 1;
  arLoadMain();
  render();
};
window.arSearch = function(v) {
  const st = arState(); st.search = v; st.page = 1;
  clearTimeout(arSearch._t);
  arSearch._t = setTimeout(() => { arLoadMain(); render(); }, 400);
};
window.arFilterState = function(v) {
  const st = arState(); st.state = v; st.unit_code = ''; st.page = 1;
  arLoadMain(); render();
};
window.arFilterUnit = function(v) {
  const st = arState(); st.unit_code = v; st.page = 1;
  arLoadMain(); render();
};
window.arSort = function(col) {
  const st = arState();
  if (st.sort === col) st.dir = st.dir === 'desc' ? 'asc' : 'desc';
  else { st.sort = col; st.dir = 'desc'; }
  st.page = 1; arLoadMain(); render();
};
window.arPage = function(p) {
  const st = arState(); st.page = p;
  arLoadMain(); render();
};
window.arApplyConfig = async function() {
  const st = arState();
  if (!st.config) return;
  const bw = Math.max(5, Math.min(95, st.draftBW || 40));
  const cfg = Object.assign({}, st.config, {
    businessWeight: bw / 100,
    paymentWeight:  1 - bw / 100,
    thresholds: Object.assign({}, st.draftThresholds),
  });
  try {
    const r = await fetch(arApi('config'), { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, api.h()),
      body: JSON.stringify(cfg) });
    const d = await r.json();
    if (d.ok) { st.config = d.config; st.draftBW = bw; st.draftThresholds = Object.assign({}, d.config.thresholds); toast('Rating config saved'); arLoadMain(); render(); }
    else toast('Save failed: ' + (d.detail || 'error'));
  } catch (e) { toast('Save failed'); }
};
window.arResetConfig = function() {
  const st = arState();
  st.draftBW = 40;
  st.draftThresholds = { AAA: 90, AA: 80, A: 70, BBB: 60, BB: 50, B: 40, C: 28 };
  render();
};
window.arBWChange = function(v) {
  const st = arState(); st.draftBW = parseInt(v, 10); render();
};
window.arThrChange = function(grade, v) {
  const st = arState();
  if (!st.draftThresholds) st.draftThresholds = {};
  st.draftThresholds[grade] = parseInt(v, 10);
};

// ── MAIN VIEW ────────────────────────────────────────────────────────────────
function arMainView() {
  const st = arState();

  // Bootstrap on first load
  if (!st.filters && !st._loading.filters) arLoadFilters();
  if (!st.config) arLoadConfig();
  if (!st.summary && !st._loading.summary) arLoadMain();

  const flt  = st.filters;
  const sum  = st.summary;
  const list = st.list;
  const isAdmin = S.user && S.user.isAdmin;
  const bw = st.draftBW != null ? st.draftBW : 40;

  // ── Grade summary cards ──
  let gradeCards = '';
  if (st._loading.summary) {
    gradeCards = `<div style="color:var(--muted);padding:12px 0">Loading grade summary…</div>`;
  } else if (sum) {
    gradeCards = `<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin">
      ${sum.cards.map(c => {
        const col  = AR_GRADE_COLOR[c.grade] || '#6B7280';
        const bg   = AR_GRADE_BG[c.grade]   || '#F3F4F6';
        const active = st.grade === c.grade;
        return `<button onclick="arFilterGrade('${c.grade}')"
          style="min-width:96px;flex:0 0 auto;
                 border:1px solid ${active ? col : 'var(--border)'};
                 border-left:4px solid ${col};
                 background:${active ? col+'18' : 'var(--card-bg)'};
                 border-radius:8px;padding:10px 12px;cursor:pointer;text-align:left;
                 transition:all .15s">
          <div style="font-size:11px;font-weight:700;color:${col};letter-spacing:.5px">${c.grade}</div>
          ${arGradeName(c.grade) && arGradeName(c.grade) !== c.grade
            ? `<div style="font-size:10px;color:var(--muted);font-weight:600;margin-top:1px">${esc(arGradeName(c.grade))}</div>` : ''}
          <div style="font-size:20px;font-weight:800;color:var(--fg);margin:3px 0 1px">${c.count.toLocaleString('en-IN')}</div>
          <div style="font-size:10px;color:var(--muted)">agencies</div>
          <div style="font-size:11px;color:${col};margin-top:4px;font-weight:600">${arInrLakh(c.outstanding)}</div>
        </button>`;
      }).join('')}
    </div>`;
  }

  // ── Scoring formula panel ──
  const thr = st.draftThresholds || { AAA: 90, AA: 80, A: 70, BBB: 60, BB: 50, B: 40, C: 28 };
  const formulaPanel = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div>
          <div style="font-weight:700;font-size:15px">⚖️ Rating Weights</div>
          <div style="font-size:12px;color:var(--muted)">Adjust weights — recomputes on Apply.</div>
        </div>
        <button onclick="const st=arState();st.showFormula=!st.showFormula;render()"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px">${st.showFormula ? '▲' : '▼'}</button>
      </div>
      ${st.showFormula ? `
      <div style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span>Supply Performance</span><b>${bw}%</b>
        </div>
        <input type="range" min="5" max="95" value="${bw}" oninput="arBWChange(this.value)"
          style="width:100%;accent-color:var(--navy)">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:8px;margin-bottom:4px">
          <span>Collection &amp; Credit</span><b>${100 - bw}%</b>
        </div>
        <div style="background:var(--navy);border-radius:4px;height:8px;overflow:hidden">
          <div style="background:var(--grn,#22c55e);height:100%;width:${100 - bw}%;margin-left:${bw}%"></div>
        </div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Grade Min Score</div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${['AAA','AA','A','BBB','BB','B','C'].map(g => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              ${arGradeBadge(g, true)}
              <input type="number" value="${thr[g] || 0}" min="0" max="100"
                onchange="arThrChange('${g}',this.value)"
                style="width:58px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;text-align:right;background:var(--input-bg,var(--card-bg));color:var(--fg)">
            </div>`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        ${isAdmin ? `<button class="btn" style="flex:1;background:var(--navy);color:#fff;padding:9px" onclick="arApplyConfig()">✦ Apply</button>` : ''}
        <button class="btn" style="flex:1;padding:9px" onclick="arResetConfig()">↺ Reset</button>
      </div>
      ` : ''}
    </div>`;

  // ── Agency ratings table ──
  const filterRow = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <input type="search" placeholder="Search agency..." value="${esc(st.search)}"
      oninput="arSearch(this.value)"
      style="flex:1;min-width:160px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg,var(--card-bg));color:var(--fg);font-size:13px">
    ${flt ? `
    <select onchange="arFilterState(this.value)"
      style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg,var(--card-bg));color:var(--fg);font-size:13px">
      <option value="">All States</option>
      ${flt.states.map(s => `<option value="${esc(s)}" ${st.state === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
    </select>
    <select onchange="arFilterUnit(this.value)"
      style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg,var(--card-bg));color:var(--fg);font-size:13px">
      <option value="">All Units</option>
      ${(flt.units || []).filter(u => !st.state || u.state_nm === st.state).map(u => `<option value="${esc(u.unit_code)}" ${st.unit_code === u.unit_code ? 'selected' : ''}>${esc(u.unit_name)}</option>`).join('')}
    </select>` : ''}
    ${st.grade ? `<button onclick="arFilterGrade('')" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);cursor:pointer;font-size:12px;color:var(--fg)">✕ ${st.grade}</button>` : ''}
  </div>`;

  let tableHtml = '';
  if (st._loading.list) {
    tableHtml = `<div style="text-align:center;padding:32px;color:var(--muted)">Loading agencies…</div>`;
  } else if (st._error.list) {
    tableHtml = `<div style="text-align:center;padding:24px;color:var(--red)">Failed to load. <button onclick="arLoadMain();render()">Retry</button></div>`;
  } else if (list) {
    const SH = (col, lbl) => {
      const active = st.sort === col;
      const arrow  = active ? (st.dir === 'desc' ? ' ↓' : ' ↑') : '';
      return `<th onclick="arSort('${col}')" style="cursor:pointer;white-space:nowrap;user-select:none">${lbl}${arrow}</th>`;
    };
    const rows = (list.rows || []).map(r => {
      const rec = r.breakdown && r.breakdown.recency != null ? r.breakdown.recency : 50;
      const reg = r.breakdown && r.breakdown.regularity != null ? r.breakdown.regularity : 50;
      const trend = rec >= 90 && reg >= 70 ? `<span style="color:#16a34a;font-size:11px">▲</span>`
                  : rec <= 35 || reg < 30  ? `<span style="color:#dc2626;font-size:11px">▼</span>`
                  : `<span style="color:var(--muted);font-size:11px">—</span>`;
      const collPct = r.breakdown && r.breakdown.collection_pct != null;
      const collCol = collPct ? (r.breakdown.collection_pct >= 80 ? '#16a34a' : r.breakdown.collection_pct < 50 ? '#dc2626' : '#b45309') : 'var(--muted)';
      return `<tr onclick="arDrillAgency('${esc(r.unit_code)}','${esc(r.ag_code)}','${esc(r.ag_name || '')}')">
        <td><b>${esc(r.ag_name || r.ag_code)}</b><small style="display:block;color:var(--muted)">${esc(r.city_name || '')}</small></td>
        <td style="font-size:11px;color:var(--muted)">${esc(r.unit_name || r.unit_code)}</td>
        <td>${arGradeBadge(r.grade)}</td>
        <td class="r num" style="font-weight:700">${r.composite}</td>
        <td class="r num" style="color:var(--navy)">${r.businessScore}</td>
        <td class="r num" style="color:var(--navy)">${r.paymentScore}</td>
        <td class="r num">${r.day_copies > 0 ? r.day_copies.toLocaleString('en-IN') : '—'} ${trend}</td>
        <td class="r num" style="color:${collCol}">${collPct ? arR1(r.breakdown.collection_pct) + '%' : '—'}</td>
        <td class="r num" style="color:#dc2626">${arInrLakh(r.cl_amt)}</td>
      </tr>`;
    }).join('');

    const total = list.total || 0;
    const totalPages = list.total_pages || 1;
    const pages = [];
    for (let i = Math.max(1, st.page - 2); i <= Math.min(totalPages, st.page + 2); i++) pages.push(i);

    tableHtml = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
        Portfolio health — ${total.toLocaleString('en-IN')} active agencies
        ${sum ? ` · weighted outstanding ${arInrLakh(sum.cards.reduce((s,c)=>s+c.outstanding,0))}` : ''}
      </div>
      <div style="overflow-x:auto">
        <table class="tbl" style="width:100%;font-size:13px">
          <thead><tr>
            ${SH('name','Agency')}
            <th>Unit</th>
            ${SH('composite','Grade')}
            ${SH('composite','Score')}
            ${SH('business','Supply Score')}
            ${SH('payment','Coll Score')}
            ${SH('supply','Copies/Day')}
            <th>Coll%</th>
            ${SH('outstanding','Outstanding')}
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted)">No agencies found</td></tr>'}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<div style="display:flex;gap:6px;justify-content:center;margin-top:12px;flex-wrap:wrap">
        ${st.page > 1 ? `<button class="btn" style="padding:5px 12px" onclick="arPage(${st.page - 1})">‹</button>` : ''}
        ${pages.map(p => `<button class="btn ${p === st.page ? 'navy' : ''}" style="padding:5px 12px" onclick="arPage(${p})">${p}</button>`).join('')}
        ${st.page < totalPages ? `<button class="btn" style="padding:5px 12px" onclick="arPage(${st.page + 1})">›</button>` : ''}
      </div>` : ''}`;
  }

  return pagehead('Agency Rating Engine', 'Transparent, configurable scoring — business performance × payment behaviour.') + `
    ${gradeCards ? `<div style="margin-bottom:16px">${gradeCards}</div>` : ''}
    <div style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:start">
      <div>${formulaPanel}</div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:12px">Agency Ratings</div>
        ${filterRow}
        ${tableHtml}
      </div>
    </div>
    <style>
      @media(max-width:700px){
        .ar-grid{grid-template-columns:1fr!important}
      }
      .tbl tbody tr:hover{background:var(--hover-bg,rgba(0,0,0,.04));cursor:pointer}
    </style>`;
}

// ── AGENCY DETAIL VIEW ───────────────────────────────────────────────────────
function arDetailView() {
  const st = arState();
  const drill = st.drillAgency || {};
  const d     = st.detail;

  const backLabel = st._returnScreen === 'ai_nexus' ? '← Strategic AI Nexus' : '← Agency Ratings';
  const back = `<button onclick="arBackToList()" style="background:none;border:none;color:var(--navy);cursor:pointer;font-size:13px;padding:0 0 12px;display:flex;align-items:center;gap:5px">${backLabel}</button>`;

  if (st._loading.detail) return back + `<div class="card" style="text-align:center;padding:40px;color:var(--muted)">Loading agency detail…</div>`;
  if (st._error.detail)   return back + `<div class="card" style="text-align:center;padding:32px;color:var(--red)">Failed to load detail. <button onclick="arLoadDetail('${drill.unit_code}','${drill.ag_code}')">Retry</button></div>`;
  if (!d) return back + `<div class="card" style="text-align:center;padding:32px;color:var(--muted)">No data</div>`;

  const ag  = d.agency  || {};
  const cur = d.current || {};
  const rat = d.rating  || {};
  const bk  = rat.breakdown || {};
  const sigs = d.signals || [];

  const statusColor = ag.status === 'Active' ? 'var(--grn,#22c55e)' : 'var(--red)';
  const cpct = cur.collection_pct;

  // ── Header card ──
  const header = `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between">
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:20px;font-weight:900">${esc(ag.ag_name || drill.ag_name || ag.ag_code)}</div>
          ${arGradeBadge(rat.grade || '—', true)}
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${statusColor}20;color:${statusColor};font-weight:600">${esc(ag.status || 'Active')}</span>
          ${cpct != null ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${cpct >= 80 ? '#D1FAE5' : cpct < 50 ? '#FEE2E2' : '#FEF3C7'};color:${cpct >= 80 ? '#059669' : cpct < 50 ? '#DC2626' : '#D97706'};font-weight:600">${cpct >= 80 ? '● Low' : cpct < 50 ? '● High' : '● Medium'} · ${arR1(cpct)}%</span>` : ''}
        </div>
        <div style="margin-top:6px;font-size:12px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap">
          <span>📋 ${esc(ag.ag_code)}</span>
          <span>📍 ${esc([ag.city_name, ag.dist_name].filter(Boolean).join(', ') || ag.unit_name || '')}</span>
          ${ag.mobile_no1 ? `<span>📞 ${esc(ag.mobile_no1)}</span>` : ''}
          ${ag.email_id   ? `<span>✉️ ${esc(ag.email_id)}</span>` : ''}
        </div>
        <div style="margin-top:6px;font-size:12px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap">
          ${ag.executive_name ? `<span>👤 ${esc(ag.executive_name)}</span>` : ''}
          ${ag.ag_type_name   ? `<span>🏷️ ${esc(ag.ag_type_name)}</span>` : ''}
          ${ag.unit_state_nm  ? `<span>🗺️ ${esc(ag.unit_state_nm)}</span>` : ''}
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Total Outstanding</div>
        <div style="font-size:26px;font-weight:900;color:var(--red)">${arInrLakh(cur.cl_amt)}</div>
      </div>
    </div>
  </div>`;

  // ── Info row: 6 stats ──
  const infoRow = (items) => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px">
    ${items.map(([icon, label, val]) => `<div class="card" style="padding:12px;text-align:center">
      <div style="font-size:18px">${icon}</div>
      <div style="font-size:11px;color:var(--muted);margin:2px 0">${label}</div>
      <div style="font-size:14px;font-weight:700">${val}</div>
    </div>`).join('')}
  </div>`;

  const tenureYrs = ag.supply_start_dt
    ? ((Date.now() - new Date(ag.supply_start_dt).getTime()) / (365.25 * 86400000)).toFixed(1)
    : null;

  const stats = infoRow([
    ['📦', 'Days Supplied', cur.supply_days > 0 ? cur.supply_days + ' d' : '—'],
    ['📋', 'Daily Avg', cur.day_copies > 0 ? cur.day_copies.toLocaleString('en-IN') : '—'],
    ['👤', 'Executive', esc((ag.executive_name || '—').split(' ').slice(0,2).join(' '))],
    ['📅', 'Active Since', ag.supply_start_dt ? new Date(ag.supply_start_dt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}) : '—'],
    ['⏳', 'Tenure', tenureYrs ? tenureYrs + ' yrs' : '—'],
    ['🗺️', 'State', esc(ag.unit_state_nm || '—')],
  ]);

  // ── Two-column: outstanding statement | rating breakdown + signals ──
  const monthLabel = p => {
    const [y, m] = (p || '').split('-');
    return ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)] + " '" + (y || '').slice(2);
  };

  const histRows = (d.history || []).map(h => `
    <tr>
      <td style="font-weight:600">${monthLabel(h.period_label)}</td>
      <td class="r num">${arInrLakh(h.bill_amt)}</td>
      <td class="r num" style="color:var(--grn,#22c55e)">${arInrLakh(h.rec_amt)}</td>
      <td class="r num" style="color:${Number(h.cl_amt) > 0 ? 'var(--red)' : 'var(--grn,#22c55e)'}">${arInrLakh(h.cl_amt)}</td>
      <td class="r num" style="color:var(--muted)">${h.supply_days || '—'}</td>
    </tr>`).join('');

  const ouStatement = `<div class="card" style="margin-bottom:16px">
    <div style="font-weight:700;font-size:14px;margin-bottom:10px">Outstanding Statement</div>
    <div style="overflow-x:auto">
      <table class="tbl" style="width:100%;font-size:13px">
        <thead><tr><th>Period</th><th class="r">Billing</th><th class="r">Collection</th><th class="r">Outstanding</th><th class="r">Sup.Days</th></tr></thead>
        <tbody>
          ${histRows || `<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--muted)">No history available</td></tr>`}
          <tr style="font-weight:800;background:var(--navy,#1C2B45);color:#fff">
            <td>YTD 2026</td>
            <td class="r num">${arInrLakh(cur.bill_amt)}</td>
            <td class="r num">${arInrLakh(cur.rec_amt)}</td>
            <td class="r num">${arInrLakh(cur.cl_amt)}</td>
            <td class="r num">${cur.supply_days || '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;

  // Rating breakdown with progress bars
  const scoreRow = (label, val, color) => `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
        <span>${label}</span><b style="color:${color}">${val != null ? val : '—'}</b>
      </div>
      ${val != null ? arBar(val, color, 100) : ''}
    </div>`;

  const ratingBreakdown = `<div class="card" style="margin-bottom:16px">
    <div style="font-weight:700;font-size:14px;margin-bottom:14px">Rating Breakdown</div>
    ${scoreRow('Composite Score',  rat.composite,     AR_GRADE_COLOR[rat.grade] || '#6B7280')}
    ${scoreRow('Business Score',   rat.businessScore, '#3B82F6')}
    ${scoreRow('Payment Score',    rat.paymentScore,  '#10B981')}
    <div style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">
    ${scoreRow('Supply Regularity',  bk.regularity,  '#60A5FA')}
    ${scoreRow('Agency Volume',       bk.volume,      '#818CF8')}
    ${scoreRow('Collection Ratio',   bk.collection,  '#34D399')}
    ${scoreRow('Outstanding Level',  bk.outstanding, '#6EE7B7')}
    </div>
    ${bk.collection_pct != null ? `
    <div style="margin-top:12px;padding:10px;background:${bk.collection_pct >= 80 ? '#ECFDF5' : bk.collection_pct < 50 ? '#FEF2F2' : '#FFFBEB'};border-radius:8px">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Default Probability</div>
      <div style="font-size:22px;font-weight:900;color:${bk.collection_pct >= 80 ? '#059669' : bk.collection_pct < 50 ? '#DC2626' : '#D97706'};margin:2px 0">${bk.collection_pct >= 80 ? (100 - bk.collection_pct).toFixed(1) : bk.outstanding_pct != null ? Math.min(99, bk.outstanding_pct).toFixed(1) : '—'}%</div>
      <div style="font-size:11px;color:var(--muted)">${bk.collection_pct >= 80 ? 'Low risk' : bk.collection_pct < 50 ? 'High risk' : 'Moderate risk'}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Risk indicator based on current payment behaviour and outstanding pattern.</div>
    </div>` : ''}
  </div>`;

  // Signals
  const sigIcon = t => t === 'green' ? '🟢' : t === 'red' ? '🔴' : '🟡';
  const signalsCard = sigs.length ? `<div class="card" style="margin-bottom:16px">
    <div style="font-weight:700;font-size:14px;margin-bottom:10px">Signals</div>
    ${sigs.map(s => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <span>${sigIcon(s.type)}</span><span>${esc(s.text)}</span></div>`).join('')}
  </div>` : '';

  // Supply history
  const supHistRows = (d.sup_history || []).map(h => `
    <tr><td style="font-weight:600">${monthLabel(h.month)}</td>
        <td class="r num">${h.total_supply > 0 ? h.total_supply.toLocaleString('en-IN') : '—'}</td>
        <td class="r num" style="color:var(--muted)">${h.supply_days || '—'}</td></tr>`).join('');
  const collHistRows = (d.coll_history || []).map(h => `
    <tr><td style="font-weight:600">${monthLabel(h.month)}</td>
        <td class="r num" style="color:var(--grn,#22c55e)">${h.collection > 0 ? arInrLakh(h.collection) : '—'}</td>
        <td class="r num" style="color:var(--muted)">${h.txn_count || '—'}</td></tr>`).join('');

  const historySection = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <div class="card">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">📦 Supply History</div>
      <div style="overflow-x:auto"><table class="tbl" style="width:100%;font-size:12px">
        <thead><tr><th>Month</th><th class="r">Copies</th><th class="r">Days</th></tr></thead>
        <tbody>${supHistRows || '<tr><td colspan="3" style="text-align:center;padding:12px;color:var(--muted)">No data</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">₹ Collection History</div>
      <div style="overflow-x:auto"><table class="tbl" style="width:100%;font-size:12px">
        <thead><tr><th>Month</th><th class="r">Collected</th><th class="r">Txns</th></tr></thead>
        <tbody>${collHistRows || '<tr><td colspan="3" style="text-align:center;padding:12px;color:var(--muted)">No data</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>`;

  return `<div style="max-width:1200px">
    ${back}
    ${header}
    ${stats}
    <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">
      <div>${ouStatement}</div>
      <div>${ratingBreakdown}${signalsCard}</div>
    </div>
    ${historySection}
    <style>@media(max-width:700px){.ar-detail-grid{grid-template-columns:1fr!important}}</style>
  </div>`;
}

VIEWS.agency_rating = () => {
  const st = arState();
  if (st.drillAgency) return arDetailView();
  return arMainView();
};

/* ════════════════════════════════════════════════════════
   SHORT PAYMENT / BILL-WISE COLLECTION REPORT
   ════════════════════════════════════════════════════════ */

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
      if (_spVisible()) spLoad();
    });
    return (_spEmbed ? '' : pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis')) +
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
    return (_spEmbed ? '' : pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis')) + filtersBar +
      `<div style="text-align:center;padding:40px;color:var(--muted)">Loading report…</div>`;
  }

  if (d.error === 'no_monthly_data') {
    return (_spEmbed ? '' : pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis')) + filtersBar +
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
              <td style="padding:4px 8px;font-weight:600;position:sticky;left:0;background:${ri%2?'var(--surface-2)':'var(--surface)'};z-index:2;white-space:nowrap;cursor:pointer" onclick="openAgencyProfile('${esc(ag.unit_code||'').replace(/'/g,"\\'")}','${esc(ag.ag_code||'').replace(/'/g,"\\'")}','${esc(ag.ag_name||ag.ag_code||'').replace(/'/g,"\\'")}')" title="View agency profile">
                <span style="color:var(--chart-1)">${esc(ag.ag_name)}</span><br><span style="font-size:10px;font-weight:400;color:var(--muted)">${ag.ag_code} · ${ag.unit_name}</span>
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

  return (_spEmbed ? '' : pagehead('Short Payment Report', 'Bill-wise collection & short payment analysis')) +
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

/* ---- App Assignment modal ---- */
let _umaData = null; // holds GET response while Apps modal is open

window.umApps = async (id) => {
  const u = (S.live.adminUsers || []).find(x => x.id === id); if (!u) return;
  const d = await api.get(`/api/admin/users/${id}/apps`);
  if (!d) { toast('❌ Failed to load'); return; }
  _umaData = { ...d, userId: id };

  const chkRow = (checked, id, label, note) =>
    `<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:9px 12px;border-radius:8px;background:var(--surface-2)">
       <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
       <span style="font-size:13px;flex:1">${label}</span>
       ${note ? `<span style="font-size:10px;color:var(--ink-2)">${note}</span>` : ''}
     </label>`;

  const modRows = MR_ALL_MODULES.map(m =>
    chkRow(d.modules.includes(m.key), `umaM_${m.key}`, `${m.icon} ${m.label}`,
           d.default_modules.includes(m.key) ? 'default' : '')).join('');

  const noPersonCode = !d.person_code;
  modal(`<h3 style="margin-bottom:4px">App Access</h3>
    <div style="font-size:12px;color:var(--ink-2);margin-bottom:14px">${esc(u.name)} · ${d.has_override ? '<b>Custom</b>' : 'Level defaults'}</div>
    ${noPersonCode ? `<div style="padding:10px 12px;background:var(--red-l);color:var(--red);border-radius:8px;font-size:13px;margin-bottom:12px">
      No person code — assign one in Edit to enable custom permissions.</div>` : ''}

    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-2);margin-bottom:6px">Dashboard</div>
    <div style="margin-bottom:14px">
      ${chkRow(d.dashboard, 'umaDash', 'Can view Vitran OS dashboard (Supply, Collections, Reports…)', d.default_dashboard ? 'default' : '')}
    </div>

    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-2);margin-bottom:6px">Field Apps</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">${modRows}</div>

    <div id="umaErr"></div>
    <div style="display:flex;gap:9px;flex-wrap:wrap">
      <button class="btn pri" onclick="umAppsSave(${id})" ${noPersonCode ? 'disabled' : ''}>Save</button>
      ${d.has_override ? `<button class="btn" onclick="umAppsReset(${id})">Reset to defaults</button>` : ''}
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window.umAppsSave = async (id) => {
  const dash = document.getElementById('umaDash')?.checked;
  const modules = MR_ALL_MODULES
    .filter(m => document.getElementById(`umaM_${m.key}`)?.checked)
    .map(m => m.key);
  const r = await apiCall('PUT', `/api/admin/users/${id}/apps`, { dashboard: dash, modules });
  if (!r.ok) {
    const el = document.getElementById('umaErr');
    if (el) el.innerHTML = `<div class="err">${esc(r.detail || 'Save failed')}</div>`;
    return;
  }
  closeModals(); toast('✅ App access saved — effective on next login');
};

window.umAppsReset = async (id) => {
  if (!confirm('Reset to level defaults?')) return;
  const r = await apiCall('PUT', `/api/admin/users/${id}/apps`, { reset: true });
  if (r.ok) { closeModals(); toast('↩️ Reset to defaults'); }
  else toast('❌ ' + (r.detail || 'Failed'));
};

/* ---- Scope Assignment modal ---- */
let _umsData = null;

window.umScope = async (id) => {
  const u = (S.live.adminUsers || []).find(x => x.id === id); if (!u) return;
  const d = await api.get(`/api/admin/users/${id}/scope`);
  if (!d) { toast('❌ Failed to load'); return; }
  _umsData = { ...d, userId: id };

  if (d.is_pan_india) {
    modal(`<h3>Scope — ${esc(u.name)}</h3>
      <div style="padding:16px;background:var(--surface-2);border-radius:10px;font-size:13px;color:var(--ink-2)">
        Level 1 Admin — PAN India access. Cannot be scoped down.</div>
      <div style="margin-top:14px"><button class="btn" onclick="closeModals()">Close</button></div>`);
    return;
  }

  const noPersonCode = !d.person_code;
  const derived = d.derived_unit_codes || [];
  const current = new Set(d.unit_codes || derived);

  // Group units by state_name
  const byState = {};
  (d.all_units || []).forEach(un => {
    const st = un.state_name || 'National / Other';
    if (!byState[st]) byState[st] = [];
    byState[st].push(un);
  });

  const stateBlocks = Object.entries(byState).sort((a,b) => a[0].localeCompare(b[0])).map(([state, units]) => {
    const allChecked = units.every(un => current.has(un.unit_code));
    const unitItems = units.map(un => {
      const isDefault = derived.includes(un.unit_code);
      return `<label style="display:flex;align-items:center;gap:8px;padding:5px 10px 5px 28px;cursor:pointer;font-size:13px">
        <input type="checkbox" name="umsUnit" data-state="${esc(state)}" value="${esc(un.unit_code)}" ${current.has(un.unit_code) ? 'checked' : ''} onchange="umsStateHeaderSync('${esc(state)}')">
        <span style="flex:1;color:var(--ink-1)">${esc(un.unit_name)}</span>
        ${isDefault ? `<span style="font-size:10px;color:var(--ink-2);background:var(--surface-2);border-radius:4px;padding:1px 5px">default</span>` : ''}
      </label>`;
    }).join('');
    return `<div class="ums-state-grp" style="margin-bottom:6px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <label style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--surface-2);cursor:pointer;font-size:13px;font-weight:600">
        <input type="checkbox" name="umsStateAll" data-state="${esc(state)}" ${allChecked ? 'checked' : ''} onchange="umsStateToggle('${esc(state)}',this.checked)">
        <span style="flex:1">${esc(state)}</span>
        <span style="font-size:11px;font-weight:400;color:var(--ink-2)">${units.length} unit${units.length !== 1 ? 's' : ''}</span>
      </label>
      ${unitItems}
    </div>`;
  }).join('');

  modal(`<h3 style="margin-bottom:4px">Branch Access</h3>
    <div style="font-size:12px;color:var(--ink-2);margin-bottom:14px">${esc(u.name)} · ${d.has_override ? '<b style="color:var(--primary)">Custom override</b>' : 'Hierarchy defaults'} · ${current.size} unit(s) assigned</div>
    ${noPersonCode ? `<div style="padding:10px 12px;background:var(--red-l);color:var(--red);border-radius:8px;font-size:13px;margin-bottom:12px">No person code — assign one in Edit first.</div>` : ''}
    ${!derived.length && !noPersonCode ? `<div style="padding:10px 12px;background:#fef3c7;color:#92400e;border-radius:8px;font-size:13px;margin-bottom:12px">Not found in hierarchy — hierarchy scope is empty. Use custom override.</div>` : ''}
    <div style="max-height:380px;overflow-y:auto;margin-bottom:10px;padding-right:2px">${stateBlocks}</div>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn sm" onclick="umsScopeAll(true)">Select all</button>
      <button class="btn sm" onclick="umsScopeAll(false)">Clear all</button>
      <button class="btn sm" onclick="umsScopeDefault()">Hierarchy defaults</button>
    </div>
    <div id="umsErr"></div>
    <div style="display:flex;gap:9px;flex-wrap:wrap">
      <button class="btn pri" onclick="umScopeSave(${id})" ${noPersonCode ? 'disabled' : ''}>Save</button>
      ${d.has_override ? `<button class="btn" onclick="umScopeReset(${id})">Reset to hierarchy</button>` : ''}
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window.umsScopeAll = (on) => {
  document.querySelectorAll('input[name="umsUnit"]').forEach(cb => { cb.checked = on; });
  document.querySelectorAll('input[name="umsStateAll"]').forEach(cb => { cb.checked = on; });
};
window.umsScopeDefault = () => {
  if (!_umsData) return;
  const derived = new Set(_umsData.derived_unit_codes || []);
  document.querySelectorAll('input[name="umsUnit"]').forEach(cb => { cb.checked = derived.has(cb.value); });
  document.querySelectorAll('input[name="umsStateAll"]').forEach(cb => {
    const state = cb.dataset.state;
    const all = document.querySelectorAll(`input[name="umsUnit"][data-state="${state}"]`);
    cb.checked = all.length > 0 && Array.from(all).every(c => c.checked);
  });
};
window.umsStateToggle = (state, on) => {
  document.querySelectorAll(`input[name="umsUnit"][data-state="${state}"]`).forEach(cb => { cb.checked = on; });
};
window.umsStateHeaderSync = (state) => {
  const all = document.querySelectorAll(`input[name="umsUnit"][data-state="${state}"]`);
  const hdr = document.querySelector(`input[name="umsStateAll"][data-state="${state}"]`);
  if (hdr) hdr.checked = all.length > 0 && Array.from(all).every(c => c.checked);
};

window.umScopeSave = async (id) => {
  const unit_codes = Array.from(document.querySelectorAll('input[name="umsUnit"]'))
    .filter(cb => cb.checked).map(cb => cb.value);
  const r = await apiCall('PUT', `/api/admin/users/${id}/scope`, { unit_codes });
  if (!r.ok) {
    const el = document.getElementById('umsErr');
    if (el) el.innerHTML = `<div class="err">${esc(r.detail || 'Save failed')}</div>`;
    return;
  }
  closeModals(); toast('✅ Scope saved — effective immediately');
};

window.umScopeReset = async (id) => {
  if (!confirm('Reset to hierarchy-derived scope?')) return;
  const r = await apiCall('PUT', `/api/admin/users/${id}/scope`, { reset: true });
  if (r.ok) { closeModals(); toast('↩️ Scope reset to hierarchy'); }
  else toast('❌ ' + (r.detail || 'Failed'));
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
        <button class="btn sm navy" onclick="umApps(${u.id})">Apps</button>
        <button class="btn sm navy" onclick="umScope(${u.id})">Scope</button>
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
  scope_update: 'Scope override saved', scope_reset: 'Scope reset to hierarchy',
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

/* ════════════════════════════════════════════════════════════════════
   COMPETITOR DATA — State/Unit/Agency market-share management
   ════════════════════════════════════════════════════════════════════ */

let _cmp = { tab:'agency', unit:'', state:'', period:'', rows:undefined, total:0, loading:false,
             periods:undefined, _pLoading:false };

function _cmpState() { return _cmp; }

function _cmpLoad(force) {
  const st = _cmpState();
  if (st.loading || (st.rows !== undefined && !force)) return;
  st.loading = true; st.rows = undefined;
  const qs = new URLSearchParams({ type: st.tab });
  if (st.unit)   qs.set('unit',   st.unit);
  if (st.period) qs.set('period', st.period);
  if (st.state)  qs.set('state',  st.state);
  fetch(`${api.base}/api/competitor?${qs}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.rows = d.rows || []; st.total = d.total || 0; st.loading = false; if (S.screen === 'competitor_data') render(); })
    .catch(() => { st.rows = []; st.loading = false; if (S.screen === 'competitor_data') render(); });
}

function _cmpLoadPeriods(force) {
  const st = _cmpState();
  if (st._pLoading || (st.periods !== undefined && !force)) return;
  st._pLoading = true;
  fetch(`${api.base}/api/competitor/periods?type=${st.tab}`, { headers: api.h() })
    .then(r => r.json())
    .then(d => { st.periods = Array.isArray(d) ? d : []; st._pLoading = false; if (S.screen === 'competitor_data') render(); })
    .catch(() => { st.periods = []; st._pLoading = false; });
}

window.cmpTab = t => {
  const st = _cmpState();
  st.tab = t; st.rows = undefined; st.periods = undefined; st.period = ''; st.unit = ''; st.state = '';
  _cmpLoad(); _cmpLoadPeriods(); render();
};

window.cmpApplyFilter = () => {
  const st = _cmpState();
  st.unit   = (document.getElementById('cmpUnit')   || {}).value || '';
  st.period = (document.getElementById('cmpPeriod') || {}).value || '';
  st.state  = (document.getElementById('cmpState')  || {}).value || '';
  st.rows = undefined; _cmpLoad();
};

window.cmpDownloadTemplate = async () => {
  const st = _cmpState();
  try {
    toast('Preparing template — fetching master data…');
    const qs = new URLSearchParams({ type: st.tab });
    if (st.period) qs.set('period', st.period);
    if (st.unit)   qs.set('unit',   st.unit);
    const r = await fetch(`${api.base}/api/competitor/template?${qs}`, { headers: api.h() });
    if (!r.ok) { toast('Template error: ' + r.status); return; }
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const period = st.period || new Date().toISOString().slice(0, 7);
    a.href = url; a.download = `competitor_${st.tab}_${period}${st.unit ? '_' + st.unit : ''}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Template downloaded');
  } catch (e) { toast('Download failed: ' + e.message); }
};

window.cmpUploadModal = () => {
  const st = _cmpState();
  modal(`<h3>Upload Competitor Data (${st.tab === 'hawker' ? 'Hawker' : 'Agency'})</h3>
    <p style="font-size:12px;color:var(--ink-2)">Download the template first, fill in the data, then upload the filled Excel here. Existing records for the same period+unit+agent will be updated.</p>
    <input type="file" id="cmpFile" accept=".xlsx,.xls" style="margin:10px 0;display:block">
    <div id="cmpUpErr" style="color:var(--red);font-size:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn pri block" onclick="cmpDoUpload()">Upload &amp; Save</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window.cmpDoUpload = async () => {
  const st = _cmpState();
  const file = document.getElementById('cmpFile')?.files?.[0];
  const errEl = document.getElementById('cmpUpErr');
  if (!file) { errEl.textContent = 'Please select an Excel file'; return; }
  errEl.textContent = 'Uploading…';
  try {
    const buf = await file.arrayBuffer();
    const u = S.user;
    const enteredBy = encodeURIComponent((u && u.name) || (u && u.person_code) || '');
    const r = await fetch(`${api.base}/api/competitor/upload?type=${st.tab}&entered_by=${enteredBy}`, {
      method: 'POST', headers: { ...api.h(), 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    // A size limit anywhere in the chain (this app, or a reverse proxy in front of it)
    // answers with an HTML error page, not JSON. Parsing that blindly used to surface
    // as 'Unexpected token "<"', which told the user nothing. Read the body as text and
    // only treat it as JSON when it actually is.
    const raw = await r.text();
    let d = null;
    try { d = JSON.parse(raw); } catch (_) {}
    if (!d) {
      const mb = (file.size / 1048576).toFixed(1);
      errEl.textContent = r.status === 413 || /too large/i.test(raw)
        ? `File too large (${mb} MB) — the server rejected it. Download the template for a single Unit Code, fill that, and upload it.`
        : `Server returned an unexpected response (HTTP ${r.status}). The upload did not go through.`;
      return;
    }
    if (!r.ok) { errEl.textContent = d.detail || 'Upload failed'; return; }
    closeModals();
    toast(`✓ ${d.inserted} records saved (${d.skipped} skipped)`);
    st.rows = undefined; st.periods = undefined; _cmpLoad(); _cmpLoadPeriods();
  } catch (e) { errEl.textContent = 'Error: ' + e.message; }
};

window.cmpAddModal = () => {
  const st = _cmpState();
  const label = st.tab === 'hawker' ? 'Hawker' : 'Agency';
  modal(`<h3>Add Competitor Data (${label})</h3>
    <div class="fld"><label>Period (YYYY-MM) *</label><input id="cmpFPeriod" placeholder="2026-08" value="${todayISO().slice(0,7)}"></div>
    <div class="fld"><label>Unit Code *</label><input id="cmpFUnit" placeholder="JA0" value="${esc(st.unit)}"></div>
    <div class="fld"><label>State</label><input id="cmpFState" placeholder="Rajasthan" value="${esc(st.state)}"></div>
    <div class="fld"><label>${label} Code</label><input id="cmpFAgent" placeholder="AG001"></div>
    <div class="fld"><label>${label} Name</label><input id="cmpFAgName" placeholder="Optional"></div>
    <div class="fld"><label>Our Copies (Patrika) *</label><input id="cmpFOurs" type="number" inputmode="numeric" placeholder="0"></div>
    <div style="font-size:11.5px;color:var(--ink-2);font-weight:700;margin:10px 0 4px">Competitors</div>
    ${[1,2,3,4,5].map(i=>`<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <input id="cmpFC${i}Name" placeholder="Competitor ${i} name" style="flex:3">
      <input id="cmpFC${i}Copies" type="number" inputmode="numeric" placeholder="Copies" style="flex:1;min-width:60px">
    </div>`).join('')}
    <div class="fld"><label>Remarks</label><input id="cmpFRemarks" placeholder="Notes…"></div>
    <div id="cmpSaveErr" style="color:var(--red);font-size:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn pri block" onclick="cmpSaveEntry()">Save</button>
      <button class="btn" onclick="closeModals()">Cancel</button>
    </div>`);
};

window.cmpSaveEntry = async () => {
  const st = _cmpState();
  const gv = id => (document.getElementById(id)||{}).value || '';
  const errEl = document.getElementById('cmpSaveErr');
  const body = {
    comp_type:  st.tab,
    period:     gv('cmpFPeriod').trim(),
    unit_code:  gv('cmpFUnit').trim(),
    state_name: gv('cmpFState').trim(),
    agent_code: gv('cmpFAgent').trim(),
    agent_name: gv('cmpFAgName').trim(),
    our_supply: parseInt(gv('cmpFOurs')||'0',10)||0,
    comp1_name: gv('cmpFC1Name'), comp1_supply: parseInt(gv('cmpFC1Copies')||'0',10)||0,
    comp2_name: gv('cmpFC2Name'), comp2_supply: parseInt(gv('cmpFC2Copies')||'0',10)||0,
    comp3_name: gv('cmpFC3Name'), comp3_supply: parseInt(gv('cmpFC3Copies')||'0',10)||0,
    comp4_name: gv('cmpFC4Name'), comp4_supply: parseInt(gv('cmpFC4Copies')||'0',10)||0,
    comp5_name: gv('cmpFC5Name'), comp5_supply: parseInt(gv('cmpFC5Copies')||'0',10)||0,
    remarks:    gv('cmpFRemarks'),
    entered_by: (S.user && S.user.name) || (S.user && S.user.person_code) || '',
  };
  if (!body.period.match(/^\d{4}-\d{2}$/) || !body.unit_code) {
    errEl.textContent = 'Period (YYYY-MM) and Unit Code are required'; return;
  }
  try {
    const r = await api.post('/api/competitor', body);
    if (r && r.ok) { closeModals(); toast('✓ Saved'); st.rows = undefined; _cmpLoad(); }
    else errEl.textContent = (r && r.detail) || 'Save failed';
  } catch (e) { errEl.textContent = e.message; }
};

window.cmpDelete = async (id) => {
  if (!confirm('Delete this record?')) return;
  try {
    const r = await fetch(`${api.base}/api/competitor/${id}`, { method: 'DELETE', headers: api.h() });
    const d = await r.json();
    if (d.ok) { toast('Deleted'); const st = _cmpState(); st.rows = undefined; _cmpLoad(); }
    else toast('Delete failed');
  } catch (e) { toast('Error: ' + e.message); }
};

VIEWS.competitor_data = () => {
  _cmpLoad(); _cmpLoadPeriods();
  const st = _cmpState();
  const isHawker = st.tab === 'hawker';
  const label    = isHawker ? 'Hawker' : 'Agency';

  const tabBar = `<div style="display:flex;gap:8px;margin-bottom:14px">
    ${['agency','hawker'].map(t => `<button class="btn${st.tab===t?' pri':''} sm" onclick="cmpTab('${t}')">${t==='hawker'?'🛵 Hawker':'🏢 Agency'}</button>`).join('')}
  </div>`;

  const periodOpts = (st.periods||[]).map(p => `<option value="${esc(p)}"${st.period===p?' selected':''}>${esc(p)}</option>`).join('');

  const filters = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:flex-end">
    <div class="fld" style="flex:1;min-width:120px;margin:0">
      <label style="font-size:11px">Period</label>
      <select id="cmpPeriod" style="width:100%">
        <option value="">All Periods</option>${periodOpts}
      </select>
    </div>
    <div class="fld" style="flex:1;min-width:110px;margin:0">
      <label style="font-size:11px">Unit Code</label>
      <input id="cmpUnit" placeholder="e.g. JA0" value="${esc(st.unit)}" style="width:100%">
    </div>
    <div class="fld" style="flex:1;min-width:110px;margin:0">
      <label style="font-size:11px">State</label>
      <input id="cmpState" placeholder="Rajasthan" value="${esc(st.state)}" style="width:100%">
    </div>
    <button class="btn sm pri" onclick="cmpApplyFilter()">Filter</button>
    <button class="btn sm" onclick="const s=_cmpState();s.unit='';s.state='';s.period='';s.rows=undefined;_cmpLoad();render()">Clear</button>
  </div>`;

  const actions = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
    <button class="btn sm" onclick="cmpDownloadTemplate()">⬇ Download Template</button>
    <button class="btn sm" onclick="cmpUploadModal()">⬆ Upload Excel</button>
    <button class="btn sm pri" onclick="cmpAddModal()">+ Add Entry</button>
  </div>`;

  let tableHtml = '';
  if (st.loading || st.rows === undefined) {
    tableHtml = `<div class="card pad" style="text-align:center;color:var(--muted);padding:28px">Loading…</div>`;
  } else if (!st.rows.length) {
    tableHtml = `<div class="card pad" style="text-align:center;padding:32px">
      <div style="font-size:28px;margin-bottom:10px">📊</div>
      <div style="font-weight:700;margin-bottom:6px">No data yet</div>
      <div style="font-size:13px;color:var(--ink-2);margin-bottom:16px">Download the Excel template, fill in competitor data, then upload it. Or use "+ Add Entry" to enter data manually.</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn pri" onclick="cmpDownloadTemplate()">⬇ Download Template</button>
        <button class="btn" onclick="cmpAddModal()">+ Add Entry</button>
      </div>
    </div>`;
  } else {
    const compCols = [1,2,3,4,5];
    const rows = st.rows.map(r => {
      const totalComp = compCols.reduce((s,i) => s + (Number(r[`comp${i}_supply`])||0), 0);
      const totalMkt  = (Number(r.our_supply)||0) + totalComp;
      const share     = totalMkt > 0 ? Math.round((Number(r.our_supply)||0) / totalMkt * 100) : 0;
      const shareColor = share >= 60 ? 'var(--grn)' : share >= 40 ? 'var(--gold)' : 'var(--red)';
      const comps = compCols.map(i => r[`comp${i}_name`] ? `${esc(r[`comp${i}_name`])} (${(Number(r[`comp${i}_supply`])||0).toLocaleString('en-IN')})` : '').filter(Boolean).join(', ');
      return `<tr>
        <td>${esc(r.period)}</td>
        <td>${esc(r.unit_name||r.unit_code)}</td>
        <td>${esc(r.agent_code||'—')}</td>
        <td>${esc(r.agent_name||'—')}</td>
        <td class="r num">${(Number(r.our_supply)||0).toLocaleString('en-IN')}</td>
        <td style="font-size:11px;max-width:200px">${comps||'—'}</td>
        <td class="r num" style="color:${shareColor};font-weight:700">${share}%</td>
        <td><button class="btn sm" style="color:var(--red);padding:2px 8px" onclick="cmpDelete(${r.id})">✕</button></td>
      </tr>`;
    }).join('');
    tableHtml = `<div class="tablewrap"><table>
      <thead><tr>
        <th>Period</th><th>Unit</th><th>${label} Code</th><th>${label} Name</th>
        <th class="r">Our Copies</th><th>Competitors</th><th class="r">Share</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div style="font-size:12px;color:var(--ink-2);margin-top:8px">${st.total} total records${st.total>st.rows.length?` — showing ${st.rows.length}`:''}.</div>`;
  }

  return pagehead('Competitor Data', `Market share tracking — ${label}-wise competitor circulation data`) +
    tabBar + filters + actions + `<div class="card" style="padding:16px">${tableHtml}</div>`;
};

/* ---- Email Config (moved out of Strategic AI Nexus into Administration) ---- */
VIEWS.email_config = () => {
  return pagehead('Email Config', 'Unit-wise recipients for AI Insights one-click alerts') +
    `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn" onclick="_aiLoadCfg(true);render()">↻ Refresh</button>
    </div>
    ${_aiCfgTab(_aiState())}`;
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
  return (S.user && S.user.isAdmin) ? true : (action === 'view');
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
    isAdmin:    !!u.isAdmin,
    navScreens: u.navScreens ? [...u.navScreens] : [...defaultScreens],
    modules:    [...(u.modules || [])],
    perms:      u.perms ? JSON.parse(JSON.stringify(u.perms)) : {},
  };
  render();
};
window.mrToggleAdmin = () => {
  if (!S.live.mr?.edit) return;
  S.live.mr.edit.isAdmin = !S.live.mr.edit.isAdmin;
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
  const body = {
    person_code: mr.sel,
    dashboard:   mr.edit.dashboard,
    nav_screens: mr.edit.navScreens,
    modules:     mr.edit.modules,
    perms:       mr.edit.perms,
  };
  // Only a real Level-1 admin can grant/revoke Admin status (backend enforces this too) —
  // omit the field entirely otherwise so it's never sent as an unintended change.
  if (S.user?.hierarchyLevel === 1) body.is_admin = mr.edit.isAdmin;
  const res = await api.post('/api/admin/permissions', body);
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
          ${u.isAdmin ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:#dbeafe;color:#1e40af;flex:none" title="Admin status">🛡️ Admin</span>` : ''}
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

      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin-bottom:8px">Admin Status</div>
      ${S.user?.hierarchyLevel === 1 ? `
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 10px;border-radius:8px;background:${edit.isAdmin ? 'var(--gold-l,#fef3c7)' : 'var(--surface-2)'};margin-bottom:6px"
             onclick="mrToggleAdmin()">
        ${chk(edit.isAdmin)}
        <span style="font-size:13px">🛡️ Admin — sees the Administration section (independent of hierarchy level / data scope)</span>
      </label>
      <div style="font-size:11px;color:var(--ink-2);margin-bottom:16px">Grants elevated status without widening this user's data scope. Once checked, tick which Administration screens below they can actually open — leave all unchecked and they're Admin in name only, with no admin screens visible.</div>
      ` : `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--surface-2);margin-bottom:16px">
        ${chk(edit.isAdmin)}
        <span style="font-size:13px;color:var(--ink-2)">🛡️ Admin ${edit.isAdmin ? '— granted' : '— not granted'} <i>(only a Level-1 administrator can change this)</i></span>
      </div>
      `}

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

      ${edit.isAdmin ? `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--ink-2);margin-bottom:8px">Visible Administration Screens</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:16px">
        ${ADMIN_MENU.map(([id, label, icon]) => `
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

/* Field apps: Agent & DCR are native modules (defined above); Hawker/Survey/Taxi open
   their real prototype via iframe (app_<key>). Legacy in-SPA field screens removed here. */

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
  return location.origin + sdvQS('/api/survey/report/' + endpoint);
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
  // PAN-India admin default (Rajasthan / Jaipur RP) — only on first load; the state
  // code 'RA0' matches /api/readers/filters's own state option values.
  if (S.live.sdvState === undefined && _isPanIndiaAdmin()) {
    S.live.sdvState = 'RA0'; S.live.sdvUnit = 'JA0';
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
  const push = (label, items) => { if (items.length) groups.push({ label, items }); };

  if (u.dashboard) {
    const fieldIds = ["routes", "collections", "complaints", "partners"];
    // mgmtIds are always shown to hl≤4 regardless of saved navScreens (handles screens added after a user's navScreens was last saved)
    const mgmtIds  = ["command", "ai_nexus", "supply_dash", "exec_perf", "agency_rating"];
    const allowed = DASH_MENU
      .filter(([id]) => (hl <= 4 && mgmtIds.includes(id)) || (u.navScreens ? u.navScreens.includes(id) : (hl <= 4 || fieldIds.includes(id))))
      .filter(([id]) => permAllows(id, 'view') !== false);  // explicit rights-matrix deny hides the screen
    const mk = ([id, l, ic]) => ({ id, label: l, icon: ic, badge: id === "approvals" ? APPROVALS.length : 0 });
    const placed = new Set(DASH_SECTIONS.flatMap(([, ids]) => ids));
    DASH_SECTIONS.forEach(([label, ids], i) => {
      // Last section also sweeps up anything not assigned to a section, so a newly
      // added DASH_MENU screen shows up rather than vanishing from the menu.
      const isLast = i === DASH_SECTIONS.length - 1;
      const inSection = allowed.filter(([id]) => ids.includes(id) || (isLast && !placed.has(id)));
      // Order within a section follows the section's own id list, not DASH_MENU order,
      // so the menu reads exactly as declared above. Unassigned strays sort last.
      inSection.sort((a, b) => {
        const ia = ids.indexOf(a[0]), ib = ids.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      push(label, inSection.map(mk));
    });
  }

  if (u.modules.includes('survey')) {
    push("◈ Reader Intelligence", [{ id: "readers_connect", label: "Readers Connect", icon: "📍", badge: 0 }]);
  }

  const apps = u.modules.filter(k => permAllows(k, 'view') !== false).map(k => ({ key: k, ...APP_MENU[k] }));
  const SHOW_FIELD_APPS_NAV = false; // hidden per request 2026-08-24 — not deleted, re-enable when ready to surface these
  if (SHOW_FIELD_APPS_NAV && apps.length) groups.push({ label: "Field Apps", apps });

  // Admin-gated screens, split for readability into Planning vs Administration.
  // Gate is unchanged: real Level-1 admins see all; a limited admin sees only what
  // their navScreens override grants.
  const adminAllowed = !u.isAdmin ? [] : ADMIN_MENU
    .filter(([id]) => hl === 1 || !u.navScreens || u.navScreens.includes(id))
    .filter(([id]) => permAllows(id, 'view') !== false)
    .map(([id, l, ic]) => ({ id, label: l, icon: ic }));

  const planning = adminAllowed.filter(x => PLANNING_IDS.includes(x.id));
  // Competitor Data has always been reachable by hl 2–3 data-entry users who are NOT
  // admins (it used to sit in its own "Data Entry" group). Regrouping must not quietly
  // take that away, so it is re-added here for them.
  if (!u.isAdmin && hl > 1 && hl <= 3 && permAllows('competitor_data', 'view') !== false) {
    planning.push({ id: "competitor_data", label: "Competitor Data", icon: "📊" });
  }
  planning.sort((a, b) => PLANNING_IDS.indexOf(a.id) - PLANNING_IDS.indexOf(b.id));
  push("◎ Planning & Targets", planning);
  push("⚙ Administration", adminAllowed.filter(x => !PLANNING_IDS.includes(x.id)));

  return groups;
}

function sideHTML() {
  const groups = navGroups();
  let html = `<button class="nav-item ${S.screen === "home" ? "on" : ""}" onclick="go('home')" style="margin-top:10px"><span class="nico">🏠</span><span>Home — My Modules</span></button>`;
  const collapsed = navCollapsedMap();
  for (const g of groups) {
    // A collapsed section still expands itself while it holds the current screen, so
    // the highlighted item can never be hidden from the user who is standing on it.
    const hasActive = (g.items || []).some(i => i.id === S.screen)
      || (g.apps || []).some(a => S.screen === 'app_' + a.key || String(S.screen).indexOf(a.key + '_') === 0);
    const open = !collapsed[g.label] || hasActive;
    const count = (g.items || g.apps || []).length;
    html += `<button class="sb-lbl sb-grp" onclick="toggleNavSection('${String(g.label).replace(/'/g, "\\'")}')"
      aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'} ${esc(g.label)}">
      <span>${g.label}</span>
      ${!open && count ? `<span class="sb-cnt">${count}</span>` : ''}
      <span class="chev ${open ? 'open' : ''}">▸</span></button>`;
    if (!open) continue;
    if (g.items) html += g.items.map(i => `<button class="nav-item ${S.screen === i.id ? "on" : ""}" onclick="go('${i.id}')">
      <span class="nico">${i.icon}</span><span>${i.label}</span>${i.badge ? `<span class="cnt num">${i.badge}</span>` : ""}</button>`).join("");
    if (g.apps) html += g.apps.map(a => {
      const scr = "app_" + a.key;
      const nm = (APP_META[a.key] && APP_META[a.key].name) || a.label;
      const inApp = S.screen === scr || String(S.screen).indexOf(a.key + "_") === 0;
      const mods = a.key === "agent" ? (typeof AGENT_MODULES !== "undefined" ? AGENT_MODULES : null)
        : a.key === "dcr" ? (typeof DCR_MODULES !== "undefined" ? DCR_MODULES : null) : null;
      let h = `<button class="nav-item ${S.screen === scr ? "on" : ""}" onclick="go('${scr}')">
        <span class="nico" style="background:${a.tint}">${a.icon}</span><span>${nm}</span></button>`;
      // When inside an app that has feature modules, expand them in the sidebar for easy access
      if (inApp && mods) {
        h += `<div class="subnav">${mods.map(m => `<button class="nav-item ${S.screen === m.screen ? "on" : ""}" onclick="go('${m.screen}')"><span>${m.icon} ${m.label}</span></button>`).join("")}</div>`;
      }
      return h;
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
  } else if (u.modules && u.modules.length) {
    const nm = k => (APP_META[k] && APP_META[k].name) || APP_MENU[k].label.split(" ")[0];
    items.push(["app_" + u.modules[0], nm(u.modules[0]), APP_MENU[u.modules[0]].icon]);
    if (u.modules[1]) items.push(["app_" + u.modules[1], nm(u.modules[1]), APP_MENU[u.modules[1]].icon]);
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
  // Full innerHTML replacement below discards scroll position — preserve it across
  // in-place re-renders (a toggle/filter click) so the page doesn't jump to the top.
  // Real navigation (go()) explicitly resets scrollTop=0 right after calling render(),
  // so that case still works as before.
  const prevMain = $(".main");
  const prevScroll = prevMain ? prevMain.scrollTop : 0;
  const view = VIEWS[S.screen] || VIEWS.home;
  app.innerHTML = `<div class="shell">
    <header class="topbar">
      <button class="menu-btn" onclick="toggleSide()" aria-label="Menu">☰</button>
      <div class="brand"><img src="assets/patrika-logo.png" alt="Patrika"><div class="bt"><b>Patrika Vitran</b><small>Circulation Suite</small></div></div>
      <div class="top-sp"></div>
      <span class="top-date" title="Today">${TODAY}</span>
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
  const newMain = $(".main");
  if (newMain && prevScroll) newMain.scrollTop = prevScroll;
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
