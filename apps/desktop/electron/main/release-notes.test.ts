import { describe, expect, it } from "vitest";
import { normalizeReleaseNotes } from "./release-notes";

describe("normalizeReleaseNotes", () => {
  it("converts GitHub release HTML into readable plain text", () => {
    const releaseNotes = [
      "<h2>What's Changed</h2>",
      "<ul>",
      '<li>fix(release): support macOS signing by <a href="https://github.com/example">@example</a> in <a href="https://github.com/example/project/pull/38">#38</a></li>',
      "</ul>",
      '<p><strong>Full Changelog</strong>: <a href="https://github.com/example/project/compare/v0.6.0...v0.7.0"><code>v0.6.0...v0.7.0</code></a></p>',
    ].join("");

    expect(normalizeReleaseNotes(releaseNotes)).toBe(
      [
        "What's Changed",
        "",
        "- fix(release): support macOS signing by @example in #38",
        "",
        "Full Changelog: v0.6.0...v0.7.0",
      ].join("\n"),
    );
  });

  it("normalizes every entry and decodes HTML entities", () => {
    expect(
      normalizeReleaseNotes([
        { note: "<p>First &amp; second</p>" },
        { note: "<ul><li>编号 &#35;42</li></ul>" },
        { note: "" },
      ]),
    ).toBe("First & second\n\n- 编号 #42");
  });

  it("preserves plain-text release notes", () => {
    const releaseNotes = "## What's Changed\n\n- Fix updater rendering";

    expect(normalizeReleaseNotes(releaseNotes)).toBe(releaseNotes);
  });

  it("removes executable element contents", () => {
    expect(normalizeReleaseNotes("<p>Safe</p><script>alert('unsafe')</script>")).toBe("Safe");
  });
});
