const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({path: path.join(__dirname, '..', '.env')});
const cfg = {
  host: process.env.MYSQL_HOST||'localhost',
  port: parseInt(process.env.MYSQL_PORT||'3306'),
  database: process.env.MYSQL_DB||'patrika_vitran',
  user: process.env.MYSQL_USER||'root',
  password: process.env.MYSQL_PASSWORD||'',
  multipleStatements: true
};

const DATA = [
  ['RP001','AHMEDABAD',    'AH0','AH0'],
  ['RP001','AJMER',        'AJ0','AJ0'],
  ['RP001','ALWAR',        'AL0','AL0'],
  ['RP001','BANGLORE',     'BA1','BA1'],
  ['RP001','BANSWARA',     'BA0','BA0'],
  ['RP001','BARMER',       'BA2','BA2'],
  ['RP001','BHILAI PT',    'BH2','BH1'],
  ['RP001','BHILWARA',     'BH0','BH0'],
  ['RP001','BHOPAL PT',    'BH1','PA0'],
  ['RP001','BIKANER',      'BI0','BI0'],
  ['RP001','BILASPUR PT',  'BI1','BI1'],
  ['RP001','CHENNAI',      'CH0','CH0'],
  ['RP001','CHHINDWARA PT','SE0','SE0'],
  ['RP001','COIMBATORE',   'CO0','CO0'],
  ['RP001','DELHI PT',     'DE0','DE1'],
  ['RP001','GANGAPUR CITY','GA0','GA0'],
  ['RP001','GWALIOR PT',   'GW0','GW0'],
  ['RP001','HUBLI',        'HU0','HU0'],
  ['RP001','INDORE NT',    'NE0','NE0'],
  ['RP001','INDORE PT',    'IN0','PA1'],
  ['RP001','JABALPUR PT',  'JA1','JA2'],
  ['RP001','JAGDALPUR PT', 'JA8','JA5'],
  ['RP001','JAIPUR',       'JA0','JA0'],
  ['RP001','JAIPUR DN',    'DA0','JA1'],
  ['RP001','JAIPUR NT',    'NE1','NE1'],
  ['RP001','JHUNJHUNU',    'JH1','JH1'],
  ['RP001','JODHPUR',      'JO0','JO0'],
  ['RP001','KHANDWA PT',   'KH0','KH0'],
  ['RP001','KOLKATA RP',   'KO1','KO1'],
  ['RP001','KOTA',         'KO0','KO0'],
  ['RP001','MANDSAUR PT',  'MA0','MA0'],
  ['RP001','MUMBAI OFFICE','MU1','MU2'],
  ['RP001','PALI',         'PA0','PA2'],
  ['RP001','RAIPUR PT',    'RA1','RA0'],
  ['RP001','RAJGARH RP',   'RA2','RA3'],
  ['RP001','RATLAM PT',    'RA0','RA1'],
  ['RP001','SAGAR PT',     'SA1','SA1'],
  ['RP001','SATNA PT',     'SA0','SA0'],
  ['RP001','SIKAR',        'SI0','SI0'],
  ['RP001','SRI GANGANAGAR','SR0','SR0'],
  ['RP001','SURAT',        'SU0','SU0'],
  ['RP001','UDAIPUR',      'UD0','UD0'],
  ['RP001','UJJAIN RP',    'UJ0','UJ0'],
  ['RP001','BHARATPUR',    'BH3','BH3'],
];

(async () => {
  const conn = await mysql.createConnection(cfg);
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS pub_unit_master (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        comp_code    VARCHAR(10)  NOT NULL,
        unit_name    VARCHAR(100) NOT NULL,
        unit_code    VARCHAR(10)  NOT NULL,
        branch_code  VARCHAR(10)  NOT NULL,
        UNIQUE KEY uk_comp_unit   (comp_code, unit_code),
        UNIQUE KEY uk_comp_branch (comp_code, branch_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('Table pub_unit_master created/verified.');

    await conn.query('DELETE FROM pub_unit_master WHERE comp_code = ?', ['RP001']);

    for (const [comp_code, unit_name, unit_code, branch_code] of DATA) {
      await conn.query(
        'INSERT INTO pub_unit_master (comp_code, unit_name, unit_code, branch_code) VALUES (?,?,?,?)',
        [comp_code, unit_name, unit_code, branch_code]
      );
    }
    console.log(`Inserted ${DATA.length} rows.`);

    // Verify the mismatches
    const [rows] = await conn.query(
      'SELECT unit_name, unit_code, branch_code FROM pub_unit_master WHERE unit_code != branch_code AND comp_code=? ORDER BY unit_name',
      ['RP001']
    );
    console.log(`\nUnits where branch_code != unit_code (${rows.length} rows):`);
    rows.forEach(r => console.log(`  ${r.unit_name.padEnd(20)} unit=${r.unit_code}  branch=${r.branch_code}`));
  } finally {
    await conn.end();
  }
})();
