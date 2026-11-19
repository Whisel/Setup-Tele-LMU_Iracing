@echo off
rem Starts the iRacing recorder that works with the Setup and Telemetry app.
rem It runs in the Windows PowerShell that comes with Windows: nothing to install.
rem "-ExecutionPolicy Bypass" lets this one script run, for this window only.
title iRacing recorder
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0iracing-recorder.ps1" %*
echo.
pause
