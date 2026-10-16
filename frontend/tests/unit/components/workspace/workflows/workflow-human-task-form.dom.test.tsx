import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WorkflowHumanTaskForm } from "@/components/workspace/workflows/workflow-human-task-form";
import type { HumanTaskRecord } from "@/core/workflows/human-tasks";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        run: {
          humanTask: {
            title: "Waiting human task",
            task: "Human task",
            approval: "Approval",
            runHint: (runId: string) => `run ${runId}`,
            previewTitle: "What will happen",
            reversible: "Reversible",
            irreversible: "Irreversible",
            recovery: "Recovery",
            confirmations: "Confirmations",
            noFields: "This task declares no fields to fill in",
            submit: "Submit",
            skip: "Skip",
            skipHint: "Skipping continues as declined",
            required: "required",
            optional: "optional",
            true: "true",
            false: "false",
            patternHint: "Format:",
          },
        },
      },
    },
  }),
}));

// The real `human-tasks` module stays in play (its pure helpers are the thing
// under test); the HTTP seam underneath it is what the test controls.
const configMock = rs.hoisted(() => ({ baseUrl: "http://backend.test" }));
const fetchMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => configMock.baseUrl,
}));

rs.mock("@/core/api/fetcher", () => ({ fetch: fetchMock }));

/** An approval row carrying the gate's real `decision` spec and a preview. */
function approvalTask(
  overrides: Partial<HumanTaskRecord> = {},
): HumanTaskRecord {
  return {
    id: "ht-ap",
    workflowRunId: "run-1",
    nodeId: "write_file",
    kind: "approval",
    status: "pending",
    description: "[approval] Overwrite hero.blend",
    outputSpec: [
      {
        name: "decision",
        type: "bool",
        required: true,
        description: "true to run the action, false to reject it",
      },
    ],
    validationRules: { enum: { decision: [true, false] }, pattern: {} },
    preview: {
      action: "overwrite",
      summary: "Overwrite hero.blend",
      reversible: false,
      recovery: "restore from backup",
      targets: ["asset://host/C:/x/hero.blend"],
      requiredConfirmations: ["type the file name"],
    },
    ...overrides,
  };
}

/** A `human:task` row declaring several submission ports. */
function plainTask(): HumanTaskRecord {
  return {
    id: "ht-task",
    workflowRunId: "run-2",
    nodeId: "ask_user",
    kind: "task",
    status: "pending",
    description: "请输入参数",
    outputSpec: [
      { name: "note", type: "data", required: true, description: "写点说明" },
      { name: "count", type: "number", required: false, description: "" },
      { name: "mode", type: "enum", required: false, description: "" },
    ],
    validationRules: { enum: { mode: ["fast", "slow"] }, pattern: {} },
    preview: null,
  };
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function failedResponse(detail: unknown): Response {
  return {
    ok: false,
    statusText: "Unprocessable Entity",
    json: async () => ({ detail }),
  } as unknown as Response;
}

/** The `/submit` and `/skip` requests the form actually made. */
function actionCalls(): { url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter((call) =>
      /\/api\/human-tasks\/.+\/(submit|skip)$/.test(String(call[0])),
    )
    .map((call) => {
      const init = call[1] as { body?: unknown } | undefined;
      const rawBody = init?.body;
      return {
        url: String(call[0]),
        body:
          typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : null,
      };
    });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
});

afterEach(() => {
  cleanup();
});

