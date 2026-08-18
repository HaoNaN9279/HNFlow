@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  HNFlow 启动
echo ============================================

REM 1. 检查 bun
where bun >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 bun，请先安装: https://bun.sh
    pause
    exit /b 1
)
echo [1/3] bun 已安装:
bun --version

REM 2. 确保 desktop 依赖
pushd apps\desktop
if not exist "node_modules" (
    echo [2/3] 未找到 desktop 依赖，安装中...
    bun install
    if errorlevel 1 (
        echo [错误] desktop 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo [2/3] desktop 依赖已就绪
)

REM bun 不执行 electron postinstall，二进制需手动下载
if not exist "node_modules\electron\dist\electron.exe" (
    echo [提示] Electron 二进制缺失，开始下载...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    node node_modules\electron\install.js
    if errorlevel 1 (
        echo [错误] Electron 二进制下载失败
        pause
        exit /b 1
    )
)

REM 3. 构建并启动
if not exist "dist\main.js" (
    echo [3/3] 未找到构建产物，先构建...
    bun run build
    if errorlevel 1 (
        echo [错误] desktop 构建失败
        pause
        exit /b 1
    )
) else (
    echo [3/3] 构建产物已就绪
)

echo 启动 HNFlow...
bunx electron .
if errorlevel 1 (
    echo [错误] Electron 启动失败
    pause
    exit /b 1
)
popd

pause
