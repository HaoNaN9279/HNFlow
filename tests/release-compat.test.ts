// 功能组发布兼容性集成测试：releaseGroup 返回的 compat 报告与发布流程联动。
// 覆盖：首次发布 / 无变化二次发布 / 删除工具 / 新增工具 / 兼容性计算失败不阻断发布 / 内容损坏。
// 注意：release.ts 中 compat 由 loadGroupContent 从磁盘读取 prev 内容生成；prev 内容缺失/非法时
// catch 回退 compat=undefined（不阻断发布），因此「删除工具后再发布」不会产出 breaking 报告。
// 临时目录用 opencode 专用 temp + 随机后缀，Windows 清理：afterAll 30000ms + rmRetry + Bun.gc(true)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { initGroup } from "../src/groups/init.js";
import { releaseGroup } from "../src/groups/release.js";

const TEMP_BASE = join("C:\\Users\\ZHANGH~1\\AppData\\Local\\Temp\\opencode", `hnflow-tests-${randomUUID()}`);

afterAll(async () => {
  await rmRetry(TEMP_BASE);
}, 30000);

beforeEach(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
  await mkdir(TEMP_BASE, { recursive: true });
});

/** 带重试的递归删除：瞬态文件锁（EBUSY）短暂等待后重试（Windows 惯例）。 */
async function rmRetry(path: string, retries = 40): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (getErrnoCode(error) === "EBUSY" && attempt < retries) {
        Bun.gc(true); // Windows 句柄释放依赖 GC，强制回收以解锁文件
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 向指定版本目录写入相对路径文件（自动建父目录）。 */
async function writeVersionFile(
  namespace: string,
  version: string,
  relPath: string,
  content: string,
): Promise<void> {
  const filePath = join(TEMP_BASE, ...namespace.split("/"), `v${version}`, relPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

/** 合法工具 JSON：loadTool 要求 name/description/parameters 字段（见 content-loader.ts）。 */
function toolJson(name: string): string {
  return JSON.stringify({
    name,
    description: `工具 ${name}`,
    parameters: { type: "object", properties: {} },
  });
}

describe("releaseGroup 兼容性集成", () => {
  test("1. 首次发布：currentVersion 更新到新版本；compat 对初始版本生成报告（agent_changed → minor）", async () => {
    await initGroup(TEMP_BASE, "demo/first");
    const released = await releaseGroup(TEMP_BASE, "demo/first", "1.0.0");

    expect(released.group.currentVersion).toBe("1.0.0");
    expect(released.group.versions).toHaveLength(2);
    expect(released.compat).toBeDefined();
    expect(released.compat?.changes.map((change) => change.kind)).toContain("agent_changed");
    expect(released.compat?.level).toBe("minor");
  });

  test("2. 二次发布无接口变化：compat 存在且 level 非 breaking", async () => {
    await initGroup(TEMP_BASE, "demo/nochange");
    await releaseGroup(TEMP_BASE, "demo/nochange", "1.0.0");

    const released = await releaseGroup(TEMP_BASE, "demo/nochange", "2.0.0");
    expect(released.compat).toBeDefined();
    expect(released.compat?.level).not.toBe("breaking");
    expect(released.compat?.changes).toEqual([]);
  });

  test("3. 二版删除工具：发布成功；prev 内容加载失败 → compat 回退 undefined", async () => {
    await initGroup(TEMP_BASE, "demo/removed");
    await writeVersionFile("demo/removed", "0.1.0", "tools/a.json", toolJson("a"));
    await releaseGroup(TEMP_BASE, "demo/removed", "1.0.0");

    // release 一版后删除 v1.0.0/tools/a.json；group.json 中 1.0.0 content.tools 仍引用该文件
    await rm(join(TEMP_BASE, "demo", "removed", "v1.0.0", "tools", "a.json"), { force: true });
    const released = await releaseGroup(TEMP_BASE, "demo/removed", "2.0.0");

    expect(released.group.currentVersion).toBe("2.0.0");
    expect(released.compat).toBeUndefined();
  });

  test("4. 二版新增工具：level minor，changes 含 tool_added", async () => {
    await initGroup(TEMP_BASE, "demo/added");
    await writeVersionFile("demo/added", "0.1.0", "tools/a.json", toolJson("a"));
    await releaseGroup(TEMP_BASE, "demo/added", "1.0.0");

    // 新工具写入当前版本目录后 release 二版（不可变快照拷贝继承）
    await writeVersionFile("demo/added", "1.0.0", "tools/b.json", toolJson("b"));
    const released = await releaseGroup(TEMP_BASE, "demo/added", "2.0.0");

    expect(released.compat).toBeDefined();
    expect(released.compat?.level).toBe("minor");
    expect(released.compat?.changes.map((change) => change.kind)).toContain("tool_added");
    expect(released.group.currentVersion).toBe("2.0.0");
  });

  test("5. 兼容性计算失败不阻断：releaseGroup 正常 resolve 且 currentVersion 更新", async () => {
    await initGroup(TEMP_BASE, "demo/blocked");
    await writeVersionFile("demo/blocked", "0.1.0", "tools/a.json", toolJson("a"));
    await releaseGroup(TEMP_BASE, "demo/blocked", "1.0.0");

    // 破坏 prev 版本工具 JSON，使 loadGroupContent(prev) 抛错 → catch 回退 compat undefined
    await writeVersionFile("demo/blocked", "1.0.0", "tools/a.json", "{ invalid json");
    const released = await releaseGroup(TEMP_BASE, "demo/blocked", "2.0.0");

    expect(released.compat).toBeUndefined();
    expect(released.group.currentVersion).toBe("2.0.0");
    expect(released.group.versions).toHaveLength(3);
  });

  test("6. 版本目录损坏（二版工具 JSON 非法）：发布仍成功且 compat undefined", async () => {
    await initGroup(TEMP_BASE, "demo/corrupt");
    await writeVersionFile("demo/corrupt", "0.1.0", "tools/a.json", toolJson("a"));
    await releaseGroup(TEMP_BASE, "demo/corrupt", "1.0.0");

    // 新增非法工具文件 → 二版 collectResources 注册它，next 内容加载失败 → compat undefined
    await writeVersionFile("demo/corrupt", "1.0.0", "tools/bad.json", "{ invalid json");
    const released = await releaseGroup(TEMP_BASE, "demo/corrupt", "2.0.0");

    expect(released.group.currentVersion).toBe("2.0.0");
    expect(released.compat).toBeUndefined();
  });
});
