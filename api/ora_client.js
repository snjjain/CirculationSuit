'use strict';

/**
 * ora_client.js — shared Oracle access for all sync scripts.
 *
 * Two drivers, auto-selected:
 *   1. node-oracledb  — used when the package is installed (Linux server:
 *      `npm i oracledb`; thick mode via Instant Client Basic, no sqlplus needed)
 *   2. sqlplus spawn  — fallback (Windows dev PC with full Oracle client)
 *
 * Drop-in contract: each sync script already writes a complete sqlplus script
 * (SET…, SPOOL <file>, SELECT … ;, SPOOL OFF, EXIT). runViaDriver() parses
 * that same file, executes the SELECT through node-oracledb, and writes the
 * result rows to the same spool path — so the per-script spool parsing stays
 * untouched.
 *
 * .env on the server:
 *   ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient_19_27   (thick mode libs;
 *   falls back to scanning LD_LIBRARY_PATH for an "instantclient" entry)
 */

const fs = require('fs');

let oracledb = null, initTried = false, initOk = false;

function driverAvailable() {
  if (!initTried) {
    initTried = true;
    try {
      oracledb = require('oracledb');
      // Thick mode is REQUIRED — the ERP is Oracle 11g, which thin mode does
      // not support (NJS-138). Only use the driver when Instant Client libs
      // initialise; otherwise fall back to sqlplus.
      try {
        const libDir = process.env.ORACLE_CLIENT_LIB_DIR ||
          (process.env.LD_LIBRARY_PATH || '').split(':').find(p => p.includes('instantclient')) || null;
        oracledb.initOracleClient(libDir ? { libDir } : {});
      } catch (_) { /* thick init failed or already initialised */ }
      initOk = oracledb.thin === false;
      if (!initOk) oracledb = null;
    } catch (_) { oracledb = null; initOk = false; }
  }
  return initOk;
}

async function runViaDriver(sqlFile) {
  const text = fs.readFileSync(sqlFile, 'utf8');
  const m = text.match(/^SPOOL[ \t]+(.+?)[ \t]*$/mi);
  if (!m) throw new Error('ora_client: no SPOOL line found in ' + sqlFile);
  const spoolPath = m[1].trim().replace(/^["']|["']$/g, '');
  const after  = text.slice(text.indexOf(m[0]) + m[0].length);
  const endIdx = after.search(/^SPOOL OFF/mi);
  const select = after.slice(0, endIdx === -1 ? undefined : endIdx).trim().replace(/;\s*$/, '');

  const conn = await oracledb.getConnection({
    user:          process.env.ORA_USER,
    password:      process.env.ORA_PASSWORD,
    connectString: `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`,
  });
  try {
    // Match the sqlplus runner's NLS environment (AMERICAN_AMERICA.AL32UTF8)
    await conn.execute(`ALTER SESSION SET NLS_DATE_LANGUAGE='AMERICAN' NLS_NUMERIC_CHARACTERS='.,'`);
    const result = await conn.execute(select, [], { resultSet: true, fetchArraySize: 5000 });
    const rs = result.resultSet;
    const out = [];
    let rows;
    while ((rows = await rs.getRows(5000)).length) {
      for (const r of rows) out.push(r[0] == null ? '' : String(r[0]));
    }
    await rs.close();
    fs.writeFileSync(spoolPath, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
    return { stdout: '', stderr: '' };
  } finally {
    try { await conn.close(); } catch (_) {}
  }
}

module.exports = { driverAvailable, runViaDriver };
