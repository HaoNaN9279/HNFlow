import { expect, type Page } from "@playwright/test";

/**
 * Add a node through the empty-canvas double-click catalog. `clientX` and
 * `clientY` are viewport coordinates (the same values the old palette drop
 * helper accepted).
 */
export async function addNodeFromCatalog(
  page: Page,
  nodeType: string,
  clientX: number,
  clientY: number,
) {
  await page.mouse.dblclick(clientX, clientY);

  const dialog = page.getByTestId("workflow-node-catalog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("node-catalog-search").fill(nodeType);
  await page.getByTestId(`node-catalog-item-${nodeType}`).click();
  await expect(dialog).toBeHidden();
}
