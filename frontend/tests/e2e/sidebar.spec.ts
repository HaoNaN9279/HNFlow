import { expect, test } from "@playwright/test";

import { openLeadAgent } from "./utils/lead-agent";
import { mockLangGraphAPI } from "./utils/mock-api";

test.describe("Sidebar navigation", () => {
  test("sidebar exposes workspace destinations without chat or agent entries", async ({
    page,
  }) => {
    mockLangGraphAPI(page);

    await openLeadAgent(page);

    const sidebar = page.locator("[data-sidebar='sidebar']");
    await expect(sidebar.locator("a[href='/workspace/workflows']")).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(sidebar.locator("a[href='/workspace/chats']")).toHaveCount(0);
    await expect(sidebar.locator("a[href='/workspace/agents']")).toHaveCount(0);
    await expect(sidebar.getByText("HNFlow", { exact: true })).toBeVisible();
  });

  test("mobile keeps the Lead Agent inside the viewport and opens the sidebar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    mockLangGraphAPI(page);

    await openLeadAgent(page);

    const viewportWidth = page.viewportSize()?.width ?? 390;
    const expectInsideViewport = async (
      locator: ReturnType<typeof page.locator>,
    ) => {
      await expect(locator).toBeVisible({ timeout: 15_000 });
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + 1);
    };

    await expectInsideViewport(page.getByTestId("lead-agent-panel"));
    await expectInsideViewport(page.getByRole("textbox").first());

    const mobileSidebarTrigger = page
      .locator("[data-sidebar='trigger']:visible")
      .first();
    await expect(mobileSidebarTrigger).toBeVisible();
    await mobileSidebarTrigger.click();

    const mobileSidebar = page.locator(
      "[data-mobile='true'][data-sidebar='sidebar']",
    );
    await expect(mobileSidebar).toBeVisible();
    await expect(
      mobileSidebar.locator("a[href='/workspace/workflows']"),
    ).toBeVisible();
    await expect(
      mobileSidebar.locator("a[href='/workspace/chats']"),
    ).toHaveCount(0);
  });
});
