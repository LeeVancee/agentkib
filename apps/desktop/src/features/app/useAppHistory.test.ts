import { describe, expect, it } from "vitest";
import {
  createAppHistoryState,
  updateAppHistoryState,
  type AppHistoryLocation,
} from "./useAppHistory";

function location(href: string, index: number, key = `key-${index}`): AppHistoryLocation {
  const [pathAndSearch, hash = ""] = href.split("#");
  const [pathname, search = ""] = pathAndSearch.split("?");
  return {
    href,
    pathname,
    search: search ? `?${search}` : "",
    hash: hash ? `#${hash}` : "",
    state: { __TSR_index: index, __TSR_key: key },
  };
}

describe("app history state", () => {
  it("keeps only the latest ten positions including the current one", () => {
    let state = createAppHistoryState(location("/0", 0));
    for (let index = 1; index <= 11; index += 1) {
      state = updateAppHistoryState(state, location(`/${index}`, index), "PUSH");
    }

    expect(state.entries).toHaveLength(10);
    expect(state.entries[0].href).toBe("/2");
    expect(state.entries.at(-1)?.href).toBe("/11");
    expect(state.cursor).toBe(9);
  });

  it("moves backward and forward through the recorded branch", () => {
    let state = createAppHistoryState(location("/", 0));
    state = updateAppHistoryState(state, location("/workspaces", 1), "PUSH");
    state = updateAppHistoryState(state, location("/agents", 2), "PUSH");

    state = updateAppHistoryState(state, location("/workspaces", 1), "BACK");
    expect(state.cursor).toBe(1);
    state = updateAppHistoryState(state, location("/agents", 2), "FORWARD");
    expect(state.cursor).toBe(2);
  });

  it("clears the forward branch after a new push", () => {
    let state = createAppHistoryState(location("/", 0));
    state = updateAppHistoryState(state, location("/workspaces", 1), "PUSH");
    state = updateAppHistoryState(state, location("/agents", 2), "PUSH");
    state = updateAppHistoryState(state, location("/workspaces", 1), "BACK");
    state = updateAppHistoryState(state, location("/settings", 3), "PUSH");

    expect(state.entries.map((entry) => entry.href)).toEqual(["/", "/workspaces", "/settings"]);
    expect(state.cursor).toBe(2);
  });

  it("replaces and deduplicates the current position", () => {
    let state = createAppHistoryState(location("/workspaces", 0));
    state = updateAppHistoryState(
      state,
      location("/workspaces?workspaceView=storage#summary", 0, "replace"),
      "REPLACE",
    );
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      pathname: "/workspaces",
      search: "?workspaceView=storage",
      hash: "#summary",
    });

    state = updateAppHistoryState(
      state,
      location("/workspaces?workspaceView=storage#summary", 1, "duplicate"),
      "PUSH",
    );
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].browserIndex).toBe(1);
  });

  it("rebuilds from an unknown external history position", () => {
    let state = createAppHistoryState(location("/", 0));
    state = updateAppHistoryState(state, location("/workspaces", 1), "PUSH");
    state = updateAppHistoryState(state, location("/external", -4, "external"), "GO");

    expect(state.entries.map((entry) => entry.href)).toEqual(["/external"]);
    expect(state.cursor).toBe(0);
  });
});
