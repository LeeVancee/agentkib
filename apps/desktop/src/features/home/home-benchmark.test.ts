import { describe, expect, it } from "vitest";
import { homeBenchmarkOutcome } from "./home-benchmark";

describe("homeBenchmarkOutcome", () => {
  it("waits until every required query succeeds", () => {
    expect(
      homeBenchmarkOutcome([
        { isError: false, isSuccess: true },
        { isError: false, isSuccess: false },
      ]),
    ).toBe("pending");
  });

  it("reports failure when any required query fails", () => {
    expect(
      homeBenchmarkOutcome([
        { isError: false, isSuccess: true },
        { isError: true, isSuccess: false },
      ]),
    ).toBe("failed");
  });

  it("reports readiness only after every query succeeds", () => {
    expect(
      homeBenchmarkOutcome([
        { isError: false, isSuccess: true },
        { isError: false, isSuccess: true },
      ]),
    ).toBe("ready");
  });
});
