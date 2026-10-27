@echo off
setlocal EnableExtensions EnableDelayedExpansion
title SubAI v5 - personal edition installer
cd /d "%~dp0"

rem -- Settings written into the plugin (subai_config.json, stays on this PC only) --
set "RELAY=https://yehudasnow--subai-relay-web.us-east.modal.run"
set "TOKEN=__SUBAI_TOKEN__"
set "SRC=%~dp0files"

echo.
echo  ==============================================
echo     SubAI v5 - personal edition installer
echo  ==============================================
echo.

if not exist "%SRC%\index.html" goto :missing
if not exist "%SRC%\jsx\host.jsx" goto :missing

if "%TOKEN%"=="__SUBAI_TOKEN__" set "TOKEN="
if "%TOKEN%"=="" set /p "TOKEN= Enter your SubAI password (SUBAI_TOKEN): "
if "%TOKEN%"=="" goto :notoken

:checkPremiere
tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" 2>nul | find /I "Adobe Premiere Pro.exe" >nul
if not errorlevel 1 (
  echo  [*] Premiere Pro is open. Close it completely, then press any key...
  pause >nul
  goto :checkPremiere
)

rem -- Find the installed plugin folder --
set "EXT="
if exist "%APPDATA%\Adobe\CEP\extensions\com.subai.cloud.panel\index.html" set "EXT=%APPDATA%\Adobe\CEP\extensions\com.subai.cloud.panel"
if not defined EXT (
  echo  Searching for the SubAI plugin folder...
  for %%B in ("%APPDATA%\Adobe\CEP\extensions" "%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions" "%ProgramFiles%\Common Files\Adobe\CEP\extensions") do (
    if exist "%%~B" for /d %%D in ("%%~B\*") do (
      if not defined EXT if exist "%%~D\CSXS\manifest.xml" (
        findstr /i /c:"com.subai.cloud" "%%~D\CSXS\manifest.xml" >nul 2>&1 && set "EXT=%%~D"
      )
    )
  )
)
if not defined EXT set "EXT=%APPDATA%\Adobe\CEP\extensions\com.subai.cloud.panel"
echo  Plugin folder: !EXT!

if not exist "!EXT!\jsx" mkdir "!EXT!\jsx" 2>nul
if not exist "!EXT!\jsx" goto :copyfail
if not exist "!EXT!\CSXS\manifest.xml" (
  echo  Fresh install - adding manifest.
  mkdir "!EXT!\CSXS" 2>nul
  copy /Y "%SRC%\CSXS\manifest.xml" "!EXT!\CSXS\manifest.xml" >nul || goto :copyfail
)

rem -- Backup of the old version (only the first time) --
if exist "!EXT!\index.html" if not exist "!EXT!\backup_v4\index.html" (
  mkdir "!EXT!\backup_v4" 2>nul
  copy /Y "!EXT!\index.html" "!EXT!\backup_v4\index.html" >nul
  if exist "!EXT!\jsx\host.jsx" copy /Y "!EXT!\jsx\host.jsx" "!EXT!\backup_v4\host.jsx" >nul
  echo  Old version backed up to backup_v4
)

rem -- Install v5 --
copy /Y "%SRC%\index.html" "!EXT!\index.html" >nul || goto :copyfail
copy /Y "%SRC%\jsx\host.jsx" "!EXT!\jsx\host.jsx" >nul || goto :copyfail
> "!EXT!\subai_config.json" echo {"relayUrl":"%RELAY%","token":"%TOKEN%"}

rem -- Allow unsigned CEP panels (same as the original installer) --
for %%V in (9 10 11 12 13 14) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1

echo.
echo  [OK] SubAI v5 installed.
echo       Open Premiere Pro ^> Window ^> Extensions ^> SubAI
echo       The connection to Modal is already configured.
echo.
pause
exit /b 0

:missing
echo  [X] Files are missing. Extract the whole ZIP first, then run this file again.
goto :fail
:notoken
echo  [X] No password entered.
goto :fail
:copyfail
echo  [X] Could not copy files. Close Premiere Pro and run again,
echo      or right-click this file ^> Run as administrator.
:fail
echo.
pause
exit /b 1
