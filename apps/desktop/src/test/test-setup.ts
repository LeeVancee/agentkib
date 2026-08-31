if (typeof window !== "undefined") {
  const unsubscribe = () => undefined;
  Object.defineProperty(window, "agentkibDesktop", {
    configurable: true,
    value: {
      platform: "linux",
      events: {
        onQuitRequested: () => unsubscribe,
        onThemeChanged: () => unsubscribe,
        onRefreshState: () => unsubscribe,
        onQuotaUpdated: () => unsubscribe,
        onNavigate: () => unsubscribe,
        onMenuCommand: () => unsubscribe,
      },
    },
  });
  document.documentElement.dataset.platform = "linux";

  class TestPointerEvent extends window.MouseEvent {
    pointerId = 1;
    pointerType = "mouse";
    isPrimary = true;
  }

  if (!window.PointerEvent) {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
  }

  if (!window.ResizeObserver) {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => undefined;
  }
}
