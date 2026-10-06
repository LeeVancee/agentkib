// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { DiscoveryReport } from "@/core/types";
import { discoveryStatusSummary } from "./workspaces";

describe("workspace discovery status", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("does not claim discovery is running when no report exists", () => {
    expect(discoveryStatusSummary(undefined, false, tr, () => "not used")).toMatchObject({
      label: "Discovery has not run yet",
      tone: "neutral",
    });
  });

  it("distinguishes an active scan from an unscanned workspace", () => {
    expect(discoveryStatusSummary(undefined, true, tr, () => "not used")).toMatchObject({
      label: "Discovery is scanning",
      tone: "neutral",
    });
  });

  it("keeps the last report time visible while reporting partial results", () => {
    const discovery: DiscoveryReport = {
      started_at: "2026-09-08T08:00:00Z",
      finished_at: "2026-09-08T08:00:01Z",
      discovered_count: 1,
      removed_count: 0,
      errors: [],
      source_diagnostics: [
        {
          source: "open-claw",
          status: "missing",
        },
      ],
    };
    const status = discoveryStatusSummary(discovery, false, tr, () => "a moment ago");

    expect(status).toMatchObject({
      label: "Discovery partially completed",
      tone: "warning",
      reportedAt: "Reported a moment ago",
    });
  });

  it("marks a previous report as refreshing instead of presenting stale success", () => {
    const discovery: DiscoveryReport = {
      started_at: "2026-09-08T08:00:00Z",
      finished_at: "2026-09-08T08:00:01Z",
      discovered_count: 3,
      removed_count: 0,
      errors: [],
    };

    expect(discoveryStatusSummary(discovery, true, tr, () => "a moment ago")).toMatchObject({
      label: "Discovery is scanning",
      tone: "neutral",
      reportedAt: "Reported a moment ago",
    });
  });
});
