/** @jsxImportSource octane */

import { createFileRoute, useNavigate, useParams } from "@octanejs/tanstack-router";
import { WorkspaceContextSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useEffect, useRef, useState } from "octane";
import { api } from "../../../core/api";
import { localizeMessage, tr } from "../../../core/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  ChevronDown,
  CircleAlert,
  FileCode2,
  FolderOpen,
  RefreshCw,
  SlidersHorizontal,
} from "@octanejs/lucide";
import type { AgentKind, ContextPreview } from "../../../core/types";
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};
function Pills({ values, empty }: { values: string[]; empty: string }) {
  return values.length ? (
    <div className="flex flex-wrap gap-2">
      {values.map((value: any) => (
        <Badge key={value} variant="outline" className="bg-background text-xs">
          {value}
        </Badge>
      ))}
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <CircleAlert size={14} />
      <span>{empty}</span>
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
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(280px,.38fr)_minmax(0,1fr)]">
      <Card className="grid content-start overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-muted/20 px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <SlidersHorizontal size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{tr("context.environment")}</h2>
            </div>
          </div>
        </div>
        <div className="grid gap-4 p-4">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Agent</Label>
            <Select
              value={agent}
              onValueChange={(value: any) => {
                if (value !== null) setAgent(String(value) as AgentKind);
              }}
            >
              <SelectTrigger className="h-10 w-full" aria-label="Agent">
                <SelectValue>{agentLabels[agent]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(agentLabels).map(([value, label]) => (
                  <SelectItem value={value} key={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {tr("context.workingDirectory")}
            </Label>
            <div className="relative">
              <FolderOpen
                size={15}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="h-10 pl-9"
                value={cwd}
                onChange={(event) => setCwd((event.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <Button className="h-10 w-full" onClick={() => void run()} disabled={resolving}>
            <RefreshCw size={15} className={resolving ? "animate-spin" : ""} />
            {tr("context.resolve")}
          </Button>
          <div className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <Bot size={16} className="text-muted-foreground" />
              <h3 className="text-sm font-semibold">{tr("context.capabilities")}</h3>
            </div>
            <div className="grid gap-2">
              <Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} />
              <Pills
                values={preview?.visible_connections ?? []}
                empty={tr("context.noConnection")}
              />
            </div>
          </div>
        </div>
      </Card>
      <Card className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/20 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <FileCode2 size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{tr("context.effective")}</h2>
            </div>
          </div>
          {preview && (
            <Badge variant="outline" className="mt-0.5 bg-background">
              {preview.sections.length} {tr("common.sections")}
            </Badge>
          )}
        </div>
        {error && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {preview?.warnings.map((warning) => (
          <div
            className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700"
            key={warning}
          >
            <CircleAlert size={15} />
            {contextWarningLabel(warning)}
          </div>
        ))}
        {empty && (
          <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            <FileCode2 size={18} />
            <span className="flex-1">{tr("context.noInstructions")}</span>
            <Button variant="outline" onClick={onOpenInstructions}>
              {tr("context.openInstructions")}
            </Button>
          </div>
        )}
        <div className="grid gap-3 p-4">
          {preview?.sections.map((contextSection, index) => (
            <article
              className="rounded-xl border border-border bg-muted/15 p-3 transition-colors hover:bg-muted/30"
              key={`${contextSection.source}-${index}`}
            >
              <div className="flex items-start gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <strong className="min-w-0 truncate text-sm">
                      {shortPath(contextSection.source)}
                    </strong>
                    <Badge variant="outline" className="bg-background text-[11px]">
                      {contextSection.scope || tr("status.scope.project")}
                    </Badge>
                  </header>
                  <Collapsible>
                    <CollapsibleTrigger className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                      {tr("context.showContent")}
                      <ChevronDown size={14} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                        {contextSection.content}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </div>
            </article>
          ))}
        </div>
        {preview?.approved_memories.length ? (
          <div className="grid gap-2 border-t border-border bg-muted/10 p-4 text-sm">
            <h3>{tr("context.approvedMemory")}</h3>
            {preview.approved_memories.map((item) => (
              <p
                className="rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground"
                key={item}
              >
                {item}
              </p>
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
