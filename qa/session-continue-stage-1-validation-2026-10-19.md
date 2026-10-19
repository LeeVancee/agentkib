# 会话无感续接：第 1 阶段验证记录

日期：2026-10-19。范围：D11 Codex 端到端。阶段完成后已供用户审阅；用户确认提交第 1 阶段并继续第 2 阶段 Claude 后端。第 2 阶段保留为独立未提交改动。没有推送，没有删除 Codex Desktop follower 实现。

当前结论：本阶段代码与相关回归已完成；完整 Web 测试通过，最新完整桌面测试尚未通过。失败与隔离复跑结果如“检查”一节所列，不能据较早的一次全套通过声称最终全绿。

## 前置实测

实测使用 macOS、本机真实 CLI、隔离的临时目录；没有复制账号凭据，没有调用真实模型。模拟 provider 只用于产生可读取的合成历史。

| 项目 | 结果 |
| --- | --- |
| Claude Code 2.1.302 普通交互启动 | 不带 `--resume`、`--session-id` 的 `claude` 会被 `claude agents --json` 列出，类型为 `interactive`，带 PID、目录和会话 ID；注册文件有可与 UTC 进程启动时间核对的 `procStart`；退出后注册记录清理 |
| Codex 写锁最低稳定版 | 0.146.0 仅保护 paginated；0.145.0、0.146.0、0.146.1 的 legacy 历史可被两个 app-server 同时 resume；0.147.0 的 legacy 历史受写锁保护。因此本阶段使用最低版本 0.147.0 |
| 当前 CLI 0.155.1 与桌面内置 0.163.0-alpha.10.2 | 对持锁合成会话，另一个真实 app-server 能只读 `thread/read`（含非空历史），不能 `thread/resume`；拒绝为 JSON-RPC `-32600`、`already has an active writer` |
| 实际桌面应用持锁 | 独立启动同版本内置 app-server，只读当前任务 15 轮成功；`loaded/list` 为空；读取前后原写锁均保持占用。没有对当前任务 resume、fork、unsubscribe 或操作 GUI，没有保存真实对话内容 |
| `thread/unsubscribe` | 0.155.1 约 60.006 秒后发出 `thread/closed` 并释放；内置 0.163.0-alpha.10.2 在 60 秒时仍未释放。结束自有 app-server 进程均能释放锁，故自动回收使用结束进程 |
| 产品政策 | Claude Code 无感代跑上线前的合规确认仍由产品负责；本阶段未实施 Claude 代跑变更或上线 |

