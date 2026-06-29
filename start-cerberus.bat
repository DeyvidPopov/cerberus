@echo off
REM ===========================================================================
REM  Cerberus demo launcher (Windows)
REM  Starts the API server via npm, then launches the packaged desktop .exe.
REM  The .exe is the CLIENT only; it talks to the server over http://localhost:8080.
REM
REM  Prereqs:
REM    * PostgreSQL running on :5433 (per .env: cerberus/cerberus @ 127.0.0.1:5433)
REM    * The app built once:  cd apps\desktop  &&  npm run tauri:build
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo === Cerberus demo launcher ===
echo.

REM --- 1) Apply any pending DB migrations (idempotent) -----------------------
echo [1/3] Applying database migrations...
call npm run migrate
if errorlevel 1 (
  echo.
  echo ERROR: migrations failed - is PostgreSQL running on port 5433?
  echo        Start Postgres, then re-run this script.
  echo.
  pause
  exit /b 1
)

REM --- 2) Make sure the app has been built -----------------------------------
REM  The Cargo WORKSPACE shares one target dir at the repo root (not under src-tauri).
set "APP=target\release\cerberus-desktop.exe"
if not exist "%APP%" (
  echo.
  echo ERROR: %APP% not found.
  echo        Build it first:  npm --prefix apps\desktop run tauri:build
  echo.
  pause
  exit /b 1
)

REM --- 3) Start the server in its own window, then launch the app -------------
echo [2/3] Starting the Cerberus server  (http://localhost:8080)...
start "Cerberus Server" cmd /k "npm --prefix apps\server run start"

echo [3/3] Launching the desktop app...
timeout /t 3 /nobreak >nul
start "" "%APP%"

echo.
echo Server is running in the "Cerberus Server" window; the app has launched.
echo Close that window to stop the server.
endlocal
