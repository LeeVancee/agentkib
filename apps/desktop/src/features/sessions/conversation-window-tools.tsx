import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { SessionContinuationStatus } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "./conversation/features/sessions/session-context";
import { sessionDisplayState } from "./conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "./conversation/features/sessions/web-layout-copy";

type ToolbarSlots = { files: HTMLElement | null; status: HTMLElement | null };

/** Keep the controls in their session context while rendering in the window toolbar. */
export function ConversationWindowTools({
  filesOpen,
  onFilesOpenChange,
}: {
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  const { selected, current, access, locale } = session;
  const [slots, setSlots] = useState<ToolbarSlots>({ files: null, status: null });
  useLayoutEffect(() => {
    const sync = () => {
      const toolbar = document.querySelector<HTMLElement>("[data-session-window-session]");
      const host = toolbar?.dataset.sessionWindowSession === selected ? toolbar : null;
      const files = host?.querySelector<HTMLElement>("[data-session-window-files-slot]") ?? null;
      const status = host?.querySelector<HTMLElement>("[data-session-window-status-slot]") ?? null;
      setSlots((previous) =>
        previous.files === files && previous.status === status ? previous : { files, status },
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-session-window-session"],
    });
    return () => observer.disconnect();
  }, [selected]);
  if (!selected || current?.id !== selected) return null;
  const copy = webLayoutCopy[locale];
  const status = sessionDisplayState(session);
  return (
    <>
      {slots.files && access?.status === "approved" && access.device?.files
        ? createPortal(
            <Button
              variant={filesOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={copy.files}
              title={copy.files}
              aria-expanded={filesOpen}
              onClick={() => onFilesOpenChange(!filesOpen)}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
            </Button>,
            slots.files,
          )
        : null}
      {slots.status && ["codex", "claude-code"].includes(current.agent)
        ? createPortal(
            <SessionContinuationStatus
              label={status.label}
              active={status.tone === "active"}
              loading={status.loading}
              className="max-w-40 [&>span:last-child]:truncate [&>span:last-child]:whitespace-nowrap"
            />,
            slots.status,
          )
        : null}
    </>
  );
}
