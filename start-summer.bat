@echo off
setlocal
REM ============================================================
REM  Summer (TTU) - one-click launcher
REM  Double-click this file to start BOTH servers:
REM    backend  -> http://127.0.0.1:8000
REM    frontend -> http://localhost:5173
REM  Close the two windows it opens to stop Summer.
REM ============================================================
cd /d "%~dp0"

REM Find the virtual-env Python (shared venv one level up, or local .venv)
set "VENV_PY=..\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" set "VENV_PY=.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo [ERROR] Could not find the Python virtual environment.
  echo Looked for ..\.venv\Scripts\python.exe and .venv\Scripts\python.exe
  pause
  exit /b 1
)

echo Starting Summer backend  (http://127.0.0.1:8000) ...
start "Summer Backend" cmd /k ""%VENV_PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env"

echo Starting Summer frontend (http://localhost:5173) ...
start "Summer Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

REM Give the servers a few seconds, then open the kiosk in the browser
timeout /t 6 /nobreak >nul
start "" http://localhost:5173/

echo.
echo Summer is starting in two windows.
echo   - Admin / login : http://localhost:5173/
echo   - Hallway kiosk : http://localhost:5173/kiosk
echo Close the two server windows to stop Summer.
endlocal
