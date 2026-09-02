/**
 * Provision logins for active circulation field staff.
 *
 *   node api/provision_field_users.js [--dry-run] [--password Patrika@123]
 *
 * Policy (set by management, 2026-09-02):
 *   - Every active circulation employee gets a login.
 *   - Login ID is their EMPLOYEE CODE; staff with no employee code in the ERP fall
 *     back to their executive code (E00xxx) so nobody is left without an identity.
 *   - Default password Patrika@123, must be changed at first login.
 *   - Default rights: own branch only, DCR app only.
 *
 * Why two tables get written, not just app_users:
 *   auth.js resolves a typed employee code through hierarchy_master, staffOf() reads
 *   the caller's branch and level from hierarchy_master, and subordinates() walks
 *   hierarchy_master.reporting_to. Field executives exist only in the Oracle PLI
 *   mirror (exec_master), so an app_users row on its own would let them log in and
 *   then find no branch, no manager and no approval route. The hierarchy_master row
 *   is what joins the two ID spaces.
 *
 * Reporting line: exec_hierarchy_mapping.edtn_incharge is the Edition Incharge, and
 * its code is already in the same space as hierarchy_master.person_code (that is the
 * assumption exec_performance.js:1063 makes). That single pointer completes the
 * approval ladder, since hierarchy_master already carries L2->L3->L4->L5.
 *
 * Oracle is READ-ONLY here: this reads the already-synced mirrors and writes only
 * to our own MySQL tables.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PASSWORD = args[args.indexOf('--password') + 1] && args.includes('--password')
  ? args[args.indexOf('--password') + 1] : 'Patrika@123';
const LEVEL_FIELD_EXEC = 7;                      // LEVEL_META: 'Field Executive'

// ERP name columns carry placeholders where a post is vacant; those are not people.
const REAL_NAME = `em.executive_desc IS NOT NULL
   AND UPPER(TRIM(em.executive_desc)) NOT IN
       ('N/A','#N/A','NA','N.A.','NOT APPLICABLE','NOTAPPLICABLE','NONE','NIL','TEST','DUMMY','-','.','')
   AND UPPER(TRIM(em.executive_desc)) NOT LIKE '#%'
   AND UPPER(TRIM(em.executive_desc)) NOT LIKE '%NOT APPLICABLE%'
   AND UPPER(TRIM(em.executive_desc)) NOT LIKE '%VACANT%'
   AND TRIM(em.executive_desc) REGEXP '[A-Za-z]'
   AND CHAR_LENGTH(TRIM(em.executive_desc)) >= 4`;

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: +(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DB, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, dateStrings: true, multipleStatements: false,
  });

  const [staff] = await c.query(
    `SELECT em.executive_code, TRIM(em.executive_desc) name, em.exec_designation,
            em.unit_code, em.comp_code, em.employee_id,
            ehm.edtn_incharge, ehm.edtn_incharge_name
     FROM exec_master em
     LEFT JOIN exec_hierarchy_mapping ehm ON ehm.exec_code = em.executive_code
     WHERE COALESCE(em.freeze_flag,'N') <> 'Y' AND ${REAL_NAME}
       AND em.exec_designation IN ('EXEC','CI')
     ORDER BY em.unit_code, em.executive_code`);

  console.log(`Candidates (active, real name, EXEC/CI): ${staff.length}`);
  const hash = await bcrypt.hash(PASSWORD, 10);

  const skipped = [], noEmpCode = [], noManager = [];
  let hier = 0, users = 0, perms = 0;

  for (const s of staff) {
    const personCode = s.executive_code;                       // stable, present for all
    const empCode = (s.employee_id && !['', '0'].includes(String(s.employee_id).trim()))
      ? String(s.employee_id).trim() : s.executive_code;
    if (empCode === s.executive_code) noEmpCode.push(`${personCode} ${s.name}`);
    if (!s.unit_code) { skipped.push(`${personCode} ${s.name} (no unit)`); continue; }
    const mgr = (s.edtn_incharge && String(s.edtn_incharge).trim()) || null;
    if (!mgr) noManager.push(`${personCode} ${s.name} (${s.unit_code})`);

    if (DRY) continue;

    /* Never downgrade somebody who already holds a real post: an existing
       hierarchy_master row is authoritative over this PLI-derived one. */
    await c.query(
      `INSERT INTO hierarchy_master
         (comp_code, unit_code, person_code, person_name, hierarchy_code, hierarchy_level,
          reporting_to, is_active, employee_code)
       VALUES (?,?,?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE
         person_name   = VALUES(person_name),
         employee_code = COALESCE(NULLIF(hierarchy_master.employee_code,''), VALUES(employee_code)),
         reporting_to  = COALESCE(NULLIF(hierarchy_master.reporting_to,''),  VALUES(reporting_to)),
         is_active     = 1`,
      [s.comp_code || '1', s.unit_code, personCode, s.name,
       String(LEVEL_FIELD_EXEC), LEVEL_FIELD_EXEC, mgr, empCode]);
    hier++;

    // Existing password and level are preserved — this must be safe to re-run.
    await c.query(
      `INSERT INTO app_users
         (person_code, name, hierarchy_level, user_type, password_hash, is_active, must_change_password)
       VALUES (?,?,?,'circulation',?,1,1)
       ON DUPLICATE KEY UPDATE
         name          = VALUES(name),
         is_active     = 1,
         password_hash = COALESCE(app_users.password_hash, VALUES(password_hash))`,
      [personCode, s.name, LEVEL_FIELD_EXEC, hash]);
    users++;

    // DCR app only, no management dashboard. Left alone if already configured.
    await c.query(
      `INSERT INTO user_permissions (person_code, dashboard, nav_screens, modules)
       VALUES (?, 0, '[]', '["dcr"]')
       ON DUPLICATE KEY UPDATE person_code = person_code`,
      [personCode]);
    perms++;
  }

  console.log(`\n${DRY ? '[DRY RUN] would create' : 'Created/updated'}:`);
  console.log(`  hierarchy_master rows : ${hier}`);
  console.log(`  app_users rows        : ${users}`);
  console.log(`  user_permissions rows : ${perms}`);
  console.log(`\nLogin ID = employee code (fallback executive code), password "${PASSWORD}", must change at first login.`);
  if (noEmpCode.length) console.log(`\n${noEmpCode.length} have NO ERP employee code — they log in with their executive code:\n  ${noEmpCode.slice(0, 10).join('\n  ')}${noEmpCode.length > 10 ? `\n  …and ${noEmpCode.length - 10} more` : ''}`);
  if (noManager.length) console.log(`\n${noManager.length} have NO Edition Incharge — their tour plans have no approver until one is set:\n  ${noManager.slice(0, 10).join('\n  ')}${noManager.length > 10 ? `\n  …and ${noManager.length - 10} more` : ''}`);
  if (skipped.length) console.log(`\n${skipped.length} skipped:\n  ${skipped.slice(0, 10).join('\n  ')}`);
  await c.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
