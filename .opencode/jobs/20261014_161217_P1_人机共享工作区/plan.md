# N10b 计划：人机共享工作区治理（P1 切片 6 后半 / §21 第一点）

> 依据：《HNFlow 开发方案》§17（人机共享：独占/共享模式、抢占规则、可见性、防冲突）、§21 第一点（人在软件中操作与 AI 操作并发：状态同步、冲突检测、可见性、抢占，承接第十七节）、§十二 幂等/确认、《HNFlow 开发规划》§四 N10 行 / §五 P1 第 6 项（切片 6 的剩余一半）。
> 状态：**待用户确认**（批准后执行 S1–S7）。
> 前置：切片 1–6 已提交（`b226e89` N10 功能 + 归档 `30d2764`，HEAD=`b226e89`）。
> 非目标提醒：§24.6a 的「共享工作区（黑板）`wf:shared:*`」是 agent 间共享状态，属另一个 P1 项（协作原语），**不在本切片**。

## 1. 范围

**做**：让引擎知道「应用此刻有没有人在用」，并据此**决策**（继续 / 等 / 拒绝 / 抢占）、**记录归属**（谁在用）、**暴露可见性**（人 / 机 / 空闲 / 未知）、**防冲突**（目标在你眼皮底下被改）。

**不做**（明确留后续）：
- 应用原生命中率、GUI 自动化兜底（§17 驱动矩阵的其余驱动）：presence 只走**应用自己声明**的探测命令，不猜。
- 跨进程占用表 / 多人共享（§23.21 单用户本地定位）：presence 与抢占是**进程内**治理，跨进程互斥仍由 N8 license slots（默认 1 = 互斥）承担，不重复造。
- 共享黑板（§24.6a）、前端共享工作区 UI（延续 N7/N10 的前端尾巴 deferred）。

## 2. 复用锚点（不造新栈）

| 已有能力 | 位置 | N10b 用法 |
| --- | --- | --- |
| 唯一准入咽喉 | `apps/session.py::AppSessionManager`（`app:*` 执行器 + 工具网关 `app` provider 都经它） | presence 决策落在这里，两条入口同时受控，执行器零改动 |
| 声明式能力双条件 | `apps/driver.py::driver_supports_undo`（N10） | presence 用同一模式：`supports_presence` 标志 + `probe_presence` 方法 |
| 冲突策略词汇 | `apps.on_conflict: wait\|fail\|degrade` + `acquire_timeout_seconds`（N8） | `on_human_conflict: fail\|wait\|preempt` 镜像同构；`wait` 复用同一超时旋钮 |
| 已声明产物 | `AppDefinition.artifact_globs` / `version_command` | presence 用 `presence_command`；app 冲突目标默认取 `artifact_globs` |
| 指纹守卫 | `workflow/preview.py` `PreviewTarget{ref,observed}` + `approval.verify_preview_targets`（N10） | 文件级冲突检测直接复用，不新建冲突引擎 |
| 纯函数决策先例 | `scheduler/triggers.py::is_trigger_due`（N7）、`preview.make_preview`（N10） | `decide_access(...)` 同构：决策全在纯函数，I/O 在外面 |
| 实例记录 | `persistence/app_instances`（N6，best-effort 写穿透） | 抢占/交还写进 `resources`，不新增表、**无迁移** |
| 挂起/审批 | `workflow/approval.py`（N10） | 抢占风险作为**声明性** risk 出现在预览里；审批快照**不**冻结 presence（见 D14） |

## 3. 设计决策

