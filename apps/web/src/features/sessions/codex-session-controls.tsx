import { useCallback, useEffect, useState, useRef, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Gauge, Goal, Plus, RotateCcw, Settings2, X } from "lucide-react";
import {
  ApiError,
  type CodexAction,
  type CodexActionBody,
  type CodexContextOptions,
  type CodexContextResource,
  type CodexGoalState,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/dialog";
import { useSession } from "./session-context";
import { composerLayoutCopy, composerTerm } from "./composer-layout-copy";
import { codexCopy, codexReason } from "./codex-copy";

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

export function CodexComposerControls({
  resources,
  setResources,
  openPhoneFiles,
  disabled,
  action,
}: CodexComposerControlsProps) {
  const { selected, client, access, locale, live, busy, online, codexAction, capabilities } =
    useSession();
  const copy = codexCopy[locale];
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
  const contextGeneration = useRef(0);
  const contextAbort = useRef<AbortController | undefined>(undefined);
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const contextLocation = useRef<{ id?: string; names: string[] }>({ names: [] });
  const [contextNames, setContextNames] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const revisionSeen = useRef<string | undefined>(undefined);
  const lastNativeRead = useRef(0);
  const settingsDraftRevision = useRef<number | undefined>(undefined);
  const goalDraftRevision = useRef<number | undefined>(undefined);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [goalDirty, setGoalDirty] = useState(false);
  const full = access?.device?.accessMode === "full";
  const [dialog, setDialog] = useState<"settings" | "goal" | "context" | "usage">();
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
        CodexActionBody,
        "model" | "effort" | "mode" | "policyId" | "serviceTierId" | "restoreDefaults"
      >
    >();
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState<"" | "default" | "plan">("");
  const [policy, setPolicy] = useState("");
  const [serviceTier, setServiceTier] = useState("");
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const running = live?.status !== "idle";

  const applySettings = useCallback((value: CodexSessionSettings) => {
    setSettings(value);
    if (settingsDraftRevision.current !== undefined) return;
    const selected = value.selected ?? value.current;
    setModel(selected.modelId ?? "");
    setEffort(selected.effort ?? "");
    setMode(selected.mode === "default" || selected.mode === "plan" ? selected.mode : "");
    setPolicy(selected.policyId ?? "");
    setServiceTier(selected.serviceTierId ?? "");
  }, []);

  const loadContext = useCallback(
    async (directoryId?: string, names: string[] = []) => {
      if (!full || !selected || !online) return;
      contextAbort.current?.abort();
      const abort = new AbortController();
      contextAbort.current = abort;
      const generation = ++contextGeneration.current;
      contextLocation.current = { id: directoryId, names };
      setContextLoading(true);
      setContextError("");
      try {
        const value = await client.codexContextOptions(selected, directoryId, abort.signal);
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
    [client, copy.resourceRemoved, full, online, selected, setResources],
  );

  const load = useCallback(async () => {
    if (!full || !selected) return;
    const generation = ++loadGeneration.current;
    const results = await Promise.allSettled([
      client.codexSessionSettings(selected),
      client.codexGoals(selected),
    ]);
    if (generation !== loadGeneration.current) return;
    const [settingsResult, goalResult] = results;
    if (settingsResult.status === "fulfilled") {
      applySettings(settingsResult.value);
      setSettingsError("");
    } else {
      setSettings(undefined);
      setSettingsError(unavailable(settingsResult.reason));
    }
    if (goalResult.status === "fulfilled") {
      setGoal(goalResult.value);
      if (goalDraftRevision.current === undefined) {
        setObjective(goalResult.value.goal?.objective ?? "");
        setTokenBudget(goalResult.value.goal?.tokenBudget?.toString() ?? "");
      }
      setGoalError("");
    } else {
      setGoal(undefined);
      setGoalError(unavailable(goalResult.reason));
    }
  }, [applySettings, client, full, selected]);

  useEffect(() => {
    loadGeneration.current++;
    settingsDraftRevision.current = undefined;
    goalDraftRevision.current = undefined;
    revisionSeen.current = undefined;
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
  }, [selected, setResources]);

  useEffect(() => {
    if (!full || !selected || !online) {
      contextGeneration.current++;
      contextAbort.current?.abort();
      setContextLoading(false);
      return;
    }
    void load();
    void loadContext(contextLocation.current.id, contextLocation.current.names);
    // Re-read only the selected session after reconnect. Native changes arrive over SSE.
  }, [full, online, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (
      !full ||
      !selected ||
      !online ||
      live?.sessionId !== selected ||
      live.revision === undefined
    ) {
      if (revisionSeen.current !== undefined) loadGeneration.current++;
      revisionSeen.current = undefined;
      return;
    }
    const stamp = `${selected}:${live.revision}`;
    if (revisionSeen.current === stamp) return;
    const first = revisionSeen.current === undefined;
    revisionSeen.current = stamp;
    if (first) {
      lastNativeRead.current = Date.now();
      return;
    }
    // Coalesce selected-session SSE revisions, without another subscription or resource scan.
    const timer = window.setTimeout(
      () => {
        lastNativeRead.current = Date.now();
        const generation = ++loadGeneration.current;
        void Promise.allSettled([
          client.codexSessionSettings(selected),
          client.codexGoals(selected),
        ]).then(([nextSettings, nextGoal]) => {
          if (generation !== loadGeneration.current) return;
          if (nextSettings.status === "fulfilled") {
            applySettings(nextSettings.value);
            setSettingsError("");
          }
          if (nextGoal.status === "fulfilled") {
            setGoal(nextGoal.value);
            setGoalError("");
            if (goalDraftRevision.current === undefined) {
              setObjective(nextGoal.value.goal?.objective ?? "");
              setTokenBudget(nextGoal.value.goal?.tokenBudget?.toString() ?? "");
            }
          }
        });
      },
      Math.max(0, 2000 - (Date.now() - lastNativeRead.current)),
    );
    return () => window.clearTimeout(timer);
  }, [applySettings, client, full, live?.sessionId, live?.revision, online, selected]);

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
    const expected = pendingSettings.restoreDefaults
      ? {
          model: settings.defaults.modelId,
          effort: settings.defaults.effort,
          serviceTierId: settings.defaults.serviceTierId,
        }
      : pendingSettings;
    const confirmed =
      settings.applicationStatus !== "pending" &&
      settings.applicationStatus !== "unknown" &&
      (expected.model === undefined || settings.current.modelId === expected.model) &&
      (expected.effort === undefined || settings.current.effort === expected.effort) &&
      (expected.mode === undefined || settings.current.mode === expected.mode) &&
      (expected.policyId === undefined || settings.current.policyId === expected.policyId) &&
      (expected.serviceTierId === undefined ||
        settings.current.serviceTierId === expected.serviceTierId);
    if (confirmed) {
      setPendingSettings(undefined);
      setSaved(true);
    }
  }, [pendingSettings, settings]);

  async function mutate(
    name: CodexAction,
    fields: Omit<
      Partial<CodexActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    if (!full || saving) return;
    const readRevision = name === "settings" ? settings?.revision : goal?.revision;
    if (live?.revision !== undefined && readRevision !== live.revision) return;
    setSaving(true);
    setSaved(false);
    setMutationError("");
    try {
      const result = await codexAction(name, fields);
      if (result) {
        if (name === "settings") {
          setPendingSettings(fields);
          settingsDraftRevision.current = undefined;
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
  const feature = (name: string) =>
    (
      capabilities?.features as
        | Record<string, { available: boolean; reason?: string } | undefined>
        | undefined
    )?.[name];
  const selectedModel = settings?.options.models?.find((item) => item.id === model);
  const usage = settings?.usage;
  const usagePercent =
    usage?.available && usage.usedTokens !== undefined && usage.contextWindow !== undefined
      ? Math.max(
          0,
          Math.min(
            100,
            usage.percent ??
              (usage.contextWindow > 0 ? (usage.usedTokens / usage.contextWindow) * 100 : 0),
          ),
        )
      : undefined;
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
  const editSettings = () => {
    settingsDraftRevision.current ??= settings?.revision;
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
  const displayedSettings = settings?.selected ?? settings?.current;
  const modeOptions = settings?.options.collaborationModes ?? [];
  const modeWritable = settings?.writable.mode?.available && modeOptions.length > 0;
  const currentModel =
    settings?.options.models?.find((item) => item.id === displayedSettings?.modelId)?.name ??
    displayedSettings?.modelId;

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
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
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-w-0 flex-1 shrink justify-start px-2"
          disabled={disabled}
          onClick={() => setDialog("settings")}
        >
          <Settings2 className="hidden shrink-0 sm:block" size={16} />
          <span className="truncate">{currentModel || copy.conversationSettings}</span>
          {displayedSettings?.effort && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {term(displayedSettings.effort)}
            </span>
          )}
          {displayedSettings?.mode === "plan" && (
            <span className="shrink-0 text-xs text-muted-foreground">{copy.plan}</span>
          )}
          {settings?.applicationStatus === "pending" && (
            <span className="shrink-0 text-xs text-muted-foreground">{layout.nextTurn}</span>
          )}
          {settings?.applicationStatus === "unknown" && (
            <span className="shrink-0 text-xs text-muted-foreground">{layout.settingsUnknown}</span>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 px-2 text-xs"
          aria-label={copy.contextUsage}
          title={`${copy.contextUsage}: ${usage?.usedTokens?.toLocaleString() ?? "?"} / ${usage?.contextWindow?.toLocaleString() ?? "?"}`}
          onClick={() => setDialog("usage")}
        >
          <Gauge size={15} />
          <span>{usagePercent === undefined ? "?" : `${Math.round(usagePercent)}%`}</span>
        </Button>
        {action}
      </div>
      {goal?.goal && (
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-11 w-full justify-start overflow-hidden px-2 text-xs"
          aria-label={copy.goals}
          onClick={() => setDialog("goal")}
        >
          <Goal className="shrink-0" size={16} />
          <span className="shrink-0">{term(goal.goal.status)}</span>
          <span className="truncate">{goal.goal.objective}</span>
        </Button>
      )}
      {dialog === "usage" && (
        <Dialog
          panel
          title={copy.contextUsage}
          closeLabel={copy.close}
          onClose={() => setDialog(undefined)}
        >
          <p>
            {usagePercent === undefined
              ? copy.contextUnknown
              : `${usage?.usedTokens?.toLocaleString()} / ${usage?.contextWindow?.toLocaleString()} (${Math.round(usagePercent)}%)`}
          </p>
        </Dialog>
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
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        settingsDraftRevision.current = undefined;
                        setSettingsDirty(false);
                        applySettings(settings);
                      }}
                    >
                      {layout.reloadDraft}
                    </Button>
                  </div>
                )}
                {running && (
                  <p role="status" className="mb-3 text-xs text-muted-foreground">
                    {copy.settingsWhileRunning}
                  </p>
                )}
                {!running &&
                  feature("settings")?.available !== true &&
                  reasonDetail(feature("settings")?.reason)}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={settingDisabled || settingsChanged || settingsReadStale}
                    onClick={() =>
                      void mutate("settings", {
                        ...(model && settings.writable.model.available ? { model } : {}),
                        ...(effort && settings.writable.effort.available ? { effort } : {}),
                        ...(mode && modeWritable ? { mode } : {}),
                        ...(policy && settings.writable.policy.available
                          ? { policyId: policy }
                          : {}),
                        ...(serviceTier && settings.writable.serviceTier.available
                          ? { serviceTierId: serviceTier }
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
                {!settings.writable.restoreDefaults?.available &&
                  reasonDetail(settings.writable.restoreDefaults?.reason)}
              </>
            ) : undefined
          }
          title={copy.conversationSettings}
          closeLabel={copy.close}
          onClose={() => setDialog(undefined)}
        >
          {!settings?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.settingUnavailable}
              {reason(settings?.reason || settingsError)}
            </p>
          ) : (
            <section className="space-y-4">
              {usage?.available &&
              usage.usedTokens !== undefined &&
              usage.contextWindow !== undefined ? (
                <div className="space-y-1 rounded-lg border p-3 text-xs">
                  <div className="flex justify-between gap-3">
                    <span>{copy.contextUsage}</span>
                    <span>
                      {usage.usedTokens.toLocaleString()} / {usage.contextWindow.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${usagePercent}%` }} />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{copy.contextUnknown}</p>
              )}
              <label className="block space-y-1 text-sm">
                {copy.model}
                <select
                  className={selectClass}
                  value={model}
                  disabled={settingDisabled || !settings.writable.model?.available}
                  title={reasonTitle(settings.writable.model?.reason)}
                  onChange={(event) => {
                    editSettings();
                    const next = event.target.value;
                    const option = settings.options.models?.find((item) => item.id === next);
                    setModel(next);
                    if (!option?.efforts?.includes(effort)) setEffort(option?.defaultEffort ?? "");
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
                      editSettings();
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
                  {!!settings.options.policies?.find((item) => item.id === policy)?.description && (
                    <small className="block text-muted-foreground">
                      {settings.options.policies.find((item) => item.id === policy)?.description}
                    </small>
                  )}
                </label>
              </div>
              {feature("settings")?.available !== true && reasonDetail(feature("settings")?.reason)}
              {settings.applicationStatus === "pending" && (
                <p role="status" className="text-xs text-muted-foreground">
                  {layout.settingsPending}
                </p>
              )}
              {settingsReadStale && (
                <p role="status" className="text-xs text-muted-foreground">
                  {layout.connecting}
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
                ["paused", "blocked", "budgetLimited", "usageLimited"].includes(
                  goal.goal.status,
                ) ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      saving ||
                      goalReadStale ||
                      !goal.actions.resume?.available ||
                      feature("goal-resume")?.available !== true
                    }
                    title={reasonTitle(
                      goal.actions.resume?.reason || feature("goal-resume")?.reason,
                    )}
                    onClick={() => void mutate("goal-resume")}
                  >
                    {["budgetLimited", "usageLimited"].includes(goal.goal.status)
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
          {!goal?.available ? (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.goalUnavailable}
              {reason(goal?.reason || goalError)}
            </p>
          ) : (
            <section className="space-y-3">
              {goalReadStale && (
                <p role="status" className="text-xs text-muted-foreground">
                  {layout.connecting}
                </p>
              )}
              {goalChanged && (
                <div role="status" className="text-xs">
                  {layout.nativeChanged}
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
                  disabled={busy || saving}
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
                  disabled={busy || saving}
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
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-start"
              onClick={() => setDialog("goal")}
            >
              <Goal size={16} />
              {copy.goals}
            </Button>
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
