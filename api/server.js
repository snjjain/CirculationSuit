'use strict';

/**
 * Patrika Vitran Suite — REST API server (Node.js / Express + MySQL)
 */

const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const path    = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ── Configuration ─────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host:        process.env.MYSQL_HOST     || 'localhost',
  port:        parseInt(process.env.MYSQL_PORT || '3306', 10),
  database:    process.env.MYSQL_DB       || 'patrika_vitran',
  user:        process.env.MYSQL_USER     || 'root',
  password:    process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit:    10,
  dateStrings: true,   // return DATE/DATETIME as 'YYYY-MM-DD' strings
};

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:8123').split(',');
const API_PORT     = parseInt(process.env.API_PORT || '8000', 10);

const pool = mysql.createPool(DB_CONFIG);

// pool.execute() returns [rows, fields] — this wrapper gives a pg-like { rows } interface
async function q(sql, params) {
  const [rows] = await pool.execute(sql, params || []);
  return { rows };
}
// For transactions, get a raw connection
async function getConn() { return pool.getConnection(); }

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Look up user id from mobile number.
 * `runner` is either the pool or a pg PoolClient so this works inside
 * both plain reads and transactions.
 */
async function userIdFromMobile(runner, mobile) {
  if (!mobile) return null;
  const [rows] = await runner.execute('SELECT id FROM users WHERE mobile = ?', [mobile]);
  return rows.length ? rows[0].id : null;
}

/** Two-letter avatar from full name */
function _avatar(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '??';
}

/**
 * Convert a pg result row so dates become ISO strings.
 * NUMERIC and BIGINT are already handled by the type parsers above;
 * this cleans up any remaining Date objects from timestamp columns.
 */
