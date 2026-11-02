import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Layer 2: drive the REAL frontend against the REAL gateway (replay model, no
 * API key) and assert the browser renders the backend's data correctly.
 *
 * The prompt is read from the same fixture the gateway replays, so the input
 * hash matches and the recorded model turns reproduce deterministically. The
 * default auto-title is local fallback state, not a replayed model turn.
 */
const fixture = JSON.parse(
  readFileSync(
    join(
      here,
      "../../../backend/tests/fixtures/replay/write_read_file.ultra.json",
    ),
    "utf-8",
  ),
) as {
  prompt: string;
  turns: Array<{ output: { data: { content?: unknown } } }>;
};

const PROMPT = fixture.prompt;
const FALLBACK_TITLE_MAX_CHARS = 50;

function fallbackTitle(userMsg: string): string {
  if (!userMsg) return "New Conversation";
  if (userMsg.length <= FALLBACK_TITLE_MAX_CHARS) return userMsg;
  return `${userMsg.slice(0, FALLBACK_TITLE_MAX_CHARS).trimEnd()}...`;
}

// The default title no longer comes from the recorded fixture: TitleMiddleware
// uses a local fallback when title.model_name is unset, so derive that expected
// title from the prompt. The replayed model output that proves a real backend
// turn reached the browser is the final assistant answer in the fixture.
const textTurns = fixture.turns
  .map((t) => t.output?.data?.content)
  .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
// Follow-up suggestion turns (bracket-prefixed JSON arrays) are no longer
// requested by the frontend — the suggestions feature was removed — so skip
// them and assert the assistant answer instead.
const answerTurns = textTurns.filter((c) => !c.trim().startsWith("["));
const EXPECTED_ANSWER =
  answerTurns.length > 0 ? answerTurns[answerTurns.length - 1]!.trim() : "";
const EXPECTED_TITLE = fallbackTitle(PROMPT);

test.describe("real backend render (replay, no API key)", () => {
  test("renders the local auto-title + replayed assistant answer from a real backend", async ({
    page,
  }) => {
    // ultra mode so the context the frontend sends (is_plan_mode + subagent_enabled)
    // matches the recorded fixture; otherwise the replay input hash would miss.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "deerflow.local-settings",
        JSON.stringify({ context: { mode: "ultra" } }),
      );
    });

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 30_000 });
    await textarea.fill(PROMPT);
    await textarea.press("Enter");

    // The title is the default local fallback, while the assistant answer is a
    // replayed model output. Together they prove the backend state update and
    // the replayed model turn both render through the real frontend.
    expect(
      EXPECTED_TITLE,
      "default local fallback title should be derived from the prompt",
    ).not.toBe("");
    expect(
      EXPECTED_ANSWER,
      "fixture should contain an assistant answer turn",
    ).not.toBe("");
    const chat = page.locator("#chat");
    await expect(chat.getByText(EXPECTED_TITLE)).toBeVisible({
      timeout: 60_000,
    });
    await expect(chat.getByText(EXPECTED_ANSWER)).toBeVisible({
      timeout: 30_000,
    });

    // Visual regression is OS-sensitive (a macOS baseline won't match CI's
    // Linux render), so it's a local dev gate only; in CI we capture the render
    // as an artifact for human review instead of hard-asserting a cross-OS
    // baseline. The DOM assertions above are the CI gate.
    if (process.env.CI) {
      await page.screenshot({
        path: "test-results/real-backend-render.png",
        fullPage: true,
      });
    } else {
      await expect(page).toHaveScreenshot("real-backend-render.png", {
        maxDiffPixelRatio: 0.02,
        fullPage: true,
      });
    }
  });
});
