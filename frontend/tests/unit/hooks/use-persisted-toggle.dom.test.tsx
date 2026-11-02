import { afterEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { usePersistedBoolean } from "@/hooks/use-persisted-toggle";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("usePersistedBoolean", () => {
  it("loads the stored value after mount", async () => {
    window.localStorage.setItem("test.toggle", "true");
    const { result } = renderHook(() =>
      usePersistedBoolean("test.toggle", false),
    );

    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
  });

  it("writes updates back to localStorage", () => {
    const { result } = renderHook(() =>
      usePersistedBoolean("test.toggle", false),
    );

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("test.toggle")).toBe("true");
  });
});
