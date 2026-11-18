---
name: add-procedure-state
description: 当用户要新增游戏流程状态（登录、主菜单、战斗、结算等）、或在流程之间切换数据时使用：从建类到注册、订阅生命周期、切换与清理的完整步骤
---

# 新增一个流程状态

把「登录 → 主菜单 → 战斗 → 结算」这类大阶段做成 `ProcedureState` 子类。

## 前置条件

- 已有可运行的 `GameEntry`（见 `framework-onboarding`）。
- 明确流程边界：进入条件、退出条件、需要跨流程共享的数据。

## 工作流

1. **建类**：`public sealed class BattleState : ProcedureState`，放 `Assets/Project/Scripts/Runtime/Gameplay/` 之类按用途分的目录。
2. **订阅生命周期**：在 `OnCreate` 里 `Enter += ...; Tick += ...; Exit += ...`，在 `OnDestroy` 里全部 `-=`。
3. **注册**：在 `OnRegisterGameModules` 里 `world.ProcedureManager.AddState<BattleState>("Battle");`。
4. **启动**：首帧 `world.ProcedureManager.Start("Boot");`，后续用 `ChangeState("Battle")` 或 `ChangeState<BattleState>()`。
5. **清理**：`Exit` 里释放本流程独占的资源与池；`Shutdown()` 或 `ClearAll()` 用于回主菜单/退出。

## 生命周期语义

| 事件 | 时机 | 该做什么 |
|---|---|---|
| `OnCreate` | 引用池创建实例时 | 订阅事件、初始化字段 |
| `Enter` | 切进本流程 | 加载资源、创建控制器、显示 UI |
| `Tick` | 每帧 | 流程内逐帧逻辑 |
| `LateTick` | 每帧表现后 | 相机、UI 跟随 |
| `Exit` | 切出本流程 | 退订、释放、关闭 UI |

## 关键约束

- 四个生命周期是事件，不能 `override`。
- 同名状态重复 `AddState` 抛异常；注册前确认名字唯一。
- 切换过程中再次 `ChangeState` 会被忽略，不要写"进入时立刻再切"。
- 生命周期回调里的异常被吞：写 try/catch，用 `DebugHub.Log` 记录。
- 状态实例由引用池创建，`OnDestroy` 必须退订，否则下局拿到旧订阅。

## 流程间数据

- 共享数据放 `Model`，通过 `ControllerManager` 挂载，流程只读。
- 一次性参数用流程的公共属性传递，不要用静态字段。

## 验收

- [ ] 流程能进、能退，`Exit` 后无残留订阅
- [ ] 重复进入同一流程不会重复注册
- [ ] 崩溃或异常时主循环不中断，日志里有记录
- [ ] 场景切换后旧流程的资源已释放

## 使用时机

新增流程阶段、拆分过大的流程、或流程切换后出现"旧界面还在/事件重复触发"时加载。
