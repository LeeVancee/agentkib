<p align="center">
  <img src="apps/desktop/resources/assets/app-icon-white.png" width="104" alt="AgentKib" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>检查、组织并安全维护 Coding Agent 的上下文、Skills、会话与本地工具链。</strong></p>

<p align="center">
  <a href="https://agentkib.com">官网</a> ·
  <a href="https://github.com/starroyhq/agentkib/releases/latest">下载</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/starroyhq/agentkib/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/starroyhq/agentkib?label=release" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="本地优先" src="https://img.shields.io/badge/data-local_first-16a34a" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827" /></a>
</p>

[![AgentKib 首页，展示今日任务和最近工作区](docs/assets/agentkib-home.png)](docs/assets/agentkib-home.png)

## 为什么需要 AgentKib

Coding Agent 会在项目指令、Skills、MCP 连接、原生配置和会话历史中积累有价值的本地状态。这些状态分散在不同工具中，因此很难确认某个 Agent 实际能看到什么、复用可信资产，或者安全地换一个工具继续工作。

AgentKib 把这些状态汇集到一个本地、可检查的桌面界面中。基础发现、诊断、Skill 管理和会话交接不需要 AgentKib 账号、云端数据库或模型 API。**KIB** 代表 **Knowledge & Instruction Base（知识与指令底座）**。

## AgentKib 能做什么

### 检查实际生效的上下文

查看每个 Agent 在工作区内可用的 Instructions、Skills、MCP 连接、记忆和原生配置。诊断缺失、漂移、无效或重复的资产，并在任何写入发生前审查完整 ChangeSet 和 Diff。

### 管理可复用的 Skills

浏览经过审查的 OpenAI Skills，或在添加到本地资源库前检查公开 GitHub 仓库。AgentKib 将受管包固定到不可变 Commit，预览文件和可执行资源，检测更新与本地漂移，并支持回滚和可恢复移除。资源库中的 Skill 不会自动启用到任何 Agent。

[![AgentKib Skill Hub，展示精选 Skills 和可审查的来源信息](docs/assets/agentkib-skill-hub.png)](docs/assets/agentkib-skill-hub.png)

### 跨 Agent 继续工作

浏览受支持的 Codex 与 Claude Code 本地会话，并准备经过审查的交接。AgentKib 会保留有用的时间线上下文、遮盖常见敏感值，并在写入或导入交接产物前请求确认。

### 维护本地工具链

检查 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 Grok Build 的安装。AgentKib 会显示每处安装的版本、来源、可执行路径、PATH 默认项和冲突。经过验证的包管理器或官方更新器操作可使用固定参数执行；来源不明、需要提权或远程脚本的流程只提供官方命令或文档。

[![AgentKib 工具与更新，展示版本、安装来源和诊断](docs/assets/agentkib-tools-updates.png)](docs/assets/agentkib-tools-updates.png)

## 下载

从 [Latest Release](https://github.com/starroyhq/agentkib/releases/latest) 下载当前稳定版本：

- macOS 13.3+：Apple Silicon 或 Intel 的 `.dmg`
- Windows 11：x64 `.exe`；ARM64 仍为 Preview
- Linux：Ubuntu `.deb` 或 AppImage、Fedora `.rpm`；ARM64 仍为 Preview

请只使用官方 Release 中的文件，并核对对应的 `.sha256` 校验值。Windows 安装包尚未进行 Authenticode 签名，可能触发 SmartScreen。应用内更新、不同安装包的升级方式和历史 macOS 包说明见[升级指南](docs/UPGRADING.md)。

## 本地优先的安全边界

- 普通发现和诊断不会调用模型，也不会上传项目资产。
- 凭据、Cookie、Token、私钥、环境文件和消息数据库不会被收录为资产或写入日志。
- 生成的写入会检查路径边界和原始哈希、创建备份，并在应用前要求审查。
- Agent Home 变更使用单独的高风险确认流程；远程集成保留各自的权限边界。

## 支持概览

- **发现与上下文：** Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes、Grok Build，以及只读的 DeepSeek Harness 诊断。
- **会话浏览与交接：** Codex 和 Claude Code。
- **工具管理：** Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 Grok Build；明确不包含 DeepSeek Harness。
- **界面：** English、简体中文、繁體中文和日本語；支持浅色、深色与跟随系统主题。
- **平台：** macOS 13.3+、Windows 11、Ubuntu 22.04 和 Fedora；Windows 与 Linux ARM64 安装包仍为 Preview。

完整的全局视图、工作区能力、Agent 支持和平台状态见[功能与兼容矩阵](docs/FEATURES.md)。

## 文档与社区

- [功能矩阵](docs/FEATURES.md)
- [开发文档](docs/DEVELOPMENT.md)
- [升级指南](docs/UPGRADING.md)
- [发布流程](docs/RELEASE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)
- [GitHub Issues](https://github.com/starroyhq/agentkib/issues)

安全漏洞必须按照[安全策略](SECURITY.md)私密报告，不要创建公开 Issue。AgentKib 使用 [MIT License](LICENSE) 发布。
