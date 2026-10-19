import { sessionContinuationCopy } from "@agentkib/session-ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationSessionSummary } from "@agentkib/web-client";
import { SessionCatalog } from "@/features/conversation/features/catalog/session-catalog";

const workspaces = [
  { id: "alpha", name: "project", path: "/work/client-a/project" },
  { id: "beta", name: "project", path: "/work/client-b/project" },
];

const sessions = [
  {
    id: "primary",
    workspace_id: "alpha",
    title: "Primary session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "newest",
    workspace_id: "beta",
    title: "Newest session",
    agent: "claude-code",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-09T00:00:00Z",
  },
  {
    id: "helper",
    workspace_id: "alpha",
    title: "Helper session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    origin: "auxiliary",
  },
  {
    id: "metadata",
    workspace_id: "alpha",
    title: "Metadata session",
    agent: "codex",
    availability: "metadata-only",
    archived: false,
    sidechain: false,
  },
] as ConversationSessionSummary[];

afterEach(cleanup);

describe("SessionCatalog", () => {
  it("groups duplicate workspace names by path identity and hides auxiliary sessions by default", () => {
    render(
      <SessionCatalog sessions={sessions} workspaces={workspaces} selected="" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Metadata session/ })).toBeNull();
    expect(screen.getByRole("button", { name: /client-b/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /client-a/ })).toBeVisible();
  });

  it("supports search and selection without an auxiliary visibility option", () => {
    const onSelect = vi.fn();
    render(
      <SessionCatalog
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "Newest" },
    });
    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Newest session/ }));
    expect(onSelect).toHaveBeenCalledWith("newest");

    fireEvent.click(screen.getByText("目录选项"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "记录类型" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "Helper" },
    });
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();
  });

  it("counts five ordinary conversations without the 36 execution records", () => {
    const ordinary: ConversationSessionSummary[] = Array.from({ length: 5 }, (_, index) => ({
      ...sessions[0],
      id: `ordinary-${index}`,
      title: index === 0 ? undefined : `Ordinary ${index}`,
      origin: index === 1 ? "unknown" : "interactive",
      ...(index === 2 ? { executionMode: "codex-managed" } : {}),
      ...(index === 3 ? { forked_from_session_id: "parent" } : {}),
    }));
    const executions: ConversationSessionSummary[] = Array.from({ length: 36 }, (_, index) => ({
      ...sessions[0],
      id: `exec-${index}`,
      title: undefined,
      origin: "execution",
    }));
    render(
      <SessionCatalog
        sessions={[...ordinary, ...executions]}
        workspaces={[workspaces[0]]}
        selected=""
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "project · 5" })).toBeVisible();
    expect(screen.getByRole("button", { name: /未命名会话/ })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Codex ·/ })).toHaveLength(5);
  });

  it.each(["projectless", "unclassified"])(
    "keeps ordinary conversations in the %s collection while hiding internal records from counts and search",
    (kind) => {
      const collection = { id: `session-collection:codex:${kind}`, name: kind, path: "" };
      const ordinary: ConversationSessionSummary = {
        ...sessions[0],
        workspace_id: collection.id,
        origin: "unknown",
      };
      render(
        <SessionCatalog
          sessions={[
            ordinary,
            { ...ordinary, id: "execution", title: "Execution record", origin: "execution" },
            { ...ordinary, id: "auxiliary", title: "Auxiliary record", origin: "auxiliary" },
          ]}
          workspaces={[collection]}
          selected=""
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: `${kind} · 1` })).toBeVisible();
      expect(screen.getByRole("button", { name: /Primary session/ })).toBeVisible();
      fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
        target: { value: "record" },
      });
      expect(
        screen.queryByRole("button", { name: /Execution record|Auxiliary record/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: `${kind} · 1` })).toBeNull();
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps runtime dots distinct from pending interactions in %s",
    (locale) => {
      const copy = sessionContinuationCopy(locale);
      render(
        <SessionCatalog
          locale={locale}
          workspaces={workspaces}
          selected=""
          onSelect={vi.fn()}
          pendingSessions={{ running: true }}
          sessions={[
            { ...sessions[0], id: "idle", title: "Idle" },
            {
              ...sessions[0],
              id: "running",
              title: "Running",
              continuation: { status: "starting", executionLocation: "agentkib" },
            },
            {
              ...sessions[1],
              id: "terminal",
              title: "Terminal",
              continuation: { status: "idle", executionLocation: "terminal" },
            },
            {
              ...sessions[1],
              id: "busy",
              title: "Busy",
              continuation: {
                status: "idle",
                executionLocation: "external",
                ownershipReason: "claude-owner-busy",
              },
            },
            {
              ...sessions[1],
              id: "unsupported",
              title: "Unsupported",
              continuation: { status: "unsupported", reason: "platform-unsupported" },
            },
          ]}
        />,
      );
      expect(screen.getByRole("status", { name: copy.running })).toHaveClass("bg-primary");
      expect(screen.getByRole("status", { name: copy.terminalBadge })).toHaveClass(
        "bg-muted-foreground",
      );
      expect(screen.getByRole("status", { name: copy.busy("Claude Code") })).toHaveClass(
        "bg-muted-foreground",
      );
      expect(screen.queryByRole("status", { name: copy.viewOnly })).toBeNull();
      expect(screen.getByRole("button", { name: /Running/ }).textContent).toContain("●");
      expect(screen.getAllByRole("status")).toHaveLength(3);
    },
  );
  it.each([
    ["zh-CN", "没有匹配的会话"],
    ["zh-TW", "沒有符合的對話"],
    ["en-US", "No matching sessions"],
    ["ja-JP", "該当する会話はありません"],
  ] as const)("uses session terminology in empty search feedback in %s", (locale, noResults) => {
    render(
      <SessionCatalog
        locale={locale}
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "No such session title" } });
    expect(screen.getByText(noResults)).toBeVisible();
  });
});
