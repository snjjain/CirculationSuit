'use strict';
// Test: CHR(28) with smaller LINESIZE; also try CHR(1) as separator
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const SQLPLUS = 'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

async function test(label, sep, linesize) {
  const spoolFile = path.join(os.tmpdir(), `nwr_test_${label}.txt`);
  if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile);
  const sqlFile = path.join(os.tmpdir(), `nwr_test_${label}.sql`);
  const sql = `SET PAGESIZE 0
SET LINESIZE ${linesize}
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET TRIMSPOOL ON
SPOOL ${spoolFile}
SELECT 'JA0' || ${sep} || 'TESTID' || ${sep} || 'DA0' FROM DUAL;
SELECT NVL(LOC_ID,'') || ${sep} || NVL(TO_CHAR(R_ID),'') || ${sep} || NVL(NEWS_SCHEME,'') FROM NEWSPAPER_DETAIL WHERE LOC_ID = 'JA0' AND NEWS_SCHEME IS NOT NULL AND NEWS_SCHEME != '' AND ROWNUM <= 3;
SPOOL OFF
EXIT
`;
  fs.writeFileSync(sqlFile, sql);
  await new Promise((resolve) => {
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' }, windowsHide: true });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      const exists = fs.existsSync(spoolFile);
      const size = exists ? fs.statSync(spoolFile).size : -1;
      const content = exists ? fs.readFileSync(spoolFile) : Buffer.alloc(0);
      console.log(`[${label}] exit=${code} spool_exists=${exists} size=${size} bytes`);
      if (size > 0) {
        console.log(`  hex: ${content.slice(0, 60).toString('hex')}`);
        console.log(`  text: ${JSON.stringify(content.slice(0, 60).toString('binary'))}`);
      }
      if (stdout) console.log(`  stdout: ${stdout.substring(0, 100)}`);
      resolve();
    });
    const cs = `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    proc.stdin.write(`CONNECT ${cs}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

(async () => {
  await test('pipe_500', "'|'", 500);
  await test('chr28_500', 'CHR(28)', 500);
  await test('chr28_32767', 'CHR(28)', 32767);
  await test('chr1_500', 'CHR(1)', 500);
})();
