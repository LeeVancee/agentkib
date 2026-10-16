# main 合并后回归验收 — 2026-10-15

## 源码与工作区

- 验证 HEAD：`c0ed7bfe7ab04c6ccfbebf927f5e4a2f5a4ee96f`，本地 `main`。
- 合并前本地：`25f801af87a2401d732630807b6fb1771e4d1cd0`；本次拉取的 `origin/main`：`efb7904e3ce369929708f81d02f3d0b21150d9e5`。
- 上游包含桌面/Web 会话 UI 拆分、角色布局与分组，以及 Windows 路径显示、SQLite LIKE 转义等变更。
- 开始验收时已有 24 个跟踪文件修改及 `.agents/`、`prototypes/`、Claude 导入探测测试等未跟踪内容。合并前快照中的 232 个文件逐项 SHA256 复核一致，未覆盖这些工作。
- 本轮另外修改 6 个已有文件、增加两端各 1 个 transcript 测试文件及本 QA；未提交、未推送。下述结果对应 HEAD 加工作区修改，不代表已发布版本。
- 工具链：Node `22.23.3`、pnpm `12.10.1`、Electron `44.0.0`（内置 Node `24.18.1`），macOS arm64。没有新增依赖或更改锁文件。

## 确认并修复的问题

1. **桌面 Claude 接管失去实时能力校验。** 合并后的 `ManagedTasks` 没有再次调用 `canConfirmClaudeHandoff`。执行归属面板打开并确认后，如果当前状态变成 `control-outcome-unconfirmed`，旧按钮仍可发出接管请求。恢复按钮和执行函数两层校验；真实 EmbeddedConversation、WebClient 和桌面桥接测试验证旧状态不派发、恢复后仅派发一次、草稿保留。Web 生产代码已有校验，补充同一竞态断言。
2. **新会话阅读器向前分页重置工具展开及焦点。** 新 `SessionTranscript` 使用首条事件等不稳定键；同轮次前插历史会替换原 DOM。两端按重叠事件身份协调角色段和工具过程键，保留上游角色布局与分组顺序。新增测试直接挂载生产使用的组件，覆盖前插、流式追加、缺少首条用户记录、重复 turn ID 和手动折叠。旧共享 Transcript 测试仍保留。
3. **相邻既有问题：普通正文和 Markdown 链接重挂载。** 将正文段渲染展开为单层带键列表，固定共享 `SafeMarkdown` 的组件定义，避免正文保留但链接节点仍被替换。此项不归因于本次合并。过滤规则未变；测试继续拒绝图片、原始 HTML 和危险链接。

本轮未修改后端接管协议、权限、版本门限、进程检查或超时，不调用真实模型。多个过程因补齐历史而合并时，继续使用原分组行为，没有额外改变其展开合并规则。

## 自动化结果

