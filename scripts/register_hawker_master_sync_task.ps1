# register_hawker_master_sync_task.ps1
# Run ONCE as Administrator to register the daily hawker MASTER sync task.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_hawker_master_sync_task.ps1

$TaskName   = "PatrikaHawkerMasterSync"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ScriptPath = "$PSScriptRoot\..\api\oracle_hawker_master_sync.js"
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

# Action: node oracle_hawker_master_sync.js (no args = full master, ~11k rows)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`"" `
    -WorkingDirectory $WorkDir

# Trigger: 05:45, before the supply syncs so a hawker who first appears in today's
# supply already has a master row to join to.
$Trigger = New-ScheduledTaskTrigger -Daily -At "05:45AM"

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
    -Description "Daily Oracle CRM_HAWKER_MASTER -> MySQL hawker_master sync at 05:45" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 05:45 AM daily"
Write-Host "  Script  : $ScriptPath"
Write-Host "  Log     : $LogDir\oracle_hawker_master_sync.log"
