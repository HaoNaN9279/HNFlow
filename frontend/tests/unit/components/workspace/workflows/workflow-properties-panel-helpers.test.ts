import { describe, expect, it } from "@rstest/core";

import {
  applyDraftRow,
  applyRemoveRow,
  paramsToDraft,
  parseParamValue,
  serializeParamValue,
} from "@/components/workspace/workflows/workflow-properties-panel-helpers";

describe("serializeParamValue", () => {
  it("renders JSON text for scalars and containers", () => {
    expect(serializeParamValue(10)).toBe("10");
    expect(serializeParamValue("x")).toBe('"x"');
    expect(serializeParamValue(true)).toBe("true");
    expect(serializeParamValue(null)).toBe("null");
    expect(serializeParamValue({ a: 1 })).toBe('{"a":1}');
    expect(serializeParamValue([1, 2])).toBe("[1,2]");
  });

  it("renders undefined as an empty string", () => {
    expect(serializeParamValue(undefined)).toBe("");
  });
});

describe("parseParamValue", () => {
  it("parses JSON values", () => {
    expect(parseParamValue('"x"')).toEqual({ ok: true, value: "x" });
    expect(parseParamValue("10")).toEqual({ ok: true, value: 10 });
    expect(parseParamValue("null")).toEqual({ ok: true, value: null });
    expect(parseParamValue("{")).toEqual({ ok: false });
  });

  it("treats blank text as undefined (not an error)", () => {
    expect(parseParamValue("")).toEqual({ ok: true, value: undefined });
    expect(parseParamValue("   ")).toEqual({ ok: true, value: undefined });
  });
});

describe("paramsToDraft", () => {
  it("maps every param into a row with serialized value and stable id", () => {
    expect(
      paramsToDraft({ threshold: 10, label: "check", note: undefined }),
    ).toEqual([
      { id: "threshold", key: "threshold", value: "10" },
      { id: "label", key: "label", value: '"check"' },
      { id: "note", key: "note", value: "" },
    ]);
  });
});

describe("applyDraftRow", () => {
  it("updates an existing key", () => {
    expect(
      applyDraftRow({ threshold: 10, label: "check" }, {
        id: "threshold",
        key: "threshold",
        value: "20",
      }),
    ).toEqual({ ok: true, params: { threshold: 20, label: "check" } });
  });

  it("adds a new key", () => {
    expect(
      applyDraftRow({ threshold: 10 }, {
        id: "new-1",
        key: "label",
        value: '"x"',
      }),
    ).toEqual({ ok: true, params: { threshold: 10, label: "x" } });
  });

  it("renames a key when the key text changes", () => {
    expect(
      applyDraftRow({ threshold: 10 }, {
        id: "threshold",
        key: "limit",
        value: "10",
      }),
    ).toEqual({ ok: true, params: { limit: 10 } });
  });

  it("removes the key when the value text is blank", () => {
    expect(
      applyDraftRow({ threshold: 10, label: "check" }, {
        id: "label",
        key: "label",
        value: "",
      }),
    ).toEqual({ ok: true, params: { threshold: 10 } });
  });

  it("rejects a blank key", () => {
    expect(
      applyDraftRow({ threshold: 10 }, { id: "new-1", key: "  ", value: "1" }),
    ).toEqual({ ok: false });
  });

  it("rejects invalid JSON", () => {
    expect(
      applyDraftRow({ threshold: 10 }, {
        id: "threshold",
        key: "threshold",
        value: "not-json",
      }),
    ).toEqual({ ok: false });
  });
});

describe("applyRemoveRow", () => {
  it("deletes only the targeted key", () => {
    expect(applyRemoveRow({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });
});
