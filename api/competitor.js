'use strict';
const express = require('express');
const XLSX    = require('xlsx');

const AGENCY_COLS = [
  'Period (YYYY-MM)', 'State', 'Unit Code', 'Unit Name', 'District',
  'AGCD', 'DPCD', 'Drop Point Name', 'Agency Name',
  'Competitor 1 Name', 'Competitor 1 Copies',
  'Competitor 2 Name', 'Competitor 2 Copies',
  'Competitor 3 Name', 'Competitor 3 Copies',
  'Competitor 4 Name', 'Competitor 4 Copies',
  'Competitor 5 Name', 'Competitor 5 Copies',
  'Remarks',
];

const HAWKER_COLS = [
  'Period (YYYY-MM)', 'State', 'Unit Code', 'Unit Name',
  'Hawker Code', 'Hawker Name',
  'Competitor 1 Name', 'Competitor 1 Copies',
  'Competitor 2 Name', 'Competitor 2 Copies',
  'Competitor 3 Name', 'Competitor 3 Copies',
  'Competitor 4 Name', 'Competitor 4 Copies',
  'Competitor 5 Name', 'Competitor 5 Copies',
  'Remarks',
];

const BLANK_COMP_CELLS = ['', 0, '', 0, '', 0, '', 0, '', 0, ''];
// Agency: Period,State,UnitCode,UnitName,District,AGCD,DPCD,DPName,AgName,C1-C5,Remarks
const AGENCY_COL_WIDTHS = [14, 14, 12, 22, 18, 14, 10, 22, 28, 22, 10, 22, 10, 22, 10, 22, 10, 22, 10, 18];
// Hawker: Period,State,UnitCode,UnitName,HawkerCode,HawkerName,C1-C5,Remarks
const HAWKER_COL_WIDTHS = [14, 14, 12, 22, 14, 28, 22, 10, 22, 10, 22, 10, 22, 10, 22, 10, 18];

