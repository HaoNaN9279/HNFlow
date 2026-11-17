---
name: image-prompt
description: 当需要把模糊的视觉想法整理成 Pollinations 文生图提示词、做系列图一致性设计或为游戏资产生成概念图简报时使用。
---

# 图像提示词 — 结构化描述与系列一致性

把“做个帅气的机器人”这类模糊需求，整理成可复现的英文提示词、宽高和 seed 方案。本技能只产出提示词与参数，不调用接口；真正生成用同组 `text-to-image`。

## 前置条件

- 已知用途（概念图、角色设定、道具参考、宣传图）和目标画幅。
- 如果做系列图，已知需要保持一致的角色/道具特征与风格关键词。

## 提示词结构

按以下顺序拼装，缺项可省略，但不要堆砌互相矛盾的词：

1. **主体**：谁/什么，数量，身份或功能。
2. **动作/状态**：站立、奔跑、悬停、破损、待机。
3. **环境**：场景、天气、地面材质、背景复杂度。
4. **构图/镜头**：全身、半身、特写、俯视、等距、广角、正交三视图。
5. **光线**：晨光、体积光、轮廓光、柔和棚拍、冷/暖对比。
6. **风格**：写实、风格化、低多边形、手绘、赛博朋克、奇幻。
7. **材质/色彩**：金属、布料、磨损、主色与点缀色。
8. **输出约束**：干净背景、无文字、无 watermark、单主体、游戏资产概念图。

模板：

```text
<subject>, <action/state>, <environment>, <composition/camera>, <lighting>, <style>, <materials and palette>, <output constraints>
```

示例（道具概念图）：

```text
a compact energy rifle for a scrapyard survival game, worn orange paint over gunmetal, taped grip, small glowing cyan cell, three-quarter view, neutral studio background, soft rim light, semi-realistic stylized concept art, clean silhouette, no text, no watermark
```

示例（角色设定图）：

```text
full-body character sheet of a young desert scavenger, layered cloth wraps, goggles on forehead, leather satchel, neutral A-pose, front and three-quarter view, flat even lighting, stylized realistic game concept art, sand and teal palette, clean light-gray background, no text
```

## 系列一致性

- 固定一段**风格块**（style block）：媒介、渲染方式、光照、色彩、细节程度，逐张原样复用。
- 固定角色/道具的**识别特征**：轮廓、主色、材质、标志性配件；不要每张换形容词。
- 需要同角色多角度时，复用同一 seed 只改构图词；seed 不是绝对保证，交付时说明。
- 批量前先出 1 张基准图，把最终 prompt 与 seed 记录到 brief。

## 参数建议

| 用途 | width × height | 说明 |
|---|---|---|
| 游戏概念图/场景 | 1280 × 720 | 横向构图，适合 key art |
| 角色全身/设定图 | 768 × 1024 | 竖向全身 |
| 道具/图标 | 1024 × 1024 | 居中、干净背景 |
| 竖版宣传 | 720 × 1280 | 移动端 |

`seed`：需要复现或做微调时显式记录；不需要时换随机整数，避免命中旧缓存。

## 输出格式

把结果写成可执行的小 JSON，交给 `text-to-image`：

```json
{
  "slug": "scrap-rifle",
  "prompt": "...",
  "width": 1024,
  "height": 1024,
  "seed": 12345,
  "notes": "单主体、干净背景；若出现文字则加 no text"
}
```

同时给用户一句中文摘要：画什么、什么风格、什么画幅、预计几张；说明使用免费端点，不产生费用。

## 常见错误

- **形容词堆叠**：`amazing, beautiful, masterpiece, 8k` 不产生稳定收益；用具体的材质、光线和构图词。
- **多主体未说明**：接口对单主体更稳；需要多个对象时明确“single object”或拆成多张。
- **风格冲突**：同时写“写实照片”和“卡通低多边形”会得到折中结果；选一个主风格。
- **期望文字**：不要要求模型生成可读文字/Logo；需要文字时后期排版。
- **忽略画幅**：竖图需求却用 16:9 会裁掉主体；先定 width/height 再写构图。
- **固定 URL 反复请求**：相同 prompt、宽高和 seed 会命中缓存；要新结果就换 seed。

## 使用时机

用户要生成图片但描述还很模糊、需要批量系列图、或要把游戏资产需求转成概念图简报时使用；生成执行交给 `text-to-image`。
