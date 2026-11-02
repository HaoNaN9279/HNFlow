"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { safeLocalStorage } from "@/core/settings/local";

type ResizablePanelOptions = {
  storageKey: string;
  defaultSize: number;
  min: number;
  max: number;
  /** Axis the panel grows along: x = width (right panel), y = height (bottom panel). */
  axis: "x" | "y";
};

type ResizablePanelHandleProps = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
};

/**
 * Persisted, pointer-draggable size for one side of a split layout.
 *
 * The handle sits on the panel's inner edge (left for a right panel, top for a
 * bottom panel), so dragging toward the canvas enlarges the panel. Sizes are
 * stored in localStorage and survive reloads; the collapse buttons keep their
 * own persisted state and temporarily replace the draggable size.
 */
export function useResizablePanel({
  storageKey,
  defaultSize,
  min,
  max,
  axis,
}: ResizablePanelOptions) {
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [max, min],
  );
  const [size, setSize] = useState(() => clamp(defaultSize));
  const sizeRef = useRef(size);

  useEffect(() => {
    const stored = Number(safeLocalStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) {
      const next = clamp(stored);
      sizeRef.current = next;
      setSize(next);
    }
  }, [clamp, storageKey]);

  const persist = useCallback(() => {
    safeLocalStorage.setItem(storageKey, String(sizeRef.current));
  }, [storageKey]);

  const apply = useCallback(
    (value: number) => {
      const next = clamp(value);
      sizeRef.current = next;
      setSize(next);
    },
    [clamp],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const startPointer = axis === "x" ? event.clientX : event.clientY;
      const startSize = sizeRef.current;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: PointerEvent) => {
        const current = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
        apply(startSize + (startPointer - current));
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        persist();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [apply, axis, persist],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const step = 16;
      let delta = 0;
      if (axis === "x") {
        if (event.key === "ArrowLeft") delta = step;
        if (event.key === "ArrowRight") delta = -step;
      } else {
        if (event.key === "ArrowUp") delta = step;
        if (event.key === "ArrowDown") delta = -step;
      }
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      apply(sizeRef.current + delta);
      persist();
    },
    [apply, axis, persist],
  );

  const handleProps: ResizablePanelHandleProps = {
    onPointerDown,
    onKeyDown,
    "aria-valuenow": size,
    "aria-valuemin": min,
    "aria-valuemax": max,
  };

  return { size, handleProps };
}
