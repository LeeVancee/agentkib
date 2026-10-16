# Claude 审查问题修复 — 2026-10-15

## 源码与范围

- 本次修复基于本地 `main` 的 `bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`。此前审查固定基线为 `origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`，受审提交止于 `43a7746c5b7c94ad1af45cd5e23a1660bcdd3137`；后续 remote HTTPS 提交不属于本轮修复范围。
- 开始时已有 24 个跟踪文件修改，以及 `.agents/`、`prototypes/`、Claude import probe 测试等未跟踪内容。先记录这 24 个文件的 SHA256 和完整补丁，保留已有工作；其中已有的 4 项 P2 补丁经复现与回归确认，没有重写为另一套实现。
- 工具链为 Node `22.23.3`、pnpm `12.10.1`，macOS arm64；Electron Worker 验证使用锁文件的 Electron `44.0.0` / Node `24.18.1`。
- 未提交、推送、部署、调用真实模型或修改个人 Agent 配置；没有新增依赖、数据库结构或公共协议。

## 修复内容与触发条件

1. **失败输出不能解除待核对状态。** 同一 stdout 块排入多帧，前一帧失败后，后续成功帧曾将 `outcome-unknown` 改回可发送。现在在实际消费帧及异步初始化返回时核对所属进程和终止状态；取消、退休或旧进程迟到事件不能修改替代进程，也不能重复产生完成回执。三种原触发序列修复前均失败，修复后保持未知状态并拒绝第二次发送。
2. **个人 Claude 内容不通过其他 Agent 的 MCP 入口泄漏。** 保留路径别名、真实路径及逐层导入检查。复核额外发现检查与打开之间的替换窗口，新增已确认路径、实际文件描述符与读取前后身份核对；覆盖叶文件、父目录、打开后换回和读中修改，并保持合法已解析链接及 macOS 大小写文件名可读。配置读取使用同一受检入口，防止 OpenCode/Grok/Antigravity 等配置中的私人路径进入 MCP 提示；Cursor 规则及 DeepSeek profile 的读取边界也已核对。通用文件读取函数不变，`default-manifest` 只为 Context 增加可选 reader。
3. **原生导入回读检查全部消息。** 拒绝缺失或空的消息对象、缺失正文、角色不一致和完整读取器跳过的记录；有效 Unicode、连续角色、工具及附件继续通过。完整回读后再核对原始快照字节、文件身份、大小和修改时间，避免规范化 turns 相同掩盖实际角色变化。损坏或变化时不启动终端。
4. **观察性任务通知不使表单过期。** 不改变可操作状态的子任务或未追踪任务通知，不递增审批/问题 revision；真实执行状态变化仍执行原校验。
5. **Doctor 不用项目外正文满足项目要求。** 禁用外部来源时保持外部导入未展开，项目自身缺失的规则仍报告；打开前路径替换也不能把外部正文标为项目内容。

这些读取核对不提供跨进程原子锁或文件系统快照，不承诺在最后一次核对后阻止外部进程修改文件。

## 验证记录

针对性验证均使用合成文件、临时配置及模拟 CLI，没有模型调用：

| 验证 | 结果 |
| --- | --- |
| Claude 执行帧、审批/问题与进程邻接回归 | 6 文件、248 项通过 |
| 原生回读、导入、probe、compaction 回归 | 5 文件、152 项通过，其中回读 38 项 |
| Context 最终回归 | 14 文件、456 项通过；新增 16 项读取竞态/兼容测试 |
| 最终 `pnpm format:check`、`pnpm lint`、`pnpm typecheck` | 通过；lint 保留既有警告 |
| 最终 `pnpm test` | 桌面 257 文件、4704 通过、2 条件跳过；Web 37 文件、765 通过 |
| 最终 `pnpm build`、`pnpm build:web:hosted` | 通过 |
| 最终 `node apps/desktop/scripts/run-backend-worker-smoke.mjs` | Electron utilityProcess 中内容索引/查询、Skills 和交接读取 Worker 均通过 |
| `git diff --check` | 通过 |

桌面条件跳过仍为 Windows 专用 native error，以及未开启真实 broker/frp relay 的用例；没有为本轮修复放宽断言或增加跳过。最终命令顺序运行，退出码为 0；中断对话后收取原进程结果，没有将未完成命令视为通过。

## 独立复核

- 执行帧修复独立复核为 **no findings**；额外合成探针验证 96 帧背压恢复、旧进程迟到事件、退休后替代进程及第三进程正常完成，没有重复回执。
- 原生回读修复独立复核为 **no findings**；多块 Unicode 正常通过，同字节长度角色变化、probe 后角色修改和同内容新 inode 替换均被拒绝。
- Context 首轮复核发现正文读取时序漏洞，后续复核又发现 OpenCode 配置路径泄漏，均修复并留下红绿证据。最后按规范和需求两维复核均为 **no findings**；OpenCode 全局/项目配置的父目录短暂替换不再读取个人字节或泄漏路径，合法非个人配置链接仍可用。

审查结论限于本轮修复及其相关读取/执行链路，不代表其他已有未提交内容经过全量重新审计。

## 证据与限制

本机临时证据可能被系统清理；本文为验收摘要，不代替原始日志：

- `/tmp/agentkib-review-fixes-20261015-pek6mh4y/`：开始修复时的工作区备份、文件身份及补丁。
- `/tmp/agentkib-review-fixes-source-20261015.json`：本轮修改相对修复开始状态的文件 SHA256。
- `/tmp/agentkib-claude-queued-red-20261015.log`、`agentkib-claude-frame-fixes-20261015.log`：队列失败修复前后结果。
- `/tmp/agentkib-claude-frame-review-probe-20261015.cjs`：独立背压、退休及旧进程迟到事件探针。
- `/tmp/agentkib-native-readback-red-green-20261015.cjs`：原生回读修复前后比较。
- `/tmp/agentkib-context-read-races-red-20261015.log`、`agentkib-context-read-deepseek-red-20261015.log`、`agentkib-context-read-races-final-20261015.log`：正文读取竞态修复前后证据。
- `/tmp/agentkib-context-config-races-red-20261015.log`、`agentkib-context-config-races-green-20261015.log`：配置竞态修复前后证据，新增 6 组中修复前 5 组失败，修复后均通过。
- `/tmp/agentkib-review-fixes-final-validation-20261015.log`：第一阶段全仓检查、测试、构建和 Electron Worker 结果。
- `/tmp/agentkib-review-fixes-final-config-validation-20261015.log`：包含配置追加修复的最终完整验证结果。

本轮未做真实 CLI 模型回复、个人钥匙串登录、Windows/Linux 实机、手机、签名安装包或自动更新验收，不将合成回归描述为这些能力已通过。