function _clean(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

/** Haversine distance in km between two lat/lon points */
function _haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(parseFloat(lat1));
  const p2 = toRad(parseFloat(lat2));
  const dp = toRad(parseFloat(lat2) - parseFloat(lat1));
  const dl = toRad(parseFloat(lon2) - parseFloat(lon1));
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

// ── user_permissions table ────────────────────────────────────────────────────
// Created once on startup; stores per-person overrides over LEVEL_META defaults
;(async () => {
  await q(`CREATE TABLE IF NOT EXISTS user_permissions (
    person_code VARCHAR(20) PRIMARY KEY,
    dashboard   TINYINT(1) DEFAULT NULL COMMENT 'NULL = use LEVEL_META default',
    nav_screens TEXT       DEFAULT NULL COMMENT 'JSON array of screen IDs or NULL',
    modules     TEXT       DEFAULT NULL COMMENT 'JSON array of module keys or NULL',
    updated_at  TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
})().catch(e => console.warn('[startup] user_permissions init:', e.message));

// Ensure dashboard performance indexes exist (idempotent — errors if already present are ignored).
// These make the collection filter-dropdown scans fast (district & agency-name lookups).
;(async () => {
  const idxs = [
    ['agency_collection', 'idx_district',    'district_name'],
    ['agency_collection', 'idx_agcode_name', 'ag_code, ag_name'],
  ];
  for (const [tbl, name, cols] of idxs) {
    try { await q(`CREATE INDEX ${name} ON ${tbl} (${cols})`); }
    catch (_) { /* already exists */ }
  }
})().catch(() => {});

// ── RBAC metadata ─────────────────────────────────────────────────────────────
const LEVEL_META = {
  1:  { roleLabel: 'Admin — Board View',   role: 'admin',            dashboard: true,  modules: ['agent','hawker','dcr','survey','taxi'] },
  2:  { roleLabel: 'Edition Incharge',     role: 'edition_incharge', dashboard: true,  modules: ['agent','dcr','survey'] },
  3:  { roleLabel: 'Circulation Incharge', role: 'circ_incharge',    dashboard: true,  modules: ['agent','dcr'] },
  4:  { roleLabel: 'Zonal Head',           role: 'zonal_head',       dashboard: true,  modules: ['agent','dcr','survey'] },
  5:  { roleLabel: 'VP Circulation',       role: 'vp',               dashboard: true,  modules: ['agent','dcr','survey','taxi'] },
  7:  { roleLabel: 'Field Executive',      role: 'executive',        dashboard: false, modules: ['dcr','survey'] },
  9:  { roleLabel: 'Newspaper Agent',      role: 'agent',            dashboard: false, modules: ['agent'] },
  10: { roleLabel: 'Hawker',               role: 'hawker',           dashboard: false, modules: ['hawker'] },
};

/** Map hierarchy level → column name in hierarchy_mapping */
const LEVEL_COL = {
  5: 'vp_circulation_code',
  4: 'zonal_head_code',
  3: 'circ_incharge_code',
  2: 'edtn_incharge_code',
};

/**
 * Return the list of unit_codes visible to this user, or null for admin (all).
 * Returns an empty array if no matching units are found.
 */
async function getScopeUnitCodes(personCode, hierarchyLevel) {
  if (hierarchyLevel === 1 || !personCode) return null;

  const col = LEVEL_COL[hierarchyLevel];
  if (col) {
    const { rows } = await q(
      `SELECT DISTINCT unit_code FROM hierarchy_mapping WHERE ${col} = ?`,
      [String(personCode)]
    );
    return rows.map((r) => r.unit_code);
  }

  const { rows } = await q(
    'SELECT unit_code FROM hierarchy_master WHERE person_code = ? AND is_active = 1',
    [String(personCode)]
  );
  const row = rows[0];
  return row && row.unit_code ? [row.unit_code] : [];
}

async function getOuScopeFilter(req) {
  const personCode = req.auth ? (req.auth.personCode || '') : (req.headers['x-person-code'] || '');
  const hl = req.auth ? req.auth.hierarchyLevel : parseInt(req.headers['x-hierarchy-level'] || '1', 10);
  const unitCodes = await getScopeUnitCodes(personCode, hl);
  if (!unitCodes) return { clause: '', params: [] };
  if (!unitCodes.length) return { clause: ' AND 1=0', params: [] };
  const ph = unitCodes.map(() => '?').join(',');
  return { clause: ` AND unit_code IN (${ph})`, params: unitCodes };
}

async function getColScopeFilter(req) {
  const personCode = req.auth ? (req.auth.personCode || '') : (req.headers['x-person-code'] || '');
  const hl = req.auth ? req.auth.hierarchyLevel : parseInt(req.headers['x-hierarchy-level'] || '1', 10);
  const unitCodes = await getScopeUnitCodes(personCode, hl);
  if (!unitCodes) return { clause: '', params: [] };
  if (!unitCodes.length) return { clause: ' AND 1=0', params: [] };
  const ph = unitCodes.map(() => '?').join(',');
  const { rows } = await q(`SELECT branch_code FROM pub_unit_master WHERE unit_code IN (${ph})`, unitCodes);
  const branchCodes = rows.map(r => r.branch_code);
  if (!branchCodes.length) return { clause: ' AND 1=0', params: [] };
  const bph = branchCodes.map(() => '?').join(',');
  return { clause: ` AND LEFT(doc_no, 3) IN (${bph})`, params: branchCodes };
}

async function scopeToTaxiNames(unitCodes) {
  if (!unitCodes || unitCodes.length === 0) return [];
  const ph = unitCodes.map(() => '?').join(',');
  const { rows } = await q(
    `SELECT DISTINCT tdl.unit_name
     FROM taxi_delay_log tdl
     JOIN units u ON (tdl.unit_name = u.unit_name OR tdl.unit_name = CONCAT(u.unit_name, ' RP'))
     WHERE u.unit_code IN (${ph})`,
    unitCodes
  );
  return rows.map((r) => r.unit_name);
}

/** Build  IN (?,?,?)  clause + params array for MySQL from an array value */
function inClause(arr) {
  return { sql: `IN (${arr.map(() => '?').join(',')})`, params: arr };
}

// ── Authentication & authorization (bcrypt + JWT) ───────────────────────────────
// Registers /api/login, /api/auth/*, /api/admin/users*, /api/admin/audit and returns
// the requireAuth/requireAdmin middleware + helpers. Must be set up BEFORE the guard
// so the login/auth routes match first.
const installAuth = require('./auth');
const auth = installAuth({ app, q, getConn, LEVEL_META });

// Guard: every /api/* request must carry a valid JWT, except these public endpoints.
// Identity/scope is taken from verified token claims (req.auth), never from client headers.
const PUBLIC_API = new Set(['/api/login', '/api/health']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.has(req.path)) return next();
  return auth.requireAuth(req, res, next);
});

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await q('SELECT COUNT(*) AS n FROM users');
    res.json({ status: 'ok', users: Number(rows[0].n) });
  } catch (e) {
    res.status(503).json({ status: 'db_error', detail: String(e) });
  }
});

// POST /api/login is now provided by auth.js (bcrypt + JWT). See installAuth() above.

// GET /api/customers
app.get('/api/customers', async (req, res) => {
  try {
    const { rows } = await q('SELECT * FROM customers ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/customers
app.post('/api/customers', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { name, address, phone, plan } = req.body;
    const [result] = await conn.execute(
      'INSERT INTO customers (name, address, mobile, edition, copies, agent_id) VALUES (?,?,?,?,1,?)',
      [name, address, phone, plan, uid]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Customer created ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/stops
app.get('/api/stops', async (req, res) => {
  try {
    const uid = await userIdFromMobile(pool, req.headers['x-user-mobile']);
    if (!uid) return res.json([]);
    const { rows } = await q('SELECT * FROM stops WHERE hawker_id = ? AND trip_date = CURDATE() ORDER BY id', [uid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/stops/:stop_id/mark
app.post('/api/stops/:stop_id/mark', async (req, res) => {
  try {
    await q('UPDATE stops SET status = ?, marked_at = NOW() WHERE id = ?', [req.body.status, parseInt(req.params.stop_id, 10)]);
    res.json({ message: 'Stop updated ✓' });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/payments
app.get('/api/payments', async (req, res) => {
  try {
    const { rows } = await q('SELECT * FROM payments ORDER BY collected_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/payments
app.post('/api/payments', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { customer_name, amount, method, notes = '' } = req.body;
    const [result] = await conn.execute(
      'INSERT INTO payments (amount, collected_by, method, notes) VALUES (?,?,?,?)',
      [amount, uid, method, `${customer_name} · ${notes}`]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Payment recorded ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/complaints
app.get('/api/complaints', async (req, res) => {
  try {
    const { rows } = await q('SELECT * FROM complaints ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/complaints
app.post('/api/complaints', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { customer_name, complaint_type, route, priority, description = '' } = req.body;
    const fullDesc = `Customer: ${customer_name} | Route: ${route} | Priority: ${priority} | ${description}`;
    const [result] = await conn.execute(
      'INSERT INTO complaints (type, description, raised_by) VALUES (?,?,?)',
      [complaint_type, fullDesc, uid]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Complaint logged ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/visits
app.get('/api/visits', async (req, res) => {
  try {
    const uid = await userIdFromMobile(pool, req.headers['x-user-mobile']);
    if (!uid) return res.json([]);
    const { rows } = await q(
      'SELECT * FROM dcr_visits WHERE dcr_id = ? AND visit_date = CURDATE() ORDER BY created_at DESC',
      [uid]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/visits
app.post('/api/visits', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { visit_type, target, outcome, amount = 0, notes = '' } = req.body;
    let note = outcome;
    if (amount) note += ` · collected ₹${amount}`;
    if (notes) note += ` · ${notes}`;
    const [result] = await conn.execute(
      'INSERT INTO dcr_visits (dcr_id, outlet_name, purpose, outcome) VALUES (?,?,?,?)',
      [uid, target, visit_type, note]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Visit saved ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/leads
app.get('/api/leads', async (req, res) => {
  try {
    const uid = await userIdFromMobile(pool, req.headers['x-user-mobile']);
    if (!uid) return res.json([]);
    const { rows } = await q('SELECT * FROM leads WHERE surveyor_id = ? ORDER BY created_at DESC', [uid]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/leads
app.post('/api/leads', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { name, mobile: leadMobile, area, publication, interest } = req.body;
    const lvl = interest.startsWith('High') ? 'hot' : interest.startsWith('Low') ? 'cold' : 'medium';
    const [result] = await conn.execute(
      'INSERT INTO leads (surveyor_id, name, mobile, address, edition, interest) VALUES (?,?,?,?,?,?)',
      [uid, name, leadMobile, area, publication, lvl]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Lead saved ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/trips
app.get('/api/trips', async (req, res) => {
  try {
    const { rows } = await q('SELECT * FROM trips WHERE trip_date = CURDATE() ORDER BY created_at DESC LIMIT 20');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/trips
app.post('/api/trips', async (req, res) => {
  const conn = await getConn();
  try {
    await conn.beginTransaction();
    const uid = await userIdFromMobile(conn, req.headers['x-user-mobile']);
    const { vehicle_no, route, bundles = 0 } = req.body;
    const [result] = await conn.execute(
      'INSERT INTO trips (driver_id, vehicle_no, route_code, bundles) VALUES (?,?,?,?)',
      [uid, vehicle_no, route, bundles]
    );
    await conn.commit();
    res.json({ id: result.insertId, message: 'Trip logged ✓' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ detail: String(e) });
  } finally { conn.release(); }
});

// GET /api/hierarchy/users
app.get('/api/hierarchy/users', async (req, res) => {
  try {
    const { rows } = await q(`
      SELECT hm.id, hm.person_code, hm.person_name, hm.hierarchy_level,
             hm.unit_code, COALESCE(u.unit_name, hm.unit_code) AS unit_name,
             hm.reporting_to, hm.employee_code
      FROM hierarchy_master hm
      LEFT JOIN units u ON u.unit_code = hm.unit_code
      WHERE hm.is_active = 1
      ORDER BY hm.hierarchy_level, hm.person_name
    `);
    // Load per-person permission overrides (table may not exist yet on first run)
    let permMap = {};
    try {
      const { rows: perms } = await q('SELECT person_code, dashboard, nav_screens, modules FROM user_permissions');
      perms.forEach(p => { permMap[p.person_code] = p; });
    } catch (_) {}

    const users = rows.map((r) => {
      const lvl = r.hierarchy_level;
      const meta = LEVEL_META[lvl] || { roleLabel: `Level ${lvl}`, role: 'user', dashboard: false, modules: [] };
      const perm = permMap[r.person_code];
      const unitLabel = lvl === 1 ? 'PAN India' : (r.unit_name || r.unit_code || '');
      return {
        id: r.id,
        person_code: r.person_code,
        name: r.person_name,
        hierarchyLevel: lvl,
        unit_code: r.unit_code,
        scopeLabel: unitLabel,
        roleLabel: meta.roleLabel,
        role: meta.role,
        dashboard:  perm && perm.dashboard !== null ? Boolean(perm.dashboard) : meta.dashboard,
        modules:    perm && perm.modules     ? JSON.parse(perm.modules)     : meta.modules,
        navScreens: perm && perm.nav_screens ? JSON.parse(perm.nav_screens) : null,
        hasOverride: !!perm,
        avatar: _avatar(r.person_name),
        employee_code: r.employee_code,
        reporting_to: r.reporting_to,
      };
    });
    res.json({ users, total: users.length });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/admin/permissions  — all saved overrides
app.get('/api/admin/permissions', async (req, res) => {
  try {
    const { rows } = await q('SELECT * FROM user_permissions ORDER BY updated_at DESC');
    res.json({ permissions: rows });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/admin/permissions  — save or reset a user's overrides (admin only)
app.post('/api/admin/permissions', async (req, res) => {
  try {
    if (!req.auth || req.auth.hierarchyLevel !== 1) return res.status(403).json({ detail: 'Administrator access required' });
    const { person_code, dashboard, nav_screens, modules, perms, reset } = req.body;
    if (!person_code) return res.status(400).json({ detail: 'person_code required' });
    if (reset) {
      await q('DELETE FROM user_permissions WHERE person_code = ?', [person_code]);
      await auth.audit('perms_reset', { actor: req.auth.personCode, target: person_code, ip: auth.ipOf(req) });
      return res.json({ ok: true, reset: true });
    }
    const dash = (dashboard !== undefined && dashboard !== null) ? (dashboard ? 1 : 0) : null;
    const nav  = nav_screens ? JSON.stringify(nav_screens) : null;
    const mods = modules     ? JSON.stringify(modules)     : null;
    const prm  = perms       ? JSON.stringify(perms)       : null;
    await q(`
      INSERT INTO user_permissions (person_code, dashboard, nav_screens, modules, perms)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE dashboard=VALUES(dashboard), nav_screens=VALUES(nav_screens),
                              modules=VALUES(modules), perms=VALUES(perms), updated_at=CURRENT_TIMESTAMP
    `, [person_code, dash, nav, mods, prm]);
    await auth.audit('perms_update', { actor: req.auth.personCode, target: person_code, ip: auth.ipOf(req) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Date-range helpers ────────────────────────────────────────────────────────

/**
 * Resolve ?from=&to= (range) or ?date= (single day) query params.
 * Returns { from, to } or null when neither is provided (caller falls back
 * to the latest date in its table).
 */
function resolveRange(query) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const { date, from, to } = query;
  if (ok(from) && ok(to)) {
    return from <= to ? { from, to } : { from: to, to: from };
  }
  if (ok(from)) return { from, to: from };
  if (ok(date)) return { from: date, to: date };
  return null;
}

/** Human label for a range: single date or "from to to". */
function rangeLabel(r) {
  return r.from === r.to ? r.from : `${r.from} to ${r.to}`;
}

// ── Dashboard: Delivery ───────────────────────────────────────────────────────

// GET /api/dashboard/delivery
app.get('/api/dashboard/delivery', async (req, res) => {
  try {
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q('SELECT DATE_FORMAT(MAX(report_date),\'%Y-%m-%d\') AS max FROM taxi_delay_log');
      const d = (rows[0] && rows[0].max) ? rows[0].max : new Date().toISOString().slice(0, 10);
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    const taxiNames = unitCodes === null ? null : await scopeToTaxiNames(unitCodes);

    if (taxiNames !== null && taxiNames.length === 0) {
      return res.json({
        date, from: range.from, to: range.to,
        summary: { total_routes:0, total_supply:0, on_time:0, cnt_delayed:0, otd_pct:0, planned_km:0, actual_km:0, delivered_drops:0, active_routes:0, planned_drops:0, missed_drops:0 },
        units: [],
      });
    }

    // taxi_delayed is INT (signed seconds): <= 0 = on-time, > 0 = delayed
    const nameFilter = taxiNames !== null ? inClause(taxiNames) : null;

    const sFilter = nameFilter ? `AND unit_name ${nameFilter.sql}` : '';
    const sParams = nameFilter ? nameFilter.params : [];

    const { rows: [summaryRow] } = await q(`
      SELECT COUNT(*) AS total_routes,
        COALESCE(SUM(supply), 0) AS total_supply,
        COALESCE(SUM(CASE WHEN COALESCE(taxi_delayed,1) <= 0 THEN 1 ELSE 0 END), 0) AS on_time,
        COALESCE(SUM(CASE WHEN COALESCE(taxi_delayed,1)  > 0 THEN 1 ELSE 0 END), 0) AS cnt_delayed,
        COALESCE(ROUND(100.0 * SUM(CASE WHEN COALESCE(taxi_delayed,1) <= 0 THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*),0), 1), 0) AS otd_pct,
        COALESCE(SUM(route_master_km), 0) AS planned_km,
        COALESCE(SUM(total_app_km), 0) AS actual_km
      FROM taxi_delay_log WHERE report_date BETWEEN ? AND ? ${sFilter}
    `, [range.from, range.to, ...sParams]);

    const dFilter = nameFilter ? `AND unit_name ${nameFilter.sql}` : '';
    const dParams = nameFilter ? nameFilter.params : [];

    const { rows: [dropsRow] } = await q(`
      SELECT COUNT(*) AS delivered_drops, COUNT(DISTINCT route_code) AS active_routes
      FROM taxi_drop_point_log WHERE sup_date BETWEEN ? AND ? ${dFilter}
    `, [range.from, range.to, ...dParams]);

    const { rows: [plannedRow] } = await q(`
      SELECT COUNT(*) AS planned_drops
      FROM drop_points_master
      WHERE route_code IN (
        SELECT DISTINCT route_code FROM taxi_drop_point_log
        WHERE sup_date BETWEEN ? AND ? ${dFilter}
      )
    `, [range.from, range.to, ...dParams]);

    let unitsRows;
    if (taxiNames !== null) {
      const ph = inClause(taxiNames);
      const { rows } = await q(`
        SELECT d.unit_name,
          COUNT(*) AS routes,
          COALESCE(SUM(d.supply), 0) AS supply,
          SUM(CASE WHEN COALESCE(d.taxi_delayed,1) <= 0 THEN 1 ELSE 0 END) AS on_time,
          SUM(CASE WHEN COALESCE(d.taxi_delayed,1)  > 0 THEN 1 ELSE 0 END) AS cnt_delayed,
          COALESCE(ROUND(100.0 * SUM(CASE WHEN COALESCE(d.taxi_delayed,1) <= 0 THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*),0), 1), 0) AS otd_pct,
          COALESCE(SUM(d.total_app_km), 0) AS actual_km,
          COALESCE(dp_agg.delivered_drops, 0) AS delivered_drops
        FROM taxi_delay_log d
        LEFT JOIN (
          SELECT unit_name, COUNT(*) AS delivered_drops
          FROM taxi_drop_point_log
          WHERE sup_date BETWEEN ? AND ? AND unit_name ${ph.sql}
          GROUP BY unit_name
        ) dp_agg ON dp_agg.unit_name = d.unit_name
        WHERE d.report_date BETWEEN ? AND ? AND d.unit_name ${ph.sql}
        GROUP BY d.unit_name, dp_agg.delivered_drops
        ORDER BY cnt_delayed DESC, d.unit_name
      `, [range.from, range.to, ...ph.params, range.from, range.to, ...ph.params]);
      unitsRows = rows;
    } else {
      const { rows } = await q(`
        SELECT d.unit_name,
          COUNT(*) AS routes,
          COALESCE(SUM(d.supply), 0) AS supply,
          SUM(CASE WHEN COALESCE(d.taxi_delayed,1) <= 0 THEN 1 ELSE 0 END) AS on_time,
          SUM(CASE WHEN COALESCE(d.taxi_delayed,1)  > 0 THEN 1 ELSE 0 END) AS cnt_delayed,
          COALESCE(ROUND(100.0 * SUM(CASE WHEN COALESCE(d.taxi_delayed,1) <= 0 THEN 1 ELSE 0 END)
            / NULLIF(COUNT(*),0), 1), 0) AS otd_pct,
          COALESCE(SUM(d.total_app_km), 0) AS actual_km,
          COALESCE(dp_agg.delivered_drops, 0) AS delivered_drops
        FROM taxi_delay_log d
        LEFT JOIN (
          SELECT unit_name, COUNT(*) AS delivered_drops
          FROM taxi_drop_point_log WHERE sup_date BETWEEN ? AND ?
          GROUP BY unit_name
        ) dp_agg ON dp_agg.unit_name = d.unit_name
        WHERE d.report_date BETWEEN ? AND ?
        GROUP BY d.unit_name, dp_agg.delivered_drops
        ORDER BY cnt_delayed DESC, d.unit_name
      `, [range.from, range.to, range.from, range.to]);
      unitsRows = rows;
    }

    const summary = _clean(summaryRow) || {};
    const drops = _clean(dropsRow) || {};
    const planned = _clean(plannedRow) || {};
    const missed = Math.max(
      0,
      parseInt(planned.planned_drops || 0) - parseInt(drops.delivered_drops || 0)
    );

    res.json({
      date, from: range.from, to: range.to,
      summary: { ...summary, ...drops, ...planned, missed_drops: missed },
      units: unitsRows.map(_clean),
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/dashboard/routes
app.get('/api/dashboard/routes', async (req, res) => {
  try {
    let { unit_name } = req.query;
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(report_date),'%Y-%m-%d') AS max FROM taxi_delay_log");
      const d = (rows[0] && rows[0].max) ? rows[0].max : '';
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    if (unitCodes !== null) {
      const taxiNames = await scopeToTaxiNames(unitCodes);
      if (!taxiNames.length || !taxiNames.includes(unit_name)) {
        return res.json({ date, unit_name, routes: [] });
      }
    }

    const { rows } = await q(`
      SELECT DATE_FORMAT(report_date,'%Y-%m-%d') AS report_date,
             route_name, sub_route_name, taxi_type, bundles, supply, vehicle_no, is_regular,
             TIME_FORMAT(scheduled_departure,'%H:%i') AS scheduled_departure,
             TIME_FORMAT(actual_departure,'%H:%i') AS actual_departure,
             ROUND(COALESCE(taxi_delayed, 0) / 60, 0) AS delay_minutes,
             COALESCE(route_master_km, 0) AS planned_km,
             COALESCE(total_app_km, 0) AS actual_km,
             (COALESCE(taxi_delayed, 0) > 0) AS is_delayed
      FROM taxi_delay_log
      WHERE report_date BETWEEN ? AND ? AND unit_name = ?
      ORDER BY report_date DESC, is_delayed DESC, route_name
    `, [range.from, range.to, unit_name]);

    res.json({ date, from: range.from, to: range.to, unit_name, routes: rows.map(_clean) });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/dashboard/drop-points
app.get('/api/dashboard/drop-points', async (req, res) => {
  try {
    let { route_code, sub_route } = req.query;
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(sup_date),'%Y-%m-%d') AS max FROM taxi_drop_point_log");
      const d = (rows[0] && rows[0].max) ? rows[0].max : '';
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const routeName = route_code;
    const subRoute  = (sub_route && sub_route !== '-') ? sub_route : null;

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    if (unitCodes !== null) {
      const taxiNames = await scopeToTaxiNames(unitCodes);
      const { rows: rrows } = await q('SELECT unit_name FROM taxi_delay_log WHERE route_name = ? LIMIT 1', [routeName]);
      if (rrows.length && !taxiNames.includes(rrows[0].unit_name)) {
        return res.json({ date, route_name: routeName, delivered_count: 0, missed_count: 0, drop_points: [] });
      }
    }

    const { rows } = await q(`
      SELECT DATE_FORMAT(sup_date,'%Y-%m-%d') AS sup_date, drop_point_name,
             TIME_FORMAT(scheduled_arrival,'%H:%i') AS scheduled_arrival,
             TIME_FORMAT(actual_arrival,'%H:%i') AS actual_arrival,
             ROUND(COALESCE(time_diff, 0) / 60, 0) AS diff_minutes,
             actual_lat, actual_long, reg_lat, reg_long, actual_km, api_distance,
             COALESCE(no_of_packets, 0) AS supply,
             CASE WHEN actual_lat IS NOT NULL AND actual_lat != 0
                       AND actual_long IS NOT NULL AND actual_long != 0
                  THEN 'delivered' ELSE 'missed' END AS status
      FROM taxi_drop_point_log
      WHERE sup_date BETWEEN ? AND ? AND route_name = ?
        ${subRoute ? 'AND sub_route_name = ?' : 'AND sub_route_code IS NULL'}
      ORDER BY sup_date DESC,
               CASE WHEN actual_arrival IS NULL THEN 1 ELSE 0 END,
               CASE WHEN HOUR(actual_arrival) < 12
                    THEN TIME_TO_SEC(actual_arrival) + 86400
                    ELSE TIME_TO_SEC(actual_arrival) END,
               CASE WHEN scheduled_arrival IS NULL THEN 1 ELSE 0 END,
               CASE WHEN HOUR(scheduled_arrival) < 12
                    THEN TIME_TO_SEC(scheduled_arrival) + 86400
                    ELSE TIME_TO_SEC(scheduled_arrival) END
    `, subRoute ? [range.from, range.to, routeName, subRoute] : [range.from, range.to, routeName]);

    const allDrops = rows.map(_clean);
    const delivered = allDrops.filter((r) => r.status === 'delivered');
    const missed = allDrops.filter((r) => r.status === 'missed');
    const totalKm = Math.round(
      allDrops.slice(1).filter(r => r.scheduled_arrival || r.actual_arrival)
        .reduce((s, r) => s + (parseFloat(r.api_distance) || 0), 0) * 100
    ) / 100;

    res.json({
      date, from: range.from, to: range.to,
      route_name: routeName,
      delivered_count: delivered.length,
      missed_count: missed.length,
      total_km: totalKm,
      drop_points: [...delivered, ...missed],
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Dashboard: Outstanding ────────────────────────────────────────────────────

// GET /api/dashboard/outstanding
app.get('/api/dashboard/outstanding', async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    let date;
    if (range) {
      const { rows } = await q(
        "SELECT DATE_FORMAT(MAX(report_date),'%Y-%m-%d') AS max FROM agency_outstanding WHERE report_date BETWEEN ? AND ?",
        [range.from, range.to]
      );
      date = (rows[0] && rows[0].max) ? rows[0].max : '';
    } else {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(report_date),'%Y-%m-%d') AS max FROM agency_outstanding");
      date = (rows[0] && rows[0].max) ? rows[0].max : '';
    }
    if (!date) return res.json({ date, summary: {}, units: [] });

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    let scopeFilter = '';
    let scopeParams = [];

    if (unitCodes === null) {
      // Admin: no filter
    } else if (unitCodes.length === 0) {
      return res.json({ date, summary: {}, units: [] });
    } else {
      const ph = inClause(unitCodes);
      const { rows: aoRows } = await q(`
        SELECT DISTINCT ao.unit_name FROM agency_outstanding ao
        JOIN units u ON (
          ao.unit_name = u.unit_name OR ao.unit_name = CONCAT(u.unit_name, ' RP')
          OR ao.unit_name = CONCAT(u.unit_name, ' PT') OR ao.unit_name = CONCAT(u.unit_name, ' DN')
        )
        WHERE u.unit_code ${ph.sql}
      `, ph.params);
      const aoNames = aoRows.map((r) => r.unit_name);
      if (!aoNames.length) return res.json({ date, summary: {}, units: [] });
      const nph = inClause(aoNames);
      scopeFilter = `AND unit_name ${nph.sql}`;
      scopeParams = nph.params;
    }

    const queryParams = [date, ...scopeParams];

    const { rows: [summaryRow] } = await q(`
      SELECT COUNT(*) AS total_agencies,
          SUM(CASE WHEN COALESCE(closing_debit,0) > 0 THEN 1 ELSE 0 END) AS outstanding_agencies,
          COALESCE(SUM(closing_debit), 0) AS total_outstanding,
          COALESCE(SUM(closing_credit), 0) AS total_advance,
          COALESCE(SUM(bill_amount), 0) AS total_bill,
          COALESCE(SUM(receipt_amount), 0) AS total_collected,
          COALESCE(ROUND(AVG(collection_pct), 1), 0) AS avg_collection_pct
      FROM agency_outstanding WHERE report_date = ? ${scopeFilter}
    `, queryParams);

    const { rows: unitsRows } = await q(`
      SELECT unit_name,
          COUNT(*) AS agency_count,
          SUM(CASE WHEN COALESCE(closing_debit,0) > 0 THEN 1 ELSE 0 END) AS outstanding_count,
          COALESCE(SUM(closing_debit), 0) AS outstanding,
          COALESCE(SUM(closing_credit), 0) AS advance,
          COALESCE(SUM(bill_amount), 0) AS bill_amount,
          COALESCE(SUM(receipt_amount), 0) AS collected,
          COALESCE(ROUND(AVG(collection_pct), 1), 0) AS avg_collection_pct
      FROM agency_outstanding WHERE report_date = ? ${scopeFilter}
      GROUP BY unit_name ORDER BY outstanding DESC
    `, queryParams);

    res.json({
      date,
      summary: _clean(summaryRow) || {},
      units: unitsRows.map(_clean),
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/dashboard/outstanding/agencies
app.get('/api/dashboard/outstanding/agencies', async (req, res) => {
  try {
    let { unit_name } = req.query;
    const range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    let date;
    if (range) {
      const { rows } = await q(
        "SELECT DATE_FORMAT(MAX(report_date),'%Y-%m-%d') AS max FROM agency_outstanding WHERE report_date BETWEEN ? AND ?",
        [range.from, range.to]
      );
      date = (rows[0] && rows[0].max) ? rows[0].max : '';
    } else {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(report_date),'%Y-%m-%d') AS max FROM agency_outstanding");
      date = (rows[0] && rows[0].max) ? rows[0].max : '';
    }
    if (!date) return res.json({ date, unit_name, agencies: [] });

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    if (unitCodes !== null && unitCodes.length > 0) {
      const ph = inClause(unitCodes);
      const { rows: checkRows } = await q(`
        SELECT 1 FROM agency_outstanding ao
        JOIN units u ON (
          ao.unit_name = u.unit_name OR ao.unit_name = CONCAT(u.unit_name, ' RP')
          OR ao.unit_name = CONCAT(u.unit_name, ' PT') OR ao.unit_name = CONCAT(u.unit_name, ' DN')
        )
        WHERE ao.unit_name = ? AND u.unit_code ${ph.sql} LIMIT 1
      `, [unit_name, ...ph.params]);
      if (!checkRows.length) return res.json({ date, unit_name, agencies: [] });
    }

    const { rows } = await q(`
      SELECT ag_code, agency_name, executive, status, drop_point, district, zonal_head,
             total_copies, daily_copies,
             COALESCE(security_deposit, 0) AS security_deposit,
             COALESCE(required_security, 0) AS required_security,
             COALESCE(security_diff, 0) AS security_diff,
             COALESCE(opening_debit, 0) AS opening_debit,
             COALESCE(opening_credit, 0) AS opening_credit,
             COALESCE(bill_amount, 0) AS bill_amount,
             COALESCE(other_debits, 0) AS other_debits,
             COALESCE(receipt_amount, 0) AS receipt_amount,
             COALESCE(other_credits, 0) AS other_credits,
             COALESCE(closing_debit, 0) AS closing_debit,
             COALESCE(closing_credit, 0) AS closing_credit,
             COALESCE(collection_pct, 0) AS collection_pct,
             mobile_no, agency_type,
             DATE_FORMAT(supply_start_date,'%Y-%m-%d') AS supply_start_date, supply_days,
             DATE_FORMAT(last_supply_date,'%Y-%m-%d') AS last_supply_date, last_supply_post
      FROM agency_outstanding
      WHERE report_date = ? AND unit_name = ?
      ORDER BY CASE WHEN closing_debit IS NULL THEN 1 ELSE 0 END, closing_debit DESC, agency_name
    `, [date, unit_name]);

    res.json({ date, unit_name, agencies: rows.map(_clean) });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Dashboard: Supply ─────────────────────────────────────────────────────────

// GET /api/dashboard/supply
app.get('/api/dashboard/supply', async (req, res) => {
  try {
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(supply_date),'%Y-%m-%d') AS max FROM daily_supply");
      const d = (rows[0] && rows[0].max) ? rows[0].max : '';
      if (!d) return res.json({ date: '', summary: {}, units: [] });
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    let scopeFilter = '';
    let scopeParams = [];

    if (unitCodes === null) {
      // Admin
    } else if (unitCodes.length === 0) {
      return res.json({ date, summary: {}, units: [] });
    } else {
      const ph = inClause(unitCodes);
      const { rows: scopeRows } = await q(`
        SELECT DISTINCT ds.unit_name FROM daily_supply ds
        JOIN units u ON (
          ds.unit_name = u.unit_name OR ds.unit_name = CONCAT(u.unit_name, ' RP')
          OR ds.unit_name = CONCAT(u.unit_name, ' PT') OR ds.unit_name = CONCAT(u.unit_name, ' DN')
        )
        WHERE u.unit_code ${ph.sql}
      `, ph.params);
      const scopeNames = scopeRows.map((r) => r.unit_name);
      if (!scopeNames.length) return res.json({ date, summary: {}, units: [] });
      const nph = inClause(scopeNames);
      scopeFilter = `AND unit_name ${nph.sql}`;
      scopeParams = nph.params;
    }

    const queryParams = [range.from, range.to, ...scopeParams];

    const { rows: [summaryRow] } = await q(`
      SELECT COUNT(DISTINCT ag_code) AS total_agencies,
          COALESCE(SUM(copies_supplied), 0) AS total_copies,
          COALESCE(AVG(copies_supplied), 0) AS avg_copies,
          COUNT(DISTINCT CASE WHEN copies_supplied > 0 THEN ag_code END) AS active_agencies
      FROM daily_supply WHERE supply_date BETWEEN ? AND ? ${scopeFilter}
    `, queryParams);

    const { rows: unitsRows } = await q(`
      SELECT unit_name,
          COUNT(DISTINCT ag_code) AS agencies,
          COALESCE(SUM(copies_supplied), 0) AS total_copies,
          COALESCE(AVG(copies_supplied), 0) AS avg_copies
      FROM daily_supply WHERE supply_date BETWEEN ? AND ? ${scopeFilter}
      GROUP BY unit_name ORDER BY total_copies DESC
    `, queryParams);

    res.json({
      date, from: range.from, to: range.to,
      summary: _clean(summaryRow) || {},
      units: unitsRows.map(_clean),
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// GET /api/dashboard/supply/agencies
app.get('/api/dashboard/supply/agencies', async (req, res) => {
  try {
    let { unit_name } = req.query;
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(supply_date),'%Y-%m-%d') AS max FROM daily_supply");
      const d = (rows[0] && rows[0].max) ? rows[0].max : '';
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    if (unitCodes !== null && unitCodes.length > 0) {
      const ph = inClause(unitCodes);
      const { rows: checkRows } = await q(`
        SELECT 1 FROM daily_supply ds
        JOIN units u ON (
          ds.unit_name = u.unit_name OR ds.unit_name = CONCAT(u.unit_name, ' RP')
          OR ds.unit_name = CONCAT(u.unit_name, ' PT') OR ds.unit_name = CONCAT(u.unit_name, ' DN')
        )
        WHERE ds.unit_name = ? AND u.unit_code ${ph.sql} LIMIT 1
      `, [unit_name, ...ph.params]);
      if (!checkRows.length) return res.json({ date, unit_name, agencies: [] });
    }

    const { rows } = await q(`
      SELECT ag_code, MAX(agency_name) AS agency_name, MAX(executive) AS executive,
             MAX(zonal_head) AS zonal_head,
             COALESCE(SUM(copies_supplied), 0) AS copies_supplied
      FROM daily_supply
      WHERE supply_date BETWEEN ? AND ? AND unit_name = ?
      GROUP BY ag_code
      ORDER BY CASE WHEN copies_supplied IS NULL THEN 1 ELSE 0 END, copies_supplied DESC, agency_name
    `, [range.from, range.to, unit_name]);

    res.json({ date, from: range.from, to: range.to, unit_name, agencies: rows.map(_clean) });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Dashboard: Collection ─────────────────────────────────────────────────────

// GET /api/dashboard/collection
app.get('/api/dashboard/collection', async (req, res) => {
  try {
    let range = resolveRange(req.query);
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = hlRaw && /^\d+$/.test(hlRaw) ? parseInt(hlRaw, 10) : 1;

    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(collection_date),'%Y-%m-%d') AS max FROM daily_collection");
      const d = (rows[0] && rows[0].max) ? rows[0].max : '';
      if (!d) return res.json({ date: '', summary: {}, units: [] });
      range = { from: d, to: d };
    }
    const date = rangeLabel(range);

    const unitCodes = await getScopeUnitCodes(personCode, hl);
    let scopeFilter = '';
    let scopeParams = [];

    if (unitCodes === null) {
      // Admin
    } else if (unitCodes.length === 0) {
      return res.json({ date, summary: {}, units: [] });
    } else {
      const ph = inClause(unitCodes);
      const { rows: scopeRows } = await q(`
        SELECT DISTINCT dc.unit_name FROM daily_collection dc
        JOIN units u ON (
          dc.unit_name = u.unit_name OR dc.unit_name = CONCAT(u.unit_name, ' RP')
          OR dc.unit_name = CONCAT(u.unit_name, ' PT') OR dc.unit_name = CONCAT(u.unit_name, ' DN')
        )
        WHERE u.unit_code ${ph.sql}
      `, ph.params);
      const scopeNames = scopeRows.map((r) => r.unit_name);
      if (!scopeNames.length) return res.json({ date, summary: {}, units: [] });
      const nph = inClause(scopeNames);
      scopeFilter = `AND unit_name ${nph.sql}`;
      scopeParams = nph.params;
    }

    const queryParams = [range.from, range.to, ...scopeParams];

    const { rows: [summaryRow] } = await q(`
      SELECT COUNT(*) AS total_transactions,
          COALESCE(SUM(amount), 0) AS total_collected,
          COALESCE(SUM(CASE WHEN sale_type='CREDIT' THEN amount END), 0) AS credit_collection,
          COALESCE(SUM(CASE WHEN sale_type='CASH' THEN amount END), 0) AS cash_collection,
          COALESCE(SUM(CASE WHEN payment_mode IN ('UPI','NEFT','CHEQUE','GATEWAY','DEMAND DRAFT')
            THEN amount END), 0) AS digital_collection,
          COALESCE(SUM(CASE WHEN payment_mode='CASH' THEN amount END), 0) AS physical_cash,
          COUNT(DISTINCT ag_code) AS agencies_paid
      FROM daily_collection WHERE collection_date BETWEEN ? AND ? ${scopeFilter}
    `, queryParams);

    const { rows: unitsRows } = await q(`
      SELECT unit_name,
          COUNT(*) AS transactions,
          COALESCE(SUM(amount), 0) AS total_collected,
          COALESCE(SUM(CASE WHEN sale_type='CREDIT' THEN amount END), 0) AS credit_collection,
          COALESCE(SUM(CASE WHEN sale_type='CASH' THEN amount END), 0) AS cash_collection,
          COALESCE(SUM(CASE WHEN payment_mode IN ('UPI','NEFT','CHEQUE','GATEWAY','DEMAND DRAFT')
            THEN amount END), 0) AS digital_collection,
          COUNT(DISTINCT ag_code) AS agencies_paid
      FROM daily_collection WHERE collection_date BETWEEN ? AND ? ${scopeFilter}
      GROUP BY unit_name ORDER BY total_collected DESC
    `, queryParams);

    res.json({
      date, from: range.from, to: range.to,
      summary: _clean(summaryRow) || {},
      units: unitsRows.map(_clean),
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Supply Issues Reports ─────────────────────────────────────────────────────

// GET /api/reports/supply-issues?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns: taxis that reached last drop after 06:00, AND taxis with 0 app km
app.get('/api/reports/supply-issues', async (req, res) => {
  try {
    let range = resolveRange(req.query);
    if (!range) {
      const { rows } = await q("SELECT DATE_FORMAT(MAX(sup_date),'%Y-%m-%d') AS mx FROM taxi_drop_point_log");
      const d = rows[0]?.mx || '';
      range = { from: d, to: d };
    }

    // ── Scope filtering (same pattern as dashboard endpoints) ──────────────────
    const personCode = req.headers['x-person-code'] || '';
    const hlRaw = req.headers['x-hierarchy-level'];
    const hl = (hlRaw && /^\d+$/.test(hlRaw)) ? parseInt(hlRaw, 10) : 1;
    const unitCodes = await getScopeUnitCodes(personCode, hl);
    const taxiNames = unitCodes === null ? null : await scopeToTaxiNames(unitCodes);

    if (taxiNames !== null && taxiNames.length === 0) {
      return res.json({ from: range.from, to: range.to, dates: [], late: [], app_not_running: [] });
    }

    // Build optional WHERE fragment to restrict to this user's units
    let scopeClause = '';
    let scopeParams = [];
    if (taxiNames !== null) {
      const ic = inClause(taxiNames);
      scopeClause = ` AND tdl.unit_name ${ic.sql}`;
      scopeParams = ic.params;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Hierarchy subquery: one state/zone per unit (MAX collapses multiple exec rows)
    const HM_JOIN = `
      LEFT JOIN (
        SELECT unit_name,
               MAX(vp_circulation_name) AS state_name,
               MAX(zonal_head_name)     AS zone_name
        FROM hierarchy_mapping
        GROUP BY unit_name
      ) hm ON hm.unit_name = tdl.unit_name`;

    // 1. Late taxis: any delivery between 06:00 and 22:59 means driver arrived past 6 AM
    const { rows: lateRows } = await q(`
      SELECT tdl.unit_name,
             COALESCE(hm.state_name, 'State Unknown') AS state_name,
             COALESCE(hm.zone_name,  'Zone Unknown')  AS zone_name,
             tdl.route_name,
             COALESCE(NULLIF(tdl.sub_route_name,''), '-') AS sub_route_name,
             DATE_FORMAT(tdl.sup_date,'%Y-%m-%d')         AS rpt_date,
             TIME_FORMAT(
               MAX(CASE WHEN HOUR(tdl.actual_arrival) BETWEEN 6 AND 22 THEN tdl.actual_arrival END),
             '%H:%i') AS last_late
      FROM taxi_drop_point_log tdl
      ${HM_JOIN}
      WHERE tdl.sup_date BETWEEN ? AND ?
        AND tdl.actual_arrival IS NOT NULL
        ${scopeClause}
      GROUP BY tdl.unit_name, hm.state_name, hm.zone_name, tdl.route_name, tdl.sub_route_name, tdl.sup_date
      HAVING MAX(CASE WHEN HOUR(tdl.actual_arrival) BETWEEN 6 AND 22 THEN tdl.actual_arrival END) IS NOT NULL
      ORDER BY hm.state_name, hm.zone_name, tdl.unit_name, tdl.route_name, tdl.sub_route_name, tdl.sup_date
    `, [range.from, range.to, ...scopeParams]);

    // 2. App-not-running: total_app_km = 0 in taxi_delay_log
    const { rows: appRows } = await q(`
      SELECT tdl.unit_name,
             COALESCE(hm.state_name, 'State Unknown') AS state_name,
             COALESCE(hm.zone_name,  'Zone Unknown')  AS zone_name,
             tdl.route_name,
             COALESCE(NULLIF(tdl.sub_route_name,''), '-') AS sub_route_name,
             DATE_FORMAT(tdl.report_date,'%Y-%m-%d')      AS rpt_date,
             tdl.vehicle_no
      FROM taxi_delay_log tdl
      LEFT JOIN (
        SELECT unit_name,
               MAX(vp_circulation_name) AS state_name,
               MAX(zonal_head_name)     AS zone_name
        FROM hierarchy_mapping
        GROUP BY unit_name
      ) hm ON hm.unit_name = tdl.unit_name
      WHERE tdl.report_date BETWEEN ? AND ?
        AND (tdl.total_app_km IS NULL OR tdl.total_app_km = 0)
        ${scopeClause}
      ORDER BY hm.state_name, hm.zone_name, tdl.unit_name, tdl.route_name, tdl.sub_route_name, tdl.report_date
    `, [range.from, range.to, ...scopeParams]);

    // Build sorted date list for pivot columns
    const dateSet = new Set();
    [...lateRows, ...appRows].forEach(r => dateSet.add(r.rpt_date));
    const dates = [...dateSet].sort();

    res.json({ from: range.from, to: range.to, dates,
               late: lateRows.map(_clean),
               app_not_running: appRows.map(_clean) });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// POST /api/alerts/supply-issues
// Body: { date, unit_name?, route_name?, sub_route_name?, channel?: 'email'|'whatsapp'|'both' }
// Sends email to branch admin and/or WhatsApp to driver for the specified route & date.
app.post('/api/alerts/supply-issues', async (req, res) => {
  try {
    const { date, unit_name, route_name, sub_route_name, channel = 'both' } = req.body;
    if (!date) return res.status(400).json({ detail: 'date required' });

    const nodemailer = require('nodemailer');
    const SMTP_HOST = process.env.SMTP_HOST || '';
    const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
    const SMTP_USER = process.env.SMTP_USER || '';
    const SMTP_PASS = process.env.SMTP_PASS || '';
    const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
    const MSG91_KEY    = process.env.MSG91_KEY  || '';
    const MSG91_TMPL   = process.env.MSG91_WHATSAPP_TEMPLATE || '';
    const MSG91_SENDER = process.env.MSG91_SENDER || 'PATRIKA';

    // Build optional per-route WHERE filters
    const lateExtra = [], lateParams = [date];
    const appExtra  = [], appParams  = [date];
    if (unit_name)     { lateExtra.push('AND unit_name = ?');                             lateParams.push(unit_name);
                          appExtra.push('AND tdl.unit_name = ?');                          appParams.push(unit_name); }
    if (route_name)    { lateExtra.push('AND route_name = ?');                            lateParams.push(route_name);
                          appExtra.push('AND tdl.route_name = ?');                         appParams.push(route_name); }
    if (sub_route_name){ lateExtra.push('AND COALESCE(NULLIF(sub_route_name,\'\'),\'-\') = ?'); lateParams.push(sub_route_name);
                          appExtra.push('AND COALESCE(NULLIF(tdl.sub_route_name,\'\'),\'-\') = ?'); appParams.push(sub_route_name); }

    const { rows: lateRows } = await q(`
      SELECT unit_name, route_name,
             COALESCE(NULLIF(sub_route_name,''), '-') AS sub_route_name,
             TIME_FORMAT(
               MAX(CASE WHEN HOUR(actual_arrival) BETWEEN 6 AND 22 THEN actual_arrival END),
             '%H:%i') AS last_late,
             MAX(driver_mobile) AS driver_mobile
      FROM taxi_drop_point_log
      WHERE sup_date = ? AND actual_arrival IS NOT NULL
        ${lateExtra.join(' ')}
      GROUP BY unit_name, route_name, sub_route_name
      HAVING MAX(CASE WHEN HOUR(actual_arrival) BETWEEN 6 AND 22 THEN actual_arrival END) IS NOT NULL
    `, lateParams);

    const { rows: appRows } = await q(`
      SELECT tdl.unit_name, tdl.route_name,
             COALESCE(NULLIF(tdl.sub_route_name, ''), '-') AS sub_route_name,
             tdl.vehicle_no,
             MAX(tdp.driver_mobile) AS driver_mobile
      FROM taxi_delay_log tdl
      LEFT JOIN taxi_drop_point_log tdp
        ON tdp.unit_name = tdl.unit_name AND tdp.route_name = tdl.route_name
        AND tdp.sup_date = tdl.report_date
      WHERE tdl.report_date = ?
        AND (tdl.total_app_km IS NULL OR tdl.total_app_km = 0)
        ${appExtra.join(' ')}
      GROUP BY tdl.unit_name, tdl.route_name, tdl.sub_route_name, tdl.vehicle_no
    `, appParams);

    const sent = { emails: 0, whatsapp: 0, errors: [] };

    // ── Email ─────────────────────────────────────────────────────────────────
    if (channel !== 'whatsapp') {
      if (SMTP_HOST && SMTP_USER) {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        const units = [...new Set([...lateRows, ...appRows].map(r => r.unit_name))];
        for (const unit of units) {
          // First try branch_emails (from Oracle SCH_MOD_PROCESS1 sync), then fall back to users table
          let admins = [];
          try {
            const { rows: be } = await q(
              `SELECT to_name AS name, to_email AS email FROM branch_emails WHERE unit_name = ? AND is_active = 1 AND to_email IS NOT NULL LIMIT 10`,
              [unit]
            );
            admins = be;
          } catch (_) {}
          if (!admins.length) {
            const { rows: ua } = await q(
              `SELECT name, email FROM users WHERE unit_name = ? AND role IN ('edition_incharge','branch_admin') AND is_active = 1 AND email IS NOT NULL LIMIT 5`,
              [unit]
            );
            admins = ua;
          }
          if (!admins.length) { sent.errors.push(`No email found for ${unit}`); continue; }

          const unitLate = lateRows.filter(r => r.unit_name === unit);
          const unitApp  = appRows.filter(r => r.unit_name === unit);
          const lateHtml = unitLate.map(r =>
            `<tr><td>${r.route_name}</td><td>${r.sub_route_name}</td><td style="color:#dc2626;font-weight:bold">Reached ${r.last_late} (after 6 AM)</td></tr>`
          ).join('');
          const appHtml = unitApp.map(r =>
            `<tr><td>${r.route_name}</td><td>${r.sub_route_name}</td><td style="color:#d97706;font-weight:bold">App Not Running · ${r.vehicle_no||''}</td></tr>`
          ).join('');
          const html = `<h2 style="font-family:sans-serif;color:#1C2B45">Supply Issues — ${unit} — ${date}</h2>
            <table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
              <tr style="background:#1C2B45;color:#fff"><th>Route</th><th>Sub Route</th><th>Issue</th></tr>
              ${lateHtml}${appHtml}
            </table>
            <p style="font-size:11px;color:#666;font-family:sans-serif">Patrika Vitran Suite · ${date}</p>`;
          for (const admin of admins) {
            try {
              await transporter.sendMail({
                from: SMTP_FROM, to: admin.email,
                subject: `[Patrika Supply Alert] ${unit} — ${date}`,
                html
              });
              sent.emails++;
            } catch (e) { sent.errors.push(`Email ${admin.email}: ${e.message}`); }
          }
        }
      } else {
        sent.errors.push('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
      }
    }

    // ── WhatsApp via MSG91 ────────────────────────────────────────────────────
    if (channel !== 'email') {
      if (MSG91_KEY && MSG91_TMPL) {
        const drivers = [...new Set([...lateRows, ...appRows]
          .map(r => r.driver_mobile).filter(m => m && /^\d{10}$/.test(String(m)))
        )];
        for (const mobile of drivers) {
          const driverRoutes = [...lateRows, ...appRows].filter(r => String(r.driver_mobile) === String(mobile));
          const routeList = driverRoutes.map(r => r.route_name).join(', ');
          try {
            const resp = await fetch(`https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'authkey': MSG91_KEY },
              body: JSON.stringify({
                integrated_number: MSG91_SENDER,
                content_type: 'template',
                payload: {
                  to: `91${mobile}`,
                  type: 'template',
                  template: { name: MSG91_TMPL, language: { code: 'hi' },
                    components: [{ type: 'body', parameters: [
                      { type: 'text', text: date },
                      { type: 'text', text: routeList }
                    ]}] }
                }
              })
            });
            if (resp.ok) sent.whatsapp++;
            else sent.errors.push(`WhatsApp ${mobile}: ${resp.status}`);
          } catch (e) { sent.errors.push(`WhatsApp ${mobile}: ${e.message}`); }
        }
      } else {
        sent.errors.push('MSG91 WhatsApp not configured — set MSG91_KEY, MSG91_WHATSAPP_TEMPLATE in .env');
      }
    }

    res.json({ date, late_count: lateRows.length, app_not_running_count: appRows.length, sent });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// ── Readers Connect ───────────────────────────────────────────────────────────

