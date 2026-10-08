import { useMutation, useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { useEffect, useRef, useState } from "react";
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
  const queryClient = useOptionalQueryClient();
  const [directory, setDirectory] = useState<{ sessionId: string; id?: string }>();
  const [selection, setSelection] = useState<{ sessionId: string; item: ArtifactEntry }>();
  const directoryId = directory?.sessionId === sessionId ? directory.id : undefined;
  const item = selection?.sessionId === sessionId ? selection.item : undefined;
  const listingQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: ["claude-files", sessionId, directoryId],
      queryFn: async ({ signal }) => {
        const result = (await api.claudeRequest({
          operation: "files",
          sessionId,
          ...(directoryId ? { directoryId } : {}),
        })) as ArtifactListing;
        signal.throwIfAborted();
        return result;
      },
      staleTime: 0,
      gcTime: 0,
    },
    queryClient,
  );
  const textQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: ["claude-file-text", sessionId, item?.id, item?.revision],
      queryFn: async ({ signal }) => {
        const result = (await api.claudeRequest({
          operation: "file-text",
          sessionId,
          artifactId: item!.id,
          revision: item!.revision,
        })) as { id: string; name: string; text: string; revision: string };
        signal.throwIfAborted();
        if (result.id !== item!.id || result.revision !== item!.revision)
          throw new Error("artifact_revision_mismatch");
        return result;
      },
      enabled: item?.previewKind === "text",
      staleTime: Infinity,
      gcTime: 0,
    },
    queryClient,
  );
  // Preview tickets are an operation, not reusable file data.
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    return () => {
      epoch.current += 1;
    };
  }, [sessionId]);
  const previewMutation = useMutation(
    {
      mutationFn: async ({
        entry,
        owner,
        generation,
      }: {
        entry: ArtifactEntry;
        owner: string;
        generation: number;
      }) => {
        const ticket = (await api.claudeRequest({
          operation: "file-preview",
          sessionId: owner,
          artifactId: entry.id,
          revision: entry.revision,
          download: entry.previewKind === "download",
        })) as ArtifactTicket;
        if (generation === epoch.current) await api.openExternal(ticket.url);
      },
    },
    queryClient,
  );
  const listing = listingQuery.data;
  const preview = item?.previewKind === "text" ? textQuery.data : undefined;
  const busy =
    listingQuery.isFetching ||
    (item?.previewKind === "text" && textQuery.isFetching) ||
    previewMutation.isPending;
  const rawError =
    listingQuery.error ??
    (item?.previewKind === "text" ? textQuery.error : null) ??
    (previewMutation.variables?.owner === sessionId ? previewMutation.error : null);
  const error = rawError
    ? rawError instanceof Error
      ? rawError.message
      : "files_unavailable"
    : "";
  const load = async (nextId?: string) => {
    setSelection(undefined);
    previewMutation.reset();
    if (nextId === directoryId) await listingQuery.refetch({ cancelRefetch: false });
    else setDirectory({ sessionId, id: nextId });
  };
  async function open(entry: ArtifactEntry) {
    previewMutation.reset();
    if (entry.kind === "directory") {
      await load(entry.id);
      return;
    }
    setSelection({ sessionId, item: entry });
    if (entry.previewKind !== "text") {
      try {
        await previewMutation.mutateAsync({ entry, owner: sessionId, generation: epoch.current });
      } catch {
        /* Display mutation.error. */
      }
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
