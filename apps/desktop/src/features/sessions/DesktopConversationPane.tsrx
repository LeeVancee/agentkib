/** @jsxImportSource octane */

import { ReactCompat } from "octane/react";
import { useCallback, useEffect, useRef, useState } from "octane";
import {
  EmbeddedConversation,
  type EmbeddedConversationHandle,
} from "@agentkib/conversation-ui/conversation";
import type { ConversationPanel } from "@agentkib/conversation-ui/conversation";
import "@agentkib/conversation-ui/conversation.css";
import { useI18n } from "@/core/useI18n";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useSessionHub } from "./SessionHubContext.tsrx";
import { refreshConversationCatalog } from "./conversation-catalog";
import { subscribeConversationPanel } from "./conversation-panel-commands";
import { useSessionViewStore } from "./session-view-store";

export function DesktopConversationPane({
  sessionId,
  create = false,
}: {
  sessionId?: string;
  create?: boolean;
}) {
  const { locale, localizeMessage, tr } = useI18n();
  const { select, historyRevision } = useSessionHub();
  const [client] = useState(createDesktopConversationClient);
  const [catalogError, setCatalogError] = useState("");
  const controlsRef = useRef<EmbeddedConversationHandle>(null);
  const navigation = useRef(0);

  useEffect(
    () => subscribeConversationPanel((panel: ConversationPanel) => controlsRef.current?.openPanel(panel)),
    [],
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
        if (request === navigation.current) setCatalogError(localizeMessage(error));
      }
    },
    [localizeMessage, select],
  );

  return (
    <div className="desktop-conversation flex min-h-0 flex-1 flex-col">
      {catalogError && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {tr("sessions.conversationCatalogError")} {catalogError}
        </p>
      )}
      <ReactCompat
        component={EmbeddedConversation}
        props={{
          controlsRef,
          client,
          sessionId: create ? undefined : sessionId,
          create,
          refreshRevision: historyRevision,
          locale,
          onSessionChange,
          onCatalogChange,
          onCreateClosed,
        }}
      />
    </div>
  );
}
