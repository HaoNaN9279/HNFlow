import { afterEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useResizablePanel } from "@/hooks/use-resizable-panel";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("useResizablePanel", () => {
  it("loads a stored size", async () => {
    window.localStorage.setItem("test.panel.width", "420");
    const { result } = renderHook(() =>
      useResizablePanel({
        storageKey: "test.panel.width",
        defaultSize: 288,
        min: 200,
        max: 720,
        axis: "x",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.size).toBe(420);
  });

  it("resizes by dragging the inner edge and persists the result", () => {
    const { result } = renderHook(() =>
      useResizablePanel({
        storageKey: "test.panel.width",
        defaultSize: 288,
        min: 200,
        max: 720,
        axis: "x",
      }),
    );

    act(() => {
      result.current.handleProps.onPointerDown({
        button: 0,
        clientX: 500,
        preventDefault: () => undefined,
      } as never);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    expect(result.current.size).toBe(388);
    expect(window.localStorage.getItem("test.panel.width")).toBe("388");
  });

  it("supports keyboard resizing and clamps to the minimum", () => {
    const { result } = renderHook(() =>
      useResizablePanel({
        storageKey: "test.panel.height",
        defaultSize: 256,
        min: 100,
        max: 640,
        axis: "y",
      }),
    );

    act(() => {
      result.current.handleProps.onKeyDown({
        key: "ArrowUp",
        preventDefault: () => undefined,
      } as never);
    });
    expect(result.current.size).toBe(272);

    act(() => {
      result.current.handleProps.onKeyDown({
        key: "ArrowDown",
        preventDefault: () => undefined,
      } as never);
      result.current.handleProps.onKeyDown({
        key: "ArrowDown",
        preventDefault: () => undefined,
      } as never);
    });
    expect(result.current.size).toBe(240);
  });
});
