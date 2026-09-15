# AgentKib v8 Design QA

**Source visual truth**

- Prototype: `designs/agentkib-codex-flow-redesign-v8.pen`
- Home frame export: `qa/home-reference-v8-original.png`
- Normalized home reference: `qa/home-reference-1215.png`

**Rendered implementation**

- Electron home: `qa/home-implementation-final.jpg`
- Workspace overview: `qa/workspace-overview-implementation.jpg`
- Agent inspector: `qa/agent-implementation.jpg`
- Settings light/dark: `qa/settings-light-implementation.jpg`, `qa/settings-dark-implementation.jpg`

**Viewport and normalization**

- Source frame: 1360 × 860 CSS px, exported at 2720 × 1720 px (`@2x`).
- Electron capture: 1215 × 768 px at the active macOS window density.
- For the full-view comparison, the source was downsampled to 1215 × 768 px so source and implementation use the same pixel dimensions and aspect ratio.
- Compared state: light theme, global “Today” page, expanded 256 px contextual sidebar, populated workspace data, no pending issues.

**Full-view comparison evidence**

- Initial comparison: `qa/home-comparison-initial.png`
- Final comparison: `qa/home-comparison.png`
- The final pass verifies the major-region proportions, task-first hierarchy, 360 px recent-workspace rail, neutral surfaces, dark primary buttons, blue links/focus accents, selected navigation weight, and bottom settings entry.

**Focused-region evidence**

- Separate full-window captures were used for the workspace-context sidebar, Agent master/detail inspector, flat settings layout, and neutral dark-theme mapping. A further crop was not required because controls, labels, dividers, and typography are legible in the 1215 × 768 captures.

**Required fidelity surfaces**

- Fonts and typography: Geist/system stack retained; heading, body, label, and muted-text hierarchy match the v8 density. Long paths and names truncate instead of displacing status/actions.
- Spacing and layout rhythm: 52 px toolbar, 256 px sidebar, 24 px content inset, 20 px master/detail gap, 360 px list rail, and 840 px settings content ceiling are implemented. Content expands naturally without viewport-filling placeholder cards.
- Colors and tokens: light surfaces are neutral white/gray; selected state is `#EDEEEE`; primary actions are dark; blue is limited to links/focus/compact status emphasis. Dark mode uses `#181818` and neutral grays without blue-gray large surfaces.
- Image and icon fidelity: existing Agent assets and Lucide icons are reused; no substitute glyphs, CSS drawings, or generated icon assets were introduced.
- Copy and content: navigation is renamed and regrouped to match v8 (“Today”, global asset catalog, quota, insights), while values remain real API/Query data rather than prototype fixtures.

**Comparison history**

1. Initial pass — blocked by P1/P2 differences:
   - P1: Home still used the legacy onboarding card and metric-card stack instead of the v8 task center.
   - P2: stored accent themes colored primary buttons and the sidebar blue.
   - P2: the bottom settings entry was a plain row, recent-workspace navigation was too dense, and the home breadcrumb lacked its parent context.
2. Fixes applied:
   - Rebuilt the populated home state around a compact summary, issue queue, recent workspaces, and natural activity flow.
   - Increased selector specificity so accent preferences no longer tint large surfaces or primary actions.
   - Added the card-style settings entry, reduced recent sidebar workspaces to two, and added `Workspaces / Today` breadcrumb context.
3. Post-fix pass:
   - `qa/home-comparison.png` has no actionable P0/P1/P2 mismatch. Remaining content differences are expected because the app renders live workspace, activity, health, and Agent data instead of prototype fixtures.

**Findings**

- No actionable P0, P1, or P2 visual findings remain in the checked states.

**Open Questions**

- None blocking. Exact native blur appearance varies with the macOS content behind the translucent sidebar; the solid fallback remains neutral.

**Implementation Checklist**

