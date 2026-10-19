import { describe, expect, it } from "vitest";
import { sessionContinuationCopy, sessionContinuationListState } from "@agentkib/session-ui";

describe("runtime-only session list presentation", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"])(
    "does not invent a runtime owner or expose a dot for view-only sources in %s",
    (locale) => {
      const session = { agent: "claude-code", availability: "readable" };
      expect(sessionContinuationListState(session, locale)).toBeUndefined();
      expect(
        sessionContinuationListState(
          { ...session, continuation: { status: "idle", executionLocation: null } },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          {
            ...session,
            remote: { host_id: "another" },
            continuation: { status: "running", executionLocation: "agentkib" },
          },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          {
            ...session,
            continuation: { status: "outcome-unknown", executionLocation: "agentkib" },
          },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          { ...session, continuation: { status: "unsupported", reason: "claude-cli-unavailable" } },
          locale,
        ),
      ).toEqual({ label: sessionContinuationCopy(locale).viewOnly });
      expect(
        sessionContinuationListState({ ...session, availability: "metadata-only" }, locale),
      ).toEqual({ label: sessionContinuationCopy(locale).viewOnly });
    },
  );
});
