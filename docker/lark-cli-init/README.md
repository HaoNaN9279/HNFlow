# lark-cli init 镜像（Pattern A）

通过 **init container + 共享 `emptyDir`** 把 `lark-cli` 运行时放进沙箱 Pod，替代 Gateway 在安装时从 GitHub 下载 Linux 二进制。

## 行为

构建期（有网络）下载并 SHA-256 校验官方 `larksuite/cli` Linux release，布局：

```text
/opt/lark-cli/bin/lark-cli                       # 按 uname -m 分派
/opt/lark-cli/linux-amd64/lark-cli
/opt/lark-cli/linux-arm64/lark-cli
/opt/lark-cli/.deerflow-lark-cli-runtime.json    # {"version": "vX.Y.Z"}
```

该布局与 Gateway writer（`_write_lark_cli_sandbox_launcher`）及校验函数（`_validate_lark_cli_sandbox_runtime`）一致，沙箱 PATH 契约保持 `/mnt/integrations/lark-cli/runtime/bin/lark-cli` 不变。

## 与 Pattern B 的区别

Pattern A 把真实二进制和凭据目录挂进沙箱；Pattern B（`lark-cli-broker`）只在 sidecar 持有凭据，沙箱内仅放转发 shim。需要凭据隔离时选 Pattern B。

镜像独立发布，详见根 [RELEASING.md](../../RELEASING.md)。
