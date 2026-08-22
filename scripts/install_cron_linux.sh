#!/usr/bin/env bash
#
# install_cron_linux.sh — registers ALL Patrika data sync cron jobs on a Linux server.
# Linux equivalent of scripts/register_all_sync_tasks.ps1 (same IST schedule).
#
# Usage (on the server, as the user that runs the app):
#   cd /path/to/patrika-app && git pull
#   chmod +x scripts/install_cron_linux.sh
#   ./scripts/install_cron_linux.sh
#
# Safe to re-run: replaces its own block in the crontab (marker-delimited).
#
# Schedule (IST — converted automatically to the server's local timezone;
# IST has no DST so the conversion never drifts):
#   04:30 daily   oracle_emp_mobile_sync.js      user/mobile account refresh
#   05:00 daily   supply_sync.js                 agent supply (yesterday)
#   05:20 daily   hawker_supply_sync.js          hawker/cash sale (yesterday)
#   05:40 daily   agency_master_sync.js          agency master incremental
#   06:15 daily   collection_sync.js             collection receipts
#   06:30 daily   oracle_outstanding_sync.js     agency outstanding balances
#   07:00 daily   oracle_dcr_sync.js             field attendance & visits
#   07:30 daily   oracle_survey_sync.js --from-last   CRM survey incremental
#   07:45 daily   oracle_exec_hierarchy_sync.js  PLI exec hierarchy
#   09:30 daily   taxi_sync_daily.js             taxi (auto-backfills missed days)
#   10:00-12:00 every 30min   oracle_tour_plan_sync.js -> tour_plan_daily_notify.js
#                             submitted tour plans + AI audit pushed to Circulation Incharges
#   02:00 Sunday  agency_master_sync.js --full   weekly full agency refresh
#
# Requirements on the server:
#   - node in PATH (or edit NODE below)
#   - Oracle Instant Client sqlplus, with SQLPLUS_PATH=<full path> in the app .env
#   - api/node_modules installed (already true if the API runs here)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_DIR/api"
LOG_DIR="$REPO_DIR/logs"
NODE="$(command -v node || true)"
MARK_BEGIN="# PATRIKA-SYNC BEGIN (managed by install_cron_linux.sh - do not edit inside)"
MARK_END="# PATRIKA-SYNC END"

[ -n "$NODE" ] || { echo "ERROR: node not found in PATH"; exit 1; }
[ -d "$API_DIR" ] || { echo "ERROR: api dir not found at $API_DIR"; exit 1; }
mkdir -p "$LOG_DIR"

# ── Oracle access check: node-oracledb driver OR sqlplus binary ──────────────
if [ -d "$API_DIR/node_modules/oracledb" ]; then
  echo "Oracle access OK: node-oracledb driver installed (thick mode via Instant Client Basic)"
  grep -q '^ORACLE_CLIENT_LIB_DIR=' "$REPO_DIR/.env" 2>/dev/null || {
    echo "  NOTE: set ORACLE_CLIENT_LIB_DIR=/path/to/instantclient in $REPO_DIR/.env"
    echo "        (or ensure LD_LIBRARY_PATH contains the instantclient dir)"
  }
else
  SQLPLUS_FROM_ENV="$(grep -E '^SQLPLUS_PATH=' "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  if [ -n "$SQLPLUS_FROM_ENV" ] && [ -x "$SQLPLUS_FROM_ENV" ]; then
    echo "sqlplus OK: $SQLPLUS_FROM_ENV (from .env)"
  elif command -v sqlplus >/dev/null 2>&1; then
    SP="$(command -v sqlplus)"
    echo "sqlplus found at $SP but SQLPLUS_PATH is not set in $REPO_DIR/.env"
    echo "  -> add this line to .env:  SQLPLUS_PATH=$SP"
    exit 1
  else
    echo "ERROR: no Oracle access. Either run 'npm i oracledb' in $API_DIR (recommended,"
    echo "uses Instant Client Basic already at /opt/oracle) OR install the sqlplus"
    echo "package and set SQLPLUS_PATH in $REPO_DIR/.env. Then re-run."
    exit 1
  fi
fi

# ── IST -> server-local time conversion (GNU date) ───────────────────────────
ist() { date -d "TZ=\"Asia/Kolkata\" $1" "+$2"; }

