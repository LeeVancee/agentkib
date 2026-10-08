import { useEffect, useRef, useState, type ReactNode } from "react";

/** One responsive DOM tree preserves native media when the viewport changes. */
export function ArtifactPanel({
  children,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [modal, setModal] = useState(() => !window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setModal(!query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const previous = document.activeElement;
    const element = panel.current;
    element?.focus();
    return () => {
      // Wait for the modal effect to restore background inertness. Focusing
      // earlier works in jsdom but is ignored by browsers on inert elements.
      queueMicrotask(() => {
        if (element?.isConnected || !(previous instanceof HTMLElement) || !previous.isConnected)
          return;
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        const active = document.activeElement;
        if (active && active !== document.body && active !== previous && !element?.contains(active))
          return;
        for (
          let ancestor: HTMLElement | null = previous;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          if (ancestor.inert) return;
        }
        previous.focus();
      });
    };
  }, []);
  useEffect(() => {
    if (!modal) return;
    const element = panel.current;
    if (!element) return;
    // Hide background from pointer and assistive navigation without reparenting
    // the panel (which would recreate its iframe and media elements).
    const backgrounds: { node: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = element;
    while (branch.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          backgrounds.push({ node: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,video[controls],audio[controls],[tabindex="0"]',
        ),
      );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        element.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) element.focus();
    };
    element.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    if (!element.contains(document.activeElement)) element.focus();
    return () => {
      backgrounds.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      document.body.style.overflow = priorOverflow;
      element.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
    };
  }, [modal]);
  return (
    <section
      ref={panel}
      role={modal ? "dialog" : "complementary"}
      aria-modal={modal || undefined}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!modal && event.key === "Escape") {
          event.preventDefault();
          onCloseRef.current();
        }
      }}
      className="fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background text-foreground outline-none xl:static xl:z-auto xl:w-[clamp(360px,32vw,480px)] xl:shrink-0 xl:border-l"
    >
      {children}
    </section>
  );
}
