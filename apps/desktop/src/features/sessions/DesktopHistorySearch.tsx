import { useState } from "react";
import { HistorySearchLauncher } from "@agentkib/conversation-ui/features/history/history-search";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { requestConversationPanel } from "./conversation-panel-commands";
export function DesktopHistorySearch() {
  const [client] = useState(createDesktopConversationClient);
  const { locale } = useI18n();
  const { selected } = useSessionHub();
  if (!hasDesktopConversation()) return null;
  const embedded =
    selected &&
    !selected.remote &&
    selected.availability === "readable" &&
    ["codex", "claude-code", "antigravity"].includes(selected.agent);
  return (
    <HistorySearchLauncher
      client={client}
      locale={locale}
      onOpen={embedded ? () => requestConversationPanel("search") : undefined}
    />
  );
}
