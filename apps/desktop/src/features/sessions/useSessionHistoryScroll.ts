import { useLayoutEffect, useRef } from "react";
import type { useSessionHistory } from "./useSessionHistory";

/** Preserve visible records when an earlier history window is prepended. */
export function useSessionHistoryScroll(
  sessionKey: string,
  history: ReturnType<typeof useSessionHistory>,
) {
  const historyRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{
    key: string;
    candidates: { id: string; top: number }[];
    height: number;
    scroll: number;
  } | null>(null);
  useLayoutEffect(() => {
    scrollAnchor.current = null;
    if (historyRef.current) historyRef.current.scrollTop = 0;
  }, [sessionKey]);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const container = historyRef.current;
    if (!anchor || !container || history.loadingEarlier) return;
    scrollAnchor.current = null;
    if (anchor.key !== sessionKey) return;
    const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
    // Completing a previously partial turn can hide the first anchor inside a
    // process disclosure. Prefer the next surviving record (usually the final).
    for (const candidate of anchor.candidates) {
      const element = elements.find(
        (item) =>
          item.dataset.eventId === candidate.id &&
          item.getClientRects().length > 0 &&
          !item.closest("[hidden]"),
      );
      if (element) {
        container.scrollTop += element.getBoundingClientRect().top - candidate.top;
        return;
      }
    }
    container.scrollTop = anchor.scroll + container.scrollHeight - anchor.height;
  }, [history.events, history.loadingEarlier, sessionKey]);
  const loadEarlier = () => {
    const container = historyRef.current;
    if (container) {
      const top = container.getBoundingClientRect().top;
      const candidates = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"))
        .filter(
          (item) =>
            item.getClientRects().length > 0 &&
            !item.closest("[hidden]") &&
            item.getBoundingClientRect().bottom > top,
        )
        .map((item) => ({ id: item.dataset.eventId!, top: item.getBoundingClientRect().top }));
      scrollAnchor.current = {
        key: sessionKey,
        candidates,
        height: container.scrollHeight,
        scroll: container.scrollTop,
      };
    }
    void history.loadEarlier();
  };

  return { historyRef, loadEarlier };
}
