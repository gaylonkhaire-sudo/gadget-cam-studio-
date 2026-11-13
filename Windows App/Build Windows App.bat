@echo off
title Gadget Cam Studio - build
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Opening the download page...
  echo Install the LTS version, then double-click this file again.
  start https://nodejs.org/
  pause
  exit /b 1
)
if not exist vcam-bin mkdir vcam-bin
where cmake >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Building the Gadget Cam Studio camera...
  cmake -S "..\Camera Driver" -B "%TEMP%\gcs-cam-build" -A x64 && cmake --build "%TEMP%\gcs-cam-build" --config Release && copy /y "%TEMP%\gcs-cam-build\Release\GcsCamSource.dll" vcam-bin\ && copy /y "%TEMP%\gcs-cam-build\Release\gcs-vcam.exe" vcam-bin\
) else (
  echo.
  echo Note: Visual Studio Build Tools not found, so this installer won't include the Gadget Cam Studio camera.
  echo       Use the GitHub build to get it, or the app will use the OBS Virtual Camera instead.
)
echo.
echo Installing (first time takes a few minutes)...
call npm install || goto :fail
echo.
echo Building the installer...
call npm run dist || goto :fail
echo.
echo Done! Opening the folder with your installer...
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo Something went wrong. Scroll up to see the error.
pause
exit /b 1
