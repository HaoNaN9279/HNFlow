export type CapabilityGroupSource = "vibestack";

export type CapabilityGroupCounts = Record<string, number>;

export interface CapabilityGroupRepository {
  path: string | null;
  configured: boolean;
  exists: boolean;
}

export interface CapabilityGroupCore {
  name: string;
  version: string;
}

export interface CapabilityGroupSummary {
  guid: string;
  name: string;
  version: string;
  description: string;
  source: CapabilityGroupSource;
  permissions: string[];
  extends: string[];
  tools?: string[];
  tool_permissions?: Record<string, string[]>;
  counts: CapabilityGroupCounts;
  is_core?: boolean;
  active?: boolean;
}

export interface CapabilityGroupCatalog {
  repository: CapabilityGroupRepository;
  core: CapabilityGroupCore;
  groups: CapabilityGroupSummary[];
  warnings: string[];
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
