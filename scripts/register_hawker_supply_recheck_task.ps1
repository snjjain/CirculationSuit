# register_hawker_supply_recheck_task.ps1
# Run ONCE as Administrator to register the morning recheck task.
# This re-syncs yesterday + day-before-yesterday at 06:25 AM to pick up any
# Oracle entries added late (after the 4 PM run) the previous day.
# Runs 5 minutes after the main 06:20 AM sync so they don't overlap.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_hawker_supply_recheck_task.ps1

$TaskName   = "PatrikaHawkerSupplyRecheck"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ScriptPath = "$PSScriptRoot\..\api\hawker_supply_sync.js"
$WorkDir    = "$PSScriptRoot\.."
$LogDir     = "$PSScriptRoot\..\logs"

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

# Action: node hawker_supply_sync.js --recheck  (re-syncs yesterday + day before)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`" --recheck" `
    -WorkingDirectory $WorkDir

# Trigger: every day at 06:25 AM (5 min after main sync at 06:20)
$Trigger = New-ScheduledTaskTrigger -Daily -At "06:25AM"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit    (New-TimeSpan -Hours 1) `
    -RestartCount          1 `
    -RestartInterval       (New-TimeSpan -Minutes 5) `
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
    -Description "Morning recheck: re-sync yesterday+day-before to catch late Oracle entries" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 06:25 AM daily"
Write-Host "  Mode    : --recheck (re-syncs yesterday + day-before-yesterday)"
Write-Host "  Log     : $LogDir\hawker_supply_sync.log"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
