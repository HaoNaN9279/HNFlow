# Caption — AI 训练数据集标注文件管理 CLI

管理 AI 训练数据集的 `.txt` 标注（caption）文件。每个标注文件与对应图片文件名相同（仅后缀不同），存放在同一目录中。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--directory`、`--file`、`--dir`、`--content-file`、`--output`、`--input` 等），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## 调用方式

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.caption <subcommand> [参数]
```

- `<工具路径>` — 工具绝对路径（见 ``hnflow-stack tool list``）
- `<subcommand>` — 操作类型，支持 12 个子命令
- `[参数]` — 各子命令特有的命令行参数

---

## 全局布尔标志

以下为布尔标志位，**出现即生效，无需传值**：

| 标志 | 生效子命令 | 说明 |
|------|-----------|------|
| `--overwrite` | create, import | 覆盖已存在的文件 |
| `--case-sensitive` | search, replace | 区分大小写 |
| `--regex` | search, replace, delete | 使用正则表达式 |
| `--by-filename` | search | 按文件名搜索 |
| `--all` | delete | 删除所有文件 |
| `--word-frequency` | stats | 显示词频统计 |

使用方式：
- `--overwrite` 存在 → 启用覆盖；不传 → 不覆盖
- `--case-sensitive` 存在 → 区分大小写；不传 → 忽略大小写

---

## 子命令参考

### `list` — 列出所有标注文件

**用途**：列出指定目录下所有 `.txt` 标注文件（按文件名排序）。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--directory` | 否 | 目标目录（**必须使用绝对路径**） |

```bash
# 列出指定目录的标注文件
hnflow-stack tool exec data-forge python -m data_forge.tools.caption list --directory /path/to/captions
```

---

### `create` — 创建标注文件

**用途**：创建一个新的 `.txt` 标注文件。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--file` | 是 | 文件名 |
| `--content` | 否 | 标注内容（与 `--content-file` 二选一） |
| `--content-file` | 否 | 从文件读取标注内容，**必须使用绝对路径**（与 `--content` 二选一） |
| `--overwrite` | 否 | 布尔标志，覆盖已存在的文件 |

```bash
# 使用 --content 直接传入内容
hnflow-stack tool exec data-forge python -m data_forge.tools.caption create \
  --directory /path/to/captions \
  --file img001 \
  --content "a cat sitting on a windowsill"

# 使用 --content-file 从文件读取内容
hnflow-stack tool exec data-forge python -m data_forge.tools.caption create \
  --directory /path/to/captions \
  --file img002 \
  --content-file /path/to/descriptions/img002.txt

# 覆盖已存在的文件
hnflow-stack tool exec data-forge python -m data_forge.tools.caption create \
  --directory /path/to/captions \
  --file img001 \
  --content "updated caption" \
  --overwrite
```

---

### `read` — 读取标注文件

**用途**：读取单个标注文件的完整内容。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--file` | 是 | 文件名 |

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.caption read \
  --directory /path/to/captions \
  --file img001.txt
```

---

### `edit` — 编辑标注文件

**用途**：修改已有标注文件的内容，支持替换、追加、前置三种模式。

> ⚠️ **注意**：`edit` 子命令使用 `--dir` 而非 `--directory` 参数。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--file` | 是 | 文件名 |
| `--content` | 是 | 新内容 |
| `--mode` | 否 | 模式：`update`（替换，默认）、`append`（追加）、`prepend`（前置） |
| `--separator` | 否 | 追加/前置时的分隔符，默认空格 |
| `--dir` | 否 | 目标目录，使用 `--dir` 而非 `--directory` |

```bash
# 替换全部内容（默认 mode=update）
hnflow-stack tool exec data-forge python -m data_forge.tools.caption edit \
  --dir /path/to/captions \
  --file img001.txt \
  --content "a dog playing in the park"

# 追加文本
hnflow-stack tool exec data-forge python -m data_forge.tools.caption edit \
  --dir /path/to/captions \
  --file img001.txt \
  --content ", high quality photo" \
  --mode append

# 前置文本
hnflow-stack tool exec data-forge python -m data_forge.tools.caption edit \
  --dir /path/to/captions \
  --file img001.txt \
  --content "masterpiece, " \
  --mode prepend \
  --separator ""

