# Antigravity complete support acceptance

This document is the delivery contract for Antigravity support. Passing unit tests or displaying an Antigravity entry in the UI is not sufficient.

## Supported baseline

- Target the stable Antigravity Desktop/IDE, Antigravity CLI, and Google-distributed ACP server versions recorded in the final test report.
- Support Codex and Claude Code as the native-session transfer peers.
- Do not claim Gemini CLI support or legacy Antigravity `.pb` compatibility.
- Unknown Antigravity versions may retain verified read-only behavior, but native writes and control must fail closed with a useful reason.

## Native transfer definition

A transfer is native only when all of the following are true:

1. A new conversation appears in the target product's own conversation list.
2. The target product renders the imported roles, order, message bodies, and supported tool records correctly.
3. The conversation remains available after the target product and AgentKib restart.
4. A new target-agent response uses a unique fact from the imported history without receiving the history again.
5. The source conversation remains unchanged and historical tools are not executed again.

A handoff file, MCP archive, in-memory SDK history, or a single prompt containing the transcript does not satisfy native transfer.

## Required implementation flow

1. Read and freeze the source conversation snapshot.
2. Normalize it to AgentKib's `SessionDocument`, redact sensitive values, and surface all representation losses.
3. Require acknowledgement for any material loss.
4. Create a new target-native conversation through a verified provider-specific importer.
5. Read the created conversation back through the target provider and compare its normalized document with the previewed source.
6. Persist the source/target relationship only after verification succeeds.
7. On failure, remove only artifacts created by the failed attempt. A retry of the same operation must not create duplicates.

## Required transfer matrix

Every row must pass in both directions:

| Peer | Antigravity surface | Directions |
| --- | --- | --- |
| Codex | Desktop/IDE | Codex → Antigravity and Antigravity → Codex |
| Codex | CLI | Codex → Antigravity and Antigravity → Codex |
| Claude Code | Desktop/IDE | Claude Code → Antigravity and Antigravity → Claude Code |
| Claude Code | CLI | Claude Code → Antigravity and Antigravity → Claude Code |

## Acceptance scenarios

| ID | Area | Pass condition |
| --- | --- | --- |
| A01 | Installation | Desktop/IDE, CLI, multiple installs, and data left after uninstall are distinguished; reported version and capabilities match the concrete installation. |
| A02 | Assets | Global and workspace Instructions, Skills, MCP, and settings are discovered without duplicates or credential files being catalogued as ordinary assets. |
| A03 | Context | Effective context matches native precedence. Reviewed writes preserve unknown fields and existing user content. |
| A04 | History | List, pagination, search, refresh, and large histories work. A temporarily unavailable source does not erase the last usable index. |
| A05 | Native transfer | All eight directions in the matrix meet every native-transfer requirement above. |
| A06 | Loss handling | Redactions and unsupported attachments or metadata are shown before confirmation; missing essential message history blocks import. |
| A07 | Atomicity | Repeated requests are idempotent, failure leaves no visible partial conversation, source data is unchanged, and old tool calls are not replayed. |
| A08 | Continued context | The resumed agent recalls a random marker and a project decision present only in imported history. |
| A09 | Send and stop | Desktop and Web can send to a new or existing idle Antigravity conversation and stop the exact active turn; final state agrees with the native client. |
| A10 | Approval | Approve and deny take effect. Stale, duplicate, cross-session, and cross-turn decisions are rejected. Disconnect never implies approval. |
| A11 | Reconnect and ownership | Reconnect does not resend an uncertain prompt. A conversation controlled by another client cannot receive a concurrent turn from AgentKib. |
| A12 | Quota and usage | Values match the native source, unavailable data is not rendered as zero, and reconnect or imported history does not double-count usage. |
| A13 | Compatibility | Every declared platform/version is tested. Unsupported versions fail closed for native writes and control. |
| A14 | Regression | Existing Codex and Claude Code history, continuation, control, asset, and tool-management tests remain green. |

## Canonical test fixture

Use a synthetic conversation containing at least three user/assistant turns, one successful and one failed tool call, one image, one document, a random marker, a project decision, and a tool with an observable side-effect sentinel. Add separate long-history, damaged-record, fork/subagent, and secret-redaction fixtures.

No private user transcript or credential may be committed as a fixture or included in logs and screenshots.

## Evidence required for sign-off

- Exact product, ACP server, OS, and architecture versions with download source and checksum.
- A result table for A01–A14 and each of the eight transfer directions.
- Redacted screenshots or recordings showing target-native list visibility, history rendering, restart recovery, and continued context.
- Evidence for successful stop, approve, deny, disconnect, reconnect, duplicate-import, and failure-cleanup cases.
- Commands and results for focused tests and the repository validation baseline.

The repository validation baseline is:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Blocking rule

If the stable Antigravity interfaces cannot create a target-native conversation from foreign history, or cannot provide correlated send/stop/approval outcomes, record the attempted official and version-pinned interfaces and mark the feature blocked. Do not replace the requirement with a handoff file, transcript prompt, SDK-only session, or mocked success.

## Implementation status · 2026-09-20

This implementation pins its automated contract tests to ACP v1 and the Google-distributed `antigravity-acp` 1.1.1 manifest. The inspected stable CLI was 1.2.7. Read-only history negotiates capabilities at runtime and refuses unknown protocol versions or missing `session/list`, `session/load`, and `session/resume` support. Mutating control additionally requires the exact `antigravity-acp` / `agy_acp_server_1.1.1` server identity; unknown builds remain read-only.

| Area | Current evidence | Status |
| --- | --- | --- |
| Assets and context | Unit tests cover global/project Instructions, `.agents/rules` plus legacy `.agent/rules`, validated workspace/global/CLI-staged plugin rules, CLI enable/disable precedence, fail-closed malformed state and `rules.json`, conditional activation warnings, Skills, settings, MCP `serverUrl`, unknown-field preservation, discovery, and doctor behavior. | Automated pass |
| ACP history | Fake stdio integration covers capability negotiation, opaque IDs, paged list, unavailable workspaces, workspace filtering, replay, text/image/audio/resource blocks, incremental tool updates, redaction, metadata updates, loss reporting, and failure limits. | Automated pass |
| ACP control | Fake stdio integration covers send, exact-turn stop, native permission options, stale revisions, cancellation acknowledgement, disconnect, bounded state, and outcome-unknown reconnect fencing. Desktop/Web host tests cover permission and outcome fences. | Automated pass |
| Antigravity → Codex/Claude | ACP replay normalizes to `SessionDocument` and enters the existing reviewed native target importer. | Automated path pass; real product evidence pending |
| Codex/Claude → Antigravity | ACP `session/new` has no foreign-history import field, and the inspected CLI exposes no stable arbitrary transcript importer. | **Blocked: `native-history-import-unsupported`** |
| Existing Desktop/IDE and CLI conversations | The official ACP server has a separate conversation source; no published stable API has been verified to enumerate and control every existing Desktop/IDE and CLI conversation. | **Blocked for complete-surface claim** |
| Quota and usage | No verified Antigravity usage provider was added; the UI does not synthesize zero values. | Not implemented; A12 pending |
| Real installation acceptance | This development host had no logged-in current Antigravity installation. Tests use protocol fixtures and downloaded-binary handshake evidence only. | A01, A05, A08–A13 require target-host evidence |

The feature cannot receive complete-support sign-off while either blocked row remains. The ACP subset is reviewable and fail-closed, but it is not evidence that the eight-direction native-transfer matrix passes.