describe("WorkflowHumanTaskForm — approval", () => {
  it("shows the preview and offers an explicit yes/no choice", () => {
    render(<WorkflowHumanTaskForm task={approvalTask()} />);

    expect(screen.getByTestId("workflow-human-task")).toBeTruthy();
    const preview = screen.getByTestId("workflow-human-task-preview");
    expect(preview.textContent).toContain("Overwrite hero.blend");
    expect(preview.textContent).toContain("Irreversible");
    expect(preview.textContent).toContain("restore from backup");
    expect(preview.textContent).toContain("asset://host/C:/x/hero.blend");

    const choices = screen.getAllByTestId("workflow-human-task-bool");
    expect(choices.map((button) => button.textContent)).toEqual([
      "true",
      "false",
    ]);
  });

  it("submits the decision the human picked", async () => {
    const onResolved = rs.fn();
    render(
      <WorkflowHumanTaskForm task={approvalTask()} onResolved={onResolved} />,
    );

    fireEvent.click(
      screen
        .getAllByTestId("workflow-human-task-bool")
        .find((button) => button.getAttribute("data-field-value") === "true")!,
    );
    fireEvent.click(screen.getByTestId("workflow-human-task-submit"));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]).toEqual({
      url: "http://backend.test/api/human-tasks/ht-ap/submit",
      body: { values: { decision: true } },
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("refuses to submit an untouched decision instead of rejecting silently", async () => {
    render(<WorkflowHumanTaskForm task={approvalTask()} />);

    fireEvent.click(screen.getByTestId("workflow-human-task-submit"));

    const error = await screen.findByTestId("workflow-human-task-error");
    expect(error.textContent).toContain("decision");
    // No request: an unset boolean must never become a rejection.
    expect(actionCalls()).toEqual([]);
  });

  it("surfaces the backend's rejection verbatim", async () => {
    fetchMock.mockResolvedValue(
      failedResponse({ errors: ["字段 decision 不在允许的枚举值中"] }),
    );
    render(<WorkflowHumanTaskForm task={approvalTask()} />);

    fireEvent.click(
      screen
        .getAllByTestId("workflow-human-task-bool")
        .find((button) => button.getAttribute("data-field-value") === "false")!,
    );
    fireEvent.click(screen.getByTestId("workflow-human-task-submit"));

    const error = await screen.findByTestId("workflow-human-task-error");
    expect(error.textContent).toContain("不在允许的枚举值中");
  });

  it("skips with the shared declined sentinel", async () => {
    const onResolved = rs.fn();
    render(
      <WorkflowHumanTaskForm task={approvalTask()} onResolved={onResolved} />,
    );

    fireEvent.click(screen.getByTestId("workflow-human-task-skip"));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]?.url).toBe(
      "http://backend.test/api/human-tasks/ht-ap/skip",
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });
});

describe("WorkflowHumanTaskForm — human:task", () => {
  it("renders one field per declared port, by kind", () => {
    render(<WorkflowHumanTaskForm task={plainTask()} />);

    const fields = screen.getAllByTestId("workflow-human-task-field");
    expect(
      fields.map((field) => field.getAttribute("data-field-name")),
    ).toEqual(["note", "count", "mode"]);
    expect(
      fields.map((field) => field.getAttribute("data-field-kind")),
    ).toEqual(["text", "number", "enum"]);
    // An enum rule becomes a real choice, not free text.
    const select = screen.getByTestId("workflow-human-task-select");
    expect(select.querySelectorAll("option")).toHaveLength(3);
  });

  it("submits typed values and omits the empty optional field", async () => {
    render(<WorkflowHumanTaskForm task={plainTask()} />);

    fireEvent.change(screen.getAllByTestId("workflow-human-task-input")[0]!, {
      target: { value: "看看这个" },
    });
    fireEvent.click(screen.getByTestId("workflow-human-task-submit"));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]).toEqual({
      url: "http://backend.test/api/human-tasks/ht-task/submit",
      body: { values: { note: "看看这个" } },
    });
  });

  it("reports a missing required field locally", async () => {
    render(<WorkflowHumanTaskForm task={plainTask()} />);

    fireEvent.click(screen.getByTestId("workflow-human-task-submit"));

    const error = await screen.findByTestId("workflow-human-task-error");
    expect(error.textContent).toContain("note");
    expect(actionCalls()).toEqual([]);
  });

  it("says so when the row declares no fields", () => {
    render(<WorkflowHumanTaskForm task={{ ...plainTask(), outputSpec: [] }} />);

    expect(screen.queryAllByTestId("workflow-human-task-field")).toEqual([]);
    expect(screen.getByTestId("workflow-human-task").textContent).toContain(
      "no fields",
    );
  });
});
