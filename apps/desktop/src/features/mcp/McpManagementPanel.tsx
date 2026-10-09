import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ManagedMcpServer,
  McpManagedEntry,
  McpManagementState,
} from "@agentkib/runtime-protocol";
import type { WorkspaceSummary } from "@/core/types";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { AGENT_LABELS } from "@/core/agents";
import { changeMcpTargets, MCP_MANAGED_AGENTS } from "./mcp-targets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { McpRuntimeProbe } from "./McpRuntimeProbe";
import { McpBatchConnectionPanel } from "./McpBatchConnectionPanel";
import { McpImportPanel } from "./McpImportPanel";
import { McpPolicyEditor } from "./McpPolicyEditor";
import { McpServiceEditor, newMcpDraft, type McpEditorDraft } from "./McpServiceEditor";

type BatchResult = {
  id: string;
  status: "saved" | "failed" | "skipped";
  error?: string;
  enabled: boolean;
};
export type McpEditorState = { entry?: McpManagedEntry; revision: string; draft: McpEditorDraft };
export function McpManagementPanel({
  project,
  workspaces,
  onChanged,
  drafts,
}: {
  project?: string;
  workspaces: WorkspaceSummary[];
  onChanged: () => Promise<void>;
  drafts: Map<string, McpEditorState>;
}) {
  const { tr, localizeMessage } = useI18n();
  const dialogs = useAppDialogs();
  const query = useQuery({
    queryKey: ["mcp", "management", project],
    queryFn: () => api.mcpManagementState({ project }),
    staleTime: 0,
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<McpEditorState | undefined>(() =>
    drafts.get(project ?? "global"),
  );
  const [open, setOpen] = useState<"import" | "connect" | undefined>();
  const [policy, setPolicy] = useState<string | null | undefined>();
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  useEffect(() => {
    if (editor) drafts.set(project ?? "global", editor);
    else drafts.delete(project ?? "global");
  }, [editor, drafts, project]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<BatchResult[]>([]);
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const state = query.data;
  const visible = (state?.servers ?? []).filter((entry) =>
    JSON.stringify(entry.config).toLowerCase().includes(search.toLowerCase()),
  );
  async function refresh() {
    await query.refetch();
    if (alive.current) setCatalogEpoch((value) => value + 1);
    await onChanged();
  }
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(localizeMessage(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save(entry: McpManagedEntry, patch: Partial<ManagedMcpServer>) {
    await run(async () => {
      if (!state) return;
      await api.saveMcpConfiguration({
        project,
        revision: state.revision,
        originalId: entry.config.id,
        server: { ...entry.config, ...patch } as ManagedMcpServer,
      });
      if (alive.current) await refresh();
    });
  }
  async function batch(items: { id: string; enabled: boolean }[]) {
    await run(async () => {
      const report: BatchResult[] = [];
      let latest: McpManagementState;
      try {
        latest = await api.mcpManagementState({ project });
      } catch (reason) {
        if (alive.current)
          setResults(
            items.map((item) => ({ ...item, status: "failed", error: localizeMessage(reason) })),
          );
        throw reason;
      }
      for (let index = 0; index < items.length; index++) {
        if (!alive.current) break;
        const item = items[index],
          entry = latest.servers.find((value) => value.config.id === item.id);
        if (!entry || entry.inherited) {
          report.push({ ...item, status: "skipped" });
          setResults([...report]);
          continue;
        }
        try {
          latest = await api.saveMcpConfiguration({
            project,
            revision: latest.revision,
            originalId: item.id,
            server: { ...entry.config, enabled: item.enabled },
          });
          report.push({ ...item, status: "saved" });
        } catch (reason) {
          report.push({ ...item, status: "failed", error: localizeMessage(reason) });
          try {
            latest = await api.mcpManagementState({ project });
          } catch (refreshError) {
            report.push(
              ...items.slice(index + 1).map((next) => ({
                ...next,
                status: "failed" as const,
                error: tr("mcp.manage.notAttempted"),
              })),
            );
            if (alive.current) setResults([...report]);
            throw refreshError;
          }
        }
        if (alive.current) setResults([...report]);
      }
      if (alive.current) await refresh();
    });
  }
  function target(
    entry: McpManagedEntry,
    agent: (typeof MCP_MANAGED_AGENTS)[number],
    checked: boolean,
  ) {
    const next = changeMcpTargets(entry.config.targets, agent, checked);
    if (!next) {
      setError(tr("mcp.manage.lastTarget"));
      return;
    }
    void save(entry, { targets: next });
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-48 flex-1"
          aria-label={tr("mcp.manage.search")}
          placeholder={tr("mcp.manage.search")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelected([]);
          }}
        />
        <Button
          disabled={!state || busy || !!editor}
          onClick={() => {
            setEditor({ revision: state!.revision, draft: newMcpDraft() });
            setOpen(undefined);
          }}
        >
          {tr("mcp.manage.add")}
        </Button>
        <Button variant="outline" onClick={() => setOpen(open === "import" ? undefined : "import")}>
          {tr("mcp.manage.import")}
        </Button>
        <Button
          variant="outline"
          onClick={() => setOpen(open === "connect" ? undefined : "connect")}
        >
          {tr("mcp.manage.connect")}
        </Button>
        <Button variant="outline" onClick={() => setPolicy(policy === null ? undefined : null)}>
          {tr("mcp.manage.builtins")}
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-destructive">
          {error || localizeMessage(query.error)}
        </p>
      )}
      {open === "connect" && (
        <McpBatchConnectionPanel
          workspaces={workspaces}
          project={project}
          servicesRevision={`${state?.revision}:${catalogEpoch}`}
        />
      )}
      {open === "import" && <McpImportPanel project={project} onSaved={refresh} />}
      {editor && (
        <McpServiceEditor
          key={`${editor.entry?.config.id ?? "new"}:${editor.revision}`}
          project={project}
          revision={editor.revision}
          entry={editor.entry}
          draft={editor.draft}
          onDraft={(draft) => setEditor((old) => (old ? { ...old, draft } : old))}
          onCancel={() => setEditor(undefined)}
          onSaved={async () => {
            setEditor(undefined);
            await refresh();
          }}
        />
      )}
      {policy === null && state && (
        <McpPolicyEditor
          project={project}
          serverId={null}
          revision={`${state.revision}:${catalogEpoch}`}
          onSaved={refresh}
        />
      )}
      {!!selected.length && (
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void batch(
                visible
                  .filter((entry) => selected.includes(entry.config.id))
                  .map((entry) => ({ id: entry.config.id, enabled: true })),
              )
            }
          >
            {tr("mcp.manage.enableSelected")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void batch(
                visible
                  .filter((entry) => selected.includes(entry.config.id))
                  .map((entry) => ({ id: entry.config.id, enabled: false })),
              )
            }
          >
            {tr("mcp.manage.disableSelected")}
          </Button>
        </div>
      )}
      {!!results.length && (
        <div role="status">
          {results.map((result) => (
            <p key={result.id}>
              {result.id} · {tr(`mcp.manage.import_${result.status}`)} {result.error}
            </p>
          ))}
          {results.some((result) => result.status === "failed") && (
            <Button
              disabled={busy}
              onClick={() => void batch(results.filter((result) => result.status === "failed"))}
            >
              {tr("mcp.manage.retryFailed")}
            </Button>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="p-2">
                <Checkbox
                  aria-label={tr("mcp.manage.selectVisible")}
                  checked={
                    visible.length > 0 &&
                    visible.every((entry) => selected.includes(entry.config.id))
                  }
                  onCheckedChange={(checked) =>
                    setSelected(checked ? visible.map((entry) => entry.config.id) : [])
                  }
                />
              </th>
              <th className="p-3 text-left">{tr("mcp.manage.service")}</th>
              <th>{tr("mcp.manage.enabled")}</th>
              {MCP_MANAGED_AGENTS.map((agent) => (
                <th key={agent} className="p-2 text-xs">
                  {AGENT_LABELS[agent]}
                </th>
              ))}
              <th>{tr("mcp.manage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr key={entry.config.id} className="border-t">
                <td className="p-2">
                  <Checkbox
                    aria-label={`select ${entry.config.name}`}
                    checked={selected.includes(entry.config.id)}
                    onCheckedChange={(checked) =>
                      setSelected((old) =>
                        checked
                          ? [...old, entry.config.id]
                          : old.filter((id) => id !== entry.config.id),
                      )
                    }
                  />
                </td>
                <td className="p-3">
                  <strong>{entry.config.name}</strong>
                  <small className="block">
                    {tr(
                      entry.inherited
                        ? "mcp.manage.inherited"
                        : entry.scope === "global"
                          ? "mcp.globalScope"
                          : "mcp.manage.workspace",
                    )}
                  </small>
                  <code className="text-xs">
                    {entry.config.transport === "stdio" ? entry.config.command : entry.config.url}
                  </code>
                </td>
                <td className="min-w-14 px-3">
                  <Checkbox
                    className="mx-auto"
                    aria-label={`${entry.config.name} ${tr("mcp.manage.enabled")}`}
                    disabled={busy || entry.inherited}
                    checked={entry.config.enabled}
                    onCheckedChange={(checked) => void save(entry, { enabled: checked })}
                  />
                </td>
                {MCP_MANAGED_AGENTS.map((agent) => (
                  <td key={agent} className="min-w-14 px-3 text-center">
                    <Checkbox
                      className="mx-auto"
                      aria-label={`${entry.config.name} ${AGENT_LABELS[agent]}`}
                      disabled={busy || entry.inherited}
                      checked={!entry.config.targets.length || entry.config.targets.includes(agent)}
                      onCheckedChange={(checked) => target(entry, agent, checked)}
                    />
                  </td>
                ))}
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || !!editor}
                      onClick={() => {
                        setEditor({ entry, revision: state!.revision, draft: newMcpDraft(entry) });
                        setOpen(undefined);
                      }}
                    >
                      {tr(entry.inherited ? "mcp.manage.createOverride" : "mcp.manage.edit")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(JSON.stringify(entry.config, null, 2))
                          .catch((reason) => setError(localizeMessage(reason)))
                      }
                    >
                      {tr("mcp.manage.copy")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setPolicy(policy === entry.config.id ? undefined : entry.config.id)
                      }
                    >
                      {tr("mcp.manage.toolPolicy")}
                    </Button>
                    {entry.config.enabled && (
                      <McpRuntimeProbe
                        key={JSON.stringify([project, entry.config, state?.revision])}
                        serverId={entry.config.id}
                        project={project}
                        onProbed={refresh}
                      />
                    )}
                    {entry.config.transport === "streamable-http" && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const response = await api.startMcpOAuth(entry.config.id, project);
                            if (alive.current) await api.openExternal(response.authorization_url);
                          })
                        }
                      >
                        {tr("mcp.authorize")}
                      </Button>
                    )}
                    {!entry.inherited && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (!(await dialogs.confirm(tr("mcp.manage.removeConfirm")))) return;
                            if (!alive.current) return;
                            await api.removeMcpConfiguration({
                              project,
                              revision: state!.revision,
                              id: entry.config.id,
                            });
                            if (alive.current) await refresh();
                          })
                        }
                      >
                        {tr(project ? "mcp.manage.removeOverride" : "common.remove")}
                      </Button>
                    )}
                  </div>
                  {policy === entry.config.id && state && (
                    <McpPolicyEditor
                      key={entry.config.id}
                      project={project}
                      serverId={entry.config.id}
                      revision={`${state.revision}:${catalogEpoch}`}
                      onSaved={refresh}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <p className="p-5">{tr(query.isPending ? "common.loading" : "mcp.configuredEmpty")}</p>
        )}
      </div>
    </div>
  );
}
