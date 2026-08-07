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

  // Check existing indexes
  const [ix] = await db.query('SHOW INDEX FROM primary_newspaper');
  console.log('primary_newspaper indexes:');
  ix.forEach(i => console.log(' ', i.Key_name, '|', i.Column_name, '| card:', i.Cardinality));

  // EXPLAIN the newspaper-filtered subquery (the one that hangs)
  const [plan] = await db.query(`EXPLAIN
    SELECT sd2.r_id, MAX(sd2.id) AS max_id
    FROM survey_data sd2
    INNER JOIN primary_newspaper pn2
      ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
    WHERE sd2.bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-30 23:59:59'
      AND sd2.unit_code = 'JA0'
      AND pn2.newspaper_name IN ('DAINIK BHASKAR')
    GROUP BY sd2.r_id`);
  console.log('\nEXPLAIN (before index):');
  plan.forEach(r => console.log('  table:', r.table, '| type:', r.type, '| key:', r.key, '| rows:', r.rows, '| Extra:', r.Extra));

  // Time the query before fix
  const t0 = Date.now();
  await db.query(`SELECT sd2.r_id, MAX(sd2.id) AS max_id
    FROM survey_data sd2
    INNER JOIN primary_newspaper pn2 ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
    WHERE sd2.bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-30 23:59:59'
      AND sd2.unit_code = 'JA0' AND pn2.newspaper_name IN ('DAINIK BHASKAR')
    GROUP BY sd2.r_id`);
  console.log('Query time BEFORE index:', Date.now() - t0, 'ms');

  // Add covering index: newspaper_name + loc_id — MySQL can filter newspaper+unit in one scan
  // r_id is implicitly in the PRIMARY KEY so the join to survey_data is free
  console.log('\nCreating idx_pn_newspaper (newspaper_name, loc_id) ...');
  const t1 = Date.now();
  try {
    await db.query('ALTER TABLE primary_newspaper ADD INDEX idx_pn_newspaper (newspaper_name, loc_id)');
    console.log('Done in', Date.now() - t1, 'ms');
  } catch (e) {
    if (e.message.includes('Duplicate key name')) console.log('Already exists');
    else throw e;
  }

  // EXPLAIN after
  const [plan2] = await db.query(`EXPLAIN
    SELECT sd2.r_id, MAX(sd2.id) AS max_id
    FROM survey_data sd2
    INNER JOIN primary_newspaper pn2
      ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
    WHERE sd2.bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-30 23:59:59'
      AND sd2.unit_code = 'JA0'
      AND pn2.newspaper_name IN ('DAINIK BHASKAR')
    GROUP BY sd2.r_id`);
  console.log('\nEXPLAIN (after index):');
  plan2.forEach(r => console.log('  table:', r.table, '| type:', r.type, '| key:', r.key, '| rows:', r.rows, '| Extra:', r.Extra));

  // Time after
  const t2 = Date.now();
  await db.query(`SELECT sd2.r_id, MAX(sd2.id) AS max_id
    FROM survey_data sd2
    INNER JOIN primary_newspaper pn2 ON pn2.loc_id = sd2.unit_code AND pn2.r_id = sd2.r_id
    WHERE sd2.bookdate BETWEEN '2026-07-01 00:00:00' AND '2026-07-30 23:59:59'
      AND sd2.unit_code = 'JA0' AND pn2.newspaper_name IN ('DAINIK BHASKAR')
    GROUP BY sd2.r_id`);
  console.log('Query time AFTER index:', Date.now() - t2, 'ms');

  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
