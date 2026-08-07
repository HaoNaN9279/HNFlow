// 系统信息 MCP Server 单测（v0.5.0 T6）：import 模块直接测白名单与环境变量读取
// （import.meta.main guard 保证被 import 时不启动 server）。
// sys_time/sys_platform/sys_uptime 无参数工具由端到端测试覆盖（mcp-servers-e2e.test.ts）。
import { describe, expect, test } from "bun:test";
import { readAllowedEnv, SYS_ENV_ALLOWLIST } from "../src/mcp/servers/system-server.js";

describe("SYS_ENV_ALLOWLIST（防泄露敏感项）", () => {
  test("白名单不含敏感项（API_KEY/SECRET/PASSWORD/TOKEN）", () => {
    const joined = SYS_ENV_ALLOWLIST.join(",").toUpperCase();
    expect(joined).not.toContain("API_KEY");
    expect(joined).not.toContain("SECRET");
    expect(joined).not.toContain("PASSWORD");
    expect(joined).not.toContain("TOKEN");
  });

  test("白名单非空且全部为短变量名（无前缀通配）", () => {
    expect(SYS_ENV_ALLOWLIST.length).toBeGreaterThan(0);
    for (const name of SYS_ENV_ALLOWLIST) {
      expect(name).not.toContain("*");
      expect(name).not.toContain("?");
    }
  });
});

describe("readAllowedEnv", () => {
  test("白名单外变量 → undefined（拒绝读取）", () => {
    expect(readAllowedEnv("HNFLOW_SUPER_SECRET_XYZ")).toBeUndefined();
  });

  test("白名单内且已设置 → 返回 process.env 值", () => {
    const name = process.platform === "win32" ? "USERPROFILE" : "HOME";
    expect(readAllowedEnv(name)).toBe(process.env[name]);
  });
});
