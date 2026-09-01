// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

describe("AgentIcon", () => {
  it("renders the OpenCode asset", () => {
    const { container } = render(<AgentIcon agent="opencode" />);

    expect(container.querySelector("img")?.getAttribute("src")).toContain("OpenCode");
  });
});
