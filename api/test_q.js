const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({path: path.join(__dirname, '..', '.env')});
const cfg = {
  host: process.env.MYSQL_HOST||'localhost',
  port: parseInt(process.env.MYSQL_PORT||'3306'),
  database: process.env.MYSQL_DB||'patrika_vitran',
  user: process.env.MYSQL_USER||'root',
  password: process.env.MYSQL_PASSWORD||'',
  dateStrings: true
};
(async () => {
  const pool = mysql.createPool(cfg);

  const fixes = [
    { period: '2026-05', rec_amt: 588800 },
    { period: '2026-06', rec_amt: 720300 },
    { period: '2026-07', rec_amt: 836300 },
    { period: 'CURRENT', rec_amt: 836300 },
  ];

  for (const { period, rec_amt } of fixes) {
    const [r] = await pool.query(
      "UPDATE agency_outstanding SET rec_amt=? WHERE ag_code='M1442' AND unit_code='BH3' AND period_label=? AND dp_code='0001' AND rec_amt > 1000000000",
      [rec_amt, period]
    );
    console.log(`${period}: updated ${r.affectedRows} row(s) → rec_amt = ${rec_amt}`);
  }

  // Verify
  const [rows] = await pool.query(
    "SELECT period_label, bill_amt, rec_amt FROM agency_outstanding WHERE ag_code='M1442' AND unit_code='BH3' AND dp_code='0001' ORDER BY period_label"
  );
  console.log('\nM1442/BH3 after fix:');
  rows.forEach(r => console.log(JSON.stringify(r)));

  process.exit(0);
})();
