"use client";

import { useCallback, useEffect, useState, type SetStateAction } from "react";

import { safeLocalStorage } from "@/core/settings/local";

/**
 * A boolean piece of UI state (usually a panel's collapsed/expanded flag)
 * persisted in localStorage so the user's layout choices survive reloads.
 *
 * SSR renders the fallback first; the stored value is applied in an effect to
 * avoid a hydration mismatch. Storage failures are swallowed by
 * `safeLocalStorage`, so private-mode/quota errors never break rendering.
 */
export function usePersistedBoolean(
  key: string,
  fallback: boolean,
): [boolean, (next: SetStateAction<boolean>) => void] {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    const raw = safeLocalStorage.getItem(key);
    if (raw === "true") {
      setValue(true);
    } else if (raw === "false") {
      setValue(false);
    }
  }, [key]);

  const setPersisted = useCallback(
    (next: SetStateAction<boolean>) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        safeLocalStorage.setItem(key, String(resolved));
        return resolved;
      });
    },
    [key],
  );

  return [value, setPersisted];
}
