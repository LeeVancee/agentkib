# Codex 原生 Plan／Goal 接入验收

本轮只实施、构建和本地验收；未部署、提交、推送或修改 VPS/TUN。保留现有工作区改动。

## 能力矩阵

| 能力 | 实现 | 原生证据 | 本轮边界 |
| --- | --- | --- | --- |
| 托管 Plan 模式目录与切换 | `collaborationMode/list`；显式下一轮 `turn/start.collaborationMode`，内外模型／强度一致，内置指令 null | 真实 0.155.1、0.158.0-alpha.2.1 隔离 fixture 通过 | 新模式只开放已支持的 0.155.1；0.158 其他基础宿主契约未完整验收，不扩白名单 |
| Plan 正文与问答 | 原生 `plan` item／`item/plan/delta` 沿用消息展示；沿用问答及 resolved 事件 | 两版原生 fixture 通过 | loopback 合成模型，不证明真实模型规划质量 |
| 模式生效与恢复 | `selected/current/applicationStatus` 区分；重启不把本地 mode 当作原生事实 | 0.155.1 resume 无模式，显式下一轮重新确认；0.158 可原生回读模式 | 无隐藏轮次，无自定义 Plan 提示词 |
| 官方会话 Plan | 精确版本 owner v2 设置通道；修正内外 model/effort 校验一致 | 真实 Desktop 26.924.22138 安全会话 default → plan → default，applied 和刷新读回通过 | 未启动轮次；不是手机／公网同步验收；竞争与运行中拒绝由桥接行为测试覆盖 |
| 托管 Goal | 原生 get/set/clear，更新不传 status；显式启动／恢复才请求 active | 原生暂停、阻塞、预算耗尽、预算变更、计数保持、恢复与清除通过 | 原生可合法返回受限状态；不新增续跑器 |
| 官方会话 Goal | 明确不可用 | 未发现可靠 follower Goal 方法 | 不通过第二个 app-server 绕过 owner |
| Plan／Goal 组合 | 待应用／未知设置阻止目标启动和恢复；已有目标更新保持状态 | runtime 行为测试 | 不发送隐藏消息使设置生效 |
| 浏览器状态同步 | 仅选中会话 SSE revision 合并重读设置／目标；保留编辑草稿并提示重新载入 | 组件及服务测试 | 无新增全会话轮询、资源重扫或自动重发 |

## 兼容与可靠性

- 新设置响应字段可选。旧浏览器权限不扩大，主机目录缺失时模式不可选。
- `goal-set.intent` 仅允许 `start/update`；缺省为旧 start。旧请求在已有目标时拒绝，防止恢复暂停目标。预算缺省保留，null 清空，不重置原生消耗。
- 暂停仅活动目标可用；paused/blocked 可恢复；budgetLimited/usageLimited 显示「尝试恢复」；complete 需清除后新建。
- 保持请求 ID、执行代次、revision 与持久回执。结果不明只核对，不自动重发；晚到 Goal 读回／回执不能覆盖较新的原生事件。
- 保存下一轮设置不声称原生已执行；运行中禁改。原生计划输出只展示，不由客户端自动执行。

## 原生验收资料

- [真实 app-server 协议 fixture](codex-native-plan-goals-2026-09-27.md) 与 [结构化结果](codex-native-plan-goals-2026-09-27.json)：两版各 13 次 loopback 请求，隔离 HOME、CODEX_HOME、TMPDIR 和工作区，不读取用户 auth。
- [真实 owner 验收](codex-native-plan-goal-owner-2026-09-27.json)：用户指定的「处理测试对话」，恢复原模式，未发送模型任务。初次发现的本地参数校验错误已修复并重测。
- 当前官方客户端原生窗口无法通过本次计算机使用工具读取，故不声称已目视确认桌面控件同步。独立 owner 回读已确认模式值。

## 本地界面检查

使用只监听 127.0.0.1 的合成 API fixture，无真实会话、凭证或文件能力。浏览器检查 Plan 保存后提示「已保存下一轮选择；发送后以 Codex 原生回读确认生效」，输入区显示「计划／下一轮」。预算受限 Goal 显示「更新目标／尝试恢复／清除」，不显示暂停；关闭弹窗焦点回到入口。检查桌面与 390×844 手机视口。

截图见 `codex-native-plan-goal-ui-2026-09-27/`。这是界面验证，不替代原生操作、公网或真机。

## 待测范围

