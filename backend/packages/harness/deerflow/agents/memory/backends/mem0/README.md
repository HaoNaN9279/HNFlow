# mem0 memory 后端

使用 mem0（托管 API 或兼容的自托管服务）作为记忆存储。进程内无状态：去重、事实抽取与存储都在服务端，适合多 worker Gateway。

## 配置

```yaml
memory:
  enabled: true
  injection_enabled: true
  manager_class: mem0
  mode: middleware            # 或 "tool"
  backend_config:
    api_key_env: MEM0_API_KEY
    base_url: https://api.mem0.ai      # 或自托管地址
    allow_insecure_http: false         # 仅可信本地 HTTP 开发
    top_k: 8
    score_threshold: 0.1
    max_injection_chars: 12000
    timeout_seconds: 10
    startup_policy: fail_fast          # fail_fast | tolerate
    failure_policy:
      read: fail_open                  # fail_open | fail_closed
      write: log_and_drop              # log_and_drop | raise
```

密钥只从环境读取：

```bash
export MEM0_API_KEY=...
```

默认要求 HTTPS，因为请求携带 API token；本地明文 HTTP 必须显式开启 `allow_insecure_http`。
