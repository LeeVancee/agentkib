# 会话无感续接：第 3 阶段 Claude 界面验证

日期：2026-10-19。基线：`06b678020`（第 2 阶段 Claude 后端）。本阶段经用户确认后本地提交，不推送。

## 范围与行为

- 按实施说明第 4 节推进第 3 阶段：桌面会话页、Web、工作区 Claude 面板同步取消手动“交给 AgentKib”、交还与执行管理流程。新建任务保留。
- 空闲直接输入；发送时显示乐观消息和启动状态；已连接终端显示运行位置与终端审批提示；外部占用显示分支/返回选择条，macOS 桌面可直达连接终端向导。占用轮询间隔 4 秒，发送结果仍以主机权威检查为准。
- 发送被明确拒绝时保留文本、附件和引用；未知结果保留原请求身份并阻止自动重发。分支草稿只在当前选择代次搬运一次；附件在新会话重新上传，不复用原会话附件 ID。资源 ID/目录游标不能证明跨会话身份，保留不可发送的引用标签并提示重新选择。
- 自动结束提示放在对话底部；中途冲突显示信息提示。正常状态不再显示旧交接横幅；客户端版本、模型、会话 ID 和来源文件归入会话详情；详情仅使用当前会话的运行数据，异步返回受到设备授权和会话身份约束。
- 首页、目录与详情复用运行位置文案；简体中文、繁体中文、英文、日文同步。目录仅投影已知的运行/短期占用信息，不为列出历史会话启动 CLI 或额外执行占用探测。
- 补齐 Claude 只读续接命令读取：工作区与原生身份、配置目录经过校验，路径采用 shell 字面量引用；沿用已配对设备与工作区授权前后检查，不调用 CLI、不获取执行锁。

## 安全与范围约束

- 内部锁、指纹、版本、平台、权限、回执、代次与原生交互身份校验保留。
- 逐语言比对 `HEAD`：四份 locale 中各 132 个跨 Agent/工作区继续相关键保持原值；两端状态/横幅/交接兼容/草稿 helper 字节一致。
- 未修改跨 Agent 继续、交接文件、在工作区续接流程及 `handoff.*` 命名空间。工作区面板的连接终端入口仅用于同一条 Claude 会话。
- 未删除或修改 Codex follower 实现。第 4 阶段清理尚未推进。
- 保留任务开始前已有的 `.agents/`、`prototypes/`、两份本机未跟踪实施/技术文档与本机设计文件。

## 实测与文档差异

- 发现后端已经有详情状态，但目录摘要没有运行位置；新增只读、可失效的目录投影，安全状态优先于外部占用缓存。
- Claude 没有现成的只读复制命令接口；复用已存在的 `managed/resume-command` 授权路径，按持久化会话身份选择 Agent，未引入 Web 跨 Agent 功能。
- 终端刚配对但还没有首个可信快照时，维持不可发送/未连接状态，不显示虚假的“已连接”。损坏的终端登记继续拦截发送，但不阻止只读复制命令。
- 目录投影使用廉价 runner 状态读取，避免每次目录轮询复制、截断长回复正文；目录生成复用已有记录。
- 会话详情此前没有客户端版本、模型和来源文件字段，两端已补齐四语标签。Claude 来源文件只展示已验证的原生路径；新任务尚无文件或可选来源验证失败时明确显示未知，保持原有工作区 context 可用，控制路径的身份校验不变。
- 常驻空闲 runner 也可能有独立的主机未知回执；目录使用既有权威读取/结算结果保留未知状态，普通空闲帧不能覆盖它，也不为目录增加磁盘或占用探测。
- 原不确定操作回执仍可后台结算；移除执行管理界面不会丢弃未知操作身份，也不会把未知结果当作未发送。
- 只读 Web 替代入口遵照用户已确认的范围：复制续接命令和主机操作说明，不增加 Web 跨 Agent 功能。

## 自动验证

