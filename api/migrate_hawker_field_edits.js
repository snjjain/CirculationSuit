'use strict';
/**
 * migrate_hawker_field_edits.js — let the field correct hawker_master, and make it stick.
 *
 *   node api/migrate_hawker_field_edits.js
 *
 * Three columns are collected standing at the stall, and Oracle barely has them:
 *
 *   beat_boys          138 of 11,042 hawkers   (1.2%)
 *   mobile_no        7,233 of 11,042           (65.5%)
 *   distribution_area 1,613 of 11,042          (14.6%)
 *
 * The executive in front of the man has all three. So the app writes them back.
 *
 * The problem that makes this more than three UPDATEs: oracle_hawker_master_sync.js runs
 * daily and lists all three among the columns it is the authority for, so tomorrow's run
 * would overwrite today's figures with Oracle's blanks. A <col>_src column records who
 * last set each value, and the sync leaves alone anything marked 'app'. Oracle keeps
 * ownership until a person in the field corrects it; after that the field wins, which is
 * the right way round for facts only a visit can establish.
 *
 * hawker_field_edit is the audit trail — a value that changes with nobody's name against
 * it is a value nobody can question.
 *
 * Additive and re-runnable.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

// The columns the field may overrule. Kept here and in dcr_msite.js's FIELD_EDITABLE,
// which validates them — this file only has to make the storage exist.
const FIELDS = ['beat_boys', 'mobile_no', 'distribution_area'];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: +(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DB, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, dateStrings: true,
  });
  const log = m => console.log(`[migrate_hawker_field_edits] ${m}`);

  const [cols] = await c.query('SHOW COLUMNS FROM hawker_master');
  const have = new Set(cols.map(r => r.Field));
  for (const f of FIELDS) {
    if (!have.has(f)) { log(`${f} — NOT IN hawker_master, skipped`); continue; }
    for (const [suffix, ddl] of [
      ['_src', "VARCHAR(4) NULL COMMENT 'app = set in the field; the Oracle sync must not overwrite it'"],
      ['_at',  'DATETIME NULL'],
      ['_by',  'VARCHAR(20) NULL'],
    ]) {
      const name = f + suffix;
      if (have.has(name)) { log(`${name} — already present`); continue; }
      await c.query(`ALTER TABLE hawker_master ADD COLUMN ${name} ${ddl}`);
      log(`${name} — added`);
    }
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

  const [n] = await c.query(`
    SELECT COUNT(*) total,
           SUM(beat_boys IS NOT NULL AND beat_boys <> 0) beat_boys,
           SUM(mobile_no IS NOT NULL AND mobile_no <> '' AND mobile_no <> '0') mobile_no,
           SUM(distribution_area IS NOT NULL AND distribution_area <> '') distribution_area
      FROM hawker_master`);
  const t = n[0];
  log(`fill rates of ${Number(t.total).toLocaleString('en-IN')} hawkers:`);
  FIELDS.forEach(f => log(`  ${f.padEnd(19)} ${String(Number(t[f]).toLocaleString('en-IN')).padStart(8)}  ${((t[f] / t.total) * 100).toFixed(1)}%`));
  await c.end();
  log('done');
  process.exit(0);
})().catch(e => { console.error('[migrate_hawker_field_edits] FAILED:', e.message); process.exit(1); });
