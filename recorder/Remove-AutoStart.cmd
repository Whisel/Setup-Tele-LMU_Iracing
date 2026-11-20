@echo off
rem Stops the recorders from starting with Windows (removes the Startup shortcut).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sim-watcher.ps1" -Uninstall
pause
