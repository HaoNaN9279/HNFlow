// 子工作流模板模块错误类集中定义（v0.3.3 T5）：加载 / 扫描 / 文件 / 版本三类错误。
// 惯例同 src/groups/errors.ts：错误类集中于单文件，调用方按 name 或 instanceof 区分。

/** 模板不存在：releaseTemplate 对模板目录缺失 / template.json 缺失时抛出。 */
export class TemplateNotFoundError extends Error {
  readonly name = "TemplateNotFoundError";
  constructor(message: string) {
    super(message);
  }
}

/** template.json / workflow.json 读取、解析、校验失败，或发布校验失败（版本、目录、内容）。 */
export class TemplateFileError extends Error {
  readonly name = "TemplateFileError";
  constructor(message: string) {
    super(message);
  }
}

/** 模板库目录扫描失败：scanTemplates 对根目录缺失 / 不可访问抛出（单个 template.json 损坏只警告不中断）。 */
export class TemplateScanError extends Error {
  readonly name = "TemplateScanError";
  constructor(message: string) {
    super(message);
  }
}
