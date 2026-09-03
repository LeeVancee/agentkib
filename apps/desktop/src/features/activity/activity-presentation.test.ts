// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n, supportedLocales } from "@/core/i18n";
import type { ActivityRecord } from "@/core/types";
import { activityPresentation } from "./activity-presentation";

function record(action: string, detail: string): ActivityRecord {
  return {
    id: "activity-1",
    action,
    detail,
    created_at: "2026-09-03T00:00:00.000Z",
  };
}

describe("activityPresentation", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("localizes discovery counts instead of exposing the stored English detail", () => {
    expect(activityPresentation(record("discovery.complete", "37 workspaces, 0 errors"))).toEqual({
      title: "Workspace discovery completed",
      detail: "Found 37 workspaces with 0 errors",
    });
  });

  it("does not expose opaque identifiers for changes and memories", () => {
    expect(activityPresentation(record("changeset.apply", "opaque-change-id")).detail).toBe(
      "The reviewed changes were applied successfully",
    );
    expect(activityPresentation(record("memory.review", "opaque-memory-id:approved")).detail).toBe(
      "The shared memory was approved",
    );
  });

  it("does not expose unknown internal action keys or details", () => {
    expect(activityPresentation(record("future.internal.event", "raw internal detail"))).toEqual({
      title: "Local activity",
      detail: "AgentKib recorded a local operation",
    });
  });

  it("has localized discovery presentation in every supported locale", async () => {
    for (const locale of supportedLocales) {
      await changeLocale(locale);
      const presentation = activityPresentation(
        record("discovery.complete", "37 workspaces, 0 errors"),
      );
      expect(presentation.title).not.toContain("discovery.complete");
      expect(presentation.detail).not.toBe("37 workspaces, 0 errors");
      expect(presentation.detail).not.toContain("activity.detail");
    }
    await changeLocale("en-US");
  });
});
