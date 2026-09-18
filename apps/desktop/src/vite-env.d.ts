/** @jsxImportSource octane */

/// <reference types="vite/client" />

declare module "@octanejs/markdown/src/markdown-hooks.tsrx" {
  export const MarkdownHooks: any;
}

declare module "*.tsrx" {
  const module: any;
  export = module;
  export const AppErrorFallback: any;
  export const discoveryStatusSummary: any;
  export const focusSettingsTarget: any;
  export const homeKeys: any;
  export const queryDefaults: any;
  export function useOptionalQueryClient(): import("@octanejs/tanstack-query").QueryClient;
  export type AgentFilter = any;
  export type AssetSection = any;
  export type GitSubview = any;
  export type SettingsSection = any;
  export type SettingsTarget = any;
  export type SidebarEntry<T = any> = any;
}
