# BoxLite 沙箱后端

用 [BoxLite](https://github.com/boxlite-ai/boxlite) micro-VM 承载每个沙箱：无守护进程、OCI 原生、自带内核（Linux 用 KVM/libkrun，macOS 用 Hypervisor.framework）。适合需要比 Docker 更强隔离或更快冷启动的场景。

## 配置

```yaml
sandbox:
  use: deerflow.community.boxlite:BoxliteProvider
  image: python:3.12-slim
  memory_mib: 1024
  cpus: 2
  replicas: 3
  idle_timeout: 600
  health_check_skip_seconds: 0.0
  environment:
    PYTHONUNBUFFERED: "1"
```

```bash
pip install "deerflow-harness[boxlite]"
```

`boxlite` 是可选依赖；仅支持其发布 wheel 且能启动 micro-VM 的 Linux/macOS。Windows 请使用其他 provider。

宿主要求：Linux 需要 KVM（云主机需嵌套虚拟化），macOS 使用 Hypervisor.framework。

## 设计

`Sandbox` 契约是同步的，BoxLite SDK 是异步且句柄绑定事件循环。Provider 在守护线程上持有**一个**私有 asyncio loop，所有协程通过 `run_coroutine_threadsafe` 调度。

- 盒子按 `user_id:thread_id` 确定性命名。
- 每轮结束释放到进程内 warm pool，下一轮由同一线程回收。
- `replicas` 限制 active + warm 总数；`idle_timeout` 控制空闲回收，`0` 关闭。

## 覆盖范围

`execute_command` 走 `sh -lc`；文件读写用 `cat` 与分块 `base64`；`download_file` 限制 100MB 且只在 `/mnt/user-data`；`list_dir`/`glob`/`grep` 使用 busybox 兼容的 `find`/`grep`。启动时创建 `/mnt/user-data/{workspace,uploads,outputs}` 与 `/mnt/skills`。