- **D1 范围 = §17 人机共享 + §21 第一点**：独占/共享、抢占、可见性、防冲突四件事；黑板协作不做（§24.6a）。
- **D2 presence 是「声明 + 实现」双条件的可选驱动能力**：`driver_supports_presence(driver)` 要求 `supports_presence = True` **且** `probe_presence` 可调用；`AppDriver` 协议**不加**方法（`runtime_checkable` 协议加方法会让既有驱动的 `isinstance` 全部失效，N10 已踩过）。`cli` 仅在定义声明了 `presence_command` 时实现；`mock` 实现以便离线测试。
- **D3 `unknown` 是一等答案，且**不阻塞**：`idle` → 放行；`human`/`busy` → 按策略；`unknown` → **放行并显式标记** `presence_unknown`。理由：只有「确知有人」才拦；对无知 fail-closed 会让所有无法报告 presence 的应用（现实里绝大多数 GUI）一律不可用——那是把功能锁死，不是安全。默认配置（无 `presence_command`）行为与今天**逐字节相同**。
- **D4 决策是纯函数**：`decide_access(report, definition, *, overrides) -> AccessDecision`，返回 `proceed | wait | refuse | preempt` + 理由；零 I/O、决定表全覆盖、可单测。I/O（探测）与阻塞（等待）在 manager。
- **D5 抢占必须显式声明**：只有 `AppDefinition.allow_preempt: true` 才认 `preempt`；未声明时策略回退 `fail` 并给出可执行错误（**永不静默抢占人正在用的软件**）。抢占成立时记 `taken_over_from="human"` + `taken_over_at`，best-effort 写进实例记录 `resources`。
- **D6 presence 检查发生在「取得应用」时**（`launch`/`attach`），不是每次操作：探测要起进程，逐操作探测成本与收益不成立；一次 run 内的归属在取得时确定。按需探测走 `GET /api/apps/{name}/presence` 与工具 `check_app_presence`；`app:script` 可选 `params.check_presence=true` 做逐操作探测。
- **D7 冲突检测复用 N10 指纹守卫，不建新引擎**：
  - 会话级冲突 = presence/holder 观测（人持有引擎正在驱动的实例 → 冲突信号）。
  - 文件级冲突 = `params.detect_conflicts=true` 时**执行器在自身开头**快照目标指纹、**首次改动前**复验，不一致即拒（错误点名 "changed by another actor"）。放在执行器而非包装层，因为要覆盖执行器内部的等待（N8 准入排队、`app:wait`）；审批窗口的长等待已由 N10 包装层守卫覆盖。
  - **不做**「改完后归因」的启发式：无法区分 AI 自己写的文件和人并发写的，猜出来的冲突比没有更糟。诚实边界：这是**乐观检查，不是锁**。
- **D8 不新增节点类型、不改执行器签名**：presence/access 全在 `AppSessionManager`；`app:*` 执行器与工具网关 `app` provider 只读结果。
- **D9 可见性 additive**：`AppSession.to_port()` 加 `holder`/`taken_over_from`；`GET /api/apps/sessions` 加 `holder`；新增 `GET /api/apps/{name}/presence`（off-loop 探测，任何失败降级为 `unknown`）与 `POST /api/apps/sessions/{id}/release`（交还，**不**关闭实例，与 `close` 区分）；app 工具返回 JSON 加 `holder`；builtin 工具 `check_app_presence`。
- **D10 跨进程边界**：presence/抢占是进程内治理（与调度器、内存沙箱、N8 同一单进程契约）；跨进程互斥继续由 N8 license slots + `locks/file_lock.py` 承担。文档写明。
- **D11 配置 additive，`config_version` 38→39**：`apps.on_human_conflict: fail`（默认；`wait` 复用 `apps.acquire_timeout_seconds`）、`AppDefinition.allow_preempt: false`、`AppDefinition.presence_command: null`。`presence_command` 语义：退出码 0 且 stdout 首个非空 token ∈ `{idle, busy, human, unknown}`；**其它一切**（非 0 退出、超时、空/不可解析）→ `unknown`，绝不猜。探测超时复用 `AppDefinition.timeout_seconds`。
- **D12 前端：零改动**（可见性走 API + 端口；前端尾巴延续 deferred）。
- **D13 mock 用 marker 文件脚本化 presence**（工作目录下 `.mock-presence`，内容为状态 token），与既有 `mock-output.txt` 风格一致 → 离线可测，不加 mock 专用配置字段。
- **D14 审批快照刻意不冻结 presence**：presence 在「审批 → 执行」之间变化是**正常且预期**的（人离开/回来）；冻结它会把「人已经离开」当成陈旧而拒绝，与意图相反。因此 presence 只在使用时实时判定，预览里只放一条**声明性**风险（「若 allow_preempt，本节点可能抢占正在使用 <app> 的人」）。
- **D15 无迁移、无新表**：presence/holder 是进程内状态 + 实例记录里的 additive 字段；`app_instances.exclusive` 保持不变（那是**实例基数**语义，与「谁在用」正交，命名上不混用）。

