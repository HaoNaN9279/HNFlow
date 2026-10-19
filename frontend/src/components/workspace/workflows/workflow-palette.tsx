"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/core/i18n/hooks";
import {
  getNodeCatalog,
  NODE_CATEGORIES,
  type NodeCatalogEntry,
} from "@/core/workflows/canvas/node-catalog";
import { cn } from "@/lib/utils";

import { WORKFLOW_NODE_DRAG_DATA_TYPE } from "./workflow-dnd";

/**
 * Node catalog: every catalog node grouped by category, draggable onto the
 * canvas. The node type travels through the native drag event under
 * `WORKFLOW_NODE_DRAG_DATA_TYPE`.
 */
export function WorkflowPalette() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const catalog = useMemo(() => getNodeCatalog(), []);

  const matchesQuery = (entry: NodeCatalogEntry) => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return true;
    }
    return (
      entry.label.toLowerCase().includes(q) ||
      entry.type.toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q)
    );
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r",
        collapsed ? "w-12" : "w-60",
      )}
      data-testid="workflow-palette"
      data-collapsed={collapsed}
    >
      <div
        className={cn(
          "flex flex-col gap-2 border-b",
          collapsed ? "items-center p-2" : "p-3",
        )}
      >
        <div className="flex w-full items-center gap-2">
          {!collapsed && (
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
              {t.workflows.canvas.paletteTitle}
            </h2>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-expanded={!collapsed}
            aria-label={
              collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel
            }
            title={
              collapsed ? t.workflows.expandPanel : t.workflows.collapsePanel
            }
            onClick={() => setCollapsed((current) => !current)}
            data-testid="workflow-palette-toggle"
          >
            {collapsed ? (
              <ChevronRightIcon className="size-4" />
            ) : (
              <ChevronLeftIcon className="size-4" />
            )}
          </Button>
        </div>
        {!collapsed && (
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.workflows.canvas.searchPlaceholder}
            aria-label={t.workflows.canvas.searchPlaceholder}
            className="h-7 text-xs"
          />
        )}
      </div>
      {!collapsed && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-3">
            {NODE_CATEGORIES.map((category) => {
              const entries = catalog.filter(
                (entry) =>
                  entry.category === category.id && matchesQuery(entry),
              );
              if (entries.length === 0) {
                return null;
              }
              return (
                <div
                  key={category.id}
                  className="flex flex-col gap-1"
                  data-testid={`palette-category-${category.id}`}
                >
                  <h3 className="text-muted-foreground text-xs font-medium">
                    {t.workflows.categories[category.id]}
                  </h3>
                  {entries.map((entry) => (
                    <PaletteItem key={entry.type} entry={entry} />
                  ))}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </aside>
  );
}

function PaletteItem({ entry }: { entry: NodeCatalogEntry }) {
  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(WORKFLOW_NODE_DRAG_DATA_TYPE, entry.type);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      data-node-type={entry.type}
      data-testid={`palette-item-${entry.type}`}
      className="hover:bg-accent flex cursor-grab flex-col gap-0.5 rounded-md border px-2 py-1.5 active:cursor-grabbing"
    >
      <span className="text-xs font-medium">{entry.label}</span>
      <span className="text-muted-foreground line-clamp-1 text-[11px]">
        {entry.description}
      </span>
    </div>
  );
}
