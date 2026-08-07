# register_collection_sync_task.ps1
# Run ONCE as Administrator to register the daily collection sync task
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_collection_sync_task.ps1

$TaskName   = "PatrikaCollectionSync"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ScriptPath = "$PSScriptRoot\..\api\collection_sync.js"
$WorkDir    = "$PSScriptRoot\.."
$LogDir     = "$PSScriptRoot\..\logs"

# Resolve to absolute paths
$ScriptPath = (Resolve-Path $ScriptPath).Path
$WorkDir    = (Resolve-Path $WorkDir).Path

# Create logs directory if it doesn't exist
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
    Write-Host "Created logs directory: $LogDir"
}

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName"
}

# Action: node collection_sync.js (no args = syncs yesterday)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`"" `
    -WorkingDirectory $WorkDir

# Trigger: every day at 06:10 (10 min after oracle_sync at 06:00)
$Trigger = New-ScheduledTaskTrigger -Daily -At "06:10AM"

# Settings: run whether logged on or not, restart on failure
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
    -Description "Daily Oracle ERP → MySQL collection receipt sync at 06:10" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 06:10 AM daily (10 min after oracle_sync)"
Write-Host "  Script  : $ScriptPath"
Write-Host "  Log     : $LogDir\collection_sync.log"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To run initial backfill (Jan 2026 to today):"
Write-Host "  & `"$NodeExe`" `"$ScriptPath`" --from 2026-01-01"
Write-Host ""
Write-Host "To sync a specific date:"
Write-Host "  & `"$NodeExe`" `"$ScriptPath`" --date 2026-07-16"
