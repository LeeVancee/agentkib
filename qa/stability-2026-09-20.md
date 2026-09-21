# AgentKib stability candidate QA — 2026-09-20

## Source and environment

- Source revision: `19d7c2d3f21c035cfb907e8e20ac422a12f3d002`
- Working tree: dirty before this iteration and still dirty. Existing Antigravity and other uncommitted work was retained; this record does not treat it as a clean release checkout.
- Host: macOS arm64
- Node: `v22.23.2`, invoked through `npx --package node@22`
- pnpm: `10.8.1`
- Dependency install: `pnpm install --frozen-lockfile` completed without changing the lockfile and restored the missing `@tanstack/markdown` package. pnpm's optional metadata lookup logged a transient registry TLS error after the locked install had completed.

## Candidate

- Unsigned directory: `/tmp/agentkib-stability-2026-09-20-unsigned.K31CKc/mac-arm64/AgentKib.app`
- Builder command: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir apps/desktop exec electron-builder --mac --arm64 --dir --publish never --config.directories.output=/tmp/agentkib-stability-2026-09-20-unsigned.K31CKc`
- Signature check: ad-hoc linker signature only; `TeamIdentifier` is absent and no Developer ID identity was used.
- Runtime SHA-256: `7144b0bd24e61f5c45f8e8b3b0c36d3096f371c51380613c5e2dc18e43d8d9ca`
- Quota sidecar SHA-256: `fedb811ac46b82f560962874de85971b9486c80336a214b7ba0f2fb885e9d7cb`
- Isolated launch data: `/tmp/agentkib-stability-qa-dev.CVRVnE` for the automatic ready/exit run and `/tmp/agentkib-stability-qa-live.MdjRr1` for the read-only UI run.

The installed AgentKib process already owned the production MCP port `47653`. It was left running and untouched. The candidate was therefore launched with the repository's existing Dev flavor, which uses `47654`, while both Electron and runtime data were redirected to the isolated directories above. The candidate completed its Runtime handshake, created a fresh database and remote identity, reached the home-data-ready marker, and exited cleanly in the automatic run. The live run exposed Runtime on `127.0.0.1:47654`; it was stopped after inspection and left no listener behind.

The packaged resources contain the arm64 Runtime, quota sidecar, quota resource bundle, built Web client and updater code. The candidate UI loaded the home, Runtime-backed quota page, QuickConnect panel, and Web access settings. No installed application, production data, package, or remote service was overwritten.

## Verification commands

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo test --workspace` | Passed, 774 Rust tests |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `pnpm format:check` under Node 22 | Passed |
| `pnpm lint` under Node 22 | Passed with existing non-fatal warnings |
| `pnpm test` under Node 22 | Passed: Desktop 688 passed / 1 skipped; Web 74 passed |
| `pnpm typecheck` under Node 22 | Passed for Desktop and Web |
| `pnpm build` under Node 22 | Passed, including release Runtime, Web bundle, renderer, main and preload |
| `pnpm build:web:hosted` under Node 22 | Passed |
| `git diff --check` | Passed |

The one skipped frontend test is the opt-in real Claude acceptance test. No real model was started.

## Acceptance results

| Area | Result | Evidence |
| --- | --- | --- |
| ChangeSet rollback safety | Passed | 17 focused ChangeSet tests cover external modification/creation, an applied prefix followed by conflict, post-write validation failure, missing or unreadable backup, rollback failure and a second external modification before rollback. External content is preserved and recovery details include affected targets and backup locations. |
| Web access invalidation | Passed | Production Web tests cover revoke, disabled indexing, host/session changes and delayed responses without restoring private state. |
| Web send control | Passed | Tests assert one mutation for an uncertain send, no automatic mutation retry, and no unlock from polling or a refresh that began before failure. |
| Web approvals/questions | Passed | Tests cover close-only behavior, projection changes, cancellation, permission revocation and disconnect invalidation. |
| Hosted transport | Passed | Cookie/Bearer/CSRF isolation, protocol compatibility, SSE CRLF/multiline/UTF-8 chunks and mutation no-retry behavior pass in the shared Web Vitest project. |
| Skill worker isolation | Passed | Runtime tests cover sequential execution, ordinary Runtime responsiveness while a Skill task is slow, one running plus eight queued requests, immediate queue-full error, deadline from enqueue, cancellable network waits, shutdown rejection, local-operation completion and one response per request. Existing preview-token, drift and install-recovery tests also pass. |
| Candidate Runtime and quota | Passed | Isolated candidate startup completed; Runtime bound the Dev port and created its database. The quota page rendered through the packaged sidecar path. |
| Candidate update/Markdown/session UI | Passed with bounded scope | Updater code is present in `app.asar`. The built Web client rendered Markdown, long code/text, tool details and older-page insertion in a real headed Chromium session. No release feed or signed-update installation was attempted. |
| QuickConnect and built-in Web | Passed with synthetic peers | Candidate QuickConnect and Web settings rendered. Production service tests cover pair/approve/revoke. The built Web bundle completed synthetic pairing, catalog load, session read, pagination, desktop/mobile layout and end-access return to the pairing screen. |
| Control fixtures | Passed | Codex, Claude and Antigravity control tests use synthetic owner/CLI/ACP fixtures; the real-model test remains opt-in and skipped. |

