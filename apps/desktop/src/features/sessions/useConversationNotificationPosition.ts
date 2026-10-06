import { useEffect, type RefObject } from "react";

/** Align the embedded pending controls with the desktop directory toolbar. */
export function useConversationNotificationPosition(
  containerRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let bell: HTMLElement | null = null;
    let anchor: HTMLElement | null = null;
    let sidebar: Element | null = null;
    const align = () => {
      if (!bell || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      bell.style.left = `${rect.left - rect.width - 8}px`;
      bell.style.top = `${rect.top}px`;
      bell.style.width = `${rect.width}px`;
      bell.style.height = `${rect.height}px`;
    };
    const resizeObserver = new ResizeObserver(align);
    const sync = () => {
      const nextAnchor = document.querySelector<HTMLElement>("[data-session-directory-options]");
      const nextBell = container.querySelector<HTMLElement>("[data-conversation-pending-trigger]");
      const nextSidebar = nextAnchor?.closest(".app-context-sidebar") ?? null;
      // Streaming changes the transcript frequently, but does not move these controls.
      if (anchor === nextAnchor && bell === nextBell && sidebar === nextSidebar) return;
      anchor = nextAnchor;
      bell = nextBell;
      sidebar = nextSidebar;
      resizeObserver.disconnect();
      if (anchor) resizeObserver.observe(anchor);
      if (sidebar) resizeObserver.observe(sidebar);
      if (bell) resizeObserver.observe(bell);
      align();
    };
    // Includes the sidebar because it can mount after the lazy conversation.
    const mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", align);
    sync();
    const frame = requestAnimationFrame(sync);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", align);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [containerRef]);
}
