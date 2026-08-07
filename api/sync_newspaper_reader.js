'use strict';
/**
 * sync_newspaper_reader.js — Oracle NEWSPAPER_DETAIL → MySQL newspaper_reader
 *
 * Syncs reader-newspaper mappings (1.5M rows) chunked by LOC_ID to avoid
 * large memory spikes. After sync, creates primary_newspaper table for
 * fast per-reader newspaper lookup in API queries.
 *
 * Usage:
 *   node api/sync_newspaper_reader.js
 *   node api/sync_newspaper_reader.js --loc JA0    # single location
 *   node api/sync_newspaper_reader.js --rebuild-primary  # only rebuild primary_newspaper
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

// All branches that have survey data
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
  const sqlFile = path.join(os.tmpdir(), `ora_nwr_${locId}_${Date.now()}.sql`);

  const sql = `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile}
SELECT NVL(LOC_ID,'') || CHR(28) || NVL(TO_CHAR(R_ID),'') || CHR(28) || NVL(NEWS_SCHEME,'')
FROM NEWSPAPER_DETAIL
WHERE LOC_ID = '${locId}' AND NEWS_SCHEME IS NOT NULL
ORDER BY R_ID;
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

  // Drop and recreate as a regular table (VIEW would be slow on 1.5M rows per query)
  await pool.execute('DROP TABLE IF EXISTS primary_newspaper');
  await pool.execute(`CREATE TABLE primary_newspaper (
    loc_id         VARCHAR(20) NOT NULL,
    r_id           VARCHAR(30) NOT NULL,
    newspaper_name VARCHAR(200),
    news_code      VARCHAR(20),
    PRIMARY KEY (loc_id, r_id)
  ) CHARACTER SET utf8mb4`);

  // Priority rules applied here:
  //   RP+DB both       → 'RP+DB'
  //   DB (incl. alias) → 'DAINIK BHASKAR'
  //   RP (or PATRIKA)  → 'RAJASTHAN PATRIKA'  (region-corrected by UPDATE below)
  //   Other named      → actual newspaper name
  //   OTHER code       → 'OTHER'
  //   NONE only        → 'NONE'
  // 'PATRIKA' and 'RAJASTHAN PATRIKA' are treated as the same RP brand here;
  // the UPDATE below corrects region (MP/CG readers get 'PATRIKA' back).
  await pool.execute(`
    INSERT INTO primary_newspaper (loc_id, r_id, newspaper_name, news_code)
    SELECT agg.loc_id, agg.r_id,
      CASE
        WHEN agg.has_rp > 0 AND agg.has_db > 0 THEN 'RP+DB'
        WHEN agg.has_db > 0                     THEN 'DAINIK BHASKAR'
        WHEN agg.has_rp > 0                     THEN 'RAJASTHAN PATRIKA'
        WHEN agg.other_paper IS NOT NULL         THEN agg.other_paper
        WHEN agg.has_other > 0                  THEN 'OTHER'
        ELSE 'NONE'
      END AS newspaper_name,
      CASE
        WHEN agg.has_rp > 0 AND agg.has_db > 0 THEN 'RP_DB'
        WHEN agg.has_db > 0                     THEN 'DB01'
        WHEN agg.has_rp > 0                     THEN 'RP01'
        ELSE NULL
      END AS news_code
    FROM (
      SELECT nr.loc_id, nr.r_id,
        SUM(CASE WHEN nd.name IN ('RAJASTHAN PATRIKA','PATRIKA')
                  AND nd.n_code NOT IN ('4001','OT0') THEN 1 ELSE 0 END) AS has_rp,
        SUM(CASE WHEN nd.name IN ('DAINIK BHASKAR','DB')
                  AND nd.n_code NOT IN ('4001','OT0') THEN 1 ELSE 0 END) AS has_db,
        MAX(CASE WHEN nd.n_code NOT IN ('4001','OT0')
                  AND nd.name NOT IN ('NONE','OTHER','RAJASTHAN PATRIKA','PATRIKA','DAINIK BHASKAR','DB')
                 THEN nd.name END) AS other_paper,
        SUM(CASE WHEN nd.n_code = 'OT0' OR nd.name = 'OTHER' THEN 1 ELSE 0 END) AS has_other
      FROM newspaper_reader nr
      JOIN newspaper_det nd ON nd.loc_id = nr.loc_id AND nd.n_code = nr.news_scheme
      GROUP BY nr.loc_id, nr.r_id
    ) agg
  `);

  // Region correction: MP/CG readers who effectively subscribe to PATRIKA (not RAJASTHAN PATRIKA).
  // After the INSERT above, RP-brand readers are all stored as 'RAJASTHAN PATRIKA'. Fix MP/CG.
  await pool.execute(`
    UPDATE primary_newspaper pn
    INNER JOIN (
      SELECT DISTINCT unit_code, state_name
      FROM survey_data
      WHERE state_name IS NOT NULL AND unit_code IS NOT NULL
    ) st ON st.unit_code = pn.loc_id
    SET pn.newspaper_name = 'PATRIKA'
    WHERE pn.newspaper_name = 'RAJASTHAN PATRIKA'
      AND st.state_name IN ('MP0','CG0')
  `);

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM primary_newspaper');
  console.log(`primary_newspaper: ${cnt} rows`);

  // Newspaper breakdown
  const [breakdown] = await pool.execute(`
    SELECT newspaper_name, COUNT(*) AS cnt
    FROM primary_newspaper
    WHERE newspaper_name IS NOT NULL
    GROUP BY newspaper_name
    ORDER BY cnt DESC
    LIMIT 10
  `);
  console.log('Newspaper breakdown:');
  breakdown.forEach(r => console.log(`  ${r.newspaper_name}: ${r.cnt}`));
}

async function main() {
  const singleLoc = process.argv.includes('--loc')
    ? process.argv[process.argv.indexOf('--loc') + 1]
    : null;
  const rebuildOnly = process.argv.includes('--rebuild-primary');

  const pool = await mysql.createPool({ ...MYSQL_CONFIG, multipleStatements: false });

  if (rebuildOnly) {
    await buildPrimaryNewspaper(pool);
    await pool.end();
    return;
  }

  // Create newspaper_reader table
  await pool.execute(`CREATE TABLE IF NOT EXISTS newspaper_reader (
    loc_id     VARCHAR(20) NOT NULL,
    r_id       VARCHAR(30) NOT NULL,
    news_scheme VARCHAR(20) NOT NULL,
    INDEX idx_nr (loc_id, r_id),
    INDEX idx_nr_ns (loc_id, news_scheme)
  ) CHARACTER SET utf8mb4`);

  const locIds = singleLoc ? [singleLoc] : ALL_LOC_IDS;

  if (!singleLoc) {
    // Full rebuild — truncate first
    await pool.execute('TRUNCATE TABLE newspaper_reader');
    console.log('Truncated newspaper_reader, starting full sync...');
  }

  let totalInserted = 0;
  for (let i = 0; i < locIds.length; i++) {
    const locId = locIds[i];
    const spoolFile = path.join(os.tmpdir(), `nwr_${locId}.txt`);
    process.stdout.write(`[${i+1}/${locIds.length}] ${locId}... `);

    try {
      const raw = await spoolLoc(locId, spoolFile);
      const rows = raw.split('\n')
        .map(l => l.replace(/\r$/, '').trim())
        .filter(l => l && l.includes(SEP))
        .map(l => { const p = l.split(SEP); return [p[0]||'', p[1]||'', p[2]||'']; });

      if (singleLoc) {
        // Delete existing rows for this loc before reinserting
        await pool.execute('DELETE FROM newspaper_reader WHERE loc_id = ?', [locId]);
      }

      const ins = await insertRows(pool, rows);
      totalInserted += ins;
      console.log(`${rows.length} rows`);

      if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log(`\nTotal inserted: ${totalInserted}`);

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM newspaper_reader');
  console.log(`newspaper_reader total: ${cnt}`);

  await buildPrimaryNewspaper(pool);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