- [x] Global, workspace, Agent, and settings sidebar contexts
- [x] Fully hidden sidebar and toolbar recovery affordance in the implementation and automated coverage
- [x] Task-first home, workspace master/detail, Agent inspector, flat settings groups
- [x] Light and representative dark states
- [x] Loading/empty/error/status behavior retained from existing Query-backed pages
- [x] Same-input source/implementation visual comparison

**Follow-up Polish**

- P3: Real activity action names currently expose internal event identifiers when no localized label exists. This does not alter layout or the core task flow, but future copy cleanup could improve readability.

## Tools & Updates implementation

**Source and rendered evidence**

- Pen direction: `designs/agentkib-settings-tool-updates/direction-2-grid.pen`
- Pen export: `designs/agentkib-settings-tool-updates/direction-2-grid.png`
- Electron light theme: `qa/tools-updates-implementation.png`
- Electron dark theme: `qa/tools-updates-dark.png`
- Electron 1215 × 768 responsive state: `qa/tools-updates-narrow.png`
- Side-by-side comparison: `qa/tools-updates-comparison.png`

**Viewport and state**

- The Pen and primary Electron captures both use a 1440 × 920 CSS px viewport and a 2× PNG export (2880 × 1840 px).
- The Electron capture uses the real settings shell and live read-only tool detection. It shows eight Agent cards, a Codex path conflict, a Claude Code update, uninstalled tools, a cached-version warning, and partial upstream failures.
- The implementation retains the existing application toolbar and breadcrumb, while the Pen direction omits that application-level chrome. Card hierarchy, four-column density, status treatment, update actions, and the two bottom command panels remain aligned with the selected direction.

**Comparison history**

1. Initial implementation pass:
   - P2: the fixed-size `AgentIcon` overflowed an additional wrapper and visually collided with Agent names.
   - P2: `DeepSeek Harness` was truncated at 1440 px.
   - P2: duplicated cached and partial-error notices pushed the bottom panels below the 920 px viewport.
2. Fixes applied:
   - Sized the existing Agent icon component through its wrapper instead of nesting a second visible icon frame.
   - Reduced only the card-header density needed to keep every Agent name readable.
   - Combined related cached/partial-source notices and tightened card rhythm without removing status, version, channel, path, warning, or action information.
3. Final pass:
   - At 1440 × 920, the page scroll container is 868 px high and its content is exactly 868 px high; no heading is truncated and no child reports overflow.
   - At 1215 × 768, the grid becomes two columns with no horizontal overflow; vertical scrolling is expected for the additional rows.
   - The dark theme preserves readable neutral surfaces and distinct conflict, update, cached, and safe-command states.

**Findings**

- No actionable P0, P1, or P2 visual findings remain in the checked light, dark, and responsive states.
- Live GitHub API rate limiting was handled as designed: cached versions remained visible and four source failures were summarized without blocking local detection.

**Post-handoff interaction verification**

- Fixed the transparent Electron drag layer intercepting the collapse, search, and overflow controls.
- Verified in the running Electron window that collapse, collapsed-state restore, global search, and the overflow menu all respond to pointer input.
- In the collapsed macOS state, the restore control and breadcrumb now clear the native traffic-light area.

final result: passed

### Official-channel and execution pass

- Electron verification: `qa/tools-updates-official-channels.jpg` (1215 × 768).
- The live page renders seven managed Agent cards; DeepSeek Harness is absent while the rest of the application can continue recognizing its historical data.
- Version labels are channel-aware. Verified npm, pnpm, Bun, Homebrew, and native updater actions are executable; remote installer scripts, Yarn, Nix, desktop-app, local, unknown, and conflicting installations remain manual.
- The update confirmation was opened and checked for Agent, channel, current version, target version, executable path, and the fixed command. The final confirmation was cancelled so QA did not modify any installed CLI.
- The card grid, installation-channel selector, conflict state, partial-source warning, sequential batch-update entry, and narrow-window scrolling remain readable without horizontal overflow.

final result: passed

## Settings layout unification

**Scope**

