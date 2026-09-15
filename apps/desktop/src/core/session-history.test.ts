import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

const sessionEvents = vi.hoisted(() => vi.fn().mockResolvedValue({ events: [], warnings: [] }));
vi.mock("./desktop", () => ({
  desktopApi: () => ({ workspace: { sessionEvents } }),
}));

describe("history page requests", () => {
  it("defaults to the latest 50 records and forwards an explicit page size unchanged", async () => {
    await api.sessionEvents("session");
    expect(sessionEvents).toHaveBeenLastCalledWith("session", undefined, 50);
    await api.sessionEvents("session", "older", 20);
    expect(sessionEvents).toHaveBeenLastCalledWith("session", "older", 20);
  });
});
