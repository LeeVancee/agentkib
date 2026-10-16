import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedConversationHandle } from "./conversation/conversation";
import { RefreshCw } from "lucide-react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { refreshConversationCatalog } from "./conversation-catalog";
import { useSessionViewStore } from "./session-view-store";
import { cn } from "cn";
import { subscribeConversationPanel } from "./conversation-panel-commands";

const EmbeddedConversation = lazy(() =>
  import("./conversation/conversation").then((module) => ({
    default: module.EmbeddedConversation,
  })),
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
  const controlsRef = useRef<EmbeddedConversationHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeConversationPanel((panel) => controlsRef.current?.openPanel(panel)), []);
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
      ref={containerRef}
      className={cn(
        "desktop-conversation flex min-h-0 flex-1 flex-col",
        "[&_.agentkib-conversation_.reader-scroll]:px-4",
        '[&_.agentkib-conversation_[data-message-role="user"]]:px-1',
        '[&_.agentkib-conversation_[data-message-role="assistant"]]:px-1',
        "[&_.agentkib-conversation>[data-conversation-toolbar]>button:not([data-conversation-pending-trigger])]:rounded-md [&_.agentkib-conversation>[data-conversation-toolbar]>button:not([data-conversation-pending-trigger])]:border [&_.agentkib-conversation>[data-conversation-toolbar]>button:not([data-conversation-pending-trigger])]:border-border [&_.agentkib-conversation>[data-conversation-toolbar]>button:not([data-conversation-pending-trigger])]:bg-background [&_.agentkib-conversation>[data-conversation-toolbar]>button:not([data-conversation-pending-trigger])]:hover:bg-muted",
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
          controlsRef={controlsRef}
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
