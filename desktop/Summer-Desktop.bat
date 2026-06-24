@echo off
REM ============================================================================
REM  Summer desktop greeter
REM  Opens Summer in a chromeless "app" window (no tabs/address bar) and allows
REM  audio autoplay, so the orb greets you by voice and offers your briefing the
REM  moment you log in to Windows -- no need to open a browser or the website.
REM
REM  One-time setup: log in once in the window so Summer remembers you (the login
REM  is saved in the browser, so future launches open already signed in).
REM  Uses Microsoft Edge if present, otherwise Google Chrome, otherwise your
REM  default browser.
REM ============================================================================
set "URL=https://summer-ttu.fly.dev/"
set "FLAGS=--app=%URL% --autoplay-policy=no-user-gesture-required --start-maximized"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE64=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%"    ( start "" "%EDGE%"    %FLAGS% & goto :eof )
if exist "%EDGE64%"  ( start "" "%EDGE64%"  %FLAGS% & goto :eof )
if exist "%CHROME%"  ( start "" "%CHROME%"  %FLAGS% & goto :eof )
if exist "%CHROME86%"( start "" "%CHROME86%"%FLAGS% & goto :eof )
start "" "%URL%"
