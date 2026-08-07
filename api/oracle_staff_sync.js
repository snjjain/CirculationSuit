'use strict';

/**
 * oracle_staff_sync.js — Pull supervisor + surveyor name masters from Oracle → MySQL
 *
 *   CRM_TEAM_LEADER_MASTER → tl_master  (tl_id → tl_name)
 *   CRM_PRO_MASTER         → pro_master (pro_id → pro_name)
 *
 * Small reference tables (~400 + ~3k rows); full replace on every run.
 * Usage:  node api/oracle_staff_sync.js
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
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

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_sync.log');
const SEP = '\x1c';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] [staff_sync] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}

function buildSqlScript(spoolFile) {
  const D = 'CHR(28)';
  return `SET PAGESIZE 0
SET LINESIZE 4000
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SET TRIMOUT ON
SET TERMOUT OFF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolFile}
SELECT 'TL' || ${D} || NVL(TO_CHAR(tl_id),'') || ${D} || NVL(REPLACE(tl_name,CHR(28),' '),'') || ${D} || NVL(loc_id,'') || ${D} || ''
FROM RPERPDATA.CRM_TEAM_LEADER_MASTER;
SELECT 'PRO' || ${D} || NVL(TO_CHAR(pro_id),'') || ${D} || NVL(REPLACE(pro_name,CHR(28),' '),'') || ${D} || NVL(loc_id,'') || ${D} || NVL(TO_CHAR(tl_id),'')
FROM RPERPDATA.CRM_PRO_MASTER;
SPOOL OFF
EXIT
`;
}

function runSqlplus(sqlFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      const errMatch = (stdout + stderr).match(/ORA-\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*|TNS-\d{5}[^\r\n]*/);
      if (code === 0 && !errMatch) resolve({ stdout, stderr });
      else reject(new Error(`sqlplus failed (exit ${code})${errMatch ? ': ' + errMatch[0] : ''}`));
    });
    const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
               `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    proc.stdin.write(`CONNECT ${cs}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

async function main() {
  log('=== Staff master sync started ===');
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-staff-'));
  const sqlFile = path.join(tmpDir, 'staff.sql');
  const spool   = path.join(tmpDir, 'staff_spool.txt');
  fs.writeFileSync(sqlFile, buildSqlScript(spool));

  try {
    await runSqlplus(sqlFile);
    const raw = fs.readFileSync(spool, 'utf-8');
    const tls = [], pros = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes(SEP)) continue;
      const f = line.split(SEP);
      if (f[0] === 'TL'  && str(f[1])) tls.push([str(f[1]), str(f[2]), str(f[3])]);
      if (f[0] === 'PRO' && str(f[1])) pros.push([str(f[1]), str(f[2]), str(f[3]), str(f[4])]);
    }
    log(`Oracle returned ${tls.length} team leaders, ${pros.length} promoters`);
    if (!tls.length && !pros.length) throw new Error('no rows parsed — aborting (tables left unchanged)');

    const conn = await mysql.createConnection(MYSQL_CONFIG);
    await conn.query(`CREATE TABLE IF NOT EXISTS tl_master (
      tl_id   VARCHAR(20) NOT NULL,
      tl_name VARCHAR(100),
      loc_id  VARCHAR(10),
      PRIMARY KEY (tl_id, loc_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query(`CREATE TABLE IF NOT EXISTS pro_master (
      pro_id   VARCHAR(40) NOT NULL,
      pro_name VARCHAR(100),
      loc_id   VARCHAR(10),
      tl_id    VARCHAR(20),
      PRIMARY KEY (pro_id, loc_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    if (tls.length) {
      await conn.query('DELETE FROM tl_master');
      await conn.query('INSERT IGNORE INTO tl_master (tl_id, tl_name, loc_id) VALUES ?',
        [tls.map(t => [t[0], t[1], t[2] || ''])]);
    }
    if (pros.length) {
      await conn.query('DELETE FROM pro_master');
      await conn.query('INSERT IGNORE INTO pro_master (pro_id, pro_name, loc_id, tl_id) VALUES ?',
        [pros.map(p => [p[0], p[1], p[2] || '', p[3]])]);
    }
    const [[tc]] = await conn.query('SELECT COUNT(*) c FROM tl_master');
    const [[pc]] = await conn.query('SELECT COUNT(*) c FROM pro_master');
    log(`MySQL now has ${tc.c} tl_master, ${pc.c} pro_master rows`);
    const [samp] = await conn.query("SELECT pro_id, pro_name FROM pro_master WHERE pro_id LIKE 'P/%' LIMIT 5");
    log('pro_id samples: ' + JSON.stringify(samp));
    await conn.end();
    log('=== Staff master sync complete ===');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
