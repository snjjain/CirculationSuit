'use strict';
/**
 * tour_plan_daily_notify.js — Daily Tour Plan AI audit → Circulation Incharge
 *
 * Runs standalone (no dependency on the Express API being up — same
 * convention as every other cron script in this codebase): connects to
 * MySQL and Telegram/SMTP directly, computes today's tour-plan verdicts via
 * tour_plan_validate.js, and pushes the Hindi verdict to each executive's
 * Circulation Incharge (Telegram if linked, email as a fallback/addition) —
 * never to the executive or an admin. Only sends when there's something
 * actionable (missing agencies or a nearby-agency gap); a plan that's
 * already correct stays silent so incharges aren't spammed daily.
 *
 * Scheduled 10:00–12:00 IST every 30 min (install_cron_linux.sh) — plans
 * trickle in through the morning, so a single 10am run would miss late
 * submissions.
 *
 * Usage:
 *   node api/tour_plan_daily_notify.js                # today
 *   node api/tour_plan_daily_notify.js --date 2026-08-22
 *   node api/tour_plan_daily_notify.js --dry-run       # compute + log, don't send
 */

const mysql = require('mysql2/promise');
const path  = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { computeVerdictsForDate } = require('./tour_plan_validate');
const { ensureTable: ensureTourPlanTable } = require('./oracle_tour_plan_sync');

const MYSQL_CFG = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  database: process.env.MYSQL_DB       || 'patrika_vitran',
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  charset:  'utf8mb4',
};

// ── Standalone Telegram sender (mirrors telegram.js's sendTG, independent of
//    the running API so this cron works even if the server is down) ────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_API   = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : '';
async function sendTelegram(conn, mobile, text) {
  if (!TG_API || !mobile) return { ok: false, reason: 'not_configured' };
  const norm = String(mobile).replace(/\D/g, '').slice(-10);
  const [rows] = await conn.query('SELECT chat_id FROM telegram_users WHERE mobile = ? LIMIT 1', [norm]);
  if (!rows.length) return { ok: false, reason: 'not_linked' };
  const r = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: rows[0].chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  const d = await r.json();
  return { ok: !!d.ok, reason: d.ok ? null : (d.description || 'send_failed') };
}

