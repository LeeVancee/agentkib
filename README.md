<p align="center">
  <img src="apps/desktop/resources/assets/app-icon-white.png" width="112" alt="AgentKib" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>A local control plane for coding agent assets, context, and session continuity.</strong></p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml"><img alt="Windows" src="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml"><img alt="Linux" src="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml/badge.svg" /></a>
  <img alt="Development preview" src="https://img.shields.io/badge/status-development_preview-f59e0b" />
  <img alt="Local first" src="https://img.shields.io/badge/data-local_first-16a34a" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827" /></a>
</p>

> [!WARNING]
> AgentKib is a development preview. Local data formats and some features may still change. Current macOS releases are signed and notarized by Apple; Windows installers are not yet Authenticode-signed.

![AgentKib home](docs/assets/agentkib-home.png)

## Why AgentKib

Coding agents accumulate valuable local state across project instructions, Skills, MCP connections, native configuration, and conversation history. That state is often fragmented between agent-specific files and homes, making it difficult to know what an agent can actually see or to continue work safely in another tool.

AgentKib gives that local state one inspectable surface. Core discovery, diagnostics, and synchronization do not require an AgentKib account, cloud database, or model API. **KIB** stands for **Knowledge & Instruction Base**.

## Three core workflows

### Start with today's actions

The home screen turns local findings into a short, prioritized list: missing shared instructions, unavailable MCP connections, pending asset changes, or context that needs review. AgentKib shows evidence and asks for confirmation before changing files.

### Build trustworthy workspace context

See the Instructions, Skills, MCP connections, and native configuration available to each agent in a directory. Diagnose missing, drifted, invalid, or duplicated assets, then review a complete ChangeSet and diff before anything is written.

### Continue across agents

Browse supported local session history and prepare a reviewed handoff between agents. AgentKib shows what can be carried over, redacts common sensitive values, and requires confirmation before writing or importing handoff artifacts.

## Download

Download the package for your platform from the [Latest Release](https://github.com/starroyhq/agentkib/releases/latest):

- macOS: `.dmg` for Apple Silicon or Intel
- Windows 11: x64 `.exe`; ARM64 remains Preview
- Linux: Ubuntu `.deb` or AppImage, or Fedora `.rpm`; ARM64 remains Preview

Only use files from the official release and verify the matching `.sha256` checksum. See [Upgrading](docs/UPGRADING.md) for in-app update support, package-manager-specific upgrades, and historical macOS packages.

## Product map

### Across your machine

| Area | What it provides |
| --- | --- |
| Today | Prioritized local actions and recent workspace activity |
| Workspaces | Discovered and manually added projects, with coverage and warnings |
| Asset catalog | A machine-wide view of Instructions, Skills, MCP, memory, and other agent assets |
| Agents | Installation state, configuration homes, capabilities, and discovered assets |
| Quota | Locally available quota windows, balances, and reset times |
| Insights | Token, session, Git activity, heatmaps, and achievements derived locally |

### Inside a workspace

| Area | What it provides |
| --- | --- |
| Overview | Agent coverage, shared asset state, and workspace signals |
| Continue work | Local session browsing and reviewed cross-agent handoff |
| Assets | Project-scoped Instructions, Skills, MCP, memory, and native configuration |
| Git | Read-only repository status and activity |
| Context | Effective load order, scope, overrides, and conflicts for a selected agent and directory |
| Doctor | Actionable diagnostics across supported agents |
| Changes | Pending and historical ChangeSets with complete diffs |

Generated changes follow a review-first flow:

```text
Discover local workspaces and agent state
                  ↓
Preview effective context and diagnostics
                  ↓
Generate a ChangeSet and complete diff
                  ↓
Write only after explicit approval
```

Browsing, previewing, and diagnostics do not create a manifest or modify agent configuration. A workspace needs no pre-existing `.agentkib/manifest.yaml`; AgentKib adds one to the reviewed ChangeSet only when shared assets are first saved.

## Supported agents

| Agent | Discovery and inventory | Context diagnostics and sync | Session browsing and handoff |
| --- | --- | --- | --- |
| Codex | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes |
| Cursor | Yes | Yes | — |
| OpenCode | Yes | Yes | — |
| OpenClaw | Yes | Yes | — |
| Hermes | Yes | Yes | — |
| Grok Build | Yes | Yes | — |
| DeepSeek Harness | Beta, read-only | Diagnostics only | — |

AgentKib distinguishes an installed app or CLI from local data left behind after uninstalling it. Agent Home writes require separate approval. DeepSeek Harness remains a read-only Beta target and is never written to or configured for MCP.

The interface supports Simplified Chinese, Traditional Chinese, Japanese, and English, with light, dark, and system themes.

## Local and private by default

- No login or AgentKib cloud sync is required. Ordinary discovery, diagnostics, and handoffs do not invoke a model or upload project assets.
- Discovery stores aggregate metadata such as paths, sources, counts, and timestamps—not prompts, message bodies, conversation titles, or raw session IDs.
- Handoff creation reads supported local sessions only when requested and redacts common sensitive values. Transcript bodies are not stored in SQLite, logs, or audit details.
- Fallback handoff files are written to `.agentkib/handoffs/` and ignored by Git by default; always review the diff before applying it.
- Generated writes check path boundaries and original hashes, create backups, and validate the result. Agent Home changes use a separate high-risk confirmation flow.

Credentials, cookies, tokens, environment files, private keys, and message databases are not cataloged as assets or written to logs. Optional Obsidian and OpenClaw/Hermes Remote Gateway integrations must be configured explicitly and retain their own permission boundaries.

## Platform status

| Platform | Status |
| --- | --- |
| macOS 13.3+ (Apple Silicon / Intel) | Primary development and acceptance platform |
| Windows 11 x64 | Platform code checked on pull requests; release workflow builds and smoke-tests NSIS |
| Ubuntu 22.04 x64 | Core CI platform; release workflow builds and verifies `.deb` and AppImage |
| Fedora x64 | Platform code checked on pull requests; release workflow builds and verifies `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview packages with limited native regression coverage |

Windows installers are currently unsigned and may trigger SmartScreen. Platform setup and known limitations are documented in the [Windows guide](docs/WINDOWS.md) and [Beta acceptance guide](docs/BETA.md).

## Documentation and community

- [Development guide](docs/DEVELOPMENT.md)
- [Upgrade guide](docs/UPGRADING.md)
- [Release process](docs/RELEASE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [GitHub Issues](https://github.com/starroyhq/agentkib/issues)

Security vulnerabilities must be reported privately according to the [security policy](SECURITY.md), not through a public issue. AgentKib is released under the [MIT License](LICENSE).
