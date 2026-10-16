// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ActivityRecord } from "@/core/types";
import { RecentActivitySection } from "./HomeRecentSections";

const activity: ActivityRecord[] = [
  { id: "1", action: "skill.apply", detail: "First Skill", created_at: "2026-10-16T01:00:00Z" },
  { id: "2", action: "skill.rollback", detail: "Second Skill", created_at: "2026-10-16T02:00:00Z" },
  { id: "3", action: "skill.restore", detail: "Third Skill", created_at: "2026-10-16T03:00:00Z" },
  {
    id: "4",
    action: "skill.uninstall",
    detail: "Fourth Skill",
    created_at: "2026-10-16T04:00:00Z",
  },
];

describe("RecentActivitySection", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("opens the activity list through its dedicated callback", () => {
    const onShowActivity = vi.fn();
    render(
      <RecentActivitySection activity={activity} pending={false} onShowActivity={onShowActivity} />,
    );
    const section = screen.getByRole("region", { name: tr("home.recentActivity") });
    fireEvent.click(within(section).getByRole("button", { name: tr("home.viewAll") }));
    expect(onShowActivity).toHaveBeenCalledTimes(1);
  });

  it("shows loading without claiming the activity log is empty or revealing cached rows", () => {
    render(<RecentActivitySection activity={activity} pending onShowActivity={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(tr("common.loading"));
    expect(screen.queryByText(tr("home.noImportantActivity"))).toBeNull();
    expect(
      screen.queryByText(tr("activity.detail.skill.apply", { name: "First Skill" })),
    ).toBeNull();
  });

  it("shows the existing explanatory empty state after loading", () => {
    render(<RecentActivitySection activity={[]} pending={false} onShowActivity={vi.fn()} />);
    expect(screen.getByText(tr("home.noImportantActivity"))).toBeVisible();
    expect(screen.getByText(tr("home.noImportantActivityText"))).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the latest three entries with their localized titles and details", () => {
    render(<RecentActivitySection activity={activity} pending={false} onShowActivity={vi.fn()} />);
    for (const record of activity.slice(0, 3)) {
      expect(screen.getByText(tr(`activity.action.${record.action}`))).toBeVisible();
      expect(
        screen.getByText(tr(`activity.detail.${record.action}`, { name: record.detail })),
      ).toBeVisible();
    }
    expect(screen.queryByText(tr("activity.action.skill.uninstall"))).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
