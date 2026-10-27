# HNFlow 发布流程

发布由 **git tag 驱动**：推送 `v*` tag 触发 GitHub Actions 构建与镜像发布。版本号源必须与 tag 完全一致，否则发布被阻断。

## 版本源

| 文件 | 字段 |
| --- | --- |
| `backend/pyproject.toml` | `version = "X.Y.Z"` |
| `frontend/package.json` | `"version": "X.Y.Z"` |

git tag `vX.Y.Z` 是最终标识。镜像按 tag 打标，不读取上述文件；版本门禁保证两者不漂移。

前端「关于」页在构建时读取 `frontend/package.json`，属于派生消费，不需要单独改。

## 辅助脚本

```bash
scripts/bump_version.sh 2.1.0     # 同步所有版本源并自检
scripts/verify_versions.sh 2.1.0  # 校验所有源等于指定版本
```

- 不带参数运行 `verify_versions.sh` 时要求所有源彼此相等。
- 脚本容忍前缀 `v`；不一致时非零退出。

## 发布步骤

1. 同步版本：

   ```bash
   scripts/bump_version.sh 2.1.0
   ```

2. 从 `git log` 整理发布说明；仓库不再维护 `CHANGELOG.md`。
3. 提交版本变更：

   ```bash
   git add -A
   git commit -m "release: v2.1.0"
   ```

4. 打 tag 并推送：

   ```bash
   git tag v2.1.0
   git push origin v2.1.0
   ```

推送后触发 `.github/workflows/container.yaml`，构建并推送后端/前端镜像。

## 版本门禁

发布工作流第一步调用 `.github/workflows/verify-versions.yml`，执行 `scripts/verify_versions.sh` 对比 tag（去掉 `v`）。任一版本源不匹配则门禁失败，所有发布任务跳过。

预发布 tag（如 `v2.1.0-rc1`）走同一流程，版本源必须等于完整字符串。

## 门禁失败恢复

```bash
scripts/bump_version.sh <version>
git commit ...
git tag -d v2.1.0
git tag v2.1.0
git push origin :refs/tags/v2.1.0
git push origin v2.1.0
```

门禁失败时不会发布任何产物，重新打 tag 是安全的。

## Nightly 与 Lark 镜像

- `.github/workflows/nightly.yaml` 从 `main` 发布 nightly 镜像，不受 `v*` 门禁约束，不覆盖 `latest`。
- `.github/workflows/lark-cli-images.yaml` 独立发布 `lark-cli-init` / `lark-cli-broker` 镜像，版本跟随上游 `larksuite/cli`。

两者目前仍保留上游仓库门禁（`github.repository == 'bytedance/deer-flow'`），迁移到 HNFlow 仓库时需同步调整。
