'use strict';

/**
 * Patrika Vitran — AI Insights & Action Center
 *
 * Rule-based decision-support engine. Every insight is computed from live
 * database values (metric + change + reason + impact + recommended action).
 * No generic text: numbers, unit names and agency lists come from SQL.
 *
 * Registered by server.js:  require('./insights')(ctx)
 * ctx = { app, q, getScopeUnitCodes, getOuScopeFilter, getColScopeFilter, scopeToTaxiNames }
 */

module.exports = function registerInsights(ctx) {
  const { app, q, getScopeUnitCodes, getOuScopeFilter, getColScopeFilter, scopeToTaxiNames } = ctx;

  // ── Tables ──────────────────────────────────────────────────────────────────
  ;(async () => {
    await q(`CREATE TABLE IF NOT EXISTS unit_email_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      unit_code   VARCHAR(10)  NOT NULL,
      unit_name   VARCHAR(150),
      role_label  VARCHAR(50)  DEFAULT 'Zonal Head',
      person_name VARCHAR(150),
      email       VARCHAR(200) NOT NULL,
      mobile      VARCHAR(15),
      is_active   TINYINT(1)   DEFAULT 1,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_unit_role_email (unit_code, role_label, email)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS action_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      insight_key VARCHAR(100),
      module      VARCHAR(30),
      title       VARCHAR(300),
      detail      TEXT,
      priority    VARCHAR(10),
      unit_code   VARCHAR(10),
      unit_name   VARCHAR(150),
      assigned_to VARCHAR(150),
      action_type VARCHAR(30),
      channel_meta TEXT,
      status      VARCHAR(20) DEFAULT 'open',
      created_by  VARCHAR(150),
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME NULL,
      resolved_by VARCHAR(150),
      KEY idx_status (status), KEY idx_insight (insight_key)
    )`);
  })().catch(e => console.warn('[insights] table init:', e.message));

  // ── Formatting helpers ──────────────────────────────────────────────────────
  const N = v => Number(v) || 0;
  function fmtINR(n) {
    n = N(n);
    const abs = Math.abs(n);
    if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    return `₹${Math.round(n).toLocaleString('en-IN')}`;
  }
  function pctChange(cur, prev) {
    if (!prev) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  }
  const fmtPct = p => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

  // ── Insight cache (per scope, 10 min) ───────────────────────────────────────
  const cache = new Map();
  const CACHE_MS = 10 * 60 * 1000;

  // ══ Analyses ═════════════════════════════════════════════════════════════════
  // Each returns an array of insight objects (possibly empty), or throws.
  // Insight: { id, module, priority(P1|P2|P3), severity(high|med|low), title,
  //            what, why, impact, next, metrics, top[], targets[], drill }

  async function aOutstandingMoM(sc) {
    const out = [];
    const labR = await q(`SELECT DISTINCT period_label FROM agency_outstanding WHERE period_label != 'CURRENT' ORDER BY period_label`);
    const labels = labR.rows.map(r => r.period_label);
    if (!labels.length) return out;
    const prevM = labels[labels.length - 1];

    const totR = await q(`
      SELECT period_label, SUM(CASE WHEN cl_amt > 0 THEN cl_amt ELSE 0 END) os,
             SUM(CASE WHEN cl_amt >= 100000 THEN cl_amt ELSE 0 END) critical_os,
             SUM(CASE WHEN CAST(dp_code AS UNSIGNED) = 1 AND cl_amt >= 100000 THEN 1 ELSE 0 END) critical_cnt
      FROM agency_outstanding WHERE period_label IN (?, 'CURRENT') ${sc.clause}
      GROUP BY period_label`, [prevM, ...sc.params]);
    const cur  = totR.rows.find(r => r.period_label === 'CURRENT');
    const prev = totR.rows.find(r => r.period_label === prevM);
    if (!cur) return out;
    const curOS = N(cur.os), prevOS = prev ? N(prev.os) : 0;
    const delta = curOS - prevOS;
    const pc = pctChange(curOS, prevOS);

    const unitR = await q(`
      SELECT unit_name, unit_code,
             SUM(CASE WHEN period_label = 'CURRENT' AND cl_amt > 0 THEN cl_amt ELSE 0 END) cur_os,
             SUM(CASE WHEN period_label = ? AND cl_amt > 0 THEN cl_amt ELSE 0 END) prev_os
      FROM agency_outstanding WHERE period_label IN (?, 'CURRENT') ${sc.clause}
      GROUP BY unit_code, unit_name
      ORDER BY (SUM(CASE WHEN period_label='CURRENT' AND cl_amt>0 THEN cl_amt ELSE 0 END)
              - SUM(CASE WHEN period_label=? AND cl_amt>0 THEN cl_amt ELSE 0 END)) DESC
      LIMIT 5`, [prevM, prevM, ...sc.params, prevM]);
    const risers = unitR.rows.map(r => ({ ...r, delta: N(r.cur_os) - N(r.prev_os) })).filter(r => r.delta > 0);
    const riseSum = risers.reduce((s, r) => s + r.delta, 0);

    if (delta > 0 && (pc == null || pc > 0.5 || delta > 1e6)) {
      out.push({
        id: 'os_mom_rise', module: 'outstanding',
        priority: delta > 2e7 ? 'P1' : 'P2', severity: delta > 2e7 ? 'high' : 'medium',
        title: `Outstanding up ${fmtINR(delta)} since ${prevM}`,
        what: `Total outstanding rose from ${fmtINR(prevOS)} (${prevM}) to ${fmtINR(curOS)} now (${fmtPct(pc)}).`,
        why: risers.length
          ? `Top contributors: ${risers.slice(0, 3).map(r => `${r.unit_name} +${fmtINR(r.delta)}`).join(', ')}` +
            (delta > 0 && riseSum > 0 ? ` — together ${Math.min(100, Math.round(riseSum / delta * 100))}% of the increase.` : '.')
          : 'Increase is spread across many units.',
        impact: `${fmtINR(delta)} additional working capital blocked. Critical (≥₹1L) agencies now hold ${fmtINR(cur.critical_os)} across ${N(cur.critical_cnt)} agencies.`,
        next: `Review the top ${Math.min(3, risers.length)} rising units with their Zonal Heads and set a recovery target for the current month.`,
        metrics: { cur_os: curOS, prev_os: prevOS, delta, pct: pc },
        top: risers.map(r => ({ label: r.unit_name, unit_code: r.unit_code, value: r.delta, text: `+${fmtINR(r.delta)} (now ${fmtINR(r.cur_os)})` })),
        targets: risers.map(r => ({ unit_code: r.unit_code, unit_name: r.unit_name })),
        drill: 'outstanding',
      });
    }
    return out;
  }

  async function aStoppedSupplyOS(sc) {
    const r = await q(`
      SELECT COUNT(*) n, SUM(cl_amt) os_sum
      FROM agency_outstanding
      WHERE period_label='CURRENT' AND cl_amt > 0 AND CAST(dp_code AS UNSIGNED) = 1
        AND (last_supply_date IS NULL OR DATEDIFF(CURDATE(), last_supply_date) > 30) ${sc.clause}`, sc.params);
    const d = r.rows[0];
    if (!d || !N(d.n)) return [];
    const topR = await q(`
      SELECT ag_code, ag_name, unit_name, unit_code, cl_amt, last_supply_date, zh_name, exec_name, mobno
      FROM agency_outstanding
      WHERE period_label='CURRENT' AND cl_amt > 0 AND CAST(dp_code AS UNSIGNED) = 1
        AND (last_supply_date IS NULL OR DATEDIFF(CURDATE(), last_supply_date) > 30) ${sc.clause}
      ORDER BY cl_amt DESC LIMIT 10`, sc.params);
    const os = N(d.os_sum);
    return [{
      id: 'os_stopped_supply', module: 'outstanding',
      priority: os > 5e6 ? 'P1' : 'P2', severity: os > 5e6 ? 'high' : 'medium',
      title: `${N(d.n)} closed/stopped agencies still owe ${fmtINR(os)}`,
      what: `${N(d.n)} agencies with no supply in the last 30+ days carry ${fmtINR(os)} outstanding.`,
      why: `Supply stopped but dues were not recovered before closure. Largest: ${topR.rows.slice(0, 3).map(a => `${a.ag_name} (${a.unit_name}) ${fmtINR(a.cl_amt)}`).join('; ')}.`,
      impact: `${fmtINR(os)} at high risk of becoming bad debt — recovery gets harder the longer supply stays stopped.`,
      next: `Issue recovery notices to the top 10 listed agencies and review security deposits held against their balances.`,
      metrics: { count: N(d.n), os },
      top: topR.rows.map(a => ({
        label: a.ag_name, unit_code: a.unit_code, value: N(a.cl_amt),
        text: `${a.ag_name} — ${a.unit_name} — ${fmtINR(a.cl_amt)} (last supply ${a.last_supply_date || 'N/A'})`,
        mobile: a.mobno, exec: a.exec_name, zh: a.zh_name,
      })),
      targets: [...new Map(topR.rows.map(a => [a.unit_code, { unit_code: a.unit_code, unit_name: a.unit_name }])).values()],
      drill: 'outstanding',
    }];
  }

  async function aCollectionTrend(scCol, scOu) {
    const out = [];
    const mR = await q(`SELECT MAX(coll_date) mx FROM agency_collection WHERE 1=1 ${scCol.clause}`, scCol.params);
    const asOf = mR.rows[0] && mR.rows[0].mx;
    if (!asOf) return out;

    const trendR = await q(`
      SELECT
        SUM(CASE WHEN coll_date > DATE_SUB(?, INTERVAL 30 DAY) THEN amount ELSE 0 END) cur30,
        SUM(CASE WHEN coll_date <= DATE_SUB(?, INTERVAL 30 DAY) AND coll_date > DATE_SUB(?, INTERVAL 60 DAY) THEN amount ELSE 0 END) prev30
      FROM agency_collection WHERE coll_date <= ? ${scCol.clause}`,
      [asOf, asOf, asOf, asOf, ...scCol.params]);
    const t = trendR.rows[0] || {};
    const cur30 = N(t.cur30), prev30 = N(t.prev30);
    const pc = pctChange(cur30, prev30);

    if (prev30 > 0 && pc != null && pc < -5) {
      const brR = await q(`
        SELECT branch_name, zonal_head,
          SUM(CASE WHEN coll_date > DATE_SUB(?, INTERVAL 30 DAY) THEN amount ELSE 0 END) cur30,
          SUM(CASE WHEN coll_date <= DATE_SUB(?, INTERVAL 30 DAY) AND coll_date > DATE_SUB(?, INTERVAL 60 DAY) THEN amount ELSE 0 END) prev30
        FROM agency_collection WHERE coll_date <= ? ${scCol.clause}
        GROUP BY branch_name, zonal_head
        HAVING prev30 > cur30 ORDER BY (prev30 - cur30) DESC LIMIT 5`,
        [asOf, asOf, asOf, asOf, ...scCol.params]);
      const declSum = brR.rows.reduce((s, b) => s + (N(b.prev30) - N(b.cur30)), 0);
      const totDecl = prev30 - cur30;
      out.push({
        id: 'col_decline', module: 'collection',
        priority: pc < -15 ? 'P1' : 'P2', severity: pc < -15 ? 'high' : 'medium',
        title: `Collection down ${fmtPct(pc)} over last 30 days`,
        what: `Collections in the 30 days ending ${asOf} were ${fmtINR(cur30)} vs ${fmtINR(prev30)} in the previous 30 days (${fmtINR(cur30 - prev30)}).`,
        why: brR.rows.length
          ? `Biggest declines: ${brR.rows.slice(0, 3).map(b => `${b.branch_name} −${fmtINR(N(b.prev30) - N(b.cur30))}`).join(', ')}` +
            (totDecl > 0 ? ` — ${Math.min(100, Math.round(declSum / totDecl * 100))}% of the total decline.` : '.')
          : 'Decline is spread across branches.',
        impact: `${fmtINR(prev30 - cur30)}/month lower cash inflow if the trend continues.`,
        next: `Ask the Zonal Heads of the top declining branches for a branch-wise recovery plan this week.`,
        metrics: { cur30, prev30, pct: pc, as_of: asOf },
        top: brR.rows.map(b => ({ label: b.branch_name, value: N(b.prev30) - N(b.cur30), text: `${b.branch_name} (${b.zonal_head || 'ZH N/A'}): ${fmtINR(b.cur30)} vs ${fmtINR(b.prev30)}` })),
        targets: [],
        drill: 'collection',
      });
    }

    // Agencies with outstanding but no payment in last 15 days
    const npR = await q(`
      SELECT COUNT(*) n, SUM(ao.cl_amt) os_sum
      FROM agency_outstanding ao
      WHERE ao.period_label='CURRENT' AND ao.cl_amt > 10000 AND CAST(ao.dp_code AS UNSIGNED) = 1 ${scOu.clause}
        AND NOT EXISTS (
          SELECT 1 FROM agency_collection ac
          WHERE ac.ag_code = ao.ag_code AND ac.coll_date > DATE_SUB(?, INTERVAL 15 DAY))`,
      [...scOu.params, asOf]);
    const np = npR.rows[0];
    if (np && N(np.n) > 0) {
      const topR = await q(`
        SELECT ao.ag_code, ao.ag_name, ao.unit_name, ao.unit_code, ao.cl_amt, ao.zh_name, ao.exec_name, ao.mobno
        FROM agency_outstanding ao
        WHERE ao.period_label='CURRENT' AND ao.cl_amt > 10000 AND CAST(ao.dp_code AS UNSIGNED) = 1 ${scOu.clause}
          AND NOT EXISTS (
            SELECT 1 FROM agency_collection ac
            WHERE ac.ag_code = ao.ag_code AND ac.coll_date > DATE_SUB(?, INTERVAL 15 DAY))
        ORDER BY ao.cl_amt DESC LIMIT 10`, [...scOu.params, asOf]);
      out.push({
        id: 'col_silent_agencies', module: 'collection',
        priority: N(np.os_sum) > 1e7 ? 'P1' : 'P2', severity: N(np.os_sum) > 1e7 ? 'high' : 'medium',
        title: `${N(np.n)} agencies made no payment in 15 days (OS ${fmtINR(np.os_sum)})`,
        what: `${N(np.n)} agencies holding outstanding above ₹10,000 have made zero payments in the 15 days up to ${asOf}. Combined outstanding: ${fmtINR(np.os_sum)}.`,
        why: `Largest silent agencies: ${topR.rows.slice(0, 3).map(a => `${a.ag_name} (${a.unit_name}) ${fmtINR(a.cl_amt)}`).join('; ')}.`,
        impact: `${fmtINR(np.os_sum)} receivables are ageing without any inflow — each 30 days of silence sharply lowers recovery probability.`,
        next: `Field executives should contact the top 10 listed agencies this week; escalate non-responders to the unit Zonal Head.`,
        metrics: { count: N(np.n), os: N(np.os_sum), as_of: asOf },
        top: topR.rows.map(a => ({
          label: a.ag_name, unit_code: a.unit_code, value: N(a.cl_amt),
          text: `${a.ag_name} — ${a.unit_name} — ${fmtINR(a.cl_amt)} — Exec: ${a.exec_name || 'N/A'}`,
          mobile: a.mobno, exec: a.exec_name, zh: a.zh_name,
        })),
        targets: [...new Map(topR.rows.map(a => [a.unit_code, { unit_code: a.unit_code, unit_name: a.unit_name }])).values()],
        drill: 'collection',
      });
    }
    return out;
  }

  async function aShortPayment(sc) {
    // Agencies whose outstanding grew ≥ 25% and ≥ ₹50k over the last 3 monthly snapshots
    const labR = await q(`SELECT DISTINCT period_label FROM agency_outstanding WHERE period_label != 'CURRENT' ORDER BY period_label`);
    const labels = labR.rows.map(r => r.period_label);
    if (labels.length < 3) return [];
    const to = labels[labels.length - 1], from = labels[labels.length - 3];
    const r = await q(`
      SELECT ag_code, unit_code,
             MAX(ag_name) ag_name, MAX(unit_name) unit_name, MAX(zh_name) zh_name, MAX(mobno) mobno,
             SUM(CASE WHEN period_label = ? THEN cl_amt ELSE 0 END) os_from,
             SUM(CASE WHEN period_label = ? THEN cl_amt ELSE 0 END) os_to
      FROM agency_outstanding
      WHERE period_label IN (?, ?) AND CAST(dp_code AS UNSIGNED) = 1 ${sc.clause}
      GROUP BY unit_code, ag_code
      HAVING os_to - os_from >= 50000 AND os_from >= 0 AND (os_from = 0 OR (os_to - os_from) / os_from >= 0.25)
      ORDER BY (os_to - os_from) DESC LIMIT 50`, [from, to, from, to, ...sc.params]);
    if (!r.rows.length) return [];
    const growth = r.rows.reduce((s, a) => s + (N(a.os_to) - N(a.os_from)), 0);
    return [{
      id: 'sp_growing_agencies', module: 'short_payment',
      priority: growth > 5e6 ? 'P1' : 'P2', severity: growth > 5e6 ? 'high' : 'medium',
      title: `${r.rows.length} agencies short-paying — dues grew ${fmtINR(growth)} in 3 months`,
      what: `Between ${from} and ${to}, ${r.rows.length} agencies grew their outstanding by ≥25% and ≥₹50,000 each — combined growth ${fmtINR(growth)}.`,
      why: `They are consistently paying less than they are billed. Fastest growing: ${r.rows.slice(0, 3).map(a => `${a.ag_name} (${a.unit_name}) +${fmtINR(N(a.os_to) - N(a.os_from))}`).join('; ')}.`,
      impact: `If unchecked, this adds ${fmtINR(growth / 3)} to outstanding every month from these agencies alone.`,
      next: `Move the top listed agencies to advance-payment or reduced-copy terms until dues are cleared; review their security deposits.`,
      metrics: { count: r.rows.length, growth, from, to },
      top: r.rows.slice(0, 10).map(a => ({
        label: a.ag_name, unit_code: a.unit_code, value: N(a.os_to) - N(a.os_from),
        text: `${a.ag_name} — ${a.unit_name} — ${fmtINR(a.os_from)} → ${fmtINR(a.os_to)} (+${fmtINR(N(a.os_to) - N(a.os_from))})`,
        mobile: a.mobno, zh: a.zh_name,
      })),
      targets: [...new Map(r.rows.slice(0, 10).map(a => [a.unit_code, { unit_code: a.unit_code, unit_name: a.unit_name }])).values()],
      drill: 'short_payment',
    }];
  }

  async function aTaxi(unitCodes) {
    const out = [];
    let clause = '', params = [];
    if (unitCodes) {
      const names = await scopeToTaxiNames(unitCodes);
      if (!names.length) return out;
      clause = ` AND unit_name IN (${names.map(() => '?').join(',')})`;
      params = names;
    }
    const mR = await q(`SELECT MAX(report_date) mx FROM taxi_delay_log WHERE 1=1${clause}`, params);
    const asOf = mR.rows[0] && mR.rows[0].mx;
    if (!asOf) return out;

    const dR = await q(`
      SELECT COUNT(*) trips, SUM(CASE WHEN taxi_delayed > 0 THEN 1 ELSE 0 END) delayed_cnt,
             SUM(CASE WHEN taxi_delayed > 0 THEN taxi_delayed ELSE 0 END) delay_min
      FROM taxi_delay_log WHERE report_date = ?${clause}`, [asOf, ...params]);
    const d = dR.rows[0] || {};
    const delayed = N(d.delayed_cnt);

    if (delayed > 0) {
      const uR = await q(`
        SELECT unit_name, COUNT(*) n, ROUND(AVG(taxi_delayed)) avg_min
        FROM taxi_delay_log WHERE report_date = ? AND taxi_delayed > 0${clause}
        GROUP BY unit_name ORDER BY n DESC LIMIT 5`, [asOf, ...params]);
      const repR = await q(`
        SELECT unit_name, route_name, sub_route_name, vehicle_no, MAX(driver_mobile) driver_mobile, COUNT(*) late_days
        FROM taxi_delay_log
        WHERE report_date > DATE_SUB(?, INTERVAL 7 DAY) AND taxi_delayed > 0${clause}
        GROUP BY unit_name, route_name, sub_route_name, vehicle_no
        HAVING late_days >= 3 ORDER BY late_days DESC LIMIT 10`, [asOf, ...params]);
      out.push({
        id: 'taxi_delays', module: 'taxi',
        priority: repR.rows.length >= 3 ? 'P1' : 'P2', severity: repR.rows.length >= 3 ? 'high' : 'medium',
        title: `${delayed} of ${N(d.trips)} taxi routes delayed on ${asOf}`,
        what: `${delayed} routes ran late on ${asOf} (${N(d.trips)} total trips). ${repR.rows.length} route/vehicle pairs were late 3+ times in the last 7 days.`,
        why: uR.rows.length
          ? `Most affected units: ${uR.rows.slice(0, 3).map(u => `${u.unit_name} (${u.n} routes, avg ${u.avg_min} min late)`).join(', ')}.`
          : 'Delays spread across units.',
        impact: `Late newspaper delivery in ${uR.rows.length} unit(s) — reader complaints and unsold-copy risk on repeat-late routes.`,
        next: `Contact the drivers of repeat-late routes (listed) and review departure times with the transport incharge of the most affected units.`,
        metrics: { trips: N(d.trips), delayed, as_of: asOf, repeat_late: repR.rows.length },
        top: repR.rows.map(r => ({
          label: `${r.route_name} / ${r.sub_route_name}`, value: N(r.late_days),
          text: `${r.unit_name}: ${r.route_name} → ${r.sub_route_name} (${r.vehicle_no}) late ${r.late_days}× in 7 days`,
          mobile: r.driver_mobile, vehicle: r.vehicle_no,
        })),
        targets: uR.rows.map(u => ({ unit_name: u.unit_name })),
        drill: 'taxi',
      });
    }

    // App usage: vehicles running without the driver app (no GPS km recorded)
    const appR = await q(`
      SELECT COUNT(*) n FROM taxi_delay_log
      WHERE report_date = ? AND (total_app_km IS NULL OR total_app_km = 0)${clause}`, [asOf, ...params]);
    const napp = N(appR.rows[0] && appR.rows[0].n);
    if (napp > 0) {
      const vR = await q(`
        SELECT vehicle_no, MAX(unit_name) unit_name, MAX(driver_mobile) driver_mobile, COUNT(*) days_off_app
        FROM taxi_delay_log
        WHERE report_date > DATE_SUB(?, INTERVAL 7 DAY) AND (total_app_km IS NULL OR total_app_km = 0)${clause}
        GROUP BY vehicle_no ORDER BY days_off_app DESC LIMIT 10`, [asOf, ...params]);
      out.push({
        id: 'taxi_app_usage', module: 'app_usage',
        priority: 'P3', severity: 'low',
        title: `${napp} vehicles ran without the driver app on ${asOf}`,
        what: `${napp} vehicle trips on ${asOf} recorded no app GPS kilometres — deliveries cannot be verified for these routes.`,
        why: `Repeat offenders (7 days): ${vR.rows.slice(0, 3).map(v => `${v.vehicle_no} (${v.unit_name}) ${v.days_off_app} days`).join(', ')}.`,
        impact: `No drop-point timestamps or km verification for these trips — delivery disputes cannot be settled from data.`,
        next: `Send app-usage reminders (WhatsApp/SMS) to the listed drivers; ask unit transport incharges to verify app installation.`,
        metrics: { count: napp, as_of: asOf },
        top: vR.rows.map(v => ({
          label: v.vehicle_no, value: N(v.days_off_app),
          text: `${v.vehicle_no} — ${v.unit_name} — no app data ${v.days_off_app} of last 7 days`,
          mobile: v.driver_mobile, vehicle: v.vehicle_no,
        })),
        targets: [],
        drill: 'taxi',
      });
    }
    return out;
  }

  async function aSurvey(sc) {
    const out = [];
    const mR = await q(`SELECT MAX(bookdate) mx FROM survey_data WHERE 1=1 ${sc.clause}`, sc.params);
    const asOf = mR.rows[0] && mR.rows[0].mx;
    if (!asOf) return out;
    const tR = await q(`
      SELECT
        SUM(CASE WHEN bookdate > DATE_SUB(?, INTERVAL 7 DAY) THEN 1 ELSE 0 END) cur7,
        SUM(CASE WHEN bookdate <= DATE_SUB(?, INTERVAL 7 DAY) AND bookdate > DATE_SUB(?, INTERVAL 14 DAY) THEN 1 ELSE 0 END) prev7
      FROM survey_data WHERE bookdate <= ? ${sc.clause}`, [asOf, asOf, asOf, asOf, ...sc.params]);
    const t = tR.rows[0] || {};
    const cur7 = N(t.cur7), prev7 = N(t.prev7);
    const pc = pctChange(cur7, prev7);
    if (prev7 >= 50 && pc != null && pc < -30) {
      const uR = await q(`
        SELECT unit_name, unit_code,
          SUM(CASE WHEN bookdate > DATE_SUB(?, INTERVAL 7 DAY) THEN 1 ELSE 0 END) cur7,
          SUM(CASE WHEN bookdate <= DATE_SUB(?, INTERVAL 7 DAY) AND bookdate > DATE_SUB(?, INTERVAL 14 DAY) THEN 1 ELSE 0 END) prev7
        FROM survey_data WHERE bookdate <= ? ${sc.clause}
        GROUP BY unit_code, unit_name HAVING prev7 > cur7
        ORDER BY (prev7 - cur7) DESC LIMIT 5`, [asOf, asOf, asOf, asOf, ...sc.params]);
      out.push({
        id: 'survey_slowdown', module: 'survey',
        priority: 'P2', severity: 'medium',
        title: `Survey activity down ${fmtPct(pc)} week-on-week`,
        what: `${cur7} surveys were booked in the 7 days ending ${asOf} vs ${prev7} in the week before (${fmtPct(pc)}).`,
        why: uR.rows.length
          ? `Biggest drops: ${uR.rows.slice(0, 3).map(u => `${u.unit_name} ${u.prev7}→${u.cur7}`).join(', ')}.`
          : 'Drop is spread across units.',
        impact: `Slower survey pipeline reduces new-reader acquisition in the affected units.`,
        next: `Check surveyor attendance/targets in the listed units with their Edition Incharges.`,
        metrics: { cur7, prev7, pct: pc, as_of: asOf },
        top: uR.rows.map(u => ({ label: u.unit_name, unit_code: u.unit_code, value: N(u.prev7) - N(u.cur7), text: `${u.unit_name}: ${u.prev7} → ${u.cur7} surveys/week` })),
        targets: uR.rows.map(u => ({ unit_code: u.unit_code, unit_name: u.unit_name })),
        drill: 'survey',
      });
    }
    // Follow-ups due
    const fR = await q(`
      SELECT COUNT(*) n FROM survey_data
      WHERE followup_date IS NOT NULL AND followup_date <= CURDATE()
        AND (order_id IS NULL OR order_id = '') ${sc.clause}`, sc.params);
    const nf = N(fR.rows[0] && fR.rows[0].n);
    if (nf > 0) {
      const fuR = await q(`
        SELECT unit_name, unit_code, COUNT(*) n FROM survey_data
        WHERE followup_date IS NOT NULL AND followup_date <= CURDATE()
          AND (order_id IS NULL OR order_id = '') ${sc.clause}
        GROUP BY unit_code, unit_name ORDER BY n DESC LIMIT 5`, sc.params);
      out.push({
        id: 'survey_followups_due', module: 'survey',
        priority: nf > 500 ? 'P2' : 'P3', severity: nf > 500 ? 'medium' : 'low',
        title: `${nf.toLocaleString('en-IN')} survey follow-ups due without an order`,
        what: `${nf.toLocaleString('en-IN')} surveyed readers have a follow-up date on or before today and no order booked yet.`,
        why: `Largest backlogs: ${fuR.rows.slice(0, 3).map(u => `${u.unit_name} (${u.n})`).join(', ')}.`,
        impact: `Each unconverted follow-up is a warm lead going cold — conversion drops steeply after the promised follow-up date.`,
        next: `Assign pending follow-ups to field executives in the listed units and clear the backlog this week.`,
        metrics: { count: nf },
        top: fuR.rows.map(u => ({ label: u.unit_name, unit_code: u.unit_code, value: N(u.n), text: `${u.unit_name}: ${u.n} follow-ups pending` })),
        targets: fuR.rows.map(u => ({ unit_code: u.unit_code, unit_name: u.unit_name })),
        drill: 'survey',
      });
    }
    return out;
  }

  async function aDigitalCollection(scCol) {
    const mR = await q(`SELECT MAX(coll_date) mx FROM agency_collection WHERE 1=1 ${scCol.clause}`, scCol.params);
    const asOf = mR.rows[0] && mR.rows[0].mx;
    if (!asOf) return [];
    const r = await q(`
      SELECT
        SUM(CASE WHEN UPPER(COALESCE(payment_cat, payment_mode, '')) LIKE '%CASH%' THEN amount ELSE 0 END) cash_amt,
        SUM(amount) total_amt
      FROM agency_collection WHERE coll_date > DATE_SUB(?, INTERVAL 30 DAY) ${scCol.clause}`,
      [asOf, ...scCol.params]);
    const d = r.rows[0] || {};
    const cash = N(d.cash_amt), total = N(d.total_amt);
    if (!total) return [];
    const cashPct = cash / total * 100;
    if (cashPct <= 50) return [];
    const brR = await q(`
      SELECT branch_name,
        SUM(CASE WHEN UPPER(COALESCE(payment_cat, payment_mode, '')) LIKE '%CASH%' THEN amount ELSE 0 END) cash_amt,
        SUM(amount) total_amt
      FROM agency_collection WHERE coll_date > DATE_SUB(?, INTERVAL 30 DAY) ${scCol.clause}
      GROUP BY branch_name HAVING total_amt > 100000
      ORDER BY cash_amt / total_amt DESC LIMIT 5`, [asOf, ...scCol.params]);
    return [{
      id: 'digital_low', module: 'digital',
      priority: 'P3', severity: 'low',
      title: `${cashPct.toFixed(0)}% of collections still in cash`,
      what: `Of ${fmtINR(total)} collected in the 30 days ending ${asOf}, ${fmtINR(cash)} (${cashPct.toFixed(1)}%) was cash.`,
      why: `Most cash-heavy branches: ${brR.rows.slice(0, 3).map(b => `${b.branch_name} (${(N(b.cash_amt) / N(b.total_amt) * 100).toFixed(0)}% cash)`).join(', ')}.`,
      impact: `Cash handling carries reconciliation delays, leakage risk and slower banking versus UPI/online receipts.`,
      next: `Push UPI/QR collection drives in the listed branches; set a digital-share target for next month.`,
      metrics: { cash, total, cash_pct: cashPct, as_of: asOf },
      top: brR.rows.map(b => ({ label: b.branch_name, value: N(b.cash_amt), text: `${b.branch_name}: ${(N(b.cash_amt) / N(b.total_amt) * 100).toFixed(0)}% cash of ${fmtINR(b.total_amt)}` })),
      targets: [],
      drill: 'collection',
    }];
  }

  // ── Supply pulse: latest day vs 7-day rolling average ──────────────────────
  async function aSupplyPulse(sc) {
    const dtR = await q(`SELECT MAX(supply_date) mx FROM supply_data WHERE 1=1${sc.clause}`, sc.params);
    const asOf = dtR.rows[0] && dtR.rows[0].mx;
    if (!asOf) return [];
    const r = await q(`
      SELECT
        SUM(CASE WHEN supply_date=? THEN sup_copy ELSE 0 END) latest,
        SUM(CASE WHEN supply_date<? AND supply_date>=DATE_SUB(?,INTERVAL 8 DAY) THEN sup_copy ELSE 0 END) prev_sum,
        COUNT(DISTINCT CASE WHEN supply_date<? AND supply_date>=DATE_SUB(?,INTERVAL 8 DAY) THEN supply_date END) prev_days
      FROM supply_data WHERE 1=1${sc.clause}`,
      [asOf, asOf, asOf, asOf, asOf, ...sc.params]);
    const d = r.rows[0] || {};
    const latest = N(d.latest), prevDays = N(d.prev_days);
    if (!prevDays) return [];
    const avg7 = N(d.prev_sum) / prevDays;
    if (!avg7) return [];
    const dropPct = (latest - avg7) / avg7 * 100;
    if (dropPct > -5) return [];  // not a significant drop

    const unitR = await q(`
      SELECT unit_code, MAX(unit_name) unit_name,
             SUM(CASE WHEN supply_date=? THEN sup_copy ELSE 0 END) latest,
             ROUND(SUM(CASE WHEN supply_date<? AND supply_date>=DATE_SUB(?,INTERVAL 8 DAY) THEN sup_copy ELSE 0 END)
               / NULLIF(COUNT(DISTINCT CASE WHEN supply_date<? AND supply_date>=DATE_SUB(?,INTERVAL 8 DAY) THEN supply_date END),0), 0) avg7
      FROM supply_data WHERE 1=1${sc.clause}
      GROUP BY unit_code
      HAVING avg7 > 100 AND latest < avg7 * 0.95
      ORDER BY (avg7 - latest) DESC LIMIT 8`,
      [asOf, asOf, asOf, asOf, asOf, ...sc.params]);

    return [{
      id: 'supply_drop', module: 'supply',
      priority: dropPct < -10 ? 'P1' : 'P2', severity: dropPct < -10 ? 'high' : 'medium',
      title: `Supply down ${fmtPct(dropPct)} vs 7-day average on ${asOf}`,
      what: `Latest supply day (${asOf}): ${fmtNum(Math.round(latest))} copies vs ${fmtNum(Math.round(avg7))} 7-day daily average (${fmtPct(dropPct)}).`,
      why: unitR.rows.length
        ? `Biggest drops: ${unitR.rows.slice(0, 3).map(u => `${u.unit_name} ${fmtNum(N(u.latest))} vs avg ${fmtNum(N(u.avg7))}`).join(', ')}.`
        : 'Drop is spread across all units.',
      impact: `${fmtNum(Math.round(avg7 - latest))} fewer copies supplied — potential unsatisfied readers and returned-copy increase for the affected units.`,
      next: `Check with printing/dispatch for production delays; verify sub-distributor completion for the top listed units.`,
      metrics: { latest, avg7, drop_pct: dropPct, as_of: asOf },
      top: unitR.rows.map(u => ({ label: u.unit_name, unit_code: u.unit_code, value: N(u.avg7) - N(u.latest),
        text: `${u.unit_name}: ${fmtNum(N(u.latest))} copies vs avg ${fmtNum(N(u.avg7))} (${fmtPct((N(u.latest)-N(u.avg7))/N(u.avg7)*100)})` })),
      targets: unitR.rows.map(u => ({ unit_code: u.unit_code, unit_name: u.unit_name })),
      drill: 'supply',
    }];
  }

  // ── DCR field-visit insights: inactive execs + unvisited agencies ───────────
  async function aDcrInsights(sc) {
    const out = [];
    const dtR = await q(`SELECT MAX(visit_date) mx FROM dcr_agency_visit WHERE 1=1${sc.clause}`, sc.params);
    const asOf = dtR.rows[0] && dtR.rows[0].mx;
    if (!asOf) return out;

    // 1. Executives active in last 30 days but zero visits in last 7 days
    const execR = await q(`
      SELECT emp_code, MAX(executive_name) exec_name, MAX(unit_code) unit_code, MAX(unit_name) unit_name,
             SUM(visit_date >= DATE_SUB(?,INTERVAL 7 DAY)) last7,
             SUM(visit_date >= DATE_SUB(?,INTERVAL 30 DAY)) last30
      FROM dcr_agency_visit WHERE 1=1${sc.clause}
      GROUP BY emp_code
      HAVING last30 > 0 AND last7 = 0
      ORDER BY last30 DESC LIMIT 30`,
      [asOf, asOf, ...sc.params]);

    if (execR.rows.length >= 2) {
      const unitBreak = {};
      execR.rows.forEach(r => { unitBreak[r.unit_code] = (unitBreak[r.unit_code] || 0) + 1; });
      const topUnits = Object.entries(unitBreak).sort((a, b) => b[1] - a[1]).slice(0, 3);
      out.push({
        id: 'dcr_inactive_execs', module: 'field_visit',
        priority: execR.rows.length >= 5 ? 'P2' : 'P3', severity: execR.rows.length >= 5 ? 'medium' : 'low',
        title: `${execR.rows.length} executives had 0 field visits in last 7 days`,
        what: `${execR.rows.length} executives who were active in the last 30 days recorded no DCR agency visit in the past 7 days.`,
        why: `Most affected units: ${topUnits.map(([uc, n]) => `${uc} (${n} exec${n > 1 ? 's' : ''})`).join(', ')}.`,
        impact: `Agent relationships go cold, payments and commitment follow-ups are missed for the agencies assigned to these executives.`,
        next: `Unit heads to review field schedules; ensure daily DCR visit targets are assigned and tracked.`,
        metrics: { count: execR.rows.length, as_of: asOf },
        top: execR.rows.slice(0, 10).map(r => ({ label: r.exec_name, unit_code: r.unit_code, value: N(r.last30),
          text: `${r.exec_name} (${r.unit_name}): 0 visits in 7 days, ${N(r.last30)} in last 30` })),
        targets: [...new Map(execR.rows.map(r => [r.unit_code, { unit_code: r.unit_code, unit_name: r.unit_name }])).values()],
        drill: 'field_visit',
      });
    }

    // 2. Main agencies with active supply but no DCR visit in 30+ days
    // Query dcr_agency_visit for last visit per (unit_code, agcd) — separate from agency_master to avoid collation JOIN
    const visitR = await q(`
      SELECT unit_code, visit_to_main_code agcd, MAX(visit_date) last_visit
      FROM dcr_agency_visit WHERE 1=1${sc.clause}
      GROUP BY unit_code, visit_to_main_code`, sc.params);
    const visitMap = {};
    visitR.rows.forEach(r => { visitMap[(r.unit_code || '') + '|' + r.agcd] = r.last_visit; });

    // Active agencies: had supply in last 15 days (dpcd=1 for main agency, same as sub-agency rows in supply)
    const today = new Date().toISOString().slice(0, 10);
    const amClause = sc.clause.replace(/unit_code/g, 'unit');
    const amR = await q(`
      SELECT unit AS unit_code, MAX(unit_name) unit_name, agcd, MAX(ag_name) ag_name
      FROM agency_master
      WHERE CAST(dpcd AS UNSIGNED) = 1
        AND (supply_stop_flag IS NULL OR supply_stop_flag != 'Y')
        AND (suspend_date IS NULL OR suspend_date > CURDATE())
        AND executive_name IS NOT NULL AND executive_name != ''${amClause}
      GROUP BY unit, agcd LIMIT 3000`, sc.params);

    const unvisited = [];
    amR.rows.forEach(a => {
      const key = (a.unit_code || '') + '|' + a.agcd;
      const lv = visitMap[key];
      const daysSince = lv ? Math.floor((new Date(today) - new Date(lv)) / 86400000) : 9999;
      if (daysSince >= 30) unvisited.push({ ...a, last_visit: lv || null, days_since: daysSince });
    });

    if (unvisited.length >= 5) {
      const neverVisited = unvisited.filter(a => !a.last_visit).length;
      const sample = [...unvisited].sort((a, b) => b.days_since - a.days_since).slice(0, 10);
      out.push({
        id: 'dcr_unvisited_agencies', module: 'field_visit',
        priority: unvisited.length >= 50 ? 'P2' : 'P3', severity: unvisited.length >= 50 ? 'medium' : 'low',
        title: `${unvisited.length} active agencies not visited by executive in 30+ days`,
        what: `${unvisited.length} main agencies with active supply have no DCR executive visit in 30+ days (${neverVisited} have never been visited in the system).`,
        why: `Longest gaps: ${sample.slice(0, 3).map(a => `${a.ag_name} (${a.unit_name}, ${a.days_since >= 9000 ? 'never' : a.days_since + ' days'}`).join('); ')}).`,
        impact: `Outstanding builds undetected; growth discussions and payment commitments are not happening at these agencies.`,
        next: `Assign a visit schedule for these agencies in the next 7 days, prioritizing those with high outstanding or declining supply.`,
        metrics: { count: unvisited.length, never_visited: neverVisited, as_of: today },
        top: sample.map(a => ({ label: a.ag_name, unit_code: a.unit_code, value: a.days_since,
          text: `${a.ag_name} (${a.unit_name}): last visited ${a.last_visit || 'never'} (${a.days_since >= 9000 ? 'never' : a.days_since + ' days ago'})` })),
        targets: [...new Map(sample.map(a => [a.unit_code, { unit_code: a.unit_code, unit_name: a.unit_name }])).values()],
        drill: 'field_visit',
      });
    }

    return out;
  }

  const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 };

  // ── GET /api/insights ───────────────────────────────────────────────────────
  app.get('/api/insights', async (req, res) => {
    try {
      const personCode = req.headers['x-person-code'] || '';
      const hl = parseInt(req.headers['x-hierarchy-level'] || '1', 10);
      const cacheKey = `${personCode}|${hl}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS && !req.query.refresh) {
        return res.json({ ...hit.data, cached: true });
      }

      const [scOu, scCol] = await Promise.all([getOuScopeFilter(req), getColScopeFilter(req)]);
      const unitCodes = await getScopeUnitCodes(personCode, hl); // null = admin

      const results = await Promise.allSettled([
        aOutstandingMoM(scOu),
        aStoppedSupplyOS(scOu),
        aCollectionTrend(scCol, scOu),
        aShortPayment(scOu),
        aTaxi(unitCodes),
        aSurvey(scOu),
        aDigitalCollection(scCol),
        aSupplyPulse(scOu),
        aDcrInsights(scOu),
      ]);
      const insights = [];
      const errors = [];
      for (const r of results) {
        if (r.status === 'fulfilled') insights.push(...r.value);
        else errors.push(String(r.reason && r.reason.message || r.reason));
      }
      insights.sort((a, b) =>
        (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) ||
        (N(b.metrics && (b.metrics.delta || b.metrics.os || b.metrics.growth || b.metrics.count)) -
         N(a.metrics && (a.metrics.delta || a.metrics.os || a.metrics.growth || a.metrics.count))));

      // attach open action counts so the UI can show "already being handled"
      const keys = insights.map(i => i.id);
      let openMap = {};
      if (keys.length) {
        const ph = keys.map(() => '?').join(',');
        const aR = await q(`SELECT insight_key, COUNT(*) n FROM action_items WHERE insight_key IN (${ph}) AND status IN ('open','in_progress') GROUP BY insight_key`, keys);
        openMap = Object.fromEntries(aR.rows.map(r => [r.insight_key, N(r.n)]));
      }
      insights.forEach(i => { i.open_actions = openMap[i.id] || 0; });

      const data = {
        generated_at: new Date().toISOString(),
        count: insights.length,
        insights: insights.slice(0, parseInt(req.query.limit || '15', 10)),
        errors: errors.length ? errors : undefined,
      };
      cache.set(cacheKey, { at: Date.now(), data });
      res.json(data);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Message drafting ────────────────────────────────────────────────────────
  function draftMessage(insight, channel, opts = {}) {
    const fromName = process.env.SMTP_FROM_NAME || 'Patrika Circulation MIS';
    const toName = opts.to_name || (insight.targets && insight.targets[0] && insight.targets[0].unit_name
      ? `Zonal Head — ${insight.targets.map(t => t.unit_name).filter(Boolean).slice(0, 3).join(', ')}`
      : 'Team');
    const topLines = (insight.top || []).slice(0, 10).map((t, i) => `${i + 1}. ${t.text || t.label}`);

    if (channel === 'email') {
      const subject = `[${insight.priority}] ${insight.title} — Action Required`;
      const body = [
        `Dear ${toName},`,
        ``,
        insight.what,
        ``,
        `Why it matters:`,
        insight.why,
        ``,
        `Impact:`,
        insight.impact,
        ...(topLines.length ? [``, `Items requiring attention:`, ...topLines] : []),
        ``,
        `Recommended action:`,
        insight.next,
        ``,
        `Please review and take corrective action within 48 hours, and reply with the current status.`,
        ``,
        `Regards,`,
        fromName,
        `(Generated by Patrika AI Decision Support from live circulation data)`,
      ].join('\n');
      return { subject, body };
    }
    if (channel === 'whatsapp') {
      const body = [
        `*${insight.title}*`,
        ``,
        insight.what,
        `*Why:* ${insight.why}`,
        ...(topLines.length ? [``, `Top items:`, ...topLines.slice(0, 5)] : []),
        ``,
        `*Action:* ${insight.next}`,
        `— ${fromName}`,
      ].join('\n');
      return { subject: insight.title, body };
    }
    // sms — keep it short
    const body = `${insight.title}. ${insight.next} — ${fromName}`.slice(0, 300);
    return { subject: insight.title, body };
  }

  // POST /api/insights/draft  { insight, channel, to_name? }
  app.post('/api/insights/draft', async (req, res) => {
    try {
      const { insight, channel = 'email', to_name } = req.body || {};
      if (!insight || !insight.title) return res.status(400).json({ detail: 'insight object required' });
      const draft = draftMessage(insight, channel, { to_name });

      // Recipients: configured emails for the insight's target units
      let recipients = [];
      const unitCodes = [...new Set((insight.targets || []).map(t => t.unit_code).filter(Boolean))];
      if (unitCodes.length) {
        const ph = unitCodes.map(() => '?').join(',');
        const r = await q(`SELECT unit_code, unit_name, role_label, person_name, email, mobile
                           FROM unit_email_config WHERE unit_code IN (${ph}) AND is_active = 1`, unitCodes);
        recipients = r.rows;
      }
      const mobiles = (insight.top || []).map(t => t.mobile).filter(Boolean);
      res.json({ ...draft, channel, recipients, mobiles: [...new Set(mobiles)] });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // POST /api/insights/send-email  { to: [..], cc?, subject, body, insight_key?, module?, priority?, created_by? }
  app.post('/api/insights/send-email', async (req, res) => {
    try {
      const { to, cc, subject, body, insight_key, module: mod, priority, created_by } = req.body || {};
      const _seenTo = new Set();
      const list = (Array.isArray(to) ? to : [to])
        .map(e => String(e || '').trim())
        .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
        .filter(e => { const k = e.toLowerCase(); if (_seenTo.has(k)) return false; _seenTo.add(k); return true; }); // one email per address
      if (!list.length) return res.status(400).json({ detail: 'valid to[] required' });
      if (!subject || !body) return res.status(400).json({ detail: 'subject and body required' });

      const SMTP_HOST = process.env.SMTP_HOST, SMTP_USER = process.env.SMTP_USER;
      if (!SMTP_HOST || !SMTP_USER) return res.status(503).json({ detail: 'SMTP not configured in .env' });
      const nodemailer = require('nodemailer');
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST, port, secure: port === 465,
        auth: { user: SMTP_USER, pass: process.env.SMTP_PASSWORD },
      });
      const from = `"${process.env.SMTP_FROM_NAME || 'Patrika Vitran'}" <${process.env.SMTP_FROM_EMAIL || SMTP_USER}>`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${
        String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;

      await transporter.sendMail({ from, to: list.join(','), cc: cc || undefined, subject, text: body, html });

      await q(`INSERT INTO action_items (insight_key, module, title, detail, priority, action_type, channel_meta, status, created_by)
               VALUES (?,?,?,?,?,?,?,?,?)`,
        [insight_key || null, mod || null, subject.slice(0, 300), body.slice(0, 5000), priority || null,
         'email_sent', JSON.stringify({ to: list, cc: cc || null }), 'in_progress', created_by || null]);

      res.json({ ok: true, sent_to: list });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Action items ────────────────────────────────────────────────────────────
  // POST /api/actions  { insight_key, module, title, detail, priority, unit_code, unit_name, assigned_to, action_type, created_by }
  app.post('/api/actions', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ detail: 'title required' });
      const r = await q(`INSERT INTO action_items
        (insight_key, module, title, detail, priority, unit_code, unit_name, assigned_to, action_type, channel_meta, status, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [b.insight_key || null, b.module || null, String(b.title).slice(0, 300), b.detail || null, b.priority || null,
         b.unit_code || null, b.unit_name || null, b.assigned_to || null, b.action_type || 'task',
         b.channel_meta ? JSON.stringify(b.channel_meta) : null, b.status || 'open', b.created_by || null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // GET /api/actions?status=open|in_progress|resolved&limit=50
  app.get('/api/actions', async (req, res) => {
    try {
      const cls = [], params = [];
      if (req.query.status)      { cls.push('status = ?');      params.push(req.query.status); }
      if (req.query.insight_key) { cls.push('insight_key = ?'); params.push(req.query.insight_key); }
      if (req.query.module)      { cls.push('module = ?');      params.push(req.query.module); }
      const where = cls.length ? 'WHERE ' + cls.join(' AND ') : '';
      const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
      const r = await q(`SELECT * FROM action_items ${where} ORDER BY created_at DESC LIMIT ${limit}`, params);
      res.json({ actions: r.rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // PATCH /api/actions/:id  { status, resolved_by, assigned_to }
  app.patch('/api/actions/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], params = [];
      if (b.status)      { sets.push('status = ?'); params.push(b.status); }
      if (b.assigned_to) { sets.push('assigned_to = ?'); params.push(b.assigned_to); }
      if (b.status === 'resolved') {
        sets.push('resolved_at = NOW()');
        sets.push('resolved_by = ?'); params.push(b.resolved_by || null);
      }
      if (!sets.length) return res.status(400).json({ detail: 'nothing to update' });
      params.push(req.params.id);
      await q(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`, params);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Unit email config ───────────────────────────────────────────────────────
  // GET /api/email-config → all units (from `units`) + configured contacts
  app.get('/api/email-config', async (req, res) => {
    try {
      const [uR, cR] = await Promise.all([
        q(`SELECT unit_code, unit_name FROM units ORDER BY unit_name`),
        q(`SELECT id, unit_code, unit_name, role_label, person_name, email, mobile, is_active
           FROM unit_email_config ORDER BY unit_code, role_label`),
      ]);
      res.json({ units: uR.rows, contacts: cR.rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // POST /api/email-config  { id?, unit_code, role_label, person_name, email, mobile, is_active }
  app.post('/api/email-config', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.unit_code || !b.email) return res.status(400).json({ detail: 'unit_code and email required' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return res.status(400).json({ detail: 'invalid email' });
      const uR = await q(`SELECT unit_name FROM units WHERE unit_code = ?`, [b.unit_code]);
      const unitName = b.unit_name || (uR.rows[0] && uR.rows[0].unit_name) || null;
      if (b.id) {
        await q(`UPDATE unit_email_config SET unit_code=?, unit_name=?, role_label=?, person_name=?, email=?, mobile=?, is_active=? WHERE id=?`,
          [b.unit_code, unitName, b.role_label || 'Zonal Head', b.person_name || null, b.email, b.mobile || null,
           b.is_active == null ? 1 : (b.is_active ? 1 : 0), b.id]);
      } else {
        await q(`INSERT INTO unit_email_config (unit_code, unit_name, role_label, person_name, email, mobile, is_active)
                 VALUES (?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE person_name=VALUES(person_name), mobile=VALUES(mobile), is_active=VALUES(is_active)`,
          [b.unit_code, unitName, b.role_label || 'Zonal Head', b.person_name || null, b.email, b.mobile || null,
           b.is_active == null ? 1 : (b.is_active ? 1 : 0)]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // DELETE /api/email-config/:id
  app.delete('/api/email-config/:id', async (req, res) => {
    try {
      await q(`DELETE FROM unit_email_config WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
