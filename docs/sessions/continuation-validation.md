# Continuation Validation

This document records sanitized acceptance evidence for conversation continuity. Use synthetic sessions and never include real credentials, private conversation content, private repository paths, or other unrelated personal data.

## Recording rules

- Record the source agent, target agent, capability, agent version, platform, architecture, mode, date, outcome, losses, and fallback.
- For native continuation and interactive launch, confirm the target agent actually opened the expected context; a spawned process is not sufficient.
- Mark a capability as `supported` only when the required evidence is present.
- Keep failures and unavailable prerequisites visible; do not convert them into success claims.

## Entry template

```text
Date:
Source agent:
Target agent:
Capability:
Agent version:
Platform / architecture:
Mode:
Fixture:
Outcome:
Losses:
Fallback:
Evidence:
```

## Phase 0 automated baseline — 2026-09-03

- Ref: `upstream/codex/continuation-home-activation` at `8d6ce1f0`
- Rust: `cargo fmt --all -- --check` passed; `cargo test --workspace` passed
- Protocol: `pnpm --filter @agentkib/desktop protocol:generate` passed
- Frontend: `pnpm test` passed — 50 test files, 245 tests
- Type checking: `pnpm typecheck` passed
- Lint: `pnpm lint` completed with existing warnings and no errors
- Formatting: `pnpm format:check` passed
- Build: `pnpm build` passed
- Native continuation: not verified; real Codex ↔ Claude Code startup was not executed

This baseline does not mark native continuation as supported. Real target-agent visibility and startup evidence are still required.

## Phase 0 latest automated baseline — 2026-09-03

- Ref: `upstream/codex/continuation-home-activation` at `e454e902`
- Rust: `cargo fmt --all -- --check` passed; `cargo test --workspace` passed
- Protocol: `pnpm --filter @agentkib/desktop protocol:generate` passed
- Frontend: `pnpm test` passed — 50 test files, 246 tests
- Type checking: `pnpm typecheck` passed
- Lint: `pnpm lint` completed successfully with warnings and no errors
- Formatting: `pnpm format:check` passed
- Build: `pnpm build` passed; quota sidecar was skipped because no prepared host binary was available
- GitHub CI: five check runs on `e454e902` completed successfully
- Native continuation: not verified; Claude Code CLI is unavailable on the current machine, so real Codex ↔ Claude Code startup was not executed

This is the current automated baseline. It is evidence for Phase 0, but Phase 0 is not complete until PR #60 is merged and no P0/P1 review issue remains. Native continuation support and real target-agent visibility are Phase 1 requirements, not Phase 0 completion gates.

## Phase 0 latest tip — 2026-09-03

- Ref: `upstream/codex/continuation-home-activation` at `9ff8a152`
- Change since the previous baseline: continuation writes now re-check that session indexing remains enabled before persisting results.
- Local verification: `cargo fmt --all -- --check`, `cargo test -p agentkib-runtime -p agentkib-adapters -p agentkib-mcp`, and `pnpm typecheck` passed.
- GitHub CI: five check runs completed successfully.
- Latest Codex review: completed with two P2 suggestions; no P0/P1 finding was shown. The suggestions concern invalidating in-flight refreshes after clearing the index and recognizing legacy AgentKib Claude URLs.
- Native continuation: remains a Phase 1 requirement and is not included in this Phase 0 gate.

The local `main` was fast-forwarded to this PR tip. The remote PR is still open, so the Phase 0 merge condition remains pending.

## Phase 0 latest tip — 2026-09-03 (updated)

- Ref: `upstream/codex/continuation-home-activation` at `26969b15`
- Change since `9ff8a152`: protect index clearing and refresh writes with a shared invalidation path, and preserve the relevant MCP configuration boundaries.
- Local verification: `cargo fmt --all -- --check`, `cargo test -p agentkib-runtime -p agentkib-adapters -p agentkib-mcp` — 122 tests passed, and `pnpm typecheck` passed.
- GitHub CI: five check runs completed successfully.
- Latest Codex review: completed against this tip with one P2 suggestion about selecting the workspace containing metadata-only sessions; no P0/P1 finding was shown.
- Native continuation: remains a Phase 1 requirement and is not included in this Phase 0 gate.

The local `main` is fast-forwarded to `26969b15`; the remote PR remains open. All technical checks are green, but the current GitHub account does not have permission to merge PR #60, so the Phase 0 merge condition is still pending.

## PR review status — 2026-09-03

- PR #60 remains open; its latest head is `26969b15`.
- The latest five GitHub check runs completed successfully.
- The latest Codex review completed against `26969b15` with one P2 suggestion about selecting the workspace containing metadata-only sessions; no P0/P1 finding was shown.
- Earlier automated P1/P2 findings were answered with fixes through `26969b15`, including transcript filtering, cached instruction/session visibility, MCP setup gating, preference-safe refresh, managed MCP preservation, URL/path validation, archive-tool readiness, and protection against stale writes after index invalidation.
- The current GitHub account cannot merge the PR: GitHub reports no conflicts and green checks, but the merge action is unavailable due to repository permission.
- Phase 0 therefore remains pending only on the remote merge condition; native continuation remains a Phase 1 requirement.

## Phase 0 completion — 2026-09-04

- PR #60 was merged into `main` on 2026-09-03 21:51 Asia/Shanghai.
- Merge commit: `98d28362` (`Merge pull request #60 from starroyhq/codex/continuation-home-activation`).
- Local `main` was fast-forwarded to `upstream/main` at `98d28362`.
- Phase 0 completion criteria are satisfied: merge completed, CI passed, and no unresolved P0/P1 review issue was found.
- Native Codex ↔ Claude continuation remains a Phase 1 validation item.
