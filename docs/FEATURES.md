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

### Session history

- The default directory shows interactive conversations and user-created forks. Recognized auxiliary/subagent records are retained but hidden until **Show auxiliary sessions** is enabled; unknown sources remain visible. The source-visibility preference is shared by session browsing and search for the current app run.
- Forks keep their own identity and title, with a small fork indicator and source information. Spawned-parent and fork-source relationships are independent; identical titles are never merged. Successful source refreshes reconcile archived/deleted records, while unavailable or unsupported sources retain the last cached snapshot.
- History opens with the latest 50 records (messages and tool summaries), displayed chronologically. Load earlier records on demand.
- Codex and Claude Code JSONL histories are read from the tail with bounded scanning and memory, rather than loading the entire transcript before pagination. Antigravity ACP histories are replayed through the official ACP server with bounded pages and update budgets. OpenCode is read through its bounded export command; OpenClaw, Hermes, and Grok Build use their verified local history sources. Page byte limits may return fewer than 50 records; an empty scan window can still offer earlier records.
- Damaged or oversized log records produce a warning. Very distant message/tool associations or ambiguous legacy metadata may be shown conservatively with a warning instead of requiring a full-file scan.
- History pagination is read-only. Codex, Claude Code, Antigravity ACP, and OpenCode histories can be used as reviewed handoff sources. OpenClaw, Hermes, and Grok Build histories remain read-only and cannot be exported or continued from AgentKib.

### Skill Hub

- A Skill is represented as one directory-level package rooted at `SKILL.md`; supporting files remain inside that package.
- The library lives under the AgentKib Home and does not automatically distribute or enable Skills in an Agent Home or workspace.
- Discovery supports the reviewed OpenAI catalog and public GitHub repository, tree, or `SKILL.md` URLs.
- Installation previews an immutable commit, package metadata, file list, executable resources, compatibility, license, and content changes without running package code.
- Managed Skills support update checks, local-drift warnings, one-version rollback, recoverable removal, and restore. Unmanaged local packages remain inspectable but cannot be updated online.

### Tools and updates

- Managed tools: Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, and Grok Build. Antigravity CLI is detected and links to official installation documentation; its remote-script installer is not executed automatically. DeepSeek Harness is not exposed because it has no supported stable tool-management channel.
- Each installation reports its executable and resolved paths, version, runnable state, installation source, runtime environment, matching manager, and whether it is the PATH default.
- Version comparison follows the detected installation channel instead of treating a GitHub or npm release as universal.
- Automatic actions are bound to the detected installation and a pinned target version. Supported executable actions use verified npm, pnpm, bun, or Volta arguments without invoking a shell or requesting elevation. Homebrew and official updater channels that cannot pin an exact target fall back to a command for the user to review and run.
- Multiple physical installations, unverified sources, unavailable managers, privileged operations, remote scripts, and unsupported channels block automatic execution and fall back to an official command or documentation.
- An operation succeeds only after the target installation is re-detected, runnable, and verified at the expected version.

### Agent support

| Agent | Discovery and inventory | Context diagnostics and sync | Session history | Handoff source | Tool management |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes | Yes | Yes |
| Antigravity | Yes | Yes | ACP sessions | ACP source only | Detect/docs |
| Cursor | Yes | Yes | — | — | Yes |
| OpenCode | Yes | Yes | Yes | Yes | Yes |
| OpenClaw | Yes | Yes | Read-only | — | Yes |
| Hermes | Yes | Yes | Read-only | — | Yes |
| Grok Build | Yes | Yes | Read-only | — | Yes |
| DeepSeek Harness | Beta, read-only | Diagnostics only | — | — | — |

AgentKib distinguishes an installed app or CLI from local data left behind after uninstalling it. Agent Home writes require separate approval. Antigravity ACP sessions are not claimed to be the complete Desktop/IDE or CLI history store, and current stable interfaces cannot import foreign history into an Antigravity-native session. DeepSeek Harness remains a read-only Beta target and is never written to, configured for MCP, or included in tool management.

### Web access and continuation

- Pairing grants read access first. Sending and approvals are separate per-browser permissions and also require the host control switch.
- On a verified macOS Claude Code installation, Web control starts an AgentKib-managed `claude --resume` process for the selected indexed session. It does not take over an existing terminal, and viewing history never starts a model.
- Codex Web control follows an already-open official owner session and remains gated to explicit acceptance builds. Unknown versions, unsupported platforms, missing owners, and unverified interaction shapes remain read-only.
- Antigravity Web control manages only sessions returned by the official ACP server. It negotiates ACP v1 capabilities, checks the indexed session and workspace again, and requires exact revision, turn, request, and offered permission option matches.
- A request receipt does not mean a turn or approval completed. Disconnects and uncertain outcomes are never retried automatically.

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

### 会话历史

