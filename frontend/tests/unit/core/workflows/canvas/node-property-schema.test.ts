import { describe, expect, test } from "@rstest/core";

import {
  getNodeParamFields,
  getNodeParamKeys,
  sanitizeNodeParams,
} from "@/core/workflows/canvas/node-property-schema";

describe("fixed node property schema", () => {
  test("flow nodes expose their fixed fields", () => {
    const keys = new Set(
      getNodeParamFields("flow:if").map((field) => field.key),
    );

    expect(keys.has("ports")).toBe(true);
    expect(keys.has("resource_lock")).toBe(false);
    expect(keys.has("require_approval")).toBe(false);
    expect(keys.has("on_reject")).toBe(false);
  });

  test("review nodes expose their review instructions", () => {
    const keys = new Set(
      getNodeParamFields("human:review").map((field) => field.key),
    );
    expect(keys.has("instructions")).toBe(true);
    expect(keys.has("require_approval")).toBe(false);
  });

  test("stale execution knobs are dropped", () => {
    expect(
      sanitizeNodeParams("app:script", {
        app: "blender",
        script: "render",
        breakpoint: true,
        idempotency: true,
        detect_conflicts: true,
        conflict_globs: ["*.png"],
      }),
    ).toEqual({ app: "blender", script: "render" });
  });

  test("legacy resource lock params are dropped", () => {
    expect(
      sanitizeNodeParams("data:file", {
        operation: "write",
        path: "/mnt/user-data/workspace/a.txt",
        resource_lock: "old-lock",
        resource_lock_timeout: 5,
      }),
    ).toEqual({
      operation: "write",
      path: "/mnt/user-data/workspace/a.txt",
    });
  });

  test("dedicated and fixed params survive sanitization", () => {
    const params = sanitizeNodeParams("ai:llm_agent", {
      capability_groups: ["alpha"],
      arbitrary: "drop me",
    });

    expect(params).toEqual({
      capability_groups: ["alpha"],
    });
  });

  test("unknown custom params are dropped for every node type", () => {
    expect(
      sanitizeNodeParams("tool:bash", {
        command: "echo hi",
        crash_confirm: true,
        extra: 1,
      }),
    ).toEqual({ command: "echo hi", crash_confirm: true });
    expect(getNodeParamKeys("tool:bash").has("extra")).toBe(false);
  });

  test("app and subworkflow forms keep the keys they own", () => {
    expect(
      sanitizeNodeParams("app:script", {
        app: "blender",
        script: "render",
        args: ["--background"],
        unknown: true,
      }),
    ).toEqual({
      app: "blender",
      script: "render",
      args: ["--background"],
    });
    expect(
      sanitizeNodeParams("nested:subworkflow", {
        subworkflow: { type: "template", template_id: "wf-1" },
        mapping: { inputs: {}, outputs: {} },
        allow_recursion: true,
        unknown: true,
      }),
    ).toEqual({
      subworkflow: { type: "template", template_id: "wf-1" },
      mapping: { inputs: {}, outputs: {} },
      allow_recursion: true,
    });
  });
});
