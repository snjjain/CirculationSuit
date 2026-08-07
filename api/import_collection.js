'use strict';
/**
 * import_collection.js — Import Agency Collection Excel → MySQL agency_collection table
 *
 * Usage:
 *   node api/import_collection.js [--file "path/to/file.xlsx"] [--clear]
 *
 * Default file: Input Reports/Collection 1 Jan to 31 Jul 2026.xlsx
 * --clear: truncate table before import (default: UPSERT)
 */

const xlsx  = require('xlsx');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DEFAULT_FILE = path.resolve(__dirname, '../Input Reports/Collection 1 Jan to 31 Jul 2026.xlsx');
const LOG_FILE     = path.resolve(__dirname, '../logs/collection_import.log');

function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function getArg(n) { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; }
function hasFlag(n) { return process.argv.includes(n); }

// Excel serial date → YYYY-MM-DD
function excelDate(v) {
  if (!v || typeof v !== 'number') return null;
  const d = new Date((v - 25569) * 86400000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// Normalise payment mode string → category (2 buckets only)
// Cash = physical cash with executive; everything else — incl. agent deposit
// cash in bank, cheque, NEFT, UPI, gateway — counts as Digital.
function paymentCat(mode) {
  const m = String(mode || '').trim().toUpperCase();
  return m === 'EXECUTIVE CASH' ? 'Cash' : 'Digital';
}

function str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? (max ? s.slice(0, max) : s) : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

async function ensureTable(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS agency_collection (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    sno           INT,
    state_name    VARCHAR(100),
    district_name VARCHAR(100),
    branch_name   VARCHAR(200),
    zonal_head    VARCHAR(200),
    coll_date     DATE NOT NULL,
    doc_type      VARCHAR(20),
    doc_no        VARCHAR(60),
    ag_code       VARCHAR(30),
    dp_code       VARCHAR(10),
    ag_name       VARCHAR(300),
    drop_point    VARCHAR(300),
    payment_mode  VARCHAR(100),
    payment_cat   VARCHAR(30),
    cheque_no     VARCHAR(50),
    chq_date      DATE,
    bank          VARCHAR(200),
    amount        DECIMAL(14,2),
    debit_head    VARCHAR(300),
    credit_head   VARCHAR(200),
    narration     TEXT,
    mobile        VARCHAR(20),
    is_valid      TINYINT DEFAULT 1,
    INDEX idx_ag_code    (ag_code),
    INDEX idx_coll_date  (coll_date),
    INDEX idx_branch     (branch_name),
    INDEX idx_payment    (payment_cat),
    INDEX idx_state      (state_name),
    INDEX idx_doc_no     (doc_no)
  ) CHARACTER SET utf8mb4`);
}

async function run() {
  const filePath = getArg('--file') || DEFAULT_FILE;
  if (!fs.existsSync(filePath)) {
    log(`FATAL: File not found: ${filePath}`);
    process.exit(1);
  }

  log(`=== Collection import started ===`);
  log(`File: ${filePath}`);

  const conn = await mysql.createConnection({
    host:     process.env.MYSQL_HOST     || 'localhost',
    port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
    database: process.env.MYSQL_DB       || 'patrika_vitran',
    user:     process.env.MYSQL_USER     || 'root',
    password: process.env.MYSQL_PASSWORD || '',
  });

  await ensureTable(conn);

  if (hasFlag('--clear')) {
    await conn.execute('TRUNCATE TABLE agency_collection');
    log('Table truncated');
  }

  log('Reading Excel...');
  const wb   = xlsx.readFile(filePath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const all  = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const data = all.slice(1).filter(r => r[5] && r[8]); // must have date + agency code

  log(`${data.length} data rows found`);

  // Amount threshold for validity (₹1 crore)
  const AMOUNT_CAP = 10_000_000;
  let anomalies = 0;

  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);

    const vals = batch.map(r => {
      const amt    = num(r[16]);
      const valid  = amt != null && amt > 0 && amt <= AMOUNT_CAP ? 1 : 0;
      if (!valid && amt) anomalies++;
      return [
        num(r[0]),                           // sno
        str(r[1], 100),                      // state_name
        str(r[2], 100),                      // district_name
        str(r[3], 200),                      // branch_name
        str(r[4], 200),                      // zonal_head
        excelDate(r[5]),                     // coll_date
        str(r[6], 20),                       // doc_type
        str(r[7], 60),                       // doc_no
        str(r[8], 30),                       // ag_code
        str(r[9] != null ? String(r[9]) : null, 10), // dp_code
        str(r[10], 300),                     // ag_name
        str(r[11], 300),                     // drop_point
        str(r[12], 100),                     // payment_mode
        paymentCat(r[12]),                   // payment_cat
        r[13] ? str(String(r[13]), 50) : null, // cheque_no
        excelDate(typeof r[14] === 'number' ? r[14] : null), // chq_date
        str(r[15], 200),                     // bank
        valid ? amt : null,                  // amount (null if anomalous)
        str(r[17], 300),                     // debit_head
        str(r[18], 200),                     // credit_head
        typeof r[19] === 'string' ? r[19].slice(0, 1000) : null, // narration
        r[20] ? str(String(r[20]), 20) : null, // mobile
        valid,                               // is_valid
      ];
    });

    const ph = vals.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    await conn.execute(
      `INSERT INTO agency_collection
        (sno,state_name,district_name,branch_name,zonal_head,coll_date,doc_type,doc_no,
         ag_code,dp_code,ag_name,drop_point,payment_mode,payment_cat,cheque_no,chq_date,
         bank,amount,debit_head,credit_head,narration,mobile,is_valid)
       VALUES ${ph}`,
      vals.flat()
    );
    inserted += batch.length;
    if (inserted % 5000 === 0) log(`  ${inserted}/${data.length} rows inserted...`);
  }

  await conn.end();
  log(`=== Import complete: ${inserted} rows, ${anomalies} amount anomalies flagged ===`);
}

run().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
