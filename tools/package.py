"""Zip the offline build with a double-click Windows install script that opens play.html (no npm, no admin rights):

    python3 tools/package.py      # after `npm run build:offline` -> dist-package/SkylineRunner.zip
"""
import os, zipfile

GAME = 'dist-offline/skyline-runner-offline.html'
OUT = 'dist-package/SkylineRunner.zip'

INSTALL = r'''@echo off
rem Installs for this user only (no admin rights), then opens play.html.
set "DEST=%LOCALAPPDATA%\SkylineRunner"
echo Installing Skyline Runner to %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0play.html" "%DEST%\play.html" >nul || goto :fail
copy /Y "%~dp0uninstall.bat" "%DEST%\uninstall.bat" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; foreach($d in [Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs')){ $l=$w.CreateShortcut((Join-Path $d 'Skyline Runner.lnk')); $l.TargetPath='%DEST%\play.html'; $l.Save() }" >nul 2>&1
if errorlevel 1 (
  rem PowerShell blocked - common on school PCs - so a plain desktop link instead
  (echo [InternetShortcut]& echo URL=file:///%DEST:\=/%/play.html) > "%USERPROFILE%\Desktop\Skyline Runner.url"
)
echo Done. Opening play.html - next time use the "Skyline Runner" shortcut on your Desktop.
start "" "%DEST%\play.html"
exit /b
:fail
echo Install failed. You can still play: double-click play.html in this folder.
start "" "%~dp0play.html"
pause
'''

UNINSTALL = r'''@echo off
del /Q "%USERPROFILE%\Desktop\Skyline Runner.url" >nul 2>&1
powershell -NoProfile -Command "foreach($d in [Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs')){ Remove-Item -ErrorAction SilentlyContinue (Join-Path $d 'Skyline Runner.lnk') }" >nul 2>&1
echo Skyline Runner removed (your saved times stay in the browser).
pause
cd /d "%TEMP%" & rmdir /S /Q "%LOCALAPPDATA%\SkylineRunner"
'''

README = '''SKYLINE RUNNER - first-person parkour

PLAY WITHOUT INSTALLING (any computer, incl. school PCs, Chromebooks, Macs)
  Double-click play.html (or drag it into a Chrome/Edge tab).
  It needs no internet, no install and no admin rights.

INSTALL ON WINDOWS
  1. Right-click the zip > Extract All (scripts don't run from inside a zip).
  2. Double-click install.bat. If Windows shows "Windows protected your PC",
     click "More info" > "Run anyway". It installs, then opens play.html.
  3. Next time, play from the "Skyline Runner" shortcut on your Desktop or Start menu.
  To remove it: run uninstall.bat in %LOCALAPPDATA%\\SkylineRunner.

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
    z.write(GAME, 'SkylineRunner/play.html')
    for name, text in [('install.bat', INSTALL), ('uninstall.bat', UNINSTALL), ('README.txt', README)]:
        z.writestr('SkylineRunner/' + name, text.replace('\r\n', '\n').replace('\n', '\r\n'))  # Windows needs CRLF
print(OUT, os.path.getsize(OUT) // 1024, 'KB')
