export type ConversationPanel = "files" | "actions" | "search";

const CONVERSATION_PANEL_EVENT = "agentkib:open-conversation-panel";

export function requestConversationPanel(panel: ConversationPanel) {
  window.dispatchEvent(
    new CustomEvent<ConversationPanel>(CONVERSATION_PANEL_EVENT, { detail: panel }),
  );
}

export function subscribeConversationPanel(listener: (panel: ConversationPanel) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<ConversationPanel>).detail);
  window.addEventListener(CONVERSATION_PANEL_EVENT, handle);
  return () => window.removeEventListener(CONVERSATION_PANEL_EVENT, handle);
}
