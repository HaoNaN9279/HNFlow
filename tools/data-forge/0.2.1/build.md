# Python MCP Server 单文件打包完整指南（uv \+ PyInstaller）

# Python MCP Server 单文件打包完整指南（uv \+ PyInstaller）

将 Python MCP Server 打包为单文件可执行文件是非常常见的需求，这样用户无需安装 Python 环境和任何依赖即可直接使用。以下是针对 uv 包管理和 PyInstaller 单文件模式的完整解决方案，包含跨平台支持和 GitHub Actions 自动化流程。

## 一、项目准备工作

### 1\. 标准 MCP Server 项目结构

```Plain Text
your-mcp-server/
├── src/
│   └── your_mcp_server/       # 你的主包名
│       ├── __init__.py
│       ├── main.py            # 入口文件（必须）
│       └── tools/             # 工具实现
├── pyproject.toml             # uv配置文件
├── uv.lock                    # 锁定依赖版本
└── README.md
```

### 2\. 确保入口文件正确

你的`main\.py`必须有标准的 MCP Server 启动代码：

```python
# src/your_mcp_server/main.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Your MCP Server")

# 定义你的工具
@mcp.tool()
def your_tool(param: str) -> str:
    return f"Result: {param}"

if __name__ == "__main__":
    mcp.run()  # 这是关键，必须直接调用run()
```

### 3\. pyproject\.toml 配置

确保你的`pyproject\.toml`包含正确的依赖和项目信息：

```toml
[project]
name = "your-mcp-server"
version = "0.1.0"
description = "Your MCP Server"
authors = [{"name" = "Your Name", "email" = "your@email.com"}]
requires-python = ">=3.10"
dependencies = [
    "mcp>=1.0.0",
    "python-dotenv>=1.0.0",
    # 其他你的依赖
]

[tool.uv]
python-version = "3.10"  # 使用较低版本以获得更好的兼容性

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

## 二、本地打包步骤

### 1\. 安装必要的工具

```bash
# 安装uv（如果还没装）
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# 在项目目录中创建虚拟环境并安装依赖
uv sync

# 安装PyInstaller到虚拟环境
uv add --dev pyinstaller
```

### 2\. 基础打包命令

```bash
# Windows
uv run pyinstaller --onefile --name your-mcp-server src/your_mcp_server/main.py

# Linux
uv run pyinstaller --onefile --name your-mcp-server src/your_mcp_server/main.py
```

打包完成后，可执行文件会生成在`dist/`目录下。

### 3\. MCP Server 关键打包参数

MCP Server 通过 stdin/stdout 通信，必须添加以下参数确保正常工作：

```bash
uv run pyinstaller \
  --onefile \
  --name your-mcp-server \
  --console \  # 关键：保留控制台，否则无法进行stdio通信
  --noconfirm \
  --clean \
  --strip \  # Linux: 减小文件体积
  --noupx \  # 暂时禁用UPX，避免MCP通信问题
  src/your_mcp_server/main.py
```

**重要警告**：绝对不要使用`\-\-windowed`或`\-\-noconsole`参数！这会导致 MCP Server 无法通过标准输入输出进行通信，客户端将无法连接。

### 4\. 处理隐藏依赖

PyInstaller 有时无法自动检测到 MCP 的某些依赖，需要手动添加：

创建一个`hook\-mcp\.py`文件在项目根目录：

```python
# hook-mcp.py
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all('mcp')
```

然后打包时指定 hook 目录：

```bash
uv run pyinstaller \
  --onefile \
  --name your-mcp-server \
  --console \
  --additional-hooks-dir . \
  src/your_mcp_server/main.py
```

### 5\. 包含额外的数据文件

如果你的 MCP Server 需要读取配置文件、模板等数据文件：

```bash
uv run pyinstaller \
  --onefile \
  --name your-mcp-server \
  --console \
  --add-data "config.json:." \  # Windows使用";"分隔："config.json;."
  --add-data "templates/*:templates/" \
  src/your_mcp_server/main.py
```

在代码中使用以下方式访问这些文件：

```python
import sys
import os

def get_resource_path(relative_path):
    """获取打包后资源文件的绝对路径"""
    if hasattr(sys, '_MEIPASS'):
        # PyInstaller创建的临时文件夹
        base_path = sys._MEIPASS
    else:
        # 开发环境
        base_path = os.path.abspath(".")
    
    return os.path.join(base_path, relative_path)

