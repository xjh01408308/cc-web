@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   cc-web Cloud Restart Script
echo ============================================
echo.

echo [1/4] Stopping old processes...

for %%P in (3001 5173) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P.*LISTENING" 2^>nul') do (
        echo   Killing process PID=%%a on port %%P
        taskkill /PID %%a /F >nul 2>&1
    )
)

timeout /t 2 /nobreak >nul
echo   Done
echo.

echo [2/4] Building frontend...
cd /d "%~dp0packages\frontend"
call npx vite build
echo   Done
echo.

echo [3/4] Starting relay service (port 3001)...
cd /d "%~dp0packages\relay"
start "cc-web-relay" cmd /c "npx tsx --env-file=.env src/index.ts"
echo   Started
echo.

echo [4/4] Starting frontend dev server (port 5173)...
cd /d "%~dp0packages\frontend"
start "cc-web-frontend" cmd /c "npx vite --host 0.0.0.0 --port 5173"
echo   Started
echo.

echo ============================================
echo   Cloud services started
echo   Frontend : http://localhost:5173
echo   Relay    : ws://localhost:3001
echo   (Local nodes should use restart-local.bat)
echo ============================================
echo.

endlocal
