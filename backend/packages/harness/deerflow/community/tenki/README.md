# Tenki 沙箱后端

用 [Tenki](https://tenki.cloud) 云沙箱承载每个沙箱：从标准基础镜像创建隔离 microVM，无需本地虚拟化。是容器 AIO 与本地 BoxLite 之外的云端选择。

## 配置

```yaml
sandbox:
  use: deerflow.community.tenki:TenkiSandboxProvider
  api_key: $TENKI_API_KEY
  base_url: https://tenki.cloud
  image: my-base-image
  project_id: proj_...
  workspace_id: ws_...
  cpu_cores: 2
  memory_mb: 2048
  replicas: 3
  idle_timeout: 600
  max_duration: 14400
  sticky: false
  home_dir: /home/tenki
  environment:
    PYTHONUNBUFFERED: "1"
```

```bash
pip install "deerflow-harness[tenki]"
```

`tenki-sandbox` 是可选依赖；API key 见 <https://tenki.cloud/docs/sandbox/sdk>。

## 设计

Tenki SDK 是同步的，适配层直接调用，无事件循环桥接。

- 沙箱按 `user_id:thread_id` 确定性命名，释放到进程内 warm pool，下一轮健康检查后由同一线程回收。
- 终端会话错误会驱逐沙箱；`exec` 不自动重试（非幂等）。
- 创建使用 `wait=False` + `wait_ready()`，确保就绪失败时仍能终止句柄。
- 沙箱以非特权 `tenki` 用户运行，`/mnt/user-data` 重映射到可写 `home_dir`，并尽力 `sudo` 软链。

## 覆盖范围

`execute_command` 走 `sh -lc`；文件传输使用原生 `sandbox.fs`（二进制安全、流式）；`list_dir`/`glob`/`grep` 使用 busybox 兼容的 `find`/`grep`。`download_file` 限制 100MB，且只允许 `/mnt/user-data`。

尚未实现：跨进程孤儿回收、预览 URL。
