import { expect, test } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";

// The marketing landing page is only served by the static website build. The
// normal (single-user workspace) build redirects the root entry to the
// workspace, so those landing assertions only apply in static mode.
const staticOnly = process.env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true";

test.describe("Root entry", () => {
  test("redirects to the workspace in the normal build", async ({ page }) => {
    test.skip(
      staticOnly,
      "the static website build serves the landing page at /",
    );
    mockLangGraphAPI(page);

    await page.goto("/");

    await page.waitForURL("**/workspace/chats/new");
    await expect(page).toHaveURL(/\/workspace\/chats\/new/);
  });
});

test.describe("Landing page", () => {
  test.beforeEach(() => {
    test.skip(
      !staticOnly,
      "the landing page requires the static website build",
    );
  });

  test("renders the header and hero section", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.locator("header").first().getByText("DeerFlow", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toContainText("DeerFlow");

    // "Get Started" call-to-action button in hero
    await expect(
      page.getByRole("link", { name: /get started/i }),
    ).toBeVisible();
  });

  for (const width of [320, 375, 390]) {
    test(`does not overflow at ${width}px width`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.goto("/");

      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      await expect(page.locator("main").first()).toBeInViewport();
    });
  }

  test("Get Started link navigates to workspace", async ({ page }) => {
    mockLangGraphAPI(page);

    await page.goto("/");

    const getStarted = page.getByRole("link", { name: /get started/i });
    await getStarted.click();

    // Should redirect to /workspace/chats/new
    await page.waitForURL("**/workspace/chats/new");
    await expect(page).toHaveURL(/\/workspace\/chats\/new/);
  });
});
