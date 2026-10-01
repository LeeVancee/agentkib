/** @jsxImportSource octane */

import { useLayoutEffect, useRef } from "octane";

// 键是完整的路由地址（含查询参数），会随浏览不断增加，需要设上限。
export const MAX_RETAINED_OFFSETS = 50;

export function useRetainedScroll(key: string, offsets: Map<string, number>) {
  const ref = useRef<HTMLDivElement | null>(null);
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
      if (waiting) return;
      // 重新插入使其成为最近使用的一项；超过上限时淘汰最久未用的位置。
      offsets.delete(key);
      offsets.set(key, element.scrollTop);
      if (offsets.size > MAX_RETAINED_OFFSETS) offsets.delete(offsets.keys().next().value!);
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
    // 不在 cleanup 里保存：key 变化时新页面的 DOM 可能已经提交，此时读到的
    // scrollTop 会被新内容截断，覆盖掉 scroll 事件已记录的正确位置。
    return () => {
      disconnect();
      element.removeEventListener("scroll", save);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        element.removeEventListener(event, interact);
      }
    };
  }, [key, offsets]);
  return ref;
}
