---
name: unreal
---

# Unreal Engine 开发规则

适用于 AI 辅助 Unreal Engine C++ 和 Blueprint 开发的规则。在每个 Unreal 项目中遵守。

## 项目结构

- 遵循 Unreal 的基于模块的架构：每个逻辑系统位于自己的模块中，包含 `Public/` 和 `Private/` 目录。
- 保持 `Source/` 目录整洁：每个模块一个目录，根目录下包含 `.Build.cs` 文件。
- 将游戏逻辑代码与引擎扩展分离；游戏逻辑模块位于 `Source/<ProjectName>/`，引擎/编辑器扩展位于 `Source/<ModuleName>/`。
- 正确使用 Unreal Header Tool（UHT）宏（`UCLASS`、`USTRUCT`、`UPROPERTY`、`UFUNCTION`）；UHT 从中生成反射数据。
- 在 `.Build.cs` 文件中显式配置模块依赖；避免模块之间的循环依赖。

## C++ 编码规范

- 为所有 Unreal 类型添加前缀：`U` 表示 `UObject` 派生类，`A` 表示 `AActor` 派生，`F` 表示结构体和普通数据类型，`I` 表示接口，`E` 表示枚举，`T` 表示模板。
- 始终使用适当的说明符（`BlueprintCallable`、`BlueprintReadOnly`、`EditAnywhere`、`Category`、`meta`）标记 `UFUNCTION` 和 `UPROPERTY`。
- 使用 `TArray` 替代 `std::vector`，`TMap` 替代 `std::unordered_map`，`FString` 替代 `std::string`，`TSharedPtr`/`TUniquePtr` 替代 `std::shared_ptr`/`std::unique_ptr`。
- 使用 `override` 关键字声明覆盖；Unreal 的 `virtual` 函数应始终通过引擎的宏系统进行覆盖。
- 使用 `check()`、`ensure()` 和 `verify()` 宏进行断言 —— 绝不使用原始的 `assert()`。
- 尽可能避免 `Tick()`；优先使用计时器、委托或事件驱动更新。
- 使用带有 `Transient`、`SkipSerialization` 或 `DuplicatesTransient` 说明符的 `UPROPERTY()` 来控制保存/加载/复制行为。

## API 使用模式

- 使用 Gameplay Ability System（GAS）实现复杂的游戏机制：Attributes、GameplayEffects、GameplayAbilities、GameplayTags。
- 优先使用 `Enhanced Input` 而非旧版输入系统；使用 `InputAction` 资源和 `InputMappingContext`。
- 使用 `FSoftObjectPath` 和 `FStreamableManager` 进行异步资源加载；在发布构建中绝不使用同步的 `LoadObject`。
- 在 `UPROPERTY` 字段中优先使用 `TSubclassOf<T>` 进行类引用，而非原始 `UClass*` 指针。
- 使用 `GetWorld()->GetTimerManager()` 实现基于时间的回调；绝不使用自旋等待或 `FPlatformProcess::Sleep()` 进行游戏计时。
- 使用 `FDelegateHandle` 管理委托订阅，并始终在 `EndPlay()` 或析构函数中取消注册。
- 使用 `UWorld::OverlapMultiByChannel()` 或 `OverlapMultiByObjectType()` 批量处理游戏查询，而非每帧调用 `GetAllActorsOfClass()`。

## 性能

- 在优化前使用 `Unreal Insights` 和 `stat` 控制台命令进行分析；针对分析器识别的特定瓶颈。
- 在热路径中避免 `Cast<T>()`；当类型预先已知时，使用 `IsA()` 检查或缓存的弱指针。
- 对频繁生成/销毁的 Actor，通过 `UObjectPool` 或自定义管理器使用对象池。
- 在 `Tick()` 中最小化动态内存分配；当预期大小已知时，使用 `Reserve()` 预分配 `TArray`。
- 仅在分析证明有益时将函数标记为 `FORCEINLINE`；相信编译器的内联启发式算法。
- 使用 `UPrimitiveComponent` 的 LOD 和剔除设置减少绘制调用 —— 仅在必要时配置 `bNeverDistanceCull`。
- 利用 `FQueuedThreadPool` 上的 `ParallelFor` API 进行数据并行操作；绝不手动生成原始线程。

## 常见陷阱

- 垃圾回收：`UObject` 指针必须用 `UPROPERTY()` 标记或添加到 `FGCObjectScopeGuard` 以防止过早 GC；非 `UPROPERTY` 字段中的原始 `UObject*` 是不安全的。
- 绝不手动调用 `BeginPlay()`、`Tick()` 或 `EndPlay()` —— 这些是由 World 调用的引擎生命周期钩子。
- `UObject::CreateDefaultSubobject()` 只能在构造函数中调用；在运行时调用会产生未定义行为。
- 暴露给 Blueprint 的函数需要 `UFUNCTION(BlueprintCallable)`；没有它，Blueprint 无法调用它们。
- 网络复制：仅服务器权威 Actor 调用 `SetReplicates(true)`；使用 `GetLifetimeReplicatedProps()` 注册复制属性。
- `AActor::Destroy()` 会延迟到帧末执行；不要依赖在同一帧内立即销毁。
- 绝不存储可能被垃圾回收的原始 `AActor*` 指针；使用 `TWeakObjectPtr<>` 或在每次访问前用 `IsValid()` 检查。

## 测试

- 使用 Unreal Automation Framework，配合 `IMPLEMENT_SIMPLE_AUTOMATION_TEST` 或 `IMPLEMENT_COMPLEX_AUTOMATION_TEST`。
- 使用 `AFunctionalTest` Actor 编写功能测试，使用 Gauntlet 进行集成测试。
- 使用 Unreal 的 `FAutomationTestBase` 和 spec 测试宏（`Describe`、`It`、`TestEqual`）模拟依赖。
- 通过 `Session Frontend` > `Automation` 面板在编辑器中执行测试；通过 `-ExecCmds="Automation RunTests"` 运行命令行测试。

## 编辑器工具

- 使用 `UEditorUtilityWidget`、`FWorkspaceItem` 和 `FExtender` 扩展编辑器，用于自定义工具窗口和菜单扩展。
- 使用 `FSlateApplication` 和 `SWidget` 类构建基于 Slate 的编辑器 UI；避免为编辑器工具使用 UMG 控件。
- 使用 `IAssetTypeActions` 和 `UFactory` 派生类注册资源类型操作，用于自定义资源创建管线。
- 使用 `FPropertyEditorModule` 和 `IDetailCustomization` 为自定义类型定制 Details 面板。
- 优先使用编辑器扩展而非直接操作资源；始终使用 `FScopedTransaction` 以支持撤销/重做。
