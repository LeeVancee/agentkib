import { useCallback, useEffect, useState, useRef, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Goal, Plus, RotateCcw, Settings2, X } from "lucide-react";
import {
  ApiError,
  type SessionAction,
  type SessionActionBody,
  type ClaudePermissionMode,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopy, codexReason } from "./codex-copy";
import { subscribeSessionInvalidation } from "./session-events";
import { ContextUsageDetails, ContextUsageGauge, useContextUsage } from "./context-usage";
import { sessionAgentCopy } from "./session-agent-copy";

export type CodexResource = CodexContextResource;

type CodexComposerControlsProps = {
  resources: CodexResource[];
  setResources: (resources: CodexResource[]) => void;
  openPhoneFiles: () => void;
  disabled: boolean;
  action?: ReactNode;
};

const selectClass =
  "block h-11 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50";

function unavailable(error: unknown) {
  return error instanceof ApiError ? error.code : "request_failed";
}

function settingsSelection(settings: CodexSessionSettings, isClaude: boolean) {
  if (!isClaude) return settings.selected ?? settings.current;
  return {
    ...settings.current,
    ...settings.selected,
    modelId: settings.selected?.modelId ?? settings.current.modelId,
    effort: settings.selected?.effort ?? settings.current.effort,
    permissionMode: settings.selected?.permissionMode ?? settings.current.permissionMode,
  };
}

function modelOption(settings: CodexSessionSettings | undefined, model: string | undefined) {
  if (!model) return undefined;
  return settings?.options.models?.find(
    (item) => item.id === model || item.resolvedModel === model,
  );
}

