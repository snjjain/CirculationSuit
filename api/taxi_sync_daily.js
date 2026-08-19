/**
 * Daily taxi sync wrapper — runs at 9:30 AM after all taxi routes complete by 8 AM.
 * Syncs from last loaded date up to today (backfills any missed days automatically).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const today = new Date().toISOString().slice(0, 10);
const script = path.join(__dirname, 'oracle_bulk_sync.js');

console.log(`[taxi-sync] Daily run: --from-last --to ${today}`);
const result = spawnSync(process.execPath, [script, '--from-last', '--to', today], {
  stdio: 'inherit',
  cwd: __dirname,
});
process.exit(result.status || 0);
