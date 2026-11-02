import { describe, expect, it } from "@rstest/core";

import {
  buildCapabilityFileTree,
  type CapabilityTreeFolder,
} from "@/core/capability-groups/tree";
import type { CapabilityGroupFile } from "@/core/capability-groups/types";

function makeFile(path: string, category: string): CapabilityGroupFile {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    category,
    is_markdown: path.endsWith(".md"),
    summary: "",
    size: 0,
    modified_at: "",
  };
}

describe("buildCapabilityFileTree", () => {
  it("strips the category root and preserves nested folders", () => {
    const tree = buildCapabilityFileTree(
      [
        makeFile("skills/child/SKILL.md", "skills"),
        makeFile("skills/child/advanced/SKILL.md", "skills"),
        makeFile("skills/other/SKILL.md", "skills"),
      ],
      "skills",
    );

    expect(tree).toHaveLength(2);
    const child = tree[0] as CapabilityTreeFolder;
    expect(child.name).toBe("child");
    expect(child.fileCount).toBe(2);
    expect(child.children[0]).toMatchObject({
      kind: "folder",
      name: "advanced",
      path: "child/advanced",
    });
  });

  it("supports arbitrary category directory names", () => {
    const tree = buildCapabilityFileTree(
      [
        makeFile("commands/build.md", "commands"),
        makeFile("commands/nested/deploy.md", "commands"),
      ],
      "commands",
    );

    expect(tree.map((node) => node.name)).toEqual(["nested", "build.md"]);
    expect(tree[0]).toMatchObject({
      kind: "folder",
      name: "nested",
      path: "nested",
    });
  });

  it("sorts folders before files and alphabetically", () => {
    const tree = buildCapabilityFileTree(
      [
        makeFile("rules/zeta.md", "rules"),
        makeFile("rules/beta.md", "rules"),
        makeFile("rules/alpha/one.md", "rules"),
      ],
      "rules",
    );

    expect(tree.map((node) => node.name)).toEqual([
      "alpha",
      "beta.md",
      "zeta.md",
    ]);
  });

  it("keeps files at the category root as leaves", () => {
    const tree = buildCapabilityFileTree(
      [makeFile("SKILL.md", "rules")],
      "rules",
    );

    expect(tree).toEqual([
      expect.objectContaining({ kind: "file", name: "SKILL.md" }),
    ]);
  });
});
