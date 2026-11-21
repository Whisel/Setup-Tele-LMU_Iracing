@echo off
rem Watches for iRacing and Le Mans Ultimate and starts the matching recorder. Leave the window open (minimised is fine).
title Sim telemetry recorders
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sim-watcher.ps1" %*
if errorlevel 1 pause
