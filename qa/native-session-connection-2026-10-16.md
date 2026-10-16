# 原会话连接与共享后端 QA — 2026-10-16

本文记录首次接入时的源码和验证结果，后续审查已修改插件、协议及界面。下述测试数量、最终源码清单和插件哈希属于审查前批次，不能用来证明审查后源码已通过。审查后的独立结果及当前插件身份见[审查修复 QA](native-session-review-loop-2026-10-16.md)；原始失败和原生证据保持不变。

## 源码与边界

- 基线：`origin/main 74912da90fe2edea090efe1d673cea9f2a439663`。
- 工作树：`$WORKTREE`，分支 `codex/native-session-connection`；创建时干净，本轮修改未提交。
- 主目录另有未提交的 UI 工作，本工作树没有复制、覆盖、清理或提交这些改动。
- Node `22.23.3`，pnpm `12.10.1`，锁文件安装和再次 frozen 安装通过；没有新增生产依赖或业务数据库表。
- Claude CLI `2.1.301`，插件 `0.1.0`；Codex CLI `0.155.1`。没有修改个人 Agent 配置、模型、凭据或 daemon，没有部署、发布或替换安装应用。
- 本轮真实模型请求 **0**。原生 CLI 接本地合成 provider，与前端/宿主自动化分别记录；不替代真实模型或真机手机验收。

## 产品能力结论

| 模式 | 本轮结果 |
| --- | --- |
| Claude 原终端连接 | 已实现本机 owner 主动配对、原 UUID/工作区/版本绑定，桌面和获授权 Web 共用连接、观察流式与工具摘要、取消当前原生 turn |
| 原终端文本发送 | **关闭**。原生 `$.prompt.submit` 没有可验证的原子空闲/CAS 参数，自身 `prompt.submit` hook 被 engine re-entry 排除，竞争输入可能进入原生等待队列。仅隔离副本的发送契约实验成功，不能提升生产能力 |
| 审批 / 问题 / 附件 | 审批和问答留在原终端；附件、资源、队列、goal、设置、分叉等在 follower 模式关闭，不修改 CLI 原权限判断 |
| Claude managed | 既有门限、停止确认、持久回执和完整控制路径保留；没有自动从连接失败切换为 managed |
| Codex 共享 app-server | 固定版本隔离验证，未接生产入口；逐项结果见[独立 Codex QA](codex-shared-server-2026-10-16.md) |
| Windows / Linux | 新原会话连接关闭。可移植协议测试可运行；没有实机原生验收 |

连接、重连、查看和断开都不启动模型；退出只关闭自有桥接，不结束借用的 Claude 原终端。原生日志仍通过原 provider 读取，近期 snapshot 不充当全历史。Web 无插件安装、连接码或 socket/path 管理入口。

## 实际命令与结果

