import { describe, expect, it } from "vitest";
import type { Locale } from "@/i18n";
import { codexReason } from "./codex-copy";

describe("Codex capability reasons", () => {
  const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  it.each(locales)(
    "explains state restrictions without reporting a read failure in %s",
    (locale) => {
      const stateUnavailable = codexReason(locale, "session-state-unavailable");
      for (const reason of [
        "session-busy",
        "session-requires-running-turn",
        "no-active-turn",
        "session-already-managed",
        "session-not-archived",
        "session-archived",
        "session-released",
        "recovery-required",
        "native-session-unconfirmed",
        "native-operation-not-integrated",
      ]) {
        const explanation = codexReason(locale, reason);
        expect(explanation.technical).toBeUndefined();
        expect(explanation.text).not.toBe(stateUnavailable.text);
        expect(explanation.text).not.toBe(codexReason(locale).text);
      }
    },
  );

  it("preserves technical details for unknown reasons", () => {
    expect(codexReason("zh-CN", "future-reason").technical).toBe("future-reason");
  });
});
