@echo off
rem Starts the Le Mans Ultimate lap recorder. Leave the window open while you drive.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lmu-recorder.ps1" %*
if errorlevel 1 pause
