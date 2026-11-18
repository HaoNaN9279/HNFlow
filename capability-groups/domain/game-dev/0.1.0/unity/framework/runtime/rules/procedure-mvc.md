---
name: procedure-mvc
description: 游戏流程状态机与 MVC 的世界注册、状态切换、生命周期事件、控制器与数据单元约定。
priority: 10
---

# 流程与 MVC

游戏主循环按「流程」组织，UI 与业务数据按「MVC」组织。两者都由 `GameWorld` 持有，不另外造单例。

## 流程（Procedure）

```csharp
var boot = world.ProcedureManager.AddState<BootState>("Boot");
world.ProcedureManager.Start("Boot");
world.ProcedureManager.ChangeState("Lobby");
```

- `AddState<T>(string name)` 返回状态实例，同名重复注册直接抛异常。
- `Start(name)` 只在没有当前状态时使用；已运行时用 `ChangeState(name)` 或 `ChangeState<T>()`。
- 切换过程中再次调用 `ChangeState` 会被忽略，不要靠嵌套切换实现"进入子流程"。
- `Shutdown()` 退出当前状态，`ClearAll()` 清空注册表（退出游戏或回主菜单时用）。

## 流程生命周期

`Enter` / `Tick` / `LateTick` / `Exit` 是**事件**不是虚方法：

```csharp
public sealed class BootState : ProcedureState
{
    protected override void OnCreate()   // 由池创建时
    {
        Enter += OnEnter;
        Tick += OnTick;
        Exit += OnExit;
    }
}
```

- 不要试图 `override` 这四个成员，编译不过。
- 状态实例由引用池创建，`OnCreate` 里订阅、`OnDestroy` 里退订。
- 订阅的处理函数抛出的异常会被吞掉，不中断主循环——出错不会崩，但也不会提示，务必自己 try/catch 并记录。
- 没有自动条件转换；转换条件写在状态自己的 `Tick` 里。

## MVC

```text
ControllerManager
  ├── RegisterController / UnregisterController   控制器注册
  └── AddUnit / RemoveUnit                        数据单元挂载
Model<T> → ReadOnlyModel<T>  外部只读访问
```

- 控制器用 `world.ControllerManager.RegisterController` 注册、`UnregisterController` 注销；注销不会回收实例，由引用池负责。
- 数据模型用 `Model`，对外暴露只读视图 `ReadOnlyModel<T>`；`Value` / `SetValue(T)` / `event Action<T> OnValueChanged` 三件套。
- `ControllerUnit` / `ModelUnit` 要实现的五个方法必须全部实现，缺一个编译不过；空实现写 `{ }` 也不要留抽象。
- 模型不参与 `Tick`：需要逐帧更新时放在流程或控制器的 `Tick` 里。
- `PropertyBinder` 只有抽象基类，绑定逻辑自行派生。

## 约定

- 流程名用静态只读字符串常量，不要在代码里散写字面量。
- 一个流程状态只做一件事；跨流程共享的数据放模型，不放状态字段。
- 控制器不直接持有 `MonoBehaviour`；需要表现层时通过事件或 UI 模块调用。
