'use strict';

/**
 * oracle_hawker_master_sync.js — Oracle CRM_HAWKER_MASTER → MySQL hawker_master
 *
 * Full sync daily: TRUNCATE + INSERT all active hawkers.
 * The table is moderate in size (typically < 50k rows) so a full reload
 * is faster and simpler than tracking incremental changes without a
 * reliable UPDATED_DT filter.
 *
 * Usage:
 *   node api/oracle_hawker_master_sync.js          # full sync
 *   node api/oracle_hawker_master_sync.js --dry-run # count rows, no write
 *
 * Source query based on:
 *   SELECT H.FIELD_OFFICER, CIR_GET_EXECUTIVE(H.COMPCODE, H.FIELD_OFFICER),
 *          H.LOC_ID, CIR_GET_UNITNAME(H.LOC_ID),
 *          H.CENTER_INCHARGE, CIR_GET_EXECUTIVE(H.COMPCODE, H.CENTER_INCHARGE),
 *          H.CENT_ID, (SELECT CENT_NAME FROM CRM_CENTER_MASTER ...),
 *          H.CATAGORY, H.*
 *   FROM CRM_HAWKER_MASTER H
 *
 * Security: Oracle credentials passed via sqlplus stdin ONLY — never on
 * command line or written to any persistent file.
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
/* The master is the lookup behind every hawker card, so a hawker who stopped supplying
   must still open rather than 404. Default is therefore the FULL master (~11k rows);
   --recent-only keeps the old 6-month-supply filter for a lighter refresh. */
const RECENT_ONLY = process.argv.includes('--recent-only');

const SQLPLUS = process.env.SQLPLUS_PATH ||
  'C:\\oraclexe\\app\\oracle\\product\\11.2.0\\server\\bin\\sqlplus.exe';

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

const LOG_FILE = path.resolve(__dirname, '../logs/oracle_hawker_master_sync.log');
const SEP   = '\x1c';   // ASCII 28 — field separator, never appears in data
const D     = 'CHR(28)';
const NCOLS = 79;       // must match cols array in buildSqlScript

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

// ── Field sanitiser (matches S() in other sync scripts) ──────────────────────
// Strips field separator + newlines; null-safe via NVL(TO_CHAR(...)).
const S = f =>
  `REPLACE(REPLACE(REPLACE(NVL(TO_CHAR(${f}),''),${D},' '),CHR(10),' '),CHR(13),' ')`;

