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

  const run = async (label, sql) => {
    console.log('\n=== ' + label + ' ===');
    const [rows] = await db.query(sql);
    rows.forEach(r => console.log('  type:', r.type, '| key:', r.key, '| rows:', r.rows, '| Extra:', r.Extra));
  };

  await run('unit+date dedup (markers/readers inner)',
    `EXPLAIN SELECT r_id, MAX(id) AS max_id FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY r_id`);

  await run('unit+locality+date dedup',
    `EXPLAIN SELECT r_id, MAX(id) AS max_id FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' AND locality_code = '1' GROUP BY r_id`);

  await run('date-only dedup (MTD, no unit)',
    `EXPLAIN SELECT r_id, MAX(id) AS max_id FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
     GROUP BY r_id`);

  await run('summary count by unprod_reason (unit+date)',
    `EXPLAIN SELECT unprod_reason, COUNT(*) AS cnt FROM survey_data
     WHERE bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-31 23:59:59'
       AND unit_code = 'JA0' GROUP BY unprod_reason`);

  await db.end();
})().catch(e => console.error(e));
