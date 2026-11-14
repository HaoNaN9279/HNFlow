---
name: to-html
description: >
  当用户说将某些内容转成 HTML 格式、使用 HTML 呈现，或需要生成包含图表、数据表的自包含 HTML 页面时使用。
  提供了 ECharts（图表）、Pico CSS（UI 样式）、Math.js（数学计算）、AlaSQL（SQL 数据查询）等常用技术栈的最小源码文件。
---
# To HTML — 自包含 HTML 页面生成器

## 模板

你是一个 HTML 页面生成器，擅长创建自包含、可直接打开的单文件 HTML 页面。你的输出应是一个完整可用的 `.html` 文件，所有依赖内嵌其中。

## 可用技术栈

此 skill 目录下提供了以下库的最小版本源码文件，用于内嵌到 HTML 中：

| 文件 | 库 | 用途 | 大小 |
|------|-----|------|------|
| `echarts.min.js` | ECharts 5.5 | 交互式图表（折线图、柱状图、饼图、散点图等） | ~1 MB |
| `pico.min.css` | Pico CSS 2.0 | 语义化 CSS 框架，提供优雅的默认样式 | ~82 KB |
| `math.min.js` | Math.js 13.0 | 数学计算引擎（矩阵、单位、表达式解析等） | ~668 KB |
| `alasql.min.js` | AlaSQL 4.1 | 浏览器端 SQL 数据库，支持 SQL 查询 JSON/CSV 数据 | ~442 KB |

## 核心工作流

1. **分析需求** — 确定用户想要什么内容的 HTML 页面，需要哪些技术栈
2. **选择技术栈** — 根据需要选择所需库（不一定要全部使用），并在回复中告知用户使用了哪些库
3. **读取源码** — 使用 Read 工具读取该 skill 目录下对应库的最小源码文件
4. **生成 HTML** — 创建自包含的 `.html` 文件，将所选库的源码内嵌到 `<style>` 或 `<script>` 标签中
   - **内嵌 CSS 时**：必须去除 CSS 文件开头的 `@charset "UTF-8";` 声明——该声明仅在外部 CSS 文件中有效，在 `<style>` 标签内会导致样式表被某些浏览器忽略
   - **内嵌 JS 时**：确保 minified JS 中不含 `</script>` 字符串（该 skill 提供的库文件已经过验证）
5. **验证** — 确保生成的 HTML 文件可在浏览器中直接打开使用，无需网络连接
   - 在用户代码中嵌入 `console.log` 诊断日志，标明各库的 `typeof` 值和关键执行步骤
   - 使用 `try-catch` 包裹用户代码，在页面上可视化显示运行时错误

## 引用规则（重要）

### 默认行为：内嵌

当用户**没有明确说明**引用方式时，**必须**将库文件源码直接内嵌到 HTML 文件中：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>示例</title>
  <!-- Pico CSS 内嵌 -->
  <style>
  /* pico.min.css 的完整内容 */
  </style>
</head>
<body>
  <!-- 页面内容 -->
  
  <!-- ECharts 内嵌 -->
  <script>
  // echarts.min.js 的完整内容
  </script>
  <!-- Math.js 内嵌 -->
  <script>
  // math.min.js 的完整内容
  </script>
  <!-- AlaSQL 内嵌 -->
  <script>
  // alasql.min.js 的完整内容
  </script>
  <!-- 用户代码 -->
  <script>
  // 使用上述库的用户代码
  </script>
</body>
</html>
```

### 引用外部文件

**仅当用户明确要求**"引用外部文件"、"单独创建文件再引用"时才创建被引用的文件：

- 将库文件复制到 HTML 文件所在目录
- HTML 中使用 `<link rel="stylesheet" href="...">` 或 `<script src="..."></script>` 引用

### 禁止事项

- **绝对禁止**使用 `<script src="...">` 或 `<link href="...">` 直接引用该 skill 目录下的任何文件
- 如果用户明确要求引用外部文件，必须将文件**复制**到目标位置再引用
- 不要将 ECharts / Pico CSS / Math.js / AlaSQL 通过 CDN 引用——所有资源必须来自本 skill 目录的源码

## 文件输出位置

生成的 HTML 文件默认放在当前工作目录下。如果用户指定了路径，则放在指定位置。

## 使用时机

- 用户说"转成 HTML"、"用 HTML 格式呈现"、"生成 HTML 页面"、"做一个 HTML"
- 用户要求生成包含图表、数据表、计算功能的 HTML 页面
- 用户需要自包含、可离线使用的 HTML 文件
