import { afterEach, expect, test } from "@rstest/core";

import {
  getSettingsDialogSnapshot,
  openSettingsDialog,
  setSettingsDialogOpen,
  subscribeSettingsDialog,
} from "@/components/workspace/settings/settings-dialog-store";

afterEach(() => {
  // Reset shared module state between tests.
  setSettingsDialogOpen(false);
});

test("starts closed on the default section", () => {
  expect(getSettingsDialogSnapshot()).toEqual({
    open: false,
    section: "appearance",
  });
});

test("openSettingsDialog opens on the requested section", () => {
  openSettingsDialog("memory");
  expect(getSettingsDialogSnapshot()).toEqual({
    open: true,
    section: "memory",
  });
});

test("setSettingsDialogOpen(false) keeps the last section", () => {
  openSettingsDialog("tools");
  setSettingsDialogOpen(false);
  expect(getSettingsDialogSnapshot()).toEqual({
    open: false,
    section: "tools",
  });
});

test("notifies subscribers only on real state changes", () => {
  let notifications = 0;
  const unsubscribe = subscribeSettingsDialog(() => {
    notifications += 1;
  });

  openSettingsDialog("memory");
  // Opening again on the same section is a no-op and must not re-notify.
  openSettingsDialog("memory");
  expect(notifications).toBe(1);

  openSettingsDialog("skills");
  expect(notifications).toBe(2);

  unsubscribe();
  openSettingsDialog("account");
  // No further notifications after unsubscribe.
  expect(notifications).toBe(2);
});
