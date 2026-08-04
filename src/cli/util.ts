// CLI 公共工具：错误描述、对齐表格、JSON 摘要、失败处理（stderr + 非 0 退出码）。

/** 提取未知错误的可读消息。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 打印对齐文本表格：表头 + 数据行，列宽取表头与各行的最大内容长度。 */
export function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - text.length));
  const render = (cells: readonly string[]): string =>
    cells.map((cell, index) => pad(cell, widths[index] ?? 0)).join("  ").trimEnd();
  console.log(render(headers));
  for (const row of rows) console.log(render(row));
}

/** 任意值 → 截断 JSON 摘要（超长文本省略号结尾），便于紧凑打印节点输出。 */
export function jsonSummary(value: unknown, maxLength = 120): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** stderr 打印中文错误 + 用法提示，返回非 0 退出码。 */
export function fail(message: string, usage?: string): number {
  console.error(`错误: ${message}`);
  if (usage !== undefined) console.error(`用法: ${usage}`);
  return 1;
}
