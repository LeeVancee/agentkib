// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SettingsNotice,
  SettingsPage,
  SettingsPageHeader,
  SettingsPanel,
  SettingsSection,
  SettingsStatus,
} from "./SettingsLayout";

describe("SettingsLayout", () => {
  afterEach(cleanup);

  it.each([
    ["form", "max-w-[920px]"],
    ["management", "max-w-[920px]"],
    ["workspace", "max-w-[1080px]"],
  ] as const)("applies the %s page width", (variant, widthClass) => {
    const { container } = render(<SettingsPage variant={variant}>Content</SettingsPage>);
    const page = container.querySelector(`[data-settings-layout="${variant}"]`);

    expect(page?.className).toContain(widthClass);
  });

  it("uses one page-level heading and exposes searchable anchors", () => {
    const { container } = render(
      <SettingsPage>
        <SettingsPageHeader title="General" description="Preferences" />
        <SettingsSection title="Interface" target="general-interface">
          Content
        </SettingsSection>
      </SettingsPage>,
    );

    expect(screen.getByRole("heading", { name: "General", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Interface", level: 2 })).toBeTruthy();
    expect(
      container.querySelector("#settings-target-general-interface")?.getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("uses the same heading and action hierarchy for sections and panels", () => {
    render(
      <>
        <SettingsSection
          title="Interface"
          description="Preferences"
          action={<button>Reset</button>}
        >
          Section content
        </SettingsSection>
        <SettingsPanel title="Gateways" description="Connections" action={<button>Add</button>}>
          Panel content
        </SettingsPanel>
      </>,
    );

    expect(screen.getByRole("heading", { name: "Interface", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gateways", level: 2 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("exposes notice semantics and status tones without relying on color alone", () => {
    const { container } = render(
      <>
        <SettingsNotice tone="error" role="alert">
          Failed
        </SettingsNotice>
        <SettingsStatus tone="warning">Needs attention</SettingsStatus>
      </>,
    );

    expect(screen.getByRole("alert").textContent).toBe("Failed");
    expect(screen.getByText("Needs attention").textContent).toContain("Needs attention");
    expect(container.querySelector("[aria-hidden='true']")).toBeTruthy();
  });
});
