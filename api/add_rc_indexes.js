'use strict';
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    database: process.env.MYSQL_DB || 'patrika_vitran',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || ''
  });

  // idx_rc_loc_date had (unit_code, locality_code, bookdate, r_id, id) — locality BEFORE date
  // so for unit+date queries (no locality), MySQL can't range on bookdate: scans all 377K JA0 rows.
  // Fix: rebuild as (unit_code, bookdate, locality_code, r_id, id) — date second, locality third.
  // Now unit+date ranges on (unit_code, bookdate) first; unit+locality+date adds locality_code filter.
  // idx_rc_unit_date (unit_code, bookdate, r_id, id) becomes a prefix of the new index so we can drop it.

  const steps = [
    ['DROP idx_rc_loc_date (locality before date — wrong order)',
     `ALTER TABLE survey_data DROP INDEX idx_rc_loc_date`],

    ['DROP idx_rc_unit_date (will be a prefix of new index)',
     `ALTER TABLE survey_data DROP INDEX idx_rc_unit_date`],

    ['CREATE idx_rc_unit_date (unit_code, bookdate, locality_code, r_id, id)',
     `ALTER TABLE survey_data ADD INDEX idx_rc_unit_date (unit_code, bookdate, locality_code, r_id, id)`],
  ];

  for (const [label, sql] of steps) {
    process.stdout.write(label + ' ... ');
    const t = Date.now();
    try {
      await db.query(sql);
      console.log('done (' + (Date.now() - t) + 'ms)');
    } catch (e) {
      if (e.message.includes('Duplicate key name') || e.message.includes("Can't DROP")) {
        console.log('skipped (' + e.message.split('\n')[0] + ')');
      } else {
        console.log('ERROR: ' + e.message);
      }
    }
  }

  await db.query('ANALYZE TABLE survey_data');
  console.log('ANALYZE done.\n');

  const check = async (label, sql) => {
    const [rows] = await db.query(sql);
    const r = rows[0];
    console.log(label + '\n  key=' + r.key + '  rows=' + r.rows + '  Extra=' + r.Extra);
  };

  await check('unit+date dedup (no locality)',
    `EXPLAIN SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY r_id`);

  await check('unit+locality+date dedup',
    `EXPLAIN SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' AND locality_code = '1' GROUP BY r_id`);

  await check('date-only dedup (MTD, no unit)',
    `EXPLAIN SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
     GROUP BY r_id`);

  await check('summary by reason (unit+date)',
    `EXPLAIN SELECT unprod_reason, COUNT(*) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY unprod_reason`);

  console.log('\n--- Real timing ---');
  const time = async (label, sql) => {
    const t = Date.now(); await db.query(sql);
    console.log(label + ': ' + (Date.now() - t) + 'ms');
  };

  await time('unit+date dedup',
    `SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY r_id`);

  await time('unit+locality+date dedup',
    `SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' AND locality_code = '1' GROUP BY r_id`);

  await time('date-only dedup',
    `SELECT r_id, MAX(id) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
     GROUP BY r_id`);

  await time('summary by reason',
    `SELECT unprod_reason, COUNT(*) FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY unprod_reason`);

  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
