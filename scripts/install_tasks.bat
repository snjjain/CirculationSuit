@echo off
:: Self-elevating batch file — registers all Patrika sync tasks in Windows Task Scheduler.
:: Double-click this file (or right-click > Run as administrator).

:: Check if running as administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :run
) else (
    :: Re-launch as administrator using PowerShell's Start-Process -Verb RunAs
    echo Requesting administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs -Wait"
    exit /b
)

:run
echo.
echo ================================================================
echo  Patrika Sync Tasks Installer
echo ================================================================
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0register_all_sync_tasks.ps1"
echo.
echo ================================================================
echo  Done. Press any key to close.
echo ================================================================
pause >nul