- Checked all six settings destinations in the running Electron app: General, Discovery, Tools & Updates, Integrations, Data & Privacy, and Diagnostics.
- Checked the shared form, management, and workspace widths, section hierarchy, panel borders, notices, statuses, and scroll behavior.
- Checked representative General and Integrations states in both light and dark themes; restored the app to light theme after verification.

**Results**

- General and Data & Privacy retain the compact form layout.
- Discovery, Integrations, and Diagnostics share the wider management layout and consistent panel treatment.
- Tools & Updates keeps its full-width card workbench while sharing the page, notice, and status primitives.
- Integration cards no longer use a separate shadowed/large-icon visual language; diagnostic panels now align to the same title and content rhythm.
- Responsive behavior was checked at the application's minimum-width constraint (`minWidth: 1280`); no horizontal overflow or clipped controls were observed. The settings grid and management columns collapse through their existing responsive breakpoints.

final result: passed

## v14 local session hub — 2026-09-07

**Scope and reference**

- Implemented the approved local-history stage, not the remote-control design: one 360 px directory within the existing navigation rail, filtered local overview, and in-place historical conversation reading.
- References: `designs/agentkib-v14-previews/40-aggregate-default.png` and `41-remote-live-chat.png`.
- Retained the production macOS window controls, breadcrumb, global navigation, tools group, typography tokens and Agent icons. These occupy more vertical space than the simplified Pen shell. Directory and conversation scrolling remain independent.
- Replaced the reference's remote-client selector, running/approval counts, permissions and composer with verified local record states, index statuses, a history notice and the existing workspace-continuation entry. No remote devices, live controls or fabricated execution states were added.

**Real Electron verification**

- Used an isolated temporary AgentKib Home, Chromium profile and synthetic Codex/Claude records across three registered workspaces, including two workspaces with the same name. No real user transcripts or project paths were used.
- Captured the actual 1360 × 860 window without OS shadows at 2×: `qa/sessions-v14/overview-light-1360.png`, `history-light-1360.png`, and `overview-dark-1360.png`.
- Also inspected the native zoomed 2056 × 1204 dark window: `qa/sessions-v14/overview-dark-wide.png`. Four metrics and the two overview panels remain readable; the directory stays in the original rail.
- Verified current/all filtering (4 current; 6 total, 5 readable, 1 archived, 1 metadata-only), title search, empty results and reset. Excluding the selected record returns to the overview.
- Opened metadata-only history: descriptive empty state, no transcript and no continuation action. Opened readable history: messages, saved tool summaries and an explicit non-live notice, without a composer.
- Opened “More”: Settings is enabled; Remote connection is disabled and exposes “Not available yet.” Settings navigation and switching back preserve the directory state. Restored the isolated app to light theme.
- Activated “Continue in workspace” and verified that the original workspace session page opened with the intended session selected. No continuation command was executed during QA.

**Visual comparison**

- Examined combined reference/implementation images at the same 1360 × 860 layout scale: `qa/sessions-v14/comparison-overview.png` and `comparison-history.png`.
- Examined the focused sidebar/header crop in `qa/sessions-v14/comparison-focus.png`: one rail, aligned directory width, existing neutral tokens and icons, readable 14 px directory/body text, consistent control radii and no overlapping controls.
- The actual history is longer than the Pen sample and correctly scrolls vertically. The overview panels size to real content rather than reserving space for remote approvals.
- The initial exploratory comparison used an OS-shadow capture and is not a valid pixel-alignment reference; only the final no-shadow comparisons above are used for acceptance.

**Problems found and corrected**

- Real refresh initially failed because upstream discovery registered OpenCode while the store accepted only Codex/Claude. Aligned the store check with registered conversation providers and verified a successful refresh in Electron. No RPC or database schema changed.
- Independent data review found two deep-link races: a retry clearing errors before recovery, and the first render after re-enabling indexing. Both were corrected and covered by regression tests.
- Automated tests also cover concurrency capped at four, cached results on partial failure, index-off behavior, stale history/pagination requests, duplicate workspace names, navigation and the disabled remote entry.

