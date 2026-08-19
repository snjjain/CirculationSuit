#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers the monthly employee mobile sync task (PatrikaEmpMobileSync).
  Runs on the 1st of every month at 04:30 AM — syncs Oracle hr_emp_mst.MOBILE
  → MySQL app_users (seeds / refreshes login accounts from hierarchy).
.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_emp_mobile_sync_task.ps1
#>

$Node     = (Get-Command node -ErrorAction Stop).Source
$Script   = Resolve-Path (Join-Path $PSScriptRoot "..\api\oracle_emp_mobile_sync.js")
$WorkDir  = Split-Path $Script -Parent
$LogDir   = Join-Path $WorkDir "..\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit  (New-TimeSpan -Hours 1) `
    -MultipleInstances   IgnoreNew `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false

$TaskName = "PatrikaEmpMobileSync"

# Monthly trigger: 1st of each month at 04:30 AM
# Windows Task Scheduler doesn't have a direct "1st of month" trigger in New-ScheduledTaskTrigger,
# so we use -Monthly with all months and day 1.
$Trigger = New-ScheduledTaskTrigger `
    -Monthly `
    -DaysOfMonth 1 `
    -MonthsOfYear January,February,March,April,May,June,July,August,September,October,November,December `
    -At "04:30AM"

$Action = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`"" `
    -WorkingDirectory $WorkDir

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Monthly Oracle hr_emp_mst → MySQL app_users mobile/login sync on 1st of month at 04:30 AM" `
    -Force | Out-Null

Write-Host "Registered: $TaskName (1st of every month, 04:30 AM)"
