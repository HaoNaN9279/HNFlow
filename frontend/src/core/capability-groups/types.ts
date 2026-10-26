export type CapabilityGroupSource = "public" | "user" | "project";

export type CapabilityGroupCounts = Record<string, number>;

export interface CapabilityGroupSummary {
  guid: string;
  name: string;
  version: string;
  description: string;
  source: CapabilityGroupSource;
  project_id?: string | null;
  root_id?: string | null;
  permissions: string[];
  extends: string[];
  tools?: string[];
  tool_permissions?: Record<string, string[]>;
  counts: CapabilityGroupCounts;
}

export interface CapabilityGroupFile {
  path: string;
  name: string;
  category: string;
  is_markdown: boolean;
  summary: string;
  size: number;
  modified_at: string;
}

export interface CapabilityGroupCategory {
  id: string;
  files: CapabilityGroupFile[];
}

export interface CapabilityGroupDetail extends CapabilityGroupSummary {
  categories: CapabilityGroupCategory[];
}
