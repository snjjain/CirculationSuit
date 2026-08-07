'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const SQLPLUS = 'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';
const SEP = '\x1c';
const spoolFile = path.join(os.tmpdir(), 'nwr_debug3_JA0.txt');
if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

const sql = `SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
SPOOL ${spoolFile}
SELECT NVL(LOC_ID,'') || CHR(28) || NVL(TO_CHAR(R_ID),'') || CHR(28) || NVL(NEWS_SCHEME,'') FROM NEWSPAPER_DETAIL WHERE LOC_ID = 'JA0' AND NEWS_SCHEME IS NOT NULL AND NEWS_SCHEME != '' AND ROWNUM <= 10;
SPOOL OFF
EXIT
`;
const sqlFile = path.join(os.tmpdir(), 'nwr_debug3.sql');
fs.writeFileSync(sqlFile, sql);
const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
  env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true });
let stdout = '';
proc.stdout.on('data', d => { stdout += d; });
proc.stderr.on('data', () => {});
proc.on('close', code => {
  console.log('Exit code:', code);
  if (!fs.existsSync(spoolFile)) { console.log('Spool file NOT created!'); return; }
  const buf = fs.readFileSync(spoolFile);
  console.log('File size:', buf.length, 'bytes');
  console.log('First 200 bytes hex:', buf.slice(0, 200).toString('hex'));
  console.log('First 200 bytes raw:', buf.slice(0, 200).toString('utf8'));
  // Check stdout (Oracle may echo to stdout instead of spool)
  console.log('Stdout (first 400 chars):', stdout.substring(0, 400));
});
const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
proc.stdin.write(`CONNECT ${cs}\n`);
proc.stdin.write(`@"${sqlFile}"\n`);
proc.stdin.write('EXIT\n');
proc.stdin.end();