// ── Oracle SQL ────────────────────────────────────────────────────────────────
// 12 fields, each on its own line (sqlplus line limit = 2499 chars).
// Field order MUST match lineToParams() below.
function buildSqlScript(spoolFile) {
  const spoolEsc = spoolFile.replace(/\\/g, '/');

  const cols = [
    S('H.COMPCODE'),                                                        //  0 compcode
    S('H.LOC_ID'),                                                          //  1 unit_code
    S('H.CENT_ID'),                                                         //  2 hawker_center_code
    S('H.HAWKER_ID'),                                                       //  3 hawker_id
    S('H.HAWKER_NAME'),                                                     //  4 hawker_name
    S('H.MOBILE'),                                                          //  5 mobile_no
    S('H.FIELD_OFFICER'),                                                   //  6 field_officer_code
    S('H.CENTER_INCHARGE'),                                                 //  7 center_incharge_code
    S('H.CATAGORY'),                                                        //  8 catagory
    S('H.ACCOUNT_NO'),                                                      //  9 account_no
    S('H.ADD1_OTH_LANG'),                                                   // 10 add1_oth_lang
    S('H.ADDR2'),                                                           // 11 addr2
    S('H.ADDR3'),                                                           // 12 addr3
    S('H.ADDR4'),                                                           // 13 addr4
    S('H.ADDRESS_OF_BANK'),                                                 // 14 address_of_bank
    S('H.ADHAR_NO'),                                                        // 15 adhar_no
    S('H.AG_NAME'),                                                         // 16 ag_name
    S('H.ATTATCH_PHOTO_FNAME'),                                             // 17 attatch_photo_fname
    S('H.BANKNAME'),                                                        // 18 bankname
    S('H.BANK_ACC_TYPE'),                                                   // 19 bank_acc_type
    S('H.BANK_BRANCH'),                                                     // 20 bank_branch
    S('H.BANK_IFSE'),                                                       // 21 bank_ifse
    S('H.BANK_NAME'),                                                       // 22 bank_name
    S('H.BEAT_BOYS'),                                                       // 23 beat_boys
    S('H.BENEFICIARY_NAME'),                                                // 24 beneficiary_name
    S('H.CITY'),                                                            // 25 city
    S('H.CREATED_BY'),                                                      // 26 created_by
    S("TO_CHAR(H.CREATED_DT,'YYYY-MM-DD HH24:MI:SS')"),                     // 27 created_dt
    S("TO_CHAR(H.DATEOFSTART,'YYYY-MM-DD')"),                               // 28 dateofstart
    S('H.DISTRIBUTION_AREA'),                                               // 29 distribution_area
    S('H.DIST_CODE'),                                                       // 30 dist_code
    S("TO_CHAR(H.DOA,'YYYY-MM-DD')"),                                       // 31 doa
    S("TO_CHAR(H.DOB,'YYYY-MM-DD')"),                                       // 32 dob
    S('H.EMAIL'),                                                           // 33 email
    S('H.EXIST'),                                                           // 34 exist
    S('H.FATHER_NAME'),                                                     // 35 father_name
    S('H.GENDER'),                                                          // 36 gender
    S('H.HAWKER_ADD'),                                                      // 37 hawker_add
    S('H.HAWKER_SEQ'),                                                      // 38 hawker_seq
    S('H.HAWKER_TYPE'),                                                     // 39 hawker_type
    S('H.HDR_UK_ID'),                                                       // 40 hdr_uk_id
    S('H.HOUSE_NO'),                                                        // 41 house_no
    S('H.HO_COORDINATOR'),                                                  // 42 ho_coordinator
    S('H.ID_ID'),                                                           // 43 id_id
    S('H.IFSC'),                                                            // 44 ifsc
    S('H.INTEGRATION_ID'),                                                  // 45 integration_id
    S('H.ISACTIVE'),                                                        // 46 isactive
    S('H.LAND_MARK'),                                                       // 47 land_mark
    S("TO_CHAR(H.MA,'YYYY-MM-DD')"),                                        // 48 ma
    S('H.MAIN_HAWKER_ID'),                                                  // 49 main_hawker_id
    S('H.MODIFY_BY'),                                                       // 50 modify_by
    S("TO_CHAR(H.MODIFY_DT,'YYYY-MM-DD HH24:MI:SS')"),                      // 51 modify_dt
    S('H.OLD_CENTER_INCHARGE'),                                             // 52 old_center_incharge
    S('H.OLD_HAWKER_ID'),                                                   // 53 old_hawker_id
    S('H.OTHER_WORK'),                                                      // 54 other_work
    S('H.OWNER_NAME'),                                                      // 55 owner_name
    S('H.PAN_NO'),                                                          // 56 pan_no
    S('H.PHONE_NO'),                                                        // 57 phone_no
    S('H.PIN'),                                                             // 58 pin
    S('H.PRINT_LABEL'),                                                     // 59 print_label
    S('H.REP_CODE'),                                                        // 60 rep_code
    S('H.ROUTE_INCHARGE'),                                                  // 61 route_incharge
    S('H.SAP_ID'),                                                          // 62 sap_id
    S('H.SPOUSE_NAME'),                                                     // 63 spouse_name
    S('H.STALL_COUNT'),                                                     // 64 stall_count
    S('H.STATE'),                                                           // 65 state
    S('H.STATE_CODE'),                                                      // 66 state_code
    S('H.SUB_CENTER'),                                                      // 67 sub_center
    S('H.SUB_HAWKER_ID'),                                                   // 68 sub_hawker_id
    S('H.SUPPORT_STAFF'),                                                   // 69 support_staff
    S('H.TOWN_SUBURB'),                                                     // 70 town_suburb
    S('H.WHATSAPPNO'),                                                      // 71 whatsappno
    S("CIR_GET_UNITNAME(H.LOC_ID)"),                                        // 72 unit_name
    S("(SELECT CENT_NAME FROM CRM_CENTER_MASTER WHERE CENT_ID=H.CENT_ID AND LOC_ID=H.LOC_ID AND ROWNUM=1)"),// 73 hawker_center_name
    S("CIR_GET_EXECUTIVE(H.COMPCODE,H.FIELD_OFFICER)"),                     // 74 field_officer_name
    S("CIR_GET_EXECUTIVE(H.COMPCODE,H.CENTER_INCHARGE)"),                   // 75 center_incharge_name
    S("CIR_GET_EXECUTIVE(H.COMPCODE,H.HO_COORDINATOR)"),                    // 76 ho_coordinator_name
    S("CIR_GET_EXECUTIVE(H.COMPCODE,H.SUPPORT_STAFF)"),                     // 77 support_staff_name
    S("CIR_GET_EXECUTIVE(H.COMPCODE,H.ROUTE_INCHARGE)"),                    // 78 route_incharge_name
  ].join(`\n  || ${D} ||\n  `);

  return `SET PAGESIZE 0
SET LINESIZE 32767
SET LONG 100000
SET FEEDBACK OFF
SET HEADING OFF
SET ECHO OFF
SET VERIFY OFF
SET TRIMSPOOL ON
SET TRIMOUT ON
SET TERMOUT OFF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SPOOL ${spoolEsc}
SELECT ${cols}
FROM CRM_HAWKER_MASTER H${RECENT_ONLY ? `
WHERE H.HAWKER_ID IN (
  SELECT DISTINCT HAWKER_ID
  FROM CRM_HAWKER_DATEWISE_SUPPLY
  WHERE SUPPLY_DATE >= ADD_MONTHS(TRUNC(SYSDATE), -6)
)` : ''}
ORDER BY H.LOC_ID, H.HAWKER_ID;
SPOOL OFF
EXIT
`;
}