export function CodexComposerControls({
  resources,
  setResources,
  openPhoneFiles,
  disabled,
  action,
}: CodexComposerControlsProps) {
  const {
    current,
    selected,
    client,
    access,
    locale,
    live,
    busy,
    online,
    codexAction,
    capabilities,
    usageEpoch,
  } = useSession();
  const copy = codexCopy[locale];
  const isClaude = current?.agent === "claude-code";
  const agentCopy = sessionAgentCopy[locale];
  const feature = (name: string) =>
    (
      capabilities?.features as
        | Record<string, { available: boolean; reason?: string } | undefined>
        | undefined
    )?.[name];
  const settingsReadable =
    !isClaude ||
    feature("settings-state")?.available === true ||
    feature("settings")?.available === true;
  const goalReadable =
    !isClaude ||
    ["goal", "goal-set", "goal-pause", "goal-resume", "goal-clear"].some(
      (key) => feature(key)?.available,
    );
  const resourcesReadable =
    !isClaude || feature("resources")?.available === true || feature("context")?.available === true;
  const layout = composerLayoutCopy[locale];
  const term = (value: string) => composerTerm(locale, value);
  const reason = (code?: string) => codexReason(locale, code).text;
  const reasonTitle = (code?: string) => (code ? reason(code) : undefined);
  const reasonDetail = (code?: string) => {
    const value = codexReason(locale, code);
    return (
      <div className="text-xs text-muted-foreground">
        {value.text}
        {value.technical && (
          <details className="mt-1">
            <summary>{layout.details}</summary>
            <code className="break-all">{value.technical}</code>
          </details>
        )}
      </div>
    );
  };
  const loadGeneration = useRef(0);
  const loadFlight = useRef<
    | {
        generation: number;
        dirty: boolean;
        background: boolean;
        promise: Promise<void>;
      }
    | undefined
  >(undefined);
  const contextGeneration = useRef(0);
  const contextAbort = useRef<AbortController | undefined>(undefined);
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const contextLocation = useRef<{ id?: string; names: string[] }>({ names: [] });
  const [contextNames, setContextNames] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const settingsDraftRevision = useRef<number | undefined>(undefined);
  const editedClaudeSettings = useRef(new Set<"model" | "effort" | "permissionMode">());
  const goalDraftRevision = useRef<number | undefined>(undefined);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const [dialog, setDialog] = useState<"settings" | "goal" | "context">();
  const [settings, setSettings] = useState<CodexSessionSettings>();
  const [goal, setGoal] = useState<CodexGoalState>();
  const [context, setContext] = useState<CodexContextOptions>();
  const [settingsError, setSettingsError] = useState("");
  const [goalError, setGoalError] = useState("");
  const [contextError, setContextError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [resourceWarning, setResourceWarning] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingSettings, setPendingSettings] =
    useState<
      Pick<
        SessionActionBody,
        | "model"
        | "effort"
        | "mode"
        | "policyId"
        | "serviceTierId"
        | "restoreDefaults"
        | "permissionMode"
        | "expectedRevision"
      >
    >();
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState<"" | "default" | "plan">("");
  const [policy, setPolicy] = useState("");
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode | "">("");
  const [serviceTier, setServiceTier] = useState("");
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const compacting = live?.activity === "compacting";
  const running = live?.status !== "idle" || compacting;
  const usageView = useContextUsage(settings?.sessionId === selected ? settings.usage : undefined);

  const applySettings = useCallback(
    (value: CodexSessionSettings) => {
      setSettings(value);
      if (settingsDraftRevision.current !== undefined) return;
      const selected = settingsSelection(value, isClaude);
      setModel(modelOption(value, selected.modelId)?.id ?? selected.modelId ?? "");
      setEffort(selected.effort ?? "");
      setMode(selected.mode === "default" || selected.mode === "plan" ? selected.mode : "");
      setPolicy(selected.policyId ?? "");
      setPermissionMode(selected.permissionMode ?? "");
      setServiceTier(selected.serviceTierId ?? "");
    },
    [isClaude],
  );

  const loadContext = useCallback(
    async (directoryId?: string, names: string[] = []) => {
      if (!full || !selected || !online || !resourcesReadable) return;
      contextAbort.current?.abort();
      const abort = new AbortController();
      contextAbort.current = abort;
      const generation = ++contextGeneration.current;
      contextLocation.current = { id: directoryId, names };
      setContextLoading(true);
      setContextError("");
      try {
        const value = isClaude
          ? await client.sessionResources(selected, "claude-code", directoryId, abort.signal)
          : await client.codexContextOptions(selected, directoryId, abort.signal);
        if (abort.signal.aborted || generation !== contextGeneration.current) return;
        setContext(value);
        setContextNames(names);
        setQuery("");
        // A directory response is only a partial catalog. Missing references may
        // belong to another folder; the host revalidates every reference on send.
        const current = resourcesRef.current;
        const visible = new Map(value.resources.map((item) => [item.id, item]));
        const next = current.flatMap((item) => {
          const refreshed = visible.get(item.id);
          return !refreshed ? [item] : refreshed.available ? [refreshed] : [];
        });
        if (next.length !== current.length) setResourceWarning(copy.resourceRemoved);
        if (next.some((item, index) => item !== current[index]) || next.length !== current.length)
          setResources(next);
      } catch (error) {
        if (!abort.signal.aborted && generation === contextGeneration.current)
          setContextError(unavailable(error));
      } finally {
        if (!abort.signal.aborted && generation === contextGeneration.current)
          setContextLoading(false);
      }
    },
    [
      client,
      copy.resourceRemoved,
      full,
      online,
      selected,
      setResources,
      isClaude,
      resourcesReadable,
    ],
  );

  const load = useCallback(
    (background = false): Promise<void> => {
      if (!full || !selected) return Promise.resolve();
      const generation = loadGeneration.current;
      const pending = loadFlight.current;
      if (pending?.generation === generation) {
        pending.dirty = true;
        pending.background &&= background;
        return pending.promise;
      }
      const flight = { generation, dirty: true, background, promise: Promise.resolve() };
      flight.promise = (async () => {
        // Initial readiness, an idle revision and domain invalidations can arrive
        // together. Coalesce that batch before starting one pair of native reads.
        await Promise.resolve();
        while (flight.dirty && generation === loadGeneration.current) {
          const quiet = flight.background;
          flight.dirty = false;
          flight.background = true;
          const [settingsResult, goalResult] = await Promise.allSettled([
            settingsReadable
              ? isClaude
                ? client.sessionSettings(selected, "claude-code")
                : client.codexSessionSettings(selected)
              : Promise.resolve(undefined),
            goalReadable
              ? isClaude
                ? client.sessionGoals(selected, "claude-code")
                : client.codexGoals(selected)
              : Promise.resolve(undefined),
          ]);
          if (generation !== loadGeneration.current) return;
          if (settingsResult.status === "fulfilled") {
            if (settingsResult.value) applySettings(settingsResult.value);
            else setSettings(undefined);
            setSettingsError("");
          } else if (!quiet) {
            setSettings(undefined);
            setSettingsError(unavailable(settingsResult.reason));
          }
          if (goalResult.status === "fulfilled") {
            setGoal(goalResult.value);
            if (goalDraftRevision.current === undefined) {
              setObjective(goalResult.value?.goal?.objective ?? "");
              setTokenBudget(goalResult.value?.goal?.tokenBudget?.toString() ?? "");
            }
            setGoalError("");
          } else if (!quiet) {
            setGoal(undefined);
            setGoalError(unavailable(goalResult.reason));
          }
        }
        if (loadFlight.current === flight) loadFlight.current = undefined;
      })().finally(() => {
        if (loadFlight.current === flight) loadFlight.current = undefined;
      });
      loadFlight.current = flight;
      return flight.promise;
    },
    [applySettings, client, full, selected, isClaude, settingsReadable, goalReadable],
  );

  useEffect(() => {
    loadGeneration.current++;
    settingsDraftRevision.current = undefined;
    editedClaudeSettings.current.clear();
    goalDraftRevision.current = undefined;
    setSettingsDirty(false);
    setGoalDirty(false);
    setSettings(undefined);
    setGoal(undefined);
    setContext(undefined);
    contextGeneration.current++;
    contextAbort.current?.abort();
    contextLocation.current = { names: [] };
    setContextNames([]);
    setContextLoading(false);
    setQuery("");
    setResources([]);
    setDialog(undefined);
    setSaved(false);
    setPendingSettings(undefined);
    setSettingsError("");
    setGoalError("");
    setContextError("");
    setMutationError("");
    setResourceWarning("");
    return () => {
      loadGeneration.current++;
      contextGeneration.current++;
      contextAbort.current?.abort();
    };
  }, [selected, setResources, client, access?.bootId, access?.device?.id]);

  useEffect(() => {
    if (!full || !selected || !online || usageEpoch === "") {
      contextGeneration.current++;
      contextAbort.current?.abort();
      setContextLoading(false);
      return;
    }
    void load();
    void loadContext(contextLocation.current.id, contextLocation.current.names);
    // Re-read only the selected session after reconnect. Native changes arrive over SSE.
    return () => {
      loadGeneration.current++;
    };
  }, [
    full,
    online,
    selected,
    access?.bootId,
    access?.device?.id,
    usageEpoch,
    settingsReadable,
    goalReadable,
    resourcesReadable,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!full || !selected || !online) return;
    return subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["settings", "goal", "usage", "ownership"].includes(domain))
      )
        void load(true);
    });
  }, [client, full, load, online, selected]);

  useEffect(() => {
    // Settings and goals use the conversation's CAS revision. An unrelated
    // idle update can advance it without invalidating either domain. Running
    // token revisions do not trigger reads; entering idle calibrates it once.
    if (
      full &&
      online &&
      live?.sessionId === selected &&
      live.status === "idle" &&
      live.revision !== undefined &&
      live.revision !== null
    )
      void load(true);
  }, [full, load, online, selected, live?.sessionId, live?.status, live?.revision]);

  useEffect(() => {
    if (live?.settings?.sessionId === selected) {
      applySettings({
        ...live.settings,
        usage: live.usage ?? live.settings.usage,
      });
    } else if (live?.usage && settings?.sessionId === selected) {
      setSettings((value) => (value ? { ...value, usage: live.usage } : value));
    }
    if (live?.goal && goal?.sessionId === selected)
      setGoal((value) => (value ? { ...value, goal: live.goal } : value));
  }, [applySettings, goal?.sessionId, live, selected, settings?.sessionId]);

  useEffect(() => {
    if (!settings?.available || !pendingSettings) return;
    const expected: Omit<typeof pendingSettings, "expectedRevision"> =
      pendingSettings.restoreDefaults
        ? {
            model: settings.defaults.modelId,
            effort: settings.defaults.effort,
            serviceTierId: settings.defaults.serviceTierId,
            permissionMode: settings.defaults.permissionMode,
          }
        : pendingSettings;
    const confirmed =
      (!isClaude ||
        (settings.applicationStatus === "confirmed" &&
          settings.revision > pendingSettings.expectedRevision)) &&
      settings.applicationStatus !== "pending" &&
      settings.applicationStatus !== "unknown" &&
      (expected.model === undefined ||
        settings.current.modelId === expected.model ||
        (isClaude &&
          !!settings.current.modelId &&
          settings.options.models.find((item) => item.id === expected.model)?.resolvedModel ===
            settings.current.modelId)) &&
      (expected.effort === undefined ||
        (isClaude && expected.effort === null
          ? settings.selected !== undefined && settings.selected.effort === undefined
          : settings.current.effort === expected.effort)) &&
      (expected.mode === undefined || settings.current.mode === expected.mode) &&
      (expected.policyId === undefined || settings.current.policyId === expected.policyId) &&
      (expected.permissionMode === undefined ||
        settings.current.permissionMode === expected.permissionMode) &&
      (expected.serviceTierId === undefined ||
        settings.current.serviceTierId === expected.serviceTierId);
    if (confirmed) {
      setPendingSettings(undefined);
      setSaved(true);
    }
  }, [isClaude, pendingSettings, settings]);

  async function mutate(
    name: SessionAction,
    fields: Omit<
      Partial<SessionActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    if (!full || saving || compacting) return;
    const readRevision = name === "settings" ? settings?.revision : goal?.revision;
    if (live?.revision !== undefined && readRevision !== live.revision) return;
    setSaving(true);
    setSaved(false);
    setMutationError("");
    try {
      const result = await codexAction(name, fields);
      if (result) {
        if (name === "settings") {
          setPendingSettings({ ...fields, expectedRevision: readRevision ?? 0 });
          settingsDraftRevision.current = undefined;
          editedClaudeSettings.current.clear();
          setSettingsDirty(false);
        }
        if (name.startsWith("goal-")) {
          goalDraftRevision.current = undefined;
          setGoalDirty(false);
        }
        await load();
      }
    } catch (error) {
      setMutationError(unavailable(error));
    } finally {
      setSaving(false);
    }
  }

  if (!full) return null;
  const selectedModel = modelOption(settings, model);
  const availableResources = (context?.resources ?? []).filter((item) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(needle);
  });
  const resourceGroups = [
    {
      label: copy.computerFiles,
      items: availableResources.filter((item) => item.kind === "file" || item.kind === "directory"),
    },
    {
      label: copy.skillsPlugins,
      items: availableResources.filter(
        (item) => item.kind === "skill" || item.kind === "plugin" || item.kind === "app",
      ),
    },
  ];
  const settingsChanged = settingsDirty && settingsDraftRevision.current !== settings?.revision;
  const goalChanged = goalDirty && goalDraftRevision.current !== goal?.revision;
  const settingsReadStale = live?.revision !== undefined && settings?.revision !== live.revision;
  const goalReadStale = live?.revision !== undefined && goal?.revision !== live.revision;
  const openControls = (next: "settings" | "goal") => {
    // Running revisions deliberately do not auto-read. Opening a stale panel
    // is an explicit request to refresh its CAS read model, without submitting.
    if (next === "settings" ? settingsReadStale : goalReadStale) void load();
    setDialog(next);
  };
  const editSettings = (field?: "model" | "effort" | "permissionMode") => {
    settingsDraftRevision.current ??= settings?.revision;
    if (isClaude && field) editedClaudeSettings.current.add(field);
    setSettingsDirty(true);
    setSaved(false);
  };
  const editGoal = () => {
    goalDraftRevision.current ??= goal?.revision;
    setGoalDirty(true);
  };
  const settingDisabled =
    disabled || busy || saving || running || feature("settings")?.available !== true;
  const parsedBudget = tokenBudget ? Number(tokenBudget) : undefined;
  const budgetValid =
    parsedBudget === undefined || (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const displayedSettings = settings ? settingsSelection(settings, isClaude) : undefined;
  const modeOptions = settings?.options.collaborationModes ?? [];
  const modeWritable = settings?.writable.mode?.available && modeOptions.length > 0;
  const unavailableSettings = settings
    ? [
        [copy.model, settings.writable.model?.available],
        [copy.effort, settings.writable.effort?.available],
        ...(isClaude
          ? [[agentCopy.permission, settings.writable.permissionMode?.available]]
          : [
              [copy.mode, modeWritable],
              [copy.serviceTier, settings.writable.serviceTier?.available],
              [copy.executionPolicy, settings.writable.policy?.available],
            ]),
        [copy.restoreDefaults, settings.writable.restoreDefaults?.available],
      ].flatMap(([label, available]) => (available === true ? [] : [label as string]))
    : [];
  const settingsFeatureUnavailable = feature("settings")?.available !== true;
  const currentModel =
    modelOption(settings, displayedSettings?.modelId)?.name ?? displayedSettings?.modelId;

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {(!isClaude || resourcesReadable || goalReadable || feature("attachments")?.available) && (
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0 p-0"
            aria-label={copy.addContext}
            disabled={disabled}
            onClick={() => {
              void load();
              void loadContext(context?.directoryId, contextNames);
              setDialog("context");
            }}
          >
            <Plus size={20} />
          </Button>
        )}
        {settingsReadable && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 min-w-0 flex-1 shrink justify-start px-2"
            disabled={disabled}
            onClick={() => openControls("settings")}
          >
            <Settings2 className="hidden shrink-0 sm:block" size={16} />
            <span className="truncate">{currentModel || copy.conversationSettings}</span>
            {displayedSettings?.effort && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {term(displayedSettings.effort)}
              </span>
            )}
            {(displayedSettings?.mode === "plan" ||
              displayedSettings?.permissionMode === "plan") && (
              <span className="shrink-0 text-xs text-muted-foreground">{copy.plan}</span>
            )}
            {settings?.applicationStatus === "pending" && (
              <span className="shrink-0 text-xs text-muted-foreground">{layout.nextTurn}</span>
            )}
            {settings?.applicationStatus === "unknown" && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {layout.settingsUnknown}
              </span>
            )}
          </Button>
        )}
        <ContextUsageGauge
          fallback={settings?.sessionId === selected ? settings.usage : undefined}
        />
        {action}
      </div>
      {goal?.goal && (
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-11 w-full justify-start overflow-hidden px-2 text-xs"
          aria-label={copy.goals}
          onClick={() => openControls("goal")}
        >
          <Goal className="shrink-0" size={16} />
          <span className="shrink-0">{term(goal.goal.status)}</span>
          <span className="truncate">{goal.goal.objective}</span>
        </Button>
      )}
      {dialog === "settings" && (
        <Dialog
          panel
          footer={
            settings?.available ? (
              <>
                {settingsChanged && (
                  <div role="status" className="mb-3 text-xs">
                    {layout.nativeChanged}
                    {!settingsReadStale && (
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => {
                          settingsDraftRevision.current = undefined;
                          editedClaudeSettings.current.clear();
                          setSettingsDirty(false);
                          applySettings(settings);
                        }}
                      >
                        {layout.reloadDraft}
                      </Button>
                    )}
                  </div>
                )}
                {running && (
                  <p role="status" className="mb-3 text-xs text-muted-foreground">
                    {copy.settingsWhileRunning}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={
                      settingDisabled ||
                      settingsChanged ||
                      settingsReadStale ||
                      (isClaude && !settingsDirty)
                    }
                    onClick={() =>
                      void mutate("settings", {
                        ...(model &&
                        settings.writable.model.available &&
                        (!isClaude || editedClaudeSettings.current.has("model"))
                          ? { model }
                          : {}),
                        ...(settings.writable.effort.available &&
                        (isClaude ? editedClaudeSettings.current.has("effort") : effort)
                          ? { effort: effort || null }
                          : {}),
                        ...(!isClaude && mode && modeWritable ? { mode } : {}),
                        ...(!isClaude && policy && settings.writable.policy.available
                          ? { policyId: policy }
                          : {}),
                        ...(!isClaude && serviceTier && settings.writable.serviceTier.available
                          ? { serviceTierId: serviceTier }
                          : {}),
                        ...(isClaude &&
                        permissionMode &&
                        editedClaudeSettings.current.has("permissionMode") &&
                        settings.writable.permissionMode?.available
                          ? { permissionMode }
                          : {}),
                      })
                    }
                  >
                    {copy.apply}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      settingDisabled ||
                      settingsReadStale ||
                      !settings?.writable.restoreDefaults?.available
                    }
                    title={reasonTitle(settings?.writable.restoreDefaults?.reason)}
                    onClick={() => void mutate("settings", { restoreDefaults: true })}
                  >
                    <RotateCcw size={15} /> {copy.restoreDefaults}
                  </Button>
                </div>
              </>
            ) : undefined
          }
          title={copy.conversationSettings}
          closeLabel={copy.close}
          onClose={() => setDialog(undefined)}
        >
          {settingsReadStale && (settings?.available || !!settingsError) && (
            <div role="status" className="mb-3 text-xs text-muted-foreground">
              {layout.connecting}
              <Button type="button" variant="outline" onClick={() => void load()}>
                {layout.reloadDraft}
              </Button>
            </div>
          )}
          {!settings?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.settingUnavailable}
              {reason(settings?.reason || settingsError)}
            </p>
          ) : (
            <section className="session-settings-layout space-y-5">
              <div className="rounded-xl border bg-muted/20 p-4">
                <ContextUsageDetails {...usageView} locale={locale} online={online} />
              </div>
              <label className="block space-y-1 text-sm">
                {copy.model}
                <select
                  className={selectClass}
                  value={model}
                  disabled={settingDisabled || !settings.writable.model?.available}
                  title={reasonTitle(settings.writable.model?.reason)}
                  onChange={(event) => {
                    editSettings("model");
                    const next = event.target.value;
                    const option = settings.options.models?.find((item) => item.id === next);
                    setModel(next);
                    if (!option?.efforts?.includes(effort)) {
                      editSettings("effort");
                      setEffort(option?.defaultEffort ?? "");
                    }
                    if (!option?.serviceTierIds?.includes(serviceTier)) {
                      setServiceTier(
                        option?.serviceTierIds?.includes(settings.defaults.serviceTierId ?? "")
                          ? (settings.defaults.serviceTierId ?? "")
                          : "",
                      );
                    }
                  }}
                >
                  <option value="">{copy.defaultOption}</option>
                  {settings.options.models?.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
                {!settings.writable.model?.available &&
                  reasonDetail(settings.writable.model?.reason)}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  {copy.effort}
                  <select
                    className={selectClass}
                    value={effort}
                    disabled={settingDisabled || !settings.writable.effort?.available}
                    title={reasonTitle(settings.writable.effort?.reason)}
                    onChange={(event) => {
                      editSettings("effort");
                      setEffort(event.target.value);
                    }}
                  >
                    <option value="">{copy.defaultOption}</option>
                    {selectedModel?.efforts?.map((item) => (
                      <option key={item} value={item}>
                        {term(item)}
                      </option>
                    ))}
                  </select>
                  {!settings.writable.effort?.available &&
                    reasonDetail(settings.writable.effort?.reason)}
                </label>
                {isClaude ? (
                  <label className="block space-y-1 text-sm">
                    {agentCopy.permission}
                    <select
                      className={selectClass}
                      value={permissionMode}
                      disabled={settingDisabled || !settings.writable.permissionMode?.available}
                      title={reasonTitle(settings.writable.permissionMode?.reason)}
                      onChange={(event) => {
                        editSettings("permissionMode");
                        setPermissionMode(event.target.value as ClaudePermissionMode);
                      }}
                    >
                      <option value="" disabled>
                        {layout.modeUnknown}
                      </option>
                      {settings.options.permissionModes
                        ?.filter((item) => ["default", "plan", "acceptEdits"].includes(item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                    {!settings.writable.permissionMode?.available &&
                      reasonDetail(settings.writable.permissionMode?.reason)}
                    {settings.options.permissionModes?.find((item) => item.id === permissionMode)
                      ?.description && (
                      <small className="block text-muted-foreground">
                        {
                          settings.options.permissionModes.find(
                            (item) => item.id === permissionMode,
                          )?.description
                        }
                      </small>
                    )}
                  </label>
                ) : (
                  <>
                    <label className="block space-y-1 text-sm">
                      {copy.mode}
                      <select
                        className={selectClass}
                        value={mode}
                        disabled={settingDisabled || !modeWritable}
                        title={reasonTitle(settings.writable.mode?.reason)}
                        onChange={(event) => {
                          editSettings();
                          setMode(event.target.value as "" | "default" | "plan");
                        }}
                      >
                        <option value="" disabled>
                          {layout.modeUnknown}
                        </option>
                        {modeOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.id === "plan" ? copy.plan : copy.normal}
                          </option>
                        ))}
                      </select>
                      {!modeWritable &&
                        reasonDetail(
                          settings.writable.mode?.reason || "collaboration-modes-unavailable",
                        )}
                    </label>
                    <label className="block space-y-1 text-sm">
                      {copy.serviceTier}
                      <select
                        className={selectClass}
                        value={serviceTier}
                        disabled={settingDisabled || !settings.writable.serviceTier?.available}
                        title={reasonTitle(settings.writable.serviceTier?.reason)}
                        onChange={(event) => {
                          editSettings();
                          setServiceTier(event.target.value);
                        }}
                      >
                        <option value="">{copy.defaultOption}</option>
                        {settings.options.serviceTiers
                          ?.filter(
                            (item) =>
                              !selectedModel?.serviceTierIds?.length ||
                              selectedModel.serviceTierIds.includes(item.id),
                          )
                          .map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.name || item.id}
                            </option>
                          ))}
                      </select>
                      {!settings.writable.serviceTier?.available &&
                        reasonDetail(settings.writable.serviceTier?.reason)}
                      {!!settings.options.serviceTiers?.find((item) => item.id === serviceTier)
                        ?.description && (
                        <small className="block text-muted-foreground">
                          {
                            settings.options.serviceTiers.find((item) => item.id === serviceTier)
                              ?.description
                          }
                        </small>
                      )}
                    </label>
                    <label className="block space-y-1 text-sm">
                      {copy.executionPolicy}
                      <select
                        className={selectClass}
                        value={policy}
                        disabled={settingDisabled || !settings.writable.policy?.available}
                        title={reasonTitle(settings.writable.policy?.reason)}
                        onChange={(event) => {
                          editSettings();
                          setPolicy(event.target.value);
                        }}
                      >
                        {settings.options.policies?.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      {!settings.writable.policy?.available &&
                        reasonDetail(settings.writable.policy?.reason)}
                      {!!settings.options.policies?.find((item) => item.id === policy)
                        ?.description && (
                        <small className="block text-muted-foreground">
                          {
                            settings.options.policies.find((item) => item.id === policy)
                              ?.description
                          }
                        </small>
                      )}
                    </label>
                  </>
                )}
              </div>
              {feature("settings")?.available !== true && reasonDetail(feature("settings")?.reason)}
              {settings.applicationStatus === "pending" && (
                <p role="status" className="text-xs text-muted-foreground">
                  {layout.settingsPending}
                </p>
              )}
              {settings.applicationStatus === "unknown" && (
                <p role="status" className="text-xs text-muted-foreground">
                  {layout.settingsUnknown}
                </p>
              )}
              {saved &&
                settings.applicationStatus !== "pending" &&
                settings.applicationStatus !== "unknown" && (
                  <p role="status" className="text-xs text-emerald-600">
                    {copy.settingsSaved}
                  </p>
                )}
              {mutationError && (
                <p role="alert" className="text-xs text-destructive">
                  {reason(mutationError)}
                </p>
              )}
            </section>
          )}
        </Dialog>
      )}

      {dialog === "goal" && (
        <Dialog
          panel
          footer={
            goal?.available ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={
                    busy ||
                    saving ||
                    compacting ||
                    goalChanged ||
                    goalReadStale ||
                    !goal.actions.set?.available ||
                    feature("goal-set")?.available !== true ||
                    !objective.trim() ||
                    !budgetValid
                  }
                  title={reasonTitle(goal.actions.set?.reason || feature("goal-set")?.reason)}
                  onClick={() =>
                    void mutate("goal-set", {
                      objective: objective.trim(),
                      intent: goal.goal ? "update" : "start",
                      tokenBudget: parsedBudget ?? null,
                    })
                  }
                >
                  {goal.goal ? copy.goalUpdate : copy.goalCreate}
                </Button>
                {goal.goal &&
                ["paused", "blocked", "budgetLimited", "usageLimited", "budget-exhausted"].includes(
                  goal.goal.status,
                ) ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      saving ||
                      compacting ||
                      goalReadStale ||
                      !goal.actions.resume?.available ||
                      feature("goal-resume")?.available !== true
                    }
                    title={reasonTitle(
                      goal.actions.resume?.reason || feature("goal-resume")?.reason,
                    )}
                    onClick={() => void mutate("goal-resume")}
                  >
                    {["budgetLimited", "usageLimited", "budget-exhausted"].includes(
                      goal.goal.status,
                    )
                      ? layout.tryResume
                      : copy.goalResume}
                  </Button>
                ) : goal.goal?.status === "active" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      saving ||
                      compacting ||
                      goalReadStale ||
                      !goal.actions.pause?.available ||
                      feature("goal-pause")?.available !== true
                    }
                    title={reasonTitle(goal.actions.pause?.reason || feature("goal-pause")?.reason)}
                    onClick={() => void mutate("goal-pause")}
                  >
                    {copy.goalPause}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={
                    busy ||
                    saving ||
                    compacting ||
                    goalReadStale ||
                    !goal.actions.clear?.available ||
                    feature("goal-clear")?.available !== true
                  }
                  title={reasonTitle(goal.actions.clear?.reason || feature("goal-clear")?.reason)}
                  onClick={() => void mutate("goal-clear")}
                >
                  {copy.goalClear}
                </Button>
              </div>
            ) : undefined
          }
          title={copy.goals}
          closeLabel={copy.close}
          onClose={() => setDialog(undefined)}
        >
          {goalReadStale && (goal?.available || !!goalError) && (
            <div role="status" className="mb-3 text-xs text-muted-foreground">
              {layout.connecting}
              <Button type="button" variant="outline" onClick={() => void load()}>
                {layout.reloadDraft}
              </Button>
            </div>
          )}
          {!goal?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.goalUnavailable}
              {reason(goal?.reason || goalError)}
            </p>
          ) : (
            <section className="space-y-3">
              {goalChanged && (
                <div role="status" className="text-xs">
                  {layout.nativeChanged}
                  {!goalReadStale && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        goalDraftRevision.current = undefined;
                        setGoalDirty(false);
                        setObjective(goal.goal?.objective ?? "");
                        setTokenBudget(goal.goal?.tokenBudget?.toString() ?? "");
                      }}
                    >
                      {layout.reloadDraft}
                    </Button>
                  )}
                </div>
              )}
              {mutationError && (
                <p role="alert" className="text-xs text-destructive">
                  {reason(mutationError)}
                </p>
              )}
              {goal.goal && (
                <dl className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs">
                  <dt>{copy.goalStatus}</dt>
                  <dd>{term(goal.goal.status)}</dd>
                  <dt>{copy.goalUsage}</dt>
                  <dd>
                    {goal.goal.tokensUsed?.toLocaleString() ?? copy.unavailable}
                    {goal.goal.tokenBudget ? ` / ${goal.goal.tokenBudget.toLocaleString()}` : ""}
                  </dd>
                  <dt>{copy.goalElapsed}</dt>
                  <dd>
                    {goal.goal.elapsedMs === undefined
                      ? copy.unavailable
                      : `${Math.round(goal.goal.elapsedMs / 1000)}s`}
                  </dd>
                </dl>
              )}
              {(["set", "pause", "resume", "clear"] as const)
                .filter(
                  (action) =>
                    !goal.actions[action]?.available ||
                    feature(`goal-${action}`)?.available !== true,
                )
                .map((action) => (
                  <div key={action}>
                    {reasonDetail(
                      goal.actions[action]?.reason || feature(`goal-${action}`)?.reason,
                    )}
                  </div>
                ))}
              <label className="block space-y-1 text-sm">
                {copy.goalObjective}
                <textarea
                  className="min-h-24 w-full rounded-md border bg-background p-2"
                  value={objective}
                  disabled={busy || saving || compacting}
                  onChange={(event) => {
                    editGoal();
                    setObjective(event.target.value);
                  }}
                />
              </label>
              <label className="block space-y-1 text-sm">
                {copy.goalBudget}
                <Input
                  type="number"
                  min={1}
                  value={tokenBudget}
                  disabled={busy || saving || compacting}
                  onChange={(event) => {
                    editGoal();
                    setTokenBudget(event.target.value);
                  }}
                />
              </label>
            </section>
          )}
        </Dialog>
      )}

      {dialog === "context" && (
        <Dialog
          panel
          footer={
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {layout.selected}: {resources.length}
              </span>
              <Button type="button" className="min-h-11" onClick={() => setDialog(undefined)}>
                {layout.done}
              </Button>
            </div>
          }
          title={copy.addContext}
          closeLabel={copy.close}
          onClose={() => setDialog(undefined)}
        >
          <section className="space-y-4">
            {goalReadable && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full justify-start"
                onClick={() => openControls("goal")}
              >
                <Goal size={16} />
                {copy.goals}
              </Button>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="min-h-11 cursor-pointer content-center">{layout.help}</summary>
              <p className="pb-2 leading-5">{copy.composerHint}</p>
            </details>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-start"
              disabled={disabled || capabilities?.features.attachments?.available !== true}
              onClick={() => {
                setDialog(undefined);
                openPhoneFiles();
              }}
            >
              {copy.uploadFromPhone}
            </Button>
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                disabled={!context?.parentId || contextLoading || !online}
                onClick={() => void loadContext(context?.parentId, contextNames.slice(0, -1))}
              >
                <ArrowLeft size={16} />
                {layout.parentDirectory}
              </Button>
              <span className="min-w-0 break-words text-sm">
                {[layout.contextRoot, ...contextNames].join(" / ")}
              </span>
            </div>
            {contextLoading && (
              <p role="status" className="text-sm">
                {layout.contextLoading}
              </p>
            )}
            {contextError && (
              <div role="alert" className="space-y-2 text-sm">
                {reason(contextError)}
                <Button
                  type="button"
                  variant="outline"
                  disabled={contextLoading || !online}
                  onClick={() =>
                    void loadContext(contextLocation.current.id, contextLocation.current.names)
                  }
                >
                  {layout.contextRetry}
                </Button>
              </div>
            )}
            {!context ? (
              <p role="status" className="text-sm text-muted-foreground">
                {!contextLoading && !contextError ? copy.resourceUnavailable : null}
              </p>
            ) : (
              <>
                <Input
                  aria-label={copy.resourceSearch}
                  placeholder={copy.resourceSearch}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{copy.directoryReference}</p>
                <div className="space-y-2">
                  {availableResources.length === 0 && (
                    <p className="text-sm text-muted-foreground">{copy.resourceEmpty}</p>
                  )}
                  {resourceGroups.map(
                    (group) =>
                      group.items.length > 0 && (
                        <section key={group.label} className="space-y-2">
                          <h3 className="text-xs font-medium text-muted-foreground">
                            {group.label}
                          </h3>
                          {group.items.map((item) => {
                            const checked = resources.some((selected) => selected.id === item.id);
                            return (
                              <div
                                key={item.id}
                                className="flex items-center gap-2 rounded-lg border p-3 text-sm"
                              >
                                <label className="flex min-w-0 flex-1 items-start gap-3">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={
                                      !item.available ||
                                      contextLoading ||
                                      !online ||
                                      disabled ||
                                      feature("context")?.available !== true
                                    }
                                    title={reasonTitle(item.reason || feature("context")?.reason)}
                                    onChange={(event) =>
                                      setResources(
                                        event.target.checked
                                          ? [...resources, item]
                                          : resources.filter((selected) => selected.id !== item.id),
                                      )
                                    }
                                  />
                                  <span className="min-w-0">
                                    <span className="block break-words font-medium">
                                      {item.name}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                      {term(item.kind)}
                                      {item.description ? ` · ${item.description}` : ""}
                                      {!item.available || feature("context")?.available !== true
                                        ? ` · ${reason(item.reason || feature("context")?.reason)}`
                                        : ""}
                                    </span>
                                  </span>
                                </label>
                                {item.kind === "directory" && item.navigationId && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="size-11 shrink-0 p-0"
                                    aria-label={`${layout.enterDirectory}: ${item.name}`}
                                    disabled={
                                      contextLoading ||
                                      !online ||
                                      disabled ||
                                      !item.available ||
                                      feature("context")?.available !== true
                                    }
                                    onClick={() =>
                                      void loadContext(item.navigationId, [
                                        ...contextNames,
                                        item.name,
                                      ])
                                    }
                                  >
                                    <ChevronRight size={18} />
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </section>
                      ),
                  )}
                </div>
              </>
            )}
          </section>
        </Dialog>
      )}

      {resources.map((item) => (
        <span
          key={item.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border pl-3 text-xs"
        >
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded hover:bg-accent"
            aria-label={`${copy.remove}: ${item.name}`}
            disabled={disabled}
            onClick={() => setResources(resources.filter((selected) => selected.id !== item.id))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {resourceWarning && (
        <span role="alert" className="text-xs text-destructive">
          {resourceWarning}
        </span>
      )}
    </>
  );
}
