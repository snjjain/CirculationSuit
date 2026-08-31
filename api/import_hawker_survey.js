'use strict';

/**
 * import_hawker_survey.js — hand-collected hawker fields → hawker_master
 *
 * These columns have no Oracle equivalent (family size, income, transport,
 * payment behaviour, the hawker's actual name). They live in hawker_master
 * alongside the Oracle columns but are deliberately outside the daily sync's
 * COL_LIST, so oracle_hawker_master_sync.js upserts around them and never
 * overwrites what was collected in the field.
 *
 * Usage:
 *   node api/import_hawker_survey.js "Input Reports/HawkerMaster_Additional.xlsx"
 *   node api/import_hawker_survey.js <file> --dry-run
 *   node api/import_hawker_survey.js <file> --sheet "Sheet1"
 *
 * Re-runnable: matches on hawker_id and overwrites only the survey columns,
 * so a corrected sheet can simply be imported again.
 */

const path  = require('path');
const XLSX  = require('xlsx');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FILE    = args.find(a => !a.startsWith('--')) ||
  path.resolve(__dirname, '../Input Reports/HawkerMaster_Additional.xlsx');
const SHEET   = args.find((_, i) => args[i - 1] === '--sheet');

const MYSQL_CONFIG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
};

/* Spreadsheet header → MySQL column. Headers are matched loosely (case, spacing and
   punctuation collapsed) because these sheets are hand-made: "Famaliy Size" is the
   spelling in the source file, and the double space in "Daily Clear/  Defaulter" is
   real. Matching on a normalised key means a corrected header still lands. */
const FIELD_MAP = [
  ['hawkerid',                            'hawker_id',              'key'],
  ['hawkernameactual',                    'actual_name',            'str'],
  ['houserentedorself',                   'house_type',             'str'],
  ['famaliysize',                         'family_size',            'int'],
  ['familysize',                          'family_size',            'int'],
  ['howmanyfamilymemberinsamebusiness',   'family_in_business',     'int'],
  ['othernewspaper',                      'other_newspaper_copies', 'int'],
  ['totalnewspaper',                      'newspapers_carried',     'str'],
  ['incomefromnewspaper',                 'income_newspaper',       'int'],
  ['otherbusiness',                       'other_business',         'str'],
  ['incomefromotherbusiness',             'income_other_business',  'int'],
  ['totalincome',                         'total_income',           'int'],
  ['modesoftransport',                    'transport_mode',         'str'],
  ['paymentnaturedailycleardefaulter',    'payment_nature',         'str'],
  ['paymentmodeonlinecash',               'payment_mode',           'str'],
  ['numberofcopiesbyhimself',             'copies_self_delivered',  'int'],
  ['maritalstatus',                       'marital_status',         'str'],
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const str  = v => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
const int  = v => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s.replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

async function run() {
  const wb    = XLSX.readFile(FILE);
  const sheet = SHEET || wb.SheetNames[0];
  if (!wb.Sheets[sheet]) throw new Error(`Sheet "${sheet}" not found. Have: ${wb.SheetNames.join(', ')}`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
  console.log(`[survey] ${path.basename(FILE)} · sheet "${sheet}" · ${rows.length} rows`);

  // Resolve this sheet's headers against the map once.
  const headers = Object.keys(rows[0] || {});
  const resolved = [];
  const unmapped = [];
  headers.forEach(h => {
    const hit = FIELD_MAP.find(([key]) => key === norm(h));
    if (hit) resolved.push({ header: h, col: hit[1], kind: hit[2] });
    else if (str(h) && !/^__empty/i.test(h)) unmapped.push(h);
  });
  const keyField = resolved.find(r => r.kind === 'key');
  if (!keyField) throw new Error('No HAWKER_ID column found in the sheet');
  const dataFields = resolved.filter(r => r.kind !== 'key');
  console.log(`[survey] mapped ${dataFields.length} field(s): ${dataFields.map(f => f.col).join(', ')}`);
  if (unmapped.length) console.log(`[survey] ignored column(s): ${unmapped.join(', ')}`);

  const conn = await mysql.createConnection(MYSQL_CONFIG);
  try {
    // Which ids actually exist — reported rather than silently dropped, since an id the
    // master does not know is usually a typo in the sheet, not a new hawker.
    const ids = [...new Set(rows.map(r => str(r[keyField.header])).filter(Boolean))];
    if (!ids.length) throw new Error('No hawker ids in the sheet');
    const [known] = await conn.query(
      `SELECT hawker_id FROM hawker_master WHERE hawker_id IN (${ids.map(() => '?').join(',')})`, ids);
    const have = new Set(known.map(r => String(r.hawker_id).toUpperCase()));
    const missing = ids.filter(i => !have.has(i.toUpperCase()));

    console.log(`[survey] ${ids.length} unique id(s) · ${ids.length - missing.length} matched · ${missing.length} not in master`);
    if (missing.length) console.log(`[survey] unmatched: ${missing.join(', ')}`);

    if (DRY_RUN) { console.log('[survey] dry run — nothing written'); return; }

    const setSql = dataFields.map(f => `${f.col} = ?`).join(', ');
    let updated = 0, skipped = 0;
    for (const r of rows) {
      const id = str(r[keyField.header]);
      if (!id || !have.has(id.toUpperCase())) { skipped++; continue; }
      const vals = dataFields.map(f => (f.kind === 'int' ? int(r[f.header]) : str(r[f.header])));
      const [res] = await conn.execute(
        `UPDATE hawker_master SET ${setSql}, survey_updated_at = NOW() WHERE hawker_id = ?`,
        [...vals, id]);
      if (res.affectedRows) updated++;
    }
    console.log(`[survey] updated ${updated} hawker(s) · skipped ${skipped}`);

    const [[c]] = await conn.query(
      `SELECT COUNT(*) n FROM hawker_master WHERE survey_updated_at IS NOT NULL`);
    console.log(`[survey] hawkers now carrying survey data: ${c.n}`);
  } finally {
    await conn.end();
  }
}

run().then(() => process.exit(0))
     .catch(e => { console.error('[survey] ERROR:', e.message); process.exit(1); });
