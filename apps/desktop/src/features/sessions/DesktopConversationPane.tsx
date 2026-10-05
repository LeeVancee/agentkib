import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { refreshConversationCatalog } from "./conversation-catalog";
import { useSessionViewStore } from "./session-view-store";
import { cn } from "@/lib/utils";

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
        "[&_.agentkib-conversation_.turn]:mb-6 [&_.agentkib-conversation_.turn>time]:mb-2 [&_.agentkib-conversation_.turn>time]:text-[11px] [&_.agentkib-conversation_.incomplete]:mb-2 [&_.agentkib-conversation_.incomplete]:text-[11px]",
        "[&_.agentkib-conversation_.message]:my-3 [&_.agentkib-conversation_.message]:leading-[1.65] [&_.agentkib-conversation_.message:not(.user-message)]:max-w-3xl",
        "[&_.agentkib-conversation_.user-message]:mb-5 [&_.agentkib-conversation_.user-message]:max-w-[82%] [&_.agentkib-conversation_.user-message]:px-4 [&_.agentkib-conversation_.process]:my-3",
        "[&_.agentkib-conversation_.reader-scroll~form]:w-[min(calc(100%-3rem),48rem)] [&_.agentkib-conversation_.reader-scroll~form]:max-w-none",
        "[&_.agentkib-conversation_.reader-scroll~form:focus-within]:outline-2 [&_.agentkib-conversation_.reader-scroll~form:focus-within]:outline-[color-mix(in_srgb,var(--ring)_20%,transparent)] [&_.agentkib-conversation_.reader-scroll~form:focus-within]:outline-offset-2",
        "[&_.agentkib-conversation_.reader-scroll~form_textarea]:min-h-14 [&_.agentkib-conversation_.reader-scroll~form_textarea]:max-h-36",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1]:gap-2",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:h-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:rounded-xl [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button]:transition-colors [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:first-child]:w-11 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:first-child]:px-0",
        "[&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(2)]:bg-muted/60 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:px-3 [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:text-muted-foreground [&_.agentkib-conversation_.reader-scroll~form_div.flex.min-w-0.items-center.gap-1>button:nth-child(3)]:tabular-nums",
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
