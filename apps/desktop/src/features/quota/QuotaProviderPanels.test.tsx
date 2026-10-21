// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { QuotaProvider } from "@/core/types";
import { ProviderTabs } from "./QuotaProviderPanels";

const providers: QuotaProvider[] = [
  {
    id: "codex",
    name: "Codex",
    enabled: true,
    windows: [{ kind: "weekly", label: "Weekly", used_percent: 20, remaining_percent: 80 }],
    accounts: [],
  },
  {
    id: "claude",
    name: "Claude",
    enabled: true,
    identity: { account_email: "reader@example.invalid" },
    windows: [],
    accounts: [],
  },
];

function ProviderSelection() {
  const [selectedId, setSelectedId] = useState("codex");
  return <ProviderTabs providers={providers} selectedId={selectedId} onSelect={setSelectedId} />;
}

describe("quota provider selection", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("keeps identity metadata readable and selectable when remaining quota is unavailable", async () => {
    render(<ProviderSelection />);
    const user = userEvent.setup();
    const metadata = screen.getByText("reader@example.invalid");
    const unavailable = screen.getByRole("tab", { name: /Claude/ });
    expect(unavailable.getAttribute("aria-selected")).toBe("false");
    expect(unavailable.getAttribute("aria-disabled")).not.toBe("true");
    expect(unavailable.textContent).toContain("—");
    expect(unavailable.textContent).not.toContain(tr("quota.lowestRemaining"));
    // 这是可选的状态入口，身份说明不能随整张卡片降低透明度。
    for (let element: HTMLElement | null = metadata; element; element = element.parentElement) {
      expect(element.className).not.toMatch(/(?:^|\s)(?:\[[^\s]+\]:)?opacity-\d/);
    }

    await user.click(unavailable);
    expect(unavailable.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /Codex/ }).getAttribute("aria-selected")).toBe("false");
    expect(unavailable.contains(metadata)).toBe(true);
    expect(unavailable.textContent).toContain("—");
    expect(metadata.className).toContain("text-quota-active-foreground");
    expect(metadata.className).not.toContain("text-foreground/70");
    await user.click(screen.getByRole("tab", { name: /Codex/ }));
    expect(metadata.className).toContain("text-muted-foreground");
    expect(metadata.className).not.toContain("text-quota-active-foreground");
  });
});
