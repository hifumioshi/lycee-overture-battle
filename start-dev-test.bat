@echo off
chcp 65001 >nul
title Lycee DEV - Test Mode
cd /d "%~dp0"
set "VITE_DEV_TOOLS=1"
echo ============================================================
echo   Lycee Overture - DEV build (with Solo Test Mode)
echo ------------------------------------------------------------
echo   In menu click the button with the flask icon (Solo Test Mode),
echo   then in battle press F2 to open/close the card search panel.
echo ------------------------------------------------------------
echo   To quit: close the game window, then close this window.
echo   Keep this window open while playing.
echo ============================================================
echo.
if not exist "node_modules" (
  echo [!] node_modules missing - running npm install first...
  call npm install
)
echo Starting dev build (first run may take ~20 seconds)...
echo.
call npm run dev
echo.
echo [exited] If an error appeared above, screenshot it and send it to the maintainer.
pause