// ── sqlplus runner (same dual-driver pattern as all other sync scripts) ───────
const _ora = require('./ora_client');
function runSqlplus(sqlFile) {
  if (_ora.driverAvailable()) return _ora.runViaDriver(sqlFile);
  return _runSqlplusSpawn(sqlFile);
}
function _runSqlplusSpawn(sqlFile) {
  return new Promise((resolve, reject) => {
    const connectStr =
      `${process.env.ORA_USER}/${process.env.ORA_PASSWORD}@//` +
      `${process.env.ORA_HOST}:${process.env.ORA_PORT || 1521}/${process.env.ORA_SERVICE}`;
    const proc = spawn(SQLPLUS, ['-L', '-S', '/nolog'], {
      env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`sqlplus exited ${code}\n${stdout}\n${stderr}`));
    });
    proc.stdin.write(`CONNECT ${connectStr}\n`);
    proc.stdin.write(`@"${sqlFile}"\n`);
    proc.stdin.write('EXIT\n');
    proc.stdin.end();
  });
}

// ── Field mapping (index matches cols array above) ────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const r = String(v).trim();
  return r === '' ? null : r;
}
// Oracle spools numbers as text; anything non-numeric (a stray '-' or 'NA') becomes NULL
// rather than a MySQL truncation warning on a BIGINT column.
function num(v) {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
// Dates arrive pre-formatted as YYYY-MM-DD[ HH:MM:SS]. Oracle holds placeholder years
// (0001, 1900) that MySQL DATE rejects — drop those instead of failing the row.
function dt(v) {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1920 || y > 2100) return null;
  return s;
}