async function buildMasterTemplate(compType, period, unitFilter, q) {
  const isHawker = compType === 'hawker';
  const cols = isHawker ? HAWKER_COLS : AGENCY_COLS;

  let dataRows = [];

  if (isHawker) {
    try {
      const where  = unitFilter ? 'WHERE unit_code = ?' : '';
      const params = unitFilter ? [unitFilter] : [];
      const { rows: hawkers } = await q(
        `SELECT hawker_id, hawker_name, unit_code, unit_name
         FROM hawker_master ${where}
         ORDER BY unit_code, hawker_name`, params);

      // Build unit→state map via agency_master (same utf8mb4_unicode_ci collation — safe)
      const stateMap = {};
      if (hawkers.length) {
        const unitCodes = [...new Set(hawkers.map(h => h.unit_code).filter(Boolean))];
        if (unitCodes.length) {
          try {
            const ph = unitCodes.map(() => '?').join(',');
            const { rows: us } = await q(
              `SELECT DISTINCT unit, state_name FROM agency_master
               WHERE unit IN (${ph}) AND state_name IS NOT NULL AND state_name != ''`, unitCodes);
            us.forEach(r => { stateMap[r.unit] = r.state_name; });
          } catch (_) {}
        }
      }

      dataRows = hawkers.map(h => [
        period,
        stateMap[h.unit_code] || '',
        h.unit_code   || '',
        h.unit_name   || '',
        h.hawker_id   || '',
        h.hawker_name || '',
        ...BLANK_COMP_CELLS,
      ]);
    } catch (e) {
      // hawker_master not synced yet — return header-only template
      console.warn('[competitor template] hawker_master query failed:', e.message);
    }
  } else {
    try {
      const whereBase = "(supply_stop_flag IS NULL OR supply_stop_flag != 'Y')";
      const where  = unitFilter ? `WHERE ${whereBase} AND unit = ?` : `WHERE ${whereBase}`;
      const params = unitFilter ? [unitFilter] : [];
      const { rows: agencies } = await q(
        `SELECT agcd, dpcd, ag_name, station_name, unit, unit_name, state_name, dist_name
         FROM agency_master ${where}
         ORDER BY state_name, unit, dist_name, agcd, dpcd`, params);

      dataRows = agencies.map(a => [
        period,
        a.state_name    || '',
        a.unit          || '',
        a.unit_name     || '',
        a.dist_name     || '',
        a.agcd          || '',
        a.dpcd          || '',
        a.station_name  || '',   // Drop Point Name (physical station)
        a.ag_name       || '',   // Agency Name (agent's business name)
        ...BLANK_COMP_CELLS,
      ]);
    } catch (e) {
      // agency_master not synced yet — return header-only template
      console.warn('[competitor template] agency_master query failed:', e.message);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([cols, ...dataRows]);
  const widths = isHawker ? HAWKER_COL_WIDTHS : AGENCY_COL_WIDTHS;
  ws['!cols'] = widths.map(wch => ({ wch }));

  const instrRows = [
    [`Competitor Data Upload — ${isHawker ? 'Hawker' : 'Agency'} Template`],
    [`Period: ${period}${unitFilter ? `  |  Unit: ${unitFilter}` : '  |  All Units'}`],
    [],
    ['Column', 'Description', 'Action'],
    ['Period (YYYY-MM)', 'Pre-filled from download parameters', 'DO NOT EDIT'],
    ['State', 'Pre-filled from master', 'DO NOT EDIT'],
    ['Unit Code', 'Pre-filled from master', 'DO NOT EDIT'],
    ['Unit Name', 'Pre-filled from master', 'DO NOT EDIT'],
    ...(isHawker ? [
      ['Hawker Code', 'Pre-filled from master', 'DO NOT EDIT'],
      ['Hawker Name', 'Pre-filled from master', 'DO NOT EDIT'],
    ] : [
      ['District', 'Pre-filled from master', 'DO NOT EDIT'],
      ['AGCD', 'Agent/Agency Code — pre-filled from master', 'DO NOT EDIT'],
      ['DPCD', 'Drop Point Code — pre-filled from master', 'DO NOT EDIT'],
      ['Drop Point Name', 'Physical station/delivery location — pre-filled from master', 'DO NOT EDIT'],
      ['Agency Name', 'Agent\'s business name — pre-filled from master', 'DO NOT EDIT'],
    ]),
    ['Competitor N Name', 'Competitor newspaper name e.g. Dainik Bhaskar', 'FILL IN'],
    ['Competitor N Copies', 'Competitor copies count', 'FILL IN'],
    [],
    ['Notes:'],
    ['• Fill ONLY the Competitor Name and Competitor Copies columns.'],
    ['• Do NOT edit pre-filled columns — unit/agent codes are used as keys on upload.'],
    ['• Save as .xlsx format before uploading.'],
    ['• Up to 5 competitors per row. Leave unused columns blank.'],
    ['• Uploading again for the same period+unit+agent will update the existing record.'],
    [],
    ['Common Competitor Names (use consistently):'],
    ['  Dainik Bhaskar'],
    ['  Navbharat Times'],
    ['  Amar Ujala'],
    ['  Hindustan Times'],
    ['  Patrika (Jaipur sub-edition)'],
  ];
  const instrWs = XLSX.utils.aoa_to_sheet(instrRows);
  instrWs['!cols'] = [{ wch: 22 }, { wch: 48 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isHawker ? 'Hawker Data' : 'Agency Data');
  XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

const N = v => { const x = parseInt(v, 10); return isNaN(x) ? 0 : x; };
const Str = v => String(v || '').trim();

function rowToRecord(row, compType, enteredBy) {
  // Hawker: "Hawker Code"; Agency (new): "AGCD"; Agency (legacy): "Agent Code"
  const agentCode = Str(row['Hawker Code'] || row['AGCD'] || row['Agent Code']);
  const agentName = Str(row['Hawker Name'] || row['Agency Name'] || row['Agent Name']);
  return {
    comp_type:    compType,
    state_name:   Str(row['State']),
    unit_code:    Str(row['Unit Code']),
    unit_name:    Str(row['Unit Name']),
    agent_code:   agentCode,
    agent_name:   agentName,
    period:       Str(row['Period (YYYY-MM)']),
    our_supply:   0,  // not collected in template; fetched from supply_data at query time
    comp1_name:   Str(row['Competitor 1 Name']),
    comp1_supply: N(row['Competitor 1 Copies']),
    comp2_name:   Str(row['Competitor 2 Name']),
    comp2_supply: N(row['Competitor 2 Copies']),
    comp3_name:   Str(row['Competitor 3 Name']),
    comp3_supply: N(row['Competitor 3 Copies']),
    comp4_name:   Str(row['Competitor 4 Name']),
    comp4_supply: N(row['Competitor 4 Copies']),
    comp5_name:   Str(row['Competitor 5 Name']),
    comp5_supply: N(row['Competitor 5 Copies']),
    remarks:      Str(row['Remarks']),
    data_source:  'excel',
    entered_by:   enteredBy,
  };
}

module.exports = function registerCompetitor({ app, q }) {

  // Table creation on startup
  q(`CREATE TABLE IF NOT EXISTS competitor_data (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    comp_type   VARCHAR(10)  NOT NULL DEFAULT 'agency' COMMENT 'agency or hawker',
    state_name  VARCHAR(50)  NOT NULL DEFAULT '',
    unit_code   VARCHAR(8)   NOT NULL,
    unit_name   VARCHAR(100),
    agent_code  VARCHAR(30)  NOT NULL DEFAULT '',
    agent_name  VARCHAR(200),
    period      VARCHAR(7)   NOT NULL COMMENT 'YYYY-MM',
    our_supply  INT          NOT NULL DEFAULT 0,
    comp1_name  VARCHAR(100), comp1_supply INT DEFAULT 0,
    comp2_name  VARCHAR(100), comp2_supply INT DEFAULT 0,
    comp3_name  VARCHAR(100), comp3_supply INT DEFAULT 0,
    comp4_name  VARCHAR(100), comp4_supply INT DEFAULT 0,
    comp5_name  VARCHAR(100), comp5_supply INT DEFAULT 0,
    remarks     TEXT,
    data_source VARCHAR(10)  DEFAULT 'manual',
    entered_by  VARCHAR(100),
    created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY  uniq_comp (comp_type, unit_code, agent_code, period)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`).catch(e =>
    console.warn('[competitor] table init:', e.message));

  async function upsertRecord(rec) {
    await q(`INSERT INTO competitor_data
        (comp_type, state_name, unit_code, unit_name, agent_code, agent_name, period,
         our_supply,
         comp1_name, comp1_supply, comp2_name, comp2_supply,
         comp3_name, comp3_supply, comp4_name, comp4_supply,
         comp5_name, comp5_supply,
         remarks, data_source, entered_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        unit_name    = VALUES(unit_name),
        agent_name   = VALUES(agent_name),
        our_supply   = VALUES(our_supply),
        comp1_name   = VALUES(comp1_name),   comp1_supply = VALUES(comp1_supply),
        comp2_name   = VALUES(comp2_name),   comp2_supply = VALUES(comp2_supply),
        comp3_name   = VALUES(comp3_name),   comp3_supply = VALUES(comp3_supply),
        comp4_name   = VALUES(comp4_name),   comp4_supply = VALUES(comp4_supply),
        comp5_name   = VALUES(comp5_name),   comp5_supply = VALUES(comp5_supply),
        remarks      = VALUES(remarks),
        data_source  = VALUES(data_source),
        entered_by   = VALUES(entered_by),
        updated_at   = NOW()`,
      [rec.comp_type, rec.state_name, rec.unit_code, rec.unit_name, rec.agent_code, rec.agent_name,
       rec.period, rec.our_supply,
       rec.comp1_name, rec.comp1_supply, rec.comp2_name, rec.comp2_supply,
       rec.comp3_name, rec.comp3_supply, rec.comp4_name, rec.comp4_supply,
       rec.comp5_name, rec.comp5_supply,
       rec.remarks, rec.data_source, rec.entered_by]);
  }

  // ════ GET /api/competitor/template ════
  // ?type=agency|hawker  &period=YYYY-MM (default: current month)  &unit=JA0 (optional filter)
  app.get('/api/competitor/template', async (req, res) => {
    try {
      const compType   = req.query.type === 'hawker' ? 'hawker' : 'agency';
      const period     = /^\d{4}-\d{2}$/.test(req.query.period || '')
        ? req.query.period
        : new Date().toISOString().slice(0, 7);
      const unitFilter = Str(req.query.unit);

      const buf = await buildMasterTemplate(compType, period, unitFilter, q);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',
        `attachment; filename="competitor_${compType}_${period}${unitFilter ? '_' + unitFilter : ''}.xlsx"`);
      res.send(buf);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ POST /api/competitor/upload ════
  // Frontend sends raw xlsx bytes as application/octet-stream
  // The master template carries one row per hawker/agency, so a real workbook is big:
  // ~2.4 MB for a single large unit and ~6 MB for all units, before the user has typed
  // anything. The old 10 MB ceiling was within reach of a filled all-units hawker file,
  // and body-parser signals that overflow by THROWING — which express renders as an
  // HTML error page, so the browser's res.json() died on "<!DOCTYPE" instead of showing
  // a real message. Ceiling raised, and the throw is converted to JSON below.
  app.post('/api/competitor/upload',
    express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], limit: '64mb' }),
    (err, req, res, next) => {
      if (!err) return next();
      const tooBig = err.type === 'entity.too.large' || /too large/i.test(err.message || '');
      res.status(tooBig ? 413 : 400).json({
        detail: tooBig
          ? 'File is too large to upload. Download the template for a single Unit Code instead of all units, fill that, and upload it.'
          : `Could not read the uploaded file: ${err.message}`,
      });
    },
    async (req, res) => {
      try {
        const compType  = req.query.type === 'hawker' ? 'hawker' : 'agency';
        const enteredBy = Str(req.query.entered_by);
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || buf.length === 0)
          return res.status(400).json({ detail: 'No file data received' });

        const wb   = XLSX.read(buf, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        let inserted = 0, skipped = 0;
        const errors = [];

        for (const row of rows) {
          const period   = Str(row['Period (YYYY-MM)']);
          const unitCode = Str(row['Unit Code']);
          if (!period.match(/^\d{4}-\d{2}$/) || !unitCode) { skipped++; continue; }
          // Skip rows where no competitor data has been entered
          const hasComp = [1,2,3,4,5].some(i => Str(row[`Competitor ${i} Name`]) || N(row[`Competitor ${i} Copies`]));
          if (!hasComp) { skipped++; continue; }
          try {
            await upsertRecord(rowToRecord(row, compType, enteredBy));
            inserted++;
          } catch (e) {
            errors.push(`${unitCode}/${Str(row['AGCD'] || row['Agent Code'] || row['Hawker Code'])}/${period}: ${e.message}`);
          }
        }
        res.json({ ok: true, inserted, skipped, errors: errors.slice(0, 20) });
      } catch (e) { res.status(500).json({ detail: String(e) }); }
    });

  // ════ GET /api/competitor ════
  // ?type=agency|hawker  &unit=JA0  &period=2026-08  &state=Rajasthan  &page=1  &limit=200
  app.get('/api/competitor', async (req, res) => {
    try {
      const { type = 'agency', unit, period, state, page = '1', limit: lim = '200' } = req.query;
      const where  = ['comp_type = ?'];
      const params = [type === 'hawker' ? 'hawker' : 'agency'];
      if (unit)   { where.push('unit_code = ?');   params.push(unit); }
      if (period) { where.push('period = ?');       params.push(period); }
      if (state)  { where.push('state_name = ?');   params.push(state); }
      const offset = (Math.max(1, Number(page)) - 1) * Number(lim);
      const { rows }  = await q(
        `SELECT * FROM competitor_data WHERE ${where.join(' AND ')} ORDER BY period DESC, unit_code, agent_code LIMIT ? OFFSET ?`,
        [...params, Number(lim), offset]);
      const { rows: cnt } = await q(
        `SELECT COUNT(*) AS cnt FROM competitor_data WHERE ${where.join(' AND ')}`, params);
      res.json({ total: Number(cnt[0].cnt), rows });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/competitor/periods ════
  app.get('/api/competitor/periods', async (req, res) => {
    try {
      const type = req.query.type === 'hawker' ? 'hawker' : 'agency';
      const { rows } = await q(
        `SELECT DISTINCT period FROM competitor_data WHERE comp_type = ? ORDER BY period DESC LIMIT 36`, [type]);
      res.json(rows.map(r => r.period));
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ POST /api/competitor ════
  // Manual single upsert
  app.post('/api/competitor', async (req, res) => {
    try {
      const b = req.body || {};
      const rec = {
        comp_type:    b.comp_type === 'hawker' ? 'hawker' : 'agency',
        state_name:   Str(b.state_name),
        unit_code:    Str(b.unit_code),
        unit_name:    Str(b.unit_name),
        agent_code:   Str(b.agent_code),
        agent_name:   Str(b.agent_name),
        period:       Str(b.period),
        our_supply:   N(b.our_supply),
        comp1_name:   Str(b.comp1_name),   comp1_supply: N(b.comp1_supply),
        comp2_name:   Str(b.comp2_name),   comp2_supply: N(b.comp2_supply),
        comp3_name:   Str(b.comp3_name),   comp3_supply: N(b.comp3_supply),
        comp4_name:   Str(b.comp4_name),   comp4_supply: N(b.comp4_supply),
        comp5_name:   Str(b.comp5_name),   comp5_supply: N(b.comp5_supply),
        remarks:      Str(b.remarks),
        data_source:  'manual',
        entered_by:   Str(b.entered_by),
      };
      if (!rec.period.match(/^\d{4}-\d{2}$/) || !rec.unit_code)
        return res.status(400).json({ detail: 'period (YYYY-MM) and unit_code are required' });
      await upsertRecord(rec);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ DELETE /api/competitor/:id ════
  app.delete('/api/competitor/:id', async (req, res) => {
    try {
      await q('DELETE FROM competitor_data WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // Helper: YYYY-MM → { fromDate, toDate } inclusive of the whole month
  function periodDateRange(period) {
    const [y, m] = period.split('-').map(Number);
    const fromDate = `${period}-01`;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const toDate = `${ny}-${String(nm).padStart(2, '0')}-01`;
    return { fromDate, toDate };
  }

  /* Per-agent daily-average supply for a period — direct scan + JS merge.
     NEVER join competitor_data to supply_data/hawker_supply in SQL: the join
     fans out (multiple supply rows per agency-date) and takes minutes; the
     plain GROUP BY over one month runs in ~1s. Returns 'UNIT|CODE' → avg/day. */
  async function agentSupplyMap(type, period) {
    const { fromDate, toDate } = periodDateRange(period);
    const map = {};
    if (type === 'agency') {
      const { rows } = await q(`
        SELECT unit_code, agcd, ROUND(SUM(sup_copy) / COUNT(DISTINCT supply_date)) AS avg_cp
        FROM supply_data
        WHERE supply_date >= ? AND supply_date < ?
          AND sup_type_code = 'S01' AND COALESCE(publ,'') NOT IN ('P14')
        GROUP BY unit_code, agcd`, [fromDate, toDate]);
      rows.forEach(r => { map[`${r.unit_code}|${r.agcd}`] = Number(r.avg_cp) || 0; });
    } else {
      const { rows } = await q(`
        SELECT loc_id, hawker_id,
          MAX(hwk_cent_code) AS cent, MAX(center_incharge) AS ci,
          ROUND(SUM(sup_copies) / COUNT(DISTINCT supply_date)) AS avg_cp
        FROM hawker_supply
        WHERE supply_date >= ? AND supply_date < ?
        GROUP BY loc_id, hawker_id`, [fromDate, toDate]);
      rows.forEach(r => {
        map[`${r.loc_id}|${r.hawker_id}`] = { avg_cp: Number(r.avg_cp) || 0, cent: r.cent, ci: r.ci };
      });
    }
    return map;
  }

  // ════ GET /api/competitor/summary ════
  // Aggregated market-share view for a given type + period
  // If period omitted, uses the latest available.
  app.get('/api/competitor/summary', async (req, res) => {
    try {
      const type = req.query.type === 'hawker' ? 'hawker' : 'agency';
      let period = Str(req.query.period);
      if (!period.match(/^\d{4}-\d{2}$/)) {
        const { rows: lp } = await q(
          `SELECT period FROM competitor_data WHERE comp_type = ? ORDER BY period DESC LIMIT 1`, [type]);
        if (!lp.length) return res.json({ available: false, message: 'No competitor data uploaded yet.' });
        period = lp[0].period;
      }

      const [{ rows: units }, { rows: cdAgents }, supMap] = await Promise.all([
        q(`SELECT unit_code, MAX(unit_name) AS unit_name, MAX(state_name) AS state_name,
            SUM(comp1_supply) AS comp1_supply, MAX(comp1_name) AS comp1_name,
            SUM(comp2_supply) AS comp2_supply, MAX(comp2_name) AS comp2_name,
            SUM(comp3_supply) AS comp3_supply, MAX(comp3_name) AS comp3_name,
            SUM(comp4_supply) AS comp4_supply, MAX(comp4_name) AS comp4_name,
            SUM(comp5_supply) AS comp5_supply, MAX(comp5_name) AS comp5_name,
            COUNT(*) AS agents
          FROM competitor_data
          WHERE comp_type = ? AND period = ?
          GROUP BY unit_code`, [type, period]),
        q(`SELECT unit_code, agent_code FROM competitor_data WHERE comp_type = ? AND period = ?`, [type, period]),
        agentSupplyMap(type, period),
      ]);

      // our_supply per unit = sum of supply daily-averages of ONLY the agents
      // that have a competitor row — apples-to-apples with competitor copies.
      const unitOurs = {};
      cdAgents.forEach(r => {
        const e = supMap[`${r.unit_code}|${r.agent_code}`];
        const v = typeof e === 'object' ? (e ? e.avg_cp : 0) : (e || 0);
        unitOurs[r.unit_code] = (unitOurs[r.unit_code] || 0) + v;
      });
      units.forEach(u => { u.our_supply = unitOurs[u.unit_code] || 0; });

      const compTotals = {};
      for (const r of units) {
        for (let i = 1; i <= 5; i++) {
          const name = r[`comp${i}_name`];
          const copies = Number(r[`comp${i}_supply`] || 0);
          if (name && copies > 0) compTotals[name] = (compTotals[name] || 0) + copies;
        }
      }
      const competitors = Object.entries(compTotals)
        .sort((a, b) => b[1] - a[1])
        .map(([name, total]) => ({ name, total }));

      const totalOurs = units.reduce((s, r) => s + Number(r.our_supply || 0), 0);
      const totalComp = competitors.reduce((s, c) => s + c.total, 0);
      const totalMkt  = totalOurs + totalComp;

      const losing = units
        .map(r => {
          const ours  = Number(r.our_supply || 0);
          const comp  = [1,2,3,4,5].reduce((s, i) => s + Number(r[`comp${i}_supply`] || 0), 0);
          const total = ours + comp;
          return { unit_code: r.unit_code, unit_name: r.unit_name, state_name: r.state_name,
            our_supply: ours, total_market: total,
            share_pct: total > 0 ? Math.round(ours / total * 100) : 100 };
        })
        .filter(r => r.total_market > 0 && r.share_pct < 50)
        .sort((a, b) => a.share_pct - b.share_pct);

      res.json({
        available: true, period, type,
        total_ours: totalOurs, total_market: totalMkt,
        our_share_pct: totalMkt > 0 ? Math.round(totalOurs / totalMkt * 100) : 0,
        competitors, unit_count: units.length, losing_units: losing,
        units: units.map(r => ({ ...r, share_pct: (() => { const c=[1,2,3,4,5].reduce((s,i)=>s+Number(r[`comp${i}_supply`]||0),0); const t=r.our_supply+c; return t>0?Math.round(r.our_supply/t*100):null; })() })),
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });

  // ════ GET /api/competitor/market-share-map ════
  // Per-agency, per-hawker, per-exec, per-CI, per-center market share lookup.
  // Key format: 'UNIT|CODE' for agency/hawker; exec/CI/center code otherwise.
  // Direct scans + JS merge (no supply-table joins); cached 10 min per period.
  const _msMapCache = new Map();
  const MSMAP_TTL = 10 * 60 * 1000;
  app.get('/api/competitor/market-share-map', async (req, res) => {
    try {
      let period = Str(req.query.period);
      if (!period.match(/^\d{4}-\d{2}$/)) {
        const { rows: lp } = await q(
          `SELECT MAX(period) AS period FROM competitor_data WHERE comp_type = 'agency'`);
        if (!lp[0]?.period) return res.json({ available: false });
        period = lp[0].period;
      }

      const hit = _msMapCache.get(period);
      if (hit && Date.now() - hit.ts < MSMAP_TTL) return res.json(hit.data);

      const [{ rows: agCd }, { rows: hwCd }, agSup, hwSup, { rows: amRows }] = await Promise.all([
        q(`SELECT unit_code, agent_code,
             comp1_name, comp1_supply, comp2_name, comp2_supply,
             comp3_name, comp3_supply, comp4_name, comp4_supply,
             comp5_name, comp5_supply
           FROM competitor_data WHERE comp_type='agency' AND period=?`, [period]),
        q(`SELECT unit_code, agent_code,
             comp1_name, comp1_supply, comp2_name, comp2_supply,
             comp3_name, comp3_supply, comp4_name, comp4_supply,
             comp5_name, comp5_supply
           FROM competitor_data WHERE comp_type='hawker' AND period=?`, [period]),
        agentSupplyMap('agency', period),
        agentSupplyMap('hawker', period),
        q(`SELECT unit, agcd, executive_code AS exec_code FROM agency_master`),
      ]);

      const execLookup = {};
      amRows.forEach(r => { execLookup[`${r.unit}|${r.agcd}`] = r.exec_code; });

      const topOf = r => {
        let name = null, copies = 0, comp = 0;
        for (let i = 1; i <= 5; i++) {
          const c = Number(r[`comp${i}_supply`]) || 0;
          comp += c;
          if (c > copies && r[`comp${i}_name`]) { copies = c; name = r[`comp${i}_name`]; }
        }
        return { name, copies, comp };
      };
      const entry = (our, comp, top) => ({
        our_copies: our, total_mkt: our + comp,
        share_pct: (our + comp) > 0 ? Math.round(our / (our + comp) * 100) : null,
        top_comp: top.name, top_comp_copies: top.copies,
      });
      const bump = (dst, key, our, comp) => {
        if (!key) return;
        if (!dst[key]) dst[key] = { our: 0, comp: 0, cnt: 0 };
        dst[key].our += our; dst[key].comp += comp; dst[key].cnt++;
      };
      const shrink = src => {
        const out = {};
        for (const [k, e] of Object.entries(src)) {
          const t = e.our + e.comp;
          out[k] = { our_copies: e.our, total_mkt: t,
            share_pct: t > 0 ? Math.round(e.our / t * 100) : null, n: e.cnt };
        }
        return out;
      };

      // ── Agencies → agency map + by_exec rollup ──
      const agency = {}, byExec = {};
      for (const r of agCd) {
        const key = `${r.unit_code}|${r.agent_code}`;
        const our = Number(agSup[key]) || 0;
        const top = topOf(r);
        agency[key] = entry(our, top.comp, top);
        bump(byExec, execLookup[key], our, top.comp);
      }

      // ── Hawkers → hawker map + by_ci / by_center rollups ──
      const hawker = {}, byCI = {}, byCenter = {};
      for (const r of hwCd) {
        const key = `${r.unit_code}|${r.agent_code}`;
        const sup = hwSup[key];
        const our = sup ? sup.avg_cp : 0;
        const top = topOf(r);
        hawker[key] = entry(our, top.comp, top);
        if (sup) { bump(byCI, sup.ci, our, top.comp); bump(byCenter, sup.cent, our, top.comp); }
      }

      const data = { available: true, period, agency, hawker,
        by_exec: shrink(byExec), by_ci: shrink(byCI), by_center: shrink(byCenter) };
      _msMapCache.set(period, { ts: Date.now(), data });
      res.json(data);
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
