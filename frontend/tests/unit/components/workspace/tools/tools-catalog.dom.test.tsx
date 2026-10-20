import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ToolsCatalog } from "@/app/workspace/tools/page";
import type { ToolCatalogEntry } from "@/core/tools/types";

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      tools: {
        title: "Toolset",
        description: "Description",
        loading: "Loading...",
        loadFailed: "Load failed",
        retry: "Retry",
        empty: "Empty",
        emptyHint: "Hint",
        searchPlaceholder: "Search tools",
        noMatches: "No matches",
        permissions: "Permissions",
        unknownPermissions: "Unknown permissions",
        source: { package: "Tool package", provider: "Provider" },
        providers: {
          mcp: "MCP",
          builtin: "Built-in",
          sandbox: "Sandbox",
          app: "Local apps",
          python: "Custom",
        },
      },
    },
  }),
}));

afterEach(cleanup);

const tools: ToolCatalogEntry[] = [
  {
    id: "mcp:github:search",
    name: "github_search",
    provider: "mcp",
    description: "Search GitHub repositories",
    permissions: null,
    source: "provider",
    version: null,
  },
  {
    id: "builtin:read_file",
    name: "read_file",
    provider: "builtin",
    description: "Read a file",
    permissions: ["fs"],
    source: "provider",
    version: null,
  },
  {
    id: `tool:${"a".repeat(32)}@v0.1.0`,
    name: "custom_query",
    provider: "python",
    description: "Custom query tool",
    permissions: ["net"],
    source: "package",
    version: "0.1.0",
  },
];

describe("ToolsCatalog", () => {
  it("renders provider groups and includes MCP tools", () => {
    render(<ToolsCatalog tools={tools} />);

    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("Built-in")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.getByText("github_search")).toBeTruthy();
    expect(screen.getByText("mcp:github:search")).toBeTruthy();
    expect(screen.getByText("Unknown permissions")).toBeTruthy();
  });

  it("filters tools by name, id, or description", () => {
    render(<ToolsCatalog tools={tools} />);

    fireEvent.change(screen.getByTestId("tools-search"), {
      target: { value: "github" },
    });

    expect(screen.getByText("github_search")).toBeTruthy();
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.queryByText("custom_query")).toBeNull();
  });

  it("shows the empty-match state", () => {
    render(<ToolsCatalog tools={tools} />);

    fireEvent.change(screen.getByTestId("tools-search"), {
      target: { value: "does-not-exist" },
    });

    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
