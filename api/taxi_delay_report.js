'use strict';

const XLSX = require('xlsx');

// State lookup (derived from ERP data)
const STATE_MAP = {
  'AJMER RP': 'RAJ',       'ALWAR RP': 'RAJ',       'BANSWARA RP': 'RAJ',
  'BARMER RP': 'RAJ',      'BHARATPUR RP': 'RAJ',    'BHILWARA RP': 'RAJ',
  'BIKANER RP': 'RAJ',     'JAIPUR RP': 'RAJ',       'JHUNJHUNU': 'RAJ',
  'JODHPUR RP': 'RAJ',     'KOTA RP': 'RAJ',         'PALI RP': 'RAJ',
  'SIKAR RP': 'RAJ',       'SRI GANGANAGAR RP': 'RAJ', 'UDAIPUR RP': 'RAJ',
  'BHOPAL PT': 'MP',       'CHHINDWARA PT': 'MP',    'GWALIOR PT': 'MP',
  'INDORE PT': 'MP',       'JABALPUR PT': 'MP',      'KHANDWA PT': 'MP',
  'SAGAR PT': 'MP',        'SATNA PT': 'MP',
  'BILASPUR PT': 'CG',     'JAGDALPUR PT': 'CG',     'RAIPUR PT': 'CG',
  'BANGLORE RP': 'KA',
};
const STATE_LABELS = { RAJ: 'Rajasthan', MP: 'Madhya Pradesh', CG: 'Chhattisgarh', KA: 'Karnataka' };
const STATE_ORDER  = ['RAJ', 'MP', 'CG', 'KA'];

function stateOf(unit) {
  if (!unit) return 'UNK';
  return STATE_MAP[unit] || (unit.endsWith(' PT') ? 'MP' : 'RAJ');
}

// Build WHERE clause + params for unit/state filtering
function buildFilter(month, state, unit) {
  const params = [month];
  let clause = '';
  if (unit) {
    clause = 'AND t.unit_name = ?';
    params.push(unit);
  } else if (state) {
    const stateUnits = Object.entries(STATE_MAP)
      .filter(([, s]) => s === state)
      .map(([u]) => u);
    if (stateUnits.length) {
      clause = `AND t.unit_name IN (${stateUnits.map(() => '?').join(',')})`;
      params.push(...stateUnits);
    }
  }
  return { clause, params };
}

