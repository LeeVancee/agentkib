# Contributing to AgentKib / 参与 AgentKib

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

## English

Thank you for helping improve AgentKib. Read the [development guide](docs/DEVELOPMENT.md) for prerequisites, architecture, isolated development data, commands, and packaging.

### Contribution workflow

1. Create a focused branch from the latest `main`.
2. Solve one concrete problem with the smallest necessary change. Avoid unrelated refactors, formatting, new dependencies, or public interface changes.
3. Follow the existing architecture, code style, error handling, and test patterns.
4. Use the repository's Conventional Commits style, such as `fix(scope): ...`, `feat(scope): ...`, or `docs(scope): ...`.
5. Run the smallest relevant checks from the [development guide](docs/DEVELOPMENT.md#validation-commands).

### Privacy and security

- Never include keys, tokens, cookies, complete transcripts, private project content, real local paths, or personal data in issues, pull requests, fixtures, logs, or screenshots.
- Sanitize UI screenshots and diagnostic output before attaching them.
- Do not weaken path, permission, backup, hash, redaction, or confirmation safeguards to make a change pass.
- Do not open a public issue for a vulnerability. Follow the [security policy](SECURITY.md) and use GitHub Private Vulnerability Reporting.

### Pull requests

- Explain the problem, solution, and user-visible impact. Link an issue when one exists.
- List exact validation commands and results. If a check could not run, explain why and identify the remaining risk.
- Include screenshots for UI changes and cover relevant loading, empty, error, and success states.
- Describe affected operating systems and architectures for platform changes.
- Call out compatibility, data, release, security, and rollback considerations, even when no material risk is known.
- Keep one pull request focused on one topic and wait for CI before requesting review.

---

<a id="简体中文"></a>

## 简体中文

感谢你帮助改进 AgentKib。环境要求、架构、隔离开发数据、命令和打包说明统一收录在[开发文档](docs/DEVELOPMENT.md)中。

### 贡献流程

1. 从最新 `main` 创建聚焦的分支。
2. 围绕一个真实问题做最小必要改动，避免无关重构、格式化、新依赖或公共接口变更。
3. 遵循现有架构、代码风格、错误处理和测试方式。
4. 使用仓库现有 Conventional Commits 风格，例如 `fix(scope): ...`、`feat(scope): ...` 或 `docs(scope): ...`。
5. 运行[开发文档](docs/DEVELOPMENT.md#验证命令)中与改动范围最相关的检查。

### 隐私与安全

- 不要在 Issue、PR、测试数据、日志或截图中包含密钥、Token、Cookie、完整会话、私有项目内容、真实本机路径或个人数据。
- 上传 UI 截图或诊断输出前必须完成脱敏。
- 不得为了让变更通过而降低路径、权限、备份、哈希、脱敏或确认流程的保护强度。
- 安全漏洞不要创建公开 Issue；请遵循[安全策略](SECURITY.md)，使用 GitHub Private Vulnerability Reporting。

### Pull Request

- 清楚说明问题、解决方式和用户可见影响；存在相关 Issue 时请关联。
- 列出实际执行的验证命令及结果。无法运行的检查应说明原因和剩余风险。
- UI 变更应包含截图，并覆盖相关 loading、empty、error 和 success 状态。
- 平台变更应说明受影响的操作系统与架构。
- 说明兼容性、数据、发布、安全和回滚影响；没有明显风险时也应明确写出。
- 保持一个 PR 聚焦一个主题，等待 CI 通过后再请求审查。
