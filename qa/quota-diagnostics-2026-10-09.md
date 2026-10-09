# 额度采集诊断与部分成功修复 · 2026-10-09

## 源码与环境

- 基线：`v0.16.0` / `fb9c39469e4600f9a94e175adc1f06e75df4921d`，开始时工作树干净。
- 验证时分支：`codex/quota-diagnostics-20261009`；验证针对该基线上的工作区修复，本报告随修复一并提交。
- macOS arm64，Node `22.23.3`、仓库要求的 pnpm `12.10.1`。
- 本机安装的 AgentKib：`0.16.0`。未替换已安装应用，未修改自动刷新设置或 Agent 配置。
- 安装包内采集器 SHA256：`cd691cb61e6d2b39eda977a14a4695fefd85c994893fe5cb5214e160f4390fc7`。
- 打包脚本固定 CodexBarCLI `v0.49.5`。包内 `--version` 返回 `CodexBar 0.16.0`，该输出不作为上游版本身份的独立证明。
- `git fetch origin` 遇到 GitHub TLS 连接失败；本轮使用已发布 tag 的固定源码，不声称包含之后的远端变更。

## 实际诊断

只读数据库记录：最后成功采集为 `2026-09-09T14:15:32Z`，最近尝试为 `2026-10-08T05:57:52Z`，调度失败计数 `391`，错误仅为 `quota collector returned no usable quota for enabled providers`。自动刷新当前关闭。截图中的 13% 是旧缓存。

使用当前安装的采集器和既有 CodexBar 配置，执行一次：

```text
agentkib-quota-sidecar dashboard --identity redacted --timeout 25
```

外层进程期限 35 秒，实际 25.97 秒完成、退出码 0、stderr 为空。响应生成于 `2026-10-09T02:24:44Z`（台北 10:24:44）。命令只执行一次、未调用模型；未统计采集器内部 HTTP 请求次数。仅保存去除账号信息后的诊断摘要到本机私有临时文件，未保存原始凭据或完整响应。

| Provider | 实际返回 | 附带错误 |
| --- | --- | --- |
| Codex / oauth | Weekly 剩余 57%，重置 `2026-10-14T03:31:52Z` | `codex cost refresh timed out` |
| Claude / web | Session 剩余 81%，Weekly 剩余 61% | `claude cost refresh timed out` |
| Gemini | 无窗口 | 尚未登录 |
| Antigravity | 无窗口 | 未检测到语言服务器 |
| Kiro | 无窗口 | CLI 子进程无法启动 |

这些是该次响应的结果，不代表后续实时额度；不能将 Claude 网页账户额度外推为任意第三方 Claude CLI provider 的额度。Codex 只返回 Weekly，不补造五小时额度。后三个 Provider 原本不在产品已验证展示范围内，本轮没有扩大支持范围。

## 根因与修复边界

上游 [DashboardSnapshotBuilder.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/DashboardSnapshotBuilder.swift#L122) 将独立的 cost 错误合并到 Provider error；窗口仍来自 usage。[CLIServeCommand.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIServeCommand.swift#L623) 明确定义该费用超时文字。一次性 [dashboard](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIDashboardCommand.swift#L73) 先取 usage 再取 cost；真正的 usage 失败返回空 usage，参见 [CLIErrorReporting.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIErrorReporting.swift#L49)。

AgentKib 原先只要 Provider 带 error 就拒绝其直接额度，因此该次有效数据会被整份拒收。现在仅对已核实的 Codex/Claude 精确费用超时、存在额度数据且时间合理的情况保留结果和警告。授权、usage、未知错误仍不被此例外放行。`updatedAt` 可能包含 cost/status 时间，只作为额外约束，不单独证明 usage 新鲜。

全失败继续保留旧快照，现有错误字段补充各启用 Provider 的具体原因，不增加数据库表或 RPC 类型。诊断屏蔽密码、私钥、常见密钥、JWT、邮箱及 URL；账号标签不参与失败汇总。错误详情有长度上限。

界面补最近尝试和自动刷新状态；失败事件/轮询/回执更新诊断。过期快照及已到期窗口不再显示“1 分钟后重置”，静置时也会更新提示。原有自动刷新设置保持不变。

## 验证

实际命令使用 Node 22 PATH 和 pnpm 12.10.1 的 `bin/pnpm.mjs` 入口；本机旧 pnpm 启动器自动切版本时发生 ENOEXEC，使用临时目录内的启动包装解决，未修改仓库包管理器或全局安装。

```sh
pnpm --filter @agentkib/desktop exec vitest run test/quota-owner.test.ts src/features/quota electron/main/refresh-coordinator.test.ts src/core/i18n.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm build:web:hosted
git diff --check
```

结果：相关 10 个文件、65 项测试通过；format、typecheck、桌面构建、hosted Web 构建、`git diff --check` 均通过。lint 退出码 0、无错误，仓库有 75 条警告；变更中的 quota 页面三条 set-state-in-effect 警告位于既有代码，没有为本轮削弱规则。

测试使用真实 QuotaOwner、BackendStore SQLite 和真实页面/查询组件，仅在采集进程与客户端边界提供合成响应。覆盖部分成功、全失败保留旧值、错误分类、未来/缺失/过期时间、敏感诊断、失败通知、静置到期和自动刷新关闭。

独立子代理核验了上游合约并审查实现；复核发现的 JSON 密码和标准 PRIVATE KEY 脱敏缺口已修复并补回归，复核未发现剩余确定问题。

本轮原生证据限于 macOS 上一次采集器查询。修改后的安装包尚未发布或替换；Windows/Linux 原生采集器未实测。没有重新执行费用统计以探测其具体性能瓶颈，不能把超时进一步归因为网络或某个历史文件。
