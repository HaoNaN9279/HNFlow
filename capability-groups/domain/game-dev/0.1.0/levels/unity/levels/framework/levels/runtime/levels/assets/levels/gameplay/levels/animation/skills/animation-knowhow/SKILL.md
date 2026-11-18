---
name: animation-knowhow
description: 当用户要做高级动画效果（叠加层、惯性化、动作匹配、IK、面部、重定向、骨骼 2D）或问某动画功能是否支持时使用：能力清单与需要自接的通道
---

# 动画能力清单

## 支持情况

| 能力 | 状态 | 说明 |
|---|---|---|
| 状态机 / 条件 / 过渡 | 完整 | 逻辑层定义，表现层应用 |
| 叠加层 Additive | 完整 | 上限 4 层 |
| Montage（一次性动作） | 完整 | 上限 2 个 |
| 同步组 SyncGroups | 完整 | 多角色同步播放 |
| 动作匹配 MotionWarping | 完整 | — |
| IK Rig | 完整 | Editor 配置 + 运行时应用 |
| 重定向 Retargeter | 完整 | Editor 烘焙 |
| LOD | 完整 | 远处暂停逻辑推进 |
| 姿势驱动 PSD / 双四元数 DQ | 完整 | — |
| 次级动画 Secondary | 完整 | 毛发/布料摆动 |
| 混合空间 | 部分 | 无专门类型，需自组合 |
| 惯性化 Inertialization | 部分 | `InertializationBlender` 无人引用，需自接 |
| ControlRig | 部分 | 有专用工具，逻辑在动画模块内 |
| 面部 Facial | 部分 | 只有编辑器配置，无运行时 |
| 骨骼 2D Skeleton2D | 部分 | 只取 X 轴，不支持 DragonBones |
| 网络同步动画 | 部分 | 无 Unity 传输适配 |

## 需要自接的通道

- `Additives[]`：框架 Representation 不消费。
- `Events[]`：动画事件需自己分发。
- `MotionIntent`：根运动意图自己应用。
- 惯性化混合。

## 编辑器工具

菜单 `HN/Framework/Animation/*`：

- Playable 调试器
- 面部配置
- IK Rig
- ControlRig / ControlRig 图
- 重定向烘焙
- 时间轴标注
- 动画压缩分析

## 选择建议

| 需求 | 方案 |
|---|---|
| 基础移动/攻击 | 状态机 + Montage |
| 上半身射击叠加 | Additive 层 |
| 远程角色省性能 | LOD + 逻辑暂停 |
| 高保真转身/起步 | 惯性化（需自接） |
| 动作与地形匹配 | MotionWarping |
| 换装重定向 | Retargeter 烘焙 |

## 使用时机

评估动画方案、确认某效果是否能直接支持时加载。
