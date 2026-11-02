export type ProjectContentInstruction = {
  path: string;
  layer: string;
  source: string;
};

export type ProjectContentRule = {
  path: string;
  source: string;
};

export type ProjectContentSkill = {
  name: string;
  description: string;
  path: string;
  source: string;
};

export type ProjectContentTool = {
  ref: string;
  provider: string;
  name: string;
  version: string;
  path: string;
  error: string;
};

export type ProjectContentRecord = {
  project_id: string;
  root_path: string;
  root: string;
  content_root: string | null;
  instructions: ProjectContentInstruction[];
  rules: ProjectContentRule[];
  skills: ProjectContentSkill[];
  tools: ProjectContentTool[];
  skill_shadow: "deny" | "allow";
  allow_python_tools: boolean;
  warnings: string[];
  exists: boolean;
  fingerprint: string;
  snapshot: { path: string; sha256: string }[];
};
