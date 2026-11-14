---
name: unity-mono-enum-native-crash
---

## 概述

Unity 2022.3 的 Mono 运行时在处理 **enum 作为泛型参数 `T`** 的特定代码路径时，会触发 **native crash（段错误）**，无法被 C# 层的 `try-catch` 捕获。

## 触发条件

以下三个条件同时满足时必定崩溃：

1. `T` 是 enum 类型（如 `TestEnum`）
2. 在 `DeserializeFromString<T>()` 泛型方法内部
3. 方法体内包含**标量值 JSON 转换路径**（`ConvertJsonValue` 或同类逻辑）

```csharp
// ❌ 崩溃示例
public static T DeserializeFromString<T>(string jsonString)
{
    // ...
    if (!jsonString.StartsWith("{"))
    {
        // T = TestEnum 时，此代码路径会导致 native crash
        var type = typeof(T);
        if (type.IsEnum)
        {
            return (T)Enum.Parse(type, "2");           // ❌ crash
            return Enum.ToObject(type, 2);              // ❌ crash
            return (T)(object)int.Parse("2");           // ❌ crash
            return (T)Convert.ChangeType("2", type);    // ❌ crash
        }
    }
}
```

## 绕过方案

在 `DeserializeFromString<T>` 的标量转换路径中，**显式排除 enum 类型**：

```csharp
// DeserializeFromString<T> — scalar path
if (!jsonString.StartsWith("{") && !jsonString.StartsWith("["))
{
    var type = typeof(T);
    // 显式排除 enum，避免 Mono native crash
    if (!type.IsEnum)
    {
        return (T)ConvertJsonValue(jsonString, typeof(T));
    }
    // enum 类型落在原始路径，行为等价于原代码（返回 default，测试 FAIL 但不崩溃）
}
```

## 影响范围

- **无法修复**：`JsonRoundtripTests` 中 4 个 enum 相关测试持续 FAIL
  - `SerializeDeserialize_Enum_Roundtrip`
  - `DeserializeEnum_FromInteger_ReturnsCorrectValue`
  - `SerializeEnum_OutputsIntegerNotStringName`（仅需序列化，未受影响）
- **不受影响**：复杂对象中 enum 字段的反序列化（走 `JsonOverwrite` → `SetFieldValue` 路径，enum 为 field type 而非泛型参数 `T`，不触发此 bug）
