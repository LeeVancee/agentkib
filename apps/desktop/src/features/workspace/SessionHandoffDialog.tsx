import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Copy, FileOutput, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  ConversationSessionSummary,
  HandoffFormat,
  PlannedSessionHandoff,
  SessionHandoffDraft,
  SessionHandoffPreparation,
  SessionHandoffRequest,
  WorkspaceSummary,
} from "@/core/types";
import { sessionHandoffTargets } from "./session-handoff-targets";

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
    () =>
      sessionHandoffTargets.filter(
        ([agent]) => agent === session.agent || targetAgents.includes(agent),
      ),
    [session.agent, targetAgents],
  );
  const defaultTarget =
    availableTargets.find(([agent]) => agent !== session.agent)?.[0] ??
    availableTargets[0]?.[0] ??
    session.agent;
  const [targetAgent, setTargetAgent] = useState<AgentKind>(defaultTarget);
  const [format, setFormat] = useState<HandoffFormat>("markdown");
  const [draft, setDraft] = useState<SessionHandoffDraft>();
  const [summaryRequired, setSummaryRequired] =
    useState<Extract<SessionHandoffPreparation, { status: "summary-required" }>>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const identityRef = useRef({ workspaceId: workspace.id, sessionId: session.id });
  identityRef.current = { workspaceId: workspace.id, sessionId: session.id };

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
  });

  const showDraft = (nextDraft: SessionHandoffDraft) => {
    setSummaryRequired(undefined);
    setDraft(nextDraft);
    setContent(nextDraft.content);
  };

  const prepare = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const preparation = await api.prepareSessionHandoff(request());
      if (!isCurrent(identity)) return;
      if (preparation.status === "ready") showDraft(preparation.draft);
      else setSummaryRequired(preparation);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) setBusy(false);
    }
  };

  const summarize = async () => {
    const identity = captureIdentity();
    setBusy(true);
    setSummarizing(true);
    setError("");
    try {
      const nextDraft = await api.summarizeSessionHandoff(request());
      if (isCurrent(identity)) showDraft(nextDraft);
    } catch (reason) {
      if (isCurrent(identity)) setError(localizeMessage(reason));
    } finally {
      if (isLatest(identity)) {
        setBusy(false);
        setSummarizing(false);
      }
    }
  };

  const plan = async () => {
    if (!draft) return;
    const identity = captureIdentity();
    setBusy(true);
    setError("");
    try {
      const planned = await api.planSessionHandoff(
        workspace.id,
        draft.filename,
        draft.format,
        content,
        targetAgent,
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
    setSummaryRequired(undefined);
    setError("");
  };

  const sourceAgentName = agentName(summaryRequired?.source_agent ?? session.agent);
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
              Session Handoff
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
            <div className="text-xs text-muted-foreground">
              {tr(`handoff.context.${draft.context_source}`, {
                count: draft.included_message_count,
                tools: draft.omitted_tool_count,
              })}
            </div>
            {draft.warnings.map((warning) => (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700"
                key={warning}
              >
                <CircleAlert size={14} />
                {tr(`handoff.warning.${warning}`)}
              </div>
            ))}
            <Textarea
              className="min-h-[320px] flex-1 resize-none font-mono text-xs leading-relaxed"
              aria-label={tr("handoff.preview")}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          </div>
        ) : summaryRequired ? (
          <div className="grid min-h-[280px] flex-1 grid-cols-[auto_1fr] content-center gap-3.5 px-6 py-7">
            <div className="grid size-[42px] place-items-center rounded-xl border border-border bg-muted text-primary">
              <Sparkles size={22} />
            </div>
            <div>
              <h3 className="m-0 text-base font-semibold">{tr("handoff.summaryRequired")}</h3>
              <p className="m-0 mt-1 text-sm leading-relaxed text-muted-foreground">
                {tr("handoff.summaryReason", {
                  count: summaryRequired.message_count,
                  size: formatBytes(summaryRequired.estimated_bytes),
                })}
              </p>
            </div>
            <div className="col-span-full mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
              <CircleAlert size={14} />
              {tr("handoff.summaryConsent", { agent: sourceAgentName })}
            </div>
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
              <div className="col-span-full flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-green-600" size={16} />
                <div className="grid gap-1">
                  <strong className="text-sm">{tr("handoff.autoContext")}</strong>
                  <span className="text-xs text-muted-foreground">
                    {tr("handoff.autoContextDetail")}
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
              <Button disabled={busy} onClick={() => void plan()}>
                <FileOutput size={14} />
                {tr("handoff.reviewSave")}
              </Button>
            </>
          ) : summaryRequired ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setSummaryRequired(undefined)}
              >
                {tr("common.cancel")}
              </Button>
              <Button disabled={busy} onClick={() => void summarize()}>
                <Sparkles size={14} />
                {tr(summarizing ? "handoff.summarizing" : "handoff.summarizeWith", {
                  agent: sourceAgentName,
                })}
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

function agentName(agent: AgentKind) {
  return sessionHandoffTargets.find(([value]) => value === agent)?.[1] ?? agent;
}

function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
