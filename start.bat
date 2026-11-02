@echo off
setlocal EnableExtensions
chcp 65001 >nul
title HNFlow

REM ============================================================
REM  HNFlow one-click launcher (Windows)
REM
REM  Usage:
REM    start.bat            fast mode (production frontend, reuse build)
REM    start.bat dev        dev mode (hot reload)
REM    start.bat prod       prod mode (prebuilt frontend)
REM    start.bat stop       stop all services
REM    start.bat restart    restart (production mode)
REM    start.bat fast       skip dependency install
REM    start.bat install     force dependency install
REM    start.bat help       show help
REM
REM  Opens http://localhost:2026 only after the first frontend route is ready.
REM  First run builds the frontend once; later runs reuse it.
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "ACTION=start"
REM Default is the fast path: reuse a production frontend build.  `dev` is
REM still available explicitly for hot reload.
set "MODE=--prod"
set "SKIP_INSTALL="
set "FORCE_INSTALL="

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
if /I "%ARG%"=="install" (set "FORCE_INSTALL=1" & set "KNOWN=1")
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

REM Dependencies already installed: skip the sync by default.  Use
REM `start.bat install` after changing package manifests.
if not defined SKIP_INSTALL if not defined FORCE_INSTALL if exist "%ROOT%frontend\node_modules" if exist "%ROOT%backend\.venv" set "SKIP_INSTALL=--skip-install"

REM serve.sh opens the browser only after nginx + the first frontend route are
REM actually ready.  Opening it here (on TCP 2026) raced the old instance and
REM the frontend compile, which is what produced the endless loading page.
set "HNFLOW_OPEN_BROWSER=1"

REM ---- run serve.sh (Ctrl+C stops all services) ----
:run
set "SERVE_FLAGS=%MODE% %SKIP_INSTALL%"
if /I "%ACTION%"=="stop" set "SERVE_FLAGS=--stop"
if /I "%ACTION%"=="restart" set "SERVE_FLAGS=--restart %MODE% %SKIP_INSTALL%"

if /I not "%ACTION%"=="stop" (
    echo.
    echo [HNFlow] Starting - production frontend build is reused; first run may build once...
)
call "%ROOT%scripts\run-with-git-bash.cmd" ./scripts/serve.sh %SERVE_FLAGS%

echo.
echo [HNFlow] Services exited.
if /I not "%ACTION%"=="stop" pause
exit /b 0

REM ---- help ----
:usage
echo HNFlow one-click launcher
echo.
echo   start.bat            fast mode (production frontend, reuse build)
echo   start.bat dev        dev mode (hot reload)
echo   start.bat prod       production mode
echo   start.bat stop       stop all services
echo   start.bat restart    restart (production mode)
echo   start.bat fast       skip dependency install
echo   start.bat install    force dependency install
echo   start.bat help       show this help
echo.
echo   URL: http://localhost:2026
echo   First run builds the frontend once; later runs reuse it.
exit /b 0

REM ---- failure ----
:fail
echo.
pause
exit /b 1