- `pnpm typecheck`：通过（backend、desktop、Web；含 Web 路由生成）。
- `pnpm lint`：通过，0 错误、275 条警告。包含仓库原有警告与本阶段相关 React 检查警告；不宣称零警告。
- `pnpm format:check`：通过，960 个匹配文件。
- `pnpm test:web`：60 个文件、1209 条用例全部通过；日志 `/tmp/agentkib-stage3-web-final.log`。
- 桌面、工作区面板与相关后端最终组合：51 个文件、894 条用例全部通过；日志 `/tmp/agentkib-stage3-desktop-frozen.log`。
- 两端会话详情各 13 条回归已包含在上述最终组合中，覆盖四语版本/模型/来源文件、切换会话、迟到响应和撤销授权；Claude 来源文件验证失败保留原工作区 context 的回归先失败后通过。
- 清理两端测试的未使用导入后，两端 `session-handoff-display.test.ts` 各 40/40 再验证通过；lint 与 format:check 重新通过。
- 首发乐观消息、分支源标记与去重额外回归：Web 2 文件 32/32 通过，两端 reader 用例同步。
- 新增命令字面量引用测试实际运行隔离的 POSIX shell 与合成 `claude` 可执行文件，验证包含引号、反引号和 `$()` 的路径不会执行插值；PowerShell 分支验证命令字面量，未当作 Windows 实机验收。

主要覆盖：空闲/回收后直接发送、焦点预检、外部占用 4 秒恢复、发送拒绝保留草稿及附件、分支代次/文件/历史引用迁移、资源身份失效、未知回执禁止重发、旧交接回执结算、终端快照和插件向导权限、模式/原生交互身份变化、四语首页/侧栏/详情状态、乐观消息去重、自动结束与冲突提示。

先补测试复现旧行为，再实现新行为；没有删除原有安全检查来通过测试。并行开发期间也跑过较早快照：旧交接/终端文案断言、首页新增导航语义、后补的 busy 草稿门和目录性能断言出现过失败，已修正并在对应最终用例中验证。第 2 阶段的全仓库 `pnpm test` 有已记录超时；本阶段未重跑该全仓库命令，采用上列完整 Web 与桌面相关组合验证，不宣称全仓库测试通过。

工具链与前两阶段一致：本机 Homebrew pnpm 10.8.1。仓库声明的 pnpm 12.10.1 自动切换会报 `ENOEXEC`，验证通过 `/tmp/agentkib-pnpm-session-continue.npmrc` 设置 `manage-package-manager-versions=false`；不修改仓库包管理器或依赖。

桌面相关组合的实际 Vitest 范围（与 `pnpm test:web` 分开运行）：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  src/features/sessions \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  test/claude-auto-continue.test.ts test/claude-bridge-auto-continue.test.ts \
  test/claude-retirement-usage.test.ts test/claude-bridge.test.ts \
  test/claude-bridge-runtime.test.ts test/claude-resume-command.test.ts \
  test/claude-runner-status.test.ts test/codex-auto-continue.test.ts \
  test/claude-managed-parity.test.ts electron/main/web/codex-resume-command.test.ts
