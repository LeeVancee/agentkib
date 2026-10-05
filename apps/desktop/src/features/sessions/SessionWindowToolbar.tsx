import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionHub } from "./SessionHubContext";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { useSessionViewStore } from "./session-view-store";

export function SessionWindowToolbar() {
  const { tr } = useI18n();
  const hub = useSessionHub();
  const navigate = useNavigate();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const createConversation = () => {
    useSessionViewStore.getState().setCreatingConversation(true);
    hub.select();
  };
  if (!selected)
    return (
      <div className="app-toolbar-content">
        <div className="app-toolbar-breadcrumb" aria-label={tr("common.breadcrumb")}>
          {tr(creating ? "sessions.newConversation" : "sessions.nav")}
        </div>
        {hasDesktopConversation() && hub.localEnabled && (
          <Button variant="ghost" size="sm" onClick={createConversation}>
            <Plus size={15} />
            {tr("sessions.newConversation")}
          </Button>
        )}
      </div>
    );
  const historyId = selected.indexedSessionIds ? selected.indexedSessionIds[0] : selected.id;
  const canContinue =
    historyId &&
    workspace &&
    !selected.remote &&
    selected.availability === "readable" &&
    canContinueFromHistory(selected.agent);
  const continueSession = () => {
    if (!canContinue) return;
    void navigate({
      to: "/workspace/$workspaceId/sessions",
      params: { workspaceId: workspace.id },
      search: { sessionId: historyId },
    });
  };
  return (
    <div className="app-toolbar-content session-window-toolbar">
      <Button
        variant="ghost"
        size="icon"
        aria-label={tr("sessions.backOverview")}
        onClick={() => {
          useSessionViewStore.getState().setCreatingConversation(false);
          hub.select();
        }}
      >
        <ArrowLeft size={17} />
      </Button>
      <AgentIcon agent={selected.agent} compact />
      <h1 className="session-window-title" title={displaySessionTitle(selected.title, tr)}>
        {displaySessionTitle(selected.title, tr)}
      </h1>
      <div className="session-window-actions">
        {hasDesktopConversation() && hub.localEnabled && (
          <Button variant="ghost" size="sm" onClick={createConversation}>
            <Plus size={15} />
            {tr("sessions.newConversation")}
          </Button>
        )}
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
            {hasDesktopConversation() && hub.localEnabled && (
              <DropdownMenuItem onClick={createConversation}>
                <Plus size={15} />
                {tr("sessions.newConversation")}
              </DropdownMenuItem>
            )}
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
