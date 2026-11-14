# 模型层

模型层是 HNFlow 平台级的命名路由档位。能力组只引用层 id；层到具体 provider/model 的默认路由放在项目的 `.hnflow/models.json`，本机可在全局配置中逐层覆盖。这样同一份能力组可以在 DSH、HNFlow 或其他 Agent 上复用，不把 provider、模型名、凭据写进能力组。

## 1. 归属

| 内容 | 归属 |
|---|---|
| 层 id、名称、描述、排序、内置默认层 | Python Core（`src/hnflow_stack/model_layers.py`） |
| 能力组的 `model` 校验 | Resolver |
| 层 → provider/model/reasoningEffort 的项目默认值 | 项目 `.hnflow/models.json`，按 Agent 分域 |
| 本机逐层覆盖 | 全局配置 `~/.config/hnflow-stack/config.json`，按 Agent 分域 |
| 把层应用到会话 | 各 Agent 插件 |
| DSH 用户自定义层 | 仅 DSH 本机配置；不进入共享内容 |

## 2. 默认层

| id | 名称 | 定位 |
|---|---|---|
| `fast` | 快速 | 检索、摘要、文档查找、简单编辑、格式转换 |
| `standard` | 标准 | 日常开发、命令执行、脚手架、普通问答；默认层 |
| `strong` | 深度 | 架构、规划、复杂调试、代码审查、疑难根因 |
| `vision` | 多模态 | 图像、截图、PDF 页面理解 |

四层现在默认全部绑定到 `deepseek-account / deepseek-flash`。默认层是 `standard`。

## 3. 能力组写法

Agent / 命令 / 技能 frontmatter 只允许可选的 `model`：

```yaml
---
name: Hermes
description: 快速问答与轻量任务执行。
mode: primary
model: fast
---
```

- `model` 可省略；省略表示继承会话当前模型路由，不主动切换。
- 值必须是上表中的平台层 id。
- 不得写 provider、具体模型名、`temperature`、`permission`、`reasoningEffort`。
- DSH 自定义层只在 DSH 本机可用，不能写进共享能力组或 HNFlow 流程。

## 4. resolve 输出

`hnflow-stack resolve --json`（schema v2）新增：

```json
{
  "model_layers": [
    { "id": "fast", "label": "快速", "description": "...", "kind": "speed", "rank": 1 },
    { "id": "standard", "label": "标准", "description": "...", "kind": "balanced", "rank": 2 },
    { "id": "strong", "label": "深度", "description": "...", "kind": "reasoning", "rank": 3 },
    { "id": "vision", "label": "多模态", "description": "...", "kind": "multimodal", "rank": 4 }
  ],
  "model_default": "standard"
}
```

未知层写入 `warnings` 并省略该条目的 `model`。这两个字段始终存在，没有版本开关。

## 5. 项目默认绑定

项目根目录的 `.hnflow/models.json` 暴露四层默认路由，可直接编辑：

```json
{
  "schema_version": 1,
  "default": "standard",
  "bindings": {
    "dsh": {
      "fast": { "provider": "deepseek-account", "model": "deepseek-flash" },
      "standard": { "provider": "deepseek-account", "model": "deepseek-flash" },
      "strong": { "provider": "deepseek-account", "model": "deepseek-flash" },
      "vision": { "provider": "deepseek-account", "model": "deepseek-flash" }
    }
  }
}
```

- `bindings.<agent>` 的 `<agent>` 与 `plugins/<agent>/plugin.json` 的 `agent` 一致。
- 查找顺序：显式项目参数 → `HNFLOW_MODELS_FILE` → 当前目录逐级向上 → `HNFLOW_HOME` / `HNFLOW_REPO` → 全局配置的 `repository`。
- `schema_version` 当前为 `1`；缺失时兼容读取。
- 文件损坏、字段类型错误、未知层、缺少 provider/model 只产生 warning，不阻断启动。
- 这是项目配置中唯一允许出现 provider/model 的文件；能力组仍不得包含宿主模型参数。

## 6. 本机覆盖

全局配置按层覆盖项目默认值，只需写要改的层：

```json
{
  "models": {
    "default": "strong",
    "bindings": {
      "dsh": {
        "fast": { "provider": "local", "model": "small" }
      }
    }
  }
}
```

优先级：

1. 每一层：全局 `models.bindings.<agent>.<layer>` 覆盖项目 `bindings.<agent>.<layer>`。
2. 默认层：全局 `models.default` → 项目 `default` → 内置 `standard`。
3. 未绑定的平台层仍出现在目录中，但不能应用。

`models bind` / `unbind` / `default` 只写全局配置，不会把项目默认值复制进 home。旧 `models.layers` 读取兼容，迁移用 `hnflow-stack models migrate`，`flash` → `fast`。DSH 自定义层放在 `models.custom.dsh`，仅 DSH 设置页或插件可读写。

DSH 设置页中四个平台层只读灰显，默认层由项目配置决定；设置页只管理 DSH 自定义层。保存自定义层时只写 `custom` 与 `default`，不会把项目默认或生效绑定复制进本机配置。

## 7. CLI

```bash
hnflow-stack models catalog [--json]                 # 平台层目录，不需要项目
hnflow-stack models show [--agent dsh] [--json]      # 目录 + 生效绑定；有项目文件时带 config
hnflow-stack models bind <layer> --agent dsh --provider <p> --model <m> [--effort <e>]
hnflow-stack models unbind <layer> --agent dsh
hnflow-stack models default <layer|none>
hnflow-stack models migrate [--agent dsh]
```

## 8. 适配器契约

新增 Agent 适配器时必须：

1. 从 `hnflow-stack models catalog --json`（或 resolve 的 `model_layers`）读取层目录，不硬编码层 id、label、默认层。
2. 从 `hnflow-stack models show --json` 读取生效的 `layers[].binding`、`default` 与 `config`，不自行解析项目文件优先级。
3. 未绑定层可以展示但不可应用；应用失败只告警，不阻断会话。
4. 能力组未指定 `model` 时不切换会话模型。
5. `plugin.json` 的 `capabilities` 声明 `models`；不支持时明确告警。
6. 不得把 provider/model/temperature/permission 写入能力组；项目级默认只放在 `.hnflow/models.json`。

## 9. 失败与迁移

| 情况 | 行为 |
|---|---|
| 层目录不可用 | 插件告警；会话照常启动；模型层功能禁用 |
| 项目文件损坏或字段非法 | warning 并忽略该部分；仍可读全局绑定 |
| 层未绑定 | 列出并标记“未绑定”；应用时告警 `layer-unbound` |
| 绑定路由不在宿主目录 | 设置页/`catalog()` 标记不可路由；不自动改绑定 |
| 旧 `models.layers` | 读取兼容并告警；`hnflow-stack models migrate` 转为 `bindings.dsh`，`flash` → `fast` |
| 能力组引用未知层 | resolver 告警并省略 `model`；不会运行到未定义层 |
