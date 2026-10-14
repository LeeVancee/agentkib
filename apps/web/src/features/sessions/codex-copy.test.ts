import { describe, expect, it } from "vitest";
import { dictionaries, type Locale } from "@agentkib/conversation-ui/i18n";
import { codexReason } from "@agentkib/conversation-ui/features/sessions/codex-copy";

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
        "codex-protocol-incompatible",
        "codex-connection-failed",
        "codex-owner-changed",
        "session-compacting",
      ]) {
        const explanation = codexReason(locale, reason);
        expect(explanation.technical).toBeUndefined();
        expect(explanation.text).not.toBe(stateUnavailable.text);
        expect(explanation.text).not.toBe(codexReason(locale).text);
      }
    },
  );

  it.each(locales)("reuses specific installation and original-client advice in %s", (locale) => {
    expect(codexReason(locale, "handoff-required")).toEqual({
      text: dictionaries[locale].handoffRequired,
    });
    expect(codexReason(locale, "unverified-installation")).toEqual({
      text: dictionaries[locale].unverifiedInstallation,
    });
    expect(codexReason(locale, "open-in-original-client")).toEqual({
      text: dictionaries[locale].openOriginalClient,
    });
  });

  it("preserves technical details for unknown reasons", () => {
    expect(codexReason("zh-CN", "future-reason").technical).toBe("future-reason");
  });
});

describe("reasons a Claude session was stopped for", () => {
  const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  const codes = ["claude-background-task", "claude-unrequested-turn", "claude-protocol-violation"];
  // The session stays read-only in AgentKib and cannot be resumed there, so the copy must not
  // promise an action that does not exist. Each language names the Claude Code terminal.
  const unavailableActions = /Ask Claude|Reopen|重新打开|重新開啟|让 Claude|讓 Claude|開き直/;
  const terminal: Record<Locale, string> = {
    "zh-CN": "Claude Code 终端",
    "zh-TW": "Claude Code 終端機",
    "en-US": "Claude Code terminal",
    "ja-JP": "Claude Code のターミナル",
  };

  it.each(locales.flatMap((locale) => codes.map((code) => [locale, code] as const)))(
    "explains %s %s and points to the Claude Code terminal, not an action AgentKib lacks",
    (locale, code) => {
      const { text, technical } = codexReason(locale, code);
      expect(technical).toBeUndefined();
      expect(text).not.toBe(codexReason(locale).text);
      expect(text).toContain(terminal[locale]);
      expect(text).not.toMatch(unavailableActions);
    },
  );

  it.each(locales)("keeps the three explanations apart in %s", (locale) => {
    expect(new Set(codes.map((code) => codexReason(locale, code).text)).size).toBe(3);
  });

  it.each(locales)(
    "splits `<code>: <detail>` into the explanation and the technical text in %s",
    (locale) => {
      expect(
        codexReason(locale, "claude-unrequested-turn: Claude result outside an active turn"),
      ).toEqual({
        text: codexReason(locale, "claude-unrequested-turn").text,
        technical: "Claude result outside an active turn",
      });
      expect(codexReason(locale, "claude-background-task: ").technical).toBeUndefined();
    },
  );

  it("does not take a similar-looking reason for one of the codes", () => {
    for (const reason of [
      "claude-background-tasks: x",
      "claude-background-task:x",
      "x claude-background-task: y",
      ": claude-background-task",
    ]) {
      const explained = codexReason("en-US", reason);
      expect(explained.text).toBe(codexReason("en-US").text);
      expect(explained.technical).toBe(reason);
    }
  });

  it("leaves Codex and the general reasons as they were", () => {
    expect(codexReason("en-US", "control-outcome-unconfirmed")).toEqual({
      text: "The previous outcome is unknown. Check native state and the saved receipt first.",
    });
    expect(codexReason("en-US", "codex-connection-failed").technical).toBeUndefined();
    expect(codexReason("en-US", "Claude process exited (1)").technical).toBe(
      "Claude process exited (1)",
    );
  });
});
