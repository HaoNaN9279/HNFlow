"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";
import {
  getNodeCatalog,
  NODE_CATEGORIES,
  type NodeCatalogEntry,
} from "@/core/workflows/canvas/node-catalog";
import type { NodeType } from "@/core/workflows/types";

type WorkflowNodeCatalogDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (type: NodeType) => void;
};

/**
 * Searchable, category-grouped node catalog shown on an empty-canvas
 * double-click. Selecting an entry closes the dialog and creates that node at
 * the double-click position.
 */
export function WorkflowNodeCatalogDialog({
  open,
  onOpenChange,
  onSelect,
}: WorkflowNodeCatalogDialogProps) {
  const { t } = useI18n();
  const labels = t.workflows.nodeCatalog;
  const [query, setQuery] = useState("");
  const catalog = useMemo(() => getNodeCatalog(), []);

  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  const matchesQuery = (entry: NodeCatalogEntry) => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return true;
    }
    return (
      entry.label.toLowerCase().includes(normalized) ||
      entry.type.toLowerCase().includes(normalized) ||
      entry.description.toLowerCase().includes(normalized)
    );
  };

  const hasMatches = catalog.some(matchesQuery);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl gap-3"
        data-testid="workflow-node-catalog"
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.hint}</DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
          data-testid="node-catalog-search"
        />

        <div className="max-h-[60vh] overflow-auto pr-1">
          {hasMatches ? (
            <div className="flex flex-col gap-5">
              {NODE_CATEGORIES.map((category) => {
                const entries = catalog.filter(
                  (entry) =>
                    entry.category === category.id && matchesQuery(entry),
                );
                if (entries.length === 0) {
                  return null;
                }
                return (
                  <section
                    key={category.id}
                    className="flex flex-col gap-1.5"
                    data-testid={`node-catalog-category-${category.id}`}
                  >
                    <h3 className="text-muted-foreground text-xs font-medium">
                      {t.workflows.categories[category.id]}
                    </h3>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {entries.map((entry) => (
                        <Button
                          key={entry.type}
                          type="button"
                          variant="outline"
                          className="flex h-auto w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left"
                          data-testid={`node-catalog-item-${entry.type}`}
                          onClick={() => onSelect(entry.type)}
                        >
                          <span className="max-w-full text-sm font-medium break-words whitespace-normal">
                            {entry.label}
                          </span>
                          <span className="text-muted-foreground max-w-full text-[11px] leading-snug font-normal break-words whitespace-normal">
                            {entry.description}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p
              className="text-muted-foreground py-6 text-center text-sm"
              role="status"
            >
              {labels.empty}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
