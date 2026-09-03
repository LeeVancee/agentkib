# Phase 1 Maintainer Validation

This guide is for the maintainer who can run AgentKib with a real Claude Code CLI. It validates the four Codex ↔ Claude Code continuation paths after Phase 0. Do not mark a path as supported until its real-machine evidence is recorded in `continuation-validation.md`.

## Scope

| Source | Target | Expected mode |
| --- | --- | --- |
| Codex | Codex | Native continuation |
| Codex | Claude Code | Native continuation, or the best validated fallback |
| Claude Code | Codex | Native continuation, or the best validated fallback |
| Claude Code | Claude Code | Native continuation |

The application must distinguish these outcomes:

- Not applied: preview or approval failed, and no continuation artifact was written.
- Applied but launch failed: the reviewed files were written, but the target CLI did not start. The user can retry without writing the same artifact again.
- Launched successfully: the target agent actually opened the expected context. Spawning a process alone is not sufficient evidence.

## Environment

Use an isolated development profile and a synthetic workspace. Do not use real credentials, private conversations, or a personal repository.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Record the following before testing:

- AgentKib commit and build mode
- Operating system and architecture
- `codex --version`
- `claude --version`
- Whether each CLI is installed, runnable, and capable of the selected continuation mode
- Whether the AgentKib MCP Hub is running

Use an isolated Codex home and Claude home where the local environment supports it. If the CLI cannot safely be isolated, record that limitation instead of using an account with real private data.

## Local automated fixture

The repository contains a synthetic, credential-free fixture covering the four source/target paths and the core safety/window behaviors:

```bash
cargo test -p agentkib-conversations --test phase1_continuation
```

The fixture currently verifies native round-trip semantics for Codex → Codex and Claude Code → Claude Code, JSON handoff preservation for Codex → Claude Code and Claude Code → Codex, re-sanitization after edits, preview invalidation through source fingerprints, and bounded windows for long sessions. It does not replace maintainer-run CLI verification.

## Synthetic fixture

The source session should contain all of the following, with visibly synthetic values:

- A user message and an assistant response
- A tool call and a successful tool result
- A failed tool result
- An inline image or document attachment
- A token-like value, an environment variable, a username, and an absolute path
- A follow-up change made after the first preview

The expected result must show the loss categories and redaction count before confirmation. External attachments and excluded private state must be reported as losses or excluded; they must not be silently copied.

## Required scenarios for each path

Run the following scenarios for every source/target pair above:

1. Short session: preview, approve, launch, and confirm the target opened the expected context.
2. Long session: exceed the target history budget and confirm the active window, archive notice, MCP availability, and loss report.
3. Changed source: change the original session after preview and confirm approval is rejected rather than applying a stale plan.
4. Launch failure: make the write succeed while the target CLI is unavailable or deliberately fails to launch. Confirm the UI says `applied but launch failed`, shows the artifact, and retries without duplicate files.
5. Missing target: repeat with the target CLI not installed or not runnable. Confirm the capability is shown as unavailable and the failure is not presented as success.
6. Version limitation: use a target CLI version that lacks the required capability and record the resulting unavailable state.
7. MCP absent: run the long-session case without the AgentKib continuation gateway and confirm windowed continuation is blocked with an actionable error.
8. MCP configured: run with the gateway configured and confirm only AgentKib's endpoint is added or updated.
9. MCP collision: configure an unrelated server with the same visible name and confirm the app refuses an ambiguous merge without deleting the unrelated entry.
10. Existing managed MCP: configure another AgentKib-managed server and confirm it remains unchanged.

## Evidence record

For each path, attach a sanitized record containing:

```text
Date:
Source agent and version:
Target agent and version:
Platform / architecture:
AgentKib commit:
Mode:
Scenario:
Fixture:
Outcome: not applied | applied but launch failed | launched successfully
Losses: category and count
Redactions: count
Files changed: relative paths only
MCP state:
Evidence: screenshots, sanitized logs, or observable target-session result
Fallback:
```

The evidence must prove that the target agent opened the intended context. Never include full transcripts, credentials, private paths, or shell initialization content in the repository record.

## Sign-off

The maintainer should report one result per path and scenario. Update `docs/sessions/capability-matrix.md` only after the corresponding validation record exists:

- `supported`: the required behavior was observed on the recorded platform and version.
- `unavailable`: the behavior exists but a local prerequisite was missing or blocked.
- `unsupported`: the target agent does not provide the behavior.
- `unverified`: no sufficient evidence yet.

Phase 1 is complete only when all four paths have automation-fixture evidence and real-machine records, failures are never displayed as success, launch retries are idempotent, and the pre-confirmation loss/redaction/file-change review is observable.
