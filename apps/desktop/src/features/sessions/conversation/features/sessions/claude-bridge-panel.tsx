import { useEffect, useRef, useState } from "react";
import type { ClaudeBridgeChallenge, ClaudeBridgeStatus } from "../../../../../../electron/api";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { Dialog } from "../../components/dialog";
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
    typeof row.installInstructions !== "string" ||
    (row.connectionError !== undefined && typeof row.connectionError !== "string")
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const copyRequest = useRef(0);
  const pending = useRef(false);
  const lastConnected = useRef(false);
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
  // A status refresh or a busy/idle transition must not revoke a displayed code.
  useEffect(() => {
    generation.current++;
    pending.current = false;
    lastConnected.current = false;
    setChallenge(undefined);
    setStatus(undefined);
    setExpired(false);
    setError(false);
    setLoading(false);
    setConfirmDisconnect(false);
    setCopied("");
    setCopyError(false);
    return () => {
      generation.current++;
    };
  }, [canRevoke, selected]);
  useEffect(() => {
    if (!canManage) return;
    const request = generation.current;
    let disposed = false;
    let checking: number | undefined;
    async function check(showLoading: boolean) {
      if (
        (checking !== undefined && checking === statusRequest.current) ||
        pending.current ||
        disposed
      )
        return;
      const query = ++statusRequest.current;
      checking = query;
      const isCurrent = () =>
        !disposed && generation.current === request && statusRequest.current === query;
      if (showLoading) setLoading(true);
      try {
        const result = statusResponse(
          await desktopApi().claude.request({ operation: "bridge-status", sessionId: selected }),
          selected,
        );
        if (isCurrent()) {
          setStatus(result);
          setError(false);
          if (result.connected) {
            setChallenge(undefined);
            setExpired(false);
            if (!lastConnected.current) void session.refresh(true);
          }
          lastConnected.current = result.connected;
        }
      } catch {
        if (isCurrent()) {
          setStatus(undefined);
          setError(true);
        }
      } finally {
        if (checking === query) checking = undefined;
        if (isCurrent() && showLoading) setLoading(false);
      }
    }
    void check(true);
    // Keep observing after code expiry so failed connection attempts remain visible.
    const timer = window.setInterval(() => void check(false), 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (!pending.current) setLoading(false);
    };
  }, [canManage, selected, live?.connectionGeneration, revision]);
  const connected =
    (status?.sessionId === selected && status.connected) ||
    (live?.sessionId === selected &&
      live.executionMode === "claude-follower" &&
      live.status !== "unsupported" &&
      live.reason !== "claude-bridge-disconnected");
  const hasBinding =
    connected || (live?.sessionId === selected && live.executionMode === "claude-follower");
  async function copyText(value: string, label: string) {
    const request = ++copyRequest.current;
    const scope = generation.current;
    setCopied("");
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      if (generation.current === scope && copyRequest.current === request) setCopied(label);
    } catch {
      if (generation.current === scope && copyRequest.current === request) {
        setCopied("");
        setCopyError(true);
      }
    }
  }
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
        ? !canManage || status?.sessionId !== selected || !status.supported || connected
        : !canRevoke || !hasBinding) ||
      loading ||
      pending.current
    )
      return;
    // A lookup started before this operation cannot describe its connection code or result.
    statusRequest.current++;
    pending.current = true;
    const request = generation.current;
    setLoading(true);
    setError(false);
    setStatus((value) => (value ? { ...value, connectionError: undefined } : value));
    copyRequest.current++;
    setCopied("");
    setCopyError(false);
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
        lastConnected.current = false;
        setConfirmDisconnect(false);
        setStatus((value) => (value ? { ...value, connected: false } : value));
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
            {status.connected ? copy.connected : copy.history} · {copy.requiredVersion}{" "}
            {status.version}
          </p>
          <p className="text-xs text-muted-foreground">
            {claudeConnectionReason(locale, status.reason)}
          </p>
          <pre className="select-text whitespace-pre-wrap break-all text-xs">
            {status.installInstructions}
          </pre>
          <Button
            variant="outline"
            onClick={() => void copyText(status.installInstructions, copy.copyInstall)}
          >
            {copy.copyInstall}
          </Button>
          {status.connectionError && (
            <p role="alert">
              {copy.connectionFailed}
              {(status.connectionError === "control-outcome-unconfirmed"
                ? copy.connectionUnconfirmed
                : claudeConnectionReason(locale, status.connectionError)) ?? copy.failed}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!canManage || !status?.supported || connected || loading}
          onClick={() => void run("bridge-challenge")}
        >
          {copy.generate}
        </Button>
        <Button
          variant="outline"
          disabled={!canRevoke || !hasBinding || loading}
          onClick={() => setConfirmDisconnect(true)}
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
      {connected && <p className="text-xs text-muted-foreground">{copy.disconnectBeforeCode}</p>}
      <p className="text-xs text-muted-foreground">{copy.disconnectInfo}</p>
      {confirmDisconnect && (
        <Dialog
          title={copy.disconnect}
          description={copy.disconnectInfo}
          closeLabel={copy.cancel}
          onClose={() => {
            if (!pending.current) setConfirmDisconnect(false);
          }}
        >
          <Button variant="outline" disabled={loading} onClick={() => setConfirmDisconnect(false)}>
            {copy.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={loading || !canRevoke || !hasBinding}
            onClick={() => void run("bridge-disconnect")}
          >
            {copy.confirmDisconnect}
          </Button>
        </Dialog>
      )}
      {copied && (
        <p role="status">
          {copied} · {copy.copied}
        </p>
      )}
      {copyError && <p role="alert">{copy.copyFailed}</p>}
      {loading && <p role="status">{copy.loading}</p>}
      {error && <p role="alert">{copy.failed}</p>}
      {challenge && canRevoke && challenge.sessionId === selected && (
        <div className="space-y-2 rounded-md border p-3">
          <pre className="select-text whitespace-pre-wrap break-all text-xs">
            {challenge.instructions}
          </pre>
          <Button
            variant="outline"
            onClick={() => void copyText(challenge.instructions, copy.copyCommand)}
          >
            {copy.copyCommand}
          </Button>
          <code className="select-text break-all">{challenge.challenge}</code>
          <Button
            variant="outline"
            onClick={() => void copyText(challenge.challenge, copy.copyCode)}
          >
            {copy.copyCode}
          </Button>
          <p className="text-xs text-muted-foreground">{copy.codeSafety}</p>
          <p className="text-xs text-muted-foreground">
            {copy.expires} {new Date(challenge.expiresAt).toLocaleTimeString(locale)}
          </p>
        </div>
      )}
      {expired && <p role="status">{copy.expired}</p>}
    </section>
  );
}
