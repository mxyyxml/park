"""Zip the offline build with double-click Windows install/play scripts (no npm, no admin rights):

    python3 tools/package.py      # after `npm run build:offline` -> dist-package/SkylineRunner.zip
"""
import os, zipfile

GAME = 'dist-offline/skyline-runner-offline.html'
OUT = 'dist-package/SkylineRunner.zip'

PLAY = r'''@echo off
rem Opens the game in its own Chrome/Edge window (app mode), else the default browser.
set "GAME=%~dp0SkylineRunner.html"
set "URL=file:///%GAME:\=/%"
for %%B in (chrome.exe msedge.exe) do (
  reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)
  reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)
)
start "" "%GAME%"
'''

INSTALL = r'''@echo off
rem Installs for this user only: no admin rights needed.
set "DEST=%LOCALAPPDATA%\SkylineRunner"
echo Installing Skyline Runner to %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0SkylineRunner.html" "%DEST%\" >nul || goto :fail
copy /Y "%~dp0Play.bat" "%DEST%\" >nul || goto :fail
copy /Y "%~dp0Uninstall.bat" "%DEST%\" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; foreach($d in [Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs')){ $l=$w.CreateShortcut((Join-Path $d 'Skyline Runner.lnk')); $l.TargetPath='%DEST%\Play.bat'; $l.WorkingDirectory='%DEST%'; $l.WindowStyle=7; $l.Save() }" >nul 2>&1
if errorlevel 1 (
  rem PowerShell blocked - common on school PCs - so a plain desktop link instead
  (echo [InternetShortcut]& echo URL=file:///%DEST:\=/%/SkylineRunner.html) > "%USERPROFILE%\Desktop\Skyline Runner.url"
)
echo Done. Start it from the "Skyline Runner" shortcut on your Desktop or in the Start menu.
start "" "%DEST%\Play.bat"
pause
exit /b
:fail
echo Install failed. You can still play: double-click SkylineRunner.html in this folder.
pause
'''

UNINSTALL = r'''@echo off
del /Q "%USERPROFILE%\Desktop\Skyline Runner.url" "%USERPROFILE%\Desktop\Skyline Runner.lnk" >nul 2>&1
powershell -NoProfile -Command "foreach($d in [Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs')){ Remove-Item -ErrorAction SilentlyContinue (Join-Path $d 'Skyline Runner.lnk') }" >nul 2>&1
echo Skyline Runner removed (your saved times stay in the browser).
pause
cd /d "%TEMP%" & rmdir /S /Q "%LOCALAPPDATA%\SkylineRunner"
'''

README = '''SKYLINE RUNNER - first-person parkour

PLAY WITHOUT INSTALLING (any computer, incl. school PCs, Chromebooks, Macs)
  Double-click SkylineRunner.html (or drag it into a Chrome/Edge tab).
  It needs no internet, no install and no admin rights.

INSTALL ON WINDOWS
  1. Right-click the zip > Extract All (scripts don't run from inside a zip).
  2. Double-click Install.bat. If Windows shows "Windows protected your PC",
     click "More info" > "Run anyway".
  3. Play from the "Skyline Runner" shortcut on your Desktop or Start menu.
  To remove it: run Uninstall.bat in %LOCALAPPDATA%\\SkylineRunner.

CONTROLS
  Click the game to capture the mouse.  WASD / arrows move, mouse look, Space jump / wall-run,
  Shift sprint, Ctrl or C slide / roll, Q quick turn, R restart trial, Esc or P pause.

IF IT RUNS SLOWLY
  The game starts on Low quality on laptop graphics. A red banner means the browser
  is not using the graphics card: Chrome/Edge > Settings > System > turn on
  "Use graphics acceleration when available", then relaunch the browser.
'''

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.write(GAME, 'SkylineRunner/SkylineRunner.html')
    for name, text in [('Play.bat', PLAY), ('Install.bat', INSTALL), ('Uninstall.bat', UNINSTALL), ('README.txt', README)]:
        z.writestr('SkylineRunner/' + name, text.replace('\r\n', '\n').replace('\n', '\r\n'))  # Windows needs CRLF
print(OUT, os.path.getsize(OUT) // 1024, 'KB')
