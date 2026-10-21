// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { HomeSummaryBar } from "./HomeSummaryBar";

afterEach(cleanup);

it("binds metric labels to their readable hover role without changing the summary surface", async () => {
  await initializeI18n("en-US");
  const onMetric = vi.fn();
  render(
    <HomeSummaryBar
      issueCount={1}
      issuesPending={false}
      metrics={[{ label: "Workspaces", value: 3, onClick: onMetric }]}
      onShowPending={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  const metric = screen.getByRole("button", { name: /^3\s*Workspaces$/ });
  expect(metric).toHaveClass("group/button", "hover:bg-primary/10");
  expect(metric.parentElement).toHaveClass("bg-muted/55");
  expect(screen.getByText("Workspaces")).toHaveClass(
    "text-muted-foreground",
    "group-hover/button:text-home-metric-hover-foreground",
  );
  fireEvent.click(metric);
  expect(onMetric).toHaveBeenCalledOnce();
});
