@echo off
REM Double-click to start the Reverb Price Tracker on Windows.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  ) else (
    python app.py
  )
)
pause
