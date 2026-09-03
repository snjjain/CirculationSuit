#!/usr/bin/env bash
#
# hawker_backfill.sh — reload hawker_supply history after the uq_hwk key fix.
#
# Why this exists: the old unique key stopped at edition_code, so a second gate pass for
# the same hawker/day/edition overwrote the first instead of adding to it. Every month
# loaded before that fix is short. Widening the key does not repair what was already
# dropped — the rows have to come back from Oracle.
#
# Usage (on the server, as the user that runs the app):
#   cd /path/to/patrika-app && git pull
#   chmod +x scripts/hawker_backfill.sh
#   ./scripts/hawker_backfill.sh                  # 2020-03-18 -> 2026-05-31, newest first
#   ./scripts/hawker_backfill.sh 2024-01-01 2024-12-31
#
# It detaches with nohup, so closing the terminal or losing the VPN does not stop it.
#
# Resumable by design. Each month is marked complete in hawker_supply_sync_log as it
# lands, and a re-run skips what is already done — so if Oracle drops the connection, or
# the password changes mid-run, just run it again and it carries on from where it
# stopped. That is also why it does NOT pass --force: force would ignore those marks and
# restart from the beginning every time.
#
# Newest month first, because recent months are the ones being reported on.

set -euo pipefail
cd "$(dirname "$0")/.."

FROM="${1:-2020-03-18}"
TO="${2:-2026-05-31}"
NODE="${NODE:-$(command -v node)}"
LOG="logs/hawker_backfill_$(date +%Y%m%d_%H%M%S).log"
mkdir -p logs

if [ -z "$NODE" ]; then echo "node not found in PATH — set NODE=/path/to/node" >&2; exit 1; fi

echo "Backfilling hawker_supply $FROM -> $TO (newest month first)"
echo "Log: $LOG"

nohup "$NODE" api/hawker_supply_sync.js --from "$FROM" --to "$TO" --reverse >> "$LOG" 2>&1 &
PID=$!
echo "$PID" > logs/hawker_backfill.pid
echo "Started as PID $PID (detached)."
echo
echo "  progress : grep -avE 'Inserted [0-9]+/' $LOG | tail -20"
echo "  still on : ps -p $PID >/dev/null && echo running || echo finished"
echo "  stop     : kill $PID        # safe — re-run this script to resume"
