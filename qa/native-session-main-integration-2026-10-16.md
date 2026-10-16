# 原会话连接与 main 集成验证 — 2026-10-16

## 集成范围

- 原会话分支：`codex/native-session-connection`，原提交 `91eb554c6`、`c882e7f0d`。
- 合入基线：`main d6739864058d149f4084137ba647701198e86b70`，包含 UI/UX 评审修复 PR #123。
- 合并保留两个原始提交，未重写历史。Desktop / Web 的 `claude-handoff.ts` 与 `managed-tasks.tsx` 共四处冲突已经逐项融合。
- 保留原终端 follower 不进入托管交接的门限，同时保留 main 的四语禁用原因、可访问说明、关闭按钮本地化和“交还原客户端”文案。
- 其余十二个自动合并的会话源与交叉测试经独立复核，未发现确定兼容缺陷；草稿、离线编辑、IME、重复提交与绑定代际保护保持。
- 新增合并回归 11 项：Desktop 5、Web 6，覆盖过期 adopt 能力仍不能触发 follower 交接、真实 Provider/桌面适配器保留草稿且无写请求、四语管理面板隐藏不适用操作。既有负断言更新为当前实际按钮名称，避免旧标签产生假通过。

## 实际验证

使用现有 Node `22.23.2`，没有新增或升级依赖。以下统计分别来自实际独立运行，不与旧 QA 累加。

| 范围                                                                                    | 实际结果                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Desktop 会话与历史专项，11 文件，`vitest run --maxWorkers=2`                            | 201/201，0 失败、0 跳过                                                                                      |
| Web 全量，`vitest run --maxWorkers=2`                                                   | 55 文件、1089/1089，0 失败、0 跳过                                                                           |
| 后端 / Runtime / 插件 / IPC / Codex portable 专项，10 文件，`vitest run --maxWorkers=2` | 172 通过、2 个显式 opt-in 跳过、0 失败                                                                       |
| Desktop `tsc -b --pretty false`                                                         | 退出 0                                                                                                       |
| Web `tsc --noEmit --pretty false`                                                       | 退出 0                                                                                                       |
| Backend `tsc --noEmit -p packages/backend/tsconfig.json --pretty false`                 | 退出 0                                                                                                       |
| 仓库格式与 lint                                                                         | 通过；lint 0 error，保留既有 Compiler / hooks 等 warning                                                     |
| 现有构建脚本顺序展开，20 步                                                             | 全部退出 0                                                                                                   |
| Node 原生依赖 smoke                                                                     | staged Koffi、SQLite FTS5 通过，darwin/arm64                                                                 |
| Electron Worker smoke                                                                   | Electron 44.0.0 / Node 24.18.1 的真实 utilityProcess 及 Skills、历史索引、handoff Workers 通过，使用隔离目录 |

Desktop 专项包含 `DesktopConversation.integration`、`claude-bridge-panel`、composer/offline、managed-handoff-feedback、handoff display/entry、pending-center、历史 File 导航、approvals 和 transcript。后端专项包含 bridge broker、Runtime/Web、生产插件、离线 native cleanup/evidence fixture、Codex portable、managed parity、Web backend integration 与 local owner IPC。

原生环境开关显式设为 `AGENTKIB_CLAUDE_BRIDGE_NATIVE=0`、`AGENTKIB_CLAUDE_BRIDGE_SEND_EXPERIMENT=0`、`AGENTKIB_TEST_CLAUDE_RELAY=0`。两个跳过项分别要求已安装的真实 Claude CLI 和跨仓库 frp relay，不计为通过；本轮没有调用真实模型或改个人配置。

## 构建与产物

本机固定版本 pnpm shim 启动报 ENOEXEC；未修改全局 pnpm 配置或安装依赖。构建按 `build:electron` / `backend:build` 既有脚本顺序，直接调用现有 Node、tsr、tsc 和 Vite：protocol、Cursor、校验缓存 relay、Web、Desktop Renderer、Electron main/preload、Claude stage、Backend/native stage、hosted Web 及两个 smoke。relay 缓存按仓库固定 SHA 校验，无下载。生成的 protocol 与 routeTree 没有源码 diff。

