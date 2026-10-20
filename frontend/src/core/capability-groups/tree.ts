import type { CapabilityGroupFile } from "./types";

/** A file leaf in a capability group's folder tree. */
export type CapabilityTreeFile = {
  kind: "file";
  name: string;
  path: string;
  file: CapabilityGroupFile;
};

/** A folder node in a capability group's folder tree. */
export type CapabilityTreeFolder = {
  kind: "folder";
  name: string;
  /** Group-relative POSIX path of the folder (stable persistence key). */
  path: string;
  /** Number of files anywhere below this folder. */
  fileCount: number;
  children: CapabilityTreeNode[];
};

export type CapabilityTreeNode = CapabilityTreeFile | CapabilityTreeFolder;

/**
 * Top-level directory names that are aliases of a built-in category. The
 * category section already names the category, so this segment is stripped
 * before building the tree (`skills/child/SKILL.md` shows a `child` folder).
 */
const CATEGORY_ROOTS: Record<string, readonly string[]> = {
  rules: ["rules"],
  agents: ["agents", "agent"],
  skills: ["skills"],
  tools: ["tools", "scripts"],
  references: ["references", "reference"],
  templates: ["templates"],
  assets: ["assets"],
  evals: ["evals"],
  other: ["other"],
};

function compareNames(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase());
  return lower !== 0 ? lower : a.localeCompare(b);
}

function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function segmentsWithinCategory(
  file: CapabilityGroupFile,
  category: string,
): string[] {
  const segments = splitPath(file.path);
  if (segments.length < 2) {
    return segments;
  }
  const roots = CATEGORY_ROOTS[category] ?? [category.toLowerCase()];
  if (roots.includes(segments[0]!.toLowerCase())) {
    return segments.slice(1);
  }
  return segments;
}

/**
 * Build a nested folder tree from the flat file list of one category.
 *
 * Arbitrary directory depth is preserved. Folders sort before files, both
 * case-insensitively, so the page renders a stable explorer-style hierarchy.
 */
export function buildCapabilityFileTree(
  files: readonly CapabilityGroupFile[],
  category: string,
): CapabilityTreeNode[] {
  type MutableFolder = {
    kind: "folder";
    name: string;
    path: string;
    fileCount: number;
    children: Map<string, MutableFolder | CapabilityTreeFile>;
  };

  const root: MutableFolder = {
    kind: "folder",
    name: "",
    path: "",
    fileCount: 0,
    children: new Map(),
  };

  for (const file of files) {
    const segments = segmentsWithinCategory(file, category);
    const fileName = segments.at(-1) ?? file.name;
    if (segments.length === 0) {
      continue;
    }

    let current = root;
    const folderSegments = segments.slice(0, -1);
    for (const segment of folderSegments) {
      current.fileCount += 1;
      const folderPath = current.path ? `${current.path}/${segment}` : segment;
      const existing = current.children.get(segment);
      if (existing?.kind === "folder") {
        current = existing;
        continue;
      }
      const folder: MutableFolder = {
        kind: "folder",
        name: segment,
        path: folderPath,
        fileCount: 0,
        children: new Map(),
      };
      current.children.set(segment, folder);
      current = folder;
    }
    current.fileCount += 1;

    const filePath = folderSegments.length ? folderSegments.join("/") : "";
    const relativePath = filePath ? `${filePath}/${fileName}` : fileName;
    current.children.set(fileName, {
      kind: "file",
      name: fileName,
      path: relativePath,
      file,
    });
  }

  const finalize = (folder: MutableFolder): CapabilityTreeNode[] =>
    [...folder.children.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "folder" ? -1 : 1;
        }
        return compareNames(a.name, b.name);
      })
      .map((node) =>
        node.kind === "folder"
          ? {
              kind: "folder" as const,
              name: node.name,
              path: node.path,
              fileCount: node.fileCount,
              children: finalize(node),
            }
          : node,
      );

  return finalize(root);
}
