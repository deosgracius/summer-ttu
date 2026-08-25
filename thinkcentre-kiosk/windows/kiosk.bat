@echo off
REM ============================================================================
REM  Summer wall-kiosk launcher for Windows (Lenovo ThinkCentre M710q).
REM
REM  What it does: opens Google Chrome fullscreen on the Summer kiosk page and,
REM  if Chrome is ever closed or crashes, waits a moment and reopens it — so the
REM  wall display stays up unattended. Intel graphics give hardware-accelerated
REM  WebGL automatically on Windows; no flags needed for that.
REM
REM  Set it up once (see windows\README.md): install Chrome, enable automatic
REM  login, and put a SHORTCUT to this file in the Startup folder (shell:startup).
REM ============================================================================

set "URL=https://summer-ttu.onrender.com/kiosk"
set "PROFILE=%LOCALAPPDATA%\SummerKiosk"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

:loop
"%CHROME%" --kiosk --noerrdialogs --disable-infobars --no-first-run ^
  --no-default-browser-check ^
  --autoplay-policy=no-user-gesture-required ^
  --use-fake-ui-for-media-stream ^
  --disable-session-crashed-bubble --disable-features=Translate ^
  --user-data-dir="%PROFILE%" "%URL%"
REM Chrome exited (crash / manual quit / Alt+F4). Wait, then bring the wall back.
timeout /t 3 /nobreak >nul
goto loop
