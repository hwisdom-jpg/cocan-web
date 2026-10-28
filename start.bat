@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install Node 18 or newer from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

rem Open the browser once the server answers.
if "%PORT%"=="" set PORT=7788
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%PORT%/"

echo.
echo   CoCan Web  --  http://127.0.0.1:7788/
echo   Close this window to stop.  (Ctrl+C)
echo.

node server.mjs %*

echo.
echo Server stopped.
pause
