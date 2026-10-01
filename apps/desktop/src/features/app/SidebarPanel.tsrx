import { createContext, useContext, useState, type ReactNode } from "octane";
import { createPortal } from "octane";

const SidebarPanelContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (element: HTMLDivElement | null) => void;
} | null>(null);

// Route content owns its data and actions; the shell owns where navigation appears.
export function SidebarPanelProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <SidebarPanelContext value={{ target, setTarget }}>
      {children}
    </SidebarPanelContext>
  );
}

export function SidebarPanelTarget() {
  const context = useContext(SidebarPanelContext);
  return <div className="sidebar-panel-slot" ref={context?.setTarget} />;
}

export function SidebarPanel({ children }: { children: ReactNode }) {
  const context = useContext(SidebarPanelContext);
  if (!context) return children;
  return context.target ? createPortal(children, context.target) : null;
}
