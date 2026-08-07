#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers two Windows Task Scheduler tasks for agency_master_sync.js:
    PatrikaAgencySync_Daily   — incremental, every day at 06:30 AM
    PatrikaAgencySync_Weekly  — full sync,   every Sunday at 02:00 AM

.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_agency_sync_task.ps1
#>

$Node      = (Get-Command node -ErrorAction Stop).Source
$Script    = Resolve-Path (Join-Path $PSScriptRoot "..\api\agency_master_sync.js")
$WorkDir   = Split-Path $Script -Parent
$LogDir    = Join-Path $WorkDir "..\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit  (New-TimeSpan -Hours 2) `
    -MultipleInstances   IgnoreNew `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false

# ── Task 1: Daily incremental at 06:30 ───────────────────────────────────────
$DailyName    = "PatrikaAgencySync_Daily"
$DailyAction  = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`"" `
    -WorkingDirectory $WorkDir
$DailyTrigger = New-ScheduledTaskTrigger -Daily -At "06:30"

Unregister-ScheduledTask -TaskName $DailyName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $DailyName `
    -Action      $DailyAction `
    -Trigger     $DailyTrigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Agency master incremental sync from Oracle (changed rows only)" `
    -Force | Out-Null
Write-Host "Registered: $DailyName  (daily 06:30 — incremental)"

# ── Task 2: Weekly full sync on Sunday at 02:00 ───────────────────────────────
$WeeklyName    = "PatrikaAgencySync_Weekly"
$WeeklyAction  = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`" --full" `
    -WorkingDirectory $WorkDir
$WeeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "02:00"

Unregister-ScheduledTask -TaskName $WeeklyName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $WeeklyName `
    -Action      $WeeklyAction `
    -Trigger     $WeeklyTrigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Agency master full sync from Oracle (TRUNCATE + INSERT, catches deletions)" `
    -Force | Out-Null
Write-Host "Registered: $WeeklyName  (Sunday 02:00 — full)"

Write-Host ""
Write-Host "To test incremental now:"
Write-Host "  Start-ScheduledTask -TaskName '$DailyName'"
Write-Host ""
Write-Host "To test full sync now:"
Write-Host "  Start-ScheduledTask -TaskName '$WeeklyName'"
Write-Host ""
Write-Host "Check last run:"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$DailyName' | Select LastRunTime, LastTaskResult"
