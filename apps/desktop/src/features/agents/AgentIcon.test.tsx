// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

afterEach(cleanup);

describe("AgentIcon", () => {
  it("renders the Grok Build icon with dark-mode contrast", () => {
    const { container } = render(<AgentIcon agent="grok-build" />);
    const image = container.querySelector("img");

    expect(image?.getAttribute("src")).toContain("Grok");
    expect(image?.classList.contains("dark:invert")).toBe(true);
  });
});
