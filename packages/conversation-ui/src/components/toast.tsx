/** @jsxImportSource octane */

import { useEffect, useState } from "octane";

type ToastDetail =
  | { kind: "show"; id: string; message: string }
  | { kind: "dismiss"; id: string };

const toastEvent = "agentkib:conversation-toast";
let nextToastId = 0;

export const toast = {
  error(message: string, options?: { id?: string }) {
    const id = options?.id ?? `conversation-toast-${++nextToastId}`;
    window.dispatchEvent(
      new CustomEvent<ToastDetail>(toastEvent, {
        detail: { kind: "show", id, message },
      }),
    );
  },
  dismiss(id: string) {
    window.dispatchEvent(
      new CustomEvent<ToastDetail>(toastEvent, {
        detail: { kind: "dismiss", id },
      }),
    );
  },
};

export function ToastViewport({ closeLabel }: { closeLabel: string }) {
  const [items, setItems] = useState<Record<string, string>>({});

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (detail.kind === "dismiss") {
        setItems((current) => {
          const next = { ...current };
          delete next[detail.id];
          return next;
        });
        return;
      }
      setItems((current) => ({ ...current, [detail.id]: detail.message }));
      window.setTimeout(() => toast.dismiss(detail.id), 5000);
    };
    window.addEventListener(toastEvent, onToast);
    return () => window.removeEventListener(toastEvent, onToast);
  }, []);

  return (
    <div className="fixed top-[calc(var(--window-toolbar-height,0px)+1rem)] right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {Object.entries(items).map(([id, message]) => (
        <div
          key={id}
          role="alert"
          className="flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground shadow-lg"
        >
          <span className="min-w-0 flex-1">{message}</span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={closeLabel}
            onClick={() => toast.dismiss(id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
