@echo off
rem Makes the recorders start by themselves when you sign in to Windows (adds a shortcut to your Startup folder).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sim-watcher.ps1" -Install
pause
