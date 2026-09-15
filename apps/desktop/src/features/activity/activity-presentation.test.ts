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

  it("localizes insight refresh counts instead of falling back to generic activity", () => {
    expect(
      activityPresentation(record("insights.refresh", "3 providers, 17 repositories")),
    ).toEqual({
      title: "Insights refreshed",
      detail: "Collected data from 3 providers and 17 repositories",
    });
  });

  it("keeps zero insight refresh counts", () => {
    expect(
      activityPresentation(record("insights.refresh", "0 providers, 0 repositories")).detail,
    ).toBe("Collected data from 0 providers and 0 repositories");
  });

  it("does not expose malformed insight refresh details", () => {
    expect(activityPresentation(record("insights.refresh", "provider=3 repositories=17"))).toEqual({
      title: "Insights refreshed",
      detail: "Insights were refreshed",
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

  it.each(["skill.apply", "skill.rollback", "skill.uninstall", "skill.restore"])(
    "presents %s with the skill name instead of an internal action key",
    (action) => {
      const presentation = activityPresentation(record(action, "reviewer"));

      expect(presentation.title).not.toBe("Local activity");
      expect(presentation.detail).toContain("reviewer");
      expect(presentation.title).not.toContain(action);
      expect(presentation.detail).not.toContain(action);
    },
  );

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

  it("has localized insight refresh presentation in every supported locale", async () => {
    for (const locale of supportedLocales) {
      await changeLocale(locale);
      const presentation = activityPresentation(
        record("insights.refresh", "3 providers, 17 repositories"),
      );
      expect(presentation.title).not.toContain("insights.refresh");
      expect(presentation.detail).not.toBe("3 providers, 17 repositories");
      expect(presentation.detail).not.toContain("activity.detail");
    }
    await changeLocale("en-US");
  });

  it("localizes skill activity in every supported locale", async () => {
    for (const locale of supportedLocales) {
      await changeLocale(locale);
      for (const action of ["skill.apply", "skill.rollback", "skill.uninstall", "skill.restore"]) {
        const presentation = activityPresentation(record(action, "reviewer"));
        expect(presentation.title).not.toContain("activity.action");
        expect(presentation.detail).not.toContain("activity.detail");
        expect(presentation.detail).toContain("reviewer");
      }
    }
    await changeLocale("en-US");
  });
});
