import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

import {
  continueDebugPause,
  fetchPendingHumanTasks,
  formatRuleValue,
  humanTaskFields,
  initialHumanTaskDrafts,
  parseHumanTask,
  pendingDebugPauses,
  pendingHumanTasks,
  serializeHumanTaskDrafts,
  skipHumanTask,
  submitHumanTask,
} from "@/core/workflows/human-tasks";

const configMock = rs.hoisted(() => ({ baseUrl: "http://backend.test" }));
const fetchMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => configMock.baseUrl,
}));

rs.mock("@/core/api/fetcher", () => ({
  fetch: fetchMock,
}));

function jsonResponse(body: unknown, ok = true, statusText = "OK"): Response {
  return {
    ok,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  fetchMock.mockReset();
});

/** One well-formed pending step task. */
function stepTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "ht-1",
    workflow_run_id: "run-1",
    node_id: "a",
    kind: "step",
    status: "pending",
    description: "[step] 节点 a 在单步调试中暂停",
    ...overrides,
  };
}

describe("parseHumanTask", () => {
  it("normalizes a raw row", () => {
    expect(parseHumanTask(stepTask())).toEqual({
      id: "ht-1",
      workflowRunId: "run-1",
      nodeId: "a",
      kind: "step",
      status: "pending",
      description: "[step] 节点 a 在单步调试中暂停",
      outputSpec: [],
      validationRules: { enum: {}, pattern: {} },
      review: null,
    });
  });

  it("defaults a missing description to an empty string", () => {
    const parsed = parseHumanTask(stepTask({ description: undefined }));
    expect(parsed?.description).toBe("");
  });

  it("rejects malformed rows instead of inventing a task", () => {
    expect(parseHumanTask(null)).toBeNull();
    expect(parseHumanTask("nope")).toBeNull();
    expect(parseHumanTask(stepTask({ id: undefined }))).toBeNull();
    expect(parseHumanTask(stepTask({ workflow_run_id: 7 }))).toBeNull();
    expect(parseHumanTask(stepTask({ kind: undefined }))).toBeNull();
  });
});

describe("pendingDebugPauses", () => {
  const tasks = [
    parseHumanTask(stepTask())!,
    parseHumanTask(stepTask({ id: "ht-2", node_id: "b", kind: "breakpoint" }))!,
    parseHumanTask(stepTask({ id: "ht-3", node_id: "c", kind: "task" }))!,
    parseHumanTask(
      stepTask({ id: "ht-4", node_id: "d", status: "submitted" }),
    )!,
    parseHumanTask(stepTask({ id: "ht-5", workflow_run_id: "run-2" }))!,
  ];

  it("keeps only pending debug tasks", () => {
    expect(pendingDebugPauses(tasks)).toEqual([
      {
        id: "ht-1",
        runId: "run-1",
        nodeId: "a",
        kind: "step",
        description: "[step] 节点 a 在单步调试中暂停",
      },
      {
        id: "ht-2",
        runId: "run-1",
        nodeId: "b",
        kind: "breakpoint",
        description: "[step] 节点 a 在单步调试中暂停",
      },
      {
        id: "ht-5",
        runId: "run-2",
        nodeId: "a",
        kind: "step",
        description: "[step] 节点 a 在单步调试中暂停",
      },
    ]);
  });

  it("does not claim a run's other human tasks", () => {
    // ht-3 is a plain human:task — the canvas debug card must not offer to
    // resolve it, and ht-4 is already submitted.
    const ids = pendingDebugPauses(tasks).map((pause) => pause.id);
    expect(ids).not.toContain("ht-3");
    expect(ids).not.toContain("ht-4");
  });

  it("keeps a paused run reachable after its resume started a new run", () => {
    // A resume admits a new run id, so the follow-up pause of a stepped run is
    // never scoped to the canvas's own run — it must still be listed.
    const pauses = pendingDebugPauses(tasks, { preferredRunId: "run-canvas" });
    expect(pauses.map((pause) => pause.runId)).toEqual([
      "run-1",
      "run-1",
      "run-2",
    ]);
  });

  it("pins the preferred run's pauses first without dropping the rest", () => {
    const pauses = pendingDebugPauses(tasks, { preferredRunId: "run-2" });
    expect(pauses.map((pause) => pause.id)).toEqual(["ht-5", "ht-1", "ht-2"]);
  });

  it("returns nothing for a list with no pending debug work", () => {
    expect(pendingDebugPauses([])).toEqual([]);
    expect(
      pendingDebugPauses([parseHumanTask(stepTask({ kind: "review" }))!]),
    ).toEqual([]);
  });
});

