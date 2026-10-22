import { expect, test } from "@playwright/test";

import { openLeadAgent } from "./utils/lead-agent";
import { handleRunStream, mockLangGraphAPI } from "./utils/mock-api";

function textFromMessageContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

test.describe("Chat workspace", () => {
  test.beforeEach(async ({ page }) => {
    mockLangGraphAPI(page);
  });

  test("new chat page loads with input box", async ({ page }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /load more/i })).toBeHidden();
  });

  test("shows the localized AI disclaimer", async ({ page }) => {
    await openLeadAgent(page);
    await page.evaluate(() => {
      document.cookie = "locale=zh-CN; path=/; SameSite=Lax";
    });
    await page.reload();

    await expect(
      page.getByText("内容由AI生成，重要信息请务必核查", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("can type a message in the input box", async ({ page }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("Hello, DeerFlow!");
    await expect(textarea).toHaveValue("Hello, DeerFlow!");
  });

  test("restores a draft after reload and clears it after sending", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill("Keep this unfinished draft");

    await page.reload();

    const restoredTextarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(restoredTextarea).toHaveValue("Keep this unfinished draft");
    await restoredTextarea.press("Enter");
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });

    await page.reload();
    await expect(page.getByPlaceholder(/how can i assist you/i)).toHaveValue(
      "",
    );
  });

  test("restores a repeated draft that matches the last sent prompt", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill("Repeat this request");
    await textarea.press("Enter");
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
    await expect(textarea).toHaveValue("");

    await textarea.fill("Repeat this request");
    await expect
      .poll(() =>
        page.evaluate(() => Object.values(window.sessionStorage).join("\n")),
      )
      .toContain("Repeat this request");

    await page.reload();
    await expect(page.getByPlaceholder(/how can i assist you/i)).toHaveValue(
      "Repeat this request",
    );
  });

  test("restores a selected slash skill draft after reload", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill("/dat");
    await textarea.press("Enter");

    await expect(page.getByText("/data-analysis")).toBeVisible();
    const skillInput = page.getByRole("textbox", {
      name: /how can i assist you/i,
    });
    await skillInput.fill("Analyze the latest results");
    await expect
      .poll(() =>
        page.evaluate(() => Object.values(window.sessionStorage).join("\n")),
      )
      .toContain("Analyze the latest results");

    await page.reload();

    await expect(page.getByText("/data-analysis")).toBeVisible();
    await expect(
      page.getByRole("textbox", {
        name: /how can i assist you/i,
      }),
    ).toHaveText("Analyze the latest results");
  });

  test("continues without draft persistence when sessionStorage is blocked", async ({
    page,
  }) => {
    let submittedText: string | undefined;
    await page.addInitScript(() => {
      const realSessionStorage = window.sessionStorage;
      Reflect.set(window, "__blockComposerDraftStorage", false);
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          if (Reflect.get(window, "__blockComposerDraftStorage") === true) {
            throw new DOMException("Blocked", "SecurityError");
          }
          return realSessionStorage;
        },
      });
    });
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      const content = body.input?.messages?.at(-1)?.content;
      submittedText = textFromMessageContent(content);
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      Reflect.set(window, "__blockComposerDraftStorage", true);
    });
    await textarea.fill("Send while storage is blocked");
    await textarea.press("Enter");

    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe("Send while storage is blocked");
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("does not rewrite an accepted attachment draft from a stale debounce", async ({
    page,
  }) => {
    let releaseUpload!: () => void;
    const uploadHeld = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let submittedText: string | undefined;

    await page.route("**/api/threads/*/uploads", async (route) => {
      await uploadHeld;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "Uploaded",
          files: [
            {
              filename: "notes.txt",
              size: 12,
              path: "notes.txt",
              virtual_path: "/mnt/user-data/uploads/notes.txt",
              artifact_url: "/api/threads/test/uploads/notes.txt",
              extension: ".txt",
            },
          ],
        }),
      });
    });
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      const content = body.input?.messages?.at(-1)?.content;
      submittedText = textFromMessageContent(content);
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Upload files").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fake notes"),
    });
    await textarea.fill("Send this immediately");
    await textarea.press("Enter");

    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() =>
        Object.values(window.sessionStorage).join("\n"),
      ),
    ).not.toContain("Send this immediately");

    releaseUpload();
    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe("Send this immediately");
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });

    await page.reload();
    await expect(page.getByPlaceholder(/how can i assist you/i)).toHaveValue(
      "",
    );
  });

  test("suggests matching skills after a leading slash", async ({ page }) => {
    let submittedText: string | undefined;
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      const content = body.input?.messages?.at(-1)?.content;
      if (typeof content === "string") {
        submittedText = content;
      } else if (Array.isArray(content)) {
        submittedText = content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
      }
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /disabled-skill/i }),
    ).toBeHidden();

    await textarea.press("Enter");

    await expect(page.getByText("/data-analysis")).toBeVisible();
    const skillInput = page.getByRole("textbox", {
      name: /how can i assist you/i,
    });
    await expect(skillInput).toBeVisible();

    await skillInput.fill("summarize this dataset");
    await skillInput.press("Enter");

    await expect
      .poll(() => submittedText)
      .toBe("/data-analysis summarize this dataset");
  });

  test("reopens the skill list with a slash after a skill is selected", async ({
    page,
  }) => {
    let submittedText: string | undefined;
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      submittedText = textFromMessageContent(
        body.input?.messages?.at(-1)?.content,
      );
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();
    await textarea.press("Enter");
    await expect(page.getByText("/data-analysis")).toBeVisible();

    const skillInput = page.getByRole("textbox", {
      name: /how can i assist you/i,
    });
    await expect(skillInput).toBeVisible();

    await skillInput.pressSequentially("/");

    const dataAnalysis = page.getByRole("option", { name: /data-analysis/i });
    const frontendDesign = page.getByRole("option", {
      name: /frontend-design/i,
    });
    await expect(dataAnalysis).toBeVisible();
    await expect(frontendDesign).toBeVisible();
    // Builtin commands own the whole composer line, so they stay out of the
    // list while a skill is selected even though an empty query matches them.
    await expect(page.getByRole("option", { name: /goal/i })).toBeHidden();

    await skillInput.pressSequentially("fro");
    await expect(frontendDesign).toHaveAttribute("aria-selected", "true");

    await skillInput.press("Enter");

    await expect(page.getByText("/frontend-design")).toBeVisible();
    await expect(page.getByText("/data-analysis")).toBeHidden();

    await skillInput.pressSequentially("polish the composer");
    await skillInput.press("Enter");

    await expect
      .poll(() => submittedText)
      .toBe("/frontend-design polish the composer");
  });

  test("does not offer a skill whose name a slash command owns", async ({
    page,
  }) => {
    // Registered after the shared mock, so it wins: nothing rejects these
    // names when the skill is created.
    await page.route("**/api/skills", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          skills: [
            {
              name: "data-analysis",
              description: "Analyze structured data and produce charts.",
              category: "public",
              enabled: true,
            },
            {
              name: "compact",
              description: "A custom skill named after a builtin command.",
              category: "custom",
              enabled: true,
            },
            {
              name: "status",
              description: "A custom skill named after a reserved command.",
              category: "custom",
              enabled: true,
            },
          ],
        }),
      }),
    );

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/comp");
    // Reserved outside chip mode: the builtin is offered, the skill is not.
    await expect(
      page.getByRole("option", { name: /compact/i }),
    ).toHaveAccessibleName(/Compact earlier context/i);

    // A contract-reserved name has no builtin standing in for it, so the list
    // is empty rather than showing a skill both slash parsers would refuse.
    await textarea.fill("/stat");
    await expect(page.getByRole("option", { name: /status/i })).toBeHidden();

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();
    await textarea.press("Enter");
    await expect(page.getByText("/data-analysis")).toBeVisible();

    const skillInput = page.getByRole("textbox", {
      name: /how can i assist you/i,
    });
    await skillInput.pressSequentially("/comp");

    // Reserved in chip mode too. Selecting it would set a `/compact` chip that
    // `parseCompactCommand` intercepts on submit, so context compaction would
    // run instead of the skill.
    await expect(page.getByRole("option", { name: /compact/i })).toBeHidden();

    await skillInput.fill("/stat");
    await expect(page.getByRole("option", { name: /status/i })).toBeHidden();
  });

  test("goal command sets a goal and starts an agent run", async ({ page }) => {
    let streamCalls = 0;
    await openLeadAgent(page);
    await page.route("**/runs/stream", (route) => {
      streamCalls += 1;
      return route.fallback();
    });

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/go");
    await expect(page.getByRole("option", { name: /goal/i })).toBeVisible();

    await textarea.fill("/goal finish all tests");
    await textarea.press("Enter");

    await expect(
      page.locator("span.font-medium", { hasText: "finish all tests" }),
    ).toBeVisible();
    await expect.poll(() => streamCalls).toBe(1);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible();
  });

  test("goal command keeps the welcome header clear of the goal status", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(
      "/goal finish a small repo check and report the result",
    );
    await textarea.press("Enter");

    const goal = page.locator("span.font-medium", {
      hasText: "finish a small repo check",
    });
    await expect(goal).toBeVisible();
    await expect(page.getByText(/welcome to/i)).toBeHidden();

    const overlaps = await page.evaluate(() => {
      const welcome = [...document.querySelectorAll("p")].find((el) =>
        el.textContent?.toLowerCase().includes("welcome to"),
      );
      const goal = [...document.querySelectorAll("span")].find((el) =>
        el.textContent?.includes(
          "finish a small repo check and report the result",
        ),
      );
      if (!welcome || !goal) {
        return false;
      }
      const welcomeRect = welcome.getBoundingClientRect();
      const goalRect = goal.getBoundingClientRect();
      return !(
        welcomeRect.right < goalRect.left ||
        goalRect.right < welcomeRect.left ||
        welcomeRect.bottom < goalRect.top ||
        goalRect.bottom < welcomeRect.top
      );
    });
    expect(overlaps).toBe(false);
  });

  test("uses arrow keys to navigate skill suggestions before prompt history", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/");

    const dataAnalysis = page.getByRole("option", {
      name: /data-analysis/i,
    });
    const frontendDesign = page.getByRole("option", {
      name: /frontend-design/i,
    });
    await expect(dataAnalysis).toBeVisible();
    await expect(frontendDesign).toBeVisible();
    await expect(dataAnalysis).toHaveAttribute("aria-selected", "true");

    await textarea.press("ArrowDown");

    await expect(textarea).toHaveValue("/");
    await expect(dataAnalysis).toHaveAttribute("aria-selected", "false");
    await expect(frontendDesign).toHaveAttribute("aria-selected", "true");

    await textarea.press("ArrowUp");

    await expect(textarea).toHaveValue("/");
    await expect(dataAnalysis).toHaveAttribute("aria-selected", "true");
    await expect(frontendDesign).toHaveAttribute("aria-selected", "false");

    await textarea.press("ArrowDown");
    await textarea.press("Enter");

    await expect(page.getByText("/frontend-design")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /how can i assist you/i }),
    ).toBeVisible();
  });

  test("keeps Shift+Enter as newline while skill suggestions are visible", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();

    await textarea.press("Shift+Enter");

    await expect(textarea).toHaveValue("/dat\n");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeHidden();
  });

  test("does not suggest skills for slash text away from the prompt start", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("please /dat");

    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeHidden();
  });

  test("sending a message triggers API call and shows response", async ({
    page,
  }) => {
    let streamCalled = false;
    await page.route("**/runs/stream", (route) => {
      streamCalled = true;
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("Hello");
    await textarea.press("Enter");

    await expect.poll(() => streamCalled, { timeout: 10_000 }).toBeTruthy();

    // The AI response should appear in the chat
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("slash skill command is submitted as normal chat text", async ({
    page,
  }) => {
    const slashCommand = "/data-analysis analyze uploads/foo.csv";
    let submittedText: string | undefined;
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      const content = body.input?.messages?.at(-1)?.content;
      if (typeof content === "string") {
        submittedText = content;
      } else if (Array.isArray(content)) {
        submittedText = content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
      }
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(slashCommand);
    await textarea.press("Enter");

    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe(slashCommand);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("slash skill command with attachment preserves command text and file metadata", async ({
    page,
  }) => {
    const slashCommand = "/data-analysis analyze report.docx";
    let uploadCalled = false;
    let submittedText: string | undefined;
    let submittedFiles:
      | Array<{ filename?: string; path?: string; status?: string }>
      | undefined;

    await page.route("**/api/threads/*/uploads", async (route) => {
      uploadCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "Uploaded",
          files: [
            {
              filename: "report.docx",
              size: 12,
              path: "report.docx",
              virtual_path: "/mnt/user-data/uploads/report.docx",
              artifact_url: "/api/threads/test/uploads/report.docx",
              extension: ".docx",
            },
          ],
        }),
      });
    });

    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: {
          messages?: Array<{
            content?: unknown;
            additional_kwargs?: {
              files?: Array<{
                filename?: string;
                path?: string;
                status?: string;
              }>;
            };
          }>;
        };
      };
      const message = body.input?.messages?.at(-1);
      const content = message?.content;
      if (typeof content === "string") {
        submittedText = content;
      } else if (Array.isArray(content)) {
        submittedText = content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
      }
      submittedFiles = message?.additional_kwargs?.files;
      return handleRunStream(route);
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("Upload files").setInputFiles({
      name: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fake docx"),
    });

    await textarea.fill(slashCommand);
    await textarea.press("Enter");

    await expect.poll(() => uploadCalled, { timeout: 10_000 }).toBeTruthy();
    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe(slashCommand);
    await expect
      .poll(() => submittedFiles, { timeout: 10_000 })
      .toEqual([
        {
          filename: "report.docx",
          size: 12,
          path: "/mnt/user-data/uploads/report.docx",
          status: "uploaded",
        },
      ]);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("shows gateway upload limits on the attachment entry point", async ({
    page,
  }) => {
    await openLeadAgent(page);

    const addAttachments = page.getByTestId("add-attachments-button");
    await expect(addAttachments).toBeVisible({ timeout: 15_000 });
    await addAttachments.hover();

    await expect(page.getByRole("tooltip")).toContainText("50 MiB");
    await expect(page.getByRole("tooltip")).toContainText("100 MiB");
  });

  test("rejects an oversized attachment before upload", async ({ page }) => {
    let uploadCalled = false;
    await page.route("**/api/threads/*/uploads", (route) => {
      if (route.request().method() === "POST") {
        uploadCalled = true;
      }
      return route.fallback();
    });
    await page.route("**/api/threads/*/uploads/limits", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          max_files: 10,
          max_file_size: 5,
          max_total_size: 20,
        }),
      }),
    );

    await openLeadAgent(page);
    const addAttachments = page.getByTestId("add-attachments-button");
    await addAttachments.hover();
    await expect(page.getByRole("tooltip")).toContainText("5 B");

    await page.getByLabel("Upload files").setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("123456"),
    });

    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "too-large.txt" }),
    ).toBeVisible();
    await expect(page.locator("form").getByText("too-large.txt")).toBeHidden();

    const textarea = page.locator('textarea[name="message"]');
    await textarea.fill("Continue without the rejected attachment");
    await textarea.press("Enter");
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
    expect(uploadCalled).toBe(false);
  });

  test("keeps valid attachments in order when the total limit is exceeded", async ({
    page,
  }) => {
    await page.route("**/api/threads/*/uploads/limits", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          max_files: 3,
          max_file_size: 10,
          max_total_size: 5,
        }),
      }),
    );

    await openLeadAgent(page);
    const addAttachments = page.getByTestId("add-attachments-button");
    await addAttachments.hover();
    await expect(page.getByRole("tooltip")).toContainText("5 B");

    await page.getByLabel("Upload files").setInputFiles([
      {
        name: "first.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("1234"),
      },
      {
        name: "over-total.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("12"),
      },
      {
        name: "second.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("1"),
      },
    ]);

    const promptForm = page.locator("form").filter({
      has: page.locator('textarea[name="message"]'),
    });
    await expect(promptForm.getByText("first.txt")).toBeVisible();
    await expect(promptForm.getByText("second.txt")).toBeVisible();
    await expect(promptForm.getByText("over-total.txt")).toBeHidden();
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "5 B" }),
    ).toBeVisible();
  });

  test("keeps attachments visible while upload submit is pending", async ({
    page,
  }) => {
    let releaseUpload!: () => void;
    const uploadCanFinish = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });

    await page.route("**/api/threads/*/uploads", async (route) => {
      uploadStarted();
      await uploadCanFinish;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "Uploaded",
          files: [
            {
              filename: "report.docx",
              size: 12,
              path: "report.docx",
              virtual_path: "/mnt/user-data/uploads/report.docx",
              artifact_url: "/api/threads/test/uploads/report.docx",
              extension: ".docx",
            },
          ],
        }),
      });
    });

    await openLeadAgent(page);

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    const promptForm = page.locator("form").filter({ has: textarea });

    await page.getByLabel("Upload files").setInputFiles({
      name: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fake docx"),
    });
    await expect(promptForm.getByText("report.docx")).toBeVisible();

    await textarea.fill("Summarize this document");
    await textarea.press("Enter");

    await uploadStartedPromise;
    await expect(promptForm.getByText("report.docx")).toBeVisible();

    releaseUpload();
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
    await expect(promptForm.getByText("report.docx")).toBeHidden();
  });
});
