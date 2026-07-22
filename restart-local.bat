@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   cc-web Local Node Restart Script
echo ============================================
echo.

echo [1/2] Stopping old local process...
taskkill /FI "WINDOWTITLE eq cc-web-local" /F /T >nul 2>&1
timeout /t 2 /nobreak >nul
echo   Done
echo.

echo [2/2] Starting local service...
cd /d "%~dp0packages\local"
start "cc-web-local" cmd /c "npx tsx --env-file=.env src/index.ts"
echo   Started
echo.

echo ============================================
echo   Local node started
echo   (Check .env for RELAY_URL setting)
echo ============================================
echo.

endlocal
