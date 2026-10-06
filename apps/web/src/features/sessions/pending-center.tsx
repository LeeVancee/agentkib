import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useSessionNavigate } from "./session-navigation";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import {
  pendingScope,
  readPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";
import { codexCopy } from "./codex-copy";
import { catalogCopy } from "../catalog/catalog-copy";

export function PendingCenter({ compact = false }: { compact?: boolean }) {
  const {
    access,
    origin,
    sessions,
    excludedSessionIds,
    selected,
    live,
    pendingSessions,
    locale,
    t,
    setModal,
    refresh,
  } = useSession();
  const copy = codexCopy[locale];
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<PendingControl[]>([]);
  const [failed, setFailed] = useState(false);
  const navigate = useSessionNavigate();
  useEffect(() => {
    if (access?.status !== "approved" || !access.device?.id) {
      setSaved([]);
      return;
    }
    const scope = pendingScope(origin, access.device.id);
    const read = () => {
      try {
        setSaved(readPending(scope));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    read();
    return subscribePending(read);
  }, [origin, access?.status, access?.device?.id, open, live?.revision]);
  if (access?.status !== "approved") return null;
  const pendingIds = new Set([
    ...Object.keys(pendingSessions).filter((id) => pendingSessions[id]),
    ...saved.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
  ]);
  const interactions = sessions.some(
    (session) => session.id === selected && session.availability === "readable",
  )
    ? [...(live?.approvals ?? []), ...(live?.questions ?? [])]
    : [];
  if (interactions.length && selected) pendingIds.add(selected);
  return (
    <>
      <Button
        data-conversation-pending-trigger
        variant="ghost"
        className={compact ? "relative size-11 p-0" : "min-h-11"}
        aria-label={`${copy.pending}${pendingIds.size ? ` (${pendingIds.size})` : ""}`}
        onClick={() => setOpen(true)}
      >
        {compact ? <Bell size={18} /> : copy.pending}
        {pendingIds.size > 0 && (
          <span
            className={
              compact
                ? "absolute right-0 top-0 rounded-full bg-primary px-1 text-xs text-primary-foreground"
                : ""
            }
          >
            {pendingIds.size}
          </span>
        )}
      </Button>
      {open && (
        <Dialog panel title={copy.pending} closeLabel={copy.close} onClose={() => setOpen(false)}>
          <p className="text-xs text-muted-foreground">{copy.pendingInfo}</p>
          {failed && <p role="alert">{copy.error}</p>}
          {!pendingIds.size && !saved.length && <p>{copy.pendingEmpty}</p>}
          {Array.from(pendingIds).map((id) => (
            <section key={id} className="space-y-2 rounded border p-3">
              {excludedSessionIds?.has(id) ? (
                <p className="text-xs text-muted-foreground">
                  {catalogCopy[locale].excludedPending}
                </p>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
                  }}
                >
                  {sessions.find((item) => item.id === id)?.title || t.untitled}
                </Button>
              )}
              {saved.some((item) => item.sessionId === id) && (
                <p className="text-xs text-muted-foreground">{copy.unknown}</p>
              )}
              {id === selected &&
                interactions.map((request) => (
                  <Button
                    variant="outline"
                    size="sm"
                    key={`${"questions" in request ? "q" : "a"}:${request.requestId}`}
                    onClick={() => {
                      setOpen(false);
                      setModal(request);
                    }}
                  >
                    {"questions" in request ? copy.pending : t.approval} ·{" "}
                    {String(request.requestId)}
                  </Button>
                ))}
            </section>
          ))}
          {saved
            .filter((item) => !item.sessionId)
            .map((item) => (
              <p key={item.requestId} className="text-xs text-muted-foreground">
                {copy.unknown} · {item.kind}
              </p>
            ))}
          <Button variant="outline" onClick={() => void refresh(true)}>
            {copy.refresh}
          </Button>
        </Dialog>
      )}
    </>
  );
}
