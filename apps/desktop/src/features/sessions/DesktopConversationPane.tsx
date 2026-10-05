import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { refreshConversationCatalog } from "./conversation-catalog";
import { useSessionViewStore } from "./session-view-store";

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
    <div className="desktop-conversation flex min-h-0 flex-1 flex-col">
      {catalogError && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {tr("sessions.conversationCatalogError")} {catalogError}
        </p>
      )}
      <Suspense
        fallback={
          <div className="session-state" role="status">
            <RefreshCw className="animate-spin" size={24} />
            <p>{tr("sessions.loading")}</p>
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
