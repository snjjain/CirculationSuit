'use strict';

/**
 * hierarchy_from_oracle.js — push the Oracle-synced hierarchy into the tables the
 * APPLICATION actually enforces.
 *
 * oracle_exec_hierarchy_sync.js lands the ERP's hierarchy in exec_master /
 * exec_hierarchy_mapping / exec_hierarchy_mast. Nothing reads those for access
 * control. Dashboard scoping (getScopeUnitCodes) reads `hierarchy_mapping`, and the
 * DCR approval chain reads `hierarchy_master` — both of which were populated by the
 * Excel importer. So an ERP hierarchy change synced cleanly into MySQL and still had
 * no effect on who could see what. This closes that gap.
 *
 * The two tables are NOT treated the same, and that asymmetry is the whole point:
 *
 *   hierarchy_mapping  — FULL MIRROR of exec_hierarchy_mapping. Oracle is the only
 *                        author of the reporting chain, blanks included.
 *
 *   hierarchy_master   — MERGE ONLY, never delete. It holds 347 field-executive rows
 *                        created by provision_field_users.js that exist nowhere in
 *                        Oracle; replacing the table would delete their logins and
 *                        their DCR access along with them. New Oracle people are
 *                        added and changed ones updated, on the uq_hm key
 *                        (comp_code, unit_code, person_code) — a person legitimately
 *                        appears once per unit.
 *
 * Both tables are copied to <name>_bak_<YYYYMMDD> before anything is written, and the
 * writes run inside one transaction.
 *
 * Usage:
 *   node api/hierarchy_from_oracle.js            # apply
 *   node api/hierarchy_from_oracle.js --dry-run  # report what would change
 */

const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DRY = process.argv.includes('--dry-run');
const LOG_FILE = path.resolve(__dirname, '../logs/hierarchy_from_oracle.log');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

