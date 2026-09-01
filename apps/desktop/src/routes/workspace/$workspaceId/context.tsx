import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { WorkspaceContextSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../core/api";
import { localizeMessage, tr } from "../../../core/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SelectControl } from "@/components/ui/select-control";
import { CircleAlert, FileCode2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentKind, ContextPreview } from "../../../core/types";
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "deepseek-harness": "DeepSeek Harness",
};
function Pills({ values, empty }: { values: string[]; empty: string }) {
  return (
    <div className="grid gap-4">
      {values.length ? (
        values.map((value) => <span key={value}>{value}</span>)
      ) : (
        <small>{empty}</small>
      )}
    </div>
  );
}
function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}
function ContextPage({
  project,
  onOpenInstructions,
}: {
  project: string;
  onOpenInstructions: () => void;
}) {
  const [agent, setAgent] = useState<AgentKind>("codex");
  const [cwd, setCwd] = useState(project);
  const [preview, setPreview] = useState<ContextPreview>();
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);
  const requestSequence = useRef(0);
  const run = async () => {
    const sequence = ++requestSequence.current;
    setResolving(true);
    setError("");
    try {
      const next = await api.context(project, cwd, agent);
      if (sequence === requestSequence.current) setPreview(next);
    } catch (value) {
      if (sequence === requestSequence.current) setError(localizeMessage(value));
    } finally {
      if (sequence === requestSequence.current) setResolving(false);
    }
  };
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void run();
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [project, cwd, agent]);
  const empty = preview && !preview.sections.length;
  if (resolving && !preview) return <WorkspaceContextSkeleton />;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,.35fr)_minmax(0,1fr)]">
      <Card className="rounded-xl border border-border bg-card shadow-sm grid content-start gap-4 p-4">
        <h2>{tr("context.environment")}</h2>
        <Label>
          Agent
          <SelectControl
            value={agent}
            onChange={(event) => setAgent(event.target.value as AgentKind)}
          >
            {Object.entries(agentLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </SelectControl>
        </Label>
        <Label>
          {tr("context.workingDirectory")}
          <Input value={cwd} onChange={(event) => setCwd(event.target.value)} />
        </Label>
        <Button
          className="border border-transparent bg-transparent text-foreground hover:bg-muted"
          onClick={() => void run()}
          disabled={resolving}
        >
          <RefreshCw size={14} className={resolving ? "animate-spin" : ""} />
          {tr("context.resolve")}
        </Button>
        <Separator />
        <h3>{tr("context.capabilities")}</h3>
        <Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} />
        <Pills values={preview?.visible_connections ?? []} empty={tr("context.noConnection")} />
      </Card>
      <Card className="rounded-xl border border-border bg-card shadow-sm min-w-0">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
          <h2>{tr("context.effective")}</h2>
          {preview && (
            <Badge variant="outline">
              {preview.sections.length} {tr("common.sections")}
            </Badge>
          )}
        </div>
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {preview?.warnings.map((warning) => (
          <div
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700"
            key={warning}
          >
            <CircleAlert size={15} />
            {contextWarningLabel(warning)}
          </div>
        ))}
        {empty && (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <FileCode2 size={18} />
            <span>{tr("context.noInstructions")}</span>
            <Button
              className="border border-transparent bg-transparent text-foreground hover:bg-muted"
              onClick={onOpenInstructions}
            >
              {tr("context.openInstructions")}
            </Button>
          </div>
        )}
        <div className="grid gap-3 p-4">
          {preview?.sections.map((contextSection, index) => (
            <article key={`${contextSection.source}-${index}`}>
              <span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {index + 1}
              </span>
              <div>
                <header>
                  <strong>{shortPath(contextSection.source)}</strong>
                  <span>{contextSection.scope || tr("status.scope.project")}</span>
                </header>
                <Collapsible>
                  <CollapsibleTrigger>{tr("context.showContent")}</CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre>{contextSection.content}</pre>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </article>
          ))}
        </div>
        {preview?.approved_memories.length ? (
          <div className="grid gap-2 border-t border-border p-4 text-sm">
            <h3>{tr("context.approvedMemory")}</h3>
            {preview.approved_memories.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function contextWarningLabel(warning: string) {
  if (
    warning ===
    "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules"
  )
    return tr("context.deepseekCustomRules");
  if (
    warning ===
    "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import"
  )
    return tr("context.deepseekClaudeImport");
  return warning;
}

function WorkspaceContextRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/context" });
  const { project } = useWorkspaceStore();
  if (!project) return <WorkspaceContextSkeleton />;
  return (
    <ContextPage
      project={project}
      onOpenInstructions={() =>
        void navigate({
          to: "/workspace/$workspaceId/assets",
          params: { workspaceId },
          search: { workspaceAssetSection: "instructions" } as never,
        })
      }
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/context")({
  component: WorkspaceContextRoute,
});
