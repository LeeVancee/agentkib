/** @jsxImportSource octane */

import { useMemo, useState } from "octane";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FolderGit2, Search } from "@octanejs/lucide";
import { tr } from "@/core/i18n";
import type { WorkspaceSummary } from "@/core/types";
import type { GlobalPage } from "./app-route";
import type { SidebarEntry } from "@/components/AppSidebar";

export function GlobalSearchDialog({
  open,
  onOpenChange,
  entries,
  workspaces,
  onNavigate,
  onOpenWorkspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: SidebarEntry<GlobalPage>[];
  workspaces: WorkspaceSummary[];
  onNavigate: (page: GlobalPage) => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = useMemo(
    () => entries.filter((entry) => tr(entry.label).toLowerCase().includes(normalizedQuery)),
    [entries, normalizedQuery],
  );
  const visibleWorkspaces = useMemo(
    () =>
      workspaces
        .filter((workspace) =>
          (workspace.name + " " + workspace.path).toLowerCase().includes(normalizedQuery),
        )
        .slice(0, 8),
    [normalizedQuery, workspaces],
  );
  const empty = visibleEntries.length === 0 && visibleWorkspaces.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) setQuery("");
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="top-[18%] w-[min(620px,calc(100vw-2rem))] -translate-y-0 gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{tr("search.title")}</DialogTitle>
          <DialogDescription>{tr("search.description")}</DialogDescription>
        </DialogHeader>
        <label className="flex h-14 items-center gap-3 border-b border-border px-4">
          <Search size={18} className="text-muted-foreground" />
          <Input
            autoFocus
            className="h-full border-0 px-0 text-[15px] shadow-none focus-visible:ring-0"
            value={query}
            onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder={tr("search.placeholder")}
          />
          <kbd className="rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            Esc
          </kbd>
        </label>
        <div className="max-h-[430px] overflow-y-auto p-2">
          {visibleEntries.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                {tr("search.pages")}
              </h3>
              {visibleEntries.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  variant="bare"
                  size="content"
                  className="flex min-h-11 w-full justify-start gap-3 rounded-lg px-3 text-sm hover:bg-muted"
                  onClick={() => {
                    onOpenChange(false);
                    onNavigate(id);
                  }}
                >
                  <Icon size={16} />
                  {tr(label)}
                </Button>
              ))}
            </section>
          )}
          {visibleWorkspaces.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
                {tr("nav.workspaces")}
              </h3>
              {visibleWorkspaces.map((workspace) => (
                <Button
                  key={workspace.id}
                  variant="bare"
                  size="content"
                  className="grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 text-left hover:bg-muted"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenWorkspace(workspace);
                  }}
                >
                  <FolderGit2 size={16} className="text-muted-foreground" />
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{workspace.name}</strong>
                    <small className="block truncate text-xs text-muted-foreground">
                      {workspace.path}
                    </small>
                  </span>
                </Button>
              ))}
            </section>
          )}
          {empty && (
            <p className="grid min-h-28 place-items-center text-sm text-muted-foreground">
              {tr("search.empty")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
