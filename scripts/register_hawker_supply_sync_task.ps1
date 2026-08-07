# register_hawker_supply_sync_task.ps1
# Run ONCE as Administrator to register the daily hawker supply sync task.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_hawker_supply_sync_task.ps1

$TaskName   = "PatrikaHawkerSupplySync"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ScriptPath = "$PSScriptRoot\..\api\hawker_supply_sync.js"
$WorkDir    = "$PSScriptRoot\.."
$LogDir     = "$PSScriptRoot\..\logs"

# Resolve to absolute paths
$ScriptPath = (Resolve-Path $ScriptPath).Path
$WorkDir    = (Resolve-Path $WorkDir).Path

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
    Write-Host "Created logs directory: $LogDir"
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName"
}

# Action: node hawker_supply_sync.js (no args = syncs yesterday)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`"" `
    -WorkingDirectory $WorkDir

# Trigger: every day at 06:20 (after oracle_sync 06:00 and collection_sync 06:10)
$Trigger = New-ScheduledTaskTrigger -Daily -At "06:20AM"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit    (New-TimeSpan -Hours 1) `
    -RestartCount          2 `
    -RestartInterval       (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$Principal = New-ScheduledTaskPrincipal `
    -UserId    "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel  Highest

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    $Trigger `
    -Settings   $Settings `
    -Principal  $Principal `
    -Description "Daily Oracle ERP → MySQL hawker/cash sale supply sync at 06:20" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 06:20 AM daily"
Write-Host "  Script  : $ScriptPath"
Write-Host "  Log     : $LogDir\hawker_supply_sync.log"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To run the one-time historical backfill (2020-03-18 ref + 2021-01→today):"
Write-Host "  & `"$NodeExe`" `"$ScriptPath`" --historical"
Write-Host ""
Write-Host "To sync a specific date:"
Write-Host "  & `"$NodeExe`" `"$ScriptPath`" --date 2026-08-06"
Write-Host ""
Write-Host "To sync from last loaded date forward:"
Write-Host "  & `"$NodeExe`" `"$ScriptPath`" --from-last"
