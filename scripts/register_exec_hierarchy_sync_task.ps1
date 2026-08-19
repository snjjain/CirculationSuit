#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers the daily exec hierarchy sync task (PatrikaExecHierarchySync).
  Runs at 07:45 AM daily — syncs Oracle PLI hierarchy tables → MySQL exec_master,
  exec_hierarchy_mapping, exec_hierarchy_mast, exec_hierarchy_level.
.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_exec_hierarchy_sync_task.ps1
#>

$Node     = (Get-Command node -ErrorAction Stop).Source
$Script   = Resolve-Path (Join-Path $PSScriptRoot "..\api\oracle_exec_hierarchy_sync.js")
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

$TaskName = "PatrikaExecHierarchySync"
$Action   = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`"" `
    -WorkingDirectory $WorkDir
$Trigger  = New-ScheduledTaskTrigger -Daily -At "07:45AM"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Daily Oracle PLI hierarchy → MySQL exec hierarchy sync at 07:45 AM" `
    -Force | Out-Null

Write-Host "Registered: $TaskName (daily 07:45 AM)"
