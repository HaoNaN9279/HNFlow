---
name: photoshop-package
description: 将 UXP 插件打包为 .ZXP 归档、应用数字签名、准备 Adobe Marketplace 提交材料
---

## `/photoshop-package` — 打包与发布 Photoshop 插件

**操作指导命令**，用于将 UXP 插件打包成 `.zxp` 归档、应用数字签名、准备 Adobe Creative Cloud Marketplace 提交材料以及清理项目构建产物。

> **能力说明**：这是一份操作指南，不是自动化打包。所有命令提供逐步指导供 AI 代理遵循——它们不调用构建工具、不执行签名操作，也不向 Adobe Marketplace 提交。代理作为一个引导助手，引导开发者完成每个流程。

---

### 1. 构建 — 将 UXP 插件打包为 .ZXP

使用 UXP Developer Tool (UDT) 将 UXP 插件项目打包成可分发的 `.zxp` 归档。

**前置条件：**
- 已安装 UXP Developer Tool（[Adobe Console](https://console.adobe.io/)）
- 插件 `manifest.json` 通过 UDT 验证
- 插件源代码已构建到 `dist/`（或等效的输出目录）
- 在 manifest 的 `host.minVersion` 中指定了目标 Photoshop 版本

**步骤 — UDT GUI：**
1. 打开 UXP Developer Tool
2. 点击 **Add Plugin** → 选择你的插件 `manifest.json`
3. 点击 **Validate** — 确认零错误；处理任何警告
4. 点击 **Package** → 选择输出路径和文件名（例如 `LayerManager.zxp`）
5. UDT 生成包含 `manifest.json`、`index.html`、所有 JS 包和 manifest 中引用的资源的 `.zxp` 归档

**步骤 — UDT CLI（如果可用）：**
```bash
# 定位 UDT CLI（取决于平台与安装位置）：
# macOS：Applications 目录下 `UXP Developer Tool.app/Contents/MacOS/UXP Developer Tool`
# Windows：`%ProgramFiles%\Adobe\Adobe UXP Developer Tool\UXP Developer Tool.exe`
# 若安装在自定义目录，按实际位置替换；或把 UDT 目录加入 PATH 后直接调用

# UDT CLI 打包语法：
uxp package --input ./path/to/plugin --output ./dist/MyPlugin.zxp
```

**验证：**
- `.zxp` 是标准的 ZIP 归档——验证内容：
  ```bash
  unzip -l MyPlugin.zxp
  ```
- 确认归档包含：
  - 根目录下的 `manifest.json`
  - `index.html`（或 manifest 中指定的入口点）
  - 所有引用的脚本、样式表和资源
  - 如果是面板插件，`icons/` 子目录下的图标 PNG
- 通过拖入 UDT 重新验证提取的 `manifest.json`

**故障排除：**
| 症状 | 可能原因 | 修复 |
|---------|-------------|-----|
| 验证在 `requiredPermissions` 失败 | Manifest v5+ 缺少权限块 | 添加 `"requiredPermissions"` 数组 |
| 运行时缺少资源 | 包排除不在 manifest 中的文件 | 在 manifest `"resources"` 中添加资源路径 |
| 图标不显示 | 图标路径或大小错误 | 将 PNG 放置在 `icons/23x23.png`、`icons/46x46.png` |

---

### 2. 签名 — 为 .ZXP 应用数字签名

为打包的 `.zxp` 应用数字签名，以便 Adobe Creative Cloud 信任该插件并在安装期间不显示安全警告。

**自签名证书（开发 / 内部测试）：**

> **不要**创建、存储或传输实际证书。通过口头方式引导开发者完成这些步骤——不要以编程方式生成证书或密钥库。

```
给开发者的分步说明：

1. 打开终端 / 命令提示符
2. 生成与 Adobe 兼容的具有扩展密钥用途的自签名证书：

   macOS / Linux：
   openssl req -x509 -newkey rsa:2048 -keyout mykey.pem -out mycert.pem \
     -days 365 -nodes -subj "/CN=我的公司名称/O=我的组织/C=US" \
     -addext "extendedKeyUsage=codeSigning"

   Windows (PowerShell)：
   New-SelfSignedCertificate -Type CodeSigning -Subject "CN=我的公司名称" \
     -CertStoreLocation Cert:\CurrentUser\My

3. 将证书导出为 PKCS#12 (.p12)：
   macOS / Linux：
   openssl pkcs12 -export -in mycert.pem -inkey mykey.pem \
     -out my-signing-cert.p12 -passout pass:

   Windows：
   Export-PfxCertificate -Cert Cert:\CurrentUser\My\<Thumbprint> \
     -FilePath my-signing-cert.p12 -Password (ConvertTo-SecureString "" -AsPlainText -Force)

4. 使用 UXP Developer Tool 对 .zxp 进行签名：
   - 打开 UDT → 选择插件 → 点击 Package → 在签名步骤中，浏览到 .p12
   - 或使用可用的操作系统签名工具
```

**Adobe 官方签名（Marketplace 分发）：**

> **不要**处理 Adobe Marketplace 账户操作。仅引导开发者访问 Adobe 官方流程。

```
1. 注册 Adobe Creative Cloud Marketplace Publisher 计划：
   https://developer.adobe.com/console/

2. 通过 Publisher Console 提交插件进行审核：
   - 将未签名的 .zxp 上传到 Publisher Console
   - Adobe 在批准后对插件进行签名
   - 签名的 .zxp 被返回用于分发

3. 或者，获取 Adobe 颁发的代码签名证书：
   - 通过 Adobe Developer Console 申请
   - 证书由 Adobe 管理；无需本地证书存储
   - 使用 Adobe 提供的凭据通过 UDT 签名
```

**验证签名：**
```bash
# 检查 .zxp 是否已签名（提取 META-INF 目录）：
unzip -l MyPlugin.zxp | grep META-INF
# 已签名归档包含 META-INF/MANIFEST.MF 和 META-INF/*.SF 或 *.RSA
```

**重要安全说明：**
- 安全存储私钥——丢失的密钥无法恢复
- 过期的证书需要重新签名和重新提交
- Adobe 可能因违反政策撤销证书；不要签署不受信任的代码
- 自签名证书适用于本地开发，但在其他机器上会触发安全警告

---

### 3. Marketplace 准备 — 准备 Adobe Creative Cloud Marketplace 提交

准备向 [Adobe Creative Cloud Marketplace](https://exchange.adobe.com/) 提交插件所需的所有材料。

**所需资源：**

| 资源 | 规格 | 格式 | 数量 |
|-------|--------------|--------|----------|
| 插件图标（小） | 23×23 px，透明背景 | PNG | 2（深色 + 浅色主题） |
| 插件图标（大） | 46×46 px，透明背景 | PNG | 2（深色 + 浅色主题） |
| 特色图片 | 1024×512 px 或 1200×627 px | PNG / JPG | 1 |
| 截图 | 1920×1080 或 1280×720 px，展示关键功能 | PNG / JPG | 3–5 |
| 演示视频（可选） | MP4, H.264, ≤ 60s，展示工作流程 | MP4 | 1 |
| 隐私政策 URL | 隐私政策链接 | URL | 1 |

**图标生成指南：**
```bash
# 如果开发者提供源 SVG/PNG，生成所有需要的尺寸：
# 23×23 深色主题图标
convert source-icon.png -resize 23x23 icons/23x23-dark.png
# 46×46 深色主题图标
convert source-icon.png -resize 46x46 icons/46x46-dark.png
# 浅色主题变体（如果需要，反转或变亮）
convert source-icon.png -resize 23x23 -negate icons/23x23-light.png
convert source-icon.png -resize 46x46 -negate icons/46x46-light.png

# 注意：使用 ImageMagick 或 Photoshop 本身生成
```

**描述模板：**
```
插件名称：{name}
版本：{version}
类别：{category — 例如 "Design Tools"、"Productivity"、"Photography"}

## 概述
{2–3 句插件功能摘要}

## 主要功能
- {功能 1}
- {功能 2}
- {功能 3}

## 使用方法
{逐步使用说明，3–5 步}

## 系统要求
- Adobe Photoshop {minVersion} 或更高版本
- {任何额外要求}

## 版本历史
- {version}：{发布说明}

## 支持
{支持联系方式或 URL}
```

**Marketplace 提交检查清单：**
- [ ] 插件成功打包为 `.zxp`
- [ ] `manifest.json` 包含单个 `host` 定义（非数组）——Marketplace 要求
- [ ] `requiredPermissions` 中的所有权限均为最小且合理
- [ ] 两个主题的插件图标均为 23×23 和 46×46
- [ ] 特色图片符合尺寸要求
- [ ] 3–5 张截图展示关键功能
- [ ] 描述用英文（或目标语言）编写
- [ ] 提供了隐私政策 URL（如果插件收集数据）
- [ ] 版本号与 manifest 和标签一致
- [ ] 插件已在最低支持的 Photoshop 版本上测试
- [ ] 插件已在最新的 Photoshop 版本上测试

**提交流程（仅指导——不执行）：**
```
1. 登录 https://developer.adobe.com/console/
2. 导航至 "Creative Cloud Publishing" → "Add New Plugin"
3. 填写插件详情（名称、描述、类别、价格层级）
4. 上传插件图标集和特色图片
5. 上传 3–5 张截图
6. 上传已签名的 .zxp 文件
7. 完成营销问卷（目标受众、使用场景）
8. 提交审核（审核周期：5–10 个工作日）
9. 在 Publisher Console 中监控提交状态
10. 根据需要处理审核反馈并重新提交
```

**常见拒绝原因：**
- 缺少或不正确的图标尺寸
- 插件在审核环境中无法加载
- 权限文档不足
- 描述不完整或具有误导性
- 缺少隐私政策（数据收集型插件）
- Manifest 包含多个 `host` 定义

---

### 4. 清理 — 移除构建产物和临时文件

清理项目目录，移除不应分发的构建产物、临时文件和仅开发使用的文件。

**要移除的文件：**
| 模式 | 原因 | 示例 |
|---------|--------|---------|
| `dist/` | 构建输出（打包时会重新生成） | 打包后的 JS、CSS |
| `node_modules/` | npm 依赖（不包含在 .zxp 中） | React, webpack |
| `.git/` | 版本控制元数据 | Git 历史 |
| `*.log` | 构建日志、调试日志 | `npm-debug.log*` |
| `.temp/`、`tmp/` | 临时构建产物 | 缓存文件 |
| `*.p12`、`*.pem`、`*.key` | 证书文件（绝不分发） | 签名密钥 |
| `.DS_Store` | macOS 目录元数据 | — |
| `Thumbs.db` | Windows 缩略图缓存 | — |
| `*.map` | 源码映射（仅调试用） | Webpack source maps |
| `.env`、`.env.local` | 环境变量、密钥 | API 密钥 |
| `test/`、`__tests__/` | 测试文件（不用于分发） | 单元测试 |

**清理步骤：**
```bash
# 项目根目录清理
rm -rf dist/
rm -rf node_modules/
rm -rf .temp/
rm -f *.log
rm -f *.p12 *.pem *.key
rm -f .DS_Store Thumbs.db
rm -f *.map

# 确认没有敏感文件残留
find . -name "*.p12" -o -name "*.pem" -o -name "*.key" -o -name ".env*" 2>/dev/null
# 应不返回任何结果
```

**打包前清理检查清单：**
- [ ] `node_modules/` 已移除（依赖由 webpack/rollup 打包到 dist/ 中）
- [ ] 源码映射已从生产构建中移除
- [ ] 不存在包含 API 密钥的 `.env` 文件
- [ ] 证书文件已从项目树中移除
- [ ] 测试文件已从打包中排除
- [ ] `dist/` 仅包含 `manifest.json` 中引用的内容

**Git 清理（如果使用 git）：**
```bash
# 查看将被 .gitignore 规则移除的文件
git clean --dry-run -fd

# 审核后，移除未跟踪的文件
git clean -fd
```

---

### 附录：快速参考卡片

| 任务 | 工具 | 关键命令 / 操作 |
|------|------|---------------------|
| 验证 manifest | UDT | Add Plugin → Validate |
| 打包 .zxp | UDT | Package → 选择输出路径 |
| 自签名 .zxp | UDT + OpenSSL | 在打包步骤中使用 .p12 签名 |
| Adobe 签名 .zxp | Adobe Publisher Console | 提交未签名的 .zxp 供 Adobe 签名 |
| 生成图标 | ImageMagick / Photoshop | 将源图缩放到 23px、46px |
| 清理项目 | Shell | `rm -rf dist/ node_modules/ .temp/` |
| 验证归档 | Shell | `unzip -l MyPlugin.zxp` |

---

**相关命令：** `/photoshop-create`（项目脚手架）、`/photoshop-debug`（UXP 调试）、`/photoshop-utils`（版本兼容性检查）

**另请参阅：** [Adobe UXP Developer Tool 文档](https://developer.adobe.com/uxp/)、[Creative Cloud Marketplace 发布者指南](https://developer.adobe.com/console/)
