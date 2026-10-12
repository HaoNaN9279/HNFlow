@echo off
setlocal EnableExtensions
chcp 65001 >nul
title HNFlow

REM ============================================================
REM  HNFlow one-click launcher (Windows)
REM
REM  Usage:
REM    start.bat            dev mode (default, hot reload)
REM    start.bat prod       prod mode (prebuilt frontend, no hot reload)
REM    start.bat stop       stop all services
REM    start.bat restart    restart (dev mode)
REM    start.bat fast       dev mode, skip dependency install
REM    start.bat help       show help
REM
REM  Opens http://localhost:2026 when ready.
REM  Equivalent to `make dev` / `make start`, but does not require make.
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "ACTION=start"
set "MODE=--dev"
set "SKIP_INSTALL="

REM ---- parse arguments ----
:parse
if "%~1"=="" goto after_parse
set "ARG=%~1"
set "KNOWN=0"
if /I "%ARG%"=="dev"     (set "MODE=--dev"  & set "KNOWN=1")
if /I "%ARG%"=="prod"    (set "MODE=--prod" & set "KNOWN=1")
if /I "%ARG%"=="start"   (set "MODE=--prod" & set "KNOWN=1")
if /I "%ARG%"=="stop"    (set "ACTION=stop" & set "KNOWN=1")
if /I "%ARG%"=="restart" (set "ACTION=restart" & set "KNOWN=1")
if /I "%ARG%"=="fast"    (set "SKIP_INSTALL=--skip-install" & set "KNOWN=1")
if /I "%ARG%"=="--skip-install" (set "SKIP_INSTALL=--skip-install" & set "KNOWN=1")
if /I "%ARG%"=="help"    goto usage
if /I "%ARG%"=="-h"      goto usage
if /I "%ARG%"=="--help"  goto usage
if "%KNOWN%"=="0" echo [HNFlow] Ignoring unknown argument: %ARG%
shift
goto parse

:after_parse

REM ---- locate python ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul && set "PY=py"
)
if not defined PY (
    echo [HNFlow] Python not found. Install Python 3.12+ and add it to PATH.
    goto fail
)

REM ---- require Git for Windows (provides bash for serve.sh) ----
where git >nul 2>nul
if errorlevel 1 (
    echo [HNFlow] git not found. Local mode needs Git for Windows, which provides bash.
    echo          Or use Docker mode after configuring config.yaml / .env.
    goto fail
)

REM ---- dependency check (skipped for stop) ----
if /I "%ACTION%"=="stop" goto run
echo.
echo [HNFlow] Checking dependencies...
%PY% "%ROOT%scripts\check.py"
if errorlevel 1 (
    echo.
    echo [HNFlow] Dependency check failed. Install the missing tools above.
    echo          Note: Windows local mode needs nginx; otherwise use Docker mode.
    goto fail
)

REM ---- open browser once port 2026 is ready ----
call :open_browser_when_ready

REM ---- run serve.sh (Ctrl+C stops all services) ----
:run
set "SERVE_FLAGS=%MODE% %SKIP_INSTALL%"
if /I "%ACTION%"=="stop" set "SERVE_FLAGS=--stop"
if /I "%ACTION%"=="restart" set "SERVE_FLAGS=--restart %MODE% %SKIP_INSTALL%"

echo.
echo [HNFlow] Starting (first run installs dependencies; may take a while)...
call "%ROOT%scripts\run-with-git-bash.cmd" ./scripts/serve.sh %SERVE_FLAGS%

echo.
echo [HNFlow] Services exited.
pause
exit /b 0

REM ---- background: wait for port 2026, then open browser ----
:open_browser_when_ready
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 180;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',2026);$c.Close();Start-Process 'http://localhost:2026';break}catch{Start-Sleep -Seconds 1}}"
exit /b 0

REM ---- help ----
:usage
echo HNFlow one-click launcher
echo.
echo   start.bat            dev mode (default, hot reload)
echo   start.bat prod       prod mode (prebuilt frontend)
echo   start.bat stop       stop all services
echo   start.bat restart    restart (dev mode)
echo   start.bat fast       dev mode, skip dependency install
echo   start.bat help       show this help
echo.
echo   URL: http://localhost:2026
echo   Equivalent: make dev / make start / make stop
exit /b 0

REM ---- failure ----
:fail
echo.
pause
exit /b 1
