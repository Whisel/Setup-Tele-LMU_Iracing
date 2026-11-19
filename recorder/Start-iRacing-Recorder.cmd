@echo off
rem Starts the iRacing recorder that works with the Setup and Telemetry app.
rem Needs Python 3.8 or later (python.org, or "winget install Python.Python.3.12").
title iRacing recorder
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0iracing_recorder.py" %*
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3 from python.org, then run this again.
  ) else (
    python "%~dp0iracing_recorder.py" %*
  )
)
echo.
pause
