import { expect, type Page } from "@playwright/test";

const THREAD_STORAGE_KEY = "deerflow.lead-agent.thread-id";

/**
 * The Lead Agent is workspace chrome now, so E2E must open any workspace route
 * and seed the persisted thread id before the app boots.
 */
export async function openLeadAgent(page: Page, threadId?: string) {
  await page.addInitScript(
    ({ key, id }) => {
      if (id) {
        window.localStorage.setItem(key, id);
      } else {
        window.localStorage.removeItem(key);
      }
    },
    { key: THREAD_STORAGE_KEY, id: threadId ?? null },
  );
  await page.goto("/workspace/workflows");
  await expect(page.getByTestId("lead-agent-panel")).toBeVisible({
    timeout: 15_000,
  });
}