# 使用示例
config_path = get_resource_path("config.json")
```

## 三、跨平台打包最佳实践

### Windows 特有注意事项

1. **使用 Windows 终端打包**：不要在 WSL 或 Git Bash 中打包 Windows 版本

2. **杀毒软件排除**：打包过程中可能会被杀毒软件误报，将项目目录添加到排除列表

3. **Python 版本**：使用 Python 3\.10 或 3\.11，避免最新版本的兼容性问题

4. **命令示例**：

    ```powershell
    uv run pyinstaller --onefile --name your-mcp-server --console --additional-hooks-dir . src/your_mcp_server/main.py
    ```

### Linux 特有注意事项

1. **使用较旧的 Linux 发行版**：为了获得最大兼容性，建议在 Ubuntu 20\.04 或 CentOS 7 上打包

2. **安装系统依赖**：

    ```bash
    sudo apt update && sudo apt install -y build-essential python3-dev
    ```

3. **静态链接**：添加`\-\-static`参数（如果可能）

4. **命令示例**：

    ```bash
    uv run pyinstaller --onefile --name your-mcp-server --console --strip --additional-hooks-dir . src/your_mcp_server/main.py
    ```

## 四、GitHub Actions 自动化打包

创建文件`\.github/workflows/build\.yml`，实现自动为 Windows 和 Linux 打包：

```yaml
name: Build MCP Server

on:
  push:
    tags:
      - 'v*'  # 当推送v开头的标签时触发
  workflow_dispatch:  # 允许手动触发

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
        python-version: ["3.10"]

    steps:
    - uses: actions/checkout@v4
    
    - name: Set up Python ${{ matrix.python-version }}
      uses: actions/setup-python@v5
      with:
        python-version: ${{ matrix.python-version }}
    
    - name: Install uv
      uses: astral-sh/setup-uv@v3
      with:
        version: "latest"
    
    - name: Install dependencies
      run: uv sync --dev
    
    - name: Build with PyInstaller (Windows)
      if: matrix.os == 'windows-latest'
      run: |
        uv run pyinstaller --onefile --name your-mcp-server --console --additional-hooks-dir . src/your_mcp_server/main.py
        mv dist/your-mcp-server.exe dist/your-mcp-server-windows.exe
    
    - name: Build with PyInstaller (Linux)
      if: matrix.os == 'ubuntu-latest'
      run: |
        uv run pyinstaller --onefile --name your-mcp-server --console --strip --additional-hooks-dir . src/your_mcp_server/main.py
        mv dist/your-mcp-server dist/your-mcp-server-linux
        chmod +x dist/your-mcp-server-linux
    
    - name: Upload artifacts
      uses: actions/upload-artifact@v4
      with:
        name: builds-${{ matrix.os }}
        path: dist/*
    
    - name: Create Release
      if: startsWith(github.ref, 'refs/tags/')
      uses: softprops/action-gh-release@v2
      with:
        files: dist/*
        generate_release_notes: true
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 五、测试打包后的文件

### 1\. 基本功能测试

```bash
# Windows
.\dist\your-mcp-server.exe

# Linux
./dist/your-mcp-server-linux
```

如果程序启动后没有报错并保持运行，说明基本打包成功。

### 2\. MCP 协议测试

使用`mcp\-inspect`工具测试打包后的 MCP Server 是否正常工作：

```bash
# 安装mcp-inspect
npm install -g @modelcontextprotocol/inspect

# 测试Windows版本
mcp-inspect ./your-mcp-server.exe

# 测试Linux版本
mcp-inspect ./your-mcp-server-linux
```

如果能看到你的工具列表，说明打包完全成功。

## 六、常见问题与解决方案

### 1\. \&\#34;找不到模块 mcp\&\#34; 错误

- 确保使用了`\-\-additional\-hooks\-dir \.`参数

- 确保`hook\-mcp\.py`文件在项目根目录

- 尝试显式添加隐藏导入：`\-\-hidden\-import mcp \-\-hidden\-import mcp\.server\.fastmcp`

### 2\. 客户端无法连接到 MCP Server

- **最常见原因**：使用了`\-\-windowed`或`\-\-noconsole`参数，必须使用`\-\-console`

- 检查是否有杀毒软件阻止了程序的标准输入输出

- 尝试在命令行直接运行可执行文件，查看是否有错误输出

### 3\. 文件体积过大

- 使用`\-\-strip`参数（Linux）

- 使用 UPX 压缩（注意：可能导致 MCP 通信问题，需要测试）

    ```bash
    uv run pyinstaller --onefile --console --upx-dir /path/to/upx src/your_mcp_server/main.py
    ```

- 移除不必要的依赖

### 4\. Windows Defender 误报

- 这是 PyInstaller 打包的常见问题

- 可以考虑使用数字签名

- 在 README 中说明这是误报，并提供源代码供用户自行编译

## 七、发布到 GitHub

1. 提交所有代码到 GitHub

2. 创建一个新的标签：

    ```bash
    git tag v0.1.0
    git push origin v0.1.0
    ```

3. GitHub Actions 会自动运行并创建 Release，包含 Windows 和 Linux 的可执行文件

4. 在 README 中添加下载链接和使用说明

## 八、用户使用说明

用户下载后，只需在他们的 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "your-mcp-server": {
      "command": "./path/to/your-mcp-server"  # Windows使用反斜杠
    }
  }
}
```

无需安装 Python 或任何其他依赖。

需要我帮你生成一个完整的`pyproject\.toml`和`build\.yml`文件模板，直接替换成你的项目名称即可使用吗？

> （注：文档部分内容可能由 AI 生成）
