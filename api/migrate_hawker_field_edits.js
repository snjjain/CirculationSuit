'use strict';
/**
 * migrate_hawker_field_edits.js — let the field correct hawker_master, and make it stick.
 *
 *   node api/migrate_hawker_field_edits.js
 *
 * Beat boys is collected standing at the stall: Oracle has a figure for 138 hawkers out
 * of 11,042, and the executive in front of the man has it for all of them. So the app
 * writes it back.
 *
 * The problem that makes this more than one UPDATE: oracle_hawker_master_sync.js runs
 * daily and lists beat_boys among the columns it is the authority for, so tomorrow's run
 * would overwrite today's count with Oracle's blank. beat_boys_src records who last set
 * the value, and the sync leaves alone anything marked 'app'. Oracle keeps ownership of
 * the column until a person in the field corrects it; after that the field wins, which is
 * the right way round for a number only a visit can establish.
 *
 * hawker_field_edit is the audit trail — a figure that changes with nobody's name against
 * it is a figure nobody can question.
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
  const log = m => console.log(`[migrate_hawker_field_edits] ${m}`);

  const [cols] = await c.query('SHOW COLUMNS FROM hawker_master');
  const have = new Set(cols.map(r => r.Field));
  for (const [name, ddl] of [
    ['beat_boys_src',    "VARCHAR(4) NULL COMMENT 'app = set in the field; the Oracle sync must not overwrite it'"],
    ['beat_boys_at',     'DATETIME NULL'],
    ['beat_boys_by',     'VARCHAR(20) NULL'],
  ]) {
    if (have.has(name)) { log(`${name} — already present`); continue; }
    await c.query(`ALTER TABLE hawker_master ADD COLUMN ${name} ${ddl}`);
    log(`${name} — added`);
  }

  await c.query(`
    CREATE TABLE IF NOT EXISTS hawker_field_edit (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      unit_code    VARCHAR(10)  NOT NULL,
      hawker_id    VARCHAR(40)  NOT NULL,
      field_name   VARCHAR(40)  NOT NULL,
      old_value    VARCHAR(200) NULL,
      new_value    VARCHAR(200) NULL,
      edited_by    VARCHAR(20)  NULL,
      edited_name  VARCHAR(200) NULL,
      visit_id     BIGINT       NULL,
      edited_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_hfe_hawker (unit_code, hawker_id, field_name),
      KEY idx_hfe_when   (edited_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  log('hawker_field_edit — ready');

  const [n] = await c.query(
    "SELECT COUNT(*) n FROM hawker_master WHERE beat_boys IS NOT NULL AND beat_boys <> 0");
  log(`beat_boys currently set on ${Number(n[0].n).toLocaleString('en-IN')} hawkers (all from Oracle)`);
  await c.end();
  log('done');
  process.exit(0);
})().catch(e => { console.error('[migrate_hawker_field_edits] FAILED:', e.message); process.exit(1); });
