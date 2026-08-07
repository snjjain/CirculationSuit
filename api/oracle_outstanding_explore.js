'use strict';

/**
 * oracle_outstanding_explore.js — Probe cir_agency_outstanding_rep_new
 *
 * Calls the Oracle procedure with VARIABLE/EXEC/PRINT to dump raw output
 * so we can see column names and data format before building the sync.
 *
 * Usage:
 *   node api/oracle_outstanding_explore.js
 *   node api/oracle_outstanding_explore.js --from 01-JAN-2026 --to 01-AUG-2026
 */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const fromDate = getArg('--from') || '01-JAN-2026';
const toDate   = getArg('--to')   || '01-AUG-2026';

const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'ora_out_'));
const sqlFile  = path.join(tmpDir, 'explore.sql');
const spoolFile = path.join(tmpDir, 'explore.txt');

// Use VARIABLE/EXEC/PRINT to dump REF CURSOR output with headers
const sqlScript = `SET PAGESIZE 50000
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING ON
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SPOOL ${spoolFile}
VARIABLE A REFCURSOR
EXEC cir_agency_outstanding_rep_new(UPPER('RP001'),'','',UPPER('NM'),'','','','2','','${fromDate}','${toDate}','dd/mm/yyyy','Y',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,:A)
PRINT A
SPOOL OFF
EXIT
`;

fs.writeFileSync(sqlFile, sqlScript, 'utf8');

console.log(`[explore] Calling Oracle procedure: ${fromDate} → ${toDate}`);
console.log(`[explore] Spool: ${spoolFile}`);

const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
  env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
  windowsHide: true,
});

let stdout = '', stderr = '';
proc.stdout.on('data', d => { stdout += d; });
proc.stderr.on('data', d => { stderr += d; });
proc.on('error', err => { console.error('spawn error:', err); process.exit(1); });
proc.on('close', code => {
  const combined = stdout + stderr;
  const errMatch = combined.match(/ORA-\d{5}[^\r\n]*|SP2-\d{4}[^\r\n]*|TNS-\d{5}[^\r\n]*/);
  if (errMatch) {
    console.error('Oracle error:', errMatch[0]);
    console.error(combined.slice(0, 1000));
    process.exit(1);
  }

  // Read spool file
  let out = '';
  try { out = fs.readFileSync(spoolFile, { encoding: 'utf8' }); } catch (_) {}

  if (!out.trim()) {
    console.log('[explore] Spool file empty — printing stdout instead:');
    console.log(combined.slice(0, 5000));
  } else {
    // Print header (first 3 lines) + column separator line + first 5 data rows
    const lines = out.split('\n').filter(l => l.trim());
    console.log('\n=== COLUMN HEADER LINES ===');
    lines.slice(0, 3).forEach(l => console.log(l));
    console.log('\n=== FIRST 10 DATA ROWS ===');
    lines.slice(3, 13).forEach(l => console.log(l));
    console.log('\n=== TOTAL LINES IN SPOOL ===', lines.length);
    console.log('\n=== FULL OUTPUT SAVED TO ===', spoolFile);
    // Also save a local copy for review
    const localCopy = path.resolve(__dirname, '../logs/outstanding_explore.txt');
    fs.mkdirSync(path.dirname(localCopy), { recursive: true });
    fs.writeFileSync(localCopy, out, 'utf8');
    console.log('[explore] Local copy saved:', localCopy);
  }

  // Cleanup temp sql file
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
});

const connectString =
  `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
  `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;

proc.stdin.write(`CONNECT ${connectString}\n`);
proc.stdin.write(`@"${sqlFile}"\n`);
proc.stdin.write('EXIT\n');
proc.stdin.end();