function lineToParams(f) {
  return [
    str(f[0]),          // compcode
    str(f[1]),          // unit_code
    str(f[2]),          // hawker_center_code
    str(f[3]),          // hawker_id
    str(f[4]),          // hawker_name
    str(f[5]),          // mobile_no
    str(f[6]),          // field_officer_code
    str(f[7]),          // center_incharge_code
    str(f[8]),          // catagory
    str(f[9]),          // account_no
    str(f[10]),         // add1_oth_lang
    str(f[11]),         // addr2
    str(f[12]),         // addr3
    str(f[13]),         // addr4
    str(f[14]),         // address_of_bank
    str(f[15]),         // adhar_no
    str(f[16]),         // ag_name
    str(f[17]),         // attatch_photo_fname
    str(f[18]),         // bankname
    str(f[19]),         // bank_acc_type
    str(f[20]),         // bank_branch
    str(f[21]),         // bank_ifse
    str(f[22]),         // bank_name
    num(f[23]),         // beat_boys
    str(f[24]),         // beneficiary_name
    str(f[25]),         // city
    str(f[26]),         // created_by
    dt(f[27]),          // created_dt
    dt(f[28]),          // dateofstart
    str(f[29]),         // distribution_area
    str(f[30]),         // dist_code
    dt(f[31]),          // doa
    dt(f[32]),          // dob
    str(f[33]),         // email
    str(f[34]),         // exist
    str(f[35]),         // father_name
    str(f[36]),         // gender
    str(f[37]),         // hawker_add
    num(f[38]),         // hawker_seq
    str(f[39]),         // hawker_type
    num(f[40]),         // hdr_uk_id
    str(f[41]),         // house_no
    str(f[42]),         // ho_coordinator
    str(f[43]),         // id_id
    str(f[44]),         // ifsc
    str(f[45]),         // integration_id
    str(f[46]),         // isactive
    str(f[47]),         // land_mark
    dt(f[48]),          // ma
    str(f[49]),         // main_hawker_id
    str(f[50]),         // modify_by
    dt(f[51]),          // modify_dt
    str(f[52]),         // old_center_incharge
    str(f[53]),         // old_hawker_id
    str(f[54]),         // other_work
    str(f[55]),         // owner_name
    str(f[56]),         // pan_no
    str(f[57]),         // phone_no
    num(f[58]),         // pin
    str(f[59]),         // print_label
    str(f[60]),         // rep_code
    str(f[61]),         // route_incharge
    str(f[62]),         // sap_id
    str(f[63]),         // spouse_name
    num(f[64]),         // stall_count
    str(f[65]),         // state
    str(f[66]),         // state_code
    str(f[67]),         // sub_center
    str(f[68]),         // sub_hawker_id
    str(f[69]),         // support_staff
    str(f[70]),         // town_suburb
    str(f[71]),         // whatsappno
    str(f[72]),         // unit_name
    str(f[73]),         // hawker_center_name
    str(f[74]),         // field_officer_name
    str(f[75]),         // center_incharge_name
    str(f[76]),         // ho_coordinator_name
    str(f[77]),         // support_staff_name
    str(f[78]),         // route_incharge_name
  ];
}

const COL_LIST = `compcode, unit_code, hawker_center_code, hawker_id, hawker_name, mobile_no,
     field_officer_code, center_incharge_code, catagory, account_no, add1_oth_lang, addr2,
     addr3, addr4, address_of_bank, adhar_no, ag_name, attatch_photo_fname, bankname,
     bank_acc_type, bank_branch, bank_ifse, bank_name, beat_boys, beneficiary_name, city,
     created_by, created_dt, dateofstart, distribution_area, dist_code, doa, dob, email,
     exist, father_name, gender, hawker_add, hawker_seq, hawker_type, hdr_uk_id, house_no,
     ho_coordinator, id_id, ifsc, integration_id, isactive, land_mark, ma, main_hawker_id,
     modify_by, modify_dt, old_center_incharge, old_hawker_id, other_work, owner_name,
     pan_no, phone_no, pin, print_label, rep_code, route_incharge, sap_id, spouse_name,
     stall_count, state, state_code, sub_center, sub_hawker_id, support_staff, town_suburb,
     whatsappno, unit_name, hawker_center_name, field_officer_name, center_incharge_name,
     ho_coordinator_name, support_staff_name, route_incharge_name`;

