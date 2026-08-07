// 功能组领域类型契约（v0.3.0 T1）——groups/ 模块单一类型源，T2/T3/T4 全部从此 import。
// 与设计文档 §3.2.1 对齐，差异：设计文档用 name 作命名空间路径，本模块统一用 namespace（更清晰）。

/** 功能组资源类型枚举：agent 单文件，tools/mcps/rules 为列表。 */
export type ResourceType = "agent" | "tool" | "mcp" | "rule";

/** 资源登记项：供 resource_registry 与唯一性检测（T3），name 唯一域为 "guid@version + name"。 */
export interface ResourceEntry {
  readonly type: ResourceType;
  readonly name: string;
  readonly path: string;
}

/** 依赖的其他功能组及版本范围。 */
export interface GroupDependency {
  readonly guid: string;
  readonly versionRange: string; // 版本范围，如 ">=1.0.0 <2.0.0"
}

/** 规则条目：按 order 字段升序加载。 */
export interface RuleEntry {
  readonly path: string;  // 规则文件路径，相对版本目录
  readonly order: number; // 加载顺序
}

/** 功能组单版本内容快照（不可变）。 */
export interface GroupContent {
  readonly agent?: string;                       // agent MD 路径，相对版本目录；仅允许一个生效（§3.2.4）
  readonly tools: readonly string[];             // 工具文件名/路径数组，相对版本目录
  readonly mcps: readonly string[];              // MCP 配置文件名/路径数组，相对版本目录
  readonly rules: readonly RuleEntry[];          // 规则列表（有序）
  readonly requiresCoreVersion?: string;         // 支持的核心引擎版本范围，如 ">=1.0.0 <2.0.0"
  readonly dependencies?: readonly GroupDependency[];
}

/** 功能组版本：不可变快照。 */
export interface GroupVersion {
  readonly version: string;      // 语义版本号，如 "1.2.0"
  readonly createdAt: string;    // 创建时间
  readonly changelog: string;    // 更新内容描述
  /** 废弃标记：true=该版本已废弃，引导用户升级到新版本。可选，旧数据无此字段不受影响。 */
  // 显式联合含 undefined：兼容 zod v4 .optional() 的 output（exactOptionalPropertyTypes 下 `?: boolean` 拒绝显式 undefined）。
  readonly deprecated?: boolean | undefined;
  readonly content: GroupContent;
}

/** 功能组：GUID 唯一标识，版本化管理，命名空间路径组织。 */
export interface CapabilityGroup {
  readonly guid: string;         // 全局唯一 ID，创建时生成，终身不变
  readonly namespace: string;    // 命名空间路径，如 "web/scraping/playwright"
  readonly aliases: readonly string[]; // 曾用名/别名（重命名或移动时写入旧路径）
  readonly description: string;
  readonly versions: readonly GroupVersion[]; // 版本历史
  readonly currentVersion: string;            // 当前最新版本号
}
