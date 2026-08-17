"use client";

import { useMemo, useState, type DragEvent } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/core/i18n/hooks";
import {
  getNodeCatalog,
  NODE_CATEGORIES,
  type NodeCatalogEntry,
} from "@/core/workflows/canvas/node-catalog";

import { WORKFLOW_NODE_DRAG_DATA_TYPE } from "./workflow-dnd";

/**
 * Material palette: every catalog node grouped by category, draggable onto
 * the canvas. The node type travels through the native drag event under
 * `WORKFLOW_NODE_DRAG_DATA_TYPE`.
 */
export function WorkflowPalette() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
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
    <aside className="flex w-60 shrink-0 flex-col border-r">
      <div className="flex flex-col gap-2 border-b p-3">
        <h2 className="text-sm font-medium">
          {t.workflows.canvas.paletteTitle}
        </h2>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.workflows.canvas.searchPlaceholder}
          aria-label={t.workflows.canvas.searchPlaceholder}
          className="h-7 text-xs"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {NODE_CATEGORIES.map((category) => {
            const entries = catalog.filter(
              (entry) => entry.category === category.id && matchesQuery(entry),
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
