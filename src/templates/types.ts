// 子工作流模板领域类型契约（v0.3.3 T5）——templates/ 模块单一类型源，T1/T3/T5/T6 全部从此 import。
// 与设计文档 §4.2 对齐：全局模板 = 可复用的子工作流节点定义，独立语义版本，引用锁定版本。
// 目录结构：templates/<name>/template.json（元数据）+ v<version>/workflow.json（内容快照，不可变）。
// interface 为模板顶层字段（对外封装接口，随当前版本更新；历史版本只存版本号/时间/更新说明）。

/** 模板对外接口：inputs 为对外参数名集合（workflow:params 后缀，有序去重），outputs 为输出变量名集合。 */
export interface TemplateInterface {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** 模板版本：不可变快照记录，内容为 workflow.json 单文件（版本目录）。 */
export interface TemplateVersion {
  readonly version: string; // 语义版本号，如 "1.2.0"
  readonly createdAt: string; // 创建时间（ISO）
  readonly changelog: string; // 更新内容描述
}

/** 子工作流模板：name 唯一标识（目录名），版本化管理。 */
export interface WorkflowTemplate {
  readonly name: string; // 模板名（目录名），引用锁定 templateId@version
  readonly description: string;
  readonly versions: readonly TemplateVersion[]; // 版本历史
  readonly currentVersion: string; // 当前最新版本号
  readonly interface: TemplateInterface; // 对外封装接口（当前版本）
}