describe("fetchPendingHumanTasks", () => {
  it("queries the pending filter and drops malformed rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([stepTask(), { id: "broken" }, "nope"]),
    );

    const tasks = await fetchPendingHumanTasks();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks?status=pending",
      { headers: { Accept: "application/json" } },
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.nodeId).toBe("a");
  });

  it("treats a non-array payload as no tasks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [] }));
    await expect(fetchPendingHumanTasks()).resolves.toEqual([]);
  });

  it("surfaces the backend detail on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: "Authentication required" },
        false,
        "Unauthorized",
      ),
    );
    await expect(fetchPendingHumanTasks()).rejects.toThrow(
      "Authentication required",
    );
  });
});

describe("debug pause actions", () => {
  it("acknowledges a pause with a non-empty resume payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "submitted" }));

    await continueDebugPause("ht/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht%2F1/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // LangGraph re-suspends on a falsy resume payload, so the submission
        // must carry the required `acknowledge` port.
        body: JSON.stringify({ values: { acknowledge: true } }),
      },
    );
  });

  it("submits explicit values", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await submitHumanTask("ht-1", { foo: "bar" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht-1/submit",
      expect.objectContaining({
        body: JSON.stringify({ values: { foo: "bar" } }),
      }),
    );
  });

  it("skips a pause without values", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await skipHumanTask("ht-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht-1/skip",
      { method: "POST" },
    );
  });

  it("joins validation errors from a 422 detail", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: { errors: ["缺少 acknowledge", "类型错误"] } },
        false,
      ),
    );
    await expect(continueDebugPause("ht-1")).rejects.toThrow(
      "缺少 acknowledge; 类型错误",
    );
  });

  it("falls back to a readable message when the detail is opaque", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, false, "Internal Server Error"),
    );
    await expect(skipHumanTask("ht-1")).rejects.toThrow(
      "Failed to skip human task: Internal Server Error",
    );
  });
});

// ── generic task fields (N14aj) ──────────────────────────────────────────────

/** A ``human:task`` row declaring the given submission ports. */
function taskRow(
  ports: {
    name: string;
    type: string;
    required?: boolean;
    description?: string;
  }[],
  rules: unknown = null,
  snapshot: unknown = null,
) {
  return {
    id: "ht-task",
    workflow_run_id: "run-1",
    node_id: "ask_user",
    kind: "task",
    status: "pending",
    description: "请输入参数",
    output_spec: {
      ports: ports.map((port) => ({
        required: false,
        description: "",
        ...port,
        type: port.type ?? "data",
      })),
    },
    validation_rules: rules,
    inputs_snapshot: snapshot,
  };
}

function parsed(raw: unknown) {
  const task = parseHumanTask(raw);
  if (task === null) {
    throw new Error("row did not parse");
  }
  return task;
}

