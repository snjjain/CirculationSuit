'use strict';
// Wrapper: loads env then runs DCR backfill
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { runSync } = require('./api/oracle_dcr_sync');

runSync({ backfill: true })
  .then(r => { console.log('[dcr-sync] DONE:', JSON.stringify(r)); process.exit(0); })
  .catch(e => { console.error('[dcr-sync] ERR:', e.message); process.exit(1); });
