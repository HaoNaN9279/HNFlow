import { expect, test } from "@playwright/test";

import { openLeadAgent } from "./utils/lead-agent";
import { mockLangGraphAPI } from "./utils/mock-api";

test.describe("UI polish mobile regressions", () => {
  test("workspace exposes mobile sidebar navigation from the chat header", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    mockLangGraphAPI(page);

    await openLeadAgent(page);

    await page
      .getByTestId("lead-agent-conversation")
      .getByRole("button", { name: /toggle sidebar/i })
      .click();

    await expect(page.getByRole("link", { name: /workflows/i })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(375);
  });

  test("global focus ring tokens are visible in light and dark themes", async ({
    page,
  }) => {
    mockLangGraphAPI(page);
    await openLeadAgent(page);

    const readRing = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ring")
          .trim(),
      );

    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    const lightRing = await readRing();
    expect(lightRing).not.toBe("transparent");
    expect(lightRing).not.toBe("");

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect.poll(readRing).not.toBe(lightRing);
    const darkRing = await readRing();
    expect(darkRing).not.toBe("transparent");
    expect(darkRing).not.toBe("");
  });
});