const N_COLS = COL_LIST.split(',').filter(s => s.trim()).length;

// ── Schema setup ──────────────────────────────────────────────────────────────
async function ensureSchema(conn) {
  await conn.execute(`CREATE TABLE IF NOT EXISTS hawker_master (
    id INT AUTO_INCREMENT PRIMARY KEY,
    compcode VARCHAR(20),
    unit_code VARCHAR(20),
    hawker_center_code VARCHAR(20),
    hawker_id VARCHAR(20),
    hawker_name VARCHAR(160),
    mobile_no VARCHAR(20),
    field_officer_code VARCHAR(20),
    center_incharge_code VARCHAR(20),
    catagory VARCHAR(20),
    account_no VARCHAR(30),
    add1_oth_lang VARCHAR(50),
    addr2 VARCHAR(60),
    addr3 VARCHAR(80),
    addr4 VARCHAR(40),
    address_of_bank VARCHAR(40),
    adhar_no VARCHAR(30),
    ag_name VARCHAR(20),
    attatch_photo_fname VARCHAR(20),
    bankname VARCHAR(20),
    bank_acc_type VARCHAR(20),
    bank_branch VARCHAR(40),
    bank_ifse VARCHAR(20),
    bank_name VARCHAR(40),
    beat_boys BIGINT,
    beneficiary_name VARCHAR(60),
    city VARCHAR(20),
    created_by VARCHAR(20),
    created_dt DATETIME,
    dateofstart DATE,
    distribution_area VARCHAR(200),
    dist_code VARCHAR(20),
    doa DATE,
    dob DATE,
    email VARCHAR(60),
    exist VARCHAR(20),
    father_name VARCHAR(50),
    gender VARCHAR(20),
    hawker_add VARCHAR(140),
    hawker_seq BIGINT,
    hawker_type VARCHAR(20),
    hdr_uk_id BIGINT,
    house_no VARCHAR(20),
    ho_coordinator VARCHAR(20),
    id_id VARCHAR(20),
    ifsc VARCHAR(20),
    integration_id VARCHAR(20),
    isactive VARCHAR(20),
    land_mark VARCHAR(30),
    ma DATE,
    main_hawker_id VARCHAR(20),
    modify_by VARCHAR(20),
    modify_dt DATETIME,
    old_center_incharge VARCHAR(20),
    old_hawker_id VARCHAR(20),
    other_work VARCHAR(70),
    owner_name VARCHAR(50),
    pan_no VARCHAR(30),
    phone_no VARCHAR(20),
    pin BIGINT,
    print_label VARCHAR(20),
    rep_code VARCHAR(20),
    route_incharge VARCHAR(20),
    sap_id VARCHAR(30),
    spouse_name VARCHAR(20),
    stall_count BIGINT,
    state VARCHAR(20),
    state_code VARCHAR(20),
    sub_center VARCHAR(20),
    sub_hawker_id VARCHAR(20),
    support_staff VARCHAR(20),
    town_suburb VARCHAR(20),
    whatsappno VARCHAR(20),
    unit_name VARCHAR(200),
    hawker_center_name VARCHAR(200),
    field_officer_name VARCHAR(200),
    center_incharge_name VARCHAR(200),
    ho_coordinator_name VARCHAR(200),
    support_staff_name VARCHAR(200),
    route_incharge_name VARCHAR(200),
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_seen_at DATETIME,
    UNIQUE KEY uq_hm_hawker (hawker_id),
    INDEX idx_hm_unit    (unit_code),
    INDEX idx_hm_center  (hawker_center_code),
    INDEX idx_hm_fo      (field_officer_code),
    INDEX idx_hm_ci      (center_incharge_code),
    INDEX idx_hm_name    (hawker_name),
    INDEX idx_hm_mobile  (mobile_no)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

  /* Every table this one joins to — hawker_supply, agency_master, supply_data,
     exec_hierarchy_mapping — is utf8mb4_0900_ai_ci. hawker_master was created
     utf8mb4_unicode_ci, so `hm.hawker_id = hs.hawker_id` raised
     ER_CANT_AGGREGATE_2COLLATIONS and no join was possible. Converting is idempotent. */
  const [[tbl]] = await conn.query(
    `SELECT table_collation c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'hawker_master'`);
  if (tbl && tbl.c && tbl.c !== 'utf8mb4_0900_ai_ci') {
    log(`Schema: converting collation ${tbl.c} → utf8mb4_0900_ai_ci so joins work`);
    await conn.query(`ALTER TABLE hawker_master CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  }

  /* CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so widening the sync
     (13 columns → 79) would fail on "Unknown column" against an older install. Diff the
     live table against the definition above and ADD what is missing. This also carries
     the hand-maintained fields that are not in Oracle: they are simply columns the diff
     never sees in the CREATE list, so they are added by hand once and never dropped. */
  const [live] = await conn.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'hawker_master'`);
  const have = new Set(live.map(r => String(r.COLUMN_NAME || r.column_name).toLowerCase()));

  const wanted = [];
  const createSql = ensureSchema.toString();
  const body = createSql.slice(createSql.indexOf('hawker_master ('), createSql.indexOf('synced_at DATETIME'));
  body.split('\n').forEach(line => {
    const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+(VARCHAR\(\d+\)|BIGINT|DATETIME|DATE|TEXT)\s*,?$/i);
    if (m && m[1].toLowerCase() !== 'id') wanted.push([m[1], m[2]]);
  });

  /* Hand-collected survey fields. Oracle has no equivalent, so they are deliberately
     absent from COL_LIST — the daily sync cannot see them and therefore cannot
     overwrite them. Added here so a fresh install has the columns too. */
  const SURVEY_COLS = [
    ['actual_name', 'VARCHAR(160)'],
    ['house_type', 'VARCHAR(20)'],                 // Rented / Self
    ['family_size', 'INT'],
    ['family_in_business', 'INT'],
    ['other_newspaper_copies', 'INT'],
    ['newspapers_carried', 'VARCHAR(60)'],         // e.g. Rp+DB+Other News Paper
    ['income_newspaper', 'INT'],
    ['other_business', 'VARCHAR(80)'],
    ['income_other_business', 'INT'],
    ['total_income', 'INT'],
    ['transport_mode', 'VARCHAR(40)'],
    ['payment_nature', 'VARCHAR(20)'],             // Daily Clear / Defaulter
    ['payment_mode', 'VARCHAR(20)'],               // Online / Cash / Both
    ['copies_self_delivered', 'INT'],
    ['marital_status', 'VARCHAR(20)'],
    ['survey_updated_at', 'DATETIME'],
  ];
  SURVEY_COLS.forEach(c => wanted.push(c));
  // Declared after synced_at in the CREATE above, which is where the parse above stops.
  wanted.push(['last_seen_at', 'DATETIME']);

  const missing = wanted.filter(([n]) => !have.has(n.toLowerCase()));
  if (missing.length) {
    log(`Schema: adding ${missing.length} new column(s) — ${missing.map(m => m[0]).join(', ')}`);
    await conn.query(`ALTER TABLE hawker_master ${missing.map(([n, t]) => `ADD COLUMN ${n} ${t}`).join(', ')}`);
    for (const [idx, col] of [['idx_hm_name', 'hawker_name'], ['idx_hm_mobile', 'mobile_no']]) {
      try { await conn.query(`ALTER TABLE hawker_master ADD INDEX ${idx} (${col})`); } catch (_) {}
    }
  }
}

// ── Parse spool output ────────────────────────────────────────────────────────
function parseSpoolFile(spoolFile) {
  const raw  = fs.readFileSync(spoolFile, 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(SEP);
    if (f.length !== NCOLS) continue;
    rows.push(f);
  }
  return rows;
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync() {
  log(`=== Hawker Master Sync START${DRY_RUN ? ' (DRY RUN)' : ''} ===`);

  // ── Oracle extract ──────────────────────────────────────────────────────────
  const tmpDir   = os.tmpdir();
  const sqlFile  = path.join(tmpDir, `hawker_master_${Date.now()}.sql`);
  const spoolFile= path.join(tmpDir, `hawker_master_${Date.now()}.spool`);

  fs.writeFileSync(sqlFile, buildSqlScript(spoolFile), 'utf8');
  log('Running Oracle query…');
  await runSqlplus(sqlFile);

  const rows = parseSpoolFile(spoolFile);
  log(`Oracle returned ${rows.length} rows`);

  try { fs.unlinkSync(sqlFile); } catch (_) {}
  try { fs.unlinkSync(spoolFile); } catch (_) {}

  if (DRY_RUN) {
    log('Dry run — no DB writes. Done.');
    return { rows: rows.length };
  }

  // ── MySQL load ──────────────────────────────────────────────────────────────
  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    await conn.query("SET time_zone = '+05:30'");
    await ensureSchema(conn);

    await conn.query('START TRANSACTION');

    /* Upsert, never TRUNCATE. hawker_master holds two kinds of column: the ones Oracle
       owns (refreshed here) and hand-collected survey fields Oracle has no idea about —
       family size, income, transport, payment behaviour. A truncate-and-reload would
       silently wipe the hand-entered half every morning, so the daily run may only
       overwrite the columns it is the authority for. Everything else is left alone. */
    const UPDATE_SET = COL_LIST.split(',').map(s => s.trim()).filter(Boolean)
      .filter(c => c !== 'hawker_id')            // the match key never updates itself
      .map(c => `${c} = VALUES(${c})`)
      .concat('last_seen_at = NOW()')
      .join(', ');

    const BATCH = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      // Derived from COL_LIST, never hardcoded — the two drifted apart when the sync
      // widened from 13 columns to 79 and every INSERT failed on the count mismatch.
      const ph    = chunk.map(() => `(${',?'.repeat(N_COLS).slice(1)})`).join(',');
      const vals  = chunk.flatMap(f => lineToParams(f));
      await conn.execute(
        `INSERT INTO hawker_master (${COL_LIST}) VALUES ${ph}
         ON DUPLICATE KEY UPDATE ${UPDATE_SET}`, vals);
      upserted += chunk.length;
    }
    // New rows never pass through ON DUPLICATE KEY, so stamp them too.
    await conn.query('UPDATE hawker_master SET last_seen_at = NOW() WHERE last_seen_at IS NULL');

    await conn.query('COMMIT');

    // Rows Oracle no longer returns are kept — a retired hawker's card must still open —
    // but say how many so a collapsing extract is visible rather than silent.
    const [[stale]] = await conn.query(
      `SELECT COUNT(*) n FROM hawker_master WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)`);
    log(`Upserted ${upserted} rows into hawker_master` +
        (Number(stale.n) ? ` · ${stale.n} row(s) not in this Oracle extract (kept)` : ''));
    return { rows: upserted };
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    await conn.end();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────
if (require.main === module) {
  sync()
    .then(r => { log(`=== Done: ${r.rows} rows ===`); process.exit(0); })
    .catch(e => { log(`ERROR: ${e.message}`); process.exit(1); });
}

module.exports = { sync };
