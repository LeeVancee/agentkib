import { useEffect, useRef, useState } from "octane";
import { ArrowUp, Square, X } from "@octanejs/lucide";
import { type UploadedAttachment } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "./session-context";
import { sessionDisplayState } from "./session-display-state";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopy } from "./codex-copy";
import { isValidMessage, MAX_MESSAGE_LENGTH } from "./session-model";
import { CodexComposerControls, type CodexResource } from "./codex-session-controls";

type Upload = {
  key: string;
  name: string;
  percent: number;
  result?: UploadedAttachment;
  failed?: boolean;
};
export function CodexComposer() {
  const session = useSession();
  const {
    selected,
    current,
    live,
    client,
    access,
    locale,
    t,
    message,
    setMessage,
    control,
    codexAction,
    capabilities,
    canSend,
    canStop,
    busy,
    online,
    controlReady,
    notice,
  } = session;
  const isClaude = current?.agent === "claude-code";
  const copy = codexCopy[locale];
  const layout = composerLayoutCopy[locale];
  const display = sessionDisplayState(session);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(160, Math.max(64, textarea.current.scrollHeight))}px`;
  }, [message]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [resources, setResources] = useState<CodexResource[]>([]);
  const active = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement | null>(null);
  const count = useRef(0);
  const uploadPermission = !!(
    access?.device?.attachments &&
    capabilities?.sessionId === selected &&
    capabilities.features.attachments?.available
  );
  useEffect(() => {
    const controllers = active.current;
    setUploads([]);
    setResources([]);
    setSubmitted(false);
    setError("");
    count.current = 0;
    return () => {
      for (const abort of controllers.values()) abort.abort();
      controllers.clear();
    };
  }, [selected]);
  useEffect(() => {
    if (access?.device?.attachments) return;
    for (const abort of active.current.values()) abort.abort();
    active.current.clear();
    count.current = 0;
    setUploads([]);
  }, [access?.device?.attachments]);
  useEffect(() => {
    if (!submitted) return;
    if (notice === "accepted") {
      setUploads([]);
      setResources([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    } else if (notice === "notDispatched") setSubmitted(false);
  }, [notice, submitted, setMessage]);
  async function add(files: File[]) {
    if (!uploadPermission || busy || submitted) return;
    setError("");
    for (const file of files) {
      if (count.current >= 10) {
        setError(copy.limit);
        break;
      }
      count.current++;
      const key = crypto.randomUUID();
      const abort = new AbortController();
      active.current.set(key, abort);
      setUploads((items) => [...items, { key, name: file.name, percent: 0 }]);
      void client
        .uploadAttachment(
          selected,
          file,
          (percent) =>
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent } : item)),
            ),
          abort.signal,
        )
        .then((result) => {
          if (!abort.signal.aborted)
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent: 100, result } : item)),
            );
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, failed: true } : item)),
            );
            setError(copy.uploadFailed);
          }
        })
        .finally(() => active.current.delete(key));
    }
  }
  async function remove(item: Upload) {
    active.current.get(item.key)?.abort();
    active.current.delete(item.key);
    count.current = Math.max(0, count.current - 1);
    setUploads((items) => items.filter((entry) => entry.key !== item.key));
    if (item.result) {
      try {
        await client.request("attachments/delete", {
          sessionId: selected,
          attachmentId: item.result.id,
          version: item.result.version,
        });
      } catch {
        setError(copy.error);
      }
    }
  }
  const ready = uploads.every((item) => !!item.result);
  const attachmentIds = uploads.flatMap((item) => (item.result ? [item.result.id] : []));
  const resourceIds = resources.map((item) => item.id);
  const valid = ready && isValidMessage(message, attachmentIds.length > 0);
  const resourceNeedsMessage = resourceIds.length > 0 && !message.trim() && !attachmentIds.length;
  async function send(action: "send" | "steer" | "queue-add") {
    if (!valid || busy || submitted) return;
    setSubmitted(true);
    const result =
      action === "send"
        ? await control("send", undefined, undefined, undefined, undefined, {
            attachmentIds,
            ...(resourceIds.length ? { resourceIds } : {}),
          })
        : await codexAction(action, {
            text: message.trim(),
            ...(attachmentIds.length ? { attachmentIds } : {}),
            ...(resourceIds.length ? { resourceIds } : {}),
            ...(action === "steer" ? { turnId: live?.turnId } : {}),
          });
    if (result) {
      setUploads([]);
      setResources([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    }
  }
  const running = live?.status === "running";
  const canAdvanced = !!(access?.device?.advancedControl && controlReady && online && !busy);
  const primaryAction = canStop ? (
    <Button
      type="button"
      variant="destructive"
      className="size-11 shrink-0 p-0"
      aria-label={t.stop}
      onClick={() => void control("stop")}
    >
      <Square size={17} />
    </Button>
  ) : (
    <Button
      className="size-11 shrink-0 p-0"
      aria-label={t.send}
      disabled={!canSend || !valid || submitted}
    >
      <ArrowUp size={20} />
    </Button>
  );
  return (
    <form
      className="mx-2 mb-[max(.5rem,env(safe-area-inset-bottom))] mt-2 w-[calc(100%-1rem)] max-w-3xl shrink-0 self-center space-y-2 rounded-2xl border bg-card p-2 shadow-sm md:mx-4 md:mb-4 md:w-[calc(100%-2rem)] md:p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void send("send");
      }}
    >
      {isClaude && (live?.model || live?.cliVersion) && (
        <p className="px-1 text-xs text-muted-foreground">
          {[live.model, live.cliVersion && `Claude Code ${live.cliVersion}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      <label className="sr-only" htmlFor="message">
        {t.message}
      </label>
      <Textarea
        ref={textarea}
        id="message"
        className="min-h-16 max-h-40 resize-none overflow-y-auto border-0 shadow-none"
        value={message}
        maxLength={MAX_MESSAGE_LENGTH}
        onChange={(event) => setMessage(event.currentTarget.value)}
        placeholder={t.message}
        disabled={!online || busy || submitted}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length && uploadPermission) {
            event.preventDefault();
            void add(files);
          }
        }}
      />
      {uploads.length > 0 && (
        <ul className="space-y-2">
          {uploads.map((item) => (
            <li key={item.key} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span role="status">
                {item.failed
                  ? copy.uploadFailed
                  : item.result
                    ? "100%"
                    : `${copy.uploading} ${item.percent}%`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-11 shrink-0 p-0"
                aria-label={`${copy.remove}: ${item.name}`}
                disabled={busy || submitted}
                onClick={() => void remove(item)}
              >
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {resourceNeedsMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {layout.resourceNeedsMessage}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="space-y-2">
        <input
          ref={fileInput}
          className="hidden"
          type="file"
          multiple
          aria-label={copy.attachment}
          disabled={!uploadPermission || busy || submitted}
          onChange={(event) => {
            void add(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        {!isClaude && (
          <CodexComposerControls
            resources={resources}
            setResources={setResources}
            openPhoneFiles={() => fileInput.current?.click()}
            disabled={busy || submitted || !online}
            action={primaryAction}
          />
        )}
        {(isClaude || access?.device?.accessMode !== "full") && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={!uploadPermission || busy || submitted}
              title={
                uploadPermission
                  ? copy.attachmentNote
                  : capabilities?.features.attachments?.reason || copy.permission
              }
              onClick={() => fileInput.current?.click()}
            >
              {copy.attachment}
            </Button>
            {primaryAction}
          </div>
        )}
        {running && !isClaude && (
          <div className="space-y-2 border-t pt-2">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                variant="outline"
                disabled={
                  !canAdvanced || !capabilities?.features.steer?.available || !valid || submitted
                }
                onClick={() => void send("steer")}
              >
                {copy.steer}
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                variant="outline"
                disabled={
                  !canAdvanced ||
                  !capabilities?.features["queue-add"]?.available ||
                  !valid ||
                  submitted
                }
                onClick={() => void send("queue-add")}
              >
                {copy.queueAdd}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{layout.queue}</p>
          </div>
        )}
      </div>
      {!canSend && !running && (
        <p role="status" className="px-1 text-xs leading-5 text-muted-foreground">
          {display.reason}
        </p>
      )}
      {!isClaude && access?.device?.accessMode !== "full" && (
        <details className="px-1 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer content-center">{layout.help}</summary>
          <p className="pb-2 leading-5">{copy.composerHint}</p>
        </details>
      )}
    </form>
  );
}
