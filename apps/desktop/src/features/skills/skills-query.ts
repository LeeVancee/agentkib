import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { desktopApi } from "@/core/desktop";
import { api } from "@/core/api";
import type { InstalledSkill, RemovedSkill, SkillSyncCoordinatorState } from "@/core/types";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";

export type SkillLibrary = { installed: InstalledSkill[]; removed: RemovedSkill[] };

export const skillKeys = {
  all: ["skills"] as const,
  inventory: () => [...skillKeys.all, "inventory"] as const,
  deployments: () => [...skillKeys.all, "deployments"] as const,
  catalog: () => [...skillKeys.all, "catalog"] as const,
  detail: (request: unknown) => [...skillKeys.all, "detail", request] as const,
  targets: () => [...skillKeys.all, "targets"] as const,
  versions: (request: unknown) => [...skillKeys.all, "versions", request] as const,
  library: () => [...skillKeys.all, "library"] as const,
  sync: () => [...skillKeys.all, "sync"] as const,
  policy: () => [...skillKeys.all, "policy"] as const,
  runs: () => [...skillKeys.all, "runs"] as const,
  schedule: () => [...skillKeys.all, "schedule"] as const,
};

/** 已安装与回收站里的技能一起读取：界面总是同时展示两者，操作也会同时改动两者。 */
export function useSkillLibrary() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: skillKeys.library(),
      queryFn: async (): Promise<SkillLibrary> => {
        const [installed, removed] = await Promise.all([
          api.installedSkills(),
          api.removedSkills(),
        ]);
        return { installed, removed };
      },
    },
    queryClient,
  );
}

export function useSkillInventory() {
  const client = useOptionalQueryClient();
  return useQuery(
    { ...queryDefaults, queryKey: skillKeys.inventory(), queryFn: () => api.skillInventory() },
    client,
  );
}
export function useSkillDeployments() {
  const client = useOptionalQueryClient();
  return useQuery(
    { ...queryDefaults, queryKey: skillKeys.deployments(), queryFn: () => api.skillDeployments() },
    client,
  );
}

export function useSkillSyncEvents() {
  const client = useOptionalQueryClient();
  useEffect(
    () =>
      desktopApi().events.onSkillSyncState?.((state) => {
        client.setQueryData(skillKeys.schedule(), state);
        if (state.state === "succeeded") void client.invalidateQueries({ queryKey: skillKeys.all });
      }),
    [client],
  );
}

export function useSkillSyncStatus() {
  const client = useOptionalQueryClient();
  return useQuery<SkillSyncCoordinatorState>(
    { queryKey: skillKeys.schedule(), queryFn: async () => ({ state: "idle" }), enabled: false },
    client,
  );
}

export function useSkillSyncState() {
  const client = useOptionalQueryClient();
  return useQuery(
    { ...queryDefaults, queryKey: skillKeys.sync(), queryFn: () => api.skillSyncState() },
    client,
  );
}
