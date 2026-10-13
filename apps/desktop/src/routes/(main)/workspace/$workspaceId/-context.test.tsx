// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ContextPreview } from "@/core/types";
import { ContextPage } from "./context";

vi.mock("@/core/api", () => ({ api: { context: vi.fn() } }));

const preview = (skill: string) =>
  ({
    sections: [],
    warnings: [],
    visible_skills: [skill],
    visible_connections: [],
    approved_memories: [],
  }) as unknown as ContextPreview;

describe("ContextPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("debounces working directory edits and keeps the previous preview while resolving", async () => {
    vi.mocked(api.context).mockImplementation(async (_project, cwd) =>
      preview(cwd === "/repo" ? "root-skill" : "nested-skill"),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("root-skill")).toBeTruthy();

    const input = screen.getByLabelText(tr("context.workingDirectory"));
    fireEvent.change(input, { target: { value: "/repo/a" } });
    fireEvent.change(input, { target: { value: "/repo/app" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 防抖期间既不发请求，也不丢掉已有结果。
    expect(api.context).toHaveBeenCalledTimes(1);
    expect(screen.getByText("root-skill")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(api.context).toHaveBeenCalledTimes(2);
    expect(api.context).toHaveBeenLastCalledWith("/repo", "/repo/app", "codex");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("nested-skill")).toBeTruthy();
    expect(screen.queryByText("root-skill")).toBeNull();
  });

  // 与后端 context-claude.ts 里的静态文案逐字一致；任一边改动都会让对应测试失败。
  const ABOVE_ROOT =
    "Directories above the workspace root were not checked for CLAUDE.md. If one exists there, Claude Code reads CLAUDE.md files only and ignores AGENTS.md.";
  const VERSION_UNKNOWN =
    "AGENTS.md may not be loaded: the Claude Code version could not be detected, and Claude Code reads AGENTS.md only from v2.1.277.";
  const EXTERNAL =
    "External import (outside the working directory): ~/team.md (source: /repo/CLAUDE.md). Claude Code asks for approval before loading external imports, so this content may not be in effect.";
  const MISSING = "Imported file is missing: /repo/none.md (source: /repo/CLAUDE.md)";

  async function renderWarnings(warnings: string[]) {
    vi.mocked(api.context).mockResolvedValue({
      ...preview("any-skill"),
      warnings,
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ContextPage project="/repo" onOpenInstructions={() => undefined} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("shows a Note: entry as a neutral note without the prefix and keeps other entries as warnings", async () => {
    await renderWarnings([`Note: ${ABOVE_ROOT}`, `Note: ${EXTERNAL}`, VERSION_UNKNOWN, MISSING]);
    const notes = screen.getAllByRole("note");
    expect(notes.map((note) => note.textContent)).toEqual([
      tr("context.claudeAgentsAboveRoot"),
      EXTERNAL,
    ]);
    // 注记不带前缀，也不使用警告的琥珀色。
    for (const note of notes) {
      expect(note.textContent).not.toContain("Note:");
      expect(note.className).not.toContain("amber");
    }
    const warning = screen.getByText(tr("context.claudeAgentsVersionUnknown"));
    expect(warning.className).toContain("amber");
    expect(screen.getByText(MISSING).className).toContain("amber");
    expect(screen.queryByText(/^Note: /)).toBeNull();
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "localizes the Claude Code AGENTS.md messages in %s",
    async (locale) => {
      await changeLocale(locale);
      try {
        await renderWarnings([`Note: ${ABOVE_ROOT}`, VERSION_UNKNOWN]);
        const above = tr("context.claudeAgentsAboveRoot");
        const unknown = tr("context.claudeAgentsVersionUnknown");
        expect(screen.getByRole("note").textContent).toBe(above);
        expect(screen.getByText(unknown)).toBeTruthy();
        if (locale !== "en-US") {
          // 没有命中映射时界面会退回英文原文，这里要求必须是译文。
          expect(above).not.toBe(ABOVE_ROOT);
          expect(unknown).not.toBe(VERSION_UNKNOWN);
          expect(screen.queryByText(ABOVE_ROOT)).toBeNull();
          expect(screen.queryByText(VERSION_UNKNOWN)).toBeNull();
        }
      } finally {
        await changeLocale("en-US");
      }
    },
  );
});
