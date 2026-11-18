@echo off
setlocal
cd /d "%~dp0"
title CodeSpace v3.13.11 - Portable EXE Builder

echo ===============================================
echo   CodeSpace v3.13.11 - Portable EXE Builder
echo ===============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js and npm are required only to BUILD the EXE.
  echo Install Node.js 22 or newer on this build PC, then run this file again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

echo [1/3] Installing project build dependencies...
call npm install
if errorlevel 1 goto :failed

echo.
echo [2/3] Downloading and verifying the bundled Node runtime...
call npm run runtime:fetch
if errorlevel 1 goto :failed

echo.
echo [3/3] Building the no-install Windows x64 portable EXE...
call npx electron-builder --win portable --x64
if errorlevel 1 goto :failed

echo.
echo SUCCESS. Output is in:
echo %CD%\release\
echo Copy CodeSpace-Portable-3.13.11.exe to a USB drive and double-click it.
echo The EXE will start the backend automatically; do not run agent-server.js manually.
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Read the error above and check the Bengali build guide.
pause
exit /b 1