**Validation and remaining coverage**

- `pnpm test`: 56 files / 306 tests passed.
- `pnpm typecheck`, `pnpm build`, `cargo fmt --all -- --check`, `cargo test -p agentkib-store` (34 tests), and `git diff --check` passed.
- The checked 1360 px light/dark and native wide-window states pass visual review. Exact 1440 × 920 and sub-1024 drawer viewport captures remain unverified: the native automation did not resize to the requested dimensions, and production Electron retains its existing 1280 px minimum width. Responsive drawer structure has automated coverage, but that is not a substitute for its remaining rendered narrow-viewport acceptance.

final result: implementation and verified desktop states passed; exact-size/narrow visual coverage remains pending

### Session overview header correction — 2026-09-07

- Source: user-annotated `codex-clipboard-19012e84-17cb-4b7e-95c8-565c0f758e49.png` (2560 × 1578), identifying the duplicate page-heading band below the shared “Sessions” toolbar.
- P2 corrected: removed the overview-only title, matching-record subtitle and duplicate content refresh button. The existing window toolbar and directory refresh remain; a selected conversation still has its identifying title, back action and workspace continuation.
- Real Electron capture: `qa/sessions-v14/overview-header-simplified.png`, 1280 × 789 CSS px / 2560 × 1578 at 2×. Compared the same light-theme overview and fixture counts against the supplied image, normalized to 1280 × 789 per side.
- Full comparison: `qa/sessions-v14/comparison-header-simplified.png`; focused header comparison: `qa/sessions-v14/comparison-header-focus.png`.
- Typography, neutral colors, Agent icons, sidebar geometry and metric content are unchanged. The removed band allows the existing content to move upward; no replacement heading or empty spacer was introduced. No new image assets were needed.
- Verified one refresh button in the overview, selected-history title/continuation still present, and successful return to overview. No overlap or clipping was found in this scoped correction.
- Validation: 14 related UI tests passed; `pnpm typecheck` and `git diff --check` passed. This local correction does not close the earlier exact-size/narrow-viewport coverage gap for the broader feature.

final result: passed

### Unified global search and compact session directory — 2026-09-07

- Moved global search to the primary sidebar brand row and settings Back row. The settings-only search remains separate; the right toolbar no longer duplicates global search. Verified the visible fallback while the primary sidebar is collapsed.
- The directory now has only its compact label and options menu above workspace groups. Agent/record filters are in submenus, with removable non-default chips. Verified reset from an archived search result returns to the current-record overview.
- Search groups indexed sessions, registered workspaces, logical assets and pages. Verified keyboard selection from Settings into an archived session, same-name workspaces with distinct paths, asset metadata details and return to the unchanged query. No asset file is executed or read by these interactions.
- Read-only search loaders have regression coverage for disabled indexing, max-four concurrency, cached records, partial errors, retry, stale requests and logical asset merging. The backend caps catalog results at 500; reaching that cap now produces a limitation notice instead of claiming complete results.
- Independent review caught popup/portal layers below the floating sidebar, hidden focus restoration targets and directory peek closing while a submenu was open. Search uses overlay/popup layers 100/101; only sidebar menu positioners use 80. Regression tests cover these layers, focus fallback, combobox keyboard behavior and closing mobile drawers when global search opens.
- Real Electron QA used the existing isolated synthetic workspace fixture and its 1280 × 789 window. Light/dark search, asset detail, directory menu and collapsed navigation were inspected; the temporary profile was restored to light mode and the current-record overview. Capture files (2784 × 1802 PNG including the native window shadow): `qa/sessions-v14/search-sidebar-light.png`, `search-dialog-light.png`, `search-dialog-dark.png`, `search-asset-detail.png`, `search-directory-menu.png`.
- A development hot-reload context error (`SessionHubProvider is required`) occurred while editing the shared root/sidebar modules. After full renderer reload, the Settings → global search → archived-session path was retested successfully. This was not treated as a successful HMR test.
- Validation: final `pnpm test`, `pnpm typecheck`, `pnpm build` and `git diff --check` all passed. Existing Node localstorage warnings remain non-failing. No commit, PR, production dependency, Rust RPC or database changes were introduced by this search work.
- Remaining visual coverage: sub-1024 viewport/drawer rendering could not be verified in the native window because `MAIN_WINDOW_MIN_WIDTH` is 1280. Responsive structure, drawer closure and overlay layers have automated/static coverage; this is not a substitute for a rendered narrow-viewport check. Native minimum sizing was not changed just for QA.

