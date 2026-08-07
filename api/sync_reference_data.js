'use strict';
/**
 * sync_reference_data.js — Oracle reference tables → MySQL
 *
 * Syncs:
 *   CRM_LOCALITY_MASTER  → locality_master  (loc_id + l_code → locality name)
 *   CRM_NEWSPAPER_DET    → newspaper_det    (loc_id + n_code → newspaper name)
 *
 * Joins for queries:
 *   locality:  WHERE lm.loc_id = sd.unit_code AND lm.l_code = sd.locality_code AND lm.compcode = 'RP001'
 *   newspaper: WHERE nd.loc_id = nr.loc_id AND nd.n_code = nr.news_scheme
 */

const { spawn } = require('child_process');
const mysql     = require('mysql2/promise');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const SEP = '\x1c';

function oraConnect() {
  return `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
         `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
}

async function spoolOracle(sqlScript, spoolFile) {
  const sqlFile = path.join(os.tmpdir(), `ora_ref_${Date.now()}.sql`);
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);
  fs.writeFileSync(sqlFile, sqlScript);

  await new Promise((resolve, reject) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`sqlplus exited ${code}`)));
    proc.stdin.write(`CONNECT ${oraConnect()}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });

  fs.unlinkSync(sqlFile);
  return fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, 'utf8') : '';
}

async function insertBatch(pool, table, columns, rows) {
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = batch.map(row => {
      row.forEach(v => params.push(v));
      return '(' + row.map(() => '?').join(',') + ')';
    });
    await pool.execute(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}`,
      params
    );
    inserted += batch.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}`);
  }
  console.log('');
}

async function syncLocalityMaster(pool) {
  const spoolFile = path.join(os.tmpdir(), 'locality_master_dump.txt');

  const sql = `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile}
SELECT NVL(LOC_ID,'') || CHR(28) || NVL(L_CODE,'') || CHR(28) || REPLACE(NVL(L_NAME,''),CHR(28),' ') || CHR(28) || NVL(COMPCODE,'')
FROM CRM_LOCALITY_MASTER
ORDER BY LOC_ID, TO_NUMBER(L_CODE) NULLS LAST;
SPOOL OFF
EXIT
`;

  console.log('Fetching CRM_LOCALITY_MASTER from Oracle...');
  const raw = await spoolOracle(sql, spoolFile);
  const rows = raw.split('\n')
    .map(l => l.replace(/\r$/, '').trim())
    .filter(l => l && l.includes(SEP))
    .map(l => { const p = l.split(SEP); return [p[0]||'', p[1]||'', p[2]||'', p[3]||'']; });
  console.log(`Parsed ${rows.length} locality rows`);
  if (!rows.length) throw new Error('No locality rows from Oracle');

  // Drop and recreate so schema is always correct (loc_id replaces old cent_id)
  await pool.execute('DROP TABLE IF EXISTS locality_master');
  await pool.execute(`CREATE TABLE locality_master (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    loc_id   VARCHAR(20) NOT NULL DEFAULT '',
    l_code   VARCHAR(20) NOT NULL DEFAULT '',
    l_name   VARCHAR(200),
    compcode VARCHAR(8),
    INDEX idx_lm (loc_id, l_code, compcode)
  ) CHARACTER SET utf8mb4`);

  // Drop old locality_names view if it exists (was based on wrong cent_id join)
  await pool.execute('DROP VIEW IF EXISTS locality_names');

  await insertBatch(pool, 'locality_master', ['loc_id','l_code','l_name','compcode'], rows);

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM locality_master');
  console.log(`locality_master: ${cnt} rows`);

  // Spot-check
  const [samples] = await pool.execute(
    `SELECT loc_id, l_code, l_name FROM locality_master
     WHERE loc_id IN ('JA0','AJ0','BH1') AND l_code IN ('1','2','3')
     ORDER BY loc_id, CAST(l_code AS UNSIGNED) LIMIT 9`
  );
  samples.forEach(r => console.log(`  ${r.loc_id} | ${r.l_code} | ${r.l_name}`));
}

async function syncNewspaperDet(pool) {
  const spoolFile = path.join(os.tmpdir(), 'newspaper_det_dump.txt');

  const sql = `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile}
SELECT NVL(LOC_ID,'') || CHR(28) || NVL(N_CODE,'') || CHR(28) || REPLACE(NVL(NAME,''),CHR(28),' ') || CHR(28) || NVL(COMPCODE,'')
FROM CRM_NEWSPAPER_DET
ORDER BY LOC_ID, N_CODE;
SPOOL OFF
EXIT
`;

  console.log('Fetching CRM_NEWSPAPER_DET from Oracle...');
  const raw = await spoolOracle(sql, spoolFile);
  const rows = raw.split('\n')
    .map(l => l.replace(/\r$/, '').trim())
    .filter(l => l && l.includes(SEP))
    .map(l => { const p = l.split(SEP); return [p[0]||'', p[1]||'', p[2]||'', p[3]||'']; });
  console.log(`Parsed ${rows.length} newspaper det rows`);
  if (!rows.length) throw new Error('No newspaper det rows from Oracle');

  await pool.execute('DROP TABLE IF EXISTS newspaper_det');
  await pool.execute(`CREATE TABLE newspaper_det (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    loc_id   VARCHAR(20) NOT NULL DEFAULT '',
    n_code   VARCHAR(20) NOT NULL DEFAULT '',
    name     VARCHAR(200),
    compcode VARCHAR(8),
    INDEX idx_nd (loc_id, n_code)
  ) CHARACTER SET utf8mb4`);

  await insertBatch(pool, 'newspaper_det', ['loc_id','n_code','name','compcode'], rows);

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM newspaper_det');
  console.log(`newspaper_det: ${cnt} rows`);

  // Distinct newspaper names (for filter display)
  const [names] = await pool.execute(
    `SELECT DISTINCT name FROM newspaper_det WHERE name NOT IN ('NONE','OTHER','') ORDER BY name LIMIT 15`
  );
  console.log('Newspapers:', names.map(r => r.name).join(', '));
}

async function main() {
  const pool = await mysql.createPool(MYSQL_CONFIG);
  try {
    await syncLocalityMaster(pool);
    await syncNewspaperDet(pool);
    console.log('\nAll reference tables synced successfully.');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