# 使用逗号作为分隔符追加
hnflow-stack tool exec data-forge python -m data_forge.tools.caption edit \
  --dir /path/to/captions \
  --file img001.txt \
  --content "detailed" \
  --mode append \
  --separator ", "
```

---

### `delete` — 删除标注文件

**用途**：删除标注文件，支持三种模式：按文件名、按文件名模式匹配、全部删除。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--file` | 否 | 指定文件名（与 `--pattern`、`--all` 三选一） |
| `--pattern` | 否 | 通配符/正则模式（与 `--file`、`--all` 三选一） |
| `--all` | 否 | 删除所有标注文件（与 `--file`、`--pattern` 三选一） |
| `--regex` | 否 | 布尔标志，`--pattern` 使用正则表达式 |

```bash
# 模式一：按文件名删除单个文件
hnflow-stack tool exec data-forge python -m data_forge.tools.caption delete \
  --directory /path/to/captions \
  --file img001.txt

# 模式二：按通配符模式删除
hnflow-stack tool exec data-forge python -m data_forge.tools.caption delete \
  --directory /path/to/captions \
  --pattern "temp_*.txt"

# 模式二：按正则表达式模式删除
hnflow-stack tool exec data-forge python -m data_forge.tools.caption delete \
  --directory /path/to/captions \
  --pattern "^bad_\d+\.txt$" \
  --regex

# 模式三：删除所有标注文件
hnflow-stack tool exec data-forge python -m data_forge.tools.caption delete \
  --directory /path/to/captions \
  --all
```

---

### `search` — 搜索标注内容

**用途**：在标注文件中搜索指定文本，返回匹配的文件名和内容。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--query` | 是 | 搜索词或正则表达式 |
| `--case-sensitive` | 否 | 布尔标志，区分大小写 |
| `--regex` | 否 | 布尔标志，使用正则搜索 |
| `--by-filename` | 否 | 布尔标志，按文件名搜索（而非文件内容） |

```bash
# 基本搜索（忽略大小写）
hnflow-stack tool exec data-forge python -m data_forge.tools.caption search \
  --directory /path/to/captions \
  --query "cat"

# 区分大小写搜索
hnflow-stack tool exec data-forge python -m data_forge.tools.caption search \
  --directory /path/to/captions \
  --query "Cat" \
  --case-sensitive

# 正则搜索
hnflow-stack tool exec data-forge python -m data_forge.tools.caption search \
  --directory /path/to/captions \
  --query "image_\d+" \
  --regex

# 按文件名搜索
hnflow-stack tool exec data-forge python -m data_forge.tools.caption search \
  --directory /path/to/captions \
  --query "img_*.txt" \
  --by-filename
```

---

### `replace` — 批量搜索替换

**用途**：跨所有标注文件执行文本搜索替换。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--old` | 是 | 被替换的文本或正则模式 |
| `--new` | 是 | 替换后的文本（支持 `\1`、`\2` 等反向引用） |
| `--case-sensitive` | 否 | 布尔标志，区分大小写 |
| `--regex` | 否 | 布尔标志，使用正则替换 |

```bash
# 基本替换（忽略大小写）
hnflow-stack tool exec data-forge python -m data_forge.tools.caption replace \
  --directory /path/to/captions \
  --old "cat" \
  --new "kitten"

# 区分大小写替换
hnflow-stack tool exec data-forge python -m data_forge.tools.caption replace \
  --directory /path/to/captions \
  --old "Cat" \
  --new "Kitten" \
  --case-sensitive

# 正则替换 + 反向引用
hnflow-stack tool exec data-forge python -m data_forge.tools.caption replace \
  --directory /path/to/captions \
  --old "img_(\d+)" \
  --new "photo_\1" \
  --regex
```

---

### `rename` — 重命名标注文件

**用途**：重命名单个标注文件。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--old-name` | 是 | 原文件名 |
| `--new-name` | 是 | 新文件名（自动补 `.txt` 后缀） |

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.caption rename \
  --directory /path/to/captions \
  --old-name img001.txt \
  --new-name photo001.txt
```

---

### `stats` — 统计信息

