import { describe, expect, it } from "@rstest/core";

import { enUS } from "@/core/i18n/locales/en-US";
import { zhCN } from "@/core/i18n/locales/zh-CN";

/** Collect every leaf key path as "a.b.c". Arrays collapse to their path. */
function collectKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n locale reconciliation", () => {
  it("en-US and zh-CN expose the same leaf keys", () => {
    const english = collectKeys(enUS).sort();
    const chinese = collectKeys(zhCN).sort();
    expect(chinese).toEqual(english);
  });

  it("workflows.run exposes run controls and status keys in both locales", () => {
    const runPaths = [
      "workflows.run.run",
      "workflows.run.runDisabled",
      "workflows.run.stop",
      "workflows.run.running",
      "workflows.run.stopping",
      "workflows.run.runSuccess",
      "workflows.run.runFailed",
      "workflows.run.cancelFailed",
      "workflows.run.history",
      "workflows.run.historyEmpty",
      "workflows.run.historyLoadFailed",
      "workflows.run.memoryBackendUnavailable",
      "workflows.run.runStatus.pending",
      "workflows.run.runStatus.running",
      "workflows.run.runStatus.success",
      "workflows.run.runStatus.error",
      "workflows.run.runStatus.timeout",
      "workflows.run.runStatus.interrupted",
      "workflows.run.nodeStatus.idle",
      "workflows.run.nodeStatus.running",
      "workflows.run.nodeStatus.completed",
      "workflows.run.nodeStatus.failed",
      "workflows.run.panel.title",
      "workflows.run.panel.idleHint",
      "workflows.run.panel.timeline",
      "workflows.run.panel.output",
      "workflows.run.panel.noOutput",
      "workflows.run.panel.errorDetail",
      "workflows.run.panel.terminalStatus",
    ];

    for (const path of runPaths) {
      expect(collectKeys(enUS), `en-US missing ${path}`).toContain(path);
      expect(collectKeys(zhCN), `zh-CN missing ${path}`).toContain(path);
    }
  });

  it("runStatus has no cancelled state (backend 6-value enum)", () => {
    expect(enUS.workflows.run.runStatus).not.toHaveProperty("cancelled");
    expect(zhCN.workflows.run.runStatus).not.toHaveProperty("cancelled");
  });

  it("key sample values are present in both locales", () => {
    expect(enUS.workflows.run.run).toBe("Run");
    expect(zhCN.workflows.run.run).toBe("运行");
    expect(enUS.workflows.run.runStatus.success).toBe("Success");
    expect(zhCN.workflows.run.runStatus.success).toBe("成功");
    expect(enUS.workflows.run.runStatus.error).toBe("Failed");
    expect(zhCN.workflows.run.runStatus.error).toBe("失败");
    expect(enUS.workflows.run.nodeStatus.completed).toBe("Completed");
    expect(zhCN.workflows.run.nodeStatus.completed).toBe("已完成");
    expect(enUS.workflows.run.panel.title).toBe("Run");
    expect(zhCN.workflows.run.panel.title).toBe("运行");
    expect(enUS.workflows.run.panel.terminalStatus).toBe("Result");
    expect(zhCN.workflows.run.panel.terminalStatus).toBe("结果");
  });
});
