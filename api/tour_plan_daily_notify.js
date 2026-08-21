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

function telegramText(v, inchargeName) {
  const L = [];
  L.push(`🗞 राजस्थान पत्रिका — टूर प्लान AI ऑडिट`);
  L.push(`प्रिय ${inchargeName},`);
  L.push(`कार्यकारी: ${v.exec_name} (${v.unit_name}) · दिनांक: ${v.date}`);
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
    onLog(`[tour-plan-notify] Computing verdicts for ${date}…`);
    const verdicts = await computeVerdictsForDate(q, date);
    onLog(`[tour-plan-notify] ${verdicts.length} executive(s) with a submitted plan`);

    let notified = 0, skipped = 0, failed = 0;
    for (const v of verdicts) {
      const actionable = v.missing.length > 0 || v.nearby_gaps.length > 0;
      if (!actionable) { skipped++; continue; }

      const incharge = await resolveIncharge(conn, v.exec_name);
      if (!incharge) {
        onLog(`  [skip] ${v.exec_name}: no Circulation Incharge found in exec_hierarchy_mapping`);
        skipped++; continue;
      }

      if (dryRun) {
        onLog(`  [dry-run] would notify ${incharge.name} about ${v.exec_name}'s plan (${v.missing.length} missing, ${v.nearby_gaps.length} nearby gaps)`);
        continue;
      }

      const text = telegramText(v, incharge.name);
      let sentAny = false;
      if (incharge.mobile) {
        const tg = await sendTelegram(conn, incharge.mobile, text);
        if (tg.ok) { sentAny = true; onLog(`  [telegram] sent to ${incharge.name} (re: ${v.exec_name})`); }
        else onLog(`  [telegram] failed for ${incharge.name}: ${tg.reason}`);
      }
      if (incharge.email) {
        const em = await sendEmail(incharge.email, `टूर प्लान AI ऑडिट — ${v.exec_name} (${v.date})`, text);
        if (em.ok) { sentAny = true; onLog(`  [email] sent to ${incharge.email} (re: ${v.exec_name})`); }
      }
      if (sentAny) notified++; else failed++;
    }
    onLog(`[tour-plan-notify] Complete — notified: ${notified}, skipped(no action/no incharge): ${skipped}, failed: ${failed}`);
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
