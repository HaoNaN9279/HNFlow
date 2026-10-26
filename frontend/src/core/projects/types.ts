export type ProjectRoot = {
  id: string;
  path: string;
  mode: "rw" | "ro";
};

export type ProjectManifest = {
  schema_version: number;
  project_id: string;
  name: string;
  description: string;
  default_environment: string | null;
  capability_profile: string | null;
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
  capability_profile: string | null;
  roots: ProjectRoot[];
  mcp_allowlist: string[];
  secret_refs: string[];
  created_at: string;
  updated_at: string;
  manifest?: ProjectManifest | null;
  workbenches_path?: string;
  error?: string;
};
