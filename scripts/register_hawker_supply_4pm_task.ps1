# register_hawker_supply_4pm_task.ps1
# Run ONCE as Administrator to register the 4 PM intraday hawker supply sync.
# This re-syncs TODAY's data to pick up afternoon Oracle entries (field staff
# submitting supply slips after the 1 PM run).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\register_hawker_supply_4pm_task.ps1

$TaskName   = "PatrikaHawkerSupplySync4PM"
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

# Action: node hawker_supply_sync.js --today  (syncs today's date)
$Action = New-ScheduledTaskAction `
    -Execute          $NodeExe `
    -Argument         "`"$ScriptPath`" --today" `
    -WorkingDirectory $WorkDir

# Trigger: every day at 4:00 PM
$Trigger = New-ScheduledTaskTrigger -Daily -At "04:00PM"

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
    -Description "4 PM intraday Oracle -> MySQL hawker supply sync (today's date)" | Out-Null

Write-Host ""
Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host "  Name    : $TaskName"
Write-Host "  Runs at : 04:00 PM daily"
Write-Host "  Mode    : --today (syncs today's supply entries from Oracle)"
Write-Host "  Log     : $LogDir\hawker_supply_sync.log"
Write-Host ""
Write-Host "To run immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
