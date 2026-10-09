// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { QuotaSnapshot, RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { QuotaPage } from "./QuotaPage";

vi.mock("@/core/api", () => ({
  api: {
    quotaSnapshot: vi.fn(),
    quotaCollectorStatus: vi.fn(),
    quotaPopoverPreferences: vi.fn(),
    refreshStatus: vi.fn(),
    refreshQuota: vi.fn(),
  },
}));

const snapshot: QuotaSnapshot = {
  schema_version: 1,
  backend: "codex-bar-cli",
  generated_at: "2026-09-09T01:00:00Z",
  fetched_at: "2026-09-09T01:00:00Z",
  stale_after_seconds: 300,
  freshness: "stale",
  providers: [
    {
      id: "codex",
      name: "Codex",
      enabled: true,
      accounts: [],
      error: "codex cost refresh timed out",
      windows: [
        {
          kind: "weekly",
          label: "Weekly",
          remaining_percent: 13,
          used_percent: 87,
          reset_at: "2026-09-10T01:00:00Z",
        },
      ],
    },
  ],
};

describe("quota page diagnostics", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    vi.clearAllMocks();
    useAppStore.getState().setRuntime({
      quota_auto_refresh_enabled: false,
      quota_auto_refresh_prompt_seen: true,
    } as RuntimeInfo);
    vi.mocked(api.quotaSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.quotaCollectorStatus).mockResolvedValue({
      backend: "codex-bar-cli",
      platform_supported: true,
      sidecar_available: true,
      config_source: "agentkib-managed",
      running: false,
      last_attempt_at: "2026-10-08T05:57:00Z",
    });
    vi.mocked(api.quotaPopoverPreferences).mockResolvedValue({
      hidden_providers: [],
      hidden_windows: [],
    });
    vi.mocked(api.refreshStatus).mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
  });

  it("exposes partial collection warnings and current diagnostics alongside cached quota", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <QuotaPage popoverSupported={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(tr("quota.staleReset"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("quota.partialData") }));
    expect(screen.getByText("codex cost refresh timed out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("quota.diagnostics") }));
    expect(screen.getByText(tr("quota.lastAttempt"))).toBeTruthy();
    expect(screen.getByText(tr("common.disabled"))).toBeTruthy();
    expect(api.refreshQuota).not.toHaveBeenCalled();
    client.clear();
  });
});
