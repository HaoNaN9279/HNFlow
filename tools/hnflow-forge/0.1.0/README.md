# hnflow-forge

HNFlow 流程定义（`schemaVersion: 2`）的**离线**工具：静态预检与评审稿渲染。

```bash
hnflow-stack tool run hnflow-forge -- lint <定义文件> [--json]
hnflow-stack tool run hnflow-forge -- render <定义文件> [--out review.md]
```

## lint

复刻 `dsh-hnflow` 0.6.0 的静态校验：形状检查、节点字段、schema 子集、契约可赋值、gate 三分支、输入绑定、judge 独立性、无环、单起点单终点。错误码与插件保持同名。

离线拿不到的两件事只给**警告**：

- 宿主 `presetAllowlist`（默认 `hnflow` / `standard`）；
- 本机模型层是否存在。

**最终以插件 `hnflow_author validate` 为准。**

## render

把定义渲染成面向人评审的 Markdown：启动输入、节点表、边表、人工与验收点、每个节点的契约、运行前提、mermaid 形状图。

## 开发

```bash
uv sync --project tools/hnflow-forge/0.1.0
uv run --project tools/hnflow-forge/0.1.0 pytest -q
uv run --project tools/hnflow-forge/0.1.0 ruff check src tests
```

仅标准库运行时依赖。
