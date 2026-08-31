'use strict';

/**
 * hawker_profile.js — Hawker 360° profile
 *
 * GET /api/hawker-profile/:unit_code/:hawker_id
 *
 * The hawker equivalent of agency_profile.js: one call returns everything the
 * flyout card shows, so clicking a hawker name anywhere in the app opens the
 * same view with the same numbers.
 *
 * hawker_master carries the identity (79 columns synced from Oracle
 * CRM_HAWKER_MASTER); hawker_supply carries what they actually lift. The master
 * is the authority for who the hawker reports to — the supply rows repeat the
 * centre-incharge name per row and can lag a transfer.
 */

module.exports = function registerHawkerProfile({ app, q, getScopeUnitCodes }) {

  const N  = v => Number(v) || 0;
  const R1 = v => Math.round(Number(v) * 10) / 10;
  const fmtDate = d => (d ? String(d).slice(0, 10) : null);

  /* The card answers a person's questions about one hawker, so the groups follow how
     someone actually asks them — who they are, how to reach them, what they distribute,
     what they earn, how they pay — rather than mirroring the 79-column master. Anything
     null is dropped at render, so a sparsely-filled hawker still reads cleanly instead
     of showing a form full of blanks.

     Oracle and the field survey sometimes answer the same question (other_work vs
     other_business); the survey wins because a person went and asked. */
  const CARD_GROUPS = [
    ['Personal', [
      ['dob', 'Date of birth'],
      ['ma', 'Anniversary date'],
      ['marital_status', 'Marital status'],
      ['father_name', "Father's name"],
      ['spouse_name', 'Spouse'],
      ['house_type', 'House'],
      ['family_size', 'Family size'],
      ['family_in_business', 'Family members in this business'],
    ]],
    ['Contact & address', [
      ['mobile_no', 'Mobile'],
      ['whatsappno', 'WhatsApp'],
      ['phone_no', 'Phone'],
      ['email', 'Email id'],
      ['_home_address', 'Home address'],
    ]],
    ['Identity documents', [
      ['adhar_no', 'Aadhaar card number'],
      ['pan_no', 'PAN card number'],
    ]],
    ['Distribution', [
      ['distribution_area', 'Area of distribution'],
      ['beat_boys', 'Number of beat boys'],
      ['copies_self_delivered', 'Copies delivered by himself'],
      ['transport_mode', 'Mode of transport'],
      ['newspapers_carried', 'Total newspapers carried'],
      ['other_newspaper_copies', 'Other newspaper copies'],
    ]],
    ['Income', [
      ['income_newspaper', 'Income from newspaper'],
      ['_other_business', 'Other business'],
      ['income_other_business', 'Income from other business'],
      ['total_income', 'Total income'],
    ]],
    ['Payment behaviour', [
      ['payment_nature', 'Payment nature'],
      ['payment_mode', 'Payment mode'],
    ]],
    ['Posting & reporting', [
      ['unit_name', 'Branch'],
      ['hawker_center_name', 'Centre'],
      ['center_incharge_name', 'Centre incharge'],
      ['field_officer_name', 'Field officer'],
      ['survey_updated_at', 'Surveyed on'],
    ]],
  ];

  app.get('/api/hawker-profile/:unit_code/:hawker_id', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const unitCode = String(req.params.unit_code || '').trim();
      const hawkerId = String(req.params.hawker_id || '').trim();
      if (!unitCode || !hawkerId) return res.status(400).json({ detail: 'unit_code and hawker_id required' });

      if (typeof getScopeUnitCodes === 'function') {
        const allowed = await getScopeUnitCodes(req.auth.personCode, req.auth.hierarchyLevel);
        if (allowed && !allowed.includes(unitCode)) {
          return res.status(403).json({ detail: 'Outside your assigned scope' });
        }
      }

      const { rows: mRows } = await q(
        `SELECT * FROM hawker_master WHERE hawker_id = ? AND unit_code = ? LIMIT 1`,
        [hawkerId, unitCode]);
      // A hawker can move branch; fall back to the id alone rather than 404 on a stale link.
      let master = mRows[0];
      if (!master) {
        const { rows: any } = await q(
          `SELECT * FROM hawker_master WHERE hawker_id = ? LIMIT 1`, [hawkerId]);
        master = any[0];
      }
      if (!master) return res.status(404).json({ detail: 'Hawker not found in master' });

      const unit = master.unit_code || unitCode;

      const [supMonthly, supRecent, supTotals, centrePeers, pubMix] = await Promise.all([
        // 12 months of lifting — the trend line on the card
        q(`SELECT DATE_FORMAT(supply_date,'%Y-%m') month,
                  SUM(sup_copies) copies, COUNT(DISTINCT supply_date) days,
                  SUM(net_amount) amount
           FROM hawker_supply
           WHERE hawker_id = ? AND loc_id = ?
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
           GROUP BY month ORDER BY month DESC LIMIT 12`, [hawkerId, unit]),
        // last 30 supply days, most recent first
        q(`SELECT supply_date, SUM(sup_copies) copies, SUM(net_amount) amount,
                  MAX(gate_pass_no) gate_pass
           FROM hawker_supply
           WHERE hawker_id = ? AND loc_id = ?
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
           GROUP BY supply_date ORDER BY supply_date DESC LIMIT 30`, [hawkerId, unit]),
        q(`SELECT MIN(supply_date) first_supply, MAX(supply_date) last_supply,
                  COUNT(DISTINCT supply_date) total_days, SUM(sup_copies) total_copies
           FROM hawker_supply WHERE hawker_id = ? AND loc_id = ?`, [hawkerId, unit]),
        // how this hawker ranks inside their own centre over the last 30 days
        master.hawker_center_code
          ? q(`SELECT hs.hawker_id, MAX(hs.hawker_name) hawker_name,
                      ROUND(SUM(hs.sup_copies)/NULLIF(COUNT(DISTINCT hs.supply_date),0)) avg_copies
               FROM hawker_supply hs
               WHERE hs.loc_id = ? AND hs.hwk_cent_code = ?
                 AND hs.supply_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
               GROUP BY hs.hawker_id ORDER BY avg_copies DESC`,
             [unit, master.hawker_center_code])
          : Promise.resolve({ rows: [] }),
        // publication / edition split over 30 days
        q(`SELECT COALESCE(pub_name, publ_code) pub, COALESCE(edtn_name, edition_code) edtn,
                  SUM(sup_copies) copies
           FROM hawker_supply
           WHERE hawker_id = ? AND loc_id = ?
             AND supply_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           GROUP BY pub, edtn ORDER BY copies DESC LIMIT 12`, [hawkerId, unit]),
      ]);

      const monthly = supMonthly.rows.map(r => ({
        month: r.month, copies: N(r.copies), days: N(r.days),
        avg_per_day: N(r.days) ? Math.round(N(r.copies) / N(r.days)) : 0,
        amount: N(r.amount),
      }));
      const thisM = monthly[0], lastM = monthly[1];
      const trend_pct = (thisM && lastM && lastM.avg_per_day > 0)
        ? R1((thisM.avg_per_day - lastM.avg_per_day) / lastM.avg_per_day * 100) : null;

      const t = supTotals.rows[0] || {};
      const lastSupply = fmtDate(t.last_supply);
      const daysSince = lastSupply
        ? Math.floor((Date.now() - new Date(lastSupply + 'T00:00:00').getTime()) / 86400000) : null;

      const peers = centrePeers.rows.map((r, i) => ({ ...r, rank: i + 1 }));
      const mine  = peers.find(p => String(p.hawker_id) === String(hawkerId));

      // Group the master fields for display, dropping anything empty.
      const details = CARD_GROUPS.map(([title, fields]) => ({
        title,
        fields: fields
          .map(([k, label]) => {
            let v = master[k];

            /* Composed fields. Oracle scatters the address over eight columns and
               answers "other business" twice (other_work from the ERP, other_business
               from the survey) — a reader wants one line, not the storage layout. */
            if (k === '_home_address') {
              v = [master.hawker_add, master.addr2, master.addr3, master.addr4,
                   master.house_no, master.land_mark, master.town_suburb, master.city,
                   master.pin && /[1-9]/.test(String(master.pin)) ? master.pin : null]
                .map(x => String(x == null ? '' : x).trim())
                .filter(x => x && x !== '0')
                // Oracle repeats the same fragment across columns often enough that an
                // uncollapsed join reads "Sodala, Sodala, Sodala".
                .filter((x, i, a) => a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i)
                .join(', ');
            }
            if (k === '_other_business') v = master.other_business || master.other_work;

            if (v === null || v === undefined || String(v).trim() === '') return null;
            if (k === 'dob' || k === 'ma' || k === 'doa' || k === 'dateofstart') v = fmtDate(v);
            if (k === 'created_dt' || k === 'modify_dt') v = String(v).slice(0, 19).replace('T', ' ');
            if (k === 'survey_updated_at') v = fmtDate(v);
            // Rupee amounts read as money, not bare digits.
            if (['income_newspaper', 'income_other_business', 'total_income'].includes(k)) {
              v = '₹' + Number(v).toLocaleString('en-IN');
            }
            if (k === 'isactive' || k === 'exist') v = String(v).toUpperCase() === 'Y' ? 'Yes' : 'No';
            // Oracle stores 0 where no number was captured — a phone column reading "0"
            // is worse than showing nothing.
            if (['mobile_no', 'phone_no', 'whatsappno', 'pin'].includes(k) &&
                !/[1-9]/.test(String(v))) return null;
            // Tag phone numbers so the card can offer Call / SMS / WhatsApp instead of
            // making someone copy digits out by hand. Normalised to the last 10 digits;
            // anything shorter is a landline or a bad capture and gets no actions.
            if (['mobile_no', 'phone_no', 'whatsappno'].includes(k)) {
              const digits = String(v).replace(/\D/g, '').slice(-10);
              if (digits.length === 10) return { key: k, label, value: String(v), tel: digits };
            }
            return { key: k, label, value: String(v) };
          })
          .filter(Boolean),
      })).filter(g => g.fields.length);

      res.json({
        identity: {
          hawker_id: master.hawker_id, hawker_name: master.hawker_name,
          unit_code: unit, unit_name: master.unit_name,
          hawker_center_code: master.hawker_center_code,
          hawker_center_name: master.hawker_center_name,
          center_incharge_code: master.center_incharge_code,
          center_incharge_name: master.center_incharge_name,
          field_officer_code: master.field_officer_code,
          field_officer_name: master.field_officer_name,
          mobile_no: (master.mobile_no && String(master.mobile_no) !== '0') ? master.mobile_no : null,
          hawker_type: master.hawker_type, catagory: master.catagory,
          is_active: String(master.isactive || '').toUpperCase() === 'Y',
          city: master.city, distribution_area: master.distribution_area,
          // Oracle's name is often an abbreviation; the survey captured what the
          // hawker actually goes by, so show that as the display name when present.
          actual_name: master.actual_name || null,
        },
        survey: master.survey_updated_at ? {
          surveyed_on: fmtDate(master.survey_updated_at),
          payment_nature: master.payment_nature || null,
          payment_mode: master.payment_mode || null,
          total_income: master.total_income == null ? null : N(master.total_income),
          family_size: master.family_size == null ? null : N(master.family_size),
          transport_mode: master.transport_mode || null,
          copies_self_delivered: master.copies_self_delivered == null ? null : N(master.copies_self_delivered),
        } : null,
        metrics: {
          current_avg_per_day: thisM ? thisM.avg_per_day : 0,
          this_month_copies:   thisM ? thisM.copies : 0,
          trend_pct,
          total_copies: N(t.total_copies), total_days: N(t.total_days),
          first_supply: fmtDate(t.first_supply), last_supply: lastSupply,
          days_since_supply: daysSince,
          centre_rank: mine ? mine.rank : null,
          centre_size: peers.length,
        },
        trends: { monthly, recent: supRecent.rows.map(r => ({
          date: fmtDate(r.supply_date), copies: N(r.copies),
          amount: N(r.amount), gate_pass: r.gate_pass || null,
        })) },
        publications: pubMix.rows.map(r => ({ pub: r.pub, edtn: r.edtn, copies: N(r.copies) })),
        centre_peers: peers.slice(0, 15).map(p => ({
          hawker_id: p.hawker_id, hawker_name: p.hawker_name,
          avg_copies: N(p.avg_copies), rank: p.rank,
          is_self: String(p.hawker_id) === String(hawkerId),
        })),
        details,
        // Everything from the master, for anything the grouped view does not cover.
        master,
      });
    } catch (e) {
      res.status(500).json({ detail: String(e.message || e) });
    }
  });

  /* GET /api/hawker-profile/search?q=&unit_code=
     Name/id/mobile lookup so a hawker card can be opened without knowing the unit. */
  app.get('/api/hawker-search', async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ detail: 'Authentication required' });
      const term = String(req.query.q || '').trim();
      if (term.length < 2) return res.json({ rows: [] });
      const unitCode = String(req.query.unit_code || '').trim();
      const where = ['(hawker_name LIKE ? OR hawker_id = ? OR mobile_no = ?)'];
      const params = [`%${term}%`, term, term];
      if (unitCode) { where.push('unit_code = ?'); params.push(unitCode); }
      const { rows } = await q(
        `SELECT hawker_id, hawker_name, unit_code, unit_name, hawker_center_name,
                center_incharge_name, mobile_no, isactive
         FROM hawker_master WHERE ${where.join(' AND ')}
         ORDER BY (isactive='Y') DESC, hawker_name LIMIT 40`, params);
      res.json({ rows });
    } catch (e) { res.status(500).json({ detail: String(e.message || e) }); }
  });
};
