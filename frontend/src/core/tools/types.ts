export type ToolCatalogSource = "package" | "provider";

export interface ToolCatalogEntry {
  id: string;
  name: string;
  provider: string;
  description: string | null;
  permissions: string[] | null;
  source: ToolCatalogSource;
  version: string | null;
}
