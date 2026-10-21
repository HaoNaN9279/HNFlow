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
            runHint: (runId: string) => `run ${runId}`,
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
          review: {
            title: "Human review",
            runHint: (runId: string) => `run ${runId}`,
            attempt: (visit: number) => `Attempt ${visit}`,
            previousRejections: (count: number) =>
              `${count} previous rejections`,
            target: (nodeId: string) => `Reject retries: ${nodeId}`,
            instructions: "Review instructions",
            input: "Submitted result",
            approve: "Approve",
            reject: "Reject",
            feedback: "Continue prompt",
            feedbackHint: "Sent to the agent on rejection.",
            submit: "Submit decision",
            submitting: "Submitting...",
            actionFailed: "Review action failed",
            loadFailed: "Failed to load pending reviews",
            retry: "Retry",
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
    review: null,
  };
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    statusText: "OK",
    json: async () => body,
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
