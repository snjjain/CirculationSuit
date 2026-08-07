'use strict';
// One-time sync: Oracle CRM_LOCALITY_MASTER → MySQL locality_master
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB || 'patrika_vitran',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

async function main() {
  const spoolFile = path.join(os.tmpdir(), 'loc_master_spool.txt');
  const sqlFile   = path.join(os.tmpdir(), 'loc_master_query.sql');

  const sqlScript = `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile}
SELECT NVL(TO_CHAR(CENT_ID),'') || CHR(28) || NVL(L_CODE,'') || CHR(28) || REPLACE(NVL(L_NAME,''),CHR(28),' ') FROM CRM_LOCALITY_MASTER ORDER BY CENT_ID NULLS FIRST, TO_NUMBER(L_CODE) NULLS LAST;
SPOOL OFF
EXIT
`;
  fs.writeFileSync(sqlFile, sqlScript);

  console.log('Fetching CRM_LOCALITY_MASTER from Oracle…');
  await new Promise((resolve, reject) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`sqlplus exited ${code}`));
    });
    const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
               `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    proc.stdin.write(`CONNECT ${cs}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });

  const raw = fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, 'utf8') : '';
  const SEP = '\x1c';
  const rows = raw.split('\n')
    .map(l => l.replace(/\r$/, '').trim())
    .filter(l => l && l.includes(SEP));
  console.log(`Parsed ${rows.length} rows from Oracle`);
  if (!rows.length) { console.error('No rows parsed. Aborting.'); process.exit(1); }

  const pool = await mysql.createPool(MYSQL_CONFIG);
  await pool.execute(`CREATE TABLE IF NOT EXISTS locality_master (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    cent_id VARCHAR(30) NOT NULL DEFAULT '',
    l_code  VARCHAR(20) NOT NULL,
    l_name  VARCHAR(200),
    INDEX idx_lm (l_code, cent_id)
  ) CHARACTER SET utf8mb4`);
  await pool.execute('TRUNCATE TABLE locality_master');

  let inserted = 0;
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const placeholders = batch.map(row => {
      const parts = row.split(SEP);
      params.push(
        (parts[0] || '').trim(),
        (parts[1] || '').trim(),
        (parts[2] || '').trim()
      );
      return '(?,?,?)';
    });
    await pool.execute(
      `INSERT INTO locality_master (cent_id, l_code, l_name) VALUES ${placeholders.join(',')}`,
      params
    );
    inserted += batch.length;
    process.stdout.write(`\r  Inserted ${inserted}/${rows.length}`);
  }
  console.log('\nDone.');

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM locality_master');
  console.log(`MySQL locality_master: ${cnt} rows`);
  const [samples] = await pool.execute(
    'SELECT cent_id, l_code, l_name FROM locality_master WHERE l_name != "" LIMIT 5'
  );
  samples.forEach(r => console.log(`  [${r.cent_id}] ${r.l_code} → ${r.l_name}`));
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
