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
      const containerRect = container.getBoundingClientRect();
      const fallback = rect.width === 0 || rect.height === 0;
      const mobileAnchor = anchor.matches("[data-sidebar-mobile-trigger]");
      const left = mobileAnchor
        ? rect.right + 8
        : fallback
          ? Math.max(containerRect.left + 8, 8)
          : Math.max(8, rect.left - rect.width - 8);
      bell.style.left = `${left}px`;
      bell.style.top = `${rect.top}px`;
      bell.style.width = `${fallback ? 36 : rect.width}px`;
      bell.style.height = `${fallback ? 36 : rect.height}px`;
    };
    const resizeObserver = new ResizeObserver(align);
    const sync = () => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-session-directory-options], [data-sidebar-mobile-trigger]",
        ),
      );
      const nextAnchor =
        anchors.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
        }) ??
        anchors[0] ??
        null;
      const nextBell = container.querySelector<HTMLElement>("[data-conversation-pending-trigger]");
      const nextSidebar = nextAnchor?.closest(".app-context-sidebar") ?? null;
      // Streaming changes the transcript frequently, but does not move these controls.
      if (anchor === nextAnchor && bell === nextBell && sidebar === nextSidebar) {
        align();
        return;
      }
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
    const mutationObserver = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.type === "attributes" &&
            mutation.target === bell &&
            mutation.attributeName === "style",
        )
      ) {
        return;
      }
      sync();
    });
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "aria-expanded", "data-state", "inert"],
      childList: true,
      subtree: true,
    });
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