以下命令使用上述 Node/pnpm，均在仓库根目录执行。

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check` | 通过 |
| `pnpm lint` | 通过，0 错误、261 条警告；未借此扩大格式化或重构范围 |
| `pnpm typecheck` | Backend、桌面、Web 全部通过 |
| `pnpm test`（最终独立运行） | 桌面 256 文件、4657 项通过、2 项跳过；Web 38 文件、767 项通过 |
| `node --test .github/scripts/*.test.mjs` | 14 项通过 |
| `node .github/scripts/smoke-test-backend-native.mjs` | darwin/arm64 原生后端 smoke 通过，覆盖已暂存 Koffi、node:sqlite/FTS5 |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs` | Electron utilityProcess 中索引/查询、Skills、交接读取 Worker 全部通过 |
| `pnpm build` | 桌面构建通过，包含 Web、Renderer、Electron 与 Backend |
| `pnpm build:web:hosted` | hosted Web 构建通过 |
| `git diff --check` | 通过 |

最终两项跳过为已有条件：Windows 专用 Win32 native error 测试；未启用 `AGENTKIB_TEST_CLAUDE_RELAY=1` 的跨仓库真实 broker/frp relay 测试。

保留失败与复核记录：与格式/lint/类型检查并行的那轮 `pnpm test` 有 3 项后端测试失败。其中 retirement-usage 在既有 `/bin/ps` 3000 ms 检查超时；managed-parity 的 5000 ms 超时伴随同用例的 `/bin/ps` 未处理拒绝；web-backend integration 的 continue 用例仅记录 5000 ms 超时，无法从日志确定具体等待步骤。三项及其后端调用链相对合并前本地提交未变，也不调用本轮前端组件。单独运行原三个文件为 59 通过、1 条件跳过；随后不与其他重型检查并行运行原始 `pnpm test`，完整通过。没有增加超时、减少断言或更改并发配置，不将第一次失败记录改写为通过。

独立子代理先分别审查桌面及 Web 合并结果，修复后由第三个子代理复核本轮 8 个代码/测试文件，结论为 **no findings**。复核包含实际组件测试、普通正文/链接焦点，以及新旧 Markdown 输出和安全属性对照。

## 最终构建的隔离启动

使用 `.github/scripts/run-desktop-startup-smoke.mjs` 的 `runDesktopStartupSmoke`，传入锁文件 Electron 的真实 executable 路径、`apps/desktop` 应用目录及 `--use-mock-keychain`，默认期限 75000 ms。该参数沿用 macOS release CI 的合成测试约定；正式启动代码和安全存储实现不变。

- 隔离 HOME、应用数据及 Electron profile；本地 Web 启用，无配对设备，LAN/relay 关闭，自动刷新关闭。
- 最终产物退出码 0，stderr 为空。
- `runtime-handshake`：371.80 ms；`window-shown`：439.41 ms；`home-data-ready`：683.33 ms。
- 测试进程及其子进程正常结束，临时数据由 harness 清理；没有替换已安装应用。

此前未使用测试钥匙串的尝试因临时 HOME 没有登录钥匙串，卡在 `safeStorage.isEncryptionAvailable` 的系统调用。原生采样确认 `SecItemAdd → defaultKeychainUI → AuthorizationCopyRights`，对应用户看到的“找不到钥匙圈来储存 AgentKib Dev Key”。未重置系统钥匙串。该次交互后启动也正常通过，但使用的是本轮最终 UI 修复前的构建，因此只作为故障定位证据，不替代上述最终产物启动结果。

最终入口文件 SHA256（用于定位本机这次构建，不等同于完整发布包校验）：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/main.cjs` | `d8520d390023b31d51d3a8583ca58157b37fb72b4d41b2ed9285d77deabb4ba2` |
| `apps/desktop/dist-electron/backend.cjs` | `b6f6b4258fd9925a7b7f6d6557587224c55eb27406e93d6cb74d707ae79b9399` |
| `apps/desktop/dist-electron/preload.cjs` | `ccf6875f1f99ce0fa47a7f607e248ceccb5088acc1b31511ba8caab58eb6330d` |
| `apps/desktop/dist/index.html` | `893b679a5725c6007e97c1b14a082e840cc0eba48769c8adbf0fbd789932c795` |
| `apps/web/dist-hosted/index.html` | `57d0a0be63b71b3484e0b218272667dac1bc12854965c2a5811c7dd537a7adb0` |

## 证据位置与边界

本机临时证据均位于 `/tmp`，可能被系统清理；本记录是摘要，不冒充原始日志备份：

- `agentkib-postmerge-final-checks-20261015.log`
- `agentkib-postmerge-final-tests-20261015.log`（包含首次三项失败）
- `agentkib-postmerge-timeout-triage-20261015.log`
- `agentkib-postmerge-final-tests-standalone-20261015.log`（最终全量通过）
- `agentkib-postmerge-ci-script-tests-20261015.log`
- `agentkib-postmerge-electron-workers-20261015.log`
- `agentkib-postmerge-final-build-20261015.log`
- `agentkib-postmerge-final-startup-20261015.json`
- `agentkib-postmerge-source-identity-20261015.json`（本轮 8 文件 SHA256）

覆盖范围内未发现剩余合并回归。真实账号/钥匙串登录、模型回复、手机与 Windows/Linux 实机、签名安装包和自动更新未在本轮验证；合成启动不代表这些能力已验收。
