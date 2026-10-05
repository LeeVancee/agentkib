import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript, type ReaderLabels } from "@agentkib/session-ui";
import type { ConversationEvent } from "@agentkib/web-client";

const labels: ReaderLabels = {
  process: "Process",
  tools: "tools",
  failed: "failed",
  incomplete: "incomplete",
  details: "Details",
  attachments: "attachments",
  truncated: "truncated",
  unknownTool: "Tool",
};

function toolEvent(id: string, turnId = "turn"): ConversationEvent {
  return {
    id,
    turn_id: turnId,
    kind: "tool-summary",
    tool_name: id,
    tool_status: "completed",
    attachment_count: 0,
    truncated: false,
  };
}

afterEach(cleanup);
describe("incremental transcript identity", () => {
  it.each([
    ["zh-CN", "执行中", "已完成"],
    ["zh-TW", "執行中", "已完成"],
    ["en-US", "Running", "Completed"],
    ["ja-JP", "実行中", "完了"],
  ])(
    "localizes a native inProgress tool in %s and completes the same row",
    (locale, running, completed) => {
      const tool: ConversationEvent = {
        id: "active-tool",
        kind: "tool-summary",
        tool_name: "shell",
        tool_status: "inProgress",
        attachment_count: 0,
        truncated: false,
      };
      const view = render(
        <Transcript events={[tool]} labels={labels} onTool={vi.fn()} locale={locale} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Process/ }));
      const row = view.container.querySelector('[data-event-id="active-tool"]');
      expect(screen.getByRole("button", { name: `⌘ shell ${running}` })).toBeVisible();
      view.rerender(
        <Transcript
          events={[{ ...tool, tool_status: "completed" }]}
          labels={labels}
          onTool={vi.fn()}
          locale={locale}
        />,
      );
      expect(screen.getByRole("button", { name: `⌘ shell ${completed}` })).toBeVisible();
      expect(view.container.querySelector('[data-event-id="active-tool"]')).toBe(row);
    },
  );
  it("keeps an expanded process and existing rows mounted when another item arrives", () => {
    const tool: ConversationEvent = {
      id: "tool-1",
      turn_id: "turn",
      kind: "tool-summary",
      tool_name: "read",
      content: "first",
      attachment_count: 0,
      truncated: false,
    };
    const view = render(
      <Transcript events={[tool]} labels={labels} onTool={vi.fn()} locale="en-US" />,
    );
    const toggle = screen.getByRole("button", { name: /Process/ });
    fireEvent.click(toggle);
    const firstRow = view.container.querySelector('[data-event-id="tool-1"]');
    view.rerender(
      <Transcript
        events={[tool, { ...tool, id: "tool-2", content: "second" }]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector('[data-event-id="tool-1"]')).toBe(firstRow);
    expect(view.container.querySelector('[data-event-id="tool-2"]')).not.toBeNull();
  });

  it("keeps an expanded process and its rows mounted when older tools load before later tools arrive", () => {
    const earlier = toolEvent("tool-a");
    const first = toolEvent("tool-b");
    const second = toolEvent("tool-c");
    const later = toolEvent("tool-d");
    const view = render(
      <Transcript events={[first, second]} labels={labels} onTool={vi.fn()} locale="en-US" />,
      { wrapper: StrictMode },
    );
    const toggle = screen.getByRole("button", { name: /Process/ });
    fireEvent.click(toggle);
    const firstRow = view.container.querySelector('[data-event-id="tool-b"]');
    const secondRow = view.container.querySelector('[data-event-id="tool-c"]');
    expect(firstRow).toBeVisible();
    expect(secondRow).toBeVisible();

    view.rerender(
      <Transcript
        events={[earlier, first, second]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector('[data-event-id="tool-b"]')).toBe(firstRow);
    expect(view.container.querySelector('[data-event-id="tool-c"]')).toBe(secondRow);
    const earlierRow = view.container.querySelector('[data-event-id="tool-a"]');
    expect(earlierRow).toBeVisible();

    view.rerender(
      <Transcript
        events={[earlier, first, second, later]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector('[data-event-id="tool-a"]')).toBe(earlierRow);
    expect(view.container.querySelector('[data-event-id="tool-b"]')).toBe(firstRow);
    expect(view.container.querySelector('[data-event-id="tool-c"]')).toBe(secondRow);
    expect(view.container.querySelector('[data-event-id="tool-d"]')).toBeVisible();
  });

  it("keeps a failed process manually collapsed when older tools load", () => {
    const failed = { ...toolEvent("failed-tool"), tool_status: "failed" };
    const view = render(
      <Transcript events={[failed]} labels={labels} onTool={vi.fn()} locale="en-US" />,
    );
    const toggle = screen.getByRole("button", { name: /Process/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    view.rerender(
      <Transcript
        events={[toolEvent("earlier-tool"), failed]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    const currentToggle = screen.getByRole("button", { name: /Process/ });
    expect(currentToggle).toHaveAttribute("aria-expanded", "false");
    expect(currentToggle).toBe(toggle);
    expect(view.container.querySelector('[data-event-id="failed-tool"]')).toBeNull();
  });

  it("keeps expansion independent across processes and repeated turn IDs when history loads", () => {
    const first = toolEvent("first-tool", "turn-1");
    const separator: ConversationEvent = {
      id: "separator",
      turn_id: "turn-1",
      kind: "agent-message",
      content: "Another step",
      attachment_count: 0,
      truncated: false,
    };
    const second = toolEvent("second-tool", "turn-1");
    const turnBoundary: ConversationEvent = {
      ...separator,
      id: "turn-boundary",
      turn_id: "turn-2",
      content: "Another turn",
    };
    const otherTurn = toolEvent("other-turn-tool", "turn-1");
    const view = render(
      <Transcript
        events={[first, separator, second, turnBoundary, otherTurn]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    const [firstToggle, secondToggle, otherTurnToggle] = screen.getAllByRole("button", {
      name: /Process/,
    });
    fireEvent.click(firstToggle);
    const firstRow = view.container.querySelector('[data-event-id="first-tool"]');
    expect(firstRow).toBeVisible();

    view.rerender(
      <Transcript
        events={[
          toolEvent("older-turn-tool", "turn-0"),
          toolEvent("earlier-tool", "turn-1"),
          first,
          separator,
          second,
          turnBoundary,
          otherTurn,
        ]}
        labels={labels}
        onTool={vi.fn()}
        locale="en-US"
      />,
    );
    const toggles = screen.getAllByRole("button", { name: /Process/ });
    expect(toggles).toHaveLength(4);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(toggles[1]).toBe(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    expect(toggles[2]).toBe(secondToggle);
    expect(secondToggle).toHaveAttribute("aria-expanded", "false");
    expect(toggles[3]).toBe(otherTurnToggle);
    expect(otherTurnToggle).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector('[data-event-id="first-tool"]')).toBe(firstRow);

    fireEvent.click(secondToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    expect(otherTurnToggle).toHaveAttribute("aria-expanded", "false");
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector('[data-event-id="second-tool"]')).toBeVisible();
  });

  it("associates each process toggle with its own body across transcript instances", () => {
    const sharedTool = toolEvent("shared-tool");
    render(
      <>
        <Transcript
          events={[{ ...sharedTool, tool_name: "first-instance" }]}
          labels={labels}
          onTool={vi.fn()}
          locale="en-US"
        />
        <Transcript
          events={[{ ...sharedTool, tool_name: "second-instance" }]}
          labels={labels}
          onTool={vi.fn()}
          locale="en-US"
        />
      </>,
    );
    const [firstToggle, secondToggle] = screen.getAllByRole("button", { name: /Process/ });
    fireEvent.click(firstToggle);
    fireEvent.click(secondToggle);

    const firstBody = document.getElementById(firstToggle.getAttribute("aria-controls")!);
    const secondBody = document.getElementById(secondToggle.getAttribute("aria-controls")!);
    expect(firstBody).toContainElement(
      screen.getByRole("button", { name: "⌘ first-instance Completed" }),
    );
    expect(secondBody).toContainElement(
      screen.getByRole("button", { name: "⌘ second-instance Completed" }),
    );
    expect(firstBody).not.toBe(secondBody);
  });
});
