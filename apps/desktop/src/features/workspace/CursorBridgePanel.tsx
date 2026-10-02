import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/core/api";
import type { CursorBridgeStatus, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { withAsyncCleanup } from "@/lib/utils";

export function CursorBridgePanel({
  workspace,
  bindingId,
  disabled,
  onBindingChange,
  onStatusChange,
  fixedBinding = false,
}: {
  workspace: WorkspaceSummary;
  bindingId: string;
  disabled: boolean;
  onBindingChange(id: string): void;
  onStatusChange(status: CursorBridgeStatus | undefined): void;
  fixedBinding?: boolean;
}) {
  const { tr, localizeMessage } = useI18n();
  const [status, setStatus] = useState<CursorBridgeStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>("");
  const [challenge, setChallenge] = useState<{
    value: string;
    expires: number;
    before: string[];
  }>();
  const [seconds, setSeconds] = useState(0);
  const [bundleVersion, setBundleVersion] = useState("");
  const active = useRef(true);
  const pendingRef = useRef(false);
  const requestId = useRef(0);
  const statusChange = useRef(onStatusChange);
  useEffect(() => {
    statusChange.current = onStatusChange;
  }, [onStatusChange]);
  const refresh = useCallback(async () => {
    const generation = ++requestId.current;
    const next = await api.cursorBridge({ action: "status", workspaceId: workspace.id });
    if (!active.current || requestId.current !== generation) return;
    if (!("bindings" in next)) throw new Error("Invalid Cursor bridge status");
    setStatus(next);
    statusChange.current(next);
    setChallenge((current) =>
      current &&
      next.bindings.some((binding) => binding.connected && !current.before.includes(binding.id))
        ? undefined
        : current,
    );
  }, [workspace.id]);

  useEffect(() => {
    active.current = true;
    statusChange.current(undefined);
    if (!workspace.remote)
      void refresh().catch((reason) => {
        if (active.current) setError(reason);
      });
    return () => {
      active.current = false;
      requestId.current += 1;
    };
  }, [refresh, workspace.remote]);

  useEffect(() => {
    if (!challenge) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((challenge.expires - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) setChallenge(undefined);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const poll = window.setInterval(() => {
      void refresh().catch((reason) => {
        if (active.current) setError(reason);
      });
    }, 2000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(poll);
    };
  }, [challenge, refresh]);

  const act = async (action: () => Promise<void>) => {
    if (pendingRef.current || disabled || workspace.remote) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await action();
        } catch (reason) {
          if (active.current) setError(reason);
        }
      },
      () => {
        pendingRef.current = false;
        if (active.current) setPending(false);
      },
    );
  };
  const connect = (selectedId?: string) =>
    act(async () => {
      const next = await api.cursorBridge({
        action: "connect",
        workspaceId: workspace.id,
        ...(selectedId ? { bindingId: selectedId } : {}),
      });
      if (!active.current) return;
      if (!("challenge" in next)) throw new Error("Invalid Cursor bridge connection response");
      setChallenge({
        value: next.challenge,
        expires: Date.now() + Math.min(next.expires_in_seconds, 120) * 1000,
        before: status?.bindings.filter((b) => b.connected).map((b) => b.id) ?? [],
      });
    });
  const reveal = () =>
    act(async () => {
      const bundle = await api.cursorBridgeBundle();
      await api.revealCursorBridgeBundle();
      if (active.current) setBundleVersion(bundle.version);
    });
  const selected = status?.bindings.find((binding) => binding.id === bindingId);

  return (
    <div className="col-span-full grid gap-3 rounded-lg border border-border p-3 text-xs">
      <p className="m-0 text-muted-foreground">{tr("handoff.cursor.install")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || pending || !!workspace.remote}
          onClick={() => void reveal()}
        >
          {tr("handoff.cursor.revealBundle")}
        </Button>
        {!fixedBinding && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending || !status?.supported}
            onClick={() => void connect()}
          >
            {tr("handoff.cursor.connect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || pending || !!workspace.remote}
          onClick={() => void act(refresh)}
        >
          {tr("handoff.cursor.refresh")}
        </Button>
      </div>
      {bundleVersion && (
        <span>{tr("handoff.cursor.bundleVerified", { version: bundleVersion })}</span>
      )}
      {status && !status.supported && (
        <p className="m-0 text-muted-foreground">{tr("handoff.cursor.platformUnavailable")}</p>
      )}
      {workspace.remote && (
        <p className="m-0 text-muted-foreground">{tr("handoff.cursor.localOnly")}</p>
      )}
      {challenge && (
        <div className="grid gap-2 rounded-md bg-muted/40 p-3">
          <span>{tr("handoff.cursor.challengeInstruction", { seconds })}</span>
          <Textarea
            readOnly
            aria-label={tr("handoff.cursor.challenge")}
            className="font-mono text-xs"
            value={challenge.value}
            spellCheck={false}
          />
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={disabled || pending}
            onClick={() =>
              void act(async () => {
                if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                await navigator.clipboard.writeText(challenge.value);
              })
            }
          >
            {tr("handoff.cursor.copyChallenge")}
          </Button>
        </div>
      )}
      <Label className="grid gap-1.5 text-xs text-muted-foreground">
        {tr("handoff.cursor.window")}
        <Select
          value={bindingId || null}
          disabled={disabled || pending || !status?.supported || fixedBinding}
          onValueChange={(value) => {
            if (value !== null) onBindingChange(String(value));
          }}
        >
          <SelectTrigger aria-label={tr("handoff.cursor.window")}>
            <SelectValue>
              {selected
                ? `${selected.profile} · ${selected.id.slice(0, 8)} · Cursor ${selected.version}`
                : tr("handoff.cursor.selectWindow")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {status?.bindings.map((binding) => (
              <SelectItem key={binding.id} value={binding.id}>
                {binding.profile} · {binding.id.slice(0, 8)} · Cursor {binding.version} ·{" "}
                {tr(binding.connected ? "handoff.cursor.connected" : "handoff.cursor.disconnected")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <span className="break-all text-muted-foreground">
        {tr("handoff.cursor.boundWorkspace", { path: workspace.path })}
      </span>
      {selected && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || pending}
            onClick={() => void connect(selected.id)}
          >
            {tr("handoff.cursor.reconnect")}
          </Button>
          {!fixedBinding && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() =>
                void act(async () => {
                  await api.cursorBridge({
                    action: "disconnect",
                    workspaceId: workspace.id,
                    bindingId: selected.id,
                  });
                  await refresh();
                })
              }
            >
              {tr("handoff.cursor.disconnect")}
            </Button>
          )}
        </div>
      )}
      {error !== "" && (
        <p role="alert" className="m-0 text-destructive">
          {localizeMessage(error)}
        </p>
      )}
    </div>
  );
}
