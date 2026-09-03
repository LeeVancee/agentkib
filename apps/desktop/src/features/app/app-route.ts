import type { AssetSection } from "@/features/home/GlobalHome";
import type { GitSubview } from "@/features/workspace/WorkspaceGitPage";
import type { SettingsSection, SettingsTarget } from "@/features/settings/SettingsSidebar";
import type { AgentKind } from "@/core/types";
import type { AgentFilter } from "@/components/AppSidebar";

export type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
export type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";

export type AppSearch = {
  assetSection?: AssetSection;
  settingsSection?: SettingsSection;
  settingsTarget?: SettingsTarget;
  quotaProvider?: string;
  quotaWindow?: import("@/core/types").QuotaWindowSelector;
  gitSubview?: GitSubview;
  doctorVerification?: "applied";
  agent?: AgentKind;
  agentFilter?: AgentFilter;
};

export type ParsedRoute =
  | { kind: "settings" }
  | { kind: "global"; page: GlobalPage }
  | { kind: "workspace"; workspaceId: string; page: Page };

export function workspaceSearchForPage(current: AppSearch, page: Page): AppSearch {
  return page === "git" ? current : { ...current, gitSubview: undefined };
}

export function parseRoute(pathname: string): ParsedRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "settings") return { kind: "settings" };
  if (segments[0] === "workspace" && segments[1]) {
    const page = segments[2];
    const workspacePage: Page =
      page === "sessions" ||
      page === "git" ||
      page === "assets" ||
      page === "context" ||
      page === "doctor" ||
      page === "changes"
        ? page
        : "overview";
    return { kind: "workspace", workspaceId: segments[1], page: workspacePage };
  }
  const page = segments[0];
  const globalPage: GlobalPage =
    page === "workspaces" ||
    page === "catalog" ||
    page === "agents" ||
    page === "quota" ||
    page === "insights"
      ? page
      : "home";
  return { kind: "global", page: globalPage };
}
