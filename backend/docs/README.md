# 后端文档

开发约束与架构唯一来源是 [../AGENTS.md](../AGENTS.md)。本目录只保留专题文档。

## 核心

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统架构 |
| [API.md](API.md) | API 参考 |
| [CONFIGURATION.md](CONFIGURATION.md) | 配置项 |
| [RUN_EVENT_STREAM.md](RUN_EVENT_STREAM.md) | 运行事件流契约（改契约需同步） |
| [STREAMING.md](STREAMING.md) | 流式设计 |

## 功能与运维

| 文档 | 内容 |
| --- | --- |
| [FILE_UPLOAD.md](FILE_UPLOAD.md) | 文件上传与转换 |
| [PATH_EXAMPLES.md](PATH_EXAMPLES.md) | 虚拟路径与映射 |
| [MCP_SERVER.md](MCP_SERVER.md) | MCP 集成 |
| [summarization.md](summarization.md) | 上下文压缩 |
| [BLOCKING_IO_DETECTION.md](BLOCKING_IO_DETECTION.md) | 阻塞 IO 静态检测 |
| [REPLAY_E2E.md](REPLAY_E2E.md) | 回放测试与重新录制 |
| [APPLE_CONTAINER.md](APPLE_CONTAINER.md) | Apple Container 沙箱 |
| `memory-settings-sample.json` | 记忆配置示例 |

## 约定

- 新增/修改运行事件、配置项、API 或工作流契约时同步对应文档与测试。
- 一次性计划、RFC、任务清单不进入本目录。
