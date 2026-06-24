# ============================================================================
#  Summer desktop greeter - one-click setup for the current Windows user.
#
#  Installs a startup launcher so that, every time you sign in to Windows, Summer
#  opens in a clean app window and the orb greets you by voice and offers your
#  daily briefing - no need to open a browser or the website yourself.
#
#  New computer? Just open PowerShell and run:
#      irm https://summer-ttu.fly.dev/setup.ps1 | iex
#
#  Safe to re-run. No administrator rights are needed: it only writes to your own
#  user profile (an app folder and a Startup-folder shortcut). It does NOT change
#  system settings, and signing in to Summer still requires your password.
# ============================================================================
$ErrorActionPreference = 'Stop'

$AppUrl = 'https://summer-ttu.fly.dev/'
$Dir    = Join-Path $env:LOCALAPPDATA 'Summer'
$Bat    = Join-Path $Dir 'Summer-Desktop.bat'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# The launcher: open Summer in a chromeless "app" window with audio autoplay
# allowed (so it can speak right away). Edge first, then Chrome, else default.
$launcher = @'
@echo off
set "URL=https://summer-ttu.fly.dev/"
set "FLAGS=--app=%URL% --autoplay-policy=no-user-gesture-required --start-maximized"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE64=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%EDGE%"     ( start "" "%EDGE%"     %FLAGS% & goto :eof )
if exist "%EDGE64%"   ( start "" "%EDGE64%"   %FLAGS% & goto :eof )
if exist "%CHROME%"   ( start "" "%CHROME%"   %FLAGS% & goto :eof )
if exist "%CHROME86%" ( start "" "%CHROME86%" %FLAGS% & goto :eof )
start "" "%URL%"
'@
Set-Content -Path $Bat -Value $launcher -Encoding ASCII

# Register it to run at every login: a shortcut in the user's Startup folder.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Summer.lnk'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $Bat
$sc.WorkingDirectory = $Dir
$sc.Description = 'Summer desktop greeter'
$sc.WindowStyle = 7   # start minimized; the app window opens on its own
$sc.Save()

Write-Host ''
Write-Host '  Summer is set up.' -ForegroundColor Green
Write-Host '  It will open and greet you automatically every time you sign in to Windows.'
Write-Host '  Opening it now - sign in once and it will remember you.'
Write-Host ''
Start-Process -FilePath $Bat

# To remove later: delete the shortcut at
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Summer.lnk
