// @vitest-environment jsdom

import { cleanup, render } from "@octanejs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

afterEach(cleanup);

describe("AgentIcon", () => {
  it("renders the OpenCode asset", () => {
    const { container } = render(<AgentIcon agent="opencode" />);

    expect(container.querySelector("img")?.getAttribute("src")).toContain("OpenCode");
  });

  it("renders the Grok Build icon with dark-mode contrast", () => {
    const { container } = render(<AgentIcon agent="grok-build" />);
    const image = container.querySelector("img");

    expect(image?.getAttribute("src")).toContain("Grok");
    expect(image?.classList.contains("dark:invert")).toBe(true);
  });
});
