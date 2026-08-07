'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const SQLPLUS = 'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';
const spoolFile = path.join(os.tmpdir(), 'nwr_debug_JA0.txt');
if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);

const sql = `SET PAGESIZE 0
SET LINESIZE 500
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
SPOOL ${spoolFile}
SELECT COUNT(*) FROM NEWSPAPER_DETAIL WHERE LOC_ID = 'JA0';
SELECT NVL(LOC_ID,'') || '|' || NVL(TO_CHAR(R_ID),'') || '|' || NVL(NEWS_SCHEME,'') FROM NEWSPAPER_DETAIL WHERE LOC_ID = 'JA0' AND ROWNUM <= 5;
SPOOL OFF
EXIT
`;
const sqlFile = path.join(os.tmpdir(), 'nwr_debug.sql');
fs.writeFileSync(sqlFile, sql);
const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
  env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true });
let out = '';
proc.stdout.on('data', d => { out += d; });
proc.stderr.on('data', d => { out += d; });
proc.on('close', code => {
  console.log('Exit code:', code);
  const content = fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, 'utf8') : 'NO SPOOL FILE';
  console.log('Spool content:\n' + content.substring(0, 800));
  console.log('Stdout:', out.substring(0, 200));
});
const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
proc.stdin.write(`CONNECT ${cs}\n`);
proc.stdin.write(`@"${sqlFile}"\n`);
proc.stdin.write('EXIT\n');
proc.stdin.end();
