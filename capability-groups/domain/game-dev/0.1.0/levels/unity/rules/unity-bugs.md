---
name: unity-bugs
description: Unity 2022.3 已知无法修复的引擎 bug 清单，开发时需规避。
---

本文件包含Unity 2022.3 中的无法修复的bug，开发过程当中需要尽量避免。

# Unity Mono Enum 泛型 Native Crash

Unity 2022.3 的 Mono 运行时在处理 **enum 作为泛型参数 `T`** 的特定代码路径时，会触发 **native crash（段错误）**，无法被 C# 层的 `try-catch` 捕获。

详细见：rules/bugs/UnityMonoEnum泛型NativeCrash.md