final result: implemented and verified at the available desktop size in both themes; narrow-viewport visual acceptance remains pending

### Sidebar search placement and stable width correction — 2026-09-07

- Removed the session-route 360px sidebar override. Sessions now inherits the same 224px width as the other primary pages, including the expanded floating sidebar.
- Search remains in the original sidebar header and hides with it; removed the extra window-navigation search button and its reserved spacing. Keyboard search remains available. When the original search trigger is hidden, closing the dialog can restore focus to the existing sidebar toggle.
- Real Electron QA at 1280 × 789 confirmed matching sidebar boundaries when switching Today → Sessions, no extra search icon when collapsed, successful ⌘K search, and Escape focus restoration to Expand sidebar. Restored the expanded session overview afterward.
- Validation: the full frontend suite passed (59 files, 340 tests); after the focus adjustment, the AppShell/global-search regression tests and typecheck were rerun. No backend, protocol or persisted settings changes; no commit created.
- This supersedes the earlier collapsed-search fallback behavior, not the outstanding narrow-viewport coverage limitation.

final result: passed for this scoped correction

### Session directory final simplification — 2026-09-07

- Session rows retain only the Agent icon and title; Agent/record metadata remains in the hover description.
- Workspace groups use closed/open folder icons without a separate chevron. Full-row activation and accessible expanded state remain intact.
- Selected sessions use only the existing background highlight, without the inset edge. Removed the directory footer refresh action; the history detail refresh remains available.
- Updated directory regression coverage for folder state and removal of the footer action. Directory/history tests (15 tests), typecheck and whitespace checks passed. These scoped changes have automated coverage; no new full visual acceptance is claimed.

### Shared resizable sidebar — 2026-09-07

- All expanded desktop sidebars now share a 250px default and a 250–400px drag range; Sessions does not apply a separate width. The effective maximum also reserves 640px for main content. Collapsed, floating-peek and mobile drawer states do not expose the resize handle.
- The boundary supports pointer dragging, double-click reset, arrow-key adjustment and Home/End. Cancellation restores the saved width. Saving occurs on release, not on every pointer move; failed saves restore the previous value and display a notice.
- Width is stored in the existing `preferences.json`, preserving other preferences, rather than relying on Chromium storage. Protocol version 10 adds the validated width preference and setter. Stale Runtime reads cannot overwrite an in-flight or newer width selection.
- Real Electron QA used an isolated benchmark data directory and Chromium profile at 1360 × 860. Confirmed the initial 250px boundary, dragging beyond the maximum clamps to 400px, disk persistence without changing other preferences, and double-click restoration to 250px. Inspected `output/playwright/sidebar-resize-250.png`; no overlap or horizontal overflow was observed in this state.
- Automated checks cover shared page widths, collapsed/narrow handle visibility, pointer cancellation, keyboard/reset behavior, save serialization/failure, hydration, stale Runtime responses and preserving unrelated preferences. Validation passed: 61 frontend/Electron test files with 368 tests, typecheck, build, 36 relevant Rust runtime/protocol tests, Rust formatting and `git diff --check`.
- Remaining manual coverage: the follow-up Electron automation connection stalled, so a full process restart, dark theme and narrow-window rendering were not accepted by this QA run. Persistence and responsive behavior have automated coverage, not a substitute for those visual checks. Only the isolated QA instance was stopped; the existing user app and development server were left intact.

final result: implemented; scoped light desktop drag/reset and persistence verified, remaining manual coverage documented