官方版本依据：[paginated 写锁引入提交](https://github.com/openai/codex/commit/5c94796dc9e88580fdf0b05ef9ce9d975a86e1a6)、[覆盖所有历史格式的提交](https://github.com/openai/codex/commit/dc60dadce6b5911b9b5852365f6eb9829ec14442)、[0.147.0](https://github.com/openai/codex/releases/tag/rust-v0.147.0)。低版本外部 writer 自身不取锁，不能仅凭 AgentKib 使用新版 CLI 就承诺与低版本客户端互斥。

本机复现证据：

- Claude：`/tmp/agentkib-claude-preflight-kkVI1h/observations.jsonl`。
- 版本边界：`/tmp/codex-lock-boundary-20261019/probes/`。
- Codex 当前版本与桌面占锁：`/tmp/agentkib-d11-preflight-gauyvwns/README.md`、`current-desktop-read-only-summary.json`、`cleanup-audit.json`。
- 前置实测的测试进程均已退出。`cross-cli-owner-kill` 的 SIGKILL 发生于原 owner 已释放之后，不能作为持锁进程崩溃释放的证据。

## 本阶段改动

- 后端统一通过自有 app-server 处理 Codex 会话，首次发送及回收后发送自动启动；保留原会话身份、工作区、CODEX_HOME、指纹、lease、版本及未知结果检查。follower 文件继续保留，主路由不再调用。
- 保留 JSON-RPC 错误码和消息，明确写锁拒绝映射为 `codex-owner-busy`；只读探测既有锁文件，不创建、改权限或删除第三方锁文件。实际发送仍以 native resume 的写锁裁决为准。
- 自动启动失败时为未派发的原发送请求保存可查询回执；启动子阶段的未知结果继续阻止重发，不通过清除未知回执放行。
- 原会话被占用时，只读历史后分支已完成轮次，不取得原会话的写锁；保留分支来源关系。
- 两端共用四语状态和选择条。去掉 Codex 手动恢复、确认勾选和旧交接卡片，队列使用新名称；保留追加、排队、停止、审批及问题的原生逻辑。
- 拒绝后保留草稿；占用解除后恢复输入；分支草稿与选择同步移交，检查和导航按会话及 generation 隔离。保留旧执行交接回执的核对机制。
- 宿主继续检查实验开关、设备权限、boot、revision、工作区及未知结果。LAN 基础发送沿用已注册会话范围，没有扩大 files/manage 权限。
- 仅可查看及选择“回 Codex 继续”后，提供复制续接命令和主机操作说明；命令仅通过只读接口生成，保留会话身份、工作区与 CODEX_HOME 校验，不启动 CLI 或占用写锁。复制不可用时可手动复制，不新增跨 Agent 功能。
- 续接命令保留已核验的原生执行子目录，两种 shell 分别进行字面量引用；Windows 说明指定 PowerShell。只读接口在返回前再次检查设备、可读 Codex 会话、注册工作区路径和目录身份。
- “回 Codex 继续”的选择与当前会话及占用状态同步绑定，切换会话时不会将旧选择应用到新会话；命令读取、复制反馈与手动复制框均隔离旧异步结果。

改动集中在 `packages/backend/src/` 的 Codex runtime、`apps/desktop/electron/main/web/service.ts`、`packages/web-client/src/index.ts`、`packages/session-ui/src/`、桌面和 Web 的会话详情组件及其回归测试。首页/侧栏运行状态按照实施顺序留在第 3 阶段。

## 已确认的文档差异

1. 实施说明要求仅可查看时提供“在原客户端继续”和“在其他 Agent 中继续”，但 Web 没有原客户端启动或跨 Agent API。用户于 2026-10-19 确认：“保持现有能力：提供复制续接命令与主机操作说明，不扩展 Web 跨 Agent 功能。”两端按此落实，原有跨 Agent 流程保持不变。
2. “最后订阅者离开时释放”没有明确正在回复时是否中断。用户于 2026-10-19 确认：“等当前轮次完成后释放。”回复、压缩及控制中的安全保护保留；轮次结束后检测到没有订阅者就释放，不再额外等待一分钟，即使较长期的 goal 仍为 active。仍有订阅者时，活跃 goal 不受闲置计时器回收。回归测试验证离开超过一分钟不关闭、不打断，本轮完成后下一秒关闭。

第 1 阶段审阅后的提交仅包含本阶段代码、测试和本记录；第 2 阶段由用户另行确认继续，不提前实施 Claude 界面。自动化完成与下节尚未执行的真实产品手动验收分别记录。

## 检查

本机项目指定的 pnpm 12.10.1 自动切换会报 `ENOEXEC`。使用现有 pnpm 10.8.1，并通过临时 userconfig 禁止自动切换；没有安装或升级项目依赖，没有修改仓库包管理器配置。

```sh
export npm_config_userconfig=/tmp/agentkib-pnpm-session-continue.npmrc
export NPM_CONFIG_USERCONFIG=/tmp/agentkib-pnpm-session-continue.npmrc
export npm_config_manage_package_manager_versions=false
export VITEST_MAX_WORKERS=2
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

- 最后冻结代码的 `pnpm typecheck`：通过（backend、desktop、Web 路由生成与类型检查）。
- 最后冻结代码的 `pnpm lint`：通过，0 错误；日志有 266 条警告，不据此声称无警告。
- 最后冻结代码的 `pnpm format:check`：通过，951 个匹配文件格式正确；新增的 backend 测试另做局部格式检查。
- 最后冻结代码的 `pnpm test:web`：59 个文件、1194 项全部通过。
- 最后冻结代码的桌面相关 Vitest：12 个文件、249 项通过，覆盖自动续接／版本／原生写锁错误／压缩／历史引用发送／生命周期／只读命令／宿主权限／路由／输入区与短订阅观察。命令见下。
- 最新 `pnpm test` **未通过**：桌面 350 个文件通过、5 个文件失败、1 个文件跳过；6657 项通过、17 项失败、3 项跳过。该次完整运行与最后生命周期补丁交错，不能作为冻结代码的最终全量通过证据。Web 未由该次命令继续执行，已以上述独立完整 Web 测试补齐。
- 上述 17 项失败中，16 项来自本轮未修改的 Skills 文件系统测试，触发既有 5000ms 限时；超时后另有清理 `ENOTEMPTY`。单 worker 隔离复跑 4 文件仍有 9 项失败、74 项通过，日志见下。同期主机 load average 约 450–500；这是资源竞争的关联证据，未证明唯一根因。相关 Skills 实现及其使用的既有 lease 逻辑不在本轮 diff 中；未改 Skills 代码、未延长超时。
- 另 1 项 goal 生命周期失败发生于补丁交错运行期间；修复并冻结后的生命周期及相关组合回归均已通过。当前不声称完整桌面套件已通过；需在环境稳定后补跑 `pnpm test`。
- 阶段主体在补充只读入口前曾完整通过一次 `pnpm test`：桌面 353 个文件通过、1 个文件跳过，6642 项通过、3 项跳过；Web 59 个文件、1178 项全部通过。这是较早版本的结果，不能替代最新全套检查。
- 首次阶段主体全套曾有 6 项失败：5 项旧 fake Codex 缺少版本响应，1 项并行调整中的自动续接回执断言；已补 fixture 并调整为可查询原请求回执的新行为，之后完整复跑通过。没有删除原测试或削弱断言。
- 补充回归发现并修复：旧“回 Codex 继续”选择跨会话短暂生效；active goal 阻止离开后的本轮结束释放；CLI 启动／预检期间离开漏记观察状态。订阅建立现在同步通知 runtime，控制入口及启动前保留观察状态，按会话共享至最后一个并发控制结束；后台从未被查看的启动不会误判为离开。
- 最后一项独立复现发现 runner 构造后、注册前的微任务间隙仍可能漏记短订阅。控制结束前现会将共享观察值回写当前 runner。原失败场景及仓库对应回归均已独立转绿；最终生命周期专项 24 项与上述 12 文件组合通过，最新窄复核无剩余明确 finding。
- 最终类型检查另发现新增宿主测试默认模式的类型错误，已修正并完整复跑通过。
- 独立复核发现的草稿、跨会话探测、回执与关闭失败缺陷也已修复。真实产品手动验收限制见下节。

冻结后的相关测试命令：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  test/codex-auto-continue.test.ts test/codex-resume-command.test.ts \
  test/codex-runtime-preflight.test.ts test/codex-app-server-dispatch.test.ts \
  test/compaction-control.test.ts test/history-search-native-send.test.ts \
  test/session-observation.test.ts electron/main/runtime-router.test.ts \
  electron/main/web/codex-resume-command.test.ts electron/main/web/codex-actions.test.ts \
  electron/main/web/remote-capabilities.test.ts \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx
```

日志：

- 冻结后的类型、lint、格式、Web 与相关桌面测试：`/tmp/agentkib-session-continue-stage1-final-{typecheck,lint,format,web,related}-frozen.log`。
- 最新完整失败运行：`/tmp/agentkib-session-continue-stage1-final-followup-test.log`。
- Skills 单 worker 隔离复跑：`/tmp/agentkib-skill-fs-recheck-20261019.log`。
- 较早完整通过运行：`/tmp/agentkib-session-continue-stage1-final-test.log`。

## 真实 CLI 手动验收覆盖

技术前提文档的 8 条用例，当前覆盖如下：

| 用例 | 当前情况 |
| --- | --- |
| 1 Claude 关闭终端后直接发送、10 分钟回收、回终端继续 | 未做；属于第 2、3 阶段 |
| 2 普通 Claude 终端占用、分支不影响原会话 | 已实测普通终端发现；完整产品流程未做 |
| 3 外部 Claude 中途打开，AgentKib 停止 | 未做；属于第 2、3 阶段 |
| 4 Codex 空闲直接发送及约 1 分钟回收 | 已验证真实 app-server 启动、写锁和释放原语；通过 AgentKib 界面调用真实模型的完整流程未做 |
| 5 Codex Desktop/CLI 占用、选择条分支、退出后恢复 | 实际 Desktop 持锁只读及两个真实 app-server 的拒绝已测；产品界面完整手动流程未做 |
| 6 AgentKib 占锁，CLI 拒绝，释放后 CLI 可打开 | 两个真实 app-server 互斥及退出后 resume 成功已测；AgentKib 与交互 CLI 的完整组合未做 |
| 7 Windows Claude、旧 Codex 仅可查看及替代入口 | 旧 Codex 版本边界实测与自动化已覆盖；复制续接命令与主机说明按用户确认落实并补自动化；Windows 未做 |
| 8 手机 Web 状态、选择条及桌面终端设置 | 共享组件与 Web 自动化已覆盖相关渲染和权限；真实手机完整手动流程未做 |

协议级实测、自动化测试与真实产品端到端手动验收分开记录，没有把模拟 provider 当作真实模型验收。

## 文件清单

以下为本任务相对开始时新增或修改的文件；原有未跟踪的 `.agents/`、`prototypes/` 与两份实施／技术前提文档未修改。

- `apps/desktop/electron/main/runtime-router.test.ts`
- `apps/desktop/electron/main/runtime-router.ts`
- `apps/desktop/electron/main/web/codex-actions.test.ts`
- `apps/desktop/electron/main/web/codex-resume-command.test.ts`
- `apps/desktop/electron/main/web/conversation-transport.ts`
- `apps/desktop/electron/main/web/history-search-lan.test.ts`
- `apps/desktop/electron/main/web/remote-capabilities.test.ts`
- `apps/desktop/electron/main/web/service.test.ts`
- `apps/desktop/electron/main/web/service.ts`
- `apps/desktop/src/features/sessions/conversation/conversation.tsx`
- `apps/desktop/src/features/sessions/conversation/features/catalog/catalog-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-tools.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-tasks.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-busy-choice.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-display-state.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-read-only.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-reader.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/use-session-controller.ts`
- `apps/desktop/test/codex-app-server-dispatch.test.ts`
- `apps/desktop/test/codex-auto-continue.test.ts`
- `apps/desktop/test/codex-resume-command.test.ts`
- `apps/desktop/test/codex-runtime-preflight.test.ts`
- `apps/desktop/test/compaction-control.test.ts`
- `apps/desktop/test/history-search-native-send.test.ts`
- `apps/desktop/test/session-observation.test.ts`
- `apps/web/src/features/conversation/features/catalog/catalog-copy.ts`
- `apps/web/src/features/conversation/features/sessions/codex-copy.ts`
- `apps/web/src/features/conversation/features/sessions/codex-tools.tsx`
- `apps/web/src/features/conversation/features/sessions/managed-tasks.tsx`
- `apps/web/src/features/conversation/features/sessions/session-busy-choice.tsx`
- `apps/web/src/features/conversation/features/sessions/session-composer.test.tsx`
- `apps/web/src/features/conversation/features/sessions/session-composer.tsx`
- `apps/web/src/features/conversation/features/sessions/session-display-state.ts`
- `apps/web/src/features/conversation/features/sessions/session-read-only.tsx`
- `apps/web/src/features/conversation/features/sessions/session-reader.tsx`
- `apps/web/src/features/conversation/features/sessions/use-session-controller.ts`
- `apps/web/src/features/sessions/codex-continuation-controller.test.tsx`
- `apps/web/src/features/sessions/codex-copy.test.ts`
- `apps/web/src/features/sessions/codex-features.test.tsx`
- `apps/web/src/features/sessions/managed-dialog-localization.test.tsx`
- `apps/web/src/features/sessions/managed-handoff-feedback.test.tsx`
- `apps/web/src/features/sessions/managed-tasks.test.tsx`
- `apps/web/src/features/sessions/session-continuation.test.tsx`
- `apps/web/src/features/sessions/session-display-state.test.ts`
- `apps/web/src/features/sessions/session-handoff-display.test.ts`
- `apps/web/src/features/sessions/session-handoff-entry.test.tsx`
- `apps/web/src/features/sessions/session-workspace.tsx`
- `apps/web/src/web-client.test.ts`
- `packages/backend/src/codex-app-server.ts`
- `packages/backend/src/codex-resume-command.ts`
- `packages/backend/src/codex-runtime-preflight.ts`
- `packages/backend/src/index.ts`
- `packages/backend/src/managed-codex-state.ts`
- `packages/backend/src/managed-session-lock.ts`
- `packages/backend/src/session-readers.ts`
- `packages/backend/src/session-stream.ts`
- `packages/backend/src/web-read.ts`
- `packages/session-ui/src/index.tsx`
- `packages/session-ui/src/session-continuation.tsx`
- `packages/web-client/src/index.ts`
- `qa/session-continue-stage-1-validation-2026-10-19.md`
