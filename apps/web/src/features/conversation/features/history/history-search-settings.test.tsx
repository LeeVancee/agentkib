import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type HistorySearchStatus } from "@agentkib/web-client";
import { HistorySearchPanel, historyAccessScope } from "./history-search";
import { historyCopy } from "./history-copy";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Web content search settings instructions", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "explains host-side settings in %s without an invalid navigation or index mutation",
    async (locale) => {
      const grant: Access = {
        protocolVersion: 2,
        status: "approved",
        csrfToken: "test",
        bootId: "boot",
        experimentalEnabled: true,
        historySearch: true,
        historySearchScope: "scope",
        device: { id: "browser", name: "Browser", send: false, approve: false },
      };
      const status: HistorySearchStatus = {
        enabled: false,
        generation: "index",
        bytes: 0,
        limitBytes: 10000,
        budgetExceeded: false,
        coverage: {
          total: 0,
          ready: 0,
          building: 0,
          partial: 0,
          stale: 0,
          unavailable: 0,
          limitations: [],
        },
      };
      const client = new WebClient(vi.fn());
      vi.spyOn(client, "access").mockResolvedValue(grant);
      vi.spyOn(client, "catalog").mockResolvedValue({ indexEnabled: true, sessions: [] });
      vi.spyOn(client, "historyStatus").mockResolvedValue(status);
      const configure = vi.spyOn(client, "historyConfigure");
      const clear = vi.spyOn(client, "historyClear");
      const rebuild = vi.spyOn(client, "historyRebuild");
      render(
        <HistorySearchPanel client={client} locale={locale} scope={historyAccessScope(grant)} />,
      );
      expect(await screen.findByText(historyCopy[locale].disabled)).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(screen.getByRole("button", { name: historyCopy[locale].search })).toBeDisabled();
      expect(configure).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
    },
  );
});
