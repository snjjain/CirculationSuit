#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers the daily outstanding sync task (PatrikaOutstandingSync).
  Runs at 06:30 AM daily — syncs Oracle outstanding balances → MySQL agency_outstanding.
.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_outstanding_sync_task.ps1
#>

$Node     = (Get-Command node -ErrorAction Stop).Source
$Script   = Resolve-Path (Join-Path $PSScriptRoot "..\api\oracle_outstanding_sync.js")
$WorkDir  = Split-Path $Script -Parent
$LogDir   = Join-Path $WorkDir "..\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit  (New-TimeSpan -Hours 3) `
    -MultipleInstances   IgnoreNew `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false

$TaskName = "PatrikaOutstandingSync"
$Action   = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`"" `
    -WorkingDirectory $WorkDir
$Trigger  = New-ScheduledTaskTrigger -Daily -At "06:30AM"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Daily Oracle → MySQL outstanding balances sync at 06:30 AM" `
    -Force | Out-Null

Write-Host "Registered: $TaskName (daily 06:30 AM)"
