# Security policy / 安全策略

## Supported versions / 支持版本

AgentKib is a development preview. Security fixes are provided for the latest
published release only. Before reporting a vulnerability, confirm that it is
reproducible on the latest release.

AgentKib 仍处于开发预览阶段，仅为最新发布的正式版本提供安全修复。报告漏洞前，请先确认问题可在最新版本中复现。

## Reporting a vulnerability / 报告漏洞

Report suspected vulnerabilities through
[GitHub Private Vulnerability Reporting](https://github.com/starroyhq/agentkib/security/advisories/new).
Do not disclose vulnerabilities through public issues, discussions, pull
requests, or social media before a coordinated fix is available.

请通过 [GitHub 私密漏洞报告](https://github.com/starroyhq/agentkib/security/advisories/new)
提交疑似安全漏洞。在协调修复完成前，请勿通过公开 Issue、Discussion、Pull Request
或社交媒体披露漏洞。

A useful report should include:

- The affected AgentKib version, operating system, and architecture.
- The security impact and the conditions required to trigger it.
- Minimal, reproducible steps or a small proof of concept.
- Relevant logs or screenshots after removing private paths and sensitive data.
- Any known mitigation or workaround.

有效报告应包含：

- 受影响的 AgentKib 版本、操作系统和架构；
- 安全影响及触发条件；
- 最小复现步骤或精简的概念验证；
- 已移除私有路径和敏感信息的相关日志或截图；
- 已知的缓解措施或临时方案。

Never include API keys, tokens, cookies, private keys, complete transcripts,
private repository contents, or real user data. Use disposable workspaces and
placeholder credentials whenever possible.

请勿提交 API Key、Token、Cookie、私钥、完整会话记录、私有仓库内容或真实用户数据。
请尽量使用一次性工作区和占位凭据复现问题。

Security issues include, but are not limited to, unauthorized disclosure of
local sessions or configuration, credential exposure, path-boundary bypasses,
unsafe update verification, unintended code execution, and privilege
escalation. Ordinary bugs and feature requests should use
[GitHub Issues](https://github.com/starroyhq/agentkib/issues).

安全问题包括但不限于：本地会话或配置被未授权披露、凭据泄露、路径边界绕过、
更新校验不安全、意外代码执行和权限提升。普通缺陷和功能建议请使用
[GitHub Issues](https://github.com/starroyhq/agentkib/issues)。

Maintainers will coordinate investigation, remediation, release timing, and
public disclosure through the private advisory. No fixed response-time SLA is
currently offered.

维护者将通过私密安全公告协调调查、修复、发布时间和公开披露。目前不承诺固定的响应时限。
