// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ActivityRecord } from "@/core/types";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import { GlobalSettings, type GlobalSettingsProps } from "@/features/settings/GlobalSettings";
import { SettingsSidebar } from "@/features/settings/SettingsSidebar";
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
  afterEach(async () => {
    cleanup();
    await act(() => changeLocale("en-US"));
  });

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

  it.each([
    {
      locale: "zh-CN",
      settings: "设置",
      diagnostics: "诊断",
      audit: "本地审计活动",
      message: "例行发现记录可在“设置 > 诊断 > 本地审计活动”查看。",
    },
    {
      locale: "zh-TW",
      settings: "設定",
      diagnostics: "診斷",
      audit: "本機稽核活動",
      message: "例行探索記錄可在「設定 > 診斷 > 本機稽核活動」查看。",
    },
    {
      locale: "ja-JP",
      settings: "設定",
      diagnostics: "診断",
      audit: "ローカル監査アクティビティ",
      message: "定期探索の記録は「設定 > 診断 > ローカル監査アクティビティ」で確認できます。",
    },
    {
      locale: "en-US",
      settings: "Settings",
      diagnostics: "Diagnostics",
      audit: "Local Audit Activity",
      message: "Routine discovery runs are kept in Settings > Diagnostics > Local Audit Activity.",
    },
  ] as const)("points to the actual audit settings destination in $locale", async (copy) => {
    await act(() => changeLocale(copy.locale));
    useSidebarViewStore.getState().setSettingsQuery("");
    const home = render(
      <RecentActivitySection activity={[]} pending={false} onShowActivity={vi.fn()} />,
    );
    const message = within(home.container).getByText(copy.message);
    expect(message).toBeVisible();
    expect(message).toHaveTextContent(`${copy.settings} > ${copy.diagnostics} > ${copy.audit}`);
    expect(tr("nav.settings")).toBe(copy.settings);

    const onSelect = vi.fn();
    const navigation = render(<SettingsSidebar active="general" onSelect={onSelect} />);
    fireEvent.click(within(navigation.container).getByRole("button", { name: copy.diagnostics }));
    expect(onSelect).toHaveBeenCalledWith("diagnostics", undefined);

    const noop = async () => undefined;
    const props: GlobalSettingsProps = {
      section: "diagnostics",
      workspaces: [],
      remoteGateways: [],
      scanRoots: [],
      excluded: [],
      activity: [],
      onAddRoot: noop,
      onRemoveRoot: noop,
      onRestore: noop,
      onCloseBehaviorChanged: noop,
      onLocaleChanged: vi.fn(),
      onSessionIndexCleared: vi.fn(),
      onOnboardingRestarted: noop,
      onRemoteGatewaysChanged: noop,
      onRefreshDiagnostics: noop,
    };
    const settings = render(<GlobalSettings {...props} />);
    expect(
      within(settings.container).getByRole("heading", { name: copy.diagnostics }),
    ).toBeVisible();
    expect(within(settings.container).getByRole("heading", { name: copy.audit })).toBeVisible();
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
