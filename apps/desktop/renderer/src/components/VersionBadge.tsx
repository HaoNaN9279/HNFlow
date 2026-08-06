// 子工作流节点版本角标（v0.4.1）。
// - 模板引用（params.template = "name@version"）：右上角显示引用版本号徽标（@ 之后部分），
//   title 提示完整引用 name@version；
// - 内嵌子图（params.template 非 string）：显示灰色「内嵌」徽标（无模板版本语义）；
// - 可升级标记（可选增强）：异步查 window.hnflow.listTemplates()，若模板最新版本与引用版本不同
//   → 绿色「可升级」小标；模块级 Map 缓存（key=模板名）避免每次渲染重复 IPC，查询失败静默
//   （不显示标记、不写缓存，下次可重试）；
// - 样式：绝对定位卡片右上角外侧，小号圆角徽标，不遮挡节点标题；内联样式（同 SubworkflowNode 先例）。

import { useEffect, useState, type CSSProperties } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";

interface VersionBadgeProps {
  readonly node: EditorGraphNode;
}

/** 解析 "name@version"：lastIndexOf("@") 切分；非法（缺失/空段）返回 undefined。 */
function parseTemplateRef(ref: unknown): { readonly name: string; readonly version: string } | undefined {
  if (typeof ref !== "string") return undefined;
  const sep = ref.lastIndexOf("@");
  if (sep <= 0 || sep === ref.length - 1) return undefined;
  return { name: ref.slice(0, sep), version: ref.slice(sep + 1) };
}

/** 可升级判定缓存：key=模板名（首次查询后复用，避免每次渲染 IPC）。 */
const upgradableCache = new Map<string, boolean>();

/** 查询模板最新版本是否与引用版本不同；失败静默返回 undefined（不写缓存，下次重查）。 */
async function fetchUpgradable(name: string, version: string): Promise<boolean | undefined> {
  try {
    const templates = await window.hnflow.listTemplates();
    const summary = templates.find((item) => item.name === name);
    if (summary === undefined) {
      return undefined;
    }
    // 与 UpgradeDialog「当前已是最新版本」判定一致：版本不同即可升级。
    return summary.currentVersion !== version;
  } catch (error) {
    console.error("查询模板最新版本失败", error);
    return undefined;
  }
}

/** 版本徽标基础样式：绝对定位卡片右上角外侧，不遮挡标题。 */
const badgeStyle: CSSProperties = {
  position: "absolute",
  top: -7,
  right: 4,
  zIndex: 5,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 10,
  lineHeight: 1,
  padding: "2px 5px",
  borderRadius: 4,
  border: "1px solid #91caff",
  background: "#e6f4ff",
  color: "#1677ff",
  boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
  pointerEvents: "none",
  userSelect: "none",
};

/** 内嵌子图徽标：灰色弱化（无模板版本语义）。 */
const embeddedStyle: CSSProperties = {
  ...badgeStyle,
  borderColor: "#d9d9d9",
  background: "#f5f5f5",
  color: "#8c8c8c",
};

/** 可升级标记：绿色小号徽标，紧贴版本徽标右侧。 */
const upgradableStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: 1,
  padding: "1px 4px",
  borderRadius: 4,
  border: "1px solid #b7eb8f",
  background: "#f6ffed",
  color: "#52c41a",
};

export function VersionBadge({ node }: VersionBadgeProps): JSX.Element | null {
  const [upgradable, setUpgradable] = useState(false);
  useEffect(() => {
    const ref = parseTemplateRef(node.params["template"]);
    if (ref === undefined) {
      return;
    }
    const cached = upgradableCache.get(ref.name);
    if (cached !== undefined) {
      setUpgradable(cached);
      return;
    }
    let cancelled = false;
    void fetchUpgradable(ref.name, ref.version).then((value) => {
      if (value !== undefined) {
        upgradableCache.set(ref.name, value);
      }
      if (!cancelled) {
        setUpgradable(value === true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [node]);

  if (node.type !== "subworkflow") {
    return null;
  }
  const template = node.params["template"];
  const ref = parseTemplateRef(template);
  if (typeof template !== "string") {
    // 内嵌子图：内容在画布内，无模板版本语义。
    return (
      <span style={embeddedStyle} title="内嵌子图（无模板版本）">
        内嵌
      </span>
    );
  }
  const version = ref === undefined ? template : ref.version;
  const title = ref === undefined ? template : `${ref.name}@${ref.version}`;
  return (
    <span style={badgeStyle} title={`引用模板：${title}`}>
      <span>v{version}</span>
      {upgradable && <span style={upgradableStyle}>可升级</span>}
    </span>
  );
}
