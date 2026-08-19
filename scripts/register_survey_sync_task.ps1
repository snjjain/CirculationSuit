#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers the daily survey sync task (PatrikaSurveySync).
  Runs at 07:30 AM daily — syncs Oracle CRM survey data → MySQL survey_data (incremental from last loaded date).
.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_survey_sync_task.ps1
#>

$Node     = (Get-Command node -ErrorAction Stop).Source
$Script   = Resolve-Path (Join-Path $PSScriptRoot "..\api\oracle_survey_sync.js")
$WorkDir  = Split-Path $Script -Parent
$LogDir   = Join-Path $WorkDir "..\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit  (New-TimeSpan -Hours 2) `
    -MultipleInstances   IgnoreNew `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false

$TaskName = "PatrikaSurveySync"
$Action   = New-ScheduledTaskAction `
    -Execute          $Node `
    -Argument         "`"$Script`" --from-last" `
    -WorkingDirectory $WorkDir
$Trigger  = New-ScheduledTaskTrigger -Daily -At "07:30AM"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Daily Oracle CRM survey → MySQL survey_data incremental sync at 07:30 AM" `
    -Force | Out-Null

Write-Host "Registered: $TaskName (daily 07:30 AM, --from-last incremental)"
Write-Host ""
Write-Host "IMPORTANT: Run a one-time backfill first if survey_data is empty:"
Write-Host "  node api\oracle_survey_sync.js --from 2026-01-01"
