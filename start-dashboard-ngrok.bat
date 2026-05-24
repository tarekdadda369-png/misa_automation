@echo off
setlocal
cd /d "%~dp0"

set PORT=3050
set NGROK_DOMAIN=

echo ============================================================
echo  MISA Dashboard + ngrok
echo  Local:  http://localhost:%PORT%
echo ============================================================
echo.

REM --- 1) Start dashboard (PM2) ---
where pm2 >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pm2 not found. Install: npm install -g pm2
  exit /b 1
)

pm2 describe misa-dashboard >nul 2>&1
if errorlevel 1 (
  echo Starting misa-dashboard on port %PORT%...
  pm2 start ecosystem.config.js
) else (
  echo Restarting misa-dashboard...
  pm2 restart misa-dashboard
)

timeout /t 2 /nobreak >nul

REM --- 2) Check local server ---
curl -s -o nul -w "%%{http_code}" http://localhost:%PORT%/ 2>nul | findstr /r "^200$" >nul
if errorlevel 1 (
  echo [WARN] Dashboard not responding on http://localhost:%PORT% yet — wait a few seconds.
) else (
  echo [OK] Dashboard is up: http://localhost:%PORT%
)

echo.
echo API key is in server-config.json ^(use in dashboard / API calls^)
echo.

REM --- 3) ngrok ---
where ngrok >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ngrok not in PATH.
  echo Install: https://ngrok.com/download
  echo Then: ngrok config add-authtoken YOUR_TOKEN
  echo.
  echo Dashboard still runs locally: http://localhost:%PORT%
  pause
  exit /b 1
)

echo Starting ngrok tunnel to port %PORT%...
echo Press Ctrl+C to stop ngrok ^(dashboard keeps running in PM2^)
echo.

if defined NGROK_DOMAIN (
  if not "%NGROK_DOMAIN%"=="" (
    ngrok http %PORT% --domain=%NGROK_DOMAIN%
    goto :done
  )
)

ngrok http %PORT%

:done
endlocal
