@echo off
setlocal
cd /d "%~dp0"
title CodeSpace - Rebuild web app from source files

echo ===============================================
echo   CodeSpace web app rebuild (js/app.js)
echo ===============================================
echo.
echo Source of truth: my-chat-agent-v3.html + css\*.css + src-js\*.js
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is required to rebuild. Install Node.js 22 or newer.
  pause
  exit /b 1
)

node tools\build-web.cjs
if errorlevel 1 goto :failed

echo.
echo DONE. js/app.js is rebuilt. Restart CodeSpace (or just refresh with Ctrl+R) to see changes.
echo Edit files in src-js\ or css\, then run this file again.
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Read the error above - it points to the file that has a syntax error.
pause
exit /b 1
