@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ============================================
echo   cc-web Local Node Restart Script
echo ============================================
echo.

cd /d "%~dp0"
if not exist "packages\local\node_modules" (
  echo [WARN] packages\local\node_modules not found — run "npm install" in repo root first.
)
if not exist "packages\local\.env" (
  echo [ERROR] packages\local\.env not found — copy from .env.example and set NODE_ID / NODE_SECRET.
  pause
  exit /b 1
)

echo [1/2] Stopping old local process...
taskkill /FI "WINDOWTITLE eq cc-web-local" /F /T >nul 2>&1
timeout /t 2 /nobreak >nul
echo   Done
echo.

echo [2/2] Starting local service...
cd /d "%~dp0packages\local"
REM cmd /k keeps the new window open even if the process exits (e.g. on a startup error),
REM so error messages stay visible instead of the window flashing closed.
start "cc-web-local" cmd /k "chcp 65001 >nul && npx tsx --env-file=.env src/index.ts"
echo   Started
echo.

echo ============================================
echo   Local node started in a new window
echo   (Check .env for RELAY_URL setting)
echo ============================================
echo.

endlocal
