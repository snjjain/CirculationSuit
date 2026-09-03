#!/usr/bin/env bash
#
# monthly_billing_snapshot.sh — the two agency_outstanding snapshots that only make
# sense once a month has closed. Meant to run on the 1st; see install_cron_linux.sh.
#
#   YYYY-MM       cumulative from 1 January to the last day of the closed month.
#                 Differencing two of these gives one month's billing, which is what
#                 the Command Centre falls back to.
#   BILL-YYYY-MM  the ERP's own monthly bill, which is a report *dated the 1st of the
#                 following month* — hence period_from = period_to = today. This is the
#                 authoritative figure and is preferred wherever it exists.
#
# The daily sync pulls only CURRENT, so without this nothing ever writes the closed
# month and "Collection vs Billing" reads "billing not loaded yet" until someone
# remembers to run it by hand. That is exactly what happened for 2026-08.
#
# Usage:
#   ./scripts/monthly_billing_snapshot.sh              # the month that just closed
#   ./scripts/monthly_billing_snapshot.sh 2026-08      # a specific month (backfill)
#
# Safe to re-run: each label is deleted and reloaded, never appended.

set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-$(command -v node)}"
[ -z "$NODE" ] && { echo "node not found in PATH — set NODE=/path/to/node" >&2; exit 1; }

up() { tr '[:lower:]' '[:upper:]'; }

if [ $# -ge 1 ]; then
  # Explicit month: anchor on its first day so the arithmetic below is identical.
  ANCHOR="$1-01"
  LABEL="$1"
  MONTH_END="$(date -d "$ANCHOR +1 month -1 day" '+%d-%b-%Y' | up)"
  # The ERP bill for that month is the report dated the 1st of the month after it.
  BILL_ON="$(date -d "$ANCHOR +1 month" '+%d-%b-%Y' | up)"
  YEAR="$(date -d "$ANCHOR" '+%Y')"
else
  # Default: yesterday is in the month that just closed (this runs on the 1st).
  LABEL="$(date -d 'yesterday' '+%Y-%m')"
  MONTH_END="$(date -d 'yesterday' '+%d-%b-%Y' | up)"
  BILL_ON="$(date '+%d-%b-%Y' | up)"
  YEAR="$(date -d 'yesterday' '+%Y')"
fi
YEAR_START="01-JAN-$YEAR"

echo "=== monthly billing snapshots for $LABEL ==="
echo "  cumulative   : $YEAR_START -> $MONTH_END   (label $LABEL)"
echo "  ERP bill     : report dated $BILL_ON        (label BILL-$LABEL)"

"$NODE" api/oracle_outstanding_sync.js --label "$LABEL"      --from "$YEAR_START" --to "$MONTH_END"
"$NODE" api/oracle_outstanding_sync.js --label "BILL-$LABEL" --from "$BILL_ON"    --to "$BILL_ON"

echo "=== done: $LABEL ==="
