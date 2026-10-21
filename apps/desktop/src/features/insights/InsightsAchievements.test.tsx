// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { Achievement } from "@/core/types";
import { AchievementWall } from "./InsightsAchievements";

describe("achievement card readable states", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it.each([false, true])("keeps track and special cards operable with unlocked=%s", (unlocked) => {
    const achievements: Achievement[] = [
      {
        code: "commit-1",
        category: "commit",
        threshold: 1,
        progress: unlocked ? 1 : 0,
      },
      {
        code: "special-first-changeset",
        category: "special",
        threshold: 1,
        progress: unlocked ? 1 : 0,
      },
    ];
    render(<AchievementWall achievements={achievements} />);
    const cards = [
      screen.getByRole("button", {
        name: tr("achievementWall.openTrack", { category: tr("milestones.category.commit") }),
      }),
      screen.getByRole("button", {
        name: tr("achievementWall.openSpecial", {
          title: tr("achievements.special_first_changeset.title"),
        }),
      }),
    ];
    for (const card of cards) {
      expect(card).toHaveClass(
        "text-muted-foreground",
        "hover:bg-accent",
        "hover:text-muted-accent-foreground",
        "focus-visible:ring-2",
      );
      expect(card.className.includes("bg-[color-mix(in_srgb,var(--green)_7%,transparent)]")).toBe(
        unlocked,
      );
      expect(
        card.lastElementChild?.className.includes(
          "group-hover:text-achievement-status-hover-foreground",
        ),
      ).toBe(unlocked);
      expect(card.firstElementChild?.className).not.toContain("group-hover:");
      fireEvent.focus(card);
      fireEvent.click(card);
      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: tr("common.close") }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });
});
