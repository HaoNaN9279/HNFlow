---
name: auto-git-commit
description: commit 当前项目变更（含 submodules 支持）
model: standard
---

# `/auto-git-commit` — 自动 Git 提交（含 Submodule 支持）

根据当前项目的 Git 变更，写出规范的 commit message 并提交，**不推送**到远程。
如果项目包含 submodules，会**先逐个子模块提交**，再提交主项目。

## 执行步骤

---

### Step 0: 检查 Submodules

运行 `git submodule status` 检查是否存在 submodule 以及它们是否有变更。

如果命令报错（项目不是 superproject）或返回空，说明没有 submodule，直接跳到 **Step 2**。

对于每个状态为 `+`（未暂存的新提交）或 `-`（submodule 缺失提交）的 submodule，记录下它的路径，进入 **Step 1**。

---

### Step 1: 逐个提交 Submodule（仅对有变更的 submodule）

_所有有变更的 submodule 都需要处理，顺序无关。_

对每个有变更的 submodule：

#### 1.1 查看 submodule 内部变更

进入 submodule 目录：

```bash
cd <submodule-path>
```

查看其工作区状态和 diff：

```bash
git status
git diff --staged
git diff
```

如果 submodule 处于 detached HEAD，仍然可以正常提交（commit 会在当前 detached HEAD 上产生）。

#### 1.2 生成 submodule 的 commit message

根据 submodule 内部的 diff 内容，遵循 Conventional Commits 规范生成 commit message，scope 用 **submodule 相对路径**（例如 `dcc/blender`）：

```
<type>(<submodule-path>): <简短描述>
```

例如：

- `fix(dcc/blender): resolve export crash on empty scene`
- `feat(ai/data-forge): add CSV batch processing pipeline`

#### 1.3 提交 submodule

```bash
git add -A
git commit -m "<commit-message>"
```

如果 submodule 没有变更（`git status` 显示 clean），则跳过该 submodule。

#### 1.4 返回主项目

```bash
cd <回到主项目根目录>
```

---

### Step 2: 查看主项目变更

运行 `git status` 查看当前工作区状态，确认是否有已修改/已暂存的文件。

运行 `git diff --staged` 查看暂存区的变更。如果有未暂存的变更，也要运行 `git diff` 查看工作区变更。

如果存在未暂存的变更，同时也要确认是否有新增的未跟踪文件（`git status` 的输出中会有提示）。

注意：如果 Step 1 中提交了任何 submodule，此时主项目的 `git status` 中会显示那些 submodule 为 `modified`（指针变更）。这些 submodule 的 diff 内容就是指针更新，应当作为主项目 commit 的一部分来提交。

---

### Step 3: 生成主项目 commit message

根据主项目的 diff 内容（包括 submodule 指针更新），遵循 Conventional Commits 规范生成简洁但描述清晰的 commit message：

```
<type>(<scope>): <简短描述>

<详细说明（可选）>
```

- **type**: feat / fix / refactor / chore / docs / style / test / perf / ci / build / revert
- **scope**: 影响的主要模块/目录（可选）
- **描述**: 中文或英文，与项目现有风格保持一致

如果唯一的变更就是 submodule 指针更新，commit message 应当反映 submodule 中的实际变更内容，例如：

```
chore(deps): update submodules

- dcc/blender: fix export crash on empty scene
- ai/data-forge: add CSV batch processing
```

---

### Step 4: 提交主项目

1. 如果有未暂存的变更（包括新文件），先执行 `git add -A` 暂存所有变更
2. 使用上一步生成的 commit message 执行 `git commit -m "<message>"`
3. **不要执行** `git push`

---

### Step 5: 报告结果

提交完成后，输出：
- 每个 submodule 的提交 hash 和 message 摘要（如有）
- 主项目的提交 hash 和 message 摘要
- 当前分支状态（`git status --short`）

## 注意事项

- 只提交，**绝不 push**
- 如果没有任何变更（包括 submodule 内），告知用户并退出
- Commit message 应当清晰反映变更内容，避免无意义的 message（如 "fix"、"update"、"changes"）
- 如果 diff 很大，提取关键变更进行概括，不必逐行描述
- Submodule 的 commit scope 使用其相对路径（如 `core/skills/markitdown`），主项目 scope 按需设置
- Submodule 在 detached HEAD 下也可以提交，不影响后续操作