// Tables created on startup
;(async () => {
  await q(`CREATE TABLE IF NOT EXISTS reader_msg_templates (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    template_type  VARCHAR(10)  NOT NULL COMMENT 'wa or sms',
    template_name  VARCHAR(100) NOT NULL,
    template_body  TEXT         NOT NULL,
    wa_template_id VARCHAR(100),
    sms_dlt_id     VARCHAR(100),
    sms_sender_id  VARCHAR(20),
    is_active      TINYINT(1)  DEFAULT 1,
    created_at     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await q(`CREATE TABLE IF NOT EXISTS reader_msg_history (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    r_id          VARCHAR(20),
    r_name        VARCHAR(200),
    mobile        VARCHAR(15),
    msg_type      VARCHAR(10),
    template_id   INT,
    message_body  TEXT,
    sent_by       VARCHAR(50),
    status        VARCHAR(20) DEFAULT 'queued',
    sent_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    delivery_at   TIMESTAMP   NULL,
    unit_code     VARCHAR(10),
    locality_code VARCHAR(20),
    INDEX idx_rmh_sent (sent_at),
    INDEX idx_rmh_unit (unit_code)
  )`);
})().catch(e => console.warn('[startup] reader_msg tables:', e.message));

// ── Reference tables — create empty stubs if sync hasn't run yet ───────────────
;(async () => {
  await q(`CREATE TABLE IF NOT EXISTS locality_master (
    id INT AUTO_INCREMENT PRIMARY KEY, loc_id VARCHAR(20) NOT NULL DEFAULT '',
    l_code VARCHAR(20) NOT NULL DEFAULT '', l_name VARCHAR(200), compcode VARCHAR(8),
    INDEX idx_lm (loc_id, l_code, compcode)
  ) CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS newspaper_det (
    id INT AUTO_INCREMENT PRIMARY KEY, loc_id VARCHAR(20) NOT NULL DEFAULT '',
    n_code VARCHAR(20) NOT NULL DEFAULT '', name VARCHAR(200), compcode VARCHAR(8),
    INDEX idx_nd (loc_id, n_code)
  ) CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS primary_newspaper (
    loc_id VARCHAR(20) NOT NULL, r_id VARCHAR(30) NOT NULL,
    newspaper_name VARCHAR(200), news_code VARCHAR(20),
    PRIMARY KEY (loc_id, r_id)
  ) CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS tl_master (
    tl_id VARCHAR(20) NOT NULL, tl_name VARCHAR(100), loc_id VARCHAR(10),
    PRIMARY KEY (tl_id, loc_id)
  ) CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS pro_master (
    pro_id VARCHAR(40) NOT NULL, pro_name VARCHAR(100), loc_id VARCHAR(10), tl_id VARCHAR(20),
    PRIMARY KEY (pro_id, loc_id)
  ) CHARACTER SET utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS agency_outstanding (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    period_label  VARCHAR(20)  NOT NULL,
    period_from   DATE,
    period_to     DATE,
    comp_code     VARCHAR(10),
    unit_code     VARCHAR(10),
    rep_type_name VARCHAR(300),
    ag_code       VARCHAR(30)  NOT NULL,
    dp_code       VARCHAR(30),
    ag_name       VARCHAR(600),
    ag_name_hi    VARCHAR(600),
    city_code     VARCHAR(30),
    city_name     VARCHAR(600),
    op_amt        DECIMAL(15,2) DEFAULT 0,
    bill_amt      DECIMAL(15,2) DEFAULT 0,
    other_db      DECIMAL(15,2) DEFAULT 0,
    rec_amt       DECIMAL(15,2) DEFAULT 0,
    other_cr      DECIMAL(15,2) DEFAULT 0,
    cl_amt        DECIMAL(15,2) DEFAULT 0,
    ag_status     VARCHAR(50),
    unit_name     VARCHAR(300),
    mobno         VARCHAR(30),
    total_copies  INT DEFAULT 0,
    day_copies    INT DEFAULT 0,
    security_bal  DECIMAL(15,2) DEFAULT 0,
    req_security  DECIMAL(15,2) DEFAULT 0,
    sec_diff      DECIMAL(15,2) DEFAULT 0,
    ag_type       VARCHAR(100),
    supply_start  DATE,
    supply_days   INT DEFAULT 0,
    exec_code     VARCHAR(30),
    exec_name     VARCHAR(300),
    last_supply_date  DATE,
    last_supply_copies INT DEFAULT 0,
    is_correspondent   VARCHAR(20),
    net_receipt   DECIMAL(15,2) DEFAULT 0,
    zh_name       VARCHAR(300),
    group_unit_name VARCHAR(300),
    block_status  VARCHAR(10),
    synced_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_period_ag (period_label, unit_code, ag_code),
    INDEX idx_unit (unit_code),
    INDEX idx_ag_status (ag_status),
    INDEX idx_cl_amt (cl_amt),
    INDEX idx_period (period_label)
  ) CHARACTER SET utf8mb4`);
})().catch(e => console.warn('[startup] reference tables:', e.message));

// ── Staff-name lookup JOIN snippets (synced by oracle_staff_sync.js) ──────────
// Deduped subqueries so a code never matches more than one row (no row fan-out).
// Supervisor: tl_master by tl_id. Surveyor: pro_master by unit + numeric suffix
// (pro_id 'P//123' vs created_by 'P/RG0001/123'), then tl_master (created_by is
// sometimes a TL code), then hierarchy_master as the last fallback.
const TL_NAME_JOIN = `
      LEFT JOIN (SELECT tl_id, MAX(tl_name) AS tl_name FROM tl_master GROUP BY tl_id) tlm
             ON tlm.tl_id = sd.tl_id`;
const SVR_NAME_JOINS = `
      LEFT JOIN (SELECT loc_id, SUBSTRING_INDEX(pro_id,'/',-1) AS sfx, MAX(pro_name) AS pro_name
                 FROM pro_master GROUP BY loc_id, sfx) prm
             ON prm.loc_id = sd.unit_code AND sd.created_by LIKE 'P/%'
            AND prm.sfx = SUBSTRING_INDEX(sd.created_by,'/',-1)
      LEFT JOIN (SELECT tl_id, MAX(tl_name) AS tl_name FROM tl_master GROUP BY tl_id) tlc
             ON tlc.tl_id = sd.created_by
      LEFT JOIN hierarchy_master hmn ON hmn.person_code = SUBSTRING_INDEX(sd.created_by,'/',-1)`;
const SUP_NAME_EXPR = `COALESCE(tlm.tl_name, sd.tl_id)`;
const SVR_NAME_EXPR = `COALESCE(prm.pro_name, tlc.tl_name, hmn.person_name, sd.created_by)`;

/** Build scope WHERE clause for survey_data from headers */
async function surveyScope(personCode, hl) {
  const unitCodes = await getScopeUnitCodes(personCode, hl);
  if (unitCodes === null)     return { clause: '', params: [] };
  if (unitCodes.length === 0) return { clause: ' AND 1=0', params: [] };
  const ic = inClause(unitCodes);
  return { clause: ` AND unit_code ${ic.sql}`, params: ic.params };
}

/** Parse x-person-code / x-hierarchy-level from request headers */
function scopeHdrs(req) {
  const personCode = req.headers['x-person-code'] || '';
  const hlRaw = req.headers['x-hierarchy-level'];
  const hl = (hlRaw && /^\d+$/.test(hlRaw)) ? parseInt(hlRaw, 10) : 1;
  return { personCode, hl };
}

const RC_STATE_MAP = { 'RA0': 'Rajasthan', 'MP0': 'Madhya Pradesh', 'CG0': 'Chhattisgarh' };

// Short-lived result cache for expensive RC queries (summary, markers, readers).
// Keyed by endpoint + all query params + user scope. TTL 3 minutes — data only
// changes when an oracle sync runs, not between user filter changes.
const _rcResultCache = new Map();
const RC_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function rcCacheKey(endpoint, req) {
  const scope = (req.headers['x-person-code'] || '') + ':' + (req.headers['x-hierarchy-level'] || '');
  return endpoint + '|' + scope + '|' + new URLSearchParams(req.query).toString();
}
function rcCacheGet(key) {
  const hit = _rcResultCache.get(key);
  if (hit && Date.now() - hit.ts < RC_CACHE_TTL) return hit.data;
  return null;
}
function rcCacheSet(key, data) {
  _rcResultCache.set(key, { data, ts: Date.now() });
  // Evict entries older than 10 minutes to avoid unbounded growth
  if (_rcResultCache.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of _rcResultCache) { if (v.ts < cutoff) _rcResultCache.delete(k); }
  }
}

// Unit→state mapping cached in memory after first query (21 rows — never changes during runtime)
let _unitStateCache = null;
async function getUnitStateMap() {
  if (_unitStateCache) return _unitStateCache;
  const { rows } = await q('SELECT unit_code, MAX(state_name) AS state_name FROM survey_data WHERE state_name IS NOT NULL AND unit_code IS NOT NULL GROUP BY unit_code');
  _unitStateCache = {};
  rows.forEach(r => { _unitStateCache[r.unit_code] = r.state_name; });
  return _unitStateCache;
}

// Distinct newspaper names cached in memory (ordered by reader count; refreshed only on restart)
let _newspaperListCache = null;
async function getNewspaperList() {
  if (_newspaperListCache && _newspaperListCache.length) return _newspaperListCache;
  try {
    const { rows } = await q(`SELECT newspaper_name FROM primary_newspaper
      WHERE newspaper_name IS NOT NULL AND newspaper_name != 'NONE'
      GROUP BY newspaper_name ORDER BY COUNT(*) DESC`);
    _newspaperListCache = rows.map(r => r.newspaper_name);
  } catch (_) { _newspaperListCache = []; }   // table may not exist until sync completes
  return _newspaperListCache;
}

/** Build survey_data-only WHERE clauses. Pass alias='sd' when the query JOINs another table. */
function rcSurveyFilters(query, alias = '') {
  const p = alias ? `${alias}.` : '';
  const cls = [], params = [];
  if (query.state_name)    { cls.push(`${p}state_name = ?`);    params.push(query.state_name); }
  if (query.unit_code)     { cls.push(`${p}unit_code = ?`);     params.push(query.unit_code); }
  if (query.locality_code) { cls.push(`${p}locality_code = ?`); params.push(query.locality_code); }
  if (query.tl_id)         { cls.push(`${p}tl_id = ?`);         params.push(query.tl_id); }
  if (query.created_by)    { cls.push(`${p}created_by = ?`);    params.push(query.created_by); }
  const r = resolveRange(query);
  if (r) { cls.push(`${p}bookdate BETWEEN ? AND ?`); params.push(r.from, r.to); }
  if (query.unprod_reasons) {
    const reasons = query.unprod_reasons.split(',').filter(Boolean);
    if (reasons.length) { const ic = inClause(reasons); cls.push(`${p}unprod_reason ${ic.sql}`); params.push(...ic.params); }
  }
  return { clause: cls.length ? ' AND ' + cls.join(' AND ') : '', params };
}

/** Build filters for endpoints with sd alias (survey_data sd) + optional pn (primary_newspaper) */
function rcFilterClauses(query) {
  const cls = [], params = [];
  if (query.state_name)    { cls.push('sd.state_name = ?');    params.push(query.state_name); }
  if (query.unit_code)     { cls.push('sd.unit_code = ?');     params.push(query.unit_code); }
  if (query.locality_code) { cls.push('sd.locality_code = ?'); params.push(query.locality_code); }
  const r = resolveRange(query);
  if (r) { cls.push('sd.bookdate BETWEEN ? AND ?'); params.push(r.from, r.to); }
  if (query.unprod_reasons) {
    const reasons = query.unprod_reasons.split(',').filter(Boolean);
    if (reasons.length) { const ic = inClause(reasons); cls.push(`sd.unprod_reason ${ic.sql}`); params.push(...ic.params); }
  }
  if (query.newspapers) {
    const nws = query.newspapers.split(',').filter(Boolean);
    if (nws.length) { const ic = inClause(nws); cls.push(`pn.newspaper_name ${ic.sql}`); params.push(...ic.params); }
  }
  return { clause: cls.length ? ' AND ' + cls.join(' AND ') : '', params };
}

// GET /api/readers/filters — cascading State → Unit → Locality → Surveyor → Supervisor options
app.get('/api/readers/filters', async (req, res) => {
  const ck = rcCacheKey('filters', req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);

    // States and units always load fast (index scans, no join).
    // Units are returned WITHOUT state filter — client filters locally (avoids 12-second state-scoped scan).
    const [{ rows: states }, { rows: units }, unitStateMap] = await Promise.all([
      q(`SELECT DISTINCT state_name FROM survey_data WHERE state_name IS NOT NULL ${sc} ORDER BY state_name`, sp),
      q(`SELECT DISTINCT unit_code, unit_name FROM survey_data WHERE unit_name IS NOT NULL ${sc} ORDER BY unit_name`, sp),
      getUnitStateMap(),
    ]);

    // Scoped filter for cascading dropdowns (unit/state restrict deeper lists)
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];

    // Qualified version for JOIN queries (hierarchy_master also has unit_code)
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fcSd, params: fpSd } = rcSurveyFilters(req.query, 'sd');
    const aSdC = scSd + fcSd, aSdP = [...sp, ...fpSd];

    // Localities only load when a unit is selected
    let locs = [];
    if (req.query.unit_code) {
      ({ rows: locs } = await q(`SELECT lm.l_code AS locality_code, MAX(lm.l_name) AS l_name
         FROM locality_master lm
         WHERE lm.loc_id = ?
         GROUP BY lm.l_code
         ORDER BY CAST(lm.l_code AS UNSIGNED)`, [req.query.unit_code]));
    }

    // Supervisors (tl_id) — only load when unit or state is selected to keep it fast
    let supervisors = [], surveyors = [];
    if (req.query.unit_code || req.query.state_name) {
      // Aggregate survey_data FIRST (few dozen rows), THEN join the name lookups —
      // joining per survey row before GROUP BY took 10+ seconds on large units.
      const [{ rows: supRows }, { rows: svrRows }] = await Promise.all([
        q(`SELECT t.tl_id, COALESCE(tlm.tl_name, t.tl_id) AS sup_name, t.cnt
           FROM (SELECT sd.tl_id, COUNT(*) AS cnt FROM survey_data sd
                 WHERE sd.tl_id IS NOT NULL AND sd.tl_id != ''${aSdC}
                 GROUP BY sd.tl_id) t
           LEFT JOIN (SELECT tl_id, MAX(tl_name) AS tl_name FROM tl_master GROUP BY tl_id) tlm
                  ON tlm.tl_id = t.tl_id
           ORDER BY sup_name`, aSdP),
        q(`SELECT t.created_by,
                  MAX(COALESCE(prm.pro_name, tlc.tl_name, hmn.person_name, t.created_by)) AS svr_name,
                  SUM(t.cnt) AS cnt
           FROM (SELECT sd.unit_code, sd.created_by, COUNT(*) AS cnt FROM survey_data sd
                 WHERE sd.created_by IS NOT NULL AND sd.created_by != ''${aSdC}
                 GROUP BY sd.unit_code, sd.created_by) t
           LEFT JOIN (SELECT loc_id, SUBSTRING_INDEX(pro_id,'/',-1) AS sfx, MAX(pro_name) AS pro_name
                      FROM pro_master GROUP BY loc_id, sfx) prm
                  ON prm.loc_id = t.unit_code AND t.created_by LIKE 'P/%'
                 AND prm.sfx = SUBSTRING_INDEX(t.created_by,'/',-1)
           LEFT JOIN (SELECT tl_id, MAX(tl_name) AS tl_name FROM tl_master GROUP BY tl_id) tlc
                  ON tlc.tl_id = t.created_by
           LEFT JOIN hierarchy_master hmn ON hmn.person_code = SUBSTRING_INDEX(t.created_by,'/',-1)
           GROUP BY t.created_by ORDER BY svr_name`, aSdP),
      ]);
      supervisors = supRows.map(r => ({ code: r.tl_id, name: r.sup_name, cnt: Number(r.cnt) }));
      surveyors   = svrRows.map(r => ({ code: r.created_by, name: r.svr_name, cnt: Number(r.cnt) }));
    }

    const payload = {
      states:      states.map(r => ({ code: r.state_name, name: RC_STATE_MAP[r.state_name] || r.state_name })),
      units:       units.map(r => ({ code: r.unit_code, name: r.unit_name, state: unitStateMap[r.unit_code] || '' })),
      localities:  locs.map(r => ({ code: r.locality_code, name: r.l_name || ('Zone ' + r.locality_code) })),
      supervisors,
      surveyors,
    };
    rcCacheSet(ck, payload);
    res.json(payload);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/newspapers — unit-based legend + newspaper breakdown.
// Counts respect the active filters (date range, state, unit, locality) so the
// dropdown numbers always match the data being viewed.
app.get('/api/readers/newspapers', async (req, res) => {
  const ck = rcCacheKey('newspapers', req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { rows: units } = await q(`SELECT unit_code, unit_name, COUNT(*) AS cnt FROM survey_data WHERE unit_name IS NOT NULL ${sc} GROUP BY unit_code, unit_name ORDER BY cnt DESC`, sp);
    // Newspaper breakdown (only if primary_newspaper table exists)
    let papers = [];
    try {
      const fq = { ...req.query }; delete fq.newspapers;   // never restrict counts by paper selection itself
      const { clause: fc, params: fp } = rcSurveyFilters(fq, 'sd');
      const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
      const { rows } = await q(`
        SELECT pn.newspaper_name, COUNT(*) AS cnt
        FROM survey_data sd
        JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
        WHERE pn.newspaper_name IS NOT NULL ${scSd}${fc}
        GROUP BY pn.newspaper_name ORDER BY cnt DESC`, [...sp, ...fp]);
      papers = rows;
    } catch (_) {}
    const payload = { units, papers };
    rcCacheSet(ck, payload);
    res.json(payload);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/summary — summary cards + by-unit breakdown
app.get('/api/readers/summary', async (req, res) => {
  const ck = rcCacheKey('summary', req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const nwList = req.query.newspapers ? req.query.newspapers.split(',').filter(Boolean) : [];

    let grpRes, byUnitRes, dbReaders = 0;

    if (nwList.length) {
      // Newspaper filter active — JOIN with primary_newspaper so KPI counts match map/list
      const fq = { ...req.query }; delete fq.newspapers;
      const { clause: fcSd, params: fpSd } = rcSurveyFilters(fq, 'sd');
      const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
      const ic = inClause(nwList);
      const baseQ = `FROM survey_data sd
        JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
        WHERE pn.newspaper_name ${ic.sql} ${scSd}${fcSd}`;
      const baseP = [...ic.params, ...sp, ...fpSd];
      [grpRes, byUnitRes] = await Promise.all([
        q(`SELECT sd.unprod_reason, COUNT(*) AS cnt ${baseQ} GROUP BY sd.unprod_reason`, baseP),
        q(`SELECT sd.unit_name, sd.unit_code, COUNT(*) AS cnt ${baseQ} GROUP BY sd.unit_name, sd.unit_code ORDER BY cnt DESC`, baseP),
      ]);
    } else {
      // No newspaper filter — fast direct aggregate on survey_data
      const { clause: fc, params: fp } = rcSurveyFilters(req.query);
      const aC = sc + fc, aP = [...sp, ...fp];
      let dbRes;
      [grpRes, byUnitRes, dbRes] = await Promise.all([
        q(`SELECT unprod_reason, COUNT(*) AS cnt FROM survey_data WHERE 1=1 ${aC} GROUP BY unprod_reason`, aP),
        q(`SELECT unit_name, unit_code, COUNT(*) AS cnt FROM survey_data WHERE 1=1 ${aC} GROUP BY unit_name, unit_code ORDER BY cnt DESC`, aP),
        q(`SELECT COUNT(DISTINCT pn.loc_id, pn.r_id) AS db_readers FROM primary_newspaper pn
           JOIN survey_data sd ON sd.unit_code = pn.loc_id AND sd.r_id = pn.r_id
           WHERE pn.newspaper_name = 'DAINIK BHASKAR' ${aC}`, aP).catch(() => ({ rows: [{ db_readers: 0 }] })),
      ]);
      dbReaders = dbRes.rows[0]?.db_readers ?? 0;
    }

    const grpMap = {};
    grpRes.rows.forEach(r => { grpMap[r.unprod_reason] = Number(r.cnt); });
    const t = {
      total:         Object.values(grpMap).reduce((a, b) => a + b, 0),
      new_leads:     grpMap['NEW']           || 0,
      rp_readers:    grpMap['RP_READER']     || 0,
      other_readers: grpMap['NOT_INTERESTED']|| 0,
      follow_up:     grpMap['FOLLOW_UP']     || 0,
      replace_cnt:   grpMap['REPLACE']       || 0,
      db_readers:    dbReaders,
    };
    const out = { totals: _clean(t), byUnit: byUnitRes.rows };
    rcCacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/markers — locality-level aggregated markers for map
// Each locality gets one dot (GPS centroid of readers who have coordinates).
// Counts include ALL readers in that locality (GPS or not) so totals match KPIs.
app.get('/api/readers/markers', async (req, res) => {
  const ck = rcCacheKey('markers', req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const nwList = req.query.newspapers ? req.query.newspapers.split(',').filter(Boolean) : [];
    const limit = Math.min(parseInt(req.query.limit || '10000', 10), 10000);

    // Dedup: one row per reader (latest survey) — NO lat/lng filter so all readers included
    let innerSql, innerP;
    if (nwList.length) {
      const ic = inClause(nwList);
      innerSql = `SELECT sd2.r_id, MAX(sd2.id) AS max_id
        FROM survey_data sd2
        INNER JOIN primary_newspaper pn2 ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
        WHERE 1=1 ${aC} AND pn2.newspaper_name ${ic.sql}
        GROUP BY sd2.r_id`;
      innerP = [...aP, ...ic.params];
    } else {
      innerSql = `SELECT r_id, MAX(id) AS max_id FROM survey_data WHERE 1=1 ${aC} GROUP BY r_id`;
      innerP = [...aP];
    }

    // Individual reader rows — one dot per reader at their actual GPS coordinates
    const { rows } = await q(`
      SELECT sd.r_id, sd.unit_code, sd.unit_name, sd.locality_code, sd.r_name,
             COALESCE(lm.l_name, CONCAT('Zone ', sd.locality_code)) AS locality_name,
             sd.latitude AS lat, sd.longitude AS lng,
             sd.unprod_reason, pn.newspaper_name
      FROM survey_data sd
      INNER JOIN (${innerSql}) dedup ON dedup.max_id = sd.id
      LEFT JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
      LEFT JOIN locality_master lm
        ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
      WHERE sd.latitude IS NOT NULL AND sd.latitude != 0
        AND sd.longitude IS NOT NULL AND sd.longitude != 0
      LIMIT ${limit}`, innerP);

    const out = { markers: rows.map(_clean), total: rows.length };
    rcCacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/locality-readers — paginated reader list (one row per distinct reader)
app.get('/api/readers/locality-readers', async (req, res) => {
  const ck = rcCacheKey('readers', req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: sf, params: sfP } = rcSurveyFilters(req.query); // survey-only (no pn)
    const sC = sc + sf, sP = [...sp, ...sfP];

    // Newspaper filter — applied inside the dedup subquery (alias pn2 matches the JOIN below)
    const nwList = req.query.newspapers ? req.query.newspapers.split(',').filter(Boolean) : [];
    let nwC = '', nwP = [];
    if (nwList.length) { const ic = inClause(nwList); nwC = ` AND pn2.newspaper_name ${ic.sql}`; nwP = ic.params; }

    const page    = Math.max(1, parseInt(req.query.page     || '1',  10));
    const perPage = Math.min(50, parseInt(req.query.per_page || '25', 10));
    const offset  = (page - 1) * perPage;
    const sensF   = hl <= 4 ? ', sd.mobile, sd.alternate_mobile, sd.email, sd.house_no, sd.r_block_street, sd.pin' : '';

    // Inner subquery: latest survey_data id per distinct reader
    const innerSql = `SELECT r_id, MAX(id) AS max_id FROM survey_data WHERE 1=1 ${sC} GROUP BY r_id`;

    let countSql, countP, listSql, listP;
    if (!nwList.length) {
      // Fast path: no newspaper filter — count from inner subquery (group-by count ~1s)
      countSql = `SELECT COUNT(*) AS total FROM (${innerSql}) sub`;
      countP   = [...sP];
      listSql  = `
        SELECT sd.id, sd.r_id, sd.r_name, sd.gender, sd.locality_code,
          COALESCE(lm.l_name, CONCAT('Zone ',sd.locality_code)) AS locality_name,
          sd.unit_code, sd.unit_name, sd.state_name,
          sd.unprod_reason, sd.bookdate, sd.followup_date,
          CAST(sd.latitude AS DECIMAL(12,8)) AS lat, CAST(sd.longitude AS DECIMAL(12,8)) AS lng,
          pn.newspaper_name ${sensF}
        FROM survey_data sd
        JOIN (${innerSql}) latest ON latest.r_id = sd.r_id AND latest.max_id = sd.id
        LEFT JOIN locality_master lm ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
        LEFT JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
        ORDER BY sd.bookdate DESC, sd.r_name LIMIT ${perPage} OFFSET ${offset}`;
      listP = [...sP, ...sP]; // inner subquery params used twice
    } else {
      // With newspaper filter: scope by pn join before dedup
      const nwInnerSql = `SELECT sd2.r_id, MAX(sd2.id) AS max_id
        FROM survey_data sd2 INNER JOIN primary_newspaper pn2 ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
        WHERE 1=1 ${sC}${nwC} GROUP BY sd2.r_id`;
      countSql = `SELECT COUNT(*) AS total FROM (${nwInnerSql}) sub`;
      countP   = [...sP, ...nwP];
      listSql  = `
        SELECT sd.id, sd.r_id, sd.r_name, sd.gender, sd.locality_code,
          COALESCE(lm.l_name, CONCAT('Zone ',sd.locality_code)) AS locality_name,
          sd.unit_code, sd.unit_name, sd.state_name,
          sd.unprod_reason, sd.bookdate, sd.followup_date,
          CAST(sd.latitude AS DECIMAL(12,8)) AS lat, CAST(sd.longitude AS DECIMAL(12,8)) AS lng,
          pn.newspaper_name ${sensF}
        FROM survey_data sd
        JOIN (${nwInnerSql}) latest ON latest.r_id = sd.r_id AND latest.max_id = sd.id
        LEFT JOIN locality_master lm ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
        LEFT JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
        ORDER BY sd.bookdate DESC, sd.r_name LIMIT ${perPage} OFFSET ${offset}`;
      listP = [...sP, ...nwP, ...sP, ...nwP]; // inner params used twice
    }

    const [{ rows: [{ total }] }, { rows }] = await Promise.all([
      q(countSql, countP),
      q(listSql, listP),
    ]);
    const out = { readers: rows.map(_clean), total: Number(total), page, per_page: perPage, pages: Math.ceil(Number(total) / perPage) };
    rcCacheSet(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/reader/:r_id — single reader detail for popup
app.get('/api/readers/reader/:r_id', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const sensF = hl <= 4 ? ', sd.mobile, sd.alternate_mobile, sd.email, sd.house_no, sd.r_block_street, sd.pin, sd.pro_id, sd.tl_id, sd.agcd' : '';
    const { rows } = await q(`
      SELECT sd.id, sd.r_id, sd.r_name, sd.gender, sd.locality_code,
        COALESCE(lm.l_name, CONCAT('Zone ',sd.locality_code)) AS locality_name,
        sd.unit_code, sd.unit_name, sd.state_name,
        sd.unprod_reason, sd.bookdate, sd.followup_date,
        CAST(sd.latitude AS DECIMAL(12,8)) AS lat, CAST(sd.longitude AS DECIMAL(12,8)) AS lng,
        sd.cent_id, sd.category,
        pn.newspaper_name, pn.news_code ${sensF}
      FROM survey_data sd
      LEFT JOIN locality_master lm ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
      LEFT JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
      WHERE sd.r_id = ? ${sc} ORDER BY sd.bookdate DESC LIMIT 1`,
      [req.params.r_id, ...sp]);
    if (!rows.length) return res.status(404).json({ detail: 'Reader not found' });
    res.json(_clean(rows[0]));
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// POST /api/readers/call-log — save a call entry
app.post('/api/readers/call-log', async (req, res) => {
  try {
    const { personCode } = scopeHdrs(req);
    const { r_id, unit_code, outcome, notes, follow_up_date } = req.body;
    if (!r_id || !outcome) return res.status(400).json({ detail: 'r_id and outcome are required' });
    await q(
      `INSERT INTO call_log (r_id, unit_code, called_by, outcome, notes, follow_up_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r_id, unit_code || null, personCode || null, outcome, notes || null, follow_up_date || null]
    );
    // Persist follow-up date back to survey_data when reader is interested / needs callback
    if (follow_up_date && ['INTERESTED', 'CALL_BACK'].includes(outcome)) {
      await q(
        `UPDATE survey_data SET followup_date = ? WHERE r_id = ? ORDER BY bookdate DESC LIMIT 1`,
        [follow_up_date, r_id]
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/call-log/:r_id — call history for one reader
app.get('/api/readers/call-log/:r_id', async (req, res) => {
  try {
    const { rows } = await q(
      `SELECT id, called_by, called_at, outcome, notes, follow_up_date
       FROM call_log WHERE r_id = ? ORDER BY called_at DESC LIMIT 30`,
      [req.params.r_id]
    );
    res.json({ logs: rows.map(_clean) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/templates
app.get('/api/readers/templates', async (req, res) => {
  try {
    const { rows } = await q('SELECT id, template_type, template_name, template_body, wa_template_id, sms_dlt_id, sms_sender_id, is_active FROM reader_msg_templates ORDER BY template_type, template_name');
    res.json({ templates: rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// POST /api/readers/templates — create or update
app.post('/api/readers/templates', async (req, res) => {
  try {
    const { id, template_type, template_name, template_body, wa_template_id, sms_dlt_id, sms_sender_id } = req.body;
    if (!template_type || !template_name || !template_body) return res.status(400).json({ detail: 'template_type, template_name, template_body required' });
    if (id) {
      await q('UPDATE reader_msg_templates SET template_type=?,template_name=?,template_body=?,wa_template_id=?,sms_dlt_id=?,sms_sender_id=? WHERE id=?',
        [template_type, template_name, template_body, wa_template_id||null, sms_dlt_id||null, sms_sender_id||null, id]);
      return res.json({ ok: true, id });
    }
    const [r] = await pool.execute('INSERT INTO reader_msg_templates (template_type,template_name,template_body,wa_template_id,sms_dlt_id,sms_sender_id) VALUES (?,?,?,?,?,?)',
      [template_type, template_name, template_body, wa_template_id||null, sms_dlt_id||null, sms_sender_id||null]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// DELETE /api/readers/templates/:id
app.delete('/api/readers/templates/:id', async (req, res) => {
  try {
    await q('DELETE FROM reader_msg_templates WHERE id=?', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// POST /api/readers/send-message — single or bulk send (queued; MSG91 key needed for live delivery)
app.post('/api/readers/send-message', async (req, res) => {
  try {
    const { readers, msg_type, template_id, message_body, sent_by } = req.body;
    if (!readers?.length || !msg_type || !message_body) return res.status(400).json({ detail: 'readers, msg_type, message_body required' });
    const MSG91_KEY = process.env.MSG91_KEY || '';
    const results = [];
    for (const reader of readers) {
      const [ins] = await pool.execute(
        `INSERT INTO reader_msg_history (r_id,r_name,mobile,msg_type,template_id,message_body,sent_by,status,unit_code,locality_code)
         VALUES (?,?,?,?,?,?,?,'queued',?,?)`,
        [reader.r_id||null, reader.r_name||null, reader.mobile||null, msg_type, template_id||null,
         message_body, sent_by||null, reader.unit_code||null, reader.locality_code||null]);
      const status = (MSG91_KEY && reader.mobile) ? 'sent' : 'queued';
      if (status === 'sent') await q('UPDATE reader_msg_history SET status=? WHERE id=?', [status, ins.insertId]);
      results.push({ id: ins.insertId, r_id: reader.r_id, status });
    }
    res.json({ ok: true, sent: results.length, queued: results.filter(r => r.status === 'queued').length, results });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/readers/msg-history — communication history (scoped by unit_code)
app.get('/api/readers/msg-history', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const unitCodes = await getScopeUnitCodes(personCode, hl);
    let hC = '', hP = [];
    if (unitCodes !== null) {
      if (unitCodes.length === 0) return res.json({ history: [], total: 0, page: 1, per_page: 30 });
      const ic = inClause(unitCodes); hC = ` AND unit_code ${ic.sql}`; hP = ic.params;
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 30, offset = (page - 1) * perPage;
    const { rows: [{ total }] } = await q(`SELECT COUNT(*) AS total FROM reader_msg_history WHERE 1=1 ${hC}`, hP);
    const { rows } = await q(`
      SELECT id, r_id, r_name, mobile, msg_type, message_body, sent_by, status, sent_at, unit_code, locality_code
      FROM reader_msg_history WHERE 1=1 ${hC}
      ORDER BY sent_at DESC LIMIT ${perPage} OFFSET ${offset}`, hP);
    res.json({ history: rows.map(_clean), total: Number(total), page, per_page: perPage });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── Survey Intelligence Dashboard ────────────────────────────────────────────

// GET /api/survey/kpis — aggregate KPIs by outcome
// 3-min result cache for every survey-dashboard GET — survey_data only changes on
// oracle sync, so identical filter combinations within the TTL are served from memory.
app.use('/api/survey', (req, res, next) => {
  if (req.method !== 'GET') return next();
  const ck = rcCacheKey('sv:' + req.path, req);
  const hit = rcCacheGet(ck);
  if (hit) return res.json(hit);
  const orig = res.json.bind(res);
  res.json = (body) => { if (res.statusCode === 200) rcCacheSet(ck, body); return orig(body); };
  next();
});

app.get('/api/survey/kpis', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const [byR, tots, fup, ordCnt] = await Promise.all([
      q(`SELECT unprod_reason, COUNT(*) AS cnt FROM survey_data WHERE 1=1${aC} GROUP BY unprod_reason`, aP),
      q(`SELECT COUNT(*) AS total, COUNT(DISTINCT DATE(bookdate)) AS active_days,
              COUNT(DISTINCT created_by) AS surveyors, COUNT(DISTINCT unit_code) AS areas
         FROM survey_data WHERE 1=1${aC}`, aP),
      q(`SELECT COUNT(*) AS cnt FROM survey_data WHERE followup_date IS NOT NULL AND followup_date >= CURDATE()${sc}`, sp),
      q(`SELECT COUNT(DISTINCT order_id) AS cnt FROM survey_data WHERE order_id IS NOT NULL AND order_id != ''${aC}`, aP),
    ]);
    const reasons = {};
    byR.rows.forEach(r => { reasons[r.unprod_reason || 'OTHER'] = Number(r.cnt); });
    const t = tots.rows[0];
    res.json({
      total: Number(t.total), active_days: Number(t.active_days),
      surveyors: Number(t.surveyors), areas: Number(t.areas),
      followup_pending: Number(fup.rows[0].cnt),
      order_count: Number(ordCnt.rows[0].cnt),
      by_reason: reasons,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/by-unit — unit-wise performance
app.get('/api/survey/by-unit', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const { rows } = await q(`
      SELECT unit_code, unit_name,
             COUNT(*) AS total,
             SUM(unprod_reason='NEW') AS new_cnt,
             SUM(unprod_reason='RP_READER') AS rp_reader,
             SUM(unprod_reason='NOT_INTERESTED') AS not_interested,
             SUM(unprod_reason='FOLLOW_UP') AS follow_up,
             SUM(unprod_reason='REPLACE') AS replace_cnt
      FROM survey_data WHERE 1=1${aC}
      GROUP BY unit_code, unit_name ORDER BY total DESC`, aP);
    const N = v => Number(v) || 0;
    res.json({ units: rows.map(r => ({
      unit_code: r.unit_code, unit_name: r.unit_name || r.unit_code,
      total: N(r.total), new_cnt: N(r.new_cnt), rp_reader: N(r.rp_reader),
      not_interested: N(r.not_interested), follow_up: N(r.follow_up), replace_cnt: N(r.replace_cnt),
      conversion_pct: N(r.total) > 0 ? Math.round(N(r.new_cnt) / N(r.total) * 1000) / 10 : 0,
    })) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/staff — surveyor attendance + performance (monthly breakdown)
app.get('/api/survey/staff', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fc, params: fp } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fc, aP = [...sp, ...fp];
    const { rows } = await q(`
      SELECT sd.created_by,
             MAX(${SVR_NAME_EXPR}) AS surveyor_name,
             MAX(sd.unit_name) AS unit_name,
             MAX(sd.tl_id) AS tl_id,
             MAX(${SUP_NAME_EXPR}) AS supervisor_name,
             COUNT(*) AS total,
             COUNT(DISTINCT DATE(sd.bookdate)) AS days_active,
             SUM(sd.unprod_reason='NEW') AS new_cnt,
             SUM(sd.unprod_reason='RP_READER') AS rp_reader,
             SUM(sd.unprod_reason='NOT_INTERESTED') AS not_interested,
             SUM(sd.unprod_reason='FOLLOW_UP') AS follow_up,
             SUM(sd.capture_image IS NOT NULL AND sd.capture_image != '') AS verified
      FROM survey_data sd
      ${TL_NAME_JOIN}
      ${SVR_NAME_JOINS}
      WHERE sd.created_by IS NOT NULL${aC}
      GROUP BY sd.created_by ORDER BY total DESC LIMIT 200`, aP);
    const N = v => Number(v) || 0;
    res.json({ staff: rows.map(r => ({
      surveyor_name: r.surveyor_name, unit_name: r.unit_name || '—',
      supervisor_name: r.supervisor_name || '—',
      total: N(r.total), days_active: N(r.days_active),
      new_cnt: N(r.new_cnt), rp_reader: N(r.rp_reader),
      not_interested: N(r.not_interested), follow_up: N(r.follow_up), verified: N(r.verified),
      conversion_pct: N(r.total) > 0 ? Math.round(N(r.new_cnt) / N(r.total) * 1000) / 10 : 0,
    })) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/teams — supervisor-level rollup with surveyor breakdown
app.get('/api/survey/teams', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fc, params: fp } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fc, aP = [...sp, ...fp];
    const { rows } = await q(`
      SELECT
        sd.tl_id,
        MAX(COALESCE(tlm.tl_name, sd.tl_id, '(No Supervisor)')) AS supervisor_name,
        sd.created_by,
        MAX(${SVR_NAME_EXPR}) AS surveyor_name,
        MAX(sd.unit_name) AS unit_name,
        MAX(sd.state_name) AS state_name,
        COUNT(*) AS total,
        COUNT(DISTINCT DATE(sd.bookdate)) AS days_active,
        SUM(sd.unprod_reason='NEW') AS new_cnt,
        SUM(sd.unprod_reason='RP_READER') AS rp_reader,
        SUM(sd.unprod_reason='NOT_INTERESTED') AS not_interested,
        SUM(sd.unprod_reason='FOLLOW_UP') AS follow_up,
        SUM(sd.capture_image IS NOT NULL AND sd.capture_image != '') AS verified
      FROM survey_data sd
      ${TL_NAME_JOIN}
      ${SVR_NAME_JOINS}
      WHERE sd.created_by IS NOT NULL${aC}
      GROUP BY sd.tl_id, sd.created_by
      ORDER BY supervisor_name, total DESC`, aP);

    const N = v => Number(v) || 0;
    // Group by supervisor
    const teamsMap = new Map();
    for (const r of rows) {
      const supKey = r.tl_id || '__none__';
      if (!teamsMap.has(supKey)) {
        teamsMap.set(supKey, {
          supervisor_name: r.supervisor_name,
          unit_name: r.unit_name || '—',
          state_name: r.state_name || '—',
          total: 0, days_active: 0, new_cnt: 0, rp_reader: 0,
          not_interested: 0, follow_up: 0, verified: 0,
          surveyors: [],
        });
      }
      const team = teamsMap.get(supKey);
      const svr = {
        surveyor_name: r.surveyor_name,
        total: N(r.total), days_active: N(r.days_active),
        new_cnt: N(r.new_cnt), rp_reader: N(r.rp_reader),
        not_interested: N(r.not_interested), follow_up: N(r.follow_up), verified: N(r.verified),
        conversion_pct: N(r.total) > 0 ? Math.round(N(r.new_cnt) / N(r.total) * 1000) / 10 : 0,
      };
      team.surveyors.push(svr);
      team.total         += svr.total;
      team.new_cnt       += svr.new_cnt;
      team.rp_reader     += svr.rp_reader;
      team.not_interested+= svr.not_interested;
      team.follow_up     += svr.follow_up;
      team.verified      += svr.verified;
      team.days_active    = Math.max(team.days_active, svr.days_active);
    }
    const teams = [...teamsMap.values()].map(t => ({
      ...t,
      conversion_pct: t.total > 0 ? Math.round(t.new_cnt / t.total * 1000) / 10 : 0,
    }));
    res.json({ teams });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── Report CSV helpers ──────────────────────────────────────────────────────

function dateListBetween(from, to) {
  const pad = n => String(n).padStart(2, '0');
  const dates = [], end = new Date(to + 'T00:00:00');
  let cur = new Date(from + 'T00:00:00');
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
const fmtDH = d => d.slice(8) + '.' + d.slice(5, 7) + '.' + d.slice(2, 4);
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsvStr(hdr, rows) {
  return [hdr, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
function sendCsv(res, name, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.end('\uFEFF' + csv);
}
/** CSV download by default; ?format=json returns {header, rows} for on-screen tables */
function sendReport(req, res, name, hdr, rows) {
  if (req.query.format === 'json') return res.json({ header: hdr, rows });
  sendCsv(res, name, toCsvStr(hdr, rows));
}

// GET /api/survey/report/area-orders — Center Wise Survey Orders (area × date → orders)
app.get('/api/survey/report/area-orders', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const r = resolveRange(req.query);
    if (!r) return res.status(400).json({ error: 'from and to date required' });
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fcSd, params: fpSd } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fcSd, aP = [...sp, ...fpSd];
    const { rows } = await q(`
      SELECT sd.locality_code,
             MAX(COALESCE(lm.l_name, CONCAT('Zone ', sd.locality_code))) AS area_name,
             DATE_FORMAT(sd.bookdate,'%Y-%m-%d') AS dt,
             COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.order_id END) AS orders
      FROM survey_data sd
      LEFT JOIN locality_master  lm ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code
      WHERE 1=1 ${aC}
      GROUP BY sd.locality_code, DATE_FORMAT(sd.bookdate,'%Y-%m-%d')
      ORDER BY area_name, dt`, aP);
    const dates = dateListBetween(r.from, r.to);
    const aMap = new Map();
    for (const row of rows) {
      const key = row.locality_code || '';
      if (!aMap.has(key)) aMap.set(key, { area: row.area_name, by: {} });
      aMap.get(key).by[row.dt] = Number(row.orders);
    }
    const hdr = ['S.No.', 'Area of Survey', ...dates.map(fmtDH), 'Total Orders'];
    let n = 1; const csvRows = [];
    for (const a of aMap.values()) {
      const dv = dates.map(d => a.by[d] || 0);
      csvRows.push([n++, a.area, ...dv, dv.reduce((s, v) => s + v, 0)]);
    }
    sendReport(req, res, `area-orders-${r.from}-to-${r.to}.csv`, hdr, csvRows);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/report/surveyor-performance — Executive Performance (surveyor × date → orders)
app.get('/api/survey/report/surveyor-performance', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const r = resolveRange(req.query);
    if (!r) return res.status(400).json({ error: 'from and to date required' });
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fcSd, params: fpSd } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fcSd, aP = [...sp, ...fpSd];
    const { rows } = await q(`
      SELECT sd.created_by AS svr_id,
             MAX(${SVR_NAME_EXPR}) AS svr_name,
             MAX(${SUP_NAME_EXPR}) AS sup_name,
             MAX(COALESCE(lm.l_name, sd.locality_code))    AS area_name,
             DATE_FORMAT(sd.bookdate,'%Y-%m-%d')            AS dt,
             COUNT(DISTINCT sd.r_id) AS surveys,
             COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.order_id END) AS orders
      FROM survey_data sd
      ${TL_NAME_JOIN}
      ${SVR_NAME_JOINS}
      LEFT JOIN locality_master  lm  ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
      WHERE 1=1 ${aC}
      GROUP BY sd.created_by, DATE_FORMAT(sd.bookdate,'%Y-%m-%d')
      ORDER BY sup_name, svr_name, dt`, aP);
    const dates = dateListBetween(r.from, r.to);
    const sMap = new Map();
    for (const row of rows) {
      if (!sMap.has(row.svr_id)) sMap.set(row.svr_id, { sup: row.sup_name || '(No Supervisor)', area: row.area_name, svr: row.svr_name, by: {} });
      const s = sMap.get(row.svr_id);
      s.by[row.dt] = Number(row.orders);
      if (row.area_name) s.area = row.area_name;
    }
    const hdr = ['S.No.', 'Supervisor Name', 'Area of Survey', 'Surveyor Name',
      ...dates.map(fmtDH), 'Total Orders', 'Present Days', 'Avg/Day'];
    let n = 1; const csvRows = [];
    for (const s of sMap.values()) {
      const dv = dates.map(d => s.by[d] != null ? s.by[d] : '');
      const present = dv.filter(v => v !== '').length;
      const total   = dv.reduce((acc, v) => acc + (Number(v) || 0), 0);
      csvRows.push([n++, s.sup, s.area, s.svr, ...dv, total, present,
        present > 0 ? (total / present).toFixed(2) : '0.00']);
    }
    sendReport(req, res, `surveyor-performance-${r.from}-to-${r.to}.csv`, hdr, csvRows);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/report/surveyor-daily — Surveyor Wise Details (all surveys/day, 'A' if absent)
app.get('/api/survey/report/surveyor-daily', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const r = resolveRange(req.query);
    if (!r) return res.status(400).json({ error: 'from and to date required' });
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fcSd, params: fpSd } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fcSd, aP = [...sp, ...fpSd];
    const { rows } = await q(`
      SELECT sd.created_by AS svr_id,
             MAX(${SVR_NAME_EXPR}) AS svr_name,
             MAX(COALESCE(lm.l_name, CONCAT('Zone ', sd.locality_code)))   AS area_name,
             DATE_FORMAT(sd.bookdate,'%Y-%m-%d')           AS dt,
             COUNT(DISTINCT sd.r_id) AS surveys,
             COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.order_id END) AS orders
      FROM survey_data sd
      ${SVR_NAME_JOINS}
      LEFT JOIN locality_master  lm ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code
      WHERE 1=1 ${aC}
      GROUP BY sd.created_by, DATE_FORMAT(sd.bookdate,'%Y-%m-%d')
      ORDER BY area_name, svr_name, dt`, aP);
    const firstDt = new Map();
    for (const row of rows) {
      const cur = firstDt.get(row.svr_id);
      if (!cur || row.dt < cur) firstDt.set(row.svr_id, row.dt);
    }
    const dates = dateListBetween(r.from, r.to);
    const sMap = new Map();
    for (const row of rows) {
      if (!sMap.has(row.svr_id)) sMap.set(row.svr_id, { svr: row.svr_name, area: row.area_name, by: {}, ord: {} });
      const s = sMap.get(row.svr_id);
      s.by[row.dt] = Number(row.surveys);
      s.ord[row.dt] = Number(row.orders);
      if (row.area_name) s.area = row.area_name;
    }
    const hdr = ['S.No.', 'Area of Survey', 'Surveyor Name', 'Designation',
      ...dates.map(fmtDH), 'Total Surveys', 'Total Orders', 'Present Days', 'Avg Surveys/Day'];
    let n = 1; const csvRows = [];
    for (const [id, s] of sMap.entries()) {
      const desig = /^P\//i.test(id) ? 'Surveyor' : 'CI';
      const fd = firstDt.get(id) || r.from;
      const dv = dates.map(d => {
        if (d < fd) return '';
        if (s.by[d] == null) return 'A';
        return `${s.by[d]}/${s.ord[d] || 0}`;
      });
      const present = dv.filter(v => v !== 'A' && v !== '').length;
      const totS = dates.reduce((acc, d) => acc + (s.by[d]  || 0), 0);
      const totO = dates.reduce((acc, d) => acc + (s.ord[d] || 0), 0);
      csvRows.push([n++, s.area, s.svr, desig, ...dv, totS, totO, present,
        present > 0 ? (totS / present).toFixed(1) : '0.0']);
    }
    sendReport(req, res, `surveyor-daily-${r.from}-to-${r.to}.csv`, hdr, csvRows);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/report/summary — Summary (supervisor → area → staff + order counts)
app.get('/api/survey/report/summary', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const r = resolveRange(req.query);
    if (!r) return res.status(400).json({ error: 'from and to date required' });
    const scSd = sc.replace(/\bunit_code\b/g, 'sd.unit_code');
    const { clause: fcSd, params: fpSd } = rcSurveyFilters(req.query, 'sd');
    const aC = scSd + fcSd, aP = [...sp, ...fpSd];
    const { rows } = await q(`
      SELECT sd.locality_code,
             MAX(COALESCE(lm.l_name, CONCAT('Zone ', sd.locality_code))) AS area_name,
             COUNT(DISTINCT sd.created_by)  AS surveyor_count,
             COUNT(DISTINCT sd.r_id)         AS total_surveys,
             COUNT(DISTINCT CASE WHEN sd.order_id IS NOT NULL AND sd.order_id != '' THEN sd.order_id END) AS total_orders,
             COUNT(DISTINCT DATE(sd.bookdate)) AS working_days
      FROM survey_data sd
      LEFT JOIN locality_master  lm  ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code
      WHERE 1=1 ${aC}
      GROUP BY sd.locality_code
      ORDER BY area_name`, aP);
    const hdr = ['S.No.', 'Area of Survey',
      'Surveyors', 'Total Surveys', 'Total Orders', 'Order %', 'Working Days'];
    let n = 1; const csvRows = [];
    for (const row of rows) {
      const ns = Number(row.total_surveys), no = Number(row.total_orders);
      const pct = ns > 0 ? (no / ns * 100).toFixed(1) + '%' : '0.0%';
      csvRows.push([n++, row.area_name, Number(row.surveyor_count), ns, no, pct, Number(row.working_days)]);
    }
    sendReport(req, res, `summary-${r.from}-to-${r.to}.csv`, hdr, csvRows);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/by-locality — locality-wise performance (drill-down from by-unit)
app.get('/api/survey/by-locality', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const { rows } = await q(`
      SELECT sd.locality_code,
             MAX(COALESCE(lm.l_name, CONCAT('Zone ', sd.locality_code))) AS locality_name,
             COUNT(*) AS total,
             SUM(sd.unprod_reason='NEW')            AS new_cnt,
             SUM(sd.unprod_reason='RP_READER')      AS rp_reader,
             SUM(sd.unprod_reason='NOT_INTERESTED') AS not_interested,
             SUM(sd.unprod_reason='FOLLOW_UP')      AS follow_up,
             SUM(sd.unprod_reason='REPLACE')        AS replace_cnt,
             SUM(pn.r_id IS NOT NULL)               AS db_readers
      FROM survey_data sd
      LEFT JOIN locality_master lm
             ON lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code
      LEFT JOIN primary_newspaper pn ON pn.loc_id = sd.unit_code AND pn.r_id = sd.r_id
      WHERE 1=1${aC}
      GROUP BY sd.locality_code
      ORDER BY total DESC`, aP);
    const N = v => Number(v) || 0;
    res.json({ localities: rows.map(r => ({
      locality_code:   r.locality_code,
      locality_name:   r.locality_name || ('Zone ' + r.locality_code),
      total:           N(r.total),
      new_cnt:         N(r.new_cnt),
      rp_reader:       N(r.rp_reader),
      not_interested:  N(r.not_interested),
      follow_up:       N(r.follow_up),
      replace_cnt:     N(r.replace_cnt),
      db_readers:      N(r.db_readers),
      conversion_pct:  N(r.total) > 0 ? Math.round(N(r.new_cnt) / N(r.total) * 1000) / 10 : 0,
    })) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/daily — daily survey trend (last 60 days by default)
app.get('/api/survey/daily', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const limitClause = (req.query.from || req.query.date)
      ? '' : ' AND bookdate >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)';
    const { rows } = await q(`
      SELECT DATE_FORMAT(bookdate,'%Y-%m-%d') AS day,
             COUNT(*) AS total,
             SUM(unprod_reason='NEW') AS new_cnt,
             SUM(unprod_reason='RP_READER') AS rp_reader,
             SUM(unprod_reason='NOT_INTERESTED') AS not_interested,
             SUM(unprod_reason='FOLLOW_UP') AS follow_up
      FROM survey_data WHERE 1=1${aC}${limitClause}
      GROUP BY day ORDER BY day`, aP);
    const N = v => Number(v) || 0;
    res.json({ days: rows.map(r => ({
      day: r.day, total: N(r.total), new_cnt: N(r.new_cnt),
      rp_reader: N(r.rp_reader), not_interested: N(r.not_interested), follow_up: N(r.follow_up),
    })) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/followups — follow-up list (all, not date-filtered)
app.get('/api/survey/followups', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 50, offset = (page - 1) * perPage;
    const { rows: [{ total }] } = await q(
      `SELECT COUNT(*) AS total FROM survey_data WHERE followup_date IS NOT NULL${sc}`, sp);
    const { rows } = await q(`
      SELECT r_id, r_name, mobile, unit_name, locality_code,
             DATE_FORMAT(followup_date,'%Y-%m-%d') AS followup_date,
             DATE_FORMAT(bookdate,'%Y-%m-%d') AS survey_date,
             created_by, unprod_reason
      FROM survey_data WHERE followup_date IS NOT NULL${sc}
      ORDER BY followup_date ASC LIMIT ${perPage} OFFSET ${offset}`, sp);
    res.json({ followups: rows.map(_clean), total: Number(total), page, per_page: perPage });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/orders — list of surveys that have an order_id (paginated)
app.get('/api/survey/orders', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 100, offset = (page - 1) * perPage;
    const [cntRes, listRes] = await Promise.all([
      q(`SELECT COUNT(DISTINCT order_id) AS total FROM survey_data
         WHERE order_id IS NOT NULL AND order_id != ''${aC}`, aP),
      q(`SELECT order_id, r_name, mobile, unit_name, unit_code,
               DATE_FORMAT(bookdate,'%Y-%m-%d') AS survey_date, created_by
         FROM survey_data
         WHERE order_id IS NOT NULL AND order_id != ''${aC}
         ORDER BY bookdate DESC LIMIT ${perPage} OFFSET ${offset}`, aP),
    ]);
    const total = Number(cntRes.rows[0].total);
    res.json({ orders: listRes.rows.map(_clean), total, page, per_page: perPage, pages: Math.ceil(total / perPage) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/survey/readers — gender, category, and newspaper market-share breakdown
app.get('/api/survey/readers', async (req, res) => {
  try {
    const { personCode, hl } = scopeHdrs(req);
    const { clause: sc, params: sp } = await surveyScope(personCode, hl);
    const { clause: fc, params: fp } = rcSurveyFilters(req.query);
    const aC = sc + fc, aP = [...sp, ...fp];
    // Newspaper scope: filter primary_newspaper by the in-scope unit_codes only (fast IN-subquery, avoids row-level join)
    const nwClause = sc + (req.query.unit_code ? ' AND unit_code = ?' : '');
    const nwParams = req.query.unit_code ? [...sp, req.query.unit_code] : [...sp];
    const [genderR, catR, nwR] = await Promise.all([
      q(`SELECT gender, COUNT(*) AS cnt FROM survey_data WHERE 1=1${aC} GROUP BY gender ORDER BY cnt DESC`, aP),
      q(`SELECT COALESCE(NULLIF(TRIM(category),''),'Unknown') AS cat, COUNT(*) AS cnt FROM survey_data WHERE 1=1${aC} GROUP BY cat ORDER BY cnt DESC`, aP),
      q(`SELECT newspaper_name, COUNT(*) AS cnt FROM primary_newspaper
         WHERE loc_id IN (SELECT DISTINCT unit_code FROM survey_data WHERE 1=1${nwClause})
           AND newspaper_name != 'NONE'
         GROUP BY newspaper_name ORDER BY cnt DESC LIMIT 10`, nwParams).catch(() => ({ rows: [] })),
    ]);
    const N = v => Number(v) || 0;
    res.json({
      gender: genderR.rows.map(r => ({ gender: r.gender || 'Unknown', cnt: N(r.cnt) })),
      category: catR.rows.map(r => ({ cat: r.cat, cnt: N(r.cnt) })),
      newspapers: nwR.rows.map(r => ({ name: r.newspaper_name, cnt: N(r.cnt) })),
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AGENCY OUTSTANDING ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// Helper: build WHERE clause from outstanding filters
function ouFilters(query, alias = 'ao') {
  const p = alias ? `${alias}.` : '';
  const cls = [], params = [];
  if (query.state)      { cls.push(`${p}group_unit_name = ?`); params.push(query.state); }
  if (query.unit_code)  { cls.push(`${p}unit_code = ?`);  params.push(query.unit_code); }
  if (query.ag_status)  { cls.push(`${p}ag_status = ?`);  params.push(query.ag_status); }
  if (query.ag_type)    { cls.push(`${p}ag_type = ?`);    params.push(query.ag_type); }
  if (query.zh_name)    { cls.push(`${p}zh_name = ?`);    params.push(query.zh_name); }
  if (query.exec_code)  { cls.push(`${p}exec_code = ?`);  params.push(query.exec_code); }
  if (query.exec_name)  { cls.push(`${p}exec_name = ?`);  params.push(query.exec_name); }
  if (query.search) {
    cls.push(`(${p}ag_name LIKE ? OR ${p}ag_code LIKE ? OR ${p}city_name LIKE ?)`);
    const like = `%${query.search}%`;
    params.push(like, like, like);
  }
  if (query.bucket) {
    const bm = {
      '15-30':  `(${p}last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(),${p}last_supply_date) >= 15 AND DATEDIFF(CURDATE(),${p}last_supply_date) <= 30)`,
      '31-60':  `(${p}last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(),${p}last_supply_date) >= 31 AND DATEDIFF(CURDATE(),${p}last_supply_date) <= 60)`,
      '61-90':  `(${p}last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(),${p}last_supply_date) >= 61 AND DATEDIFF(CURDATE(),${p}last_supply_date) <= 90)`,
      '91-180': `(${p}last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(),${p}last_supply_date) >= 91 AND DATEDIFF(CURDATE(),${p}last_supply_date) <= 180)`,
      '180+':   `(${p}op_amt > 0 AND ${p}cl_amt > 0)`,
    };
    if (bm[query.bucket]) cls.push(bm[query.bucket]);
  }
  return { clause: cls.length ? ' AND ' + cls.join(' AND ') : '', params };
}

// GET /api/outstanding/filters — distinct filter options
app.get('/api/outstanding/filters', async (req, res) => {
  try {
    const sc = await getOuScopeFilter(req);
    const [units, statuses, types, zhs, states] = await Promise.all([
      q(`SELECT DISTINCT unit_code, MAX(unit_name) unit_name, MAX(group_unit_name) state
         FROM agency_outstanding WHERE period_label='CURRENT' AND unit_code IS NOT NULL${sc.clause} GROUP BY unit_code ORDER BY unit_name`, sc.params),
      q(`SELECT DISTINCT ag_status FROM agency_outstanding WHERE period_label='CURRENT' AND ag_status IS NOT NULL${sc.clause} ORDER BY ag_status`, sc.params),
      q(`SELECT DISTINCT ag_type FROM agency_outstanding WHERE period_label='CURRENT' AND ag_type IS NOT NULL${sc.clause} ORDER BY ag_type`, sc.params),
      q(`SELECT DISTINCT zh_name, MAX(group_unit_name) state FROM agency_outstanding WHERE period_label='CURRENT' AND zh_name IS NOT NULL${sc.clause} GROUP BY zh_name ORDER BY zh_name`, sc.params),
      q(`SELECT DISTINCT group_unit_name FROM agency_outstanding WHERE period_label='CURRENT' AND group_unit_name IS NOT NULL${sc.clause} ORDER BY group_unit_name`, sc.params),
    ]);
    const synced = await q(`SELECT MAX(synced_at) mx, MAX(period_to) pt FROM agency_outstanding WHERE period_label='CURRENT'`);
    res.json({
      states:   states.rows.map(r => r.group_unit_name),
      units:    units.rows.map(r => ({ code: r.unit_code, name: r.unit_name, state: r.state })),
      statuses: statuses.rows.map(r => r.ag_status),
      types:    types.rows.map(r => r.ag_type),
      zh_names: zhs.rows.map(r => ({ code: r.zh_name, name: r.zh_name, state: r.state })),
      synced_at: synced.rows[0]?.mx,
      period_to: synced.rows[0]?.pt,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/kpis — primary KPI cards
app.get('/api/outstanding/kpis', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const r = await q(`
      SELECT
        /* Agency counts: unit+ag_code is the unique agency identity; DPCD=1 is a
           main agency, DPCD>1 a sub-agency — only main agencies are counted. */
        SUM(CASE WHEN CAST(dp_code AS UNSIGNED) = 1 THEN 1 ELSE 0 END) total_agencies,
        SUM(CASE WHEN CAST(dp_code AS UNSIGNED) = 1 AND cl_amt > 0 THEN 1 ELSE 0 END) agencies_with_outstanding,
        SUM(CASE WHEN CAST(dp_code AS UNSIGNED) = 1 AND cl_amt > 0 AND (last_supply_date IS NULL OR DATEDIFF(CURDATE(), last_supply_date) > 30) THEN 1 ELSE 0 END) overdue_ag_count,
        SUM(CASE WHEN CAST(dp_code AS UNSIGNED) = 1 AND cl_amt >= 100000 THEN 1 ELSE 0 END) critical_count,
        SUM(bill_amt) total_billed,
        SUM(CASE WHEN rec_amt > bill_amt * 10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END + other_cr) total_collected,
        SUM(CASE WHEN cl_amt > 0 THEN cl_amt ELSE 0 END) total_outstanding,
        SUM(op_amt) op_total,
        SUM(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(), last_supply_date) > 30 THEN cl_amt ELSE 0 END) overdue_outstanding,
        SUM(CASE WHEN cl_amt >= 100000 THEN cl_amt ELSE 0 END) critical_outstanding
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' ${clause}${sc.clause}
    `, [...params, ...sc.params]);
    const d = r.rows[0] || {};
    const N = v => Number(v) || 0;
    const billed = N(d.total_billed), collected = N(d.total_collected);
    res.json({
      total_agencies:          N(d.total_agencies),
      agencies_with_outstanding: N(d.agencies_with_outstanding),
      overdue_ag_count:        N(d.overdue_ag_count),
      critical_count:          N(d.critical_count),
      total_billed:            billed,
      total_collected:         collected,
      total_outstanding:       N(d.total_outstanding),
      current_outstanding:     N(d.total_outstanding) - N(d.overdue_outstanding),
      overdue_outstanding:     N(d.overdue_outstanding),
      critical_outstanding:    N(d.critical_outstanding),
      collection_pct:          billed > 0 ? ((collected / billed) * 100).toFixed(1) : '0.0',
      op_outstanding:          N(d.op_total),
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/ageing — outstanding by ageing bucket
app.get('/api/outstanding/ageing', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    // Buckets based on days since last supply date and opening balance
    const r = await q(`
      SELECT
        SUM(CASE WHEN op_amt > 0 AND op_amt >= cl_amt AND cl_amt > 0 THEN cl_amt
                 WHEN op_amt > 0 AND op_amt < cl_amt AND cl_amt > 0 THEN op_amt
                 ELSE 0 END) b_180plus,
        SUM(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL
                  AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 91 AND 180
                  AND (op_amt IS NULL OR op_amt = 0)
                 THEN cl_amt
                 WHEN cl_amt > 0 AND last_supply_date IS NOT NULL
                  AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 91 AND 180
                 THEN GREATEST(0, cl_amt - COALESCE(op_amt,0))
                 ELSE 0 END) b_91_180,
        SUM(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL
                  AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 61 AND 90
                 THEN GREATEST(0, cl_amt - COALESCE(op_amt,0))
                 ELSE 0 END) b_61_90,
        SUM(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL
                  AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 31 AND 60
                 THEN GREATEST(0, cl_amt - COALESCE(op_amt,0))
                 ELSE 0 END) b_31_60,
        SUM(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL
                  AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 15 AND 30
                 THEN GREATEST(0, cl_amt - COALESCE(op_amt,0))
                 ELSE 0 END) b_15_30,
        SUM(CASE WHEN cl_amt > 0 AND (last_supply_date IS NULL OR DATEDIFF(CURDATE(), last_supply_date) < 15)
                 THEN GREATEST(0, cl_amt - COALESCE(op_amt,0))
                 ELSE 0 END) b_current,
        COUNT(CASE WHEN op_amt > 0 AND cl_amt > 0 THEN 1 END) cnt_180plus,
        COUNT(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 91 AND 180 THEN 1 END) cnt_91_180,
        COUNT(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 61 AND 90 THEN 1 END) cnt_61_90,
        COUNT(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 31 AND 60 THEN 1 END) cnt_31_60,
        COUNT(CASE WHEN cl_amt > 0 AND last_supply_date IS NOT NULL AND DATEDIFF(CURDATE(), last_supply_date) BETWEEN 15 AND 30 THEN 1 END) cnt_15_30
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' AND cl_amt > 0 ${clause}${sc.clause}
    `, [...params, ...sc.params]);
    const d = r.rows[0] || {};
    const N = v => Number(v) || 0;
    const buckets = [
      { label: '< 30 Days',   days: '15-30',   amt: N(d.b_15_30),   cnt: N(d.cnt_15_30) },
      { label: '31-60 Days',  days: '31-60',   amt: N(d.b_31_60),   cnt: N(d.cnt_31_60) },
      { label: '61-90 Days',  days: '61-90',   amt: N(d.b_61_90),   cnt: N(d.cnt_61_90) },
      { label: '91-180 Days', days: '91-180',  amt: N(d.b_91_180),  cnt: N(d.cnt_91_180) },
      { label: '180+ Days',   days: '180+',    amt: N(d.b_180plus), cnt: N(d.cnt_180plus) },
    ];
    res.json({ buckets, current: N(d.b_current) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/agencies — paginated agency-wise table
app.get('/api/outstanding/agencies', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const offset = (page - 1) * limit;
    const sortMap = {
      outstanding: 'cl_amt DESC',
      overdue:     'DATEDIFF(CURDATE(),last_supply_date) DESC',
      collection:  '(CASE WHEN bill_amt>0 THEN (rec_amt+other_cr)/bill_amt ELSE 1 END) ASC',
      billing:     'bill_amt DESC',
      name:        'ag_name ASC',
    };
    const sort = sortMap[req.query.sort] || 'cl_amt DESC';

    const cnt = await q(`SELECT COUNT(*) n FROM agency_outstanding ao WHERE period_label='CURRENT' ${clause}${sc.clause}`, [...params, ...sc.params]);
    const rows = await q(`
      SELECT ag_code, ag_name, ag_name_hi, unit_code, unit_name, rep_type_name, city_name, ag_type,
             op_amt, bill_amt, other_db, rec_amt, other_cr, cl_amt, ag_status,
             supply_start, last_supply_date, last_supply_copies, supply_days,
             exec_name, zh_name, mobno, day_copies, security_bal, req_security, sec_diff,
             net_receipt, group_unit_name, block_status,
             DATEDIFF(CURDATE(), last_supply_date) days_since_supply,
             CASE WHEN bill_amt > 0 THEN ROUND((CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr)/bill_amt*100,1) ELSE NULL END coll_pct,
             CASE WHEN cl_amt >= 200000 THEN 'Critical'
                  WHEN cl_amt >= 50000  THEN 'High'
                  WHEN cl_amt >= 10000  THEN 'Medium'
                  WHEN cl_amt > 0       THEN 'Low'
                  ELSE 'Clear' END risk_status
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' ${clause}${sc.clause}
      ORDER BY ${sort}
      LIMIT ${limit} OFFSET ${offset}
    `, [...params, ...sc.params]);
    res.json({ total: Number(cnt.rows[0]?.n) || 0, page, limit, rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/top — top N agencies by outstanding
app.get('/api/outstanding/top', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const sortMap = {
      outstanding: 'cl_amt DESC',
      overdue:     'DATEDIFF(CURDATE(),last_supply_date) DESC',
      collection:  '(CASE WHEN bill_amt>0 THEN (rec_amt+other_cr)/bill_amt ELSE 1 END) ASC',
      oldest:      'supply_start ASC',
    };
    const sort = sortMap[req.query.sort] || 'cl_amt DESC';
    const rows = await q(`
      SELECT ag_code, ag_name, unit_name, city_name, ag_type, ag_status,
             op_amt, bill_amt, rec_amt, other_cr, cl_amt,
             last_supply_date, last_supply_copies,
             DATEDIFF(CURDATE(), last_supply_date) days_since_supply,
             CASE WHEN bill_amt > 0 THEN ROUND((rec_amt+other_cr)/bill_amt*100,1) ELSE 0 END coll_pct,
             CASE WHEN cl_amt >= 200000 THEN 'Critical'
                  WHEN cl_amt >= 50000  THEN 'High'
                  WHEN cl_amt >= 10000  THEN 'Medium'
                  ELSE 'Low' END risk_status
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' AND cl_amt > 0 ${clause}${sc.clause}
      ORDER BY ${sort}
      LIMIT ${limit}
    `, [...params, ...sc.params]);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/trend — monthly trend from snapshots
app.get('/api/outstanding/trend', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    // Check if monthly snapshots exist
    const labels = await q(`SELECT DISTINCT period_label FROM agency_outstanding WHERE period_label != 'CURRENT' ORDER BY period_label`);
    if (!labels.rows.length) {
      // Fall back: group by month from period_to on CURRENT data (not ideal but usable)
      return res.json({ months: [], note: 'Run sync with --monthly flag for trend data' });
    }
    const months = labels.rows.map(r => r.period_label);
    const rows = await Promise.all(months.map(async m => {
      const r = await q(`
        SELECT '${m}' month,
          SUM(op_amt) op_amt, SUM(bill_amt) bill_amt,
          SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr) collected, SUM(cl_amt) cl_amt,
          COUNT(CASE WHEN cl_amt > 0 THEN 1 END) outstanding_count
        FROM agency_outstanding ao
        WHERE period_label=? ${clause}${sc.clause}
      `, [m, ...params, ...sc.params]);
      const d = r.rows[0] || {};
      const N = v => Number(v) || 0;
      return { month: m, op_amt: N(d.op_amt), bill_amt: N(d.bill_amt), collected: N(d.collected), cl_amt: N(d.cl_amt), outstanding_count: N(d.outstanding_count) };
    }));
    res.json({ months: rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/unit-summary — unit-wise summary
app.get('/api/outstanding/unit-summary', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const rows = await q(`
      SELECT unit_code, MAX(unit_name) unit_name, MAX(group_unit_name) group_unit_name, MAX(zh_name) zh_name,
        COUNT(*) agencies, COUNT(CASE WHEN cl_amt>0 THEN 1 END) with_outstanding,
        SUM(bill_amt) bill_amt,
        SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr) collected, SUM(cl_amt) cl_amt,
        CASE WHEN SUM(bill_amt)>0 THEN ROUND(SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr)/SUM(bill_amt)*100,1) ELSE 0 END coll_pct
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' ${clause}${sc.clause}
      GROUP BY unit_code
      HAVING SUM(bill_amt) > 0
      ORDER BY group_unit_name ASC, zh_name ASC, cl_amt DESC
    `, [...params, ...sc.params]);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/state-summary — Level 1 of the State → Unit → Executive drill.
// group_unit_name already carries the region code (RPPL / MP / CG / NATIONAL).
app.get('/api/outstanding/state-summary', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const rows = await q(`
      SELECT COALESCE(group_unit_name,'—') state_code,
        COUNT(DISTINCT unit_code) units,
        COUNT(*) agencies, COUNT(CASE WHEN cl_amt>0 THEN 1 END) with_outstanding,
        SUM(bill_amt) bill_amt,
        SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr) collected,
        SUM(cl_amt) cl_amt,
        CASE WHEN SUM(bill_amt)>0 THEN ROUND(SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr)/SUM(bill_amt)*100,1) ELSE 0 END coll_pct
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' ${clause}${sc.clause}
      GROUP BY group_unit_name
      HAVING SUM(bill_amt) > 0 OR SUM(cl_amt) <> 0
      ORDER BY cl_amt DESC
    `, [...params, ...sc.params]);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/outstanding/exec-summary — Level 3: executives within a unit (or state).
app.get('/api/outstanding/exec-summary', async (req, res) => {
  try {
    const { clause, params } = ouFilters(req.query);
    const sc = await getOuScopeFilter(req);
    const rows = await q(`
      SELECT COALESCE(NULLIF(exec_name,''),'(no executive)') exec_name,
        MAX(unit_name) unit_name, MAX(unit_code) unit_code,
        COUNT(*) agencies, COUNT(CASE WHEN cl_amt>0 THEN 1 END) with_outstanding,
        SUM(bill_amt) bill_amt,
        SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr) collected,
        SUM(cl_amt) cl_amt,
        CASE WHEN SUM(bill_amt)>0 THEN ROUND(SUM(CASE WHEN rec_amt > bill_amt*10 AND rec_amt > 1000000 THEN 0 ELSE rec_amt END+other_cr)/SUM(bill_amt)*100,1) ELSE 0 END coll_pct
      FROM agency_outstanding ao
      WHERE period_label='CURRENT' ${clause}${sc.clause}
      GROUP BY exec_name
      HAVING SUM(bill_amt) > 0 OR SUM(cl_amt) <> 0
      ORDER BY cl_amt DESC
    `, [...params, ...sc.params]);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// SHORT PAYMENT REPORT
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shortpayment/months — available monthly periods
app.get('/api/shortpayment/months', async (req, res) => {
  try {
    const r = await q(`SELECT DISTINCT period_label FROM agency_outstanding WHERE period_label != 'CURRENT' ORDER BY period_label`);
    res.json({ months: r.rows.map(x => x.period_label) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/shortpayment/report
// Fast: uses telescope formula (2 periods for totals) + per-page monthly detail
app.get('/api/shortpayment/report', async (req, res) => {
  try {
    const availR = await q(`SELECT DISTINCT period_label FROM agency_outstanding WHERE period_label != 'CURRENT' ORDER BY period_label`);
    const allLabels = availR.rows.map(r => r.period_label);
    if (!allLabels.length) return res.json({ error: 'no_monthly_data', months: [], agencies: [], total: 0, summary: {} });

    const toM   = req.query.to_month   || allLabels[allLabels.length - 1];
    const fromM = req.query.from_month || (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    const selectedLabels = allLabels.filter(l => l >= fromM && l <= toM);
    if (!selectedLabels.length) return res.json({ error: 'no_data_for_range', months: allLabels, agencies: [], total: 0, summary: {} });
    const prevLabel = allLabels.filter(l => l < fromM).pop() || null;

    // Build filter WHERE (applies to snapshot queries)
    const cls = [], prms = [];
    if (req.query.state)     { cls.push('ao.group_unit_name = ?'); prms.push(req.query.state); }
    if (req.query.zh_name)   { cls.push('ao.zh_name = ?');         prms.push(req.query.zh_name); }
    if (req.query.ag_status) { cls.push('ao.ag_status = ?');       prms.push(req.query.ag_status); }
    if (req.query.unit_code) { cls.push('ao.unit_code = ?');       prms.push(req.query.unit_code); }
    const sc = await getOuScopeFilter(req);
    const whr = (cls.length ? ' AND ' + cls.join(' AND ') : '') + sc.clause;
    const whrParams = [...prms, ...sc.params];

    const N = v => Number(v) || 0;
    const stateLabel = s => s === 'RPPL' ? 'Rajasthan' : (s || '');
    const DUMMY = '0000-00';  // placeholder that matches nothing

    // ── STEP 1: Telescope summary query (only 2 periods: prevLabel + toM) ──────
    // tot_bill = toM.bill - prevM.bill; saves fetching all intermediate periods
    const teleLabels = [toM, prevLabel || DUMMY];
    const phT = teleLabels.map(() => '?').join(',');
    // GROUP BY (unit_code, ag_code) — unique agency per unit (same ag_code can exist in multiple units)
    const summR = await q(`
      SELECT ao.ag_code, ao.unit_code,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.ag_name     ELSE NULL END) ag_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.unit_name   ELSE NULL END) unit_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.group_unit_name ELSE NULL END) group_unit_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.zh_name     ELSE NULL END) zh_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.ag_type     ELSE NULL END) ag_type,
             MAX(ao.ag_status) ag_status,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.city_name   ELSE NULL END) city_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.rep_type_name ELSE NULL END) rep_type_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.exec_name   ELSE NULL END) exec_name,
             MAX(CASE WHEN ao.bill_amt > 0 THEN ao.mobno       ELSE NULL END) mobno,
             SUM(CASE WHEN ao.period_label = ? THEN ao.cl_amt  ELSE 0 END) cur_os,
             GREATEST(0,
               SUM(CASE WHEN ao.period_label = ? THEN ao.bill_amt  ELSE 0 END) -
               SUM(CASE WHEN ao.period_label = ? THEN ao.bill_amt  ELSE 0 END)
             ) tot_bill,
             GREATEST(0,
               SUM(CASE WHEN ao.period_label = ? THEN ao.other_cr ELSE 0 END) -
               SUM(CASE WHEN ao.period_label = ? THEN ao.other_cr ELSE 0 END)
             ) tot_other_cr
      FROM agency_outstanding ao
      WHERE ao.dp_code = '0001' AND ao.period_label IN (${phT}) ${whr}
      GROUP BY ao.unit_code, ao.ag_code
      HAVING tot_bill > 0
    `, [toM, toM, prevLabel || DUMMY, toM, prevLabel || DUMMY, ...teleLabels, ...whrParams]);

    // ── Identify multi-unit ag_codes (same code in 2+ units in this period) ─────
    // e.g. M1442 in AL0 and BH3 are truly different agencies sharing a code.
    // These use unit+ag_code for collection matching; all others (H0293-style,
    // whose payment may be posted in a different unit) use ag_code only.
    const agCodeUnitCount = {};
    for (const row of summR.rows) {
      if (!agCodeUnitCount[row.ag_code]) agCodeUnitCount[row.ag_code] = new Set();
      agCodeUnitCount[row.ag_code].add(row.unit_code || '');
    }
    const multiUnitAgCodes = new Set(Object.keys(agCodeUnitCount).filter(c => agCodeUnitCount[c].size > 1));

    // ── STEP 2: Total cash receipts ───────────────────────────────────────────
    // JOIN pub_unit_master to translate branch_code (doc_no prefix) → unit_code
    // (e.g. INDORE PT: branch=PA1 → unit=IN0)
    const collFrom = `${fromM}-01`;
    const collTotR = await q(
      `SELECT ac.ag_code, COALESCE(ubm.unit_code, LEFT(ac.doc_no,3)) unit_code, SUM(ac.amount) tot_rcpt
       FROM agency_collection ac
       LEFT JOIN pub_unit_master ubm ON ubm.branch_code = LEFT(ac.doc_no,3) AND ubm.comp_code = 'RP001'
       WHERE ac.is_valid=1 AND ac.coll_date >= ? AND ac.coll_date <= LAST_DAY(?)
       GROUP BY ac.ag_code, COALESCE(ubm.unit_code, LEFT(ac.doc_no,3))`,
      [collFrom, `${toM}-01`]
    );
    const collByUnit = {};  // "unit_code|ag_code" for multi-unit agencies
    const collByCode = {};  // "ag_code" for single-unit agencies (sum across all units)
    for (const row of collTotR.rows) {
      collByUnit[(row.unit_code || '') + '|' + row.ag_code] = (collByUnit[(row.unit_code || '') + '|' + row.ag_code] || 0) + N(row.tot_rcpt);
      collByCode[row.ag_code] = (collByCode[row.ag_code] || 0) + N(row.tot_rcpt);
    }

    // ── STEP 3: Merge + classify ───────────────────────────────────────────────
    const agencies = [];
    for (const row of summR.rows) {
      const tot_bill     = N(row.tot_bill);
      const tot_other_cr = N(row.tot_other_cr);
      const tot_cash     = multiUnitAgCodes.has(row.ag_code)
        ? (collByUnit[(row.unit_code || '') + '|' + row.ag_code] || 0)
        : (collByCode[row.ag_code] || 0);
      const tot_rcpt     = tot_cash + tot_other_cr;
      const tot_diff     = tot_bill - tot_rcpt;
      const coll_pct     = tot_bill > 0 ? Math.round(tot_rcpt / tot_bill * 1000) / 10 : 0;
      const cur_os       = N(row.cur_os);
      const pay_status   = tot_rcpt === 0 && tot_bill > 100 ? 'Unpaid'
                         : tot_diff > 100                   ? 'Short Paid' : 'Fully Paid';

      if (req.query.payment_status && req.query.payment_status !== pay_status) continue;

      agencies.push({
        ag_code: row.ag_code, unit_code: row.unit_code || '',
        ag_name: row.ag_name || '', unit_name: row.unit_name || '',
        state: stateLabel(row.group_unit_name), zh_name: row.zh_name || '',
        ag_type: row.ag_type || '', ag_status: row.ag_status || '',
        city_name: row.city_name || '', rep_type_name: row.rep_type_name || '',
        exec_name: row.exec_name || '', mobno: row.mobno || '',
        tot_bill, tot_rcpt, tot_diff, coll_pct, cur_os, pay_status,
        monthly: []
      });
    }

    // ── STEP 4: Summary stats ──────────────────────────────────────────────────
    const summary = {
      total_agencies: agencies.length,
      short_agencies: agencies.filter(a => a.pay_status === 'Short Paid').length,
      unpaid_agencies: agencies.filter(a => a.pay_status === 'Unpaid').length,
      fully_paid:      agencies.filter(a => a.pay_status === 'Fully Paid').length,
      total_billed:    agencies.reduce((s, a) => s + a.tot_bill, 0),
      total_received:  agencies.reduce((s, a) => s + a.tot_rcpt, 0),
    };
    summary.total_short = summary.total_billed - summary.total_received;
    summary.coll_pct  = summary.total_billed > 0 ? Math.round(summary.total_received / summary.total_billed * 1000) / 10 : 0;
    summary.short_pct = summary.total_billed > 0 ? Math.round(summary.total_short    / summary.total_billed * 1000) / 10 : 0;

    const makeGrp = (key, label) => {
      const grp = {};
      for (const ag of agencies) {
        const k = ag[key] || 'Unknown';
        if (!grp[k]) grp[k] = { [label]: k, state: ag.state, agencies: 0, short_ag: 0, billed: 0, received: 0 };
        grp[k].agencies++; grp[k].billed += ag.tot_bill; grp[k].received += ag.tot_rcpt;
        if (ag.pay_status !== 'Fully Paid') grp[k].short_ag++;
      }
      return Object.values(grp).map(s => ({ ...s, diff: s.billed - s.received,
        coll_pct: s.billed > 0 ? Math.round(s.received / s.billed * 1000) / 10 : 0 })).sort((a, b) => b.diff - a.diff);
    };
    summary.by_state = makeGrp('state', 'state');
    summary.by_zh    = makeGrp('zh_name', 'zh_name');

    // ── Sort ──────────────────────────────────────────────────────────────────
    agencies.sort((a, b) => b.tot_diff - a.tot_diff);
    const page = Math.max(1, parseInt(req.query.page  || '1',  10));
    const lim  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const total = agencies.length;

    // ── CSV export ─────────────────────────────────────────────────────────────
    if (req.query.export === 'csv') {
      const fmtM = l => { const [y,m] = l.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)-1]+' '+y; };
      const hdrs = ['State','Zonal Head','Unit','Agency Name','Agency Code','City','Type','Executive','Mobile','Status',
        'Total Bill','Total Rcpt','Total Diff','Coll%','OS Balance','Payment Status'].join(',');
      const rows = agencies.map(ag => [
        ag.state, ag.zh_name, ag.unit_name, `"${(ag.ag_name||'').replace(/"/g,'""')}"`, ag.ag_code,
        ag.city_name, ag.rep_type_name, ag.exec_name, ag.mobno, ag.ag_status,
        Math.round(ag.tot_bill), Math.round(ag.tot_rcpt), Math.round(ag.tot_diff),
        ag.coll_pct, Math.round(ag.cur_os), ag.pay_status
      ].join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="short_payment_${fromM}_${toM}.csv"`);
      return res.send('﻿' + [hdrs, ...rows].join('\r\n'));
    }

    // ── STEP 5: Monthly detail for this page only (7 periods × ~50 agencies) ──
    const pageAgencies = agencies.slice((page - 1) * lim, page * lim);
    if (pageAgencies.length > 0) {
      const agCodes     = [...new Set(pageAgencies.map(a => a.ag_code))];
      const unitCodes   = [...new Set(pageAgencies.map(a => a.unit_code))];
      const phCodes     = agCodes.map(() => '?').join(',');
      const phUnits     = unitCodes.map(() => '?').join(',');
      const queryLabels = prevLabel ? [prevLabel, ...selectedLabels] : selectedLabels;
      const phPeriods   = queryLabels.map(() => '?').join(',');

      const [detailR, detailCollR] = await Promise.all([
        q(`SELECT unit_code, ag_code, period_label,
                  SUM(bill_amt) bill_amt, SUM(other_cr) other_cr, SUM(cl_amt) cl_amt, SUM(op_amt) op_amt
           FROM agency_outstanding
           WHERE dp_code='0001' AND period_label IN (${phPeriods})
             AND ag_code IN (${phCodes}) AND unit_code IN (${phUnits})
           GROUP BY unit_code, ag_code, period_label`,
          [...queryLabels, ...agCodes, ...unitCodes]),
        q(`SELECT ac.ag_code, COALESCE(ubm.unit_code, LEFT(ac.doc_no,3)) unit_code,
                  DATE_FORMAT(ac.coll_date,'%Y-%m') month_key, SUM(ac.amount) collected
           FROM agency_collection ac
           LEFT JOIN pub_unit_master ubm ON ubm.branch_code = LEFT(ac.doc_no,3) AND ubm.comp_code = 'RP001'
           WHERE ac.is_valid=1 AND DATE_FORMAT(ac.coll_date,'%Y-%m') IN (${selectedLabels.map(() => '?').join(',')})
             AND ac.ag_code IN (${phCodes})
           GROUP BY ac.ag_code, COALESCE(ubm.unit_code, LEFT(ac.doc_no,3)), DATE_FORMAT(ac.coll_date,'%Y-%m')`,
          [...selectedLabels, ...agCodes])
      ]);

      // Key snapshots by "unit_code|ag_code"
      const snapsMap = {};
      for (const row of detailR.rows) {
        const k = (row.unit_code || '') + '|' + row.ag_code;
        if (!snapsMap[k]) snapsMap[k] = {};
        snapsMap[k][row.period_label] = row;
      }
      // For collection: two maps — by unit_code+ag_code+month (multi-unit) and by ag_code+month (single-unit)
      // unit_code is already translated from branch_code via pub_unit_master JOIN
      const collMonthByUnit = {};  // "unit_code|ag_code|month_key"
      const collMonthByCode = {};  // "ag_code|month_key"
      for (const row of detailCollR.rows) {
        const uak = (row.unit_code || '') + '|' + row.ag_code + '|' + row.month_key;
        collMonthByUnit[uak] = (collMonthByUnit[uak] || 0) + N(row.collected);
        const ak = row.ag_code + '|' + row.month_key;
        collMonthByCode[ak] = (collMonthByCode[ak] || 0) + N(row.collected);
      }

      for (const ag of pageAgencies) {
        const uk      = (ag.unit_code || '') + '|' + ag.ag_code;
        const agSnaps = snapsMap[uk] || {};
        const isMulti = multiUnitAgCodes.has(ag.ag_code);
        let prevSnap  = prevLabel ? agSnaps[prevLabel] : null;
        const firstSnap = agSnaps[selectedLabels[0]];
        if (firstSnap) ag.op_bal = N(firstSnap.op_amt);

        for (const label of selectedLabels) {
          const snap = agSnaps[label];
          if (!snap) { ag.monthly.push({ label, bill: 0, rcpt: 0, diff: 0 }); prevSnap = null; continue; }
          const bill          = prevSnap ? Math.max(0, N(snap.bill_amt) - N(prevSnap.bill_amt)) : N(snap.bill_amt);
          const cash          = isMulti
            ? (collMonthByUnit[(ag.unit_code || '') + '|' + ag.ag_code + '|' + label] || 0)
            : (collMonthByCode[ag.ag_code + '|' + label] || 0);
          const other_cr_diff = prevSnap ? Math.max(0, N(snap.other_cr) - N(prevSnap.other_cr)) : N(snap.other_cr);
          ag.monthly.push({ label, bill, rcpt: cash + other_cr_diff, diff: bill - cash - other_cr_diff });
          prevSnap = snap;
        }
      }
    }

    res.json({ months: selectedLabels, all_months: allLabels, summary, total, page, limit: lim,
               agencies: pageAgencies });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// OUTSTANDING SYNC — API + 7 AM DAILY SCHEDULER
// ════════════════════════════════════════════════════════════════════════════
const ouSync = require('./oracle_outstanding_sync');

// In-memory sync state (reset on server restart)
const ouSyncState = {
  running: false,
  lastStarted: null,
  lastCompleted: null,
  lastStatus: 'never',   // 'never' | 'running' | 'success' | 'error'
  lastResult: null,
  lastError: null,
  log: [],
};

function startOutstandingSync(opts = {}) {
  if (ouSyncState.running) return { started: false, reason: 'already running' };
  ouSyncState.running = true;
  ouSyncState.lastStarted = new Date().toISOString();
  ouSyncState.lastStatus = 'running';
  ouSyncState.log = [];
  ouSyncState.lastError = null;

  ouSync.runSync({
    ...opts,
    onLog: line => {
      ouSyncState.log.push(line);
      if (ouSyncState.log.length > 500) ouSyncState.log.shift();
    },
  }).then(result => {
    ouSyncState.running = false;
    ouSyncState.lastCompleted = new Date().toISOString();
    ouSyncState.lastStatus = 'success';
    ouSyncState.lastResult = result;
    console.log(`[outstanding-sync] Done — ${result.totalRows} rows`);
  }).catch(err => {
    ouSyncState.running = false;
    ouSyncState.lastCompleted = new Date().toISOString();
    ouSyncState.lastStatus = 'error';
    ouSyncState.lastError = err.message;
    console.error('[outstanding-sync] Error:', err.message);
  });

  return { started: true };
}

// POST /api/sync/outstanding  — manual trigger
// Body (optional JSON): { monthly: true }
app.post('/api/sync/outstanding', (req, res) => {
  const result = startOutstandingSync({ monthly: !!(req.body && req.body.monthly) });
  if (!result.started) return res.status(409).json({ error: result.reason });
  res.json({ ok: true, message: 'Sync started', startedAt: ouSyncState.lastStarted });
});

// GET /api/sync/outstanding/status
app.get('/api/sync/outstanding/status', (req, res) => {
  res.json({
    running:       ouSyncState.running,
    lastStarted:   ouSyncState.lastStarted,
    lastCompleted: ouSyncState.lastCompleted,
    status:        ouSyncState.lastStatus,
    result:        ouSyncState.lastResult,
    error:         ouSyncState.lastError,
    recentLog:     ouSyncState.log.slice(-50),
  });
});

// 7 AM daily scheduler (no external package — pure setTimeout chain)
function scheduleNextSync() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    console.log('[outstanding-sync] 7 AM daily trigger firing');
    startOutstandingSync({ monthly: false });
    scheduleNextSync();
  }, delay);
  console.log(`[outstanding-sync] Next auto-sync at ${next.toLocaleString('en-IN')}`);
}
scheduleNextSync();

// ════════════════════════════════════════════════════════════════════════════
// COLLECTION DASHBOARD ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

function colFilters(query) {
  const clauses = [], params = [];
  if (query.from)    { clauses.push('coll_date >= ?');   params.push(query.from); }
  if (query.to)      { clauses.push('coll_date <= ?');   params.push(query.to); }
  if (query.state)   { clauses.push('state_name = ?');   params.push(query.state); }
  if (query.branch)  { clauses.push('branch_name = ?');  params.push(query.branch); }
  if (query.district){ clauses.push('district_name = ?');params.push(query.district); }
  if (query.ag_code) { clauses.push('ag_code = ?');      params.push(query.ag_code); }
  if (query.payment_cat) { clauses.push('payment_cat = ?'); params.push(query.payment_cat); }
  const clause = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
  return { clause, params };
}

// Same as colFilters but strips date range — used for MTD/YTD so they are never
// contradicted by the user's date filter selection.
function colFiltersNoDate(query) {
  const clauses = [], params = [];
  if (query.state)   { clauses.push('state_name = ?');   params.push(query.state); }
  if (query.branch)  { clauses.push('branch_name = ?');  params.push(query.branch); }
  if (query.district){ clauses.push('district_name = ?');params.push(query.district); }
  if (query.ag_code) { clauses.push('ag_code = ?');      params.push(query.ag_code); }
  const clause = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
  return { clause, params };
}

// GET /api/collection/billing-vs-collection
// Billing (agency_outstanding.bill_amt for the bill month) vs Collection (agency_collection
// receipts over the collection date range), state-wise + unit-wise.
// Default: collection = current month → today, bill month = the calendar month before it
// (e.g. bill July → collection Aug). Params: from, to, bill_month(YYYY-MM), state_name, unit_code.
app.get('/api/collection/billing-vs-collection', async (req, res) => {
  try {
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const defFrom = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const defTo   = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const from = String(req.query.from || defFrom).slice(0, 10);
    const to   = String(req.query.to   || defTo).slice(0, 10);
    // Bill month = explicit, else the calendar month BEFORE the collection range start
    let billMonth = String(req.query.bill_month || '').trim();
    if (!billMonth) {
      const d = new Date(from + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - 1);
      billMonth = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    }
    const stateF = String(req.query.state_name || '').trim();
    const unitF  = String(req.query.unit_code  || '').trim();

    // Role scope (non-admin → restrict to allowed units)
    const { personCode, hl } = scopeHdrs(req);
    const scoped = await getScopeUnitCodes(personCode, hl); // null = all
    const unitCl = (col) => {
      if (unitF) return { cls: ` AND ${col} = ?`, p: [unitF] };
      if (scoped && !scoped.length) return { cls: ' AND 1=0', p: [] };
      if (scoped) return { cls: ` AND ${col} IN (${scoped.map(() => '?').join(',')})`, p: scoped };
      return { cls: '', p: [] };
    };

    // Billing FOR the month. Preferred source: a "BILL-YYYY-MM" snapshot produced by running the
    // ERP Party Outstanding report dated the FIRST of the NEXT month (from=to=01-<next>-YYYY).
    // In that snapshot bill_amt is already the month's billing and matches the ERP report exactly
    // (e.g. BILL-2026-07 → JAIPUR 7,653,837, all-India 113,542,947).
    // Fallback for months without a snapshot: cumulative delta (this month − previous month),
    // since a normal period pull's bill_amt is cumulative from Jan 1.
    const billLabel = `BILL-${billMonth}`;
    const snapChk = await q(`SELECT 1 FROM agency_outstanding WHERE period_label = ? LIMIT 1`, [billLabel]);
    const useSnap = snapChk.rows.length > 0;

    let prevMonth = null;
    if (/^\d{4}-\d{2}$/.test(billMonth)) {
      const [yy, mm] = billMonth.split('-').map(Number);
      if (mm > 1) prevMonth = `${yy}-${String(mm - 1).padStart(2, '0')}`; // Jan: cumulative == monthly
    } else {
      const pr = await q(`SELECT MAX(period_label) pl FROM agency_outstanding WHERE period_label <> 'CURRENT' AND period_label < ?`,
        [billMonth === 'CURRENT' ? '9999-99' : billMonth]);
      prevMonth = pr.rows[0]?.pl || null;
    }
    const prevM = prevMonth || '__none__';

    const bw = unitCl('unit_code'), cw = unitCl('unit_code');
    const billingQ = useSnap
      ? q(`SELECT unit_code, MAX(unit_name) unit_name, SUM(bill_amt) billing
             FROM agency_outstanding WHERE period_label = ?${bw.cls}
             GROUP BY unit_code`, [billLabel, ...bw.p])
      : q(`SELECT unit_code, MAX(unit_name) unit_name,
                  SUM(CASE WHEN period_label = ? THEN bill_amt ELSE 0 END)
                - SUM(CASE WHEN period_label = ? THEN bill_amt ELSE 0 END) billing
             FROM agency_outstanding WHERE period_label IN (?, ?)${bw.cls}
             GROUP BY unit_code`, [billMonth, prevM, billMonth, prevM, ...bw.p]);

    const [billing, collection, stmap] = await Promise.all([
      billingQ,
      q(`SELECT unit_code, MAX(state_name) state_name, MAX(branch_name) unit_name,
                -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) collection
         FROM agency_collection
         WHERE is_valid = 1 AND coll_date BETWEEN ? AND ?${cw.cls}
         GROUP BY unit_code`, [from, to, ...cw.p]),
      q(`SELECT unit_code, MAX(state_name) state_name FROM agency_collection
         WHERE state_name IS NOT NULL AND state_name <> '' GROUP BY unit_code`),
    ]);

    const u2s = {}; stmap.rows.forEach(r => { u2s[r.unit_code] = r.state_name; });
    const byUnit = {};
    const ensure = (uc, nm) => (byUnit[uc] = byUnit[uc] || { unit_code: uc, unit_name: nm || uc, state: null, billing: 0, collection: 0 });
    billing.rows.forEach(r => { const u = ensure(r.unit_code, r.unit_name); u.billing = Number(r.billing) || 0; if (r.unit_name) u.unit_name = r.unit_name; });
    collection.rows.forEach(r => { const u = ensure(r.unit_code, r.unit_name); u.collection = Number(r.collection) || 0; if (r.state_name) u.state = r.state_name; if (r.unit_name) u.unit_name = r.unit_name; });

    let units = Object.values(byUnit).map(u => {
      const state = u.state || u2s[u.unit_code] || '—';
      return { unit_code: u.unit_code, unit_name: u.unit_name, state,
        billing: Math.round(u.billing), collection: Math.round(u.collection),
        outstanding: Math.round(u.billing - u.collection),
        coll_pct: u.billing ? Math.round(u.collection / u.billing * 1000) / 10 : null };
    });
    if (stateF) units = units.filter(u => u.state === stateF);
    units.sort((a, b) => (a.state === b.state ? b.billing - a.billing : (a.state < b.state ? -1 : 1)));

    // State-wise summary: core states stay separate; all other states → NATIONAL bucket
    const CORE = new Set(['RAJASTHAN', 'MADHYA PRADESH', 'CHHATTISGARH']);
    const regionOf = s => CORE.has(String(s || '').toUpperCase()) ? String(s).toUpperCase() : 'NATIONAL';
    const st = {};
    units.forEach(u => { const rg = regionOf(u.state); const s = st[rg] = st[rg] || { state: rg, billing: 0, collection: 0, units: 0 };
      s.billing += u.billing; s.collection += u.collection; s.units++; });
    const states = Object.values(st).map(s => ({ ...s, outstanding: s.billing - s.collection,
      coll_pct: s.billing ? Math.round(s.collection / s.billing * 1000) / 10 : null }))
      .sort((a, b) => (a.state === 'NATIONAL') - (b.state === 'NATIONAL') || b.billing - a.billing);

    const tb = states.reduce((a, s) => a + s.billing, 0), tc = states.reduce((a, s) => a + s.collection, 0);
    res.json({ bill_month: billMonth, coll_from: from, coll_to: to, states, units,
      bill_source: useSnap ? 'erp_snapshot' : 'cumulative_delta',
      total_billing: tb, total_collection: tc, total_outstanding: tb - tc,
      total_pct: tb ? Math.round(tc / tb * 1000) / 10 : null });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/filters
// Dropdown options are slow-changing reference data derived from full-table scans, so they are
// cached in-memory per scope (TTL below) to avoid a multi-second scan on every dashboard load.
const _colFiltersCache = new Map(); // key -> { data, exp }
const COL_FILTERS_TTL_MS = 30 * 60 * 1000;
app.get('/api/collection/filters', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const key = sc.clause + '|' + JSON.stringify(sc.params);
    const now = Date.now();
    const hit = _colFiltersCache.get(key);
    if (hit && hit.exp > now && !('refresh' in req.query)) return res.json(hit.data);

    const [states, branches, districts, cats, agencies] = await Promise.all([
      q(`SELECT DISTINCT state_name FROM agency_collection WHERE state_name IS NOT NULL${sc.clause} ORDER BY state_name`, sc.params),
      q(`SELECT DISTINCT branch_name FROM agency_collection WHERE branch_name IS NOT NULL${sc.clause} ORDER BY branch_name`, sc.params),
      q(`SELECT DISTINCT district_name FROM agency_collection WHERE district_name IS NOT NULL${sc.clause} ORDER BY district_name`, sc.params),
      q(`SELECT DISTINCT payment_cat FROM agency_collection WHERE payment_cat IS NOT NULL${sc.clause} ORDER BY payment_cat`, sc.params),
      q(`SELECT DISTINCT ag_code, MAX(ag_name) ag_name FROM agency_collection WHERE ag_code IS NOT NULL${sc.clause} GROUP BY ag_code ORDER BY MAX(ag_name)`, sc.params),
    ]);
    const data = {
      states: states.rows.map(r => r.state_name),
      branches: branches.rows.map(r => r.branch_name),
      districts: districts.rows.map(r => r.district_name),
      payment_cats: cats.rows.map(r => r.payment_cat),
      agencies: agencies.rows,
    };
    _colFiltersCache.set(key, { data, exp: now + COL_FILTERS_TTL_MS });
    res.json(data);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/kpis
app.get('/api/collection/kpis', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const { clause: ndc, params: ndp } = colFiltersNoDate(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const ndClause = ndc + sc.clause, ndParams = [...ndp, ...sc.params];
    // MTD/YTD anchor on the LATEST collection date, not today's calendar date —
    // data is imported with a lag, so calendar-month MTD would show 0 on the 1st.
    const { rows: lastRows } = await q(
      `SELECT MAX(coll_date) last_date FROM agency_collection WHERE is_valid=1 ${ndClause}`, ndParams);
    const anchor = lastRows[0]?.last_date
      ? new Date(lastRows[0].last_date).toISOString().slice(0,10)
      : new Date().toISOString().slice(0,10);
    const monthStart = anchor.slice(0,8) + '01';
    const yearStart  = anchor.slice(0,5) + '01-01';
    const [total, todayR, mtd, ytd, agencies, modes, trend] = await Promise.all([
      q(`SELECT -COALESCE(SUM(amount),0) tot, COUNT(*) txn FROM agency_collection WHERE is_valid=1 ${clause}`, params),
      q(`SELECT -COALESCE(SUM(amount),0) tot FROM agency_collection WHERE is_valid=1 AND coll_date=? ${ndClause}`, [anchor, ...ndParams]),
      q(`SELECT -COALESCE(SUM(amount),0) tot FROM agency_collection WHERE is_valid=1 AND coll_date>=? AND coll_date<=? ${ndClause}`, [monthStart, anchor, ...ndParams]),
      q(`SELECT -COALESCE(SUM(amount),0) tot FROM agency_collection WHERE is_valid=1 AND coll_date>=? AND coll_date<=? ${ndClause}`, [yearStart, anchor, ...ndParams]),
      q(`SELECT COUNT(DISTINCT ag_code) cnt, -COALESCE(SUM(amount)/NULLIF(COUNT(DISTINCT ag_code),0),0) avg_ag, -MIN(amount) highest FROM agency_collection WHERE is_valid=1 ${clause}`, params),
      q(`SELECT payment_cat, -COALESCE(SUM(amount),0) amt FROM agency_collection WHERE is_valid=1 ${clause} GROUP BY payment_cat`, params),
      q(`SELECT MAX(coll_date) last_date, MIN(coll_date) first_date FROM agency_collection WHERE is_valid=1 ${clause}`, params),
    ]);
    const cash    = (modes.rows.find(r=>r.payment_cat==='Cash')||{}).amt || 0;
    const digital = modes.rows.filter(r=>r.payment_cat!=='Cash').reduce((s,r)=>s+Number(r.amt||0),0);
    res.json({
      total_collection:   Number(total.rows[0].tot),
      total_txn:          Number(total.rows[0].txn),
      today_collection:   Number(todayR.rows[0].tot),
      mtd_collection:     Number(mtd.rows[0].tot),
      ytd_collection:     Number(ytd.rows[0].tot),
      agencies_paid:      Number(agencies.rows[0].cnt),
      avg_per_agency:     Number(agencies.rows[0].avg_ag),
      highest_collection: Number(agencies.rows[0].highest),
      cash_collection:    Number(cash),
      digital_collection: Number(digital),
      last_date:          trend.rows[0].last_date,
      first_date:         trend.rows[0].first_date,
      payment_modes:      modes.rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/trend?granularity=daily|weekly|monthly
app.get('/api/collection/trend', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const gran = req.query.granularity || 'monthly';
    let groupExpr;
    if (gran === 'daily')        groupExpr = 'DATE(coll_date)';
    else if (gran === 'weekly')  groupExpr = 'DATE(DATE_SUB(coll_date, INTERVAL WEEKDAY(coll_date) DAY))';
    else                         groupExpr = "DATE_FORMAT(coll_date,'%Y-%m-01')";
    const rows = await q(`
      SELECT ${groupExpr} period, -COALESCE(SUM(amount),0) amount, COUNT(*) txn,
             COUNT(DISTINCT ag_code) agencies
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY ${groupExpr}
      ORDER BY ${groupExpr}
    `, params);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/payment-modes
app.get('/api/collection/payment-modes', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const rows = await q(`
      SELECT payment_cat, payment_mode,
             -COALESCE(SUM(amount),0) amount, COUNT(*) txn
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY payment_cat, payment_mode
      ORDER BY payment_cat, amount DESC
    `, params);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/app-usage — state/unit wise agent-app (payment gateway) adoption
app.get('/api/collection/app-usage', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const { rows } = await q(`
      SELECT state_name, branch_name,
             COUNT(DISTINCT ag_code) AS agencies,
             COUNT(DISTINCT CASE WHEN payment_mode LIKE 'PAYMENT GAT%' THEN ag_code END) AS app_agencies,
             -COALESCE(SUM(CASE WHEN payment_mode LIKE 'PAYMENT GAT%' THEN amount ELSE 0 END),0) AS app_amount,
             -COALESCE(SUM(amount),0) AS total_amount
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY state_name, branch_name
      ORDER BY state_name, branch_name
    `, params);
    res.json({ rows: rows.map(r => ({
      state_name:   r.state_name || '—',
      branch_name:  r.branch_name || '—',
      agencies:     Number(r.agencies) || 0,
      app_agencies: Number(r.app_agencies) || 0,
      app_amount:   Number(r.app_amount) || 0,
      total_amount: Number(r.total_amount) || 0,
      app_pct:      Number(r.total_amount) > 0 ? Math.round(Number(r.app_amount) / Number(r.total_amount) * 1000) / 10 : 0,
    })) });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/agencies  — ranked agency list
app.get('/api/collection/agencies', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const limit = Math.min(parseInt(req.query.limit||'200',10), 500);
    const rows = await q(`
      SELECT ag_code, MAX(ag_name) ag_name, MAX(branch_name) branch_name, MAX(state_name) state_name,
             -COALESCE(SUM(amount),0) total_amount, COUNT(*) txn,
             MAX(coll_date) last_payment_date,
             DATEDIFF(CURDATE(), MAX(coll_date)) days_since
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY ag_code
      ORDER BY total_amount DESC
      LIMIT ${limit}
    `, params);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/agency-behavior  — per-agency payment behaviour
app.get('/api/collection/agency-behavior', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const limit = Math.min(parseInt(req.query.limit||'200',10), 500);
    const rows = await q(`
      SELECT ag_code, MAX(ag_name) ag_name, MAX(branch_name) branch_name, MAX(state_name) state_name,
             MAX(coll_date) last_payment, MIN(coll_date) first_payment,
             DATEDIFF(CURDATE(), MAX(coll_date)) days_since,
             COUNT(*) num_payments,
             -COALESCE(AVG(amount),0) avg_amount,
             -MIN(amount) highest,
             -MAX(amount) lowest,
             -COALESCE(SUM(amount),0) total_amount,
             ROUND(COUNT(*) / NULLIF(DATEDIFF(MAX(coll_date),MIN(coll_date)),0) * 30, 2) freq_per_month
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY ag_code
      ORDER BY total_amount DESC
      LIMIT ${limit}
    `, params);
    res.json({ rows: rows.rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── Collection: State → Unit → Executive drill ────────────────────────────────
// Core states stand alone; every other state collapses into NATIONAL.
const COL_REGION_CASE = `CASE WHEN UPPER(state_name) IN ('RAJASTHAN','MADHYA PRADESH','CHHATTISGARH') THEN UPPER(state_name) ELSE 'NATIONAL' END`;
function colRegionWhere(region) {
  const r = String(region || '').toUpperCase();
  if (!r) return { clause: '', params: [] };
  if (r === 'NATIONAL') return { clause: ` AND (state_name IS NULL OR UPPER(state_name) NOT IN ('RAJASTHAN','MADHYA PRADESH','CHHATTISGARH'))`, params: [] };
  return { clause: ` AND UPPER(state_name) = ?`, params: [r] };
}
// Agency → executive map (main-agency rows of the agency master).
const COL_EXEC_JOIN = `LEFT JOIN (SELECT unit, agcd, MAX(executive_name) executive_name FROM agency_master GROUP BY unit, agcd) am ON am.unit = ac.unit_code AND am.agcd = ac.ag_code`;

// GET /api/collection/state-summary — Level 1
app.get('/api/collection/state-summary', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const { rows } = await q(`
      SELECT ${COL_REGION_CASE} region,
             -COALESCE(SUM(amount),0) amount, COUNT(*) txn,
             COUNT(DISTINCT ag_code) agencies, COUNT(DISTINCT branch_name) units
      FROM agency_collection
      WHERE is_valid=1 ${clause}
      GROUP BY region ORDER BY amount DESC`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/unit-summary?state=REGION — Level 2 (units within a region)
app.get('/api/collection/unit-summary', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req);
    const { clause: rc, params: rp } = colFilters(req.query);
    const rw = colRegionWhere(req.query.region);
    const clause = rc + rw.clause + sc.clause, params = [...rp, ...rw.params, ...sc.params];
    const { rows } = await q(`
      SELECT branch_name unit_name, MAX(unit_code) unit_code, MAX(state_name) state_name,
             -COALESCE(SUM(amount),0) amount, COUNT(*) txn, COUNT(DISTINCT ag_code) agencies
      FROM agency_collection
      WHERE is_valid=1 AND branch_name IS NOT NULL ${clause}
      GROUP BY branch_name ORDER BY amount DESC`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/exec-summary?branch=UNIT — Level 3 (executives within a unit)
app.get('/api/collection/exec-summary', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req, 'ac');
    const { clause: rc, params: rp } = colFilters(req.query);
    const clause = rc + sc.clause, params = [...rp, ...sc.params];
    const { rows } = await q(`
      SELECT COALESCE(NULLIF(am.executive_name,''),'(no executive)') exec_name,
             -COALESCE(SUM(ac.amount),0) amount, COUNT(*) txn, COUNT(DISTINCT ac.ag_code) agencies
      FROM agency_collection ac ${COL_EXEC_JOIN}
      WHERE ac.is_valid=1 ${clause}
      GROUP BY exec_name ORDER BY amount DESC`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// GET /api/collection/exec-agencies?branch=UNIT&exec=NAME — Level 4 (an executive's agencies)
app.get('/api/collection/exec-agencies', async (req, res) => {
  try {
    const sc = await getColScopeFilter(req, 'ac');
    const { clause: rc, params: rp } = colFilters(req.query);
    const exec = String(req.query.exec || '').trim();
    const clause = rc + sc.clause, params = [...rp, ...sc.params, exec];
    const { rows } = await q(`
      SELECT ac.ag_code, MAX(ac.ag_name) ag_name,
             -COALESCE(SUM(ac.amount),0) amount, COUNT(*) txn,
             MAX(ac.coll_date) last_date, DATEDIFF(CURDATE(), MAX(ac.coll_date)) days_since
      FROM agency_collection ac ${COL_EXEC_JOIN}
      WHERE ac.is_valid=1 ${clause}
        AND COALESCE(NULLIF(am.executive_name,''),'(no executive)') = ?
      GROUP BY ac.ag_code ORDER BY amount DESC LIMIT 300`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── Agency Master ─────────────────────────────────────────────────────────────

app.get('/api/agency-master/filters', async (req, res) => {
  try {
    const [states, units, agTypes, agClasses, executives] = await Promise.all([
      q(`SELECT DISTINCT state_code, state_name
         FROM agency_master
         WHERE state_code IS NOT NULL AND state_name IS NOT NULL
         ORDER BY state_name`),
      q(`SELECT DISTINCT unit, unit_name
         FROM agency_master
         WHERE unit IS NOT NULL
         ORDER BY unit_name`),
      q(`SELECT DISTINCT ag_type, ag_type_name
         FROM agency_master
         WHERE ag_type IS NOT NULL
         ORDER BY ag_type_name`),
      q(`SELECT DISTINCT ag_class, ag_class_name
         FROM agency_master
         WHERE ag_class IS NOT NULL
         ORDER BY ag_class_name`),
      q(`SELECT DISTINCT executive_code, executive_name
         FROM agency_master
         WHERE executive_code IS NOT NULL AND executive_name IS NOT NULL
         ORDER BY executive_name`),
    ]);
    res.json({
      states:     states.rows,
      units:      units.rows,
      ag_types:   agTypes.rows,
      ag_classes: agClasses.rows,
      executives: executives.rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.get('/api/agency-master', async (req, res) => {
  try {
    const {
      unit, state_code, ag_type, ag_class, executive_code,
      supply_stop_flag, search,
      page = '1', limit: lim = '50',
    } = req.query;

    const conditions = [];
    const params     = [];

    if (unit)             { conditions.push('unit = ?');              params.push(unit); }
    if (state_code)       { conditions.push('state_code = ?');        params.push(state_code); }
    if (ag_type)          { conditions.push('ag_type = ?');           params.push(ag_type); }
    if (ag_class)         { conditions.push('ag_class = ?');          params.push(ag_class); }
    if (executive_code)   { conditions.push('executive_code = ?');    params.push(executive_code); }
    if (supply_stop_flag) { conditions.push('supply_stop_flag = ?');  params.push(supply_stop_flag); }

    if (search) {
      conditions.push(`(ag_name LIKE ? OR agcd LIKE ? OR dpcd LIKE ? OR mobile_no1 LIKE ? OR agent_name LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const pageNum  = Math.max(1, parseInt(page, 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(lim, 10)));
    const offset   = (pageNum - 1) * pageSize;

    const [{ rows: [{ total }] }, { rows }] = await Promise.all([
      q(`SELECT COUNT(*) AS total FROM agency_master ${where}`, params),
      q(`SELECT agcd, dpcd, ag_name, ag_type_name, ag_class_name,
                unit, unit_name, unit_state_nm,
                executive_code, executive_name,
                city_name, dist_name, state_name,
                mobile_no1, email_id,
                field_officer_name, ho_coordinator_name,
                supply_start_dt, suspend_date, suspend_type,
                supply_stop_flag, is_corrospondent, iscenter,
                new_replace_agency, agent_name, address
         FROM agency_master ${where}
         ORDER BY unit_name, agcd
         LIMIT ${pageSize} OFFSET ${offset}`, params),
    ]);

    res.json({
      total:     Number(total),
      page:      pageNum,
      page_size: pageSize,
      pages:     Math.ceil(Number(total) / pageSize),
      rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── Supply Data ───────────────────────────────────────────────────────────────

// Returns true if supply_data table exists
async function supplyTableExists() {
  try {
    const { rows } = await q(
      `SELECT 1 FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supply_data' LIMIT 1`
    );
    return rows.length > 0;
  } catch (_) { return false; }
}

// Filters: states, units, publications, editions, supply types
app.get('/api/supply/filters', async (req, res) => {
  if (!(await supplyTableExists()))
    return res.json({ states: [], units: [], publs: [], edtns: [], sup_types: [], _note: 'Run historical sync first' });
  try {
    const [states, units, publs, edtns, supTypes] = await Promise.all([
      q(`SELECT DISTINCT state_code, state_name FROM supply_data
         WHERE state_code IS NOT NULL ORDER BY state_name`),
      q(`SELECT DISTINCT unit_code, unit_name FROM supply_data
         WHERE unit_code IS NOT NULL ORDER BY unit_name`),
      q(`SELECT DISTINCT publ, publ_name FROM supply_data
         WHERE publ IS NOT NULL ORDER BY publ_name`),
      q(`SELECT DISTINCT edtn, edtn_name FROM supply_data
         WHERE edtn IS NOT NULL ORDER BY edtn_name`),
      q(`SELECT DISTINCT sup_type_code, supply_type_name FROM supply_data
         WHERE sup_type_code IS NOT NULL ORDER BY supply_type_name`),
    ]);
    res.json({
      states:    states.rows,
      units:     units.rows,
      publs:     publs.rows,
      edtns:     edtns.rows,
      sup_types: supTypes.rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.get('/api/supply/comparison', async (req, res) => {
  if (!(await supplyTableExists()))
    return res.json({ rows: [], _note: 'Run historical sync first' });
  try {
    const {
      group_by = 'state',
      target_from,
      target_to,
      publ, edtn, sup_type_code,
    } = req.query;

    const groupCol  = group_by === 'unit' ? 'unit_code' : 'state_code';
    const nameCol   = group_by === 'unit' ? 'unit_name'  : 'state_name';

    const filters  = [];
    const fParams  = [];
    if (publ)          { filters.push('publ = ?');          fParams.push(publ); }
    if (edtn)          { filters.push('edtn = ?');          fParams.push(edtn); }
    if (sup_type_code) { filters.push('sup_type_code = ?'); fParams.push(sup_type_code); }
    const fWhere = filters.length ? ' AND ' + filters.join(' AND ') : '';

    // Pre-COVID baseline: 18 March 2020
    const COVID_DATE = '2020-03-18';
    const [covidRows] = await q(
      `SELECT ${groupCol} grp, MAX(${nameCol}) grp_name, SUM(sup_copy) supply
       FROM supply_data
       WHERE supply_date = ?${fWhere}
         AND ${groupCol} IS NOT NULL
       GROUP BY ${groupCol}`,
      [COVID_DATE, ...fParams]
    );

    // Target period (default: current month)
    const tFrom = target_from || new Date().toISOString().slice(0, 7) + '-01';
    const tTo   = target_to   || new Date().toISOString().slice(0, 10);
    const targetDays = Math.max(1,
      Math.round((new Date(tTo) - new Date(tFrom)) / 86400000) + 1);

    const [targetRows] = await q(
      `SELECT ${groupCol} grp, MAX(${nameCol}) grp_name,
              SUM(sup_copy) supply,
              COUNT(DISTINCT supply_date) days
       FROM supply_data
       WHERE supply_date >= ? AND supply_date <= ?${fWhere}
         AND ${groupCol} IS NOT NULL
       GROUP BY ${groupCol}`,
      [tFrom, tTo, ...fParams]
    );

    // Build COVID map
    const covidMap = {};
    for (const r of covidRows) covidMap[r.grp] = Number(r.supply);

    // Merge
    const rows = targetRows.map(r => {
      const current  = Number(r.supply);
      const covid    = covidMap[r.grp] || 0;
      const days     = Number(r.days) || 1;
      const covidDailyAvg = covid;          // covid = 1 day total, so it IS the daily figure
      const currentDailyAvg = current / days;
      const change   = currentDailyAvg - covidDailyAvg;
      const changePct = covidDailyAvg > 0
        ? ((change / covidDailyAvg) * 100).toFixed(1)
        : null;
      return {
        grp:               r.grp,
        grp_name:          r.grp_name,
        covid_supply:      covid,
        current_supply:    current,
        current_days:      days,
        current_daily_avg: Math.round(currentDailyAvg),
        daily_change:      Math.round(change),
        change_pct:        changePct !== null ? Number(changePct) : null,
      };
    }).sort((a, b) => b.current_supply - a.current_supply);

    res.json({
      group_by,
      covid_date: COVID_DATE,
      target_from: tFrom,
      target_to: tTo,
      rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.get('/api/supply/trend', async (req, res) => {
  if (!(await supplyTableExists()))
    return res.json({ rows: [], covid_reference: null, _note: 'Run historical sync first' });
  try {
    const {
      state_code, unit_code, publ, edtn, sup_type_code,
      from_date, to_date,
    } = req.query;

    const filters = [];
    const params  = [];
    if (state_code)    { filters.push('state_code = ?');    params.push(state_code); }
    if (unit_code)     { filters.push('unit_code = ?');     params.push(unit_code); }
    if (publ)          { filters.push('publ = ?');          params.push(publ); }
    if (edtn)          { filters.push('edtn = ?');          params.push(edtn); }
    if (sup_type_code) { filters.push('sup_type_code = ?'); params.push(sup_type_code); }
    if (from_date)     { filters.push('supply_date >= ?');  params.push(from_date); }
    if (to_date)       { filters.push('supply_date <= ?');  params.push(to_date); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await q(
      `SELECT DATE_FORMAT(supply_date, '%Y-%m') AS month,
              SUM(sup_copy) AS total_supply,
              COUNT(DISTINCT supply_date) AS days,
              COUNT(DISTINCT agcd) AS agency_count,
              COUNT(DISTINCT unit_code) AS unit_count
       FROM supply_data ${where}
       GROUP BY DATE_FORMAT(supply_date, '%Y-%m')
       ORDER BY month`,
      params
    );

    // Add the 2020-03-18 COVID reference as a special row (always included)
    const covidFilters = [];
    const covidParams  = [];
    if (state_code)    { covidFilters.push('state_code = ?');    covidParams.push(state_code); }
    if (unit_code)     { covidFilters.push('unit_code = ?');     covidParams.push(unit_code); }
    if (publ)          { covidFilters.push('publ = ?');          covidParams.push(publ); }
    if (edtn)          { covidFilters.push('edtn = ?');          covidParams.push(edtn); }
    if (sup_type_code) { covidFilters.push('sup_type_code = ?'); covidParams.push(sup_type_code); }
    const covidWhere = covidFilters.length ? 'AND ' + covidFilters.join(' AND ') : '';
    const { rows: covidRows } = await q(
      `SELECT SUM(sup_copy) total_supply FROM supply_data WHERE supply_date='2020-03-18' ${covidWhere}`,
      covidParams
    );

    res.json({
      covid_reference: {
        date: '2020-03-18',
        total_supply: Number((covidRows[0] || {}).total_supply || 0),
      },
      rows: rows.map(r => ({
        month:         r.month,
        total_supply:  Number(r.total_supply),
        days:          Number(r.days),
        daily_avg:     Math.round(Number(r.total_supply) / Number(r.days)),
        agency_count:  Number(r.agency_count),
        unit_count:    Number(r.unit_count),
      })),
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.get('/api/supply/sync-status', async (req, res) => {
  if (!(await supplyTableExists()))
    return res.json({ loaded: false, _note: 'Run: node supply_sync.js --historical' });
  try {
    const [stats, log] = await Promise.all([
      q(`SELECT
           MIN(supply_date) AS earliest_date,
           MAX(supply_date) AS latest_date,
           COUNT(*) AS total_rows,
           SUM(sup_copy) AS total_copies,
           COUNT(DISTINCT supply_date) AS distinct_dates
         FROM supply_data`),
      q(`SELECT from_date, to_date, rows_loaded, completed_at
         FROM supply_sync_log ORDER BY from_date DESC LIMIT 20`),
    ]);
    const s = stats.rows[0] || {};
    res.json({
      earliest_date:  s.earliest_date,
      latest_date:    s.latest_date,
      total_rows:     Number(s.total_rows),
      total_copies:   Number(s.total_copies),
      distinct_dates: Number(s.distinct_dates),
      recent_chunks:  log.rows,
    });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// ── AI Insights & Action Center ───────────────────────────────────────────────
require('./insights')({ app, q, getScopeUnitCodes, getOuScopeFilter, getColScopeFilter, scopeToTaxiNames });

// ── Ask AI (natural-language Q&A) ─────────────────────────────────────────────
require('./ask_ai')({ app, q, getScopeUnitCodes });

// ── Supply Management Dashboard ───────────────────────────────────────────────
require('./supply_dashboard')({ app, q, getScopeUnitCodes });

// ── Taxi Delay Report ─────────────────────────────────────────────────────────
require('./taxi_delay_report')({ app, q });

// ── Agent (Agency) web app — live agent-scoped data ───────────────────────────
require('./agent_app')({ app, q });

// ── DCR web app — circulation-staff agent/hawker visits (branch-scoped, writes to MySQL) ──
require('./dcr_app')({ app, q, getScopeUnitCodes });

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`Patrika Vitran API running on http://0.0.0.0:${API_PORT}`);
  });
}

module.exports = app;
