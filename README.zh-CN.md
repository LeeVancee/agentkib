<p align="center">
  <img src="apps/desktop/resources/assets/app-icon-white.png" width="112" alt="AgentKib" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>管理 Coding Agent 资产、上下文与会话连续性的本地控制台。</strong></p>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml"><img alt="Windows" src="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml"><img alt="Linux" src="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml/badge.svg" /></a>
  <img alt="开发预览" src="https://img.shields.io/badge/status-development_preview-f59e0b" />
  <img alt="本地优先" src="https://img.shields.io/badge/data-local_first-16a34a" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827" /></a>
</p>

> [!WARNING]
> AgentKib 仍处于开发预览阶段，本地数据格式和部分功能可能继续调整。当前 macOS 版本已签名并通过 Apple 公证；Windows 安装包尚未进行 Authenticode 签名。

![AgentKib 首页](docs/assets/agentkib-home.png)

## 为什么需要 AgentKib

Coding Agent 会在项目指令、Skills、MCP 连接、原生配置和会话历史中积累有价值的本地状态。这些状态通常分散在不同 Agent 的文件和 Home 目录里，因此很难确认某个 Agent 实际能看到什么，也很难安全地换一个工具继续工作。

AgentKib 把这些本地状态汇集到一个可检查的界面中。基础发现、诊断和同步不需要 AgentKib 账号、云端数据库或模型 API。**KIB** 代表 **Knowledge & Instruction Base（知识与指令底座）**。

## 三条核心工作流

### 从今日任务开始

首页会把本机发现转成简短、排好优先级的行动列表，例如公共指令缺失、MCP 连接不可用、资产变更待确认或上下文需要复核。AgentKib 会展示证据，并在修改文件前请求确认。

### 建立可信的工作区上下文

查看每个 Agent 在指定目录实际可用的 Instructions、Skills、MCP 连接和原生配置。诊断缺失、漂移、无效或重复的资产，并在任何写入发生前审查完整 ChangeSet 和 Diff。

### 跨 Agent 继续工作

浏览受支持的本地会话历史，在 Agent 之间准备经过审查的交接。AgentKib 会展示可延续的内容、遮盖常见敏感值，并在写入或导入交接产物前请求确认。

## 下载

从 [Latest Release](https://github.com/starroyhq/agentkib/releases/latest) 下载当前平台的安装包：

- macOS：Apple Silicon 或 Intel 的 `.dmg`
- Windows 11：x64 `.exe`；ARM64 仍为 Preview
- Linux：Ubuntu `.deb` 或 AppImage、Fedora `.rpm`；ARM64 仍为 Preview

请只使用官方 Release 中的文件，并核对对应的 `.sha256` 校验值。应用内更新、不同包管理方式以及历史 macOS 包的说明见[升级指南](docs/UPGRADING.md)。

## 能力地图

### 全局视图

| 区域 | 提供的能力 |
| --- | --- |
| 今日任务 | 排好优先级的本地行动项和近期工作区活动 |
| 工作区 | 自动发现或手动添加的项目，以及覆盖情况和警告 |
| 全局资产目录 | 跨工作区查看 Instructions、Skills、MCP、记忆和其他 Agent 资产；Skills 区域还可管理本地资源库，并发现精选或公开 GitHub 包，但不会自动启用到任何 Agent |
| Agent | 安装状态、配置 Home、能力和已发现资产 |
| 额度 | 本机可读取的额度窗口、余额和重置时间 |
| 洞察 | 本地派生的 Token、会话、Git 活动、热力图和成就 |

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

## 支持的 Agent

| Agent | 发现与盘点 | 上下文诊断与同步 | 会话浏览与交接 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 支持 |
| Cursor | 支持 | 支持 | — |
| OpenCode | 支持 | 支持 | — |
| OpenClaw | 支持 | 支持 | — |
| Hermes | 支持 | 支持 | — |
| Grok Build | 支持 | 支持 | — |
| DeepSeek Harness | Beta，只读 | 仅诊断 | — |

AgentKib 会区分“已安装”和“卸载后仍留有本地数据”。涉及 Agent Home 的写入会单独请求授权。DeepSeek Harness 仍是只读 Beta 目标，不会被写入或配置 MCP。

界面支持简体中文、繁體中文、日本語和 English，并提供浅色、深色与跟随系统主题。

## 本地与隐私边界

- 不需要登录，也不提供 AgentKib 云同步；普通发现、诊断和交接不会调用模型或上传项目资产。
- 自动发现只保存路径、来源、数量和时间等聚合元数据，不保存 Prompt、消息正文、对话标题或原始 Session ID。
- 创建交接时只在用户请求后读取受支持的本地会话，并遮盖常见敏感值；正文不会写入 SQLite、日志或审计详情。
- 回退交接文件保存在 `.agentkib/handoffs/`，该目录默认加入 `.gitignore`；应用前仍应检查 Diff。
- 生成的写入会检查路径边界和原始哈希、创建备份并验证结果。Agent Home 变更使用单独的高风险确认流程。

凭据、Cookie、Token、环境文件、私钥和消息数据库不会被收录为资产或写入日志。可选的 Obsidian、OpenClaw Remote Gateway 和 Hermes Remote Gateway 集成都需主动配置，并保持各自的权限边界。

## 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台 |
| Windows 11 x64 | PR 验证平台代码；发布工作流构建并烟测 NSIS |
| Ubuntu 22.04 x64 | 核心 CI 平台；发布工作流构建并验证 `.deb` 与 AppImage |
| Fedora x64 | PR 验证平台代码；发布工作流构建并验证 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview 包，原生回归覆盖有限 |

Windows 安装包目前未签名，可能触发 SmartScreen。平台配置与已知限制见 [Windows 指南](docs/WINDOWS.md)和 [Beta 验收指南](docs/BETA.md)。

## 文档与社区

- [开发文档](docs/DEVELOPMENT.md)
- [升级指南](docs/UPGRADING.md)
- [发布流程](docs/RELEASE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)
- [GitHub Issues](https://github.com/starroyhq/agentkib/issues)

安全漏洞必须按照[安全策略](SECURITY.md)私密报告，不要创建公开 Issue。AgentKib 使用 [MIT License](LICENSE) 发布。
