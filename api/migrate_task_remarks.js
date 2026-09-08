'use strict';
/**
 * migrate_task_remarks.js — a task carries a conversation, not one closing line.
 *
 *   node api/migrate_task_remarks.js
 *
 * A task was completed with a single remark and that was the end of it. The manager who
 * assigned it had nowhere to say "that is not what I asked for" and no way to send it
 * back; the executive had nowhere to answer. Both sides now write to one thread, and
 * every status change lands in it too, so the record reads as what actually happened
 * rather than as a final state with no account of how it got there.
 *
 * Existing completion remarks are copied in as the first entry, attributed to the person
 * the task belonged to — they were written by the executive closing it.
 *
 * Additive and re-runnable.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: +(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DB, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, dateStrings: true,
  });
  const log = m => console.log(`[migrate_task_remarks] ${m}`);

  await c.query(`
    CREATE TABLE IF NOT EXISTS dcr_task_remark (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      task_id    BIGINT       NOT NULL,
      by_code    VARCHAR(20)  NULL,
      by_name    VARCHAR(200) NULL,
      /* 'owner' — the person the task was given to; 'manager' — someone above them who
         can send it back. Kept on the row so the thread reads correctly even after a
         reporting line changes. */
      by_side    VARCHAR(10)  NULL,
      action     VARCHAR(20)  NULL COMMENT 'start | done | reopen | comment',
      remark     TEXT         NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tr_task (task_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  log('dcr_task_remark — ready');

  // Whatever was already written on a completed task becomes the thread's first entry.
  const [seed] = await c.query(`
    INSERT INTO dcr_task_remark (task_id, by_code, by_name, by_side, action, remark, created_at)
    SELECT p.id, p.staff_person_code, p.staff_name, 'owner', 'done', p.completion_remarks,
           COALESCE(p.completed_at, NOW())
      FROM dcr_tour_plan p
     WHERE p.completion_remarks IS NOT NULL AND p.completion_remarks <> ''
       AND NOT EXISTS (SELECT 1 FROM dcr_task_remark r WHERE r.task_id = p.id)`);
  log(`seeded ${seed.affectedRows} existing completion remark(s) into the thread`);

  const [n] = await c.query('SELECT COUNT(*) n FROM dcr_task_remark');
  log(`dcr_task_remark holds ${n[0].n} row(s)`);
  await c.end();
  log('done');
  process.exit(0);
})().catch(e => { console.error('[migrate_task_remarks] FAILED:', e.message); process.exit(1); });
