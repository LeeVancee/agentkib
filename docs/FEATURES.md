# Features and compatibility / 功能与兼容矩阵

This document describes AgentKib's current product surfaces and support boundaries. For installation and the product overview, see the [README](../README.md).

本文档描述 AgentKib 当前的产品界面与支持边界。安装方式和产品简介见[中文 README](../README.zh-CN.md)。

## English

### Across your machine

| Area | What it provides |
| --- | --- |
| Today | Prioritized local actions and recent workspace activity |
| Workspaces | Discovered and manually added projects, with coverage and warnings |
| Asset catalog | A machine-wide view of Instructions, Skills, MCP, memory, and other agent assets |
| Skill Hub | A local Skill library, reviewed OpenAI catalog, public GitHub import, updates, rollback, and recoverable removal |
| Agents | Installation state, configuration homes, capabilities, and discovered assets |
| Quota | Locally available quota windows, balances, and reset times |
| Insights | Token, session, Git activity, heatmaps, and achievements derived locally |
| Settings | Discovery roots, tool updates, integrations, privacy controls, and diagnostics |

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

### Skill Hub

- A Skill is represented as one directory-level package rooted at `SKILL.md`; supporting files remain inside that package.
- The library lives under the AgentKib Home and does not automatically distribute or enable Skills in an Agent Home or workspace.
- Discovery supports the reviewed OpenAI catalog and public GitHub repository, tree, or `SKILL.md` URLs.
- Installation previews an immutable commit, package metadata, file list, executable resources, compatibility, license, and content changes without running package code.
- Managed Skills support update checks, local-drift warnings, one-version rollback, recoverable removal, and restore. Unmanaged local packages remain inspectable but cannot be updated online.

### Tools and updates

- Managed tools: Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, and Grok Build. DeepSeek Harness is not exposed because it has no supported stable tool-management channel.
- Each installation reports its executable and resolved paths, version, runnable state, installation source, runtime environment, matching manager, and whether it is the PATH default.
- Version comparison follows the detected installation channel instead of treating a GitHub or npm release as universal.
- Automatic actions are bound to the detected installation and a pinned target version. Supported actions use verified npm, pnpm, bun, Homebrew, Volta, or an official updater without invoking a shell or requesting elevation.
- Multiple physical installations, unverified sources, unavailable managers, privileged operations, remote scripts, and unsupported channels block automatic execution and fall back to an official command or documentation.
- An operation succeeds only after the target installation is re-detected, runnable, and verified at the expected version.

### Agent support

| Agent | Discovery and inventory | Context diagnostics and sync | Session browsing and handoff | Tool management |
| --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes | Yes |
| Cursor | Yes | Yes | — | Yes |
| OpenCode | Yes | Yes | — | Yes |
| OpenClaw | Yes | Yes | — | Yes |
| Hermes | Yes | Yes | — | Yes |
| Grok Build | Yes | Yes | — | Yes |
| DeepSeek Harness | Beta, read-only | Diagnostics only | — | — |

AgentKib distinguishes an installed app or CLI from local data left behind after uninstalling it. Agent Home writes require separate approval. DeepSeek Harness remains a read-only Beta target and is never written to, configured for MCP, or included in tool management.

### Platform status

| Platform | Status |
| --- | --- |
| macOS 13.3+ (Apple Silicon / Intel) | Primary development and acceptance platform; releases are signed and notarized |
| Windows 11 x64 | Release workflow builds and smoke-tests NSIS; installers are not yet Authenticode-signed |
| Ubuntu 22.04 x64 | Core CI platform; releases include verified `.deb` and AppImage packages |
| Fedora x64 | Platform checks run on pull requests; releases include verified `.rpm` packages |
| Windows ARM64 / Linux ARM64 | Preview packages with limited native regression coverage |

Platform setup and known limitations are documented in the [Windows guide](WINDOWS.md), [upgrade guide](UPGRADING.md), and [release guide](RELEASE.md).

## 简体中文

### 全局视图

| 区域 | 提供的能力 |
| --- | --- |
| 今日任务 | 排好优先级的本地行动项和近期工作区活动 |
| 工作区 | 自动发现或手动添加的项目，以及覆盖情况和警告 |
| 全局资产目录 | 跨工作区查看 Instructions、Skills、MCP、记忆和其他 Agent 资产 |
| Skill Hub | 本地 Skill 资源库、OpenAI 精选目录、公开 GitHub 导入、更新、回滚和可恢复移除 |
| Agent | 安装状态、配置 Home、能力和已发现资产 |
| 额度 | 本机可读取的额度窗口、余额和重置时间 |
| 洞察 | 本地派生的 Token、会话、Git 活动、热力图和成就 |
| 设置 | 发现目录、工具更新、集成、隐私控制和诊断 |

