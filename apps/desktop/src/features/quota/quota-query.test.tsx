// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { QuotaCollectorStatus, RefreshJobStatus } from "@/core/types";
import {
  quotaKeys,
  useQuotaQueryEvents,
  useQuotaRefreshJob,
  useQuotaRefreshMutation,
  useQuotaStatus,
} from "./quota-query";

const events = vi.hoisted(() => ({
  refresh: undefined as ((status: RefreshJobStatus) => void) | undefined,
}));
vi.mock("@/core/api", () => ({
  api: { quotaCollectorStatus: vi.fn(), refreshStatus: vi.fn(), refreshQuota: vi.fn() },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    events: {
      onQuotaUpdated: () => () => {},
      onRefreshState: (listener: (status: RefreshJobStatus) => void) => {
        events.refresh = listener;
        return () => (events.refresh = undefined);
      },
    },
  }),
}));

const failed = { kind: "quota", state: "failed", request_id: "attempt-2" } as RefreshJobStatus;
const handles: { refresh?: () => Promise<unknown> } = {};
function Page() {
  useQuotaQueryEvents();
  useQuotaRefreshJob();
  const status = useQuotaStatus();
  const { mutateAsync } = useQuotaRefreshMutation();
  useEffect(() => {
    handles.refresh = mutateAsync;
  });
  return <div>{status.data?.error_detail ?? "no failure"}</div>;
}

describe("quota failure diagnostics invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.refreshStatus).mockResolvedValue([]);
    vi.mocked(api.quotaCollectorStatus).mockResolvedValue({
      backend: "codex-bar-cli",
      platform_supported: true,
      sidecar_available: true,
      config_source: "agentkib-managed",
      running: false,
    });
  });
  afterEach(cleanup);

  it.each(["event", "poll", "receipt"] as const)(
    "loads the latest diagnostic when failure arrives by %s",
    async (delivery) => {
      const client = new QueryClient();
      render(
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(api.refreshStatus).toHaveBeenCalled());
      await waitFor(() => expect(api.quotaCollectorStatus).toHaveBeenCalledTimes(1));
      vi.mocked(api.quotaCollectorStatus).mockResolvedValue({
        error_detail: "codex: usage request timed out",
        last_attempt_at: "2026-10-09T02:00:00Z",
      } as QuotaCollectorStatus);
      await act(async () => {
        if (delivery === "event") events.refresh!(failed);
        else if (delivery === "poll") {
          vi.mocked(api.refreshStatus).mockResolvedValue([failed]);
          await client.invalidateQueries({ queryKey: quotaKeys.refreshJob() });
        } else {
          vi.mocked(api.refreshQuota).mockResolvedValue({
            kind: "quota",
            disposition: "queued",
            request_id: "attempt-2",
            status: failed,
          });
          await handles.refresh!();
        }
      });
      expect(await screen.findByText("codex: usage request timed out")).toBeTruthy();
      client.clear();
    },
  );
});