- 真实 iPhone Safari／Android Chrome、软键盘、蜂窝切换和公网 Web → runtime → Codex 全链路。
- 官方会话手机切换后的桌面控件目视同步、真实双端同时修改、运行中由手机拒绝操作。
- 真实账户用量受限与真实模型 Plan 行为。本地 fixture 的合成结果不能替代它们。
- 当前内置 0.158 CLI 的完整托管基础契约和 writer-lock 回归；本轮只完成其 Plan／Goal 协议对比，不扩兼容白名单。

## 测试与构建

| 命令／检查 | 最终结果 |
| --- | --- |
| `pnpm --filter @agentkib/web test` | 22 文件、203 项通过（包含 WebClient 回归） |
| desktop `pnpm exec vitest run electron/main/web/{conversation-controls,codex-actions,service,lan-service}.test.ts` | 4 文件、100 项通过 |
| `cargo test -p agentkib-codex-bridge -p agentkib-runtime -- --test-threads=1` | 桥接 58 项通过；最终 runtime 164／167 项通过，3 项限时失败，见下方，不记为全绿 |
| 本次 7 项 Plan／Goal Rust 行为回归 | 最终全量运行中全部通过：下一轮模式／原生参数、预算更新、缺失能力、目标状态、迟到事件、旧 CLI 降级、Goal GET 竞态 |
| `cargo test -p agentkib-runtime --test stdio_shutdown` | 独立集成测试 1 项通过 |
| 托管专项 `cargo test -p agentkib-runtime codex_managed::tests::` | 实施阶段 34 项通过；后续全量有随机环境超时，不据此宣称全量通过 |
| `pnpm --filter @agentkib/web build:hosted` | 类型检查、托管构建通过 |
| `pnpm --filter @agentkib/desktop build:electron` | 协议生成、Rust release、同源 Web 类型检查及构建、桌面类型检查及构建、Electron main/preload 构建通过 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --arm64 --dir --publish never …` | 临时目录 ARM64 本地应用包生成通过，未签名／公证／发布 |
| `node apps/desktop/scripts/smoke-remote-package.mjs <临时包> qa/codex-native-plan-goal-package-2026-09-27.json` | 独立数据目录启动、runtime handshake、home-data-ready、内置 Web、frpc／许可证及 Rust CSR 通过，随后退出 |
| `git diff --check` | 通过 |

最终安装包记录见 [macOS 隔离冒烟](codex-native-plan-goal-package-2026-09-27.json)。包在 `/tmp/agentkib-plan-package.REDACTED/mac-arm64/AgentKib.app`，没有替换正在工作的应用。

### 全量 Rust 限制（未隐藏）

此前主体实现时 runtime 166 项全量通过；补充计划正文及 Goal GET 竞态回归后的最终套件为 167 项。本轮机器负载曾为 12 逻辑核、load average 21.00，默认并发和受限并发出现不同用例的子进程启动超时；串行重跑仍未稳定全绿。

最终失败：`antigravity_runner::tests::slow_discovery_and_attachment_share_one_web_deadline`（ACP deadline）、`codex_managed::tests::completed_turn_is_not_an_approval_resolution_acknowledgement`（fixture 创建前 `codex-version-timeout`）及 `creates_sends_and_recovers_after_restart_without_replaying`（创建未成功导致后续字段缺失）。前一次串行仅 `lost_send_receipt_is_reconciled_without_replaying_prompt` 同类版本探测超时，单独重跑已通过。失败分布及高负载支持环境时序抖动判断，尚不能以此宣布最终全量通过。

未放宽生产 3 秒版本探测超时、白名单或行为断言。fixture 将版本响应改为 Shell builtin，实际 app-server 协议仍由独立 Python 子进程提供；该调整不绕过版本校验。需要在负载稳定时重跑完整 Rust 套件，此项仍列为待验收。

### 本轮文件范围

- runtime `codex_managed.rs` 及 `codex_managed/{state,completion,tests}.rs`：原生模式、Goal 意图／预算、状态和迟到事件保护；`web.rs` 修复 follower 模型／强度参数。
- codex bridge `bridge.rs`、`compatibility.rs`、`transport_tests.rs`、`examples/probe.rs`：能力投影、精确版本检查和真实 owner 验收入口。
- Web `codex-session-controls.tsx`、两份四语言文案和组件测试；桌面 `web/service.ts` 及专项测试；WebClient 可选类型／请求传输。
- 原生 fixture、兼容说明、使用说明和本目录验收记录。未将工作区其他已有改动归为本轮实现。
