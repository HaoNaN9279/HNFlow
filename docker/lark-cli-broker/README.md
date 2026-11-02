# lark-cli broker 镜像（Pattern B）

用一个长期运行的 sidecar 持有 `lark-cli` 与凭据，沙箱内只放一个转发 argv/stdin 的 shim。原始 `appSecret` / OAuth token **不进入沙箱文件系统**，即使 agent 被诱导也无法 `cat` 泄露；授权子命令仍可正常执行。

## 两种模式

由第一个 CLI 参数分派：

- `install-shim <dest>`：init container。把 launcher、Python shim 与 `.deerflow-lark-cli-runtime.json`（`kind: "shim"`）写入共享 `emptyDir`（默认 `/mnt/integrations/lark-cli/runtime`），然后退出。沙箱从 `bin/lark-cli` 找到入口，布局与 Pattern A 一致。
- `serve`（默认 CMD）：sidecar。在 `127.0.0.1:8788` 提供 broker HTTP 服务，真实 `lark-cli` 与凭据只挂载在 sidecar 的 `/var/lark/{config,data}`。

## 与 Pattern A 的区别

| | Pattern A（`lark-cli-init`） | Pattern B（本镜像） |
| --- | --- | --- |
| 凭据位置 | 挂载进沙箱 | 只在 sidecar |
| 沙箱内容 | 真实二进制 | 转发 shim |
| 适用场景 | 信任沙箱 | 需要隔离凭据 |

## 构建与使用

镜像独立发布，不随 HNFlow `v*` 发布，详见根 [RELEASING.md](../../RELEASING.md)。部署时确保沙箱能访问 sidecar 的 loopback 端口，并把 runtime 目录挂到约定路径。