- 默认目录显示用户对话和用户创建的分叉。明确的辅助/子代理记录保留在索引中，开启“显示辅助会话”后才显示；无法识别的来源仍保留显示。来源可见性在本次应用运行期间由会话浏览与搜索共享。
- 分叉保留独立身份和原标题，通过小型分叉标识及来源信息区分；子代理父关系与历史分叉关系独立，不按同名合并。成功刷新会同步归档、删除状态；来源不可用或结构不支持时保留上次缓存快照。
- 默认加载最新 50 条记录（消息和工具摘要），按时间正序展示；更早记录按需加载。
- Codex 与 Claude Code 的 JSONL 历史从文件尾部开始有界读取，不再先读取完整文件才分页。Antigravity ACP 历史通过官方 ACP server 有界回放。OpenCode 通过有界导出命令读取；OpenClaw、Hermes 和 Grok Build 使用各自经过校验的本机历史来源。单页体积限制可能使结果少于 50 条；本次扫描窗口为空时，仍可能继续加载更早记录。
- 损坏或超大的日志记录会显示提示；距离过远的消息/工具关联，以及无法明确判断的旧格式元数据，会保守展示并提示，而非要求扫描完整文件。
- 历史分页只读，不修改原记录。Codex、Claude Code、Antigravity ACP 与 OpenCode 历史可以作为经过审查的交接来源；OpenClaw、Hermes 和 Grok Build 历史保持只读，不能从 AgentKib 导出或续接。

### Skill Hub

- 一个 Skill 以 `SKILL.md` 所在目录作为包级入口，支持文件保留在包内，不会成为重复的顶层资产。
- 资源库位于 AgentKib Home，不会自动向 Agent Home 或工作区分发或启用 Skill。
- 发现支持 OpenAI 精选目录，以及公开 GitHub 仓库、Tree 目录或 `SKILL.md` URL。
- 安装前会预览固定到不可变 Commit 的包元数据、文件列表、可执行资源、兼容性、许可证和内容变化，不执行包内代码。
- 受管 Skill 支持更新检查、本地漂移提醒、上一版本回滚、可恢复移除与恢复；本地未托管包可以检查，但不能在线更新。

### 工具与更新

- 管理 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 Grok Build。Antigravity CLI 支持检测并提供官方安装文档，但不会自动执行远程脚本安装器。DeepSeek Harness 没有受支持的稳定工具管理渠道，因此不在此处展示。
- 每处安装展示可执行路径与解析后路径、版本、可运行状态、安装来源、运行环境、对应管理器和 PATH 默认项。
- 版本比较遵循检测到的安装渠道，不会把 GitHub 或 npm 的版本通用于所有安装。
- 自动操作绑定实际安装与固定目标版本，通过经过验证的 npm、pnpm、bun 或 Volta 参数执行，不经过 Shell，也不请求提权。Homebrew 或官方更新器无法固定精确目标版本时，只提供供用户审查并自行运行的命令。
- 多个物理安装、来源不明、管理器不可用、需要提权、远程脚本或不支持的渠道会阻止自动执行，改为提供官方命令或文档。
- 命令退出后只有重新检测到目标安装可运行且达到预期版本，才会报告成功。

### Agent 支持

| Agent | 发现与盘点 | 上下文诊断与同步 | 会话历史 | 交接来源 | 工具管理 |
| --- | --- | --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 支持 | 支持 | 支持 |
| Antigravity | 支持 | 支持 | ACP 会话 | 仅作来源 | 检测/文档 |
| Cursor | 支持 | 支持 | — | — | 支持 |
| OpenCode | 支持 | 支持 | 支持 | 支持 | 支持 |
| OpenClaw | 支持 | 支持 | 只读 | — | 支持 |
| Hermes | 支持 | 支持 | 只读 | — | 支持 |
| Grok Build | 支持 | 支持 | 只读 | — | 支持 |
| DeepSeek Harness | Beta，只读 | 仅诊断 | — | — | — |

AgentKib 会区分“已安装”和“卸载后仍留有本地数据”。涉及 Agent Home 的写入会单独请求授权。Antigravity ACP 会话不代表完整的 Desktop/IDE 或 CLI 历史；当前稳定接口也不能把外部历史导入 Antigravity 原生会话。DeepSeek Harness 仍是只读 Beta 目标，不会被写入、配置 MCP 或纳入工具管理。

### Web 访问与续接

- 配对首先授予读取权限；发送和审批是单独的浏览器权限，同时还需要打开主机控制开关。
- 对经过验证的 macOS Claude Code 安装，Web 控制会为所选的已索引会话启动 AgentKib 托管的 `claude --resume` 进程。它不会接管已有终端，查看历史也不会启动模型。
- Codex Web 控制跟随官方客户端中已打开的 owner 会话，并继续只在明确的验收构建中开放。版本未知、平台不支持、没有 owner 或交互结构未经验证时保持只读。
- Antigravity Web 控制只管理官方 ACP server 返回的会话。运行时协商 ACP v1 能力，重新核验索引会话和工作区，并要求 revision、turn、request 与服务端提供的权限选项全部精确匹配。
- 请求回执不代表轮次或审批已经完成。断线或结果不明确时不会自动重试。

### 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台；发布包已签名并通过 Apple 公证 |
| Windows 11 x64 | 发布工作流构建并烟测 NSIS；安装包尚未进行 Authenticode 签名 |
| Ubuntu 22.04 x64 | 核心 CI 平台；发布包包含经过验证的 `.deb` 与 AppImage |
| Fedora x64 | PR 运行平台检查；发布包包含经过验证的 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview 包，原生回归覆盖有限 |

平台配置和已知限制见 [Windows 指南](WINDOWS.md)、[升级指南](UPGRADING.md)和[发布指南](RELEASE.md)。
