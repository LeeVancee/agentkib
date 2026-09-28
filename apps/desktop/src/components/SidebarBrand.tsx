import { useAppStore } from "@/stores/app-store";

export function SidebarBrand() {
  const appName = useAppStore((state) => state.runtime?.app_name ?? "AgentKib");
  return (
    <div className="sidebar-brand inline-flex w-fit items-center gap-2.5 rounded-[0.625rem] p-1 text-foreground text-[0.9375rem] font-[650] tracking-[-0.02em]">
      <span className="sidebar-brand-label whitespace-nowrap">{appName}</span>
    </div>
  );
}
