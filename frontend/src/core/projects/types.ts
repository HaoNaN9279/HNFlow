export type ProjectRoot = {
  id: string;
  path: string;
  mode: "rw" | "ro";
};

export type ProjectCapabilityGroupRoot = {
  id: string;
  path: string;
};

export type ProjectCapabilityGroupRootStatus = {
  id: string;
  path: string;
  resolved_path: string;
  exists: boolean;
  is_symlink: boolean;
  is_junction: boolean;
  group_count: number;
};

export type ProjectManifest = {
  schema_version: number;
  project_id: string;
  name: string;
  description: string;
  default_environment: string | null;
  capability_groups: { roots: ProjectCapabilityGroupRoot[] };
  roots: ProjectRoot[];
  mcp_allowlist: string[];
  secret_refs: string[];
  settings: Record<string, unknown>;
};

export type ProjectRecord = {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  description: string;
  root_path: string;
  manifest_hash: string;
  default_environment: string | null;
  capability_groups: { roots: ProjectCapabilityGroupRoot[] };
  roots: ProjectRoot[];
  mcp_allowlist: string[];
  secret_refs: string[];
  created_at: string;
  updated_at: string;
  manifest?: ProjectManifest | null;
  workbenches_path?: string;
  capability_group_roots?: ProjectCapabilityGroupRootStatus[];
  error?: string;
};