## 4. 步骤

### S1 presence 纯原语
- 新 `apps/presence.py`：`PresenceState`（`idle`/`busy`/`human`/`unknown` 常量 + 校验）、`PresenceReport{state, detail, source, observed_at}`（纯 dataclass）、`AccessDecision{outcome, reason, taken_over_from}`、`decide_access(report, definition, *, on_human_conflict, allow_preempt, presence_observed=True)`。
- 决定表：`idle`→proceed；`human`/`busy` + `fail`→refuse；+ `wait`→wait；+ `preempt` 且 `allow_preempt`→preempt；+ `preempt` 无声明→refuse（理由写明「未声明 allow_preempt」）；`unknown`→proceed（标记）。
- 验收：`tests/test_apps_presence.py`（决定表逐行 + 非法状态 + `unknown` 不阻塞）。

### S2 驱动 presence 能力（声明 + 实现双条件）
- `apps/driver.py`：`driver_supports_presence(driver)`、`driver_presence(driver, definition) -> PresenceReport`（缺能力 → `unknown`，不是异常；异常 → `unknown` + detail）。
- `drivers/cli.py`：`supports_presence = True`，`probe_presence` 仅在定义声明 `presence_command` 时执行（`timeout_seconds` 上限、`_resolve_env` 复用），无声明 → `unknown`。
- `drivers/mock.py`：读工作目录 `.mock-presence`（缺失 → `idle`）。
- 验收：`tests/test_apps_presence_drivers.py`（cli 声明/未声明/非 0 退出/超时/不可解析 token → unknown；mock marker 各状态；无能力驱动 → unknown）。

### S3 配置字段
- `config/apps_config.py`：`AppsConfig.on_human_conflict: Literal["fail","wait","preempt"] = "fail"`、`AppDefinition.allow_preempt: bool = False`、`AppDefinition.presence_command: str | None = None`（strip + 空串归一）。
- `config.example.yaml`：apps 段补三字段注释 + `config_version: 39`；`STARTUP_ONLY_FIELDS["apps"]` 已注册（无需改）。
- 验收：`tests/test_apps_config_presence.py`（默认值 = 今天行为、非法策略拒绝、`presence_command` 归一、`config_version` 由既有 `test_config_version` 覆盖）。

### S4 manager 集成（决策 / 等待 / 抢占 / 交还）
- `apps/session.py`：`probe_presence(app_name) -> PresenceReport`（经驱动能力，结果带短 TTL 缓存避免逐次起进程）、`acquire_access(app_name, *, mode) -> AccessDecision`（`wait` 在 `_lock` 上条件等待至 `apps.acquire_timeout_seconds` 或人类释放，超时 → `refuse`）、`launch()` 前调用它（`refuse` → `AppHumanPresentError`；`preempt` → 记标记）、`release(session_id, *, to="human")`、`AppSession` 加 `holder`/`taken_over_from`/`taken_over_at`（additive 进 `to_port()`）。
- `apps/persistence.py`：抢占/交还写进 `resources`（best-effort，沿用既有三函数之一）。
- 验收：`tests/test_workflow_app_presence.py`（节点级：human+fail → 节点失败且错误可执行；human+wait → 人类释放后放行 / 超时失败；human+preempt 无声明 → 拒绝；有声明 → 放行并记 `taken_over_from`；unknown → 放行且 `session` 端口带 `holder`）。