以下命令在本工作树、上述 Node/pnpm 下执行。Vitest 命令通过 `pnpm --filter @agentkib/desktop exec` 运行；测试日志保留在 `/tmp/agentkib-native-session-*.log`。

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；全部 11 个 workspace project，现有锁文件不变 |
| `pnpm format:check` | 通过 |
| `pnpm lint` | 通过，无 error；保留 React Compiler / hooks 等 warning，没有为了通过而关规则 |
| `pnpm typecheck` | backend、桌面、Web 通过；路由生成器有 circular-dependency warning |
| `vitest run test/claude-bridge.test.ts test/claude-bridge-runtime.test.ts` | 28 项通过，真实 UDS、BackendStore、Runtime、WebAccessService；未模拟 owner 控制实现 |
| `vitest run src/features/sessions/DesktopConversation.integration.test.tsx src/features/sessions/conversation/features/sessions/claude-bridge-panel.test.tsx electron/main/web/local-claude.test.ts` | 34 项通过；之后的失效来源撤销、状态读取失败及未知状态撤销回归纳入下述最终 95 项 |
| `pnpm test:web` | 37 文件、771 项通过 |
| `pnpm test` 首轮 | 桌面 5497 通过、7 超时、3 跳过；两个 Skills 文件的文件系统测试触发原有 5 秒期限，Web 未进入。原失败日志保留 |
| 首轮失败的两个文件单独重跑 | 37 / 37 通过；未改这两个文件或测试期限 |
| `vitest run --maxWorkers=4` | 293 文件、5525 项通过，3 项跳过；仅限制并发，不削弱断言或延长期限。跳过项包括显式 opt-in 的原生用例，不计自动通过 |
| `pnpm build` | 通过：协议、Cursor/relay staging、内置 Web、桌面 Renderer、Electron main/preload 与 Backend bundles |
| `pnpm build:web:hosted` | 通过；输出 `apps/web/dist-hosted` |
| `node .github/scripts/smoke-test-backend-native.mjs` | 通过：staged Koffi Worker 与 SQLite FTS5，darwin/arm64 |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs` | 通过：Electron `44.0.0` / Node `24.18.1` utilityProcess → Backend → Skills、历史索引及交接 Worker，隔离目录，正常退出 |

最终追加修复后，再运行 broker、Runtime/Web、插件、Codex 探测、local owner IPC、真实 Panel、真实 EmbeddedConversation 共 7 文件 **95 / 95**。最后再次执行 format、lint、typecheck、桌面及 hosted 构建全部通过。构建并非已安装包或真机手机验收。

## Claude 原生证据

- 实际二进制：`$HOME/.local/bin/claude`，版本输出严格 `2.1.301 (Claude Code)`。
- SHA256：`1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`。
- 原生 CLI 实际生成 `.claude-plugin/types/claude-code/index.d.ts`，SHA256：`7af2348e2aa84883bed70e532ebffbf066496101877e3ebd8ad49d7ff220a754`。实现依据本机固定声明及实际原生观察，非只据网上声明。
- 官方 `claude plugin validate ./packages/claude-bridge-plugin --strict`：0 error / 0 warning；`claude plugin test ./packages/claude-bridge-plugin`：4 / 4。
- 插件 Vitest：20 / 20，覆盖身份错误、透明 stream iterator、工具只调用一次、失序及缓冲溢出、迟到/丢失回执、未知状态不因 idle 解锁、完成证据重送、慢启动/重连不阻塞原终端及过期代际竞争。
- 原生 opt-in 命令：`AGENTKIB_CLAUDE_BRIDGE_NATIVE=1 AGENTKIB_NATIVE_BRIDGE_EVIDENCE_DIR=… pnpm --filter @agentkib/desktop exec vitest run test/claude-bridge-native.test.ts`。
- 生产路径证据：`/tmp/agentkib-claude-native-20261016-read-stop/`。`summary.json` 明确 `productionSend: experimental-disabled`、`sendContractExperiment: false`。实际原生 TUI 加载插件，通过官方 `socketPath` 配对、同 UUID/工作区流文本、原生 usage、当前 turn 取消及原 SSE 连接关闭；完整原生日志仅一个 UUID，正文可回读。
- 热重载实验先执行 `/reload-plugins`。固定版本会保留未变模块，因此再修改**隔离副本**的一行注释触发真正 hot reload；新 lease 重连，原 TUI 未退出且没有新增 provider 请求。不是假设 reload 必然更换模块。
- 发送契约证据：`/tmp/agentkib-claude-native-20261016-send-contract/`。测试仅替换临时复制模块的常量；无 Renderer、Web 或插件配置开关。实际 send 一次、重复回执不再派发、原 native turn、取消、重连和日志身份检查通过；缺少原子不排队保证，仍不开放生产发送。
- 上述两批各记录 4 个**本地合成** Messages POST；生产批包含 2 个原生标题请求及两条终端输入，发送实验批包含标题、终端 seed、实验 follow-up 和取消目标输入。标题请求不得混入未来“真实单轮”验收。本地 fixture 无上游转发实现。
- 最终生产原生批次：`/tmp/agentkib-claude-native-read-stop-isolated-final-20261016/`。HOME、USERPROFILE、XDG_CONFIG/DATA/CACHE 均指向本批私有目录，`isolatedHome: true`；证据目录 `0700`、文件 `0600`。原 UUID `ce141f67-d351-4a8a-8182-301e9f911201`。`summary.json` 的 requestCounts 为 title 2 / seed 1 / cancel 1 / followup 0 / other 0。原生生产读取/取消/重连用例通过，没有重跑发送实验。
- 最终目录保存 `raw-types/{claude-code,claude-code-mcp,claude-code-tools}/index.d.ts` 及配置，`types-manifest.json` 五项 SHA256 已独立重算一致；主声明哈希与上述固定值相同。早期日志保留，未改写成最终批次。
- 随应用 staging 的 `artifact.json`：ID `agentkib-bridge`、版本 `0.1.0`、SHA256 `0ce2da626ff36b3da89f75b907c6cb0059fd1ce24e02f0a925e38be826c2926a`；逐文件与源码字节相等，并重算清单哈希一致。分发模块的 `SEND_CONTRACT_EXPERIMENT` 仍是 `false`。

## 独立审查与修复

1. 插件权限及生命周期、回执恢复由未编写实现的子代理复核。实际复现并修复：回执 ACK 丢失不补发、迟到 stop 结果丢失、首 snapshot 前完成事件丢失、重连清空未 ACK 完成证据、缓冲溢出永久暂停与丢终止证据、session.start 等网络阻塞原终端、首次离线不再重连、临时 reconnect lease 被时钟发送及迟到响应覆盖新配对。
2. broker 保留命令/绑定/原生身份的持久关联，只重报回执及事件，不重派命令。未确认操作阻止新配对；断开同时撤销挑战。累计已撤销且无未确认操作的绑定可回收，凭据和登记读取恢复 `0700/0600`。
3. 工具过程只输出经现有脱敏的工具名及状态，不向 Web 新增原始工具输入输出；隐藏推理不进入协议。
4. UI、本机 owner、Web 权限与打包由独立子代理复核，桌面 34 项及 Web 专项 36 项通过，未发现确定 P1/P2。身份变更清理旧表单与引用，保留草稿。
5. 另修复完成事件需带共享 reducer 的 `domains`，以及来源不可用时仍可通过 owner 撤销连接；对应回归使用实际 reducer / Panel / IPC 边界。独立子代理最终复核 broker、Runtime、IPC 和真实 Panel 52 / 52 通过，未发现剩余确定 P1/P2；断开不依赖状态查询、busy 或未知结果，迟到响应仍受代际限制。
6. Codex 探测由另一子代理独立复核，最终 10 项 portable tests 通过。发现派发后未确认及 goal 两项原生覆盖缺口后，已追加定向隔离实验：真实 UDS 压下 ACK，原生同 turn 回读只有一个请求；启用 goals 后 active 运行中及 paused 的附加未增派发。追加代码/证据复核 no finding，空闲 active 前提仍明确未验收。

## 未验收边界

- 真实模型回复、真机手机、Windows/Linux 原生客户端未执行；没有借此宣称原会话发送或全部控制已开放。
- Claude 原生 API 无原子空闲门禁，本轮文本发送明确关闭；审批、问题、附件分别未开放。原终端审批/问题的等待原因经过合成协议测试，未在本轮真实 TUI 中触发审批/问答，不据此宣称原生双端处理通过。
- Codex 共享服务仍有空 thread、proxy，以及空闲 active goal 前提等具体门槛，见其独立 QA。现有 Desktop follower / managed 默认路径不变。
- 未发布安装包、未提交或推送，未替换已安装应用。

最后源码及构建身份保存在本机 `$HOME/.codex/tmp/agentkib-native-session-final-20261016/identity.json`；包含当前 dirty 文件哈希、diff 哈希、基线和构建文件哈希，QA 本身不参与其循环校验。
