import { describe, expect, it } from "@rstest/core";

import {
  hrefForTrailEntry,
  parseLocalPath,
  parseWorkflowTrail,
  workflowHref,
} from "@/core/workflows/trail";

const A = { id: "wf-a", name: "父流程" };
const B = {
  id: "wf-b",
  name: "子流程",
  localRoot: "wf-a",
  localPath: ["n_sub"],
};

describe("workflow navigation trail", () => {
  it("round-trips ancestor names and embedded targets through the URL", () => {
    const href = workflowHref("wf-c", [A, B], {
      localRoot: "wf-a",
      localPath: ["n_sub", "n_inner"],
    });
    const query = new URLSearchParams(href.split("?")[1]);

    expect(parseWorkflowTrail(query.get("trail"))).toEqual([A, B]);
    expect(parseLocalPath(query.get("localPath"))).toEqual([
      "n_sub",
      "n_inner",
    ]);
    expect(query.get("localRoot")).toBe("wf-a");
  });

  it("keeps a parent entry's own local target", () => {
    expect(hrefForTrailEntry(B, [A])).toContain("localRoot=wf-a");
    expect(hrefForTrailEntry(B, [A])).toContain("localPath=n_sub");
    expect(hrefForTrailEntry(A, [])).toBe("/workspace/workflows/wf-a");
  });

  it("drops malformed trail entries", () => {
    expect(parseWorkflowTrail("not json")).toEqual([]);
    expect(parseWorkflowTrail(JSON.stringify([{ id: "x" }, A]))).toEqual([A]);
  });
});
