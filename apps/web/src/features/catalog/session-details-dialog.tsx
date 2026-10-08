import { agentName } from "@agentkib/agent-identity";
import { Dialog } from "@/components/dialog";
import { useSession } from "@/features/sessions/session-context";
import { useEffect, useState } from "octane";

type NativeContext = {
  available: boolean;
  cwd?: string;
  projectId?: string | null;
  branchAtCreation?: string | null;
};
export function SessionDetailsDialog() {
  const {
    t,
    c,
    setModal,
    current,
    currentWorkspace,
    formatCatalogTime,
    sourceTitle,
    online,
    liveText,
    client,
    access,
  } = useSession();
  const [context, setContext] = useState<{ key: string; value?: NativeContext }>();
  const isCodex = current?.agent === "codex";
  const contextKey = `${access?.device?.id ?? ""}:${current?.id ?? ""}`;
  useEffect(() => {
    if (!isCodex || !current?.id || access?.status !== "approved") return;
    const abort = new AbortController();
    const key = `${access.device?.id ?? ""}:${current.id}`;
    setContext({ key });
    void client
      .request<NativeContext>(
        `managed/context?sessionId=${encodeURIComponent(current.id)}`,
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setContext({ key, value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setContext({ key, value: { available: false } });
      });
    return () => abort.abort();
  }, [client, current?.id, isCodex, access?.status, access?.device?.id]);
  const nativeContext = context?.key === contextKey ? context.value : undefined;
  const nativeValue = (value?: string | null) =>
    !nativeContext
      ? c.contextLoading
      : nativeContext.available
        ? value || c.unknown
        : c.contextUnavailable;
  return (
    <Dialog closeLabel={t.close} title={t.metadata} onClose={() => setModal(undefined)}>
      <dl>
        <dt>{t.agent}</dt>
        <dd>{agentName(current?.agent)}</dd>
        <dt>{c.project}</dt>
        <dd>{currentWorkspace?.name || c.missing}</dd>
        <dt>{c.path}</dt>
        <dd>{currentWorkspace?.path || c.unknown}</dd>
        <dt>{c.updated}</dt>
        <dd>{formatCatalogTime(current?.updated_at)}</dd>
        <dt>{c.created}</dt>
        <dd>{formatCatalogTime(current?.created_at)}</dd>
        {isCodex ? (
          <>
            <dt>{c.executionDirectory}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.cwd)}</dd>
            <dt>{c.codexProjectId}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.projectId)}</dd>
            <dt>{c.branchAtCreation}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.branchAtCreation)}</dd>
          </>
        ) : (
          <>
            <dt>{c.branch}</dt>
            <dd>{current?.git_branch || c.unknown}</dd>
          </>
        )}
        <dt>{c.source}</dt>
        <dd>
          {current?.origin === "auxiliary"
            ? c.auxiliarySource
            : current?.origin === "interactive"
              ? c.interactive
              : c.unknown}
        </dd>
        {current?.forked_from_session_id && (
          <>
            <dt>{c.fork}</dt>
            <dd>{sourceTitle(current.forked_from_session_id)}</dd>
          </>
        )}
        {current?.spawned_by_session_id && (
          <>
            <dt>{c.spawned}</dt>
            <dd>{sourceTitle(current.spawned_by_session_id)}</dd>
          </>
        )}
        <dt>{t.workspaceId}</dt>
        <dd>{current?.workspace_id}</dd>
        <dt>{t.sessionId}</dt>
        <dd>{current?.id}</dd>
        <dt>{t.status}</dt>
        <dd>{online ? liveText : t.unknown}</dd>
      </dl>
      {isCodex && <p>{c.codexContextNote}</p>}
      <p>{t.scope}</p>
    </Dialog>
  );
}
