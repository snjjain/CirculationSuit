# register_dcr_sync_task.ps1
# Run ONCE as Administrator to register the daily DCR sync task
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_dcr_sync_task.ps1

$TaskName   = "PatrikaDCRSync"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if ($nodeCmd) { $nodeCmd.Source } else { "C:\Program Files\nodejs\node.exe" }
$ScriptPath = "$PSScriptRoot\..\api\oracle_dcr_sync.js"
$WorkDir    = "$PSScriptRoot\.."
$LogDir     = "$PSScriptRoot\..\logs"

# Resolve to absolute paths
$ScriptPath = (Resolve-Path $ScriptPath).Path
$WorkDir    = (Resolve-Path $WorkDir).Path
$LogFile    = "$LogDir\dcr_sync.log"
$ErrFile    = "$LogDir\dcr_sync_err.log"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName"
}

# Action: node oracle_dcr_sync.js (last 2 days by default)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`"" `
    -WorkingDirectory $WorkDir

# Trigger: every day at 07:00 AM (after supply/collection syncs at ~06:00)
$Trigger = New-ScheduledTaskTrigger -Daily -At "07:00AM"

# Settings: run whether logged on or not, 1-hour time limit, retry on failure
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit    (New-TimeSpan -Hours 1) `
    -RestartCount          2 `
    -RestartInterval       (New-TimeSpan -Minutes 15) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Run as SYSTEM so it works even when no user is logged in
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
    -Description "Daily Oracle DCR → MySQL sync (agency visits + center attendance) at 07:00" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 07:00 AM daily"
Write-Host "  Script  : $ScriptPath"
Write-Host "  Node    : $NodeExe"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To check last run result:"
Write-Host "  (Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo).LastTaskResult"
