import { useEffect, useRef, useState } from "react";
import type { ClaudeBridgeChallenge, ClaudeBridgeStatus } from "../../../../../../electron/api";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { useSession } from "./session-context";
import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";

function statusResponse(value: unknown, sessionId: string): ClaudeBridgeStatus {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    value.sessionId !== sessionId
  )
    throw new Error("invalid_bridge_status");
  const row = value as Record<string, unknown>;
  if (
    typeof row.supported !== "boolean" ||
    typeof row.connected !== "boolean" ||
    typeof row.version !== "string" ||
    typeof row.pluginDirectory !== "string" ||
    typeof row.installInstructions !== "string"
  )
    throw new Error("invalid_bridge_status");
  return value as ClaudeBridgeStatus;
}
function challengeResponse(value: unknown): ClaudeBridgeChallenge {
  if (!value || typeof value !== "object") throw new Error("invalid_bridge_challenge");
  const row = value as Record<string, unknown>;
  if (
    typeof row.challenge !== "string" ||
    !row.challenge ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    typeof row.instructions !== "string"
  )
    throw new Error("invalid_bridge_challenge");
  return value as ClaudeBridgeChallenge;
}

/** Local owner IPC only; no connection credentials or paths are accepted from Web. */
export function ClaudeBridgePanel({ active }: { active: boolean }) {
  const session = useSession();
  const { selected, current, live, access, online, controlReady, busy, locale, notice } = session;
  const copy = claudeConnectionCopy[locale];
  const [status, setStatus] = useState<ClaudeBridgeStatus>();
  const [challenge, setChallenge] = useState<
    ClaudeBridgeChallenge & {
      sessionId: string;
      connectionGeneration?: string;
    }
  >();
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const canRevoke = !!(
    active &&
    selected &&
    current?.id === selected &&
    current.agent === "claude-code" &&
    access?.status === "approved" &&
    access.protocolVersion === 2 &&
    access.device?.manage &&
    online
  );
  const canManage = !!(
    canRevoke &&
    access?.experimentalEnabled &&
    controlReady &&
    !busy &&
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown"
  );
  useEffect(() => {
    const request = ++generation.current;
    pending.current = false;
    setChallenge(undefined);
    setStatus(undefined);
    setExpired(false);
    setError(false);
    setLoading(false);
    if (!canManage) return;
    setLoading(true);
    void Promise.resolve()
      .then(() => desktopApi().claude.request({ operation: "bridge-status", sessionId: selected }))
      .then((value) => {
        if (generation.current === request) setStatus(statusResponse(value, selected));
      })
      .catch(() => {
        if (generation.current === request) setError(true);
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [canManage, selected, live?.connectionGeneration, revision]);
  useEffect(() => {
    if (!challenge) return;
    const expires = Date.parse(challenge.expiresAt);
    const timer = window.setTimeout(
      () => {
        setChallenge(undefined);
        setExpired(true);
      },
      Math.max(0, Math.min(expires - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [challenge]);
  async function run(operation: "bridge-challenge" | "bridge-disconnect") {
    if (
      (operation === "bridge-challenge"
        ? !canManage || status?.sessionId !== selected || !status.supported
        : !canRevoke) ||
      loading ||
      pending.current
    )
      return;
    pending.current = true;
    const request = generation.current;
    setLoading(true);
    setError(false);
    setChallenge(undefined);
    setExpired(false);
    try {
      const result = await desktopApi().claude.request({ operation, sessionId: selected });
      if (generation.current !== request) return;
      if (operation === "bridge-challenge")
        setChallenge({
          ...challengeResponse(result),
          sessionId: selected,
          connectionGeneration: live?.connectionGeneration,
        });
      else {
        if (
          !result ||
          typeof result !== "object" ||
          !("disconnected" in result) ||
          result.disconnected !== true
        )
          throw new Error("invalid_bridge_disconnect");
        setRevision((value) => value + 1);
        void session.refresh(true);
      }
    } catch {
      if (generation.current === request) setError(true);
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setLoading(false);
      }
    }
  }
  if (!active || current?.agent !== "claude-code" || !access?.device?.manage) return null;
  return (
    <section className="space-y-3 border-b pb-4" aria-label={copy.title}>
      <h3 className="font-medium">{copy.title}</h3>
      <p className="text-sm text-muted-foreground">{copy.instructions}</p>
      {status?.sessionId === selected && canManage && (
        <>
          <p role="status">
            {status.connected ? copy.connected : copy.history} · Claude Code {status.version}
          </p>
          <p className="text-xs text-muted-foreground">
            {claudeConnectionReason(locale, status.reason)}
          </p>
          <pre className="select-text whitespace-pre-wrap break-all text-xs">
            {status.installInstructions}
          </pre>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!canManage || !status?.supported || loading}
          onClick={() => void run("bridge-challenge")}
        >
          {copy.generate}
        </Button>
        <Button
          variant="outline"
          disabled={!canRevoke || loading}
          onClick={() => void run("bridge-disconnect")}
        >
          {copy.disconnect}
        </Button>
        <Button
          variant="ghost"
          disabled={!canManage || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {copy.refresh}
        </Button>
      </div>
      {loading && <p role="status">{copy.loading}</p>}
      {error && <p role="alert">{copy.failed}</p>}
      {challenge &&
        canManage &&
        challenge.sessionId === selected &&
        challenge.connectionGeneration === live?.connectionGeneration && (
          <div className="space-y-2 rounded-md border p-3">
            <pre className="select-text whitespace-pre-wrap break-all text-xs">
              {challenge.instructions}
            </pre>
            <code className="select-text break-all">{challenge.challenge}</code>
            <p className="text-xs text-muted-foreground">
              {copy.expires} {new Date(challenge.expiresAt).toLocaleTimeString(locale)}
            </p>
          </div>
        )}
      {expired && <p role="status">{copy.expired}</p>}
    </section>
  );
}
