// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETAINED_OFFSETS, useRetainedScroll } from "./useRetainedScroll";

function Scroller({ routeKey, offsets }: { routeKey: string; offsets: Map<string, number> }) {
  const ref = useRetainedScroll(routeKey, offsets);
  return <div data-testid="scroller" ref={ref} />;
}

describe("useRetainedScroll", () => {
  afterEach(cleanup);

  it("keeps the position saved by scrolling instead of re-reading it on key change", () => {
    const offsets = new Map<string, number>();
    const view = render(<Scroller routeKey="/a" offsets={offsets} />);
    const element = view.getByTestId("scroller");
    element.scrollTop = 120;
    fireEvent.scroll(element);
    expect(offsets.get("/a")).toBe(120);

    // 模拟新页面内容更短：切换 key 时 scrollTop 已被截断为 0。
    element.scrollTop = 0;
    view.rerender(<Scroller routeKey="/b" offsets={offsets} />);
    expect(offsets.get("/a")).toBe(120);
  });

  it("evicts the least recently used positions beyond the limit", () => {
    const offsets = new Map<string, number>();
    const view = render(<Scroller routeKey="/route-0" offsets={offsets} />);
    for (let index = 0; index <= MAX_RETAINED_OFFSETS; index++) {
      view.rerender(<Scroller routeKey={`/route-${index}`} offsets={offsets} />);
      const element = view.getByTestId("scroller");
      element.scrollTop = index + 1;
      fireEvent.scroll(element);
    }
    expect(offsets.size).toBe(MAX_RETAINED_OFFSETS);
    expect(offsets.has("/route-0")).toBe(false);
    expect(offsets.get(`/route-${MAX_RETAINED_OFFSETS}`)).toBe(MAX_RETAINED_OFFSETS + 1);
  });
});
