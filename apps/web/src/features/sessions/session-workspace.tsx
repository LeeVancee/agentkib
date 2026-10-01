import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  MoreHorizontal,
  Settings2,
  RefreshCw,
  LogOut,
  Monitor,
} from "lucide-react";
import { SessionCatalog } from "@/features/catalog/session-catalog";
import { Button } from "@/components/ui/button";
import { useSession } from "./session-context";
import { ManagedTasks } from "./managed-tasks";
import { PendingCenter } from "./pending-center";
import { SessionPanelsContext } from "./session-panels";
import { sessionDisplayState } from "./session-display-state";
import { webLayoutCopy } from "./web-layout-copy";
import { cn } from "@/lib/utils";

export function SessionWorkspace() {
  const session = useSession();
  const {
    t,
    access,
    refresh,
    post,
    pendingSessions,
    sessions,
    workspaces,
    selected,
    choose,
    locale,
    indexEnabled,
    currentTitle,
    currentWorkspace,
    leaveSession,
    setModal,
  } = session;
  const navigate = useNavigate();
  const reading = useLocation({
    select: (location) =>
      location.pathname.startsWith("/sessions/") && location.pathname !== "/sessions/",
  });
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    setFilesOpen(false);
    setActionsOpen(false);
  }, [selected]);
  useEffect(() => {
    if (!session.modal) return;
    // An incoming approval must not compete with the fullscreen file panel's
    // focus trap. Keep the existing global dialog as the sole modal surface.
    setFilesOpen(false);
    setActionsOpen(false);
  }, [session.modal]);
  const copy = webLayoutCopy[locale];
  const status = sessionDisplayState(session);
  return (
    <SessionPanelsContext
      value={{
        filesOpen: filesOpen && !session.modal,
        setFilesOpen,
        actionsOpen: actionsOpen && !session.modal,
        setActionsOpen,
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center border-b">
          <div
            className={cn(
              "items-center gap-3 px-4 md:flex md:w-[280px] md:shrink-0 md:border-r",
              reading ? "hidden" : "flex flex-1 md:flex-none",
            )}
          >
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-xl bg-foreground font-bold text-background"
            >
              K
            </span>
            <strong className="flex-1 text-sm">AgentKib</strong>
            <Button
              variant="ghost"
              className="hidden size-11 p-0 md:inline-flex"
              aria-label={t.preferences}
              onClick={() => setModal("preferences")}
            >
              <Settings2 />
            </Button>
          </div>
          {reading && (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-2 md:px-5">
              <Button
                variant="ghost"
                className="size-11 p-0 md:hidden"
                aria-label={t.back}
                onClick={() => {
                  leaveSession();
                  void navigate({ to: "/sessions" });
                }}
              >
                <ArrowLeft />
              </Button>
              <div className="min-w-0 flex-1 py-2">
                <h1 className="truncate text-sm font-semibold" title={currentTitle}>
                  {currentTitle}
                </h1>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="max-w-[45%] truncate md:max-w-40" title={currentWorkspace?.path}>
                    {currentWorkspace?.name}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span
                    role="status"
                    className={cn(
                      "truncate",
                      status.tone === "warning" && "text-amber-700 dark:text-amber-300",
                    )}
                  >
                    {status.label}
                  </span>
                </div>
              </div>
            </div>
          )}
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 pr-2 md:gap-2 md:pr-5",
              !reading && "md:ml-auto",
            )}
          >
            <PendingCenter compact />
            {reading ? (
              <>
                {access?.device?.files && (
                  <Button
                    variant={filesOpen ? "secondary" : "ghost"}
                    className="size-11 p-0 md:w-auto md:px-3"
                    aria-label={copy.files}
                    aria-expanded={filesOpen}
                    onClick={() => setFilesOpen(!filesOpen)}
                  >
                    <FolderOpen />
                    <span className="hidden lg:inline">{copy.files}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="size-11 p-0 md:w-auto md:px-3"
                  data-dialog-return-focus="true"
                  aria-label={copy.actions}
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen(true)}
                >
                  <MoreHorizontal />
                  <span className="hidden lg:inline">{copy.actions}</span>
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="size-11 p-0 md:hidden"
                aria-label={t.preferences}
                onClick={() => setModal("preferences")}
              >
                <Settings2 />
              </Button>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex min-h-0 w-full shrink-0 flex-col border-r bg-sidebar md:w-[280px]",
              reading && "hidden md:flex",
            )}
          >
            <header className="flex items-center justify-between px-5 pb-4 pt-6">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold">{t.sessions}</h1>
                <span className="rounded-md bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {sessions.length}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t.refresh}
                onClick={() => void refresh(true)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </header>
            <ManagedTasks create />
            <SessionCatalog
              pendingSessions={pendingSessions}
              sessions={sessions}
              workspaces={workspaces}
              selected={selected}
              onSelect={(id) => {
                void choose(id);
                void navigate({
                  to: "/sessions/$sessionId",
                  params: { sessionId: id },
                  resetScroll: false,
                });
              }}
              locale={locale}
              indexEnabled={indexEnabled}
            />
            <footer className="flex items-center gap-3 border-t p-4">
              <span className="grid size-9 place-items-center rounded-lg border bg-background">
                <Monitor className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">{t.device}</div>
                <div className="truncate text-xs font-medium">{access?.device?.name}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.logout}
                onClick={() => void post("logout", {})}
              >
                <LogOut className="size-4" />
              </Button>
            </footer>
          </aside>
          <main
            className={cn(
              "min-w-0 flex-1 flex-col bg-background",
              reading ? "flex" : "hidden md:flex",
            )}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </SessionPanelsContext>
  );
}