const s = v => { if (v == null) return null; const r = String(v).trim(); return r || null; };

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    database: process.env.MYSQL_DB, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  });

  log(`=== hierarchy_from_oracle start${DRY ? ' (DRY RUN)' : ''} ===`);

  const [oraMap]  = await conn.query(`SELECT * FROM exec_hierarchy_mapping`);
  const [oraMast] = await conn.query(`SELECT * FROM exec_hierarchy_mast`);
  if (!oraMap.length || !oraMast.length) {
    log('Oracle-synced tables are empty — run oracle_exec_hierarchy_sync.js first. Aborting.');
    await conn.end(); process.exit(1);
  }

  const [[{ mapHave }]]  = await conn.query(`SELECT COUNT(*) mapHave  FROM hierarchy_mapping`);
  const [[{ mastHave }]] = await conn.query(`SELECT COUNT(*) mastHave FROM hierarchy_master`);
  log(`Oracle: ${oraMap.length} mapping, ${oraMast.length} master rows`);
  log(`App   : ${mapHave} hierarchy_mapping, ${mastHave} hierarchy_master rows`);

  /* Same guard the Oracle sync itself now carries: a read that lands mid-bulk-load
     returns a small, perfectly valid result, and mirroring it would wipe live access
     rights. Under half of what is stored is refused. */
  if (mapHave > 0 && oraMap.length < mapHave * 0.5) {
    log(`REFUSED: Oracle holds ${oraMap.length} mapping rows against ${mapHave} stored (under 50%).`);
    await conn.end(); process.exit(1);
  }

  // unit_name is resolved from `units`, the same lookup the Excel importer used.
  const [unitRows] = await conn.query(`SELECT unit_code, unit_name FROM units WHERE unit_name IS NOT NULL`);
  const unitName = {}; unitRows.forEach(r => { unitName[r.unit_code] = r.unit_name; });

  // ── What will change, reported before it is done ──────────────────────────
  const K = r => `${r.unit_code}|${r.exec_code}`;
  const [appMap] = await conn.query(`SELECT unit_code, exec_code, edtn_incharge_code e,
    circ_incharge_code c, zonal_head_code z, vp_circulation_code v FROM hierarchy_mapping`);
  const A = new Map(appMap.map(r => [K(r), r]));
  const chainO = r => [r.edtn_incharge, r.circ_incharge, r.zonal_head, r.vp_circulation].map(x => s(x) || '').join('/');
  const chainA = r => [r.e, r.c, r.z, r.v].map(x => s(x) || '').join('/');
  let added = 0, dropped = 0, changed = 0;
  const seen = new Set();
  oraMap.forEach(r => {
    seen.add(K(r));
    if (!A.has(K(r))) added++;
    else if (chainO(r) !== chainA(A.get(K(r)))) changed++;
  });
  appMap.forEach(r => { if (!seen.has(K(r))) dropped++; });
  log(`hierarchy_mapping: +${added} new, -${dropped} removed, ${changed} chains changed`);

  const MK = r => `${s(r.comp_code) || ''}|${s(r.unit_code) || ''}|${s(r.code || r.person_code) || ''}`;
  const [appMast] = await conn.query(`SELECT comp_code, unit_code, person_code, hierarchy_level, reporting_to FROM hierarchy_master`);
  const AM = new Map(appMast.map(r => [MK(r), r]));
  let mNew = 0, mUpd = 0;
  oraMast.forEach(r => {
    const cur = AM.get(MK(r));
    if (!cur) { mNew++; return; }
    if (String(cur.reporting_to || '') !== String(s(r.reporting_to) || '') ||
        String(cur.hierarchy_level || '') !== String(r.hierarchy_level || '')) mUpd++;
  });
  const untouched = appMast.length - oraMast.filter(r => AM.has(MK(r))).length;
  log(`hierarchy_master : +${mNew} new, ${mUpd} updated, ${untouched} app-only rows left untouched`);

  if (DRY) { log('=== dry run, nothing written ==='); await conn.end(); process.exit(0); }

  // ── Backups ───────────────────────────────────────────────────────────────
  /* Stamped to the minute, and never dropped. A date-only name plus DROP IF EXISTS
     meant the second run of a day overwrote the morning's backup with the data that
     run had just written — the rollback point was destroyed by the act of retrying. */
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  for (const t of ['hierarchy_mapping', 'hierarchy_master']) {
    const bak = `${t}_bak_${stamp}`;
    const [exists] = await conn.query(`SHOW TABLES LIKE ?`, [bak]);
    if (exists.length) { log(`  backup ${bak} already exists — keeping it`); continue; }
    await conn.query(`CREATE TABLE ${bak} AS SELECT * FROM ${t}`);
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) n FROM ${bak}`);
    log(`  backup ${bak}: ${n} rows`);
  }

  await conn.beginTransaction();
  try {
    // ── hierarchy_mapping — full mirror ─────────────────────────────────────
    await conn.execute(`DELETE FROM hierarchy_mapping`);
    const insMap = `INSERT INTO hierarchy_mapping
      (comp_code, unit_code, unit_name, exec_code, exec_name, exec_desig,
       edtn_incharge_code, edtn_incharge_name, circ_incharge_code, circ_incharge_name,
       zonal_head_code, zonal_head_name, vp_circulation_code, vp_circulation_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    for (const r of oraMap) {
      await conn.execute(insMap, [
        s(r.comp_code), s(r.unit_code), unitName[r.unit_code] || null,
        s(r.exec_code), s(r.exec_desc), s(r.exec_desig),
        s(r.edtn_incharge), s(r.edtn_incharge_name),
        s(r.circ_incharge), s(r.circ_incharge_name),
        s(r.zonal_head), s(r.zonal_head_name),
        s(r.vp_circulation), s(r.vp_circulation_name),
      ]);
    }
    log(`  hierarchy_mapping: ${oraMap.length} rows mirrored from Oracle (was ${mapHave})`);

    /* hierarchy_master — merge, never delete: the 347 provisioned field-executive rows
       have no Oracle counterpart and replacing the table would take their logins with
       them.

       The match is done with an explicit NULL-safe lookup rather than ON DUPLICATE KEY.
       uq_hm covers (comp_code, unit_code, person_code), and MySQL treats every NULL in
       a unique index as distinct — so the rows carrying unit_code = NULL matched
       nothing and were appended on each run. Person codes 124 and 145 had quietly
       reached three identical copies apiece that way before this was caught. `<=>` is
       the NULL-safe equality MySQL's unique index will not give us. */
    const findMast = `SELECT id FROM hierarchy_master
       WHERE comp_code <=> ? AND unit_code <=> ? AND person_code <=> ? LIMIT 1`;
    const insMast = `INSERT INTO hierarchy_master
      (comp_code, unit_code, person_code, person_name, hierarchy_code,
       hierarchy_level, reporting_to, is_active, employee_code)
      VALUES (?,?,?,?,?,?,?,?,?)`;
    const updMast = `UPDATE hierarchy_master SET
        person_name = ?, hierarchy_code = ?, hierarchy_level = ?, reporting_to = ?,
        is_active = ?, employee_code = COALESCE(?, employee_code), updated_at = NOW()
      WHERE id = ?`;
    let mi = 0, mu = 0;
    for (const r of oraMast) {
      const key  = [s(r.comp_code), s(r.unit_code), s(r.code)];
      const rest = [s(r.name), s(r.hierarchy_code),
                    r.hierarchy_level == null ? null : Number(r.hierarchy_level),
                    s(r.reporting_to), s(r.is_active_pli) === 'Y' ? 1 : 0, s(r.employee_id)];
      const [hit] = await conn.execute(findMast, key);
      if (hit.length) { await conn.execute(updMast, [...rest, hit[0].id]); mu++; }
      else            { await conn.execute(insMast, [...key, ...rest]); mi++; }
    }
    log(`  hierarchy_master: ${mi} inserted, ${mu} updated (was ${mastHave})`);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    log(`FAILED — rolled back, both tables unchanged: ${e.message}`);
    await conn.end(); process.exit(1);
  }

  const [[{ m1 }]] = await conn.query(`SELECT COUNT(*) m1 FROM hierarchy_mapping`);
  const [[{ m2 }]] = await conn.query(`SELECT COUNT(*) m2 FROM hierarchy_master`);
  log(`Final: hierarchy_mapping ${m1}, hierarchy_master ${m2}`);
  log('=== hierarchy_from_oracle complete ===');
  await conn.end();
  process.exit(0);
})().catch(e => { log('ERROR: ' + e.message); process.exit(1); });
