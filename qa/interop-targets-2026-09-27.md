# Command import target evidence — 2026-09-27

This record covers target payload conversion and offline native storage checks in the `all-agent-continuation` worktree. It does **not** certify a real model continuation. All probe histories were synthetic; no user history or credentials were read or copied. No installed user CLI was upgraded.

## OpenCode

- Isolated package: `opencode-ai@1.18.32`, `/tmp/agentkib-interop-tools/opencode/node_modules/.bin/opencode`.
- Upstream schema and importer inspected at tag `v1.18.32`: `packages/schema/src/v1/session.ts`, `packages/opencode/src/cli/cmd/import.ts`, `packages/opencode/src/session/session.ts`.
- Official interfaces: `opencode import <file>`, `opencode export <session-id>`, `opencode session list --format json`, interactive `opencode --session <session-id>`.
- Import JSON is `{ info: Session, messages: [{ info: User|Assistant, parts: Part[] }] }`. The caller-provided session and message IDs are retained. Receipt: `Imported session: <id>`.
- The importer inserts session/messages/parts separately. It is **not an atomic transaction**. On ID conflicts the existing message/part is retained; therefore neither exit code nor the success receipt proves that all expected text was written. Runtime must export and strictly compare the confirmed projection and native identity links.
- User records require a model/provider. OpenCode's `currentModel()` falls back to the last user's model. A made-up historical model can break the next reply; production import must use an explicitly configured target model and refuse absent/unknown model configuration.
- The renderer projects historical tool calls/results to clearly labelled text (arguments/output omitted), omits attachments with a visible marker, and reports `TargetToolSummary` / `TargetAttachmentOmitted`. It does not preserve executable tool records or silently lose user/assistant text.

Actual commands run:

```text
npm install --prefix /tmp/agentkib-interop-tools/opencode --no-audit --no-fund opencode-ai@1.18.32
/tmp/agentkib-interop-tools/opencode/node_modules/.bin/opencode --version
cargo test -p agentkib-conversations native_targets --lib
AGENTKIB_TEST_OPENCODE=/tmp/agentkib-interop-tools/opencode/node_modules/.bin/opencode cargo test -p agentkib-conversations official_opencode_import_export_roundtrip -- --ignored --nocapture
```

Results: version `1.18.32`; seven conversion/validation tests passed; the ignored offline CLI test passed using the actual Rust renderer and isolated HOME/XDG roots. Two independent export processes matched exact expected roles/text/order/IDs after import. A separate synthetic probe also appeared in `session list`. Model credentials were removed from the child environment, and no `run`/prompt invocation was made. Real reply and TUI display remain unverified by this record.

Sources: <https://opencode.ai/docs/cli/>, <https://github.com/anomalyco/opencode/tree/v1.18.32>.

## Hermes

- Pinned official release: `v2026.9.24`, CLI/package version `0.21.5`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, isolated source checkout `/tmp/agentkib-interop-tools/hermes-src`.
- `hermes sessions import --from claude <explicit-file>` calls `hermes_cli.foreign_sessions.import_foreign_session` and prints `Imported Claude Code session as <id>` plus `hermes --resume <id>`.
- Each CLI import generates a fresh random target ID. CLI execution is not idempotent; desktop import deduplication must not be assumed to apply to the CLI.
- The session row's `origin_json.imported_from` stores `tool`, `path`, and `foreign_session_id`. An operation-specific source UUID and immutable operation-specific payload path provide an exact reconciliation key after a missing receipt. Zero or multiple matches cannot be treated as confirmed success.
- The pinned importer trims whole messages, merges adjacent same-role turns, filters user content beginning with known injected-wrapper tags, and removes non-text content. The renderer first constructs the exact alternating text projection and rejects user/assistant text that would be trimmed or filtered; it does not silently accept these changes.
- Source JSONL is generated entirely from the frozen preview document. No original Claude/Codex file is passed to the importer.

Actual offline native database check:

```text
git clone --depth 1 --branch v2026.9.24 --filter=blob:none --sparse https://github.com/NousResearch/hermes-agent.git /tmp/agentkib-interop-tools/hermes-src
git -C /tmp/agentkib-interop-tools/hermes-src sparse-checkout set hermes_cli hermes_platform agent tools
uv venv /tmp/agentkib-interop-tools/hermes-env
uv pip install --python /tmp/agentkib-interop-tools/hermes-env/bin/python PyYAML python-dotenv rich httpx requests pydantic psutil packaging prompt-toolkit
AGENTKIB_TEST_HERMES_SOURCE=/tmp/agentkib-interop-tools/hermes-src AGENTKIB_TEST_PYTHON=/tmp/agentkib-interop-tools/hermes-env/bin/python cargo test -p agentkib-conversations official_hermes_import_db_roundtrip -- --ignored --nocapture
```