- 274 个构建产物保存了大小与 SHA256 清单；清单 SHA256：`ea883d1e1cb2a17992eb21f8668c4e4b33ee927ad50b7cfea8a96eb028ca6a80`。
- Claude 插件 5 个分发文件与源码逐字节一致，重算 SHA256：`35d6d1d6d5896d2f2bfa0013085cc982a400e59b7dd2251aef3abf35229701ad`；生产发送实验开关仍为 `false`。
- Cursor 分发文件与源码匹配，frpc 固定缓存哈希和 `0.68.0` 版本核对通过。
- 构建执行时尚未创建本次合并提交，Web build-info 如实记录 `c882e7f0d`、`dirty=true`；产物来自已解决冲突的工作区，不宣称其元数据是最终提交身份，也没有发布安装包。

命令、日志、JSON 结果和产物清单保留在本地验证目录；公开 PR 只报告汇总，不上传原始会话或个人路径。原始接入、审查和真实模型证据分别保留于既有 QA，本节不改写历史结果。

## 覆盖边界

本轮没有重跑完整 Desktop 或 Skills 磁盘套件；专项通过不替代远程 CI 的完整测试。原有默认 5 秒时限未提高。未重跑真实模型、原生 CLI、运行中热加载、真实手机或 Windows/Linux 原终端连接；这些范围按原 QA 的限制保留。Claude 原会话生产发送、审批、问题和附件控制仍未开放，Codex 生产默认路径不变。

## 合并后 Windows CI 关闭竞态修复

PR #125 的合并前五项检查通过；合并提交 `44bc25a60` 的 [Windows ARM64 检查](https://github.com/starroyhq/agentkib/actions/runs/38889273035/job/116934542636) 随后失败。类型检查及原生 Worker smoke 通过，稳定性套件 933 通过、11 跳过，唯一失败为 `history-search-native-send.test.ts` 的 steer / queue-add 用例清理临时 `project` 时遇到 `EBUSY`。Windows x64、Linux 两项和主 CI 同次通过，不将合并前检查等同于合并后验证。

根因：`TypeScriptBackend.closeAsync()` 在重置阶段调用同步 `WebReadRequests.close()`，其内部丢弃托管 Codex bridge 的异步关闭结果；Backend 在原生 CLI 仍持有工作目录时就应答 shutdown 并退出。现将 WebRead 的共享异步关闭纳入 Backend 的关闭等待，待原生连接退出并释放会话租约后才重置存储。Reader 同时跟踪初始化中的会话，并等待正在收尾的 metadata 请求。

`CodexAppServerSession.close()` 改为并发调用共享完成结果，以实际 ChildProcess `close` 确认退出，不能仅凭 `exitCode` 或发出 kill 就报告完成；正常退出后清理计时器。保留原 3000ms 正常退出宽限，强杀后最多 1000ms 确认，未确认则明确失败。Runtime 外层既有 2 秒应急强制停止预算保持；本次修复覆盖正常 EOF 关闭仍未被等待的竞态，不宣称更改了无响应 CLI 的外层停止策略。

新增 9 项回归：8 项生命周期单测覆盖并发关闭、exit / stdio close 时序、同步 close、Windows Job 终止确认与失败、Reader 初始化及收尾；1 项真实隔离 Backend / CLI 进程集成测试在 EOF 后延迟 150ms 退出，要求 Runtime 停止完成后已存在退出标记。该集成测试在旧 main 构建上因标记尚不存在而失败，修复后通过。生命周期测试已加入 `test:backend:stability`，Windows / Linux CI 均执行。

本地使用现有 Node 22.23.2、现有依赖验证：

- 按 `backend:build` 既有顺序直接运行 Claude stage、Vite backend build、native stage，成功；固定 pnpm shim 的原 ENOEXEC 环境限制仍在，未安装或升级工具。
- `test:backend:stability` 的原生 smoke 与 Vitest 文件列表等价展开，`--maxWorkers=2`：33 文件、958 通过、1 个既有条件跳过、0 失败。未传 `testTimeout`，使用默认 5000ms；原用例自己的显式超时保持。
- 相邻 `managed-session-catalog`、`compaction-control`、`codex-live-state`：3 文件、83/83 通过。
- Backend / Desktop 类型检查、改动文件格式检查、`git diff --check`、lint 均退出 0；lint 保留既有 warning。

本地结果不替代 Windows 实机验证；修复 PR 的 Windows ARM64 / x64 与完整主 CI 结果以 GitHub 检查为准。未扩大测试超时、添加重试、跳过失败用例或修改个人 Agent 配置。
