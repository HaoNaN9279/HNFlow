import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WorkflowReviewForm } from "@/components/workspace/workflows/workflow-review-form";
import type { HumanTaskRecord } from "@/core/workflows/human-tasks";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      workflows: {
        run: {
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
            submitting: "Submitting...",
            actionFailed: "Review action failed",
            loadFailed: "Failed to load pending reviews",
            retry: "Retry",
            submit: "Submit",
          },
        },
      },
    },
  }),
}));

const configMock = rs.hoisted(() => ({ baseUrl: "http://backend.test" }));
const fetchMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => configMock.baseUrl,
}));

rs.mock("@/core/api/fetcher", () => ({ fetch: fetchMock }));

function reviewTask(overrides: Partial<HumanTaskRecord> = {}): HumanTaskRecord {
  return {
    id: "ht-review",
    workflowRunId: "run-1",
    nodeId: "review",
    kind: "review",
    status: "pending",
    description: "Check the draft",
    outputSpec: [],
    validationRules: { enum: {}, pattern: {} },
    review: {
      visit: 2,
      previousRejections: 1,
      targetNodeId: "ai_writer",
      instructions: "Check the citations",
      input: { draft: "hello" },
    },
    ...overrides,
  };
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function actionCalls(): { url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter((call) => /\/api\/human-tasks\/.+\/submit$/.test(String(call[0])))
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

describe("WorkflowReviewForm", () => {
  it("shows the review context and has no skip action", () => {
    render(<WorkflowReviewForm task={reviewTask()} />);

    const card = screen.getByTestId("workflow-review");
    expect(card.getAttribute("data-task-visit")).toBe("2");
    expect(card.textContent).toContain("Attempt 2");
    expect(card.textContent).toContain("1 previous rejections");
    expect(card.textContent).toContain("Reject retries: ai_writer");
    expect(card.textContent).toContain("Check the citations");
    expect(screen.queryByTestId("workflow-human-task-skip")).toBeNull();
  });

  it("submits a review approval decision", async () => {
    const onResolved = rs.fn();
    render(<WorkflowReviewForm task={reviewTask()} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("workflow-review-approve"));
    fireEvent.click(screen.getByTestId("workflow-review-submit"));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]).toEqual({
      url: "http://backend.test/api/human-tasks/ht-review/submit",
      body: { values: { decision: true } },
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("submits a rejection together with the continue prompt", async () => {
    render(<WorkflowReviewForm task={reviewTask()} />);

    fireEvent.click(screen.getByTestId("workflow-review-reject"));
    fireEvent.change(screen.getByTestId("workflow-review-feedback"), {
      target: { value: "  add citations  " },
    });
    fireEvent.click(screen.getByTestId("workflow-review-submit"));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]).toEqual({
      url: "http://backend.test/api/human-tasks/ht-review/submit",
      body: { values: { decision: false, feedback: "add citations" } },
    });
  });

  it("does not submit before the human chooses", () => {
    render(<WorkflowReviewForm task={reviewTask()} />);

    fireEvent.click(screen.getByTestId("workflow-review-submit"));
    expect(actionCalls()).toEqual([]);
  });
});
