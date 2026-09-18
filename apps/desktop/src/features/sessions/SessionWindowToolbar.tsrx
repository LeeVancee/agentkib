/** @jsxImportSource octane */

import { useNavigate } from "@octanejs/tanstack-router";
import { ArrowLeft, ArrowUpRight, MoreHorizontal, RefreshCw } from "@octanejs/lucide";
import { Button } from "@/components/ui/button.tsrx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsrx";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon.tsrx";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionHub } from "./SessionHubContext.tsrx";

export function SessionWindowToolbar() {
  const { tr } = useI18n();
  const hub = useSessionHub();
  const navigate = useNavigate();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  if (!selected)
    return (
      <div className="app-toolbar-content">
        <div className="app-toolbar-breadcrumb" aria-label={tr("common.breadcrumb")}>
          {tr("sessions.nav")}
        </div>
      </div>
    );
  const canContinue =
    workspace &&
    !selected.remote &&
    selected.availability === "readable" &&
    canContinueFromHistory(selected.agent);
  const continueSession = () => {
    if (!canContinue) return;
    void navigate({
      to: "/workspace/$workspaceId/sessions",
      params: { workspaceId: workspace.id },
      search: { sessionId: selected.id },
    });
  };
  return (
    <div className="app-toolbar-content session-window-toolbar">
      <Button
        variant="ghost"
        size="icon"
        aria-label={tr("sessions.backOverview")}
        onClick={() => hub.select()}
      >
        <ArrowLeft size={17} />
      </Button>
      <AgentIcon agent={selected.agent} compact />
      <h1 className="session-window-title" title={displaySessionTitle(selected.title, tr)}>
        {displaySessionTitle(selected.title, tr)}
      </h1>
      <div className="session-window-actions">
        {canContinue && (
          <Button variant="ghost" size="sm" onClick={continueSession}>
            <ArrowUpRight size={15} />
            {tr("sessions.continueWorkspace")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={hub.refreshing}
          onClick={() => void hub.refresh()}
        >
          <RefreshCw size={15} className={hub.refreshing ? "animate-spin" : ""} />
          {tr("sessions.refresh")}
        </Button>
      </div>
      <div className="session-window-menu">
        <DropdownMenu>
          <DropdownMenuTrigger className="app-toolbar-more" aria-label={tr("common.moreActions")}>
            <MoreHorizontal size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {canContinue && (
              <DropdownMenuItem onClick={continueSession}>
                <ArrowUpRight size={15} />
                {tr("sessions.continueWorkspace")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={hub.refreshing} onClick={() => void hub.refresh()}>
              <RefreshCw size={15} />
              {tr("sessions.refresh")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
