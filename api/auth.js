'use strict';

/**
 * auth.js — Real authentication & authorization for Patrika Vitran Suite
 *
 * - Login by mobile + password (bcrypt hashed), issues a signed JWT.
 * - Token-verified authorization middleware (replaces the old spoofable x-* headers).
 * - Failed-login lockout, self password change, admin user management, audit trail.
 *
 * Users live in `app_users` (login identity), linked to `hierarchy_master` by person_code
 * where applicable. Admins can be standalone (no hierarchy_master row).
 *
 * Installed from server.js via:  const auth = installAuth({ app, q, getConn, LEVEL_META });
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

module.exports = function installAuth({ app, q, LEVEL_META }) {
  const JWT_SECRET = process.env.JWT_SECRET || (() => {
    const s = crypto.randomBytes(48).toString('hex');
    console.warn('[auth] JWT_SECRET not set in .env — using an ephemeral secret (all sessions drop on restart). Set JWT_SECRET to persist logins.');
    return s;
  })();
  const JWT_EXPIRY    = process.env.JWT_EXPIRY || '8h';       // session timeout
  const MAX_FAILED    = parseInt(process.env.AUTH_MAX_FAILED || '5', 10);
  const LOCK_MINUTES  = parseInt(process.env.AUTH_LOCK_MINUTES || '15', 10);
  const BCRYPT_ROUNDS = 10;

  // ── Schema ────────────────────────────────────────────────────────────────
  async function ensureSchema() {
    await q(`CREATE TABLE IF NOT EXISTS app_users (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      person_code          VARCHAR(20)  DEFAULT NULL,
      name                 VARCHAR(200) NOT NULL,
      username             VARCHAR(50)  DEFAULT NULL,
      mobile               VARCHAR(15)  DEFAULT NULL,
      password_hash        VARCHAR(100) DEFAULT NULL,
      email                VARCHAR(150) DEFAULT NULL,
      hierarchy_level      INT          DEFAULT NULL,
      user_type            VARCHAR(30)  DEFAULT 'circulation',
      is_active            TINYINT(1)   DEFAULT 1,
      must_change_password TINYINT(1)   DEFAULT 1,
      failed_attempts      INT          DEFAULT 0,
      locked_until         DATETIME     DEFAULT NULL,
      last_login_at        DATETIME     DEFAULT NULL,
      created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mobile (mobile),
      UNIQUE KEY uq_username (username),
      UNIQUE KEY uq_person (person_code),
      INDEX idx_active (is_active)
    ) CHARACTER SET utf8mb4`);
    // Migrations for existing installs (idempotent)
    try { await q(`ALTER TABLE app_users ADD COLUMN username VARCHAR(50) DEFAULT NULL AFTER name`); } catch (_) {}
    try { await q(`ALTER TABLE app_users ADD UNIQUE KEY uq_username (username)`); } catch (_) {}
    try { await q(`ALTER TABLE app_users MODIFY mobile VARCHAR(15) DEFAULT NULL`); } catch (_) {}

    await q(`CREATE TABLE IF NOT EXISTS auth_audit (
      id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
      ts                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      actor_person_code  VARCHAR(20)  DEFAULT NULL,
      actor_name         VARCHAR(200) DEFAULT NULL,
      action             VARCHAR(40)  NOT NULL,
      target_person_code VARCHAR(20)  DEFAULT NULL,
      detail             TEXT         DEFAULT NULL,
      ip                 VARCHAR(45)  DEFAULT NULL,
      INDEX idx_ts (ts),
      INDEX idx_action (action)
    ) CHARACTER SET utf8mb4`);

    // Extend user_permissions with a per-form rights matrix (view/add/edit/delete/export)
    try { await q(`ALTER TABLE user_permissions ADD COLUMN perms TEXT DEFAULT NULL COMMENT 'JSON {form:{view,add,edit,delete,export}}'`); }
    catch (_) { /* column already exists */ }
  }
  ensureSchema().catch(e => console.warn('[auth] schema init:', e.message));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function avatar(name) {
    if (!name) return '??';
    const p = String(name).trim().split(/\s+/);
    if (p.length >= 2) return (p[0][0] + p[p.length - 1][0]).toUpperCase();
    return String(name).slice(0, 2).toUpperCase() || '??';
  }
  const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const hashPassword = (p) => bcrypt.hash(String(p), BCRYPT_ROUNDS);
  function genTempPassword() {
    // Human-typeable temp password, no ambiguous chars
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ', num = '23456789';
    const pick = (s, n) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
    return `${pick(abc, 3)}${pick(num, 3)}@pk`;
  }

  async function audit(action, { actor, actorName, target, detail, ip } = {}) {
    try {
      await q(`INSERT INTO auth_audit (actor_person_code, actor_name, action, target_person_code, detail, ip)
               VALUES (?,?,?,?,?,?)`,
        [actor || null, actorName || null, action, target || null, detail || null, ip || null]);
    } catch (e) { console.warn('[auth] audit failed:', e.message); }
  }

  function sign(u) {
    return jwt.sign(
      { uid: u.id, pc: u.person_code, hl: u.hierarchy_level, mob: u.mobile, ut: u.user_type },
      JWT_SECRET, { expiresIn: JWT_EXPIRY }
    );
  }

  /** Build the full frontend profile object from an app_users row. */
  async function buildProfile(u) {
    const hl = u.hierarchy_level;
    const meta = LEVEL_META[hl] || { roleLabel: hl ? `Level ${hl}` : 'User', role: 'user', dashboard: false, modules: [] };

    let unit_code = null, unit_name = null, name = u.name;
    if (u.person_code) {
      try {
        const { rows } = await q(
          `SELECT hm.unit_code, COALESCE(un.unit_name, hm.unit_code) AS unit_name, hm.person_name
           FROM hierarchy_master hm LEFT JOIN units un ON un.unit_code = hm.unit_code
           WHERE hm.person_code = ? LIMIT 1`, [u.person_code]);
        if (rows[0]) { unit_code = rows[0].unit_code; unit_name = rows[0].unit_name; if (!name) name = rows[0].person_name; }
      } catch (_) {}
    }

    let perm = null;
    try {
      const { rows } = await q('SELECT dashboard, nav_screens, modules, perms FROM user_permissions WHERE person_code = ?', [u.person_code]);
      perm = rows[0];
    } catch (_) {}

    const scopeLabel = hl === 1 ? 'PAN India' : (unit_name || unit_code || '');
    return {
      id: u.id,
      person_code: u.person_code,
      name,
      mobile: u.mobile,
      user_type: u.user_type,
      hierarchyLevel: hl,
      unit_code,
      scopeLabel,
      roleLabel: meta.roleLabel,
      role: meta.role,
      dashboard:  perm && perm.dashboard !== null && perm.dashboard !== undefined ? Boolean(perm.dashboard) : meta.dashboard,
      modules:    perm && perm.modules     ? safeJSON(perm.modules, meta.modules) : meta.modules,
      navScreens: perm && perm.nav_screens ? safeJSON(perm.nav_screens, null)     : null,
      perms:      perm && perm.perms        ? safeJSON(perm.perms, null)           : null,
      mustChangePassword: !!u.must_change_password,
      avatar: avatar(name),
    };
  }
  function safeJSON(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

  // ── Middleware ──────────────────────────────────────────────────────────────
  function requireAuth(req, res, next) {
    const hdr = req.headers['authorization'] || '';
    const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!tok) return res.status(401).json({ detail: 'Authentication required', code: 'no_token' });
    try {
      const p = jwt.verify(tok, JWT_SECRET);
      req.auth = { id: p.uid, personCode: p.pc, hierarchyLevel: p.hl, mobile: p.mob, userType: p.ut };
      // Stamp verified identity onto the legacy scoping headers so ALL existing
      // header-based data scoping (server.js, insights.js, ask_ai.js, supply_dashboard.js)
      // uses trusted token claims. Any client-supplied x-* header is overwritten here.
      req.headers['x-person-code']     = p.pc  == null ? '' : String(p.pc);
      req.headers['x-hierarchy-level'] = p.hl  == null ? '' : String(p.hl);
      req.headers['x-user-mobile']     = p.mob == null ? '' : String(p.mob);
      next();
    } catch (e) {
      return res.status(401).json({ detail: 'Session expired. Please sign in again.', code: 'token_invalid' });
    }
  }
  function requireAdmin(req, res, next) {
    if (!req.auth || req.auth.hierarchyLevel !== 1) return res.status(403).json({ detail: 'Administrator access required' });
    next();
  }

  // ── Auth routes ───────────────────────────────────────────────────────────
  // POST /api/login  { mobile, password }
  app.post('/api/login', async (req, res) => {
    try {
      // Identifier can be a mobile number OR a User ID (e.g. "admin")
      const ident    = String(req.body.mobile || req.body.identifier || req.body.username || '').trim();
      const identDig = ident.replace(/\D/g, '');
      const password = String(req.body.password || '');
      const ip = ipOf(req);
      if (!ident || !password) return res.status(400).json({ detail: 'User ID / mobile number and password are required' });

      const { rows } = await q(
        `SELECT * FROM app_users
         WHERE (username IS NOT NULL AND LOWER(username) = LOWER(?))
            OR (mobile   IS NOT NULL AND mobile = ? AND ? <> '')
         LIMIT 1`,
        [ident, identDig, identDig]);
      const u = rows[0];
      if (!u) { await audit('login_fail', { detail: `unknown id ${ident}`, ip }); return res.status(401).json({ detail: 'Invalid User ID / mobile number or password' }); }
      if (!u.is_active) { await audit('login_fail', { target: u.person_code, actorName: u.name, detail: 'inactive account', ip }); return res.status(403).json({ detail: 'Your account is inactive. Please contact the administrator.' }); }
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        const mins = Math.max(1, Math.ceil((new Date(u.locked_until) - new Date()) / 60000));
        await audit('login_fail', { target: u.person_code, actorName: u.name, detail: 'locked', ip });
        return res.status(423).json({ detail: `Account locked due to failed attempts. Try again in ${mins} minute(s).` });
      }
      if (!u.password_hash) return res.status(403).json({ detail: 'No password is set for this account. Please contact the administrator.' });

      const ok = await bcrypt.compare(password, u.password_hash);
      if (!ok) {
        const fa = (u.failed_attempts || 0) + 1;
        const lock = fa >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
        await q('UPDATE app_users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [fa, lock, u.id]);
        await audit(lock ? 'locked' : 'login_fail', { target: u.person_code, actorName: u.name, detail: `failed attempt ${fa}`, ip });
        if (lock) return res.status(423).json({ detail: `Too many failed attempts. Account locked for ${LOCK_MINUTES} minutes.` });
        return res.status(401).json({ detail: `Invalid mobile number or password (${MAX_FAILED - fa} attempt(s) left)` });
      }

      await q('UPDATE app_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?', [u.id]);
      const token = sign(u);
      const user  = await buildProfile(u);
      await audit('login_success', { actor: u.person_code, actorName: u.name, target: u.person_code, ip });
      res.json({ token, user, mustChangePassword: !!u.must_change_password });
    } catch (e) {
      console.error('[auth] login error:', e);
      res.status(500).json({ detail: 'Login failed: ' + e.message });
    }
  });

  // GET /api/auth/me  — validate token, return fresh profile
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
      const { rows } = await q('SELECT * FROM app_users WHERE id = ? LIMIT 1', [req.auth.id]);
      const u = rows[0];
      if (!u || !u.is_active) return res.status(401).json({ detail: 'Account no longer active', code: 'inactive' });
      res.json({ user: await buildProfile(u), mustChangePassword: !!u.must_change_password });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    await audit('logout', { actor: req.auth.personCode, target: req.auth.personCode, ip: ipOf(req) });
    res.json({ ok: true }); // JWT is stateless; client discards the token
  });

  // POST /api/auth/change-password  { currentPassword, newPassword }
  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ detail: 'New password must be at least 6 characters' });
      const { rows } = await q('SELECT * FROM app_users WHERE id = ? LIMIT 1', [req.auth.id]);
      const u = rows[0];
      if (!u) return res.status(404).json({ detail: 'User not found' });
      if (u.password_hash) {
        const ok = await bcrypt.compare(String(currentPassword || ''), u.password_hash);
        if (!ok) return res.status(401).json({ detail: 'Current password is incorrect' });
      }
      const hash = await hashPassword(newPassword);
      await q('UPDATE app_users SET password_hash = ?, must_change_password = 0, updated_at = NOW() WHERE id = ?', [hash, u.id]);
      await audit('password_change', { actor: u.person_code, actorName: u.name, target: u.person_code, ip: ipOf(req) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // ── Admin: user management ──────────────────────────────────────────────────
  // GET /api/admin/users
  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await q(`
        SELECT au.id, au.person_code, au.name, au.username, au.mobile, au.email, au.hierarchy_level,
               au.user_type, au.is_active, au.must_change_password, au.failed_attempts,
               au.locked_until, au.last_login_at, (au.password_hash IS NOT NULL) AS has_password
        FROM app_users au ORDER BY (au.hierarchy_level IS NULL), au.hierarchy_level, au.name`);
      res.json({ users: rows, total: rows.length });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // POST /api/admin/users  — create
  app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const username = (b.username || '').trim() || null;
      const mobile = String(b.mobile || '').replace(/\D/g, '') || null;
      if (!b.name)               return res.status(400).json({ detail: 'Name is required' });
      if (!mobile && !username)  return res.status(400).json({ detail: 'A mobile number or a User ID is required' });
      const hl = b.hierarchy_level ? parseInt(b.hierarchy_level, 10) : null;
      const tempPwd = b.password || genTempPassword();
      const hash = await hashPassword(tempPwd);
      try {
        await q(`INSERT INTO app_users (person_code, name, username, mobile, hierarchy_level, user_type, email, password_hash, is_active, must_change_password)
                 VALUES (?,?,?,?,?,?,?,?,?,1)`,
          [b.person_code || null, b.name, username, mobile, hl, b.user_type || 'circulation', b.email || null, hash, b.is_active === false ? 0 : 1]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ detail: 'A user with this mobile number, User ID or person code already exists' });
        throw e;
      }
      await audit('user_create', { actor: req.auth.personCode, target: b.person_code || username || mobile, detail: b.name, ip: ipOf(req) });
      res.json({ ok: true, tempPassword: b.password ? undefined : tempPwd });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // PATCH /api/admin/users/:id  — update (activate/deactivate, designation, type, email, name, mobile)
  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}, fields = [], params = [];
      if ('is_active'       in b) { fields.push('is_active = ?');       params.push(b.is_active ? 1 : 0); }
      if ('hierarchy_level' in b) { fields.push('hierarchy_level = ?'); params.push(b.hierarchy_level ? parseInt(b.hierarchy_level, 10) : null); }
      if ('user_type'       in b) { fields.push('user_type = ?');       params.push(b.user_type); }
      if ('email'           in b) { fields.push('email = ?');           params.push(b.email || null); }
      if ('name'            in b) { fields.push('name = ?');            params.push(b.name); }
      if ('username'        in b) { fields.push('username = ?');        params.push((b.username || '').trim() || null); }
      if ('person_code'     in b) { fields.push('person_code = ?');     params.push(b.person_code || null); }
      if ('mobile'          in b) { fields.push('mobile = ?');          params.push(String(b.mobile).replace(/\D/g, '') || null); }
      if ('locked_until'    in b) { fields.push('locked_until = ?, failed_attempts = 0'); params.push(b.locked_until); } // pass null to unlock
      if (!fields.length) return res.status(400).json({ detail: 'No updatable fields provided' });
      params.push(req.params.id);
      try {
        await q(`UPDATE app_users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ detail: 'Mobile number or person code already in use' });
        throw e;
      }
      await audit('user_update', { actor: req.auth.personCode, target: String(req.params.id), detail: Object.keys(b).join(','), ip: ipOf(req) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // POST /api/admin/users/:id/reset-password  { password? }  → returns tempPassword if generated
  app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    try {
      const supplied = req.body && req.body.password;
      const pwd = supplied || genTempPassword();
      const hash = await hashPassword(pwd);
      const [r] = await (async () => { const { rows } = await q('SELECT person_code, name FROM app_users WHERE id = ?', [req.params.id]); return [rows[0]]; })();
      if (!r) return res.status(404).json({ detail: 'User not found' });
      await q('UPDATE app_users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?', [hash, req.params.id]);
      await audit('admin_reset', { actor: req.auth.personCode, target: r.person_code || String(req.params.id), detail: r.name, ip: ipOf(req) });
      res.json({ ok: true, tempPassword: supplied ? undefined : pwd });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  // GET /api/admin/audit  — recent audit trail
  app.get('/api/admin/audit', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(500, parseInt(req.query.limit || '200', 10));
      const { rows } = await q(`SELECT * FROM auth_audit ORDER BY ts DESC LIMIT ${limit}`);
      res.json({ audit: rows });
    } catch (e) { res.status(500).json({ detail: e.message }); }
  });

  return { requireAuth, requireAdmin, buildProfile, audit, hashPassword, ipOf };
};
