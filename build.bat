@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  HNFlow 一键构建
echo ============================================

REM 1. 检查 bun
where bun >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 bun，请先安装: https://bun.sh
    pause
    exit /b 1
)
echo [1/4] bun 已安装:
bun --version

REM 2. 安装依赖（先装齐，bun test 会扫描全项目含 desktop 测试）
echo [2/4] 安装根依赖...
bun install
if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)

echo [2/4] 安装 desktop 依赖...
pushd apps\desktop
bun install
if errorlevel 1 (
    echo [错误] desktop 依赖安装失败
    pause
    exit /b 1
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

REM 3. 核心库验证
echo [3/4] 核心库类型检查...
bunx tsc --noEmit
if errorlevel 1 (
    echo [错误] 类型检查未通过
    pause
    exit /b 1
)

echo [3/4] 全量测试...
bun test
if errorlevel 1 (
    echo [错误] 测试未通过
    pause
    exit /b 1
)

REM 4. desktop 构建
echo [4/4] 构建 desktop...
bun run build
if errorlevel 1 (
    echo [错误] desktop 构建失败
    pause
    exit /b 1
)
popd

echo ============================================
echo  构建成功: 核心库 OK / desktop OK
echo ============================================
pause
