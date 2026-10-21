export type ModelProfileTarget = {
  available: boolean;
  model: string | null;
  display_name: string | null;
  supports_thinking: boolean;
  supports_reasoning_effort: boolean;
};

export type ModelProfile = {
  id: string;
  user_id: string;
  name: string;
  display_name: string;
  description: string | null;
  target_model: string;
  target: ModelProfileTarget;
  enabled: boolean;
  referenced_by: number;
  referenced_workflows: number;
  created_at: string | null;
  updated_at: string | null;
};

export type ModelProfileInput = {
  name: string;
  display_name?: string;
  description?: string;
  target_model: string;
  enabled: boolean;
};
