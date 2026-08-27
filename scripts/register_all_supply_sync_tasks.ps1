#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers all agent + hawker supply sync tasks for 4 daily runs.

  Schedule:
    06:25  --recheck  (re-syncs yesterday + D-2 for late Oracle entries)
    09:00  --today    (morning intraday)
    13:00  --today    (afternoon intraday)
    16:00  --today    (evening intraday)

.EXAMPLE
  PowerShell -ExecutionPolicy Bypass -File scripts\register_all_supply_sync_tasks.ps1
#>

$Node        = (Get-Command node -ErrorAction Stop).Source
$AgentScript = Resolve-Path (Join-Path $PSScriptRoot "..\api\supply_sync.js")
$HawkerScript= Resolve-Path (Join-Path $PSScriptRoot "..\api\hawker_supply_sync.js")
$WorkDir     = Split-Path $AgentScript -Parent
$LogDir      = Join-Path $WorkDir "..\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit  (New-TimeSpan -Hours 1) `
    -MultipleInstances   IgnoreNew `
    -DisallowStartIfOnBatteries:$false `
    -StopIfGoingOnBatteries:$false

# ── Remove old tasks (if any) ─────────────────────────────────────────────────
$OldTasks = @(
    "PatrikaSupplySync_Daily",
    "PatrikaHawkerSupplySync",
    "PatrikaHawkerSupplySync4PM",
    "PatrikaHawkerSupplyRecheck"
)
foreach ($t in $OldTasks) {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Host "Old tasks removed (if they existed)."
Write-Host ""

# ── Helper ────────────────────────────────────────────────────────────────────
function Register-SupplyTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [string]$Args,
        [string]$At,
        [string]$Desc
    )
    $Action = New-ScheduledTaskAction `
        -Execute          $Node `
        -Argument         "`"$ScriptPath`" $Args".Trim() `
        -WorkingDirectory $WorkDir
    $Trigger = New-ScheduledTaskTrigger -Daily -At $At
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask `
        -TaskName    $TaskName `
        -Action      $Action `
        -Trigger     $Trigger `
        -Settings    $Settings `
        -Principal   $Principal `
        -Description $Desc `
        -Force | Out-Null
    Write-Host "  Registered: $TaskName  [$At]  $ScriptPath $Args"
}

# ── 06:25 — recheck (yesterday + D-2, catches late Oracle entries) ────────────
Write-Host "=== 06:25 AM — Recheck (yesterday + D-2) ==="
Register-SupplyTask `
    -TaskName  "PatrikaAgentSupply_0625" `
    -ScriptPath $AgentScript `
    -Args      "--recheck" `
    -At        "06:25" `
    -Desc      "Agent supply recheck: re-syncs yesterday + D-2 for late Oracle entries"

Register-SupplyTask `
    -TaskName  "PatrikaHawkerSupply_0625" `
    -ScriptPath $HawkerScript `
    -Args      "--recheck" `
    -At        "06:25" `
    -Desc      "Hawker supply recheck: re-syncs yesterday + D-2 for late Oracle entries"

# ── 09:00 — today (morning intraday) ─────────────────────────────────────────
Write-Host ""
Write-Host "=== 09:00 AM — Today (morning intraday) ==="
Register-SupplyTask `
    -TaskName  "PatrikaAgentSupply_0900" `
    -ScriptPath $AgentScript `
    -Args      "--today" `
    -At        "09:00" `
    -Desc      "Agent supply intraday sync: today's supply (morning)"

Register-SupplyTask `
    -TaskName  "PatrikaHawkerSupply_0900" `
    -ScriptPath $HawkerScript `
    -Args      "--today" `
    -At        "09:00" `
    -Desc      "Hawker supply intraday sync: today's supply (morning)"

# ── 13:00 — today (afternoon intraday) ───────────────────────────────────────
Write-Host ""
Write-Host "=== 01:00 PM — Today (afternoon intraday) ==="
Register-SupplyTask `
    -TaskName  "PatrikaAgentSupply_1300" `
    -ScriptPath $AgentScript `
    -Args      "--today" `
    -At        "13:00" `
    -Desc      "Agent supply intraday sync: today's supply (afternoon)"

Register-SupplyTask `
    -TaskName  "PatrikaHawkerSupply_1300" `
    -ScriptPath $HawkerScript `
    -Args      "--today" `
    -At        "13:00" `
    -Desc      "Hawker supply intraday sync: today's supply (afternoon)"

# ── 16:00 — today (evening intraday) ─────────────────────────────────────────
Write-Host ""
Write-Host "=== 04:00 PM — Today (evening intraday) ==="
Register-SupplyTask `
    -TaskName  "PatrikaAgentSupply_1600" `
    -ScriptPath $AgentScript `
    -Args      "--today" `
    -At        "16:00" `
    -Desc      "Agent supply intraday sync: today's supply (evening)"

Register-SupplyTask `
    -TaskName  "PatrikaHawkerSupply_1600" `
    -ScriptPath $HawkerScript `
    -Args      "--today" `
    -At        "16:00" `
    -Desc      "Hawker supply intraday sync: today's supply (evening)"

Write-Host ""
Write-Host "Done. 8 tasks registered:"
Write-Host "  PatrikaAgentSupply_0625  / PatrikaHawkerSupply_0625   [06:25 --recheck]"
Write-Host "  PatrikaAgentSupply_0900  / PatrikaHawkerSupply_0900   [09:00 --today]"
Write-Host "  PatrikaAgentSupply_1300  / PatrikaHawkerSupply_1300   [13:00 --today]"
Write-Host "  PatrikaAgentSupply_1600  / PatrikaHawkerSupply_1600   [16:00 --today]"
