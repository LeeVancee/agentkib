import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Code2, FolderOpen, SquareTerminal } from "lucide-react";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type { WorkspaceOpener, WorkspaceSummary } from "@/core/types";

export function WorkspaceOpenWith({
  workspace,
  onError,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
}) {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>([]);
  const [opening, setOpening] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const nextOpeners = await api.workspaceOpeners(workspace.id);
      if (sequence === requestSequence.current) setOpeners(nextOpeners);
    } catch (reason) {
      if (sequence === requestSequence.current) onError(localizeMessage(reason));
    }
  }, [onError, workspace.id]);

  useEffect(() => {
    setOpeners([]);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);
  const preferred = openers.find((opener) => opener.preferred) ?? openers[0];

  const openWorkspace = async (openerId?: string) => {
    if (!preferred && !openerId) return;
    setOpening(true);
    onError("");
    try {
      await api.openWorkspaceWithApp(workspace.id, openerId);
      if (openerId) await load();
    } catch (reason) {
      onError(localizeMessage(reason));
    } finally {
      setOpening(false);
    }
  };

  if (!preferred) return null;
  return (
    <div className="inline-flex h-9 max-w-full items-stretch overflow-hidden rounded-lg border border-border bg-background">
      <Button
        variant="ghost"
        className="min-w-0 max-w-40 justify-start gap-2 rounded-none border-0 px-3"
        disabled={opening}
        onClick={() => void openWorkspace()}
        title={tr("workspaceOpener.openWith", { app: preferred.name })}
      >
        <OpenerIcon category={preferred.category} />
        <span className="truncate">{preferred.name}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" className="h-9 w-8 rounded-none border-0 px-0" />
          }
          aria-label={tr("workspaceOpener.choose")}
          title={tr("workspaceOpener.choose")}
        >
          <ChevronDown size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[248px] max-h-[min(480px,calc(100vh-110px))]" align="end">
          {(["editor", "terminal", "file-manager"] as const).map((category) => {
            const values = openers.filter((opener) => opener.category === category);
            return values.length ? (
              <DropdownMenuGroup
                key={category}
                className="border-t border-border pt-1 first:border-t-0 first:pt-0"
              >
                <DropdownMenuLabel>{tr(`workspaceOpener.category.${category}`)}</DropdownMenuLabel>
                {values.map((opener) => (
                  <DropdownMenuItem
                    key={opener.id}
                    className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2"
                    onClick={() => void openWorkspace(opener.id)}
                  >
                    <OpenerIcon category={opener.category} />
                    <strong className="truncate text-sm">{opener.name}</strong>
                    {opener.preferred && (
                      <em className="text-xs not-italic text-primary">
                        {tr("workspaceOpener.default")}
                      </em>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OpenerIcon({ category }: { category: WorkspaceOpener["category"] }) {
  if (category === "terminal") return <SquareTerminal size={15} />;
  if (category === "file-manager") return <FolderOpen size={15} />;
  return <Code2 size={15} />;
}