### S5 冲突检测（复用指纹守卫，独立于审批）
- `workflow/compensation.py` 或新 helper：`ConflictGuard`（`snapshot(targets)` / `verify()` → 变化清单，纯 + N10 指纹复用）。
- 执行器：`data.py` write、`asset.py` import/export/convert、`local_app.py` `app:script`（目标默认取 `artifact_globs` 现存文件，可 `params.conflict_globs` 覆盖）支持 `params.detect_conflicts=true`。
- 验收：`tests/test_workflow_conflict_detection.py`（未开 → 零行为变化；开启 → 目标在快照后被改 → 拒绝并点名；无变化 → 放行；沙箱目标与宿主目标各自路径）。

### S6 API + 可见性 + 工具
- `routers/apps.py`：`GET /api/apps/{name}/presence`（`asyncio.to_thread` 探测，失败 → `unknown` 而非 5xx）、`POST /api/apps/sessions/{id}/release`（交还）、`AppInstanceInfo.holder`、`AppSessionInfo` 来源两条路径都带 `holder`。
- `workflow/tool_gateway.py`：app 工具返回 JSON 加 `holder`（additive）。
- builtin 工具：`check_app_presence`（`workflow_runtime_tools.py` 或 app 相关模块，只读）。
- 验收：`tests/test_app_presence_routes.py`、`tests/test_app_presence_tool.py`。

### S7 文档 + 全量回归 + 提交
- 文档：根/`backend/AGENTS.md`（apps 层 presence/共享小节、Routers 表补两行、config_version 39、`config.example.yaml`）、`HNFlow 开发规划.md`（N10 行 → 完成、P1 第 6 项、M4 行、切片 6 注）。
- 验证：`ruff check` + `format --check` 全绿；全量离线回归（N10 基线 **77 failed / 10300 passed / 104 skipped**，本切片预期同样 75 既有 + flake）；前端 `pnpm test`/`check`（零改动守门）。
- 提交：`feat(apps): N10b 人机共享工作区治理（presence 探测 + 准入决策 + 抢占声明 + 冲突检测）` + 跟踪归档小提交。

## 5. 验证策略

- TDD：每步先写测试；命令 `cd backend` + `$env:PYTHONPATH="."` + `.venv\Scripts\python.exe -m pytest <files> -q -p no:cacheprovider`。
- async 测试须显式 `@pytest.mark.asyncio`（strict 模式）；同步测试内跑异步用 `asyncio.run`。
- `wait` 策略测试用可注入的短超时（`apps.acquire_timeout_seconds`）避免真实等待；释放用第二个线程/事件模拟人类离开。
- 全量：`pytest -m "not live" tests/ -q --tb=line -p no:cacheprovider`。
- 默认行为回归：**无 `presence_command` / 无 `on_human_conflict` 的配置必须逐字节保持现状**（专项断言 + 全量回归佐证）。

## 6. 开放问题（请裁决）

- **Q1 范围**：本切片 = §17「人机共享」四件事（独占/共享、抢占、可见性、防冲突），共享黑板（§24.6a）不做。是否同意？
- **Q2 `unknown` 语义**：未知 presence **放行并标记**（fail-open，保持既有行为；建议）还是**阻塞**（fail-closed，安全但所有无法报告 presence 的应用立刻不可用）？
- **Q3 抢占是否纳入**：纳入（仅 `allow_preempt: true` 声明后生效，未声明回退 `fail`；建议——这是「人在用」治理的核心，缺它本切片只能读不能动）还是本切片只做 `fail`/`wait`，抢占留 N10c？
