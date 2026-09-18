/** @jsxImportSource octane */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@octanejs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { SidebarBrand } from "./SidebarBrand.tsrx";

describe("SidebarBrand", () => {
  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
  });

  it("uses the runtime application name", () => {
    useAppStore.getState().setRuntime({ app_name: "AgentKib Dev" } as RuntimeInfo);

    const { container } = render(<SidebarBrand />);

    expect(screen.getByText("AgentKib Dev")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AgentKib Dev" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps the sidebar usable when storage is unavailable", () => {
    expect(() => useAppStore.getState().setSidebarCollapsed(true)).not.toThrow();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });
});
