#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Master script — registers ALL Patrika data sync tasks in Windows Task Scheduler.
  Run once as Administrator, or double-click scripts\install_tasks.bat.
  Safe to re-run (existing tasks are replaced).

  Schedule (IST):
    04:30 AM  daily         — PatrikaEmpMobileSync      (user/mobile account refresh)
    05:00 AM  daily         — PatrikaSupplySync_Daily    (agent supply — yesterday)
    05:20 AM  daily         — PatrikaHawkerSupplySync    (hawker/cash sale — yesterday)
    05:40 AM  daily         — PatrikaAgencySync_Daily    (agency master incremental)
    06:15 AM  daily         — PatrikaCollectionSync      (collection receipts)
    06:30 AM  daily         — PatrikaOutstandingSync     (agency outstanding balances)
    07:00 AM  daily         — PatrikaDCRSync             (field attendance & visits)
    07:30 AM  daily         — PatrikaSurveySync          (CRM survey — incremental)
    07:45 AM  daily         — PatrikaExecHierarchySync   (PLI exec hierarchy)
    09:30 AM  daily         — PatrikaOracleSync          (taxi — backfill + today; all routes done by 8 AM)
    02:00 AM  Sunday        — PatrikaAgencySync_Weekly   (agency master full sync)

.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_all_sync_tasks.ps1
#>

$Node   = (Get-Command node -ErrorAction Stop).Source
$ApiDir = Resolve-Path (Join-Path $PSScriptRoot "..\api")
$LogDir = Resolve-Path (Join-Path $PSScriptRoot "..\logs")
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

function MakeSettings($hours = 1) {
    New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours $hours) `
        -MultipleInstances IgnoreNew `
        -RestartCount 2 `
        -RestartInterval (New-TimeSpan -Minutes 15)
}

function Reg($name, $script, $args_, $trigger, $hours = 1) {
    $sp  = Join-Path $ApiDir $script
    $arg = if ($args_) { "`"$sp`" $args_" } else { "`"$sp`"" }
    $action = New-ScheduledTaskAction -Execute $Node -Argument $arg -WorkingDirectory $ApiDir
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Settings (MakeSettings $hours) -Principal $Principal -Force | Out-Null
    Write-Host ("  [OK] {0,-32} Next: {1}" -f $name, (Get-ScheduledTaskInfo $name).NextRunTime.ToString("ddd HH:mm"))
}

Write-Host ""
Write-Host "Registering all Patrika sync tasks..." -ForegroundColor Cyan
Write-Host ""

# Monthly (daily check — script is idempotent, auto-skips on non-1st if no new users)
Reg "PatrikaEmpMobileSync"     "oracle_emp_mobile_sync.js"   ""            (New-ScheduledTaskTrigger -Daily -At "04:30AM")

# Supply chain
Reg "PatrikaSupplySync_Daily"  "supply_sync.js"              ""            (New-ScheduledTaskTrigger -Daily -At "05:00AM")
Reg "PatrikaHawkerSupplySync"  "hawker_supply_sync.js"       ""            (New-ScheduledTaskTrigger -Daily -At "05:20AM")
Reg "PatrikaAgencySync_Daily"  "agency_master_sync.js"       ""            (New-ScheduledTaskTrigger -Daily -At "05:40AM")

# Data syncs
Reg "PatrikaCollectionSync"    "collection_sync.js"          ""            (New-ScheduledTaskTrigger -Daily -At "06:15AM") 2
Reg "PatrikaOutstandingSync"   "oracle_outstanding_sync.js"  ""            (New-ScheduledTaskTrigger -Daily -At "06:30AM") 3
Reg "PatrikaDCRSync"           "oracle_dcr_sync.js"          ""            (New-ScheduledTaskTrigger -Daily -At "07:00AM")
Reg "PatrikaSurveySync"        "oracle_survey_sync.js"       "--from-last" (New-ScheduledTaskTrigger -Daily -At "07:30AM") 2
Reg "PatrikaExecHierarchySync" "oracle_exec_hierarchy_sync.js" ""          (New-ScheduledTaskTrigger -Daily -At "07:45AM")

# Taxi: 9:30 AM — all routes done by 8 AM; backfills missed days automatically
Reg "PatrikaOracleSync"        "taxi_sync_daily.js"          ""            (New-ScheduledTaskTrigger -Daily -At "09:30AM") 2

# Weekly full agency refresh
Reg "PatrikaAgencySync_Weekly" "agency_master_sync.js"       "--full"      (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "02:00AM") 2

Write-Host ""
Write-Host "All tasks registered successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.TaskName -like 'Patrika*' } | Sort-Object TaskName | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -ErrorAction SilentlyContinue
    $next = if ($info -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString("ddd yyyy-MM-dd HH:mm") } else { "—" }
    $last = if ($info -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString("MM-dd HH:mm") } else { "never" }
    "  {0,-32} Next={1}  Last={2}" -f $_.TaskName, $next, $last
}
