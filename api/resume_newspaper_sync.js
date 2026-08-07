'use strict';
/**
 * resume_newspaper_sync.js
 * Syncs only the remaining LOC_IDs not yet in newspaper_reader, then
 * rebuilds primary_newspaper once at the end.
 * Run: node api/resume_newspaper_sync.js
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

const ALL_LOC_IDS = [
  'AJ0','AL0','BA1','BA0','BA2','BH2','BH0','BH1','BI0','BI1',
  'CH0','SE0','DE0','GW0','IN0','JA1','JA8','JA0','JH1','JO0',
  'KH0','KO1','KO0','MA0','PA0','RA1','RA0','SA1','SA0','SI0',
  'SR0','SU0','UD0','UJ0','BH3',
];

function oraConnect() {
  return `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
         `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
}

async function spoolLoc(locId, spoolFile) {
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);
  const sqlFile = path.join(os.tmpdir(), `nwr_${locId}.sql`);
  const sql = `WHENEVER SQLERROR EXIT SQL.SQLCODE
SET TERMOUT OFF FEEDBACK OFF HEADING OFF PAGESIZE 0 LINESIZE 32767 TRIMOUT ON TRIMSPOOL ON
SPOOL "${spoolFile.replace(/\\/g, '/')}"
SELECT NVL(LOC_ID,'') || CHR(28) || NVL(R_ID,'') || CHR(28) || NVL(NEWS_SCHEME,'')
FROM NEWSPAPER_DETAIL WHERE LOC_ID = '${locId}' AND NEWS_SCHEME IS NOT NULL
/
SPOOL OFF
EXIT
`;
  fs.writeFileSync(sqlFile, sql);
  await new Promise((resolve, reject) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`sqlplus exited ${code} for ${locId}`)));
    proc.stdin.write(`CONNECT ${oraConnect()}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
  fs.unlinkSync(sqlFile);
  return fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, 'utf8') : '';
}

async function insertRows(pool, rows) {
  if (!rows.length) return 0;
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const ph = batch.map(([loc, rid, ns]) => { params.push(loc, rid, ns); return '(?,?,?)'; });
    await pool.execute(
      `INSERT IGNORE INTO newspaper_reader (loc_id, r_id, news_scheme) VALUES ${ph.join(',')}`,
      params
    );
    inserted += batch.length;
  }
  return inserted;
}

async function buildPrimaryNewspaper(pool) {
  console.log('Building primary_newspaper table...');
  await pool.execute('DROP TABLE IF EXISTS primary_newspaper');
  await pool.execute(`CREATE TABLE primary_newspaper (
    loc_id         VARCHAR(20) NOT NULL,
    r_id           VARCHAR(30) NOT NULL,
    newspaper_name VARCHAR(200),
    news_code      VARCHAR(20),
    PRIMARY KEY (loc_id, r_id)
  ) CHARACTER SET utf8mb4`);

  await pool.execute(`
    INSERT INTO primary_newspaper (loc_id, r_id, newspaper_name, news_code)
    SELECT nr.loc_id, nr.r_id,
      MAX(CASE WHEN nd.n_code NOT IN ('4001','OT0') AND nd.name NOT IN ('NONE','OTHER') THEN nd.name END) AS newspaper_name,
      MAX(CASE WHEN nd.n_code NOT IN ('4001','OT0') AND nd.name NOT IN ('NONE','OTHER') THEN nd.n_code END) AS news_code
    FROM newspaper_reader nr
    JOIN newspaper_det nd ON nd.loc_id = nr.loc_id AND nd.n_code = nr.news_scheme
    GROUP BY nr.loc_id, nr.r_id
  `);

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM primary_newspaper');
  console.log(`primary_newspaper: ${cnt} rows`);

  const [breakdown] = await pool.execute(`
    SELECT newspaper_name, COUNT(*) AS cnt FROM primary_newspaper
    WHERE newspaper_name IS NOT NULL GROUP BY newspaper_name ORDER BY cnt DESC LIMIT 10`);
  console.log('Newspaper breakdown:');
  breakdown.forEach(r => console.log(`  ${r.newspaper_name}: ${r.cnt}`));
}

async function main() {
  const pool = mysql.createPool({ ...MYSQL_CONFIG, multipleStatements: false });

  // Find which LOC_IDs are already synced
  const [synced] = await pool.execute(
    'SELECT DISTINCT loc_id FROM newspaper_reader'
  );
  const syncedSet = new Set(synced.map(r => r.loc_id));
  const remaining = ALL_LOC_IDS.filter(loc => !syncedSet.has(loc));

  console.log('Already synced:', [...syncedSet].sort().join(', '));
  console.log('Remaining:', remaining.join(', ') || '(none)');

  for (let i = 0; i < remaining.length; i++) {
    const locId = remaining[i];
    const spoolFile = path.join(os.tmpdir(), `nwr_${locId}.txt`);
    process.stdout.write(`[${i + 1}/${remaining.length}] ${locId}... `);
    try {
      // Delete any partial data for this loc before reinserting
      await pool.execute('DELETE FROM newspaper_reader WHERE loc_id = ?', [locId]);
      const raw = await spoolLoc(locId, spoolFile);
      const rows = raw.split('\n')
        .map(l => l.replace(/\r$/, '').trim())
        .filter(l => l && l.includes(SEP))
        .map(l => { const p = l.split(SEP); return [p[0] || '', p[1] || '', p[2] || '']; });
      const ins = await insertRows(pool, rows);
      console.log(`${ins} rows`);
      if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM newspaper_reader');
  console.log(`\nnewspaper_reader total: ${cnt}`);

  await buildPrimaryNewspaper(pool);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
