/** @jsxImportSource octane */

let sidebarPeekCloseTimer: number | undefined;

export function clearSidebarPeekCloseTimer() {
  if (sidebarPeekCloseTimer === undefined) return;
  window.clearTimeout(sidebarPeekCloseTimer);
  sidebarPeekCloseTimer = undefined;
}

export function scheduleSidebarPeekClose(setSidebarPeek: (peek: boolean) => void) {
  clearSidebarPeekCloseTimer();
  sidebarPeekCloseTimer = window.setTimeout(() => {
    setSidebarPeek(false);
    sidebarPeekCloseTimer = undefined;
  }, 280);
}
