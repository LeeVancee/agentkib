import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, X } from "lucide-react";
import {
  ApiError,
  type ArtifactEntry,
  type ArtifactListing,
  type ArtifactTicket,
} from "@agentkib/web-client";
import { ArtifactPreview } from "./artifact-viewers";
import { Button } from "../../components/ui/button";
import { artifactCopy } from "./artifact-copy";
import { ArtifactPanel } from "./artifact-panel";
import { useSession } from "./session-context";

type Root = { id: string; name: string };
type Diff = {
  patch: string;
  binary: boolean;
  submodule: boolean;
  encoding_lossy: boolean;
  truncated: boolean;
};

export function ArtifactBrowser({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
} = {}) {
  const { client, access, current, selected, locale, embedded } = useSession();
  const copy = artifactCopy(locale);
  const titleId = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const open = (controlledOpen ?? localOpen) && Boolean(access?.device?.files);
  const setOpen = useCallback(
    (value: boolean) => {
      setLocalOpen(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const [roots, setRoots] = useState<Root[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tab, setTab] = useState<"files" | "artifacts" | "diff">("artifacts");
  const [listing, setListing] = useState<ArtifactListing>();
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [entry, setEntry] = useState<ArtifactEntry>();
  const [ticket, setTicket] = useState<ArtifactTicket>();
  const [download, setDownload] = useState<ArtifactTicket>();
  const [text, setText] = useState<string>();
  const [diff, setDiff] = useState<Diff | null>();
  const [kind, setKind] = useState("worktree");
  const [oid, setOid] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const media = useRef<HTMLMediaElement | null>(null);
  const playback = useRef({ time: 0, playing: false });
  const requests = useRef<AbortController | undefined>(undefined);
  const message = useCallback(
    (e: unknown) => (e instanceof ApiError && e.status === 403 ? copy.denied : copy.loadError),
    [copy],
  );
  const stopMedia = useCallback(() => {
    const player = media.current;
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
  }, []);
  const setMedia = useCallback(
    (node: HTMLMediaElement | null) => {
      if (media.current && media.current !== node) stopMedia();
      media.current = node;
    },
    [stopMedia],
  );
  const resetPreview = useCallback(() => {
    stopMedia();
    setEntry(undefined);
    setTicket(undefined);
    setDownload(undefined);
    setText(undefined);
    playback.current = { time: 0, playing: false };
  }, [stopMedia]);
  useEffect(() => () => stopMedia(), [stopMedia]);
  useEffect(() => {
    if (!access?.device?.files) setOpen(false);
  }, [access?.device?.files, setOpen]);
  useEffect(() => {
    if (!open) {
      generation.current++;
      requests.current?.abort();
      resetPreview();
      return;
    }
    const abort = new AbortController();
    void client
      .request<{ workspaces: Root[] }>("files/workspaces", undefined, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setRoots(result.workspaces);
        setWorkspaceId(
          result.workspaces.find((w) => w.id === current?.workspace_id)?.id ??
            result.workspaces[0]?.id ??
            "",
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [open, client, current?.workspace_id, resetPreview, message]);
  const load = useCallback(
    async (directoryId?: string, older?: string) => {
      requests.current?.abort();
      const abort = new AbortController();
      requests.current = abort;
      const g = ++generation.current;
      setLoading(true);
      setError("");
      resetPreview();
      try {
        const query = new URLSearchParams({ workspaceId });
        if (tab === "files") {
          if (directoryId) query.set("directoryId", directoryId);
          const result = await client.request<ArtifactListing>(
            `files/list?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) setListing(result);
        } else if (tab === "artifacts") {
          if (workspaceId !== current?.workspace_id) {
            setArtifacts([]);
            setCursor(undefined);
            return;
          }
          query.set("sessionId", selected);
          if (older) query.set("cursor", older);
          const result = await client.request<{ artifacts: ArtifactEntry[]; next_cursor?: string }>(
            `artifacts?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) {
            setArtifacts((old) =>
              older
                ? [...old, ...result.artifacts].filter(
                    (item, index, all) => all.findIndex((x) => x.id === item.id) === index,
                  )
                : result.artifacts,
            );
            setCursor(result.next_cursor);
          }
        } else {
          query.set("kind", kind);
          if (kind === "commit") {
            if (!/^[a-f0-9]{40,64}$/i.test(oid)) {
              setDiff(undefined);
              return;
            }
            query.set("oid", oid);
          }
          const result = await client.request<Diff | null>(
            `diff?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) setDiff(result);
        }
      } catch (e) {
        if (g === generation.current && !abort.signal.aborted) setError(message(e));
      } finally {
        if (g === generation.current) setLoading(false);
      }
    },
    [client, workspaceId, tab, current?.workspace_id, selected, kind, oid, resetPreview, message],
  );
  useEffect(() => {
    setListing(undefined);
    setArtifacts([]);
    setDiff(undefined);
    setCursor(undefined);
    if (open && workspaceId) void load();
    return () => {
      generation.current++;
      requests.current?.abort();
    };
  }, [open, workspaceId, tab, kind, selected, current?.workspace_id, load]);
  async function preview(item: ArtifactEntry) {
    if (item.kind === "directory") return load(item.id);
    requests.current?.abort();
    const abort = new AbortController();
    requests.current = abort;
    const g = ++generation.current;
    setLoading(true);
    setError("");
    resetPreview();
    setEntry(item);
    playback.current = { time: 0, playing: false };
    try {
      if (item.previewKind === "text") {
        const query = new URLSearchParams({
          workspaceId,
          artifactId: item.id,
          revision: item.revision,
        });
        const result = await client.request<{ text: string }>(
          `files/text?${query}`,
          undefined,
          abort.signal,
        );
        if (g === generation.current) setText(result.text);
      } else {
        const result = await client.request<ArtifactTicket>(
          "artifact-tickets",
          { workspaceId, artifactId: item.id },
          abort.signal,
        );
        if (g === generation.current) setTicket(result);
      }
    } catch (e) {
      if (g === generation.current && !abort.signal.aborted) setError(message(e));
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  // Renew only through the authenticated parent. The untrusted document never receives control credentials.
  useEffect(() => {
    if (!open || !ticket || !entry) return;
    const g = generation.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expiry = setTimeout(
      () => {
        if (g !== generation.current || abort.signal.aborted) return;
        abort.abort();
        clearTimeout(timer);
        setTicket(undefined);
        setError(copy.expired);
      },
      Math.max(0, ticket.expiresAt - Date.now()),
    );
    const renew = () => {
      void client
        .request<ArtifactTicket>(
          "artifact-tickets",
          { workspaceId, artifactId: entry.id },
          AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        )
        .then((result) => {
          if (g !== generation.current || abort.signal.aborted) return;
          if (result.revision !== ticket.revision) {
            setTicket(undefined);
            setError(copy.changed);
            return;
          }
          const player = media.current;
          if (player) playback.current = { time: player.currentTime, playing: !player.paused };
          setError("");
          setTicket(result);
        })
        .catch((e) => {
          if (!abort.signal.aborted && g === generation.current) {
            if (e instanceof ApiError && [401, 403, 404, 409, 410].includes(e.status)) {
              setTicket(undefined);
              setError(message(e));
            } else if (Date.now() < ticket.expiresAt) {
              // A temporary renewal failure does not invalidate an unexpired URL.
              timer = setTimeout(renew, Math.min(2000, ticket.expiresAt - Date.now()));
            }
          }
        });
    };
    timer = setTimeout(renew, Math.max(1000, ticket.expiresAt - Date.now() - 30_000));
    return () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      abort.abort();
    };
  }, [open, ticket, entry, workspaceId, client, copy, message]);
  async function downloadFile() {
    if (!entry) return;
    const g = generation.current;
    try {
      const result = await client.request<ArtifactTicket>(
        "artifact-tickets",
        {
          workspaceId,
          artifactId: entry.id,
          download: true,
        },
        requests.current?.signal,
      );
      if (g === generation.current) setDownload(result);
    } catch (e) {
      if (g === generation.current) setError(message(e));
    }
  }
  function restorePlayback() {
    const player = media.current;
    if (!player) return;
    player.currentTime = playback.current.time;
    if (playback.current.playing) void player.play().catch(() => {});
  }
  function backToList() {
    generation.current++;
    requests.current?.abort();
    resetPreview();
    setLoading(false);
    setError("");
  }
  if (!access?.device?.files) return null;
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" className="min-h-11" onClick={() => setOpen(true)}>
          <FolderOpen size={16} />
          {copy.title}
        </Button>
      )}
      {open && (
        <ArtifactPanel labelledBy={titleId} onClose={() => setOpen(false)}>
          <header className="flex shrink-0 items-center gap-2 border-b p-3">
            <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
              {copy.title}
            </h2>
            <Button
              variant="ghost"
              className="size-11 shrink-0"
              aria-label={copy.close}
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </Button>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <label className="block space-y-1 text-sm">
              <span>{copy.directory}</span>
              <select
                className="block min-h-11 w-full min-w-0 rounded border bg-background p-2"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {roots.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {!roots.length && <p className="text-sm">{copy.authorize}</p>}
            <div className="flex flex-wrap gap-1" role="group" aria-label={copy.views}>
              {(["artifacts", "files", "diff"] as const).map((value) => (
                <Button
                  key={value}
                  className="min-h-11 px-2"
                  variant={tab === value ? "default" : "outline"}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {copy[value]}
                </Button>
              ))}
            </div>
            {!entry && (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={loading || !workspaceId}
                onClick={() => void load(tab === "files" ? listing?.directoryId : undefined)}
              >
                {copy.refresh}
              </Button>
            )}
            {tab === "diff" && (
              <>
                <p className="text-xs text-muted-foreground">{copy.diffNote}</p>
                <select
                  aria-label={copy.diffKind}
                  className="min-h-11 w-full rounded border bg-background p-2"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="worktree">{copy.worktree}</option>
                  <option value="staged">{copy.staged}</option>
                  <option value="commit">{copy.commit}</option>
                </select>
                {kind === "commit" && (
                  <label className="block space-y-2 text-sm">
                    {copy.commitSha}
                    <input
                      className="block min-h-11 w-full rounded border bg-background p-2"
                      value={oid}
                      onChange={(e) => setOid(e.target.value)}
                    />
                    <Button
                      className="min-h-11"
                      disabled={loading || !oid}
                      onClick={() => void load()}
                    >
                      {copy.view}
                    </Button>
                  </label>
                )}
                {diff && (
                  <>
                    {(diff.binary || diff.submodule || diff.encoding_lossy || diff.truncated) && (
                      <p className="text-sm">{copy.partial}</p>
                    )}
                    <pre className="max-h-[60dvh] max-w-full overflow-auto rounded border p-3 text-xs">
                      {diff.patch || copy.noChanges}
                    </pre>
                  </>
                )}
                {diff === null && <p className="text-sm">{copy.noDiff}</p>}
              </>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
            {loading && (
              <p role="status" className="text-sm">
                {copy.loading}
              </p>
            )}
            {tab !== "diff" && !entry && (
              <div className="min-w-0 rounded border p-2">
                {tab === "files" && listing?.parentId && (
                  <Button
                    className="min-h-11"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => void load(listing.parentId)}
                  >
                    {copy.parent}
                  </Button>
                )}
                {(tab === "files" ? (listing?.entries ?? []) : artifacts).map((item) => (
                  <button
                    key={item.id}
                    disabled={loading}
                    className="block min-h-11 w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2"
                    title={item.name}
                    onClick={() => void preview(item)}
                  >
                    {item.kind === "directory" ? "📁 " : ""}
                    {item.name}
                  </button>
                ))}
                {!loading && !(tab === "files" ? listing?.entries.length : artifacts.length) && (
                  <p className="p-2 text-sm">{copy.empty}</p>
                )}
                {tab === "artifacts" && cursor && (
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void load(undefined, cursor)}
                  >
                    {copy.earlier}
                  </Button>
                )}
              </div>
            )}
            {tab !== "diff" && entry && (
              <div className="min-w-0 space-y-3 [&_audio]:max-w-full">
                <Button variant="ghost" className="min-h-11" onClick={backToList}>
                  <ArrowLeft size={16} />
                  {copy.back}
                </Button>
                <div className="space-y-2 text-sm">
                  <strong className="block break-all">{entry.name}</strong>
                  <span className="block text-xs text-muted-foreground">
                    {entry.mime} · {entry.size.toLocaleString()} B
                  </span>
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void downloadFile()}
                  >
                    {copy.prepareDownload}
                  </Button>
                  {download && (
                    <a
                      href={download.url}
                      download
                      target={embedded ? "_blank" : undefined}
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center px-3 underline"
                    >
                      {copy.download}
                    </a>
                  )}
                </div>
                <ArtifactPreview
                  entry={entry}
                  ticket={ticket}
                  text={text}
                  onMediaRef={setMedia}
                  onLoadedMetadata={restorePlayback}
                  onMediaError={() => setError(copy.mediaError)}
                  openLabel={copy.open}
                />
              </div>
            )}
          </div>
        </ArtifactPanel>
      )}
    </>
  );
}
