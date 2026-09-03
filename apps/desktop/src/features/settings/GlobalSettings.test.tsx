// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { GlobalSettingsProps } from "./GlobalSettings";
import { GlobalSettings } from "./GlobalSettings";

const noop = async () => undefined;
const baseProps: GlobalSettingsProps = {
  section: "diagnostics",
  workspaces: [],
  remoteGateways: [],
  scanRoots: [],
  excluded: [],
  activity: [],
  onAddRoot: noop,
  onRemoveRoot: noop,
  onRestore: noop,
  onCloseBehaviorChanged: noop,
  onLocaleChanged: () => undefined,
  onOnboardingRestarted: noop,
  onRemoteGatewaysChanged: noop,
  onRefreshDiagnostics: noop,
};

const quotaStatus: NonNullable<GlobalSettingsProps["quotaStatus"]> = {
  backend: "codex-bar-cli",
  platform_supported: true,
  sidecar_available: true,
  config_source: "bundled",
  running: false,
};

const insightsStatus: NonNullable<GlobalSettingsProps["insightsStatus"]> = {
  providers: [],
  running: false,
};

describe("GlobalSettings diagnostics health", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it.each([
    { quotaStatus: undefined, insightsStatus },
    { quotaStatus, insightsStatus: undefined },
  ])("does not report healthy until both diagnostic datasets load", (statusProps) => {
    render(<GlobalSettings {...baseProps} {...statusProps} />);

    expect(screen.queryByText("Running normally")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("reports healthy only when both datasets are available without issues", () => {
    render(
      <GlobalSettings {...baseProps} quotaStatus={quotaStatus} insightsStatus={insightsStatus} />,
    );

    expect(screen.getByText("Running normally")).toBeTruthy();
  });

  it("reports attention when a supported provider is unavailable", () => {
    render(
      <GlobalSettings
        {...baseProps}
        quotaStatus={quotaStatus}
        insightsStatus={{
          ...insightsStatus,
          providers: [
            {
              agent: "codex",
              available: false,
              quality: "incomplete",
              imported_events: 0,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Running normally")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });
});