describe("humanTaskFields", () => {
  it("derives one field per declared port, in order", () => {
    const fields = humanTaskFields(
      parsed(
        taskRow([
          {
            name: "note",
            type: "data",
            required: true,
            description: "写点说明",
          },
          { name: "confirmed", type: "bool" },
        ]),
      ),
    );

    expect(fields.map((field) => field.name)).toEqual(["note", "confirmed"]);
    expect(fields[0]).toMatchObject({
      kind: "text",
      required: true,
      description: "写点说明",
      options: null,
      pattern: null,
    });
    expect(fields[1]).toMatchObject({ kind: "bool" });
  });

  it("maps declared types onto widgets", () => {
    const kinds = humanTaskFields(
      parsed(
        taskRow([
          { name: "a", type: "bool" },
          { name: "b", type: "number" },
          { name: "c", type: "array" },
          { name: "d", type: "record" },
          { name: "e", type: "file" },
        ]),
      ),
    ).map((field) => field.kind);

    expect(kinds).toEqual(["bool", "number", "json", "json", "text"]);
  });

  it("drops malformed ports instead of inventing a field", () => {
    const task = parseHumanTask({
      ...taskRow([{ name: "ok", type: "data" }]),
      output_spec: {
        ports: [
          { type: "data" },
          { name: "", type: "data" },
          "nope",
          { name: "ok", type: "data" },
        ],
      },
    })!;
    expect(humanTaskFields(task).map((field) => field.name)).toEqual(["ok"]);
  });

  it("turns an enum rule into a labelled choice", () => {
    const fields = humanTaskFields(
      parsed(
        taskRow([{ name: "mode", type: "enum" }], {
          enum: { mode: { enum: ["fast", "slow"] } },
        }),
      ),
    );

    expect(fields[0]).toMatchObject({
      kind: "enum",
      options: [
        { label: "fast", value: "fast" },
        { label: "slow", value: "slow" },
      ],
    });
  });

  it("keeps a review's boolean decision as a choice", () => {
    const fields = humanTaskFields(
      parsed({
        ...taskRow([{ name: "decision", type: "bool", required: true }]),
        kind: "review",
        validation_rules: { enum: { decision: { enum: [true, false] } } },
      }),
    );

    // A bool port stays a bool: the rule constrains the *choice*, it does not
    // turn the field into a select whose labels would be strings.
    expect(fields[0]).toMatchObject({
      kind: "bool",
      options: [
        { label: "true", value: true },
        { label: "false", value: false },
      ],
    });
  });

  it("reports a declared pattern as a hint", () => {
    const fields = humanTaskFields(
      parsed(
        taskRow([{ name: "code", type: "data" }], {
          pattern: { code: { pattern: "^[a-z]+$" } },
        }),
      ),
    );
    expect(fields[0]).toMatchObject({ pattern: "^[a-z]+$" });
  });

  it("ignores malformed rules", () => {
    const fields = humanTaskFields(
      parsed(
        taskRow([{ name: "x", type: "data" }], {
          enum: { x: "nope" },
          pattern: { x: 7 },
        }),
      ),
    );
    expect(fields[0]).toMatchObject({
      kind: "text",
      options: null,
      pattern: null,
    });
  });
});

