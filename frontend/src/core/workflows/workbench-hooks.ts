import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useI18n } from "@/core/i18n/hooks";

import {
  addWorkbenchMember,
  createWorkbench,
  createWorkbenchRun,
  deleteWorkbench,
  getWorkbench,
  listMonitorRuns,
  listWorkbenches,
  removeWorkbenchMember,
  updateWorkbench,
  type MonitorRun,
  type WorkbenchLayout,
  type WorkbenchRecord,
} from "./workbenches";

const MONITOR_KEY = ["workflow-monitor-runs"] as const;

export function useWorkbenches() {
  return useQuery({
    queryKey: ["workbenches"],
    queryFn: listWorkbenches,
  });
}

export function useWorkbench(id: string | null | undefined) {
  return useQuery({
    queryKey: ["workbenches", id],
    queryFn: () => getWorkbench(id ?? ""),
    enabled: Boolean(id),
  });
}

export function useMonitorRuns(options?: {
  workbenchId?: string | null;
  status?: "active" | "waiting_human" | "all";
}) {
  return useQuery({
    queryKey: [
      ...MONITOR_KEY,
      options?.workbenchId ?? "all",
      options?.status ?? "active",
    ],
    queryFn: () => listMonitorRuns(options),
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    staleTime: 1_000,
    retry: false,
  });
}

export function useCreateWorkbench() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: createWorkbench,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
      toast.success(t.workbenches.created);
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.createFailed}: ${error.message}`);
    },
  });
}

export function useUpdateWorkbench(id: string) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (payload: {
      name?: string;
      description?: string;
      layout?: WorkbenchLayout | Record<string, unknown>;
      settings?: Record<string, unknown>;
      revision?: number;
    }) => updateWorkbench(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
      void queryClient.invalidateQueries({ queryKey: ["workbenches", id] });
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.saveFailed}: ${error.message}`);
    },
  });
}

export function useDeleteWorkbench() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (id: string) => deleteWorkbench(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.deleteFailed}: ${error.message}`);
    },
  });
}

export function useAddWorkbenchMember(workbenchId: string) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (definitionId: string) =>
      addWorkbenchMember(workbenchId, definitionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workbenches", workbenchId],
      });
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
      toast.success(t.workbenches.memberAdded);
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.memberAddFailed}: ${error.message}`);
    },
  });
}

export function useRemoveWorkbenchMember(workbenchId: string) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (definitionId: string) =>
      removeWorkbenchMember(workbenchId, definitionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workbenches", workbenchId],
      });
      void queryClient.invalidateQueries({ queryKey: ["workbenches"] });
      toast.success(t.workbenches.memberRemoved);
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.memberRemoveFailed}: ${error.message}`);
    },
  });
}

export function useCreateWorkbenchRun(workbenchId: string) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (payload: {
      definition_id: string;
      params?: Record<string, unknown>;
      debug_step?: boolean;
    }) => createWorkbenchRun(workbenchId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MONITOR_KEY });
      void queryClient.invalidateQueries({
        queryKey: ["workbenches", workbenchId],
      });
      toast.success(t.workbenches.runStarted);
    },
    onError: (error: Error) => {
      toast.error(`${t.workbenches.runFailed}: ${error.message}`);
    },
  });
}

export function useWorkbenchRuns(workbenchId: string | null | undefined): {
  runs: MonitorRun[];
  activeRuns: MonitorRun[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const query = useMonitorRuns({ workbenchId, status: "active" });
  const runs = query.data ?? [];
  return {
    runs,
    activeRuns: runs.filter(
      (run) => run.status === "pending" || run.status === "running",
    ),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

export function latestRunForDefinition(
  runs: MonitorRun[],
  definitionId: string,
): MonitorRun | null {
  return runs.find((run) => run.definition_id === definitionId) ?? null;
}

export function workbenchEditorHref(
  workbenchId: string,
  definitionId: string,
): string {
  return `/workspace/workflows/${encodeURIComponent(definitionId)}?workbench=${encodeURIComponent(workbenchId)}`;
}

export type { MonitorRun, WorkbenchRecord };
