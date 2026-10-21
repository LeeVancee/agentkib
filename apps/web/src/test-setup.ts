import "@testing-library/jest-dom/vitest";

// Resizable panels observe their layout container in the browser.
if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
