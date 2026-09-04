/**
 * collection_basis.js — the one definition of "collection %" in this suite.
 *
 * Recovery is the ERP's net receipt over the ERP's own bill, both read as the movement
 * between two consecutive cumulative snapshots of agency_outstanding:
 *
 *     bill        = Δ bill_amt
 *     net receipt = Δ (rec_amt + other_cr)      money banked + credit notes/adjustments
 *
 * Verified against the ERP to the rupee: for JA0 the movement from the 2026-07 to the
 * 2026-08 snapshot gives 76,53,837, which is exactly what the ERP's own BILL-2026-07
 * report says; for SHAKIR KHAN it gives 25,58,065 billed and 18,78,037 received — 73.4%,
 * the figure management quoted.
 *
 * Two traps this exists to prevent:
 *
 *   agency_collection is NOT the numerator. It records banked cash transactions only,
 *   so it omits credit notes and adjustments and runs materially lower — 13.5 L against
 *   18.8 L for that same executive, which read as 53% instead of 73%.
 *
 *   collected / (collected + outstanding) is a different question entirely — what share
 *   of the total dues has been cleared, not how much of this month's bill came in.
 *   Executive Performance used it while the Command Centre used recovery, so the same
 *   label showed ~7% on one screen and 73% on another for the same person.
 *
 * A month with no snapshot pair is reported as missing rather than counted as zero: a
 * bill the ERP has not written yet is not a bill of nought.
 */
module.exports = function installCollectionBasis({ q }) {
  const N = v => Number(v) || 0;
  const pad = n => String(n).padStart(2, '0');

  /* The months whose ledger movement covers [from, to]. Money banked during August is
     the movement from the July snapshot to the August one, and that same pair's bill
     movement is the bill raised on 1 August — which the ERP labels BILL-2026-07. Taking
     both from one pair is what keeps the two halves of the ratio consistent. */
  function monthsIn(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return [];
    const f = new Date(from + 'T00:00:00'), t = new Date(to + 'T00:00:00');
    const out = [];
    let cur = new Date(f.getFullYear(), f.getMonth(), 1);
    const end = new Date(t.getFullYear(), t.getMonth(), 1);
    while (cur <= end && out.length < 36) {
      const p = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
      out.push({
        label: `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`,
        prev:  `${p.getFullYear()}-${pad(p.getMonth() + 1)}`,
      });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return out;
  }

  /**
   * @param {string}   from        YYYY-MM-DD
   * @param {string}   to          YYYY-MM-DD
   * @param {string[]} unitCodes   optional scope
   * @param {'exec'|'unit'|'agency'} groupBy
   * @returns {{ by: Map, totals: {billed,net_receipt}, months_used: string[],
   *             months_missing: string[], known: boolean }}
   */
  async function basis({ from, to, unitCodes, groupBy = 'exec' }) {
    const empty = { by: new Map(), totals: { billed: 0, net_receipt: 0 },
                    months_used: [], months_missing: [], known: false };
    const months = monthsIn(from, to);
    if (!months.length) return empty;

    const labels = [...new Set(months.flatMap(m => [m.label, m.prev]))];
    const scoped = Array.isArray(unitCodes) && unitCodes.length;
    const keyExpr = groupBy === 'unit' ? 'unit_code'
                  : groupBy === 'agency' ? "CONCAT(unit_code,'|',ag_code)"
                  : 'exec_code';

    const { rows } = await q(
      `SELECT period_label, ${keyExpr} k,
              SUM(bill_amt) b, SUM(rec_amt) + SUM(other_cr) r
         FROM agency_outstanding
        WHERE period_label IN (${labels.map(() => '?').join(',')})
        ${scoped ? `AND unit_code IN (${unitCodes.map(() => '?').join(',')})` : ''}
        GROUP BY period_label, ${keyExpr}`,
      [...labels, ...(scoped ? unitCodes : [])]);

    const at = new Map();          // "label|key" -> { b, r }
    const keys = new Set();
    const present = new Set();
    rows.forEach(x => {
      if (x.k == null || x.k === '') return;
      present.add(x.period_label);
      keys.add(x.k);
      at.set(`${x.period_label}|${x.k}`, { b: N(x.b), r: N(x.r) });
    });

    const by = new Map();
    const months_used = [], months_missing = [];
    months.forEach(m => {
      // Both ends of the pair are needed; one alone says nothing about the movement.
      if (!present.has(m.label) || !present.has(m.prev)) { months_missing.push(m.label); return; }
      months_used.push(m.label);
      keys.forEach(k => {
        const cur = at.get(`${m.label}|${k}`) || { b: 0, r: 0 };
        const prv = at.get(`${m.prev}|${k}`)  || { b: 0, r: 0 };
        const e = by.get(k) || { billed: 0, net_receipt: 0 };
        e.billed      += Math.max(0, cur.b - prv.b);
        e.net_receipt += Math.max(0, cur.r - prv.r);
        by.set(k, e);
      });
    });

    const totals = [...by.values()].reduce(
      (a, e) => ({ billed: a.billed + e.billed, net_receipt: a.net_receipt + e.net_receipt }),
      { billed: 0, net_receipt: 0 });

    return { by, totals, months_used, months_missing, known: months_used.length > 0 };
  }

  /** Recovery percentage, or null when there is no bill to measure against. */
  const pctOf = e => (e && e.billed > 0)
    ? Math.round((e.net_receipt / e.billed) * 1000) / 10
    : null;

  return { basis, monthsIn, pctOf };
};
