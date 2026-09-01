import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Copy, FileOutput, ShieldCheck, X } from "lucide-react";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  ConversationSessionSummary,
  HandoffFormat,
  PlannedSessionHandoff,
  SessionHandoffDraft,
  SessionHandoffRequest,
  WorkspaceSummary,
} from "@/core/types";

const targets: Array<[AgentKind, string]> = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["cursor", "Cursor"],
  ["open-claw", "OpenClaw"],
  ["hermes", "Hermes"],
  ["deepseek-harness", "DeepSeek Harness"],
];

export function SessionHandoffDialog({
  workspace,
  session,
  targetAgents,
  onClose,
  onPlanned,
}: {
  workspace: WorkspaceSummary;
  session: ConversationSessionSummary;
  targetAgents: AgentKind[];
  onClose: () => void;
  onPlanned: (handoff: PlannedSessionHandoff) => void;
}) {
  const availableTargets = useMemo(
    () => targets.filter(([agent]) => agent === session.agent || targetAgents.includes(agent)),
    [session.agent, targetAgents],
  );
  const defaultTarget =
    availableTargets.find(([agent]) => agent !== session.agent)?.[0] ??
    availableTargets[0]?.[0] ??
    session.agent;
  const [targetAgent, setTargetAgent] = useState<AgentKind>(defaultTarget);
  const [format, setFormat] = useState<HandoffFormat>("markdown");
  const [historyBudget, setHistoryBudget] = useState(120_000);
  const [draft, setDraft] = useState<SessionHandoffDraft>();
  const [content, setContent] = useState("");
  const [acceptLosses, setAcceptLosses] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const identityRef = useRef({ workspaceId: workspace.id, sessionId: session.id });

  useEffect(() => {
    identityRef.current = { workspaceId: workspace.id, sessionId: session.id };
  }, [session.id, workspace.id]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const captureIdentity = () => ({
    workspaceId: workspace.id,
    sessionId: session.id,
    generation: ++requestGenerationRef.current,
  });
  const isLatest = (identity: { generation: number }) =>
    activeRef.current && requestGenerationRef.current === identity.generation;
  const isCurrent = (identity: { workspaceId: string; sessionId: string; generation: number }) =>
    isLatest(identity) &&
    identityRef.current.workspaceId === identity.workspaceId &&
    identityRef.current.sessionId === identity.sessionId;

  const request = (): SessionHandoffRequest => ({
    session_id: session.id,
    target_agent: targetAgent,
    format,
    history_budget_tokens: historyBudget,
  });

  const showDraft = (nextDraft: SessionHandoffDraft) => {
    setDraft(nextDraft);
    setContent(nextDraft.content);
    setAcceptLosses(nextDraft.losses.length === 0);
  };

  const prepare = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const preparation = await api.prepareSessionHandoff(request());
      if (!isCurrent(identity)) return;
      showDraft(preparation.draft);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const plan = async () => {
    if (!draft) return;
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const planned = await api.planSessionHandoff(
        session.id,
        workspace.id,
        draft.filename,
        draft.format,
        draft.mode === "handoff-file" && draft.window_strategy === "full" ? content : undefined,
        targetAgent,
        draft.mode,
        draft.source_fingerprint,
        acceptLosses,
        draft.history_budget_tokens,
        draft.archive_id,
      );
      if (isCurrent(identity)) onPlanned(planned);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const copy = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const sanitized = await api.sanitizeSessionHandoff(format, content);
      if (!isCurrent(identity)) return;
      await navigator.clipboard?.writeText(sanitized);
      if (!isCurrent(identity)) return;
      setCopied(true);
      window.setTimeout(() => {
        if (activeRef.current) setCopied(false);
      }, 1200);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const reset = () => {
    requestGenerationRef.current += 1;
    setDraft(undefined);
    setAcceptLosses(false);
    setError("");
  };

  const close = () => {
    activeRef.current = false;
    requestGenerationRef.current += 1;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="w-[min(660px,calc(100vw-2rem))] max-h-[min(820px,calc(100vh-2rem))] gap-0 overflow-hidden p-0 shadow-2xl"
        showCloseButton={false}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-[18px]">
          <div>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
              Session Continuation
            </span>
            <DialogTitle className="mt-0 text-xl">{tr("handoff.title")}</DialogTitle>
            <p className="m-0 mt-1 text-xs text-muted-foreground">{tr("handoff.description")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={close} aria-label={tr("common.close")}>
            <X size={17} />
          </Button>
        </header>
        {error && (
          <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <CircleAlert size={15} />
            {error}
          </div>
        )}
        {draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-5 py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="shrink-0 text-green-600" size={16} />
              <span>{tr("handoff.redacted", { count: draft.redaction_count })}</span>
              <code className="ml-auto max-w-[55%] truncate font-mono">{draft.filename}</code>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{tr(`handoff.mode.${draft.mode}`)}</span>
              <span>
                {tr("handoff.stats", {
                  turns: draft.stats.turn_count,
                  tools: draft.stats.tool_call_count,
                  attachments: draft.stats.attachment_count,
                })}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs max-[620px]:grid-cols-1">
              <div>
                <span className="block text-muted-foreground">{tr("handoff.window.total")}</span>
                <strong>{formatEstimatedTokens(draft.window_stats.estimated_total_tokens)}</strong>
              </div>
              <div>
                <span className="block text-muted-foreground">{tr("handoff.window.active")}</span>
                <strong>{formatEstimatedTokens(draft.window_stats.estimated_active_tokens)}</strong>
              </div>
              <div>
                <span className="block text-muted-foreground">{tr("handoff.window.deferred")}</span>
                <strong>
                  {formatEstimatedTokens(draft.window_stats.estimated_deferred_tokens)}
                </strong>
              </div>
            </div>
            {draft.window_strategy === "windowed" && (
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                  draft.mcp_available
                    ? "border-blue-500/25 bg-blue-500/5 text-foreground"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
                }`}
              >
                <CircleAlert className="mt-0.5 shrink-0" size={14} />
                {tr(
                  draft.mcp_available
                    ? "handoff.window.archiveReady"
                    : "handoff.window.mcpRequired",
                  {
                    turns: draft.window_stats.deferred_turn_count,
                    blocks: draft.window_stats.deferred_block_count,
                  },
                )}
              </div>
            )}
            {draft.native_capability.reason && (
              <p className="m-0 text-xs text-muted-foreground">
                {tr(`handoff.capabilityReason.${draft.native_capability.reason}`)}
              </p>
            )}
            {draft.losses.map((loss) => (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700"
                key={loss.code}
              >
                <CircleAlert size={14} />
                {tr(`handoff.loss.${loss.code}`, { count: loss.count })}
              </div>
            ))}
            {draft.losses.length > 0 && (
              <Label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <Checkbox
                  checked={acceptLosses}
                  onCheckedChange={(checked) => setAcceptLosses(checked === true)}
                />
                {tr("handoff.acceptLosses")}
              </Label>
            )}
            <Textarea
              className="min-h-[320px] flex-1 resize-none font-mono text-xs leading-relaxed"
              aria-label={tr("handoff.preview")}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              readOnly={draft.mode === "native-session" || draft.window_strategy === "windowed"}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
            <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
              <Label className="col-span-full grid gap-1.5 text-xs text-muted-foreground">
                {tr("handoff.target")}
                <SelectControl
                  aria-label={tr("handoff.target")}
                  value={targetAgent}
                  disabled={busy}
                  onChange={(event) => setTargetAgent(event.target.value as AgentKind)}
                >
                  {availableTargets.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </SelectControl>
              </Label>
              <Label className="col-span-full grid gap-1.5 text-xs text-muted-foreground">
                {tr("handoff.historyBudget")}
                <SelectControl
                  aria-label={tr("handoff.historyBudget")}
                  value={String(historyBudget)}
                  disabled={busy}
                  onChange={(event) => setHistoryBudget(Number(event.target.value))}
                >
                  <option value="64000">64k</option>
                  <option value="120000">120k · {tr("handoff.recommended")}</option>
                  <option value="180000">180k</option>
                </SelectControl>
                <span>{tr("handoff.historyBudgetDetail")}</span>
              </Label>
              <div className="col-span-full flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-green-600" size={16} />
                <div className="grid gap-1">
                  <strong className="text-sm">{tr("handoff.localParser")}</strong>
                  <span className="text-xs text-muted-foreground">
                    {tr("handoff.localParserDetail")}
                  </span>
                </div>
              </div>
              <Collapsible className="col-span-full">
                <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent text-xs text-muted-foreground">
                  {tr("handoff.advanced")}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2.5">
                  <Label className="grid max-w-[280px] gap-1.5 text-xs text-muted-foreground">
                    {tr("handoff.format")}
                    <SelectControl
                      aria-label={tr("handoff.format")}
                      value={format}
                      disabled={busy}
                      onChange={(event) => setFormat(event.target.value as HandoffFormat)}
                    >
                      <option value="markdown">Markdown</option>
                      <option value="json">JSON</option>
                    </SelectControl>
                  </Label>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        )}
        <footer className="flex min-h-16 items-center justify-end gap-2 border-t border-border px-5 py-3">
          {draft ? (
            <>
              <Button variant="outline" disabled={busy} onClick={reset}>
                {tr("common.back")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void copy()}>
                <Copy size={14} />
                {tr(copied ? "handoff.copied" : "handoff.copy")}
              </Button>
              <Button
                disabled={
                  busy ||
                  !acceptLosses ||
                  (draft.window_strategy === "windowed" && !draft.mcp_available)
                }
                onClick={() => void plan()}
              >
                <FileOutput size={14} />
                {tr("handoff.reviewSave")}
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => void prepare()}>
              <FileOutput size={14} />
              {tr(busy ? "common.loading" : "handoff.prepare")}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function formatEstimatedTokens(value: number) {
  return `≈${Math.round(value / 1000)}k Token`;
}