**用途**：获取标注目录的统计信息，包括文件数、字符数、单词数等，可选显示词频排名。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--word-frequency` | 否 | 布尔标志，显示词频排名 |
| `--top-n` | 否 | 词频排名前 N 个，默认 20（需与 `--word-frequency` 配合） |

```bash
# 基础统计
hnflow-stack tool exec data-forge python -m data_forge.tools.caption stats \
  --directory /path/to/captions

# 统计 + 词频排名 Top 50
hnflow-stack tool exec data-forge python -m data_forge.tools.caption stats \
  --directory /path/to/captions \
  --word-frequency \
  --top-n 50

# 统计 + 默认词频排名 Top 20
hnflow-stack tool exec data-forge python -m data_forge.tools.caption stats \
  --directory /path/to/captions \
  --word-frequency
```

输出包含以下统计指标：`file_count`（文件数）、`total_chars`（总字符数）、`total_words`（总单词数）、`total_lines`（总行数）、`avg_chars`（平均字符数）、`avg_words`（平均单词数）、`min_chars`（最少字符数）、`max_chars`（最多字符数）、`empty_count`（空文件数）。

---

### `export` — 导出标注

**用途**：将所有标注导出为 JSON 或 CSV 文件。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--output` | 是 | 输出文件路径 |
| `--format` | 否 | 导出格式：`json`（默认）或 `csv` |

```bash
# 导出为 JSON
hnflow-stack tool exec data-forge python -m data_forge.tools.caption export \
  --directory /path/to/captions \
  --output /path/to/captions.json

# 导出为 CSV
hnflow-stack tool exec data-forge python -m data_forge.tools.caption export \
  --directory /path/to/captions \
  --output /path/to/captions.csv \
  --format csv
```

JSON 格式：`{"filename.txt": "caption text", ...}`
CSV 格式：列名为 `filename` 和 `content`。

---

### `import` — 导入标注

**用途**：从 JSON 或 CSV 文件导入标注到目录。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input` | 是 | 输入文件路径 |
| `--format` | 否 | 导入格式：`json`（默认）或 `csv` |
| `--overwrite` | 否 | 布尔标志，覆盖已存在的标注文件 |

```bash
# 从 JSON 导入
hnflow-stack tool exec data-forge python -m data_forge.tools.caption import \
  --directory /path/to/captions \
  --input /path/to/captions.json

# 从 CSV 导入（覆盖已存在文件）
hnflow-stack tool exec data-forge python -m data_forge.tools.caption import \
  --directory /path/to/captions \
  --input /path/to/captions.csv \
  --format csv \
  --overwrite
```

---

### `deduplicate` — 去重

**用途**：删除内容完全重复的标注文件，只保留一份。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--keep` | 否 | 保留策略：`first`（保留第一个，默认）或 `last`（保留最后一个） |

```bash
# 默认保留第一个
hnflow-stack tool exec data-forge python -m data_forge.tools.caption deduplicate \
  --directory /path/to/captions

# 保留最后一个
hnflow-stack tool exec data-forge python -m data_forge.tools.caption deduplicate \
  --directory /path/to/captions \
  --keep last
```

---

## 快速参考表

| 子命令 | 用途 | 关键参数 |
|--------|------|----------|
| `list` | 列出标注文件 | `--directory` |
| `create` | 创建标注 | `--file`, `--content`/`--content-file`, `--overwrite` |
| `read` | 读取标注 | `--file` |
| `edit` | 编辑标注 | `--file`, `--content`, `--mode`, `--separator`, `--dir` |
| `delete` | 删除标注 | `--file` / `--pattern` / `--all`, `--regex` |
| `search` | 搜索标注 | `--query`, `--case-sensitive`, `--regex`, `--by-filename` |
| `replace` | 批量替换 | `--old`, `--new`, `--case-sensitive`, `--regex` |
| `rename` | 重命名 | `--old-name`, `--new-name` |
| `stats` | 统计信息 | `--word-frequency`, `--top-n` |
| `export` | 导出标注 | `--output`, `--format` |
| `import` | 导入标注 | `--input`, `--format`, `--overwrite` |
| `deduplicate` | 去重 | `--keep` |