Result: **passed**, including the full CLI entry point. The actual Rust renderer produced the payload; a separate process invoked `python -m hermes_cli.main --profile default sessions import --from claude <payload>`, equivalent to the installed `hermes` console entry point declared in upstream `pyproject.toml`. After that CLI process exited, reopening the official `SessionDB` returned exactly the previewed role/text sequence. The stored `origin_json` matched both operation UUID and explicit source path, and the source payload remained byte-for-byte unchanged. The same test invokes full `--version` and verifies `Hermes Agent v0.21.5 (2026.9.24)`; separate `sessions import --help` inspection also passed. Initial attempts failed due to missing isolated Python/source dependencies, then passed after filling those dependencies; no additional dependencies were needed for the final full CLI run. Python packages are confined to the temporary venv and are not AgentKib production dependencies. Desktop display, interactive terminal rendering, and a real model response remain unverified by this record.

Sources: <https://hermes-agent.nousresearch.com/docs/user-guide/sessions>, <https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/hermes_cli/foreign_sessions.py>.

## Grok Build

- Official stable channel reported `1.0.41`; binary downloaded directly to `/tmp/agentkib-interop-tools/grok-1.0.41` from `https://x.ai/cli/grok-1.0.41-macos-aarch64` without running the installer or changing shell configuration.
- Actual version: `grok 1.0.41 (4220f3b224a6)`.
- Public CLI documentation advertises `grok import [targets...]`. The actual pinned binary has **no import subcommand**: `grok help import` exited 2 with `unrecognized subcommand 'import'`. `grok import --help` merely returned top-level help; this is not evidence of a working importer. Executing `grok import <file>` would risk treating `import` as a prompt, so it was not attempted.
- A local-format probe created synthetic `summary.json` and `chat_history.jsonl` under isolated `GROK_HOME/sessions`. `grok sessions list` returned `No sessions found`; `grok export <UUID>` exited 1 (`Session ... not found`). A shape readable by AgentKib's history provider therefore does not prove that Grok accepts it natively.
- The pinned binary's embedded official sessions documentation identifies `updates.jsonl` as the authoritative resume/restore log, distinct from `chat_history.jsonl`. A verified writable schema and working target roundtrip for its native index plus updates log were not established. Native target import remains disabled; the renderer fails closed for Grok.
- No model invocation, login, or private session inspection occurred. Source-side support can ship independently of this native-target blocker.

Sources: <https://docs.x.ai/build/cli/reference>, <https://docs.x.ai/build/features/sessions>, pinned official binary above.

## Runtime integration and regression checks

`native_import.rs` supports OpenCode and Hermes command targets, records an attempted marker before mutation, captures only a fixed allowlist of non-secret storage environment paths, and always clears `OPENCODE_CONFIG_CONTENT` in the launched terminal. Runtime inline OpenCode configuration is rejected rather than persisted. Target version, selected model/profile, storage environment, source fingerprint and frozen payload are checked before first mutation. OpenCode launch passes the explicitly confirmed model. Hermes resolves the actual random session ID by unique `origin_json` operation UUID plus payload path, then compares every projected message under a read-only SQLite transaction.

Eight Runtime unit tests passed (`cargo test -p agentkib-runtime native_import::tests --bin agentkib-runtime`): lost-receipt lookup; missing/ambiguous identity; changed text/role/workspace, hidden and executable records; append-only recovery; immutable plan mismatch; environment allowlist/control characters; symlink database rejection; native Hermes parent/child resume redirects with unchanged parent text. The shared document matrix covers eight source AgentKind labels through the actual source finalizer/redactor and both target converters. It is conversion coverage, not a claim that sixteen real source-to-target executions were performed.

First-import OpenCode verification now checks deterministic message/part identities, nearest-user parent links, assistant completion/error/summary state, fixed agent/mode and absence of injected permissions/context or a reverted effective history, in addition to exact role/text/order. Reopening an already-used target permits appended turns while verifying the complete reviewed prefix; changed imported text or executable state still blocks launch.

`cargo clippy -p agentkib-conversations --all-targets -- -D warnings` passed before Runtime integration. A later Runtime all-target Clippy found pre-existing codex_managed lint failures and one concurrently-added Runtime integration-test lint; the main agent owns overall resolution/reporting. This record does not claim whole-workspace Clippy passed.
