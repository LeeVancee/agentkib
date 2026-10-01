import { useCallback, useEffect, useRef, useState } from "octane";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactTicket,
} from "../../../../../packages/web-client/src/index";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";

/** Workspace-scoped opaque IDs only; executable previews open outside Electron. */
export function ClaudeFilesPanel({ sessionId }: { sessionId: string }) {
  const { locale } = useI18n();
  const text = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const [listing, setListing] = useState<ArtifactListing>();
  const [preview, setPreview] = useState<{ name: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const load = useCallback(
    async (directoryId?: string) => {
      const generation = ++epoch.current;
      setBusy(true);
      setPreview(undefined);
      setError("");
      try {
        const value = (await api.claudeRequest({
          operation: "files",
          sessionId,
          ...(directoryId ? { directoryId } : {}),
        })) as ArtifactListing;
        if (generation === epoch.current) setListing(value);
      } catch (e) {
        if (generation === epoch.current)
          setError(e instanceof Error ? e.message : "files_unavailable");
      } finally {
        if (generation === epoch.current) setBusy(false);
      }
    },
    [sessionId],
  );
  useEffect(() => {
    setListing(undefined);
    void load();
    return () => {
      epoch.current++;
    };
  }, [load]);
  async function open(item: ArtifactEntry) {
    if (item.kind === "directory") {
      await load(item.id);
      return;
    }
    const generation = ++epoch.current;
    setBusy(true);
    setPreview(undefined);
    setError("");
    try {
      if (item.previewKind === "text") {
        const value = (await api.claudeRequest({
          operation: "file-text",
          sessionId,
          artifactId: item.id,
          revision: item.revision,
        })) as { id: string; name: string; text: string; revision: string };
        if (
          generation === epoch.current &&
          value.id === item.id &&
          value.revision === item.revision
        )
          setPreview(value);
      } else {
        const ticket = (await api.claudeRequest({
          operation: "file-preview",
          sessionId,
          artifactId: item.id,
          revision: item.revision,
          download: item.previewKind === "download",
        })) as ArtifactTicket;
        if (generation === epoch.current) await api.openExternal(ticket.url);
      }
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "preview_unavailable");
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section
      className="rounded border p-3 space-y-2"
      aria-label={text("文件与产物", "Files and artifacts")}
    >
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || !listing?.parentId}
          onClick={() => void load(listing?.parentId)}
        >
          {text("上级目录", "Parent directory")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void load(listing?.directoryId)}>
          {text("刷新文件", "Refresh files")}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{text("正在读取", "Loading")}</p>}
      <ul className="max-h-48 overflow-y-auto">
        {listing?.entries.map((item) => (
          <li key={item.id}>
            <Button variant="ghost" disabled={busy} onClick={() => void open(item)}>
              {item.kind === "directory" ? "📁 " : ""}
              {item.name}
            </Button>
          </li>
        ))}
      </ul>
      {listing && !listing.entries.length && <p>{text("此目录为空", "This directory is empty")}</p>}
      {preview && (
        <div>
          <strong>{preview.name}</strong>
          <pre className="max-h-64 whitespace-pre-wrap break-words overflow-auto text-xs">
            {preview.text}
          </pre>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {text(
          "HTML 和媒体通过隔离的浏览器预览打开。",
          "HTML and media open in an isolated browser preview.",
        )}
      </p>
    </section>
  );
}