entry() {  # entry "HH:MM-IST" "jobname" "script.js [args]"
  local t="$1" name="$2" cmd="$3"
  local H M
  H="$(ist "$t" %H)"; M="$(ist "$t" %M)"
  echo "$M $H * * * cd '$API_DIR' && flock -n /tmp/patrika_${name}.lock $NODE $cmd >> '$LOG_DIR/cron_${name}.log' 2>&1"
}

weekly_entry() {  # weekly_entry "next Sunday HH:MM" "jobname" "script.js [args]"
  local t="$1" name="$2" cmd="$3"
  local H M W
  H="$(ist "$t" %H)"; M="$(ist "$t" %M)"; W="$(ist "$t" %w)"
  echo "$M $H * * $W cd '$API_DIR' && flock -n /tmp/patrika_${name}.lock $NODE $cmd >> '$LOG_DIR/cron_${name}.log' 2>&1"
}

chained_entry() {  # chained_entry "HH:MM-IST" "jobname" "script1.js [args]" "script2.js [args]"
  # Runs script1 then script2 in sequence (&&) under one lock+log — used when
  # the second script needs data the first one just synced.
  local t="$1" name="$2" cmd1="$3" cmd2="$4"
  local H M
  H="$(ist "$t" %H)"; M="$(ist "$t" %M)"
  echo "$M $H * * * cd '$API_DIR' && flock -n /tmp/patrika_${name}.lock bash -c '$NODE $cmd1 && $NODE $cmd2' >> '$LOG_DIR/cron_${name}.log' 2>&1"
}

BLOCK="$MARK_BEGIN
SHELL=/bin/bash
$(entry "04:30" "emp_mobile"     "oracle_emp_mobile_sync.js")
$(entry "04:45" "hawker_master"  "oracle_hawker_master_sync.js")
$(entry "05:00" "supply"         "supply_sync.js")
$(entry "05:20" "hawker"         "hawker_supply_sync.js")
$(entry "05:40" "agency"         "agency_master_sync.js")
$(entry "06:15" "collection"     "collection_sync.js")
$(entry "06:30" "outstanding"    "oracle_outstanding_sync.js")
$(entry "07:00" "dcr"            "oracle_dcr_sync.js")
$(entry "07:30" "survey"         "oracle_survey_sync.js --from-last")
$(entry "07:45" "exec_hierarchy" "oracle_exec_hierarchy_sync.js")
$(entry "09:30" "taxi"           "taxi_sync_daily.js")
$(chained_entry "10:00" "tour_plan_1000" "oracle_tour_plan_sync.js" "tour_plan_daily_notify.js")
$(chained_entry "10:30" "tour_plan_1030" "oracle_tour_plan_sync.js" "tour_plan_daily_notify.js")
$(chained_entry "11:00" "tour_plan_1100" "oracle_tour_plan_sync.js" "tour_plan_daily_notify.js")
$(chained_entry "11:30" "tour_plan_1130" "oracle_tour_plan_sync.js" "tour_plan_daily_notify.js")
$(chained_entry "12:00" "tour_plan_1200" "oracle_tour_plan_sync.js" "tour_plan_daily_notify.js")
$(weekly_entry "next Sunday 02:00" "agency_full" "agency_master_sync.js --full")
$MARK_END"

# ── install: replace existing managed block, keep everything else ────────────
EXISTING="$(crontab -l 2>/dev/null || true)"
CLEANED="$(printf '%s\n' "$EXISTING" | sed "/^$(printf '%s' "$MARK_BEGIN" | sed 's/[][\/.*()]/\\&/g')\$/,/^$MARK_END\$/d")"
printf '%s\n\n%s\n' "$CLEANED" "$BLOCK" | sed '/./,$!d' | crontab -

echo ""
echo "Installed. Server timezone: $(date +%Z) — IST times converted accordingly."
echo "Crontab now contains:"
crontab -l | sed -n "/PATRIKA-SYNC BEGIN/,/PATRIKA-SYNC END/p"
echo ""
echo "Logs: $LOG_DIR/cron_<job>.log"
echo "Test one sync now:  cd '$API_DIR' && node supply_sync.js"
