import type { Unlisten } from "@/core/platform-events";

export interface PlatformWindow {
  hide(): Promise<void>;
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<Unlisten>;
}