function csvEsc(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

module.exports = function({ app, q }) {

  // ── Date-wise drill for one vehicle+route ─────────────────────────────────
  app.get('/api/taxi-delay/route-detail', async (req, res) => {
    try {
      const { month, vehicle_no, route_name, sub_route_name } = req.query;
      if (!month || !vehicle_no || !route_name)
        return res.status(400).json({ detail: 'month, vehicle_no, route_name required' });
      const sub = sub_route_name || '-';
      const { rows } = await q(`
        SELECT
          DATE_FORMAT(t.report_date, '%Y-%m-%d')  AS rep_date,
          DATE_FORMAT(t.report_date, '%d %b')      AS rep_date_short,
          t.unit_name,
          ROUND(t.total_app_km, 2)                AS total_app_km,
          t.route_master_km,
          t.bundles,
          t.supply,
          TIME_FORMAT(t.scheduled_departure, '%H:%i') AS sched_dep,
          TIME_FORMAT(t.actual_departure,    '%H:%i') AS actual_dep,
          t.start_location,
          t.last_location,
          TIME_FORMAT(t.reached_time, '%H:%i')        AS reached_time,
          ROUND(t.taxi_delayed / 60, 0)               AS taxi_delayed_mins,
          GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)     AS delay_mins,
          GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30) * 3 AS penalty,
          CASE WHEN t.is_regular = 1 THEN 'REG' ELSE 'CAS' END AS reg_cas,
          COALESCE(t.casual_reason, '')               AS casual_reason
        FROM taxi_delay_log t
        WHERE DATE_FORMAT(t.report_date, '%Y-%m') = ?
          AND t.vehicle_no = ?
          AND t.route_name = ?
          AND COALESCE(t.sub_route_name, '-') = ?
        ORDER BY t.report_date
      `, [month, vehicle_no, route_name, sub]);
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Filter options ────────────────────────────────────────────────────────
  app.get('/api/taxi-delay/filters', async (req, res) => {
    try {
      const { rows: mRows } = await q(`
        SELECT DISTINCT DATE_FORMAT(report_date, '%Y-%m') AS month
        FROM taxi_delay_log ORDER BY month DESC LIMIT 36
      `);
      const { rows: uRows } = await q(
        'SELECT DISTINCT unit_name FROM taxi_delay_log ORDER BY unit_name'
      );
      const byState = {};
      for (const r of uRows) {
        const s = stateOf(r.unit_name);
        if (!byState[s]) byState[s] = [];
        byState[s].push(r.unit_name);
      }
      res.json({
        months: mRows.map(r => r.month),
        states: STATE_ORDER.filter(s => byState[s]),
        stateLabels: STATE_LABELS,
        unitsByState: byState,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Summary JSON (for table view) ─────────────────────────────────────────
  app.get('/api/taxi-delay/summary', async (req, res) => {
    try {
      const month = req.query.month || '';
      if (!month) return res.status(400).json({ detail: 'month required' });

      const { clause, params } = buildFilter(month, req.query.state, req.query.unit);

      const { rows } = await q(`
        SELECT
          t.unit_name,
          t.vehicle_no,
          t.route_name,
          COALESCE(t.sub_route_name, '-') AS sub_route_name,
          ROUND(MAX(t.route_master_km), 0) AS route_master_km,
          ROUND(MAX(t.total_app_km), 2)   AS total_app_km,
          COUNT(DISTINCT t.report_date)   AS app_running_days,
          SUM(GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)) AS delay_mins,
          SUM(GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)) * 3 AS penalty
        FROM taxi_delay_log t
        WHERE DATE_FORMAT(t.report_date, '%Y-%m') = ?
          ${clause}
        GROUP BY t.unit_name, t.vehicle_no, t.route_name, t.sub_route_name
        ORDER BY t.unit_name, t.route_name, t.vehicle_no
      `, params);

      const out = rows.map(r => ({ ...r, state: stateOf(r.unit_name) }));

      const totals = {
        total_app_km:     out.reduce((s, r) => s + parseFloat(r.total_app_km  || 0), 0).toFixed(2),
        app_running_days: out.reduce((s, r) => s + parseInt(r.app_running_days || 0), 0),
        delay_mins:       out.reduce((s, r) => s + parseInt(r.delay_mins       || 0), 0),
        penalty:          out.reduce((s, r) => s + parseInt(r.penalty           || 0), 0),
      };

      res.json({ rows: out, totals });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ── Download (CSV or XLSX) ─────────────────────────────────────────────────
  app.get('/api/taxi-delay/download', async (req, res) => {
    try {
      const month  = req.query.month  || '';
      const state  = req.query.state  || '';
      const unit   = req.query.unit   || '';
      const format = req.query.format || 'xlsx';
      if (!month) return res.status(400).json({ detail: 'month required' });

      const { clause, params } = buildFilter(month, state, unit);

      // Summary rows
      const { rows: summary } = await q(`
        SELECT
          t.unit_name,
          t.vehicle_no,
          t.route_name,
          COALESCE(t.sub_route_name, '-') AS sub_route_name,
          ROUND(MAX(t.route_master_km), 0) AS route_master_km,
          ROUND(MAX(t.total_app_km), 2)   AS total_app_km,
          COUNT(DISTINCT t.report_date)   AS app_running_days,
          SUM(GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)) AS delay_mins,
          SUM(GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)) * 3 AS penalty
        FROM taxi_delay_log t
        WHERE DATE_FORMAT(t.report_date, '%Y-%m') = ?
          ${clause}
        GROUP BY t.unit_name, t.vehicle_no, t.route_name, t.sub_route_name
        ORDER BY t.unit_name, t.route_name, t.vehicle_no
      `, params);

      // Detail rows
      const { rows: detail } = await q(`
        SELECT
          t.unit_name,
          DATE_FORMAT(t.report_date, '%d/%m/%Y') AS rep_date,
          t.route_name,
          COALESCE(t.sub_route_name, '-') AS sub_route_name,
          COALESCE(t.taxi_type, 'MAIN')   AS taxi_type,
          t.bundles,
          t.supply,
          t.vehicle_no,
          CASE WHEN t.is_regular = 1 THEN 'REGULAR' ELSE 'CASUAL' END AS regular_casual,
          t.casual_reason,
          t.vehicle_name,
          t.vehicle_owner,
          t.driver_mobile,
          t.start_location,
          TIME_FORMAT(t.scheduled_departure, '%H:%i') AS sched_dep,
          TIME_FORMAT(t.actual_departure,    '%H:%i') AS actual_dep,
          t.last_location,
          TIME_FORMAT(t.reached_time, '%H:%i') AS reached_time,
          ROUND(t.taxi_delayed / 60, 0)        AS taxi_delayed_mins,
          t.route_master_km,
          ROUND(t.total_app_km, 2)             AS total_app_km,
          GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30)     AS delay_mins,
          GREATEST(0, FLOOR(t.taxi_delayed / 60) - 30) * 3 AS penalty
        FROM taxi_delay_log t
        WHERE DATE_FORMAT(t.report_date, '%Y-%m') = ?
          ${clause}
        ORDER BY t.unit_name, t.report_date, t.route_name, t.vehicle_no
      `, params);

      const label    = unit || (state ? STATE_LABELS[state] || state : 'ALL');
      const filename = `TaxiDelay_${month}_${label}`.replace(/\s+/g, '_');

      if (format === 'csv') {
        const hdr = ['STATE','Unit Name','Vehicle No.','Route Name','Sub Route Name',
                     'Route Mast KM','Max App KM','App Running Days','Delay in Minutes','Penalty@3/minute'];
        const lines = [hdr.map(csvEsc).join(',')];
        for (const r of summary) {
          lines.push([stateOf(r.unit_name), r.unit_name, r.vehicle_no, r.route_name, r.sub_route_name,
            r.route_master_km, r.total_app_km, r.app_running_days, r.delay_mins, r.penalty
          ].map(csvEsc).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.end('﻿' + lines.join('\r\n'));
      }

      // XLSX — two sheets
      const sumHdr = ['STATE','Unit Name','Vehicle No.','Route Name','Sub Route Name',
                      'Route Mast KM','Max App KM','App Running Days','Delay in Minutes','Penalty@3/minute'];
      const sumData = [sumHdr, ...summary.map(r => [
        stateOf(r.unit_name), r.unit_name, r.vehicle_no, r.route_name, r.sub_route_name,
        parseFloat(r.route_master_km)||0, parseFloat(r.total_app_km)||0,
        parseInt(r.app_running_days)||0, parseInt(r.delay_mins)||0, parseInt(r.penalty)||0,
      ])];

      const detHdr = ['Unit Name','STATE','Date','Route Name','Sub Route Name',
                      'Taxi Type','Bundles','Supply','Vehicle No.','Regular/Casual','Casual Reason',
                      'Vehicle Name','Vehicle Owner','Mobile No.','Start Location',
                      'Schedule Departure','Actual Departure','Last Location','Reached Time',
                      'Taxi Delayed (Min)','Route Mast KM','Total App KM',
                      'Delay in Minutes','Penalty@3/minute'];
      const detData = [detHdr, ...detail.map(r => [
        r.unit_name, stateOf(r.unit_name), r.rep_date, r.route_name, r.sub_route_name,
        r.taxi_type, r.bundles||0, r.supply||0, r.vehicle_no,
        r.regular_casual, r.casual_reason||'',
        r.vehicle_name||'', r.vehicle_owner||'', r.driver_mobile||'', r.start_location||'',
        r.sched_dep||'', r.actual_dep||'', r.last_location||'', r.reached_time||'',
        parseInt(r.taxi_delayed_mins)||0,
        parseFloat(r.route_master_km)||0, parseFloat(r.total_app_km)||0,
        parseInt(r.delay_mins)||0, parseInt(r.penalty)||0,
      ])];

      const wb = XLSX.utils.book_new();
      const wsSummary = XLSX.utils.aoa_to_sheet(sumData);
      const wsDetail  = XLSX.utils.aoa_to_sheet(detData);

      // Column widths — summary
      wsSummary['!cols'] = [
        {wch:6},{wch:18},{wch:14},{wch:35},{wch:20},{wch:13},{wch:13},{wch:10},{wch:14},{wch:14},
      ];
      wsDetail['!cols'] = [
        {wch:18},{wch:6},{wch:12},{wch:35},{wch:20},{wch:8},{wch:8},{wch:8},{wch:14},
        {wch:10},{wch:14},{wch:16},{wch:20},{wch:13},{wch:16},
        {wch:10},{wch:10},{wch:16},{wch:10},{wch:14},{wch:13},{wch:12},{wch:14},{wch:14},
      ];

      XLSX.utils.book_append_sheet(wb, wsSummary, month);
      XLSX.utils.book_append_sheet(wb, wsDetail,  `Detail`);

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.end(buf);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
