import type { DesktopApi } from "../electron/api";
import type { DesktopConversationBridge } from "./core/conversation-bridge";

declare global {
  interface Window {
    agentkibDesktop?: DesktopApi;
    desktopConversation?: DesktopConversationBridge;
  }
}

export {};