Browser artifacts are in `output/playwright/stability-2026-09-20/`, including `web-session.png`, `web-session-mobile.png` and the accessibility snapshots for pairing, catalog, pagination and access termination.

## Post-review Runtime fixes

After the candidate build, the Skill worker exit paths were updated to flush pending JSON-RPC responses on stdin EOF or read failure, and network-method completions that pass the enqueue deadline now return a deadline result even when synchronous filesystem work delayed the timer. The candidate directory above predates these follow-up source edits; its launch acceptance is not a validation of the updated Runtime binary.

Focused verification of the updated source: `cargo test -p agentkib-runtime skill_` (10 passed), `cargo test -p agentkib-runtime` (121 passed), `cargo clippy -p agentkib-runtime --all-targets -- -D warnings` (passed), and `cargo fmt --all -- --check` (passed). The first focused test attempt used a stale compiled `agentkib-skills` artifact and failed to find the existing `cached_curated_stale` method; `cargo clean -p agentkib-skills` removed only derived build artifacts, after which the source recompiled and all checks above passed.

## Follow-up stdio acceptance and rebuilt candidate

- Source revision at rebuild: `e788fd96a194e5ee9e769f1bcf17fb21b7d9dcf8`, with the stability changes still uncommitted.
- New integration test: `cargo test -p agentkib-runtime --test stdio_shutdown` passed. It sends three Skill requests to a real Runtime process, closes stdin, and verifies one JSON-RPC response per request.
- Updated Runtime verification: `cargo test -p agentkib-runtime` passed (121 unit tests and 1 stdio integration test); `cargo clippy -p agentkib-runtime --all-targets -- -D warnings`, `cargo fmt --all -- --check`, and `git diff --check` passed.
- Rebuilt with Node 22 and pnpm 10.8.1 using `pnpm build`, followed by `pnpm --dir apps/desktop quota:prepare`. The unsigned directory candidate was packaged with `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir apps/desktop exec electron-builder --mac --arm64 --dir --publish never --config.directories.output=/tmp/agentkib-stability-postreview-2026-09-20-unsigned.r6R0bB`.
- Current candidate: `/tmp/agentkib-stability-postreview-2026-09-20-unsigned.r6R0bB/mac-arm64/AgentKib.app`. Its packaged Runtime matches `target/release/agentkib-runtime` byte for byte; both have SHA-256 `7c3ead74975e9c6bf6f3ea61859802937fcf30dba64cb16979302985f8dcff76`. The quota sidecar SHA-256 is `fedb811ac46b82f560962874de85971b9486c80336a214b7ba0f2fb885e9d7cb`. The app has only an ad-hoc linker signature and no TeamIdentifier.
- Isolated launch data: `/tmp/agentkib-stability-postreview-qa.ioCP8p`. The candidate exited 0 after `runtime-handshake` and `home-data-ready`, created a fresh `agentkib.db`, and left no listener on Dev port `47654`. Its packaged Runtime independently passed the same three-request EOF check with exactly one response per ID.

The previous headed browser and UI checks cover unchanged Web and Electron frontend source. This follow-up verified the rebuilt package's startup and Runtime EOF behavior; it did not repeat those visual checks.

## PR verification

Before committing the combined Antigravity and stability branch, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`, frontend `format:check`, `lint`, `typecheck`, `test`, and the complete production build passed. Desktop Vitest reported 688 passed and 1 opt-in real-model test skipped; Web Vitest reported 76 passed. Lint exited successfully with non-fatal warnings. The unrelated design and older QA files still present in the local worktree were not staged for this PR.

## Release gates outside this iteration

The following remain release gates and are not claimed by this QA pass: a real phone, a second physical computer, Windows/Linux hardware, signing and notarization, a signed end-to-end updater path, and real-model control acceptance. Version changes and formal release work remain deferred until those gates are completed.