describe("serializeHumanTaskDrafts", () => {
  const fields = humanTaskFields(
    parsed(
      taskRow(
        [
          { name: "note", type: "data", required: true },
          { name: "confirmed", type: "bool", required: true },
          { name: "count", type: "number" },
          { name: "items", type: "array" },
          { name: "mode", type: "enum" },
        ],
        { enum: { mode: { enum: ["fast", "slow"] } } },
      ),
    ),
  );

  it("starts booleans unset (an untouched review must not submit a rejection)", () => {
    const drafts = initialHumanTaskDrafts(fields);
    expect(drafts.confirmed).toBeNull();
    expect(drafts.note).toBe("");
  });

  it("round-trips every declared kind", () => {
    const result = serializeHumanTaskDrafts(fields, {
      note: "hello",
      confirmed: true,
      count: "3",
      items: '[1, "two"]',
      mode: "slow",
    });

    expect(result).toEqual({
      ok: true,
      values: {
        note: "hello",
        confirmed: true,
        count: 3,
        items: [1, "two"],
        mode: "slow",
      },
    });
  });

  it("refuses a missing required field before making a request", () => {
    const result = serializeHumanTaskDrafts(fields, {
      note: "hello",
      confirmed: null,
      count: "",
      items: "",
      mode: "",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("confirmed");
  });

  it("omits an optional field left empty", () => {
    const result = serializeHumanTaskDrafts(fields, {
      note: "hello",
      confirmed: false,
      count: "",
      items: "",
      mode: "",
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.values).toEqual({
      note: "hello",
      confirmed: false,
    });
  });

  it("rejects unparsable JSON / numbers / enum values", () => {
    const base = {
      note: "n",
      confirmed: true,
      count: "1",
      items: "[1]",
      mode: "fast",
    };
    for (const [patch, needle] of [
      [{ items: "{oops" }, "JSON"],
      [{ count: "abc" }, "数字"],
      [{ mode: "medium" }, "枚举"],
    ] as const) {
      const result = serializeHumanTaskDrafts(fields, { ...base, ...patch });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain(needle);
    }
  });

  it("formatRuleValue distinguishes booleans from the strings that spell them", () => {
    expect(formatRuleValue(true)).toBe("true");
    expect(formatRuleValue("true")).toBe("true");
    // Both labels read "true" but only the option's *value* is what gets
    // submitted — so the boolean port's options must carry booleans.
    const boolFields = humanTaskFields(
      parsed({
        ...taskRow([{ name: "decision", type: "bool", required: true }]),
        kind: "review",
        validation_rules: { enum: { decision: { enum: [true, false] } } },
      }),
    );
    expect(boolFields[0]?.options?.map((option) => option.value)).toEqual([
      true,
      false,
    ]);
    expect(serializeHumanTaskDrafts(boolFields, { decision: false })).toEqual({
      ok: true,
      values: { decision: false },
    });
  });

  it("refuses a string draft for a boolean port", () => {
    // The defensive guard behind the widget: a stale (or hand-built) draft must
    // not submit the string "false" where the backend validates a boolean.
    const fields = humanTaskFields(
      parsed(taskRow([{ name: "confirmed", type: "bool", required: true }])),
    );
    const result = serializeHumanTaskDrafts(fields, { confirmed: "false" });
    expect(result.ok).toBe(false);
  });

  it("narrows a boolean port to the booleans its enum rule allows", () => {
    // A breakpoint's `acknowledge` allows only `true`: offering `false` would
    // render a button the backend rejects.
    const fields = humanTaskFields(
      parsed({
        ...taskRow([{ name: "acknowledge", type: "bool", required: true }]),
        kind: "breakpoint",
        validation_rules: { enum: { acknowledge: { enum: [true] } } },
      }),
    );
    expect(fields[0]?.options).toEqual([{ label: "true", value: true }]);
    expect(serializeHumanTaskDrafts(fields, { acknowledge: false }).ok).toBe(
      false,
    );
  });
});

describe("pendingHumanTasks", () => {
  it("keeps submission tasks and leaves debug pauses to their own list", () => {
    const rows = [
      parsed(taskRow([{ name: "x", type: "data" }])),
      parsed({
        ...taskRow([{ name: "x", type: "data" }]),
        id: "ht-ap",
        kind: "review",
      }),
      parsed(stepTask()),
      parsed({
        ...taskRow([{ name: "x", type: "data" }]),
        id: "ht-done",
        status: "submitted",
      }),
    ];

    const pending = pendingHumanTasks(rows);

    expect(pending.map((task) => task.id)).toEqual(["ht-task", "ht-ap"]);
    expect(pending.map((task) => task.kind)).toEqual(["task", "review"]);
  });

  it("pins the open run's tasks first without hiding another run's", () => {
    const other = parsed({
      ...taskRow([{ name: "x", type: "data" }]),
      id: "ht-other",
      workflow_run_id: "run-9",
    });
    const mine = parsed(taskRow([{ name: "x", type: "data" }]));

    expect(
      pendingHumanTasks([other, mine], { preferredRunId: "run-1" }).map(
        (task) => task.id,
      ),
    ).toEqual(["ht-task", "ht-other"]);
  });
});

describe("review snapshots", () => {
  it("reduces a stored review snapshot", () => {
    const task = parsed({
      ...taskRow([{ name: "decision", type: "bool", required: true }]),
      kind: "review",
      inputs_snapshot: {
        kind: "review",
        visit: 2,
        previous_rejections: 1,
        target_node_id: "ai_writer",
        instructions: "Check the citations",
        in: { draft: "hello" },
      },
    });

    expect(task.review).toEqual({
      visit: 2,
      previousRejections: 1,
      targetNodeId: "ai_writer",
      instructions: "Check the citations",
      input: { draft: "hello" },
    });
  });

  it("is null for a non-review snapshot or a malformed payload", () => {
    expect(parsed(taskRow([{ name: "x", type: "data" }])).review).toBeNull();
    expect(
      parsed({
        ...taskRow([{ name: "x", type: "data" }]),
        kind: "review",
        inputs_snapshot: { kind: "task" },
      }).review,
    ).toBeNull();
    expect(
      parsed({
        ...taskRow([{ name: "x", type: "data" }]),
        kind: "review",
        inputs_snapshot: "nope",
      }).review,
    ).toBeNull();
  });

  it("defaults visit and previous rejection counts defensively", () => {
    const task = parsed({
      ...taskRow([{ name: "decision", type: "bool" }]),
      kind: "review",
      inputs_snapshot: { kind: "review" },
    });
    expect(task.review).toEqual({
      visit: 1,
      previousRejections: 0,
      targetNodeId: "",
      instructions: "",
      input: undefined,
    });
  });
});
