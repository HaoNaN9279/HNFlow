import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createModelProfile,
  deleteModelProfile,
  listModelProfiles,
  updateModelProfile,
} from "./api";
import type { ModelProfileInput } from "./types";

export const MODEL_PROFILES_QUERY_KEY = ["model-profiles"] as const;

export function useModelProfiles() {
  return useQuery({
    queryKey: MODEL_PROFILES_QUERY_KEY,
    queryFn: listModelProfiles,
  });
}

function useInvalidateModelProfiles() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: MODEL_PROFILES_QUERY_KEY });
}

export function useCreateModelProfile() {
  const invalidate = useInvalidateModelProfiles();
  return useMutation({
    mutationFn: (input: ModelProfileInput) => createModelProfile(input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateModelProfile() {
  const invalidate = useInvalidateModelProfiles();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<ModelProfileInput>;
    }) => updateModelProfile(id, input),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteModelProfile() {
  const invalidate = useInvalidateModelProfiles();
  return useMutation({
    mutationFn: (id: string) => deleteModelProfile(id),
    onSuccess: () => void invalidate(),
  });
}
