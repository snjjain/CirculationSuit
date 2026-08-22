'use strict';
const express = require('express');
const XLSX    = require('xlsx');

const TEMPLATE_COLS = [
  'Period (YYYY-MM)', 'State', 'Unit Code', 'Unit Name',
  'Agent Code', 'Agent Name', 'Our Copies (Patrika)',
  'Competitor 1 Name', 'Competitor 1 Copies',
  'Competitor 2 Name', 'Competitor 2 Copies',
  'Competitor 3 Name', 'Competitor 3 Copies',
  'Competitor 4 Name', 'Competitor 4 Copies',
  'Competitor 5 Name', 'Competitor 5 Copies',
  'Remarks',
];

function buildTemplate(compType) {
  const sample = compType === 'hawker'
    ? ['2026-08', 'Rajasthan', 'JA0', 'Jaipur City', 'HW001', 'Sample Hawker', 80,
       'Dainik Bhaskar', 60, 'Navbharat Times', 10, '', 0, '', 0, '', 0, '']
    : ['2026-08', 'Rajasthan', 'JA0', 'Jaipur', 'AG001', 'Sample Agency', 150,
       'Dainik Bhaskar', 120, 'Navbharat Times', 30, '', 0, '', 0, '', 0, ''];

  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLS, sample]);
  ws['!cols'] = [14,12,12,20,12,25,14,20,12,20,12,20,12,20,12,20,12,18].map(wch => ({ wch }));

  const instrRows = [
    ['Competitor Data Upload — Instructions'],
    [],
    ['Column', 'Description', 'Required'],
    ['Period (YYYY-MM)', 'Month-year e.g. 2026-08', 'Yes'],
    ['State', 'State name e.g. Rajasthan', 'No'],
    ['Unit Code', 'Unit code from system e.g. JA0', 'Yes'],
    ['Unit Name', 'Label only — auto-filled by system', 'No'],
    ['Agent Code', 'Agency/hawker code. Leave blank for unit-level entry.', 'No'],
    ['Agent Name', 'Label only — auto-filled by system', 'No'],
    ['Our Copies (Patrika)', 'Patrika copies for that agency/unit', 'Yes'],
    ['Competitor N Name', 'Competitor newspaper name e.g. Dainik Bhaskar', 'No'],
    ['Competitor N Copies', 'Competitor copies count', 'No'],
    [],
    ['Notes:'],
    ['• Delete the sample data row before uploading.'],
    ['• Save as .xlsx format (not .csv or .xls).'],
    ['• Up to 5 competitors per row. Leave unused columns blank.'],
    ['• Rows with missing Period or Unit Code are skipped.'],
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
  instrWs['!cols'] = [{ wch: 25 }, { wch: 50 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, compType === 'hawker' ? 'Hawker Data' : 'Agency Data');
  XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

const N = v => { const x = parseInt(v, 10); return isNaN(x) ? 0 : x; };
const Str = v => String(v || '').trim();

function rowToRecord(row, compType, enteredBy) {
  return {
    comp_type:    compType,
    state_name:   Str(row['State']),
    unit_code:    Str(row['Unit Code']),
    unit_name:    Str(row['Unit Name']),
    agent_code:   Str(row['Agent Code']),
    agent_name:   Str(row['Agent Name']),
    period:       Str(row['Period (YYYY-MM)']),
    our_supply:   N(row['Our Copies (Patrika)']),
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
  app.get('/api/competitor/template', (req, res) => {
    const compType = req.query.type === 'hawker' ? 'hawker' : 'agency';
    const buf = buildTemplate(compType);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="competitor_${compType}_template.xlsx"`);
    res.send(buf);
  });

  // ════ POST /api/competitor/upload ════
  // Frontend sends raw xlsx bytes as application/octet-stream
  app.post('/api/competitor/upload',
    express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], limit: '10mb' }),
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
          try {
            await upsertRecord(rowToRecord(row, compType, enteredBy));
            inserted++;
          } catch (e) {
            errors.push(`${unitCode}/${Str(row['Agent Code'])}/${period}: ${e.message}`);
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

      const { rows: units } = await q(`
        SELECT unit_code, unit_name, state_name,
          SUM(our_supply)   AS our_supply,
          SUM(comp1_supply) AS comp1_supply, MAX(comp1_name) AS comp1_name,
          SUM(comp2_supply) AS comp2_supply, MAX(comp2_name) AS comp2_name,
          SUM(comp3_supply) AS comp3_supply, MAX(comp3_name) AS comp3_name,
          SUM(comp4_supply) AS comp4_supply, MAX(comp4_name) AS comp4_name,
          SUM(comp5_supply) AS comp5_supply, MAX(comp5_name) AS comp5_name,
          COUNT(*)          AS agents
        FROM competitor_data
        WHERE comp_type = ? AND period = ?
        GROUP BY unit_code, unit_name, state_name
        ORDER BY our_supply DESC`, [type, period]);

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
        competitors, unit_count: units.length, losing_units: losing, units,
      });
    } catch (e) { res.status(500).json({ detail: String(e) }); }
  });
};
