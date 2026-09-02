import { useAppStore } from "@/stores/app-store";

export function SidebarBrand() {
  const appName = useAppStore((state) => state.runtime?.app_name ?? "AgentKib");
  return (
    <div className="sidebar-brand">
      <span className="sidebar-brand-label">{appName}</span>
    </div>
  );
}
