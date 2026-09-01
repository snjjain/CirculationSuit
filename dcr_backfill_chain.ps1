Set-Location "E:\PatrikaAI\Patrika Apps\patrika-app"
$log = "E:\PatrikaAI\Patrika Apps\patrika-app\dcr_backfill_log.txt"
"=== DCR Backfill Chain started $(Get-Date) ===" | Out-File $log -Encoding utf8

$periods = @(
  @{from="2026-07-01"; to="2026-07-31"; label="Jul 2026 (retry)"},
  @{from="2026-08-01"; to="2026-08-27"; label="Aug 2026 (current month)"},
  @{from="2026-01-01"; to="2026-03-31"; label="Jan-Mar 2026"},
  @{from="2025-10-01"; to="2025-12-31"; label="Oct-Dec 2025"},
  @{from="2025-07-01"; to="2025-09-30"; label="Jul-Sep 2025"},
  @{from="2025-04-01"; to="2025-06-30"; label="Apr-Jun 2025"},
  @{from="2025-01-01"; to="2025-03-31"; label="Jan-Mar 2025"},
  @{from="2024-10-01"; to="2024-12-31"; label="Oct-Dec 2024"},
  @{from="2024-07-01"; to="2024-09-30"; label="Jul-Sep 2024"},
  @{from="2024-04-01"; to="2024-06-30"; label="Apr-Jun 2024"},
  @{from="2024-01-01"; to="2024-03-31"; label="Jan-Mar 2024"},
  @{from="2023-10-01"; to="2023-12-31"; label="Oct-Dec 2023"},
  @{from="2023-07-01"; to="2023-09-30"; label="Jul-Sep 2023"},
  @{from="2023-04-01"; to="2023-06-30"; label="Apr-Jun 2023"},
  @{from="2023-01-01"; to="2023-03-31"; label="Jan-Mar 2023"}
)

foreach ($p in $periods) {
  $started = Get-Date
  "[$started] Starting: $($p.label) ($($p.from) to $($p.to))" | Out-File $log -Append -Encoding utf8
  Write-Host "Starting: $($p.label)"

  $result = & node api/oracle_dcr_sync.js --from $p.from --to $p.to 2>&1
  $exit = $LASTEXITCODE
  $ended = Get-Date
  $duration = [math]::Round(($ended - $started).TotalSeconds)

  "[$ended] Done: $($p.label) exit=$exit duration=${duration}s" | Out-File $log -Append -Encoding utf8
  $result | Out-File $log -Append -Encoding utf8
  "---" | Out-File $log -Append -Encoding utf8

  if ($exit -ne 0) {
    "ERROR: $($p.label) failed with exit $exit — stopping chain" | Out-File $log -Append -Encoding utf8
    Write-Host "ERROR: $($p.label) failed — check dcr_backfill_log.txt"
    break
  }
  Write-Host "Done: $($p.label) in ${duration}s"
  # Brief pause between periods to let spool file release
  Start-Sleep -Seconds 3
}

"=== DCR Backfill Chain ended $(Get-Date) ===" | Out-File $log -Append -Encoding utf8
Write-Host "=== Backfill chain complete ==="
