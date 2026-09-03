# Continuation Capability Matrix

This document records verified continuation capabilities by source agent, target agent, platform, version, and environment.

Use only these states:

- `supported`
- `unavailable`
- `unsupported`
- `unverified`

Do not mark a capability as `supported` without a corresponding entry in [continuation-validation.md](./continuation-validation.md).

## Capability columns

| Source | Target | Platform / architecture | Agent version | `source_read` | `source_parse` | `native_resume` | `file_handoff` | `windowed_context` | `mcp_setup` | `interactive_launch` | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Codex | Maintainer environment | Record required | unverified | unverified | unverified | unverified | unverified | unverified | unverified | [Phase 1 guide](./phase1-maintainer-validation.md) |
| Codex | Claude Code | Maintainer environment | Record required | unverified | unverified | unverified | unverified | unverified | unverified | unverified | [Phase 1 guide](./phase1-maintainer-validation.md) |
| Claude Code | Codex | Maintainer environment | Record required | unverified | unverified | unverified | unverified | unverified | unverified | unverified | [Phase 1 guide](./phase1-maintainer-validation.md) |
| Claude Code | Claude Code | Maintainer environment | Record required | unverified | unverified | unverified | unverified | unverified | unverified | unverified | [Phase 1 guide](./phase1-maintainer-validation.md) |

## Recognized agents

The current AgentKib model recognizes Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, Grok Build, and DeepSeek Harness. Recognition does not imply continuation support; each capability requires its own evidence.