```

命令运行时设置 `npm_config_manage_package_manager_versions=false`，根脚本额外使用上述临时 userconfig，测试设置 `VITEST_MAX_WORKERS=1`；日志只放在 `/tmp`。

## 浏览器与真实 CLI 验收

- Playwright 使用真实 Chromium 渲染生产 Web 路由和桌面 `EmbeddedConversation`。接口/流数据来自隔离的合成测试夹具，未访问用户会话、未触发真实模型任务。桌面渲染验证不是打包 Electron 验收。
- 截图保存在忽略目录 `output/playwright/stage3/`。临时桌面预览入口和本任务启动的两个 Vite 服务已清理。
- 桌面组件：1280px 宽布局、390px 窄屏四种语言；选择条所有按钮高度至少 44px（英/日插件长文案为 64px），页面滚动宽度均为 390px，无横向溢出。已查看生成的截图。
- Web：390px 占用选择、已连接终端、自动结束、中途冲突截图；转移提示各只显示一次。实际操作“回 Claude Code 继续”再模拟外部退出，原始未发送草稿恢复，未发送模型请求。
- 真实 CLI 技术前提实测沿用第 1 阶段记录：普通无参数 Claude 交互进程的识别、Codex 原生写入锁与订阅离开等；本阶段未把合成进程测试算作真实 CLI 验收。

技术前提文档“验收”逐项状态：

| 项 | 本阶段验证 | 仍需真实环境验收 |
| --- | --- | --- |
| 1 Claude 空闲发送、10 分钟后回终端 | 自动续接/回收/重启安全回归；UI 直接输入与自动结束提示 | 真实模型回复、实际等待 10 分钟、终端续接与原生记录无交错 |
| 2 Claude 终端占用及分支 | 无参数终端识别前提沿用；占用选择、分支草稿/附件/回执回归 | 用户真实终端与分支会话的完整模型往返 |
| 3 Claude 运行中外部打开 | 后端抢占停止与 UI 冲突提示回归 | 两个真实 CLI 的完整并发记录验收 |
| 4 Codex 空闲续接与释放 | 第 1 阶段已验证的链路，本阶段共享状态/回执回归 | 真实模型轮次与约 1 分钟释放后人工续接 |
| 5 Codex 外部占用与分支 | 原生写入锁技术前提沿用；共享选择条/草稿回归 | 真实桌面应用/CLI 与分支的完整往返 |
| 6 Codex 双写拒绝 | 第 1 阶段原生锁实测沿用，相关代码未改 | 真实模型执行期间从另一 CLI 续接及释放后的整体验收 |
| 7 不支持的平台/版本 | Windows Claude/旧版本只读、原因、命令与四语回归 | Windows 实机与旧版 CLI 产品验收 |
| 8 手机/Web 与桌面一致 | 四语渲染/交互测试、桌面与窄屏 Chromium 视觉检查 | 真手机连接运行中的主机、完整真实 CLI 操作 |

## 文件清单

本阶段修改/新增 111 个文件（不含临时预览文件、忽略目录截图和用户已有本机文档）；提交范围仅限本阶段文件。

### 共享组件与客户端契约

共享状态与选择条、只读命令及目录摘要类型。

- `packages/session-ui/src/index.tsx`
- `packages/session-ui/src/session-continuation.tsx`
- `packages/web-client/src/index.ts`

### 后端只读投影与命令

运行位置、安全状态优先级、廉价状态读取、命令及详情来源身份校验。

- `packages/backend/src/claude-bridge.ts`
- `packages/backend/src/claude-managed-read.ts`
- `packages/backend/src/claude-managed-runner.ts`
- `packages/backend/src/claude-resume-command.ts`
- `packages/backend/src/index.ts`
- `packages/backend/src/web-read.ts`

### 桌面宿主授权

沿用配对设备和工作区授权的只读命令读取及宿主回归。

- `apps/desktop/electron/main/web/codex-resume-command.test.ts`
- `apps/desktop/electron/main/web/service.ts`

### 桌面自动化回归

续接、桥接、回收、目录安全与性能、来源文件及 shell 命令验证。

- `apps/desktop/test/claude-auto-continue.test.ts`
- `apps/desktop/test/claude-bridge-auto-continue.test.ts`
- `apps/desktop/test/claude-bridge.test.ts`
- `apps/desktop/test/claude-managed-parity.test.ts`
- `apps/desktop/test/claude-resume-command.test.ts`
- `apps/desktop/test/claude-retirement-usage.test.ts`
- `apps/desktop/test/claude-runner-status.test.ts`
- `apps/desktop/test/codex-auto-continue.test.ts`

### 桌面界面、四语与组件测试

自动续接、占用选择、运行状态、连接向导、草稿、详情与工作区面板。

- `apps/desktop/src/core/i18n.ts`
- `apps/desktop/src/core/types.ts`
- `apps/desktop/src/features/sessions/DesktopConversation.integration.test.tsx`
- `apps/desktop/src/features/sessions/DesktopConversationPane.test.tsx`
- `apps/desktop/src/features/sessions/DesktopConversationPane.tsx`
- `apps/desktop/src/features/sessions/SessionDirectory.test.tsx`
- `apps/desktop/src/features/sessions/SessionDirectory.tsx`
- `apps/desktop/src/features/sessions/SessionOverview.tsx`
- `apps/desktop/src/features/sessions/conversation-panel-commands.ts`
- `apps/desktop/src/features/sessions/conversation/conversation.tsx`
- `apps/desktop/src/features/sessions/conversation/features/catalog/catalog-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/catalog/session-details-dialog.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/catalog/session-details-dialog.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/claude-bridge-panel.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/claude-connection-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/claude-session-banner.test.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/claude-session-banner.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-session-controls.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/codex-tools.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/context-usage-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/context-usage.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/continuation-draft.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-error-copy.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/managed-tasks.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-busy-choice.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-display-state.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-operations.test.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-operations.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-panels.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-read-only.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-reader.tsx`
- `apps/desktop/src/features/sessions/conversation/features/sessions/use-session-controller.ts`
- `apps/desktop/src/features/sessions/conversation/live-status.ts`
- `apps/desktop/src/features/sessions/session-continuation-list.test.ts`
- `apps/desktop/src/features/sessions/session-view-store.test.ts`
- `apps/desktop/src/features/sessions/session-view-store.ts`
- `apps/desktop/src/features/workspace/ClaudeSessionPanel.test.tsx`
- `apps/desktop/src/features/workspace/ClaudeSessionPanel.tsx`
- `apps/desktop/src/features/workspace/WorkspaceSessionsPage.tsx`
- `apps/desktop/src/locales/en-US.json`
- `apps/desktop/src/locales/ja-JP.json`
- `apps/desktop/src/locales/zh-CN.json`
- `apps/desktop/src/locales/zh-TW.json`
- `apps/desktop/src/routes/(main)/workspace/$workspaceId/sessions.tsx`

### Web 界面、四语与组件测试

同步直接续接、状态、草稿及回执、详情和四语行为。

- `apps/web/src/features/catalog/session-catalog.test.tsx`
- `apps/web/src/features/catalog/session-details-dialog.test.tsx`
- `apps/web/src/features/conversation/features/catalog/catalog-copy.ts`
- `apps/web/src/features/conversation/features/catalog/session-catalog.tsx`
- `apps/web/src/features/conversation/features/catalog/session-details-dialog.tsx`
- `apps/web/src/features/conversation/features/sessions/claude-connection-copy.ts`
- `apps/web/src/features/conversation/features/sessions/claude-session-banner.test.ts`
- `apps/web/src/features/conversation/features/sessions/claude-session-banner.ts`
- `apps/web/src/features/conversation/features/sessions/codex-composer.tsx`
- `apps/web/src/features/conversation/features/sessions/codex-session-controls.tsx`
- `apps/web/src/features/conversation/features/sessions/codex-tools.tsx`
- `apps/web/src/features/conversation/features/sessions/context-usage-copy.ts`
- `apps/web/src/features/conversation/features/sessions/context-usage.tsx`
- `apps/web/src/features/conversation/features/sessions/continuation-draft.ts`
- `apps/web/src/features/conversation/features/sessions/managed-error-copy.ts`
- `apps/web/src/features/conversation/features/sessions/managed-tasks.tsx`
- `apps/web/src/features/conversation/features/sessions/session-busy-choice.tsx`
- `apps/web/src/features/conversation/features/sessions/session-composer.test.tsx`
- `apps/web/src/features/conversation/features/sessions/session-composer.tsx`
- `apps/web/src/features/conversation/features/sessions/session-display-state.ts`
- `apps/web/src/features/conversation/features/sessions/session-panels.tsx`
- `apps/web/src/features/conversation/features/sessions/session-read-only.tsx`
- `apps/web/src/features/conversation/features/sessions/session-reader.tsx`
- `apps/web/src/features/conversation/features/sessions/use-session-controller.ts`
- `apps/web/src/features/conversation/i18n/index.ts`
- `apps/web/src/features/conversation/live-status.ts`
- `apps/web/src/features/sessions/claude-parity.test.tsx`
- `apps/web/src/features/sessions/codex-continuation-controller.test.tsx`
- `apps/web/src/features/sessions/codex-copy.test.ts`
- `apps/web/src/features/sessions/context-navigation.test.tsx`
- `apps/web/src/features/sessions/context-usage.test.tsx`
- `apps/web/src/features/sessions/managed-dialog-localization.test.tsx`
- `apps/web/src/features/sessions/managed-handoff-feedback.test.tsx`
- `apps/web/src/features/sessions/managed-tasks.test.tsx`
- `apps/web/src/features/sessions/session-display-state.test.ts`
- `apps/web/src/features/sessions/session-empty.test.tsx`
- `apps/web/src/features/sessions/session-empty.tsx`
- `apps/web/src/features/sessions/session-guidance.test.tsx`
- `apps/web/src/features/sessions/session-handoff-display.test.ts`
- `apps/web/src/features/sessions/session-handoff-entry.test.tsx`
- `apps/web/src/features/sessions/session-stability.test.tsx`
- `apps/web/src/features/sessions/session-workspace.tsx`

### QA 记录

本阶段范围、差异、验证证据及真实 CLI 待验项。

- `qa/session-continue-stage-3-validation-2026-10-19.md`
