/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useEffect, useRef } from "octane";
import type { PointerEvent } from "octane";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useSidebarWidthStore,
} from "./sidebar-width-store";

export function SidebarResizeHandle({ width, maxWidth }: { width: number; maxWidth: number }) {
  const { tr } = useI18n();
  const state = useSidebarWidthStore();
  const gesture = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const cancel = () => {
    gesture.current = null;
    useSidebarWidthStore.getState().cancelResize();
  };
  useEffect(() => {
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      cancel();
    };
  }, []);
  const update = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    state.preview(Math.min(maxWidth, drag.startWidth + event.clientX - drag.startX));
  };
  const disabled = !state.hydrated || state.saving;
  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={tr("sidebar.resize")}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={tr("sidebar.resizeHint")}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false || !state.beginResize()) return;
        event.preventDefault();
        event.currentTarget.focus();
        gesture.current = { id: event.pointerId, startX: event.clientX, startWidth: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={update}
      onPointerUp={(event) => {
        if (gesture.current?.id !== event.pointerId) return;
        update(event);
        gesture.current = null;
        void state.save(useSidebarWidthStore.getState().width);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={() => {
        if (!disabled) void state.save(DEFAULT_SIDEBAR_WIDTH);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (disabled || gesture.current) return;
        const next =
          event.key === "ArrowLeft"
            ? width - 10
            : event.key === "ArrowRight"
              ? Math.min(maxWidth, width + 10)
              : event.key === "Home"
                ? DEFAULT_SIDEBAR_WIDTH
                : event.key === "End"
                  ? maxWidth
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        void state.save(next);
      }}
    />
  );
}
