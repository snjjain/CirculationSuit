#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers the daily supply sync task (PatrikaSupplySync_Daily).
  Historical load must be triggered manually once.

.EXAMPLE
  # Register daily cron:
  PowerShell -ExecutionPolicy Bypass -File scripts\register_supply_sync_task.ps1

  # Run historical load manually (one-time, takes several hours):
  cd api
  node supply_sync.js --historical
#>

$Node     = (Get-Command node -ErrorAction Stop).Source
$Script   = Resolve-Path (Join-Path $PSScriptRoot "..\api\supply_sync.js")
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

$TaskName = "PatrikaSupplySync_Daily"
$Action   = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`"" `
    -WorkingDirectory $WorkDir
$Trigger  = New-ScheduledTaskTrigger -Daily -At "05:00"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Daily supply data sync from Oracle cir_dbksup (yesterday's data)" `
    -Force | Out-Null

Write-Host "Registered: $TaskName (daily at 05:00 — loads yesterday's supply)"
Write-Host ""
Write-Host "IMPORTANT: Run historical load manually once before the dashboard works:"
Write-Host "  cd `"$WorkDir`""
Write-Host "  node supply_sync.js --historical"
Write-Host ""
Write-Host "This loads:"
Write-Host "  - 2020-03-18 (pre-COVID reference, ~305K rows)"
Write-Host "  - 2021-01-01 to today (last 5 years, monthly chunks, ~15M rows total)"
Write-Host "  Estimated time: 4-8 hours (resumable if interrupted)"