// ── Standalone email sender (mirrors insights.js's send-email endpoint) ─────
async function sendEmail(to, subject, body) {
  const SMTP_HOST = process.env.SMTP_HOST, SMTP_USER = process.env.SMTP_USER;
  if (!SMTP_HOST || !SMTP_USER || !to) return { ok: false, reason: 'not_configured' };
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    auth: { user: SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  const from = `"${process.env.SMTP_FROM_NAME || 'Patrika Vitran'}" <${process.env.SMTP_FROM_EMAIL || SMTP_USER}>`;
  await transporter.sendMail({ from, to, subject, text: body });
  return { ok: true };
}

// ── Resolve an executive's Circulation Incharge (name-matched — DCR emp_code
//    and PLI exec_code live in different ID spaces throughout this codebase,
//    so every cross-lookup here goes by executive display name, same as
//    dcr_analytics.js's next-day-plan/team-plan) ────────────────────────────
async function resolveIncharge(conn, execName) {
  const [rows] = await conn.query(
    `SELECT circ_incharge, circ_incharge_name FROM exec_hierarchy_mapping WHERE exec_desc = ? LIMIT 1`,
    [execName]);
  if (!rows.length || !rows[0].circ_incharge) return null;
  const { circ_incharge, circ_incharge_name } = rows[0];
  const [em] = await conn.query(
    `SELECT mobile_no, email_id FROM exec_master WHERE executive_code = ? LIMIT 1`, [circ_incharge]);
  return {
    code: circ_incharge, name: circ_incharge_name || circ_incharge,
    mobile: em[0]?.mobile_no || null, email: em[0]?.email_id || null,
  };
}

// The executive who owns the territory is the one who can act on this, so they are
// addressed directly; the Circulation Incharge gets the same audit for oversight.
// NOTE: exec_master.mobile_no / email_id are empty for all 269 active executives in
// the current Oracle sync, so this almost always falls through to app_users — the only
// place executive contact details actually exist today. Until those numbers are filled
// in (in either source) the executive copy cannot be delivered; runNotify logs that
// explicitly rather than failing quietly.
async function resolveExecutive(conn, execName) {
  const [em] = await conn.query(
    `SELECT executive_code, mobile_no, email_id FROM exec_master
     WHERE executive_desc = ? AND is_active_pli = 'Y' ORDER BY exec_designation='EXEC' DESC LIMIT 1`,
    [execName]);
  let mobile = em[0]?.mobile_no || null, email = em[0]?.email_id || null;
  if (!mobile && !email) {
    const [au] = await conn.query(
      `SELECT mobile, email FROM app_users
       WHERE UPPER(TRIM(name)) = UPPER(TRIM(?)) AND is_active = 1 LIMIT 1`, [execName]);
    mobile = au[0]?.mobile || null;
    email  = au[0]?.email  || null;
  }
  if (!em.length && !mobile && !email) return null;
  return { code: em[0]?.executive_code || null, name: execName, mobile, email };
}

function telegramText(v, toName, forSelf) {
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — टूर प्लान AI ऑडिट`);
  L.push(`प्रिय ${toName},`);
  L.push(forSelf
    ? `दिनांक: ${v.date} · ${v.unit_name}`
    : `कार्यकारी: ${v.exec_name} (${v.unit_name}) · दिनांक: ${v.date}`);
  L.push(`आपके प्लान में ${v.submitted_count} एजेंसी — प्राथमिकता मिलान ${v.overlap_pct}%`);
  L.push('');
  L.push(v.hindi_message);
  return L.join('\n');
}

async function runNotify(opts = {}) {
  const onLog = opts.onLog || (s => console.log(s));
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const dryRun = !!opts.dryRun;

  const conn = await mysql.createConnection(MYSQL_CFG);
  const q = async (sql, params) => { const [rows] = await conn.query(sql, params); return { rows }; };

  try {
    await ensureTourPlanTable(conn);   // create table if first run
    onLog(`[tour-plan-notify] Computing verdicts for ${date}…`);
    const verdicts = await computeVerdictsForDate(q, date);
    onLog(`[tour-plan-notify] ${verdicts.length} executive(s) with a submitted plan`);

    let notified = 0, skipped = 0, failed = 0, noExecContact = 0;
    for (const v of verdicts) {
      const actionable = v.missing.length > 0 || v.nearby_gaps.length > 0;
      if (!actionable) { skipped++; continue; }

      // Executive first — it is their plan and their route to change. Incharge still
      // gets a copy so the shortfall is visible up the line.
      const executive = await resolveExecutive(conn, v.exec_name);
      const incharge  = await resolveIncharge(conn, v.exec_name);
      if (!executive && !incharge) {
        onLog(`  [skip] ${v.exec_name}: no contact found in exec_master or exec_hierarchy_mapping`);
        skipped++; continue;
      }

      if (dryRun) {
        onLog(`  [dry-run] ${v.exec_name} (${v.missing.length} missing, ${v.nearby_gaps.length} nearby, route "${v.route_label || '—'}") -> exec:${executive ? (executive.mobile || 'no-mobile') : 'none'} incharge:${incharge ? incharge.name : 'none'}`);
        continue;
      }

      let sentAny = false;
      const targets = [];
      if (executive && (executive.mobile || executive.email)) targets.push({ who: executive, self: true });
      else noExecContact++;
      if (incharge)  targets.push({ who: incharge,  self: false });

      for (const { who, self } of targets) {
        const text = telegramText(v, who.name, self);
        if (who.mobile) {
          const tg = await sendTelegram(conn, who.mobile, text);
          if (tg.ok) { sentAny = true; onLog(`  [telegram] sent to ${self ? 'executive' : 'incharge'} ${who.name} (re: ${v.exec_name})`); }
          else onLog(`  [telegram] failed for ${who.name}: ${tg.reason}`);
        }
        if (who.email) {
          const em = await sendEmail(who.email, `टूर प्लान AI ऑडिट — ${v.exec_name} (${v.date})`, text);
          if (em.ok) { sentAny = true; onLog(`  [email] sent to ${who.email} (re: ${v.exec_name})`); }
        }
      }
      if (sentAny) notified++; else failed++;
    }
    if (noExecContact) {
      onLog(`[tour-plan-notify] NOTE: ${noExecContact} executive(s) had no mobile/email on record, so only their Incharge was alerted. Executive alerts need exec_master.mobile_no (currently empty for all 269 active execs) or a matching app_users row, plus that number linked in Telegram.`);
    }
    onLog(`[tour-plan-notify] Complete — notified: ${notified}, skipped(no action/no contact): ${skipped}, failed: ${failed}`);
    return { date, total: verdicts.length, notified, skipped, failed };
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  const di = args.indexOf('--date'); if (di >= 0) opts.date = args[di + 1];
  if (args.includes('--dry-run')) opts.dryRun = true;
  runNotify(opts)
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { runNotify };
