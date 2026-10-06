import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { refreshConversationCatalog } from "./conversation-catalog";
import { useSessionViewStore } from "./session-view-store";
import { cn } from "@/lib/utils";
import { subscribeConversationPanel } from "./conversation-panel-commands";

const EmbeddedConversation = lazy(() =>
  import("@agentkib/web/conversation").then((module) => ({ default: module.EmbeddedConversation })),
);

export function DesktopConversationPane({
  sessionId,
  create = false,
}: {
  sessionId?: string;
  create?: boolean;
}) {
  const { locale, tr, localizeMessage } = useI18n();
  const { select, conversationRefreshRevision } = useSessionHub();
  const [client] = useState(createDesktopConversationClient);
  const [catalogError, setCatalogError] = useState("");
  const navigation = useRef(0);
  useEffect(
    () =>
      subscribeConversationPanel((panel) => {
        const header = document.querySelector(
          ".desktop-conversation .agentkib-conversation > div.flex.shrink-0.items-center.justify-end.gap-2.border-b",
        );
        const buttons = Array.from(header?.querySelectorAll("button") ?? []).filter(
          (button) => !button.querySelector("svg.lucide-bell"),
        );
        const target =
          panel === "actions" ? buttons.at(-1) : buttons.length > 1 ? buttons.at(-2) : undefined;
        target?.click();
      }),
    [],
  );
  useEffect(() => {
    const alignBell = () => {
      const bell = document.querySelector<HTMLElement>(
        ".desktop-conversation .agentkib-conversation > div.flex.shrink-0.items-center.justify-end.gap-2.border-b > button:has(svg.lucide-bell)",
      );
      const anchor = document.querySelector<HTMLElement>("[data-session-directory-options]");
      if (!bell || !anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      bell.style.left = `${anchorRect.left - anchorRect.width - 8}px`;
      bell.style.top = `${anchorRect.top}px`;
      bell.style.width = `${anchorRect.width}px`;
      bell.style.height = `${anchorRect.height}px`;
    };
    const resizeObserver = new ResizeObserver(alignBell);
    const sync = () => {
      alignBell();
      const anchor = document.querySelector<HTMLElement>("[data-session-directory-options]");
      const bell = document.querySelector<HTMLElement>(
        ".desktop-conversation .agentkib-conversation > div.flex.shrink-0.items-center.justify-end.gap-2.border-b > button:has(svg.lucide-bell)",
      );
      resizeObserver.disconnect();
      if (anchor) resizeObserver.observe(anchor);
      const sidebar = anchor?.closest(".app-context-sidebar");
      if (sidebar) resizeObserver.observe(sidebar);
      if (bell) resizeObserver.observe(bell);
    };
    const mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", sync);
    sync();
    const frame = requestAnimationFrame(sync);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);
  useEffect(
    () => () => {
      navigation.current += 1;
    },
    [sessionId],
  );
  const onCreateClosed = useCallback(() => {
    useSessionViewStore.getState().setCreatingConversation(false);
  }, []);
  const onCatalogChange = useCallback(() => {
    void refreshConversationCatalog().then(
      () => setCatalogError(""),
      (error: unknown) => setCatalogError(localizeMessage(error)),
    );
  }, [localizeMessage]);
  const onSessionChange = useCallback(
    async (id?: string) => {
      const request = ++navigation.current;
      if (!id) {
        useSessionViewStore.getState().setCreatingConversation(false);
        select();
        setCatalogError("");
        return;
      }
      try {
        const sessions = await refreshConversationCatalog();
        if (request !== navigation.current) return;
        const session = sessions.find((item) => item.id === id);
        if (session) useSessionViewStore.getState().revealSession(session);
        useSessionViewStore.getState().setCreatingConversation(false);
        select(id);
        setCatalogError("");
      } catch (error) {
        // Creation/fork has already succeeded. Keep its conversation mounted and
        // report catalog refresh separately instead of offering to repeat creation.
        if (request === navigation.current) setCatalogError(localizeMessage(error));
      }
    },
    [select, localizeMessage],
  );
  return (
    <div
      className={cn(
        "desktop-conversation flex min-h-0 flex-1 flex-col",
        "[&_.agentkib-conversation_.transcript]:w-full [&_.agentkib-conversation_.transcript]:max-w-3xl",
        "[&_.agentkib-conversation_.reader-scroll]:px-6",
        "[&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:rounded-md [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:border [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:border-border [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:bg-background [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:hover:bg-muted",
        "[&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b]:h-0 [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b]:gap-0 [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b]:overflow-visible [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b]:border-0 [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b]:p-0 [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:not(:has(svg.lucide-bell))]:hidden",
        "[&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:has(svg.lucide-bell)]:fixed [&_.agentkib-conversation>div.flex.shrink-0.items-center.justify-end.gap-2.border-b>button:has(svg.lucide-bell)]:z-50",
        "[&_.agentkib-conversation_.turn]:mb-6 [&_.agentkib-conversation_.turn>time]:mb-2 [&_.agentkib-conversation_.turn>time]:text-[11px] [&_.agentkib-conversation_.incomplete]:mb-2 [&_.agentkib-conversation_.incomplete]:text-[11px]",
        "[&_.agentkib-conversation_.message]:my-3 [&_.agentkib-conversation_.message]:leading-[1.65] [&_.agentkib-conversation_.message:not(.user-message)]:max-w-3xl",
        "[&_.agentkib-conversation_.user-message]:mb-5 [&_.agentkib-conversation_.user-message]:max-w-[82%] [&_.agentkib-conversation_.user-message]:px-4 [&_.agentkib-conversation_.process]:my-3",
        "[&_.agentkib-conversation_.reader-scroll~form]:w-[min(calc(100%-3rem),48rem)] [&_.agentkib-conversation_.reader-scroll~form]:max-w-none",
        "[&_.agentkib-conversation_.reader-scroll~form]:space-y-1.5 [&_.agentkib-conversation_.reader-scroll~form]:p-2",
        "[&_.agentkib-conversation_.reader-scroll~form_textarea]:focus-visible:border-0 [&_.agentkib-conversation_.reader-scroll~form_textarea]:focus-visible:ring-0",
        "[&_.agentkib-conversation_.reader-scroll~form_textarea]:min-h-12 [&_.agentkib-conversation_.reader-scroll~form_textarea]:max-h-28",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1]:gap-2",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:h-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:rounded-xl [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:transition-colors [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:first-child]:w-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:first-child]:px-0",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:w-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:flex-none [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:justify-center [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:border [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:border-border [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:bg-background [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:p-0 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:hover:bg-muted [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)>svg:first-child]:block [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)>span]:sr-only [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:ml-auto [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:px-3 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:text-muted-foreground [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:tabular-nums",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:last-child]:w-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:last-child]:px-0 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:last-child]:shadow-sm [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:focus-visible]:outline-2 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:focus-visible]:outline-ring [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:focus-visible]:outline-offset-2",
      )}
    >
      {catalogError && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {tr("sessions.conversationCatalogError")} {catalogError}
        </p>
      )}
      <Suspense
        fallback={
          <div
            className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
            role="status"
          >
            <RefreshCw className="animate-spin" size={24} />
            <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
              {tr("sessions.loading")}
            </p>
          </div>
        }
      >
        <EmbeddedConversation
          client={client}
          sessionId={sessionId}
          create={create}
          refreshRevision={conversationRefreshRevision}
          locale={locale}
          onSessionChange={onSessionChange}
          onCatalogChange={onCatalogChange}
          onCreateClosed={onCreateClosed}
        />
      </Suspense>
    </div>
  );
}
