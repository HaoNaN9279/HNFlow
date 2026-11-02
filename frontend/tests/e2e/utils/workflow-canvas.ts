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
  // Dispatch on the pane so the drop point remains usable even when a larger
  // resizable node card covers those viewport coordinates.
  await page.evaluate(
    ({ clientX, clientY }) => {
      const pane = document.querySelector(".react-flow__pane");
      pane?.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          clientX,
          clientY,
        }),
      );
    },
    { clientX, clientY },
  );

  const dialog = page.getByTestId("workflow-node-catalog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("node-catalog-search").fill(nodeType);
  await page.getByTestId(`node-catalog-item-${nodeType}`).click();
  await expect(dialog).toBeHidden();
}