### 工作区内

| 区域 | 提供的能力 |
| --- | --- |
| 概览 | Agent 覆盖、共享资产状态和工作区信号 |
| 继续工作 | 本地会话浏览和经过审查的跨 Agent 交接 |
| 资产 | 工作区范围的 Instructions、Skills、MCP、记忆和原生配置 |
| Git | 只读的仓库状态和活动 |
| 上下文 | 指定 Agent 与目录的有效加载顺序、作用域、覆盖和冲突 |
| 诊断 | 跨受支持 Agent 的可执行诊断 |
| 变更 | 待处理和历史 ChangeSet，以及完整 Diff |

生成的变更遵循先审查、后写入的流程：

```text
发现本机工作区与 Agent 状态
              ↓
预览有效上下文并进行诊断
              ↓
生成 ChangeSet 和完整 Diff
              ↓
只有明确确认后才写入
```

浏览、预览和诊断不会创建 manifest，也不会修改 Agent 配置。工作区不需要预先存在 `.agentkib/manifest.yaml`；只有首次保存共享资产时，AgentKib 才会把它加入待审查的 ChangeSet。

### Skill Hub

- 一个 Skill 以 `SKILL.md` 所在目录作为包级入口，支持文件保留在包内，不会成为重复的顶层资产。
- 资源库位于 AgentKib Home，不会自动向 Agent Home 或工作区分发或启用 Skill。
- 发现支持 OpenAI 精选目录，以及公开 GitHub 仓库、Tree 目录或 `SKILL.md` URL。
- 安装前会预览固定到不可变 Commit 的包元数据、文件列表、可执行资源、兼容性、许可证和内容变化，不执行包内代码。
- 受管 Skill 支持更新检查、本地漂移提醒、上一版本回滚、可恢复移除与恢复；本地未托管包可以检查，但不能在线更新。

### 工具与更新

- 管理 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 Grok Build。DeepSeek Harness 没有受支持的稳定工具管理渠道，因此不在此处展示。
- 每处安装展示可执行路径与解析后路径、版本、可运行状态、安装来源、运行环境、对应管理器和 PATH 默认项。
- 版本比较遵循检测到的安装渠道，不会把 GitHub 或 npm 的版本通用于所有安装。
- 自动操作绑定实际安装与固定目标版本，通过已验证的 npm、pnpm、bun、Homebrew、Volta 或官方更新器执行，不经过 Shell，也不请求提权。
- 多个物理安装、来源不明、管理器不可用、需要提权、远程脚本或不支持的渠道会阻止自动执行，改为提供官方命令或文档。
- 命令退出后只有重新检测到目标安装可运行且达到预期版本，才会报告成功。

### Agent 支持

| Agent | 发现与盘点 | 上下文诊断与同步 | 会话浏览与交接 | 工具管理 |
| --- | --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 支持 | 支持 |
| Cursor | 支持 | 支持 | — | 支持 |
| OpenCode | 支持 | 支持 | — | 支持 |
| OpenClaw | 支持 | 支持 | — | 支持 |
| Hermes | 支持 | 支持 | — | 支持 |
| Grok Build | 支持 | 支持 | — | 支持 |
| DeepSeek Harness | Beta，只读 | 仅诊断 | — | — |

AgentKib 会区分“已安装”和“卸载后仍留有本地数据”。涉及 Agent Home 的写入会单独请求授权。DeepSeek Harness 仍是只读 Beta 目标，不会被写入、配置 MCP 或纳入工具管理。

### 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台；发布包已签名并通过 Apple 公证 |
| Windows 11 x64 | 发布工作流构建并烟测 NSIS；安装包尚未进行 Authenticode 签名 |
| Ubuntu 22.04 x64 | 核心 CI 平台；发布包包含经过验证的 `.deb` 与 AppImage |
| Fedora x64 | PR 运行平台检查；发布包包含经过验证的 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview 包，原生回归覆盖有限 |

平台配置和已知限制见 [Windows 指南](WINDOWS.md)、[升级指南](UPGRADING.md)和[发布指南](RELEASE.md)。
