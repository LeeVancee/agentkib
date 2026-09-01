import { describe, expect, it } from "vitest";
import { firstCloseDecision } from "./close-behavior";

describe("firstCloseDecision", () => {
  it("hides into an available tray", () => {
    expect(firstCloseDecision(0, true)).toEqual({
      behavior: "minimize-to-tray",
      action: "hide",
    });
  });

  it("minimizes when the runtime has not created a tray", () => {
    expect(firstCloseDecision(0, false)).toEqual({
      behavior: "minimize-to-tray",
      action: "minimize",
    });
  });

  it("allows quitting without depending on runtime persistence", () => {
    expect(firstCloseDecision(1, false)).toEqual({ behavior: "quit", action: "quit" });
  });

  it("does nothing when the prompt is cancelled", () => {
    expect(firstCloseDecision(2, false)).toBeUndefined();
  });
});
