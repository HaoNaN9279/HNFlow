/**
 * Pure helpers for the properties panel's parameter key/value editor.
 *
 * Values are edited as JSON strings (so objects/arrays/null round-trip) and
 * parsed back on commit. Separated from the component so the serialization
 * contract is unit-testable in the plain node environment.
 */

export type ParamDraftRow = {
  /** Stable row identity — the original param key, or `new-<n>` for added rows. */
  id: string;
  key: string;
  value: string;
};

/** Serialize a param value into the JSON text shown in the value input. */
export function serializeParamValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Cyclic or otherwise unserializable value — there is no useful JSON text.
    return "";
  }
}

export type ParseParamValueResult =
  | { ok: true; value: unknown }
  | { ok: false };

/** Parse a JSON value string; empty text resolves to `undefined`. */
export function parseParamValue(text: string): ParseParamValueResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Build the initial draft rows from a node's params. */
export function paramsToDraft(params: Record<string, unknown>): ParamDraftRow[] {
  return Object.entries(params).map(([key, value]) => ({
    id: key,
    key,
    value: serializeParamValue(value),
  }));
}

/**
 * Apply one edited row back onto the params. A blank key or invalid JSON is
 * rejected so the caller can restore the stored value; an empty parsed value
 * (blank text) removes the key.
 */
export function applyDraftRow(
  params: Record<string, unknown>,
  row: ParamDraftRow,
): { ok: true; params: Record<string, unknown> } | { ok: false } {
  const key = row.key.trim();
  if (!key) {
    return { ok: false };
  }
  const parsed = parseParamValue(row.value);
  if (!parsed.ok) {
    return { ok: false };
  }
  const next = { ...params };
  if (parsed.value === undefined) {
    delete next[key];
  } else {
    next[key] = parsed.value;
  }
  // Rename semantics: when the edited key text differs from the row's original
  // key (`id`), the original key no longer exists in the params map.
  if (row.id !== key && row.id in next) {
    delete next[row.id];
  }
  return { ok: true, params: next };
}

/** Remove a single param key (used by the per-row delete button). */
export function applyRemoveRow(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const next = { ...params };
  delete next[key];
  return next;
}
