# HNFlow

HNFlow 是运行在 DeepSeek Harness 上的**约束式工作流插件**。
它把工作流定义为节点契约、边条件和人工门禁，由插件自己的状态机编排，节点执行交给 DSH subagent。

本仓库只保留 DSH 插件 `dsh-hnflow`；旧的 Python/Next.js 单体、Docker 编排、旧画布与旧引擎已移除。

## 入口

| 内容 | 位置 |
| --- | --- |
| 安装、页面、命令、工具、测试 | [`plugins/dsh/README.md`](plugins/dsh/README.md) |
| 设计、边界、实现差异 | [`docs/dsh-plugin-plan-v2.md`](docs/dsh-plugin-plan-v2.md) |
| 为什么做约束式流程 | [`docs/新开发理念.md`](docs/新开发理念.md) |
| DSH 升级回归 | [`docs/dsh-upgrade-checklist.md`](docs/dsh-upgrade-checklist.md) |

## 快速开始

```sh
dsh plugin --profile desktop add "D:/workspace/HNFlow/plugins/dsh"
```

安装后在会话模式中选择 **HNFlow**。详细依赖（VibeStack ≥ 0.3.0）与配置见
[`plugins/dsh/README.md`](plugins/dsh/README.md)。

## 测试

```sh
cd plugins/dsh
node test/run.mjs
```

## 目录

```text
plugins/dsh/       插件源码、技能、示例与测试（本仓库唯一代码交付物）
docs/              当前设计、理念与升级回归文档
LICENSE
```
