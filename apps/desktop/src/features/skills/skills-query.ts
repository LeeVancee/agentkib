import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import type { InstalledSkill, RemovedSkill } from "@/core/types";
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
