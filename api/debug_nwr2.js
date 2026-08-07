'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const SQLPLUS = 'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';
const SEP = '\x1c';
const spoolFile = path.join(os.tmpdir(), 'nwr_debug2_JA0.txt');
if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

// Test with CHR(28) separator
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
const sqlFile = path.join(os.tmpdir(), 'nwr_debug2.sql');
fs.writeFileSync(sqlFile, sql);
const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
  env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true });
proc.stdout.on('data', () => {});
proc.stderr.on('data', () => {});
proc.on('close', code => {
  console.log('Exit code:', code);
  if (!fs.existsSync(spoolFile)) { console.log('Spool file NOT created!'); return; }
  const content = fs.readFileSync(spoolFile, 'utf8');
  const rawLines = content.split('\n');
  console.log('Total lines:', rawLines.length);
  const filtered = rawLines.map(l => l.replace(/\r$/, '').trim()).filter(l => l && l.includes(SEP));
  console.log('Lines with SEP (\\x1c):', filtered.length);
  if (filtered.length > 0) {
    const parsed = filtered[0].split(SEP);
    console.log('Sample parsed:', parsed);
  } else {
    // show hex of first non-empty line
    const nonEmpty = rawLines.filter(l => l.trim().length > 0);
    if (nonEmpty.length > 0) {
      const hex = Buffer.from(nonEmpty[0]).toString('hex');
      console.log('First line hex:', hex);
      console.log('First line text:', nonEmpty[0]);
    }
  }
});
const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
proc.stdin.write(`CONNECT ${cs}\n`);
proc.stdin.write(`@"${sqlFile}"\n`);
proc.stdin.write('EXIT\n');
proc.stdin.end();
