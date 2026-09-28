import { useLayoutEffect, useRef } from "react";

export function useRetainedScroll(key: string, offsets: Map<string, number>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const offset = offsets.get(key) ?? 0;
    let waiting = offset > 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => restore());
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => restore());
    const disconnect = () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      clearTimeout(timeout);
    };
    const restore = () => {
      element.scrollTop = offset;
      if (Math.abs(element.scrollTop - offset) < 1) {
        waiting = false;
        disconnect();
      }
    };
    const save = () => {
      if (!waiting) offsets.set(key, element.scrollTop);
    };
    const interact = () => {
      waiting = false;
      disconnect();
      save();
    };
    element.addEventListener("scroll", save);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      element.addEventListener(event, interact, { passive: true });
    }
    restore();
    if (waiting) {
      // A retained Outlet or lazy route may not have its final height yet.
      observer.observe(element, { childList: true, subtree: true, attributes: true });
      if (element.firstElementChild) resizeObserver?.observe(element.firstElementChild);
      timeout = setTimeout(interact, 3000);
    }
    return () => {
      save();
      disconnect();
      element.removeEventListener("scroll", save);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        element.removeEventListener(event, interact);
      }
    };
  }, [key, offsets]);
  return ref;
}
