"use client";

import { RefreshCwIcon, SearchIcon, WrenchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";
import { useTools } from "@/core/tools/hooks";
import type { ToolCatalogEntry } from "@/core/tools/types";
import { cn } from "@/lib/utils";

const PROVIDER_ORDER = ["mcp", "builtin", "sandbox", "app", "python"] as const;

function providerRank(provider: string): number {
  const index = (PROVIDER_ORDER as readonly string[]).indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function providerLabel(
  labels: ReturnType<typeof useI18n>["t"]["tools"],
  provider: string,
): string {
  return (
    (labels.providers as Record<string, string | undefined>)[provider] ??
    provider
  );
}

function matchesQuery(tool: ToolCatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [tool.name, tool.id, tool.description ?? ""].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export default function ToolsPage() {
  const { t } = useI18n();
  const labels = t.tools;
  const query = useTools();

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5">
          <header className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <WrenchIcon className="text-muted-foreground size-4" />
              <h1 className="text-lg font-semibold">{labels.title}</h1>
              {query.data && (
                <Badge variant="secondary" className="text-[10px]">
                  {query.data.length}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm">
              {labels.description}
            </p>
          </header>

          {query.isLoading ? (
            <div className="text-muted-foreground py-8 text-sm">
              {labels.loading}
            </div>
          ) : query.isError ? (
            <div className="border-destructive/40 bg-destructive/5 flex items-center justify-between gap-3 rounded-md border p-3">
              <span className="text-destructive text-sm">
                {labels.loadFailed}: {query.error.message}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                <RefreshCwIcon className="size-3.5" />
                {labels.retry}
              </Button>
            </div>
          ) : query.data && query.data.length > 0 ? (
            <ToolsCatalog tools={query.data} />
          ) : (
            <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center text-sm">
              <p>{labels.empty}</p>
              <p className="mt-1 text-xs">{labels.emptyHint}</p>
            </div>
          )}
        </div>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}

export function ToolsCatalog({ tools }: { tools: ToolCatalogEntry[] }) {
  const { t } = useI18n();
  const labels = t.tools;
  const [search, setSearch] = useState("");

  const groups = useMemo(() => {
    const filtered = tools.filter((tool) => matchesQuery(tool, search));
    const byProvider = new Map<string, ToolCatalogEntry[]>();
    for (const tool of filtered) {
      const existing = byProvider.get(tool.provider);
      if (existing) {
        existing.push(tool);
      } else {
        byProvider.set(tool.provider, [tool]);
      }
    }
    return [...byProvider.entries()]
      .sort(([a], [b]) => {
        const rank = providerRank(a) - providerRank(b);
        return rank !== 0 ? rank : a.localeCompare(b);
      })
      .map(([provider, entries]) => ({
        provider,
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [tools, search]);

  const filteredCount = groups.reduce(
    (total, group) => total + group.entries.length,
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">{labels.searchPlaceholder}</span>
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={labels.searchPlaceholder}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border pr-3 pl-8 text-xs outline-none focus-visible:ring-[3px]"
          data-testid="tools-search"
        />
      </label>

      {filteredCount === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center text-sm">
          {labels.noMatches}
        </div>
      ) : (
        groups.map(({ provider, entries }) => (
          <section
            key={provider}
            className="overflow-hidden rounded-md border"
            data-testid="tool-provider-group"
            data-provider={provider}
          >
            <div className="bg-muted/30 flex items-center gap-2 px-3 py-2">
              <span className="text-xs font-medium">
                {providerLabel(labels, provider)}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {entries.length}
              </Badge>
            </div>
            <div className="grid gap-2 p-2 sm:grid-cols-2">
              {entries.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCatalogEntry }) {
  const { t } = useI18n();
  const labels = t.tools;
  const permissions = tool.permissions;

  return (
    <article
      className="bg-card flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5"
      data-testid="tool-card"
      data-tool-id={tool.id}
      data-provider={tool.provider}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium">
          {tool.name}
        </span>
        {tool.version && (
          <Badge variant="outline" className="font-mono text-[10px]">
            v{tool.version}
          </Badge>
        )}
        <Badge variant="secondary" className="text-[10px]">
          {tool.source === "package"
            ? labels.source.package
            : labels.source.provider}
        </Badge>
      </div>
      <div className="text-muted-foreground truncate font-mono text-[11px]">
        {tool.id}
      </div>
      {tool.description && (
        <p className="text-muted-foreground line-clamp-2 text-xs">
          {tool.description}
        </p>
      )}
      <div className="text-muted-foreground mt-auto flex flex-wrap gap-1 text-[10px]">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5",
            permissions === null && "border-dashed",
          )}
        >
          {permissions === null
            ? labels.unknownPermissions
            : `${labels.permissions}: ${permissions.length > 0 ? permissions.join(", ") : "—"}`}
        </span>
      </div>
    </article>
  );
}
