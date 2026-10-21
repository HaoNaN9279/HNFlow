import { describe, expect, test } from "@rstest/core";

import {
  getNodeParamFields,
  getNodeParamKeys,
  sanitizeNodeParams,
} from "@/core/workflows/canvas/node-property-schema";

describe("fixed node property schema", () => {
  test("flow nodes expose their fixed fields plus common execution options", () => {
    const keys = new Set(
      getNodeParamFields("flow:if").map((field) => field.key),
    );

    expect(keys.has("ports")).toBe(true);
    expect(keys.has("breakpoint")).toBe(true);
    expect(keys.has("resource_lock")).toBe(false);
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

  test("start/end nodes do not expose breakpoint", () => {
    const keys = new Set(
      getNodeParamFields("flow:start").map((field) => field.key),
    );

    expect(keys.has("breakpoint")).toBe(false);
  });

  test("dedicated and fixed params survive sanitization", () => {
    const params = sanitizeNodeParams("ai:llm_agent", {
      instruction: "Do it",
      capability_groups: ["alpha"],
      breakpoint: true,
      user_prompt: "legacy",
      arbitrary: "drop me",
    });

    expect(params).toEqual({
      instruction: "Do it",
      capability_groups: ["alpha"],
      breakpoint: true,
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
