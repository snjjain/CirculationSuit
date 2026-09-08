'use strict';
/**
 * migrate_tasks.js — turn the tour plan table into a task table.
 *
 *   node api/migrate_tasks.js
 *
 * Additive and re-runnable: it adds the columns a general task needs and leaves every
 * existing row alone. The table keeps the name dcr_tour_plan because eight live rows and
 * a working approval flow are not worth a rename; a tour is now simply the row whose
 * task_type is 'tour', which is what the existing rows are backfilled to.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const COLUMNS = [
  ['task_type',          "VARCHAR(40) NOT NULL DEFAULT 'tour'"],
  ['subject',            'VARCHAR(300) NULL'],
  ['priority',           "VARCHAR(10) NULL DEFAULT 'normal'"],
  ['objective',          'TEXT NULL'],
  // The executive's own progress, kept apart from the approval status so "approved" and
  // "done" cannot overwrite each other.
  ['exec_status',        "VARCHAR(20) NULL DEFAULT 'pending'"],
  ['started_at',         'DATETIME NULL'],
  ['completed_at',       'DATETIME NULL'],
  ['completion_remarks', 'TEXT NULL'],
  ['input_lang',         'VARCHAR(4) NULL'],
];

const INDEXES = [
  ['idx_tp_task_type',  '(task_type)'],
  ['idx_tp_exec_queue', '(staff_person_code, exec_status, tour_date)'],
];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: +(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DB, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, dateStrings: true,
  });
  const log = m => console.log(`[migrate_tasks] ${m}`);

  const [have] = await c.query('SHOW COLUMNS FROM dcr_tour_plan');
  const present = new Set(have.map(r => r.Field));
  for (const [name, ddl] of COLUMNS) {
    if (present.has(name)) { log(`${name} — already present`); continue; }
    await c.query(`ALTER TABLE dcr_tour_plan ADD COLUMN ${name} ${ddl}`);
    log(`${name} — added`);
  }

  const [ix] = await c.query('SHOW INDEX FROM dcr_tour_plan');
  const haveIx = new Set(ix.map(r => r.Key_name));
  for (const [name, cols] of INDEXES) {
    if (haveIx.has(name)) { log(`${name} — already present`); continue; }
    await c.query(`ALTER TABLE dcr_tour_plan ADD INDEX ${name} ${cols}`);
    log(`${name} — added`);
  }

  // Existing rows are tours, and a tour that was approved is work still to be done.
  const [r1] = await c.query(
    "UPDATE dcr_tour_plan SET task_type = 'tour' WHERE task_type IS NULL OR task_type = ''");
  const [r2] = await c.query(
    "UPDATE dcr_tour_plan SET priority = 'normal' WHERE priority IS NULL OR priority = ''");
  const [r3] = await c.query(
    `UPDATE dcr_tour_plan SET exec_status = 'pending'
      WHERE exec_status IS NULL OR exec_status = ''`);
  /* A subject is what the executive reads first on the phone, so nothing may be left
     without one. Backfilled from the purpose and the target the row already carries. */
  const [r4] = await c.query(
    `UPDATE dcr_tour_plan
        SET subject = CONCAT(COALESCE(NULLIF(purpose,''), 'Tour visit'), ' — ', COALESCE(target_name, target_code))
      WHERE subject IS NULL OR subject = ''`);
  log(`backfill: task_type ${r1.affectedRows}, priority ${r2.affectedRows}, exec_status ${r3.affectedRows}, subject ${r4.affectedRows}`);

  const [chk] = await c.query(
    `SELECT task_type, priority, exec_status, COUNT(*) n FROM dcr_tour_plan
      GROUP BY task_type, priority, exec_status`);
  console.table(chk);
  await c.end();
  log('done');
  process.exit(0);
})().catch(e => { console.error('[migrate_tasks] FAILED:', e.message); process.exit(1); });
