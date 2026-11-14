# ComfyUI CLI 使用参考

通过 DataForge CLI 连接本地的 ComfyUI 服务器，支持工作流提交、执行追踪和输出下载。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--workflow`、`--output-dir`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## 前置条件

- **ComfyUI 服务器** 正在运行，默认地址为 `http://127.0.0.1:8188`
- **工具依赖** 已安装（路径见 ``hnflow-stack tool list``）：

```bash
cd <工具路径>
uv sync
```

## 调用方式

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui <subcommand> [参数]
```

| 部分 | 说明 |
|------|------|
| `--project` | 工具绝对路径（见 ``hnflow-stack tool list``） |
| `python -m data_forge.tools.comfyui` | 以模块方式运行 ComfyUI CLI |
| `<subcommand>` | 子命令：`status`、`run`、`batch`、`queue-size` |

## 全局参数

以下参数适用于多个子命令：

| 参数 | 类型 | 适用子命令 | 说明 |
|------|------|-----------|------|
| `--server` | `str` | 全部 | ComfyUI 服务器地址，默认 `http://127.0.0.1:8188` |
| `--workflow` | `str` | `run`, `batch` | 工作流 JSON 文件路径（**必须使用绝对路径**） |
| `--output-dir` | `str` | `run`, `batch` | 输出目录路径（**必须使用绝对路径**） |
| `--timeout` | `float` | `run`, `batch` | 单次请求超时秒数 |

---

## `status` — 检查服务器状态

检查 ComfyUI 服务器是否可达。

### 参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--server` | `str` | 否 | 服务器地址，默认 `http://127.0.0.1:8188` |

### 示例

```bash
# 检查默认地址的服务器状态
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui status

# 指定服务器地址
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui status --server http://192.168.1.100:8188
```

### 输出说明

- 服务器可达时返回成功信息。
- 服务器不可达时返回连接错误提示。

---

## `run` — 执行单个工作流

提交工作流 JSON 到 ComfyUI 执行，等待完成后下载输出文件。

### 参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--server` | `str` | 否 | 服务器地址，默认 `http://127.0.0.1:8188` |
| `--workflow` | `str` | 是 | 工作流 JSON 文件路径（**必须使用绝对路径**） |
| `--output-dir` | `str` | 是 | 输出文件保存目录（**必须使用绝对路径**） |
| `--node-override` | `str` | 否 | JSON 字符串，节点覆盖参数（合并到工作流的指定节点） |
| `--timeout` | `float` | 否 | 单次请求超时秒数，默认 `30.0` |

### 示例

```bash
# 执行默认工作流
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui run \
  --server http://127.0.0.1:8188 \
  --workflow /path/to/workflows/txt2img.json \
  --output-dir /path/to/output

# 覆盖节点参数（将节点 3 的 seed 设为 42）
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui run \
  --server http://127.0.0.1:8188 \
  --workflow /path/to/workflows/txt2img.json \
  --output-dir /path/to/output \
  --node-override '{"3":{"inputs":{"seed":42}}}'

# 指定超时时间
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui run \
  --server http://127.0.0.1:8188 \
  --workflow /path/to/workflows/img2img.json \
  --output-dir /path/to/output \
  --timeout 60.0
```

### 节点覆盖说明

`--node-override` 参数接受 JSON 格式字符串，键为工作流中的节点 ID，值为要合并的节点配置。覆盖采用**深度合并**策略，只会替换指定字段，不影响节点原有其他配置。

---

## `batch` — 批量参数扫描

使用不同的参数集多次执行同一个工作流，每个参数集的输出保存到独立的子目录中。

### 参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--server` | `str` | 否 | 服务器地址，默认 `http://127.0.0.1:8188` |
| `--workflow` | `str` | 是 | 工作流 JSON 文件路径（**必须使用绝对路径**） |
| `--output-dir` | `str` | 是 | 输出根目录，每个批次创建 `batch_N` 子目录（**必须使用绝对路径**）
| `--param-list` | `str` | 否 | JSON 数组字符串，每项为节点覆盖字典 |
| `--timeout` | `float` | 否 | 单次请求超时秒数，默认 `3600.0` |

### 示例

```bash
# 使用多组参数批量执行
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui batch \
  --server http://127.0.0.1:8188 \
  --workflow /path/to/workflows/txt2img.json \
  --output-dir /path/to/batch-output \
  --param-list '[{"3":{"inputs":{"seed":1}}},{"3":{"inputs":{"seed":2}}},{"3":{"inputs":{"seed":3}}}]'

# 无参数列表时仅使用原始工作流执行一次
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui batch \
  --server http://127.0.0.1:8188 \
  --workflow /path/to/workflows/txt2img.json \
  --output-dir /path/to/batch-output
```

### 输出目录结构

```
batch-output/
├── batch_0/    # 第一组参数输出
├── batch_1/    # 第二组参数输出
└── batch_2/    # 第三组参数输出
```

---

## `queue-size` — 查看执行队列

查询 ComfyUI 服务器当前队列中待执行的任务数量。

### 参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `--server` | `str` | 否 | 服务器地址，默认 `http://127.0.0.1:8188` |

### 示例

```bash
# 查看队列大小
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui queue-size

# 指定服务器
hnflow-stack tool exec data-forge python -m data_forge.tools.comfyui queue-size \
  --server http://127.0.0.1:8188
```

### 输出说明

返回队列中剩余待执行任务数量。服务器不可达时返回 `-1`。
