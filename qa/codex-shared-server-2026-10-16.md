# Codex 共享 app-server 隔离协议验收

2026-10-16，基于 `74912da90fe2edea090efe1d673cea9f2a439663` 的 dirty 工作树。Codex 这条并行工作仅新增验证脚本、PTY 辅助程序、回归和本记录；没有接入生产控制流程，没有替换现有 Desktop follower，也没有启动、停止或修改个人 daemon。

## 身份、运行方式与证据

- macOS arm64，Node `22.23.3`，pnpm `12.10.1`；使用现有 `ws`，没有新增依赖。
- 原安装 `/opt/homebrew/Caskroom/codex/0.155.1/bin/codex`，版本输出严格为 `codex-cli 0.155.1`。SHA256：`8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e`。每批独立冻结副本并在结束时复核原安装字节。
- 每批在私有目录创建空 `HOME`、`CODEX_HOME` 和合成工作区。只启用文件凭据存储，不读取个人凭据、全局配置或历史。socket 位于短路径私有目录，原生创建的 socket 为当前用户所有、权限 `0600`。
- 一个自有 `app-server --listen unix://…`、两个协议客户端及原生 `codex resume --remote unix://… UUID` 共用执行者。退出一个客户端只关闭连接；结束和重启实验时才停止实验自己创建的服务。
- 正式复核采用先验证再执行的 OS 网络限制：只放行本地合成 Responses 服务的精确端口及本批私有 Unix socket，公网连接必须返回 `EPERM/EACCES`，否则不运行原生轮次。
- Responses fixture 不具备上游转发实现。固定虚拟模型 `gpt-5.6-terra` 来自该二进制 bundled catalog，仅用于协议数据。真实模型请求为 **0**；这里的“原生通过”不表示真实模型回复通过。
- 证据根：`$HOME/.codex/tmp/codex-shared-probe-20261016-14/`。保存精确 runner/PTY 源码、二进制、help、stable/experimental schema、命令/隔离环境、原始 RPC/HTTP、原生 TUI 输出、结果及 SHA256 清单。此前各批目录保留。
- 最终批次为 12:59:12–12:59:37（Asia/Taipei）：**11 项通过、2 项阻塞、真实单轮未执行**，14 个本地合成 POST。另外逐文件重算 772 项证据哈希全部一致；runner SHA256 为 `8fd1ea966ac0e2eeb31f62f748a3197e6db376b7846e7afa65046b9a3889c4aa`，PTY 辅助程序为 `6ce9f6e9204e8c82d0bad8ef8a9661c9bd1b290561a5212f63b59e7a1217f09c`。两个自有 server PID `40456`、`41637` 及 TUI 已结束，原安装哈希不变。

实际命令：

```sh
node apps/desktop/scripts/verify-codex-shared-server.mjs \
  --codex /opt/homebrew/bin/codex \
  --evidence-dir "$HOME/.codex/tmp/codex-shared-probe-20261016-14"
pnpm --filter @agentkib/desktop exec vitest run test/codex-shared-server.test.ts
pnpm exec oxfmt --check apps/desktop/scripts/verify-codex-shared-server.mjs apps/desktop/test/codex-shared-server.test.ts
node --check apps/desktop/scripts/verify-codex-shared-server.mjs
```

## 当前结果

| 项目 | 结果与证据范围 |
| --- | --- |
| 同一个已持久化 thread | 通过；第二连接 resume 同 UUID，loaded 集合中身份唯一，模型、provider、工作区、审批策略和 sandbox 保持一致 |
| 双端流式 | 通过；两连接收到同 turn 的完整、完全一致的增量正文，只有一个合成 POST |
| 跨连接取消 | 通过；另一连接 interrupt，双方得到同一个 `interrupted` 终态，没有第二个推理请求 |
| 发起连接断线 | 通过；另一订阅者继续收到完成，新连接可恢复原 UUID，不重发 |
| 跨连接审批与问答 | 通过；原生请求广播到两连接，第二连接作答，双方收到 `serverRequest/resolved`；审批选择拒绝，原生 command item 为 `declined` |
| 已处理表单重复作答 | 通过；旧回答不触发额外请求或第二轮执行 |
| 待审批时发起者断线 | 通过；另一订阅者可以处理原审批并完成 |
| 待审批的所有订阅者断线 | 通过；fresh 连接 resume 收到原 request ID 的待审批请求，可以处理并完成；没有重跑工具请求 |
| 原生 TUI 双向交互 | 通过；完整历史可读；协议端新回复出现在 TUI；TUI 实际发送的新提示和回复同步到协议端，同 UUID，两方向共两个预期合成 POST |
| 自有服务重启及只读回读 | 通过；停止自有服务并确认退出，再启动同一隔离数据目录的服务。完整 turns 精确相等，原 UUID 恢复，没有新增推理请求 |
| 无首条消息的空 thread | 阻塞；第二连接 `thread/resume` 返回 `no rollout found for thread id …`。不通过调用模型补齐空历史；首条消息由用户产生、持久化之后才可按已验证路径连接 |
| `app-server proxy --sock` | 未验收通过；Node stdio 管道中 initialize 在 15 秒内没有回包。它有真实 help 支持，但本次不把它当作已通过的接入路径，也未证明其失败根因 |
| 真实模型、个人现有 daemon、Desktop/Web 产品接入 | 未执行，不从本次协议结果外推 |

原生 TUI 的两条提示使用精确请求匹配。预先给合成 thread 设置原生标题，避免 TUI 自行生成标题。输入采用“粘贴 → 观察文本 → Enter → 原生事件”，不靠固定睡眠推进。

## 回归、失败与限制

- 回归 **9 项通过**：已派发请求断线/超时不重发，迟到响应，旧轮次事件隔离，借用连接只断线且重复关闭幂等，Unicode 与最终正文一致，非预期请求拒绝，标题请求不消费用户回复，以及真实 Unix HTTP Upgrade/重连。Unix 用例在 Windows 明确跳过；未执行 Windows/Linux 原生客户端验收。
- 上述 `oxfmt --check`、Node 语法检查、PTY Python AST 检查均通过。脚本退出 0 表示成功记录各项结果，不能解释为阻塞项通过或真实模型验收通过。
- 固定 `0.155.1` 拒绝 `ws` 默认提供的 `sec-websocket-extensions`。早期批次的 `socket hang up` 已由原生日志定位；关闭 `perMessageDeflate` 后握手通过，回归确认没有发送该扩展头。早期超时不是已经证明的钥匙串故障。
- 早期 TUI 使用虚拟 `gpt-5.4` 时出现原生退役弹窗，继续保留该批失败。后续新批次从一开始就固定为 bundled catalog 中有效的虚拟 `gpt-5.6-terra`，没有切换真实模型。另一次完整隔离 config 被原生拒绝为 remote resume 不支持权限覆盖；当前 TUI 不传这些覆盖。
- 原生 TUI 会为未命名 thread 发起模型标题请求。早期仅本地 fixture 的一次标题请求消耗了原定回复，已保留原始 HTTP 证据；不能把这种请求混入以后“真实单轮”验收。当前预设标题并校验精确提示。
- 早期网络 profile 的宽泛 local-ip 放行未通过外连断言，不能宣称这些早期实验完全禁网；所有推理仍指向无转发实现的本地 fixture。一次定位诊断的空 HOME、无 sandbox 启动尝试了匿名插件目录请求并收到 401，未读取个人凭据、未发送推理。正式复核强制先通过外连阻断。
- stable/experimental schema 来自同一固定二进制。最新官方文档出现但本机 help 不存在的 flag 不纳入假设；daemon bootstrap/start/update/remote-control 均没有执行。

## 补充：回执丢失与启用的 goal

独立审查指出原第 14 批的“发起连接断线”发生在收到 ACK 和 delta 之后，不能覆盖回执丢失；该批还显式关闭了 goals，不能证明 goal 附加行为。原批次及以上结果保持不变，新增 `--mode recovery-only` 只运行定向检查，没有重复原 14 POST 全量批次，也没有修改生产 adapter。

```sh
node apps/desktop/scripts/verify-codex-shared-server.mjs \
  --codex /opt/homebrew/bin/codex \
  --evidence-dir "$HOME/.codex/tmp/codex-shared-recovery-20261016-02" \
  --mode recovery-only
pnpm --filter @agentkib/desktop exec vitest run test/codex-shared-server.test.ts
```

使用相同 `0.155.1` 二进制及网络隔离，显式启用 `features.goals=true`。最终定向批次为 13:13:15–13:13:23（Asia/Taipei），自有 server PID `33598` 已退出，安装字节保持不变。只有 **3 个本地合成 POST**：持久化 seed、丢失 ACK 的用户轮次、显式激活 goal 产生的自动轮次。真实模型请求 **0**。

| 检查 | 结果及精确范围 |
| --- | --- |
| `turn/start` 写出但未收到 ACK 即断线 | 通过；私有 UDS 故障代理向真实 server 转发一次，在原生成功 ACK 返回时丢弃 ACK 并断开发起连接，任何本轮 delta 同样未交付。不是先等待应用收到 ACK 或 delta 再断线。观察连接按原 thread/turn 读到唯一 `inProgress` 轮次，完成后 fresh 连接 resume 回读完整正文；原轮只产生一个 POST、一个新 turn，未再次发送 `turn/start` |
| 已运行的 active goal，loaded/list 与既有／fresh resume | 通过；使用公开 `thread/goal/set(active)` 后等待它的原生续轮进入持有中的流式状态，再附加连接。goal 仍为 active，同一个 turn 仍在运行，显式 3 秒观察期内没有新增 turn 或 POST。此结论仅覆盖运行中的 active goal |
| paused goal，loaded/list 与既有／fresh resume | 通过；3 秒观察期内 goal 对象全部字段精确相等，没有 turn 或 POST；goals 功能保持启用 |
| 空闲 active goal 附加 | **未验收**；公开 `thread/goal/set(active)` 本身立即启动自动续轮，未能建立空闲 active goal 前提。本机生成的 `ThreadResumeParams` 未提供专门延后 goal continuation 的字段，不能从运行／暂停状态外推，也不能关闭 goals 后冒充通过 |

定向第 1 批 `$HOME/.codex/tmp/codex-shared-recovery-20261016-01/` 保留：丢失 ACK 已通过，但激活 goal 时没有预先排入合成回复，fixture 将该自动 POST 拒绝为 `403 No synthetic case admitted`，原生 goal 进入 blocked；此为离线探测失败证据，不是供应商或真实模型失败。第 2 批是新的隔离数据、thread 和操作，在开始前就为显式 goal 激活安排持有的合成回复。检查附加后先显式暂停 goal，再完成该合成轮并清除隔离 goal，避免自动继续。

证据目录保存 proxy 双向帧、被压下的 ACK、发起端未收到 ACK/delta 的帧、观察／fresh 客户端读回结果、goal 事件、HTTP 请求、精确配置和 schema。独立 Python 进程逐文件重算哈希：原第 14 批 772 项、定向第 1 批 767 项、第 2 批 769 项均一致。原第 14 批 manifest SHA256 为 `3062bea804a76b9ada299978c2ae5380d39c519a2827c33af1ab022003ce38ca`，原 runner 哈希保持上文值；定向第 2 批 manifest 为 `267d43af44b969d6ba7df1aa07a87ccde922440f831abc5c91259660cb331d78`，其冻结 runner 为 `b7c1ccf1633ce5e53613539593613b33f223199dd533b788e0d5af919ff986c2`。`schema-experimental/v2/ThreadResumeParams.json` 哈希为 `5ebc2fe61b33d85dd6dfa81acf88f632fe2bafe4aa83ff57ee58e866f14d49ac`。

新增实际 Unix transport 故障代理回归，确认正常 initialize 可转发、被选中的原生 ACK/delta 不会交付，且 `turn/start` 只转发一次；当前回归合计 **10 项通过**。格式检查及 Node 语法检查通过。公开 goal 方法与语义对照已打开的 [OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 和 [Goals 说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)，行为结论以本机固定版本的实际帧和请求计数为准。

## 产品结论

官方共享 app-server 已有本机原生多客户端可行性证据，能承载同一会话的流式、取消、审批、问答及断线恢复。当前证明的是**显式连接该服务的原生 TUI**，并非任意已经启动的独立 CLI 或 Codex Desktop 会话。

生产接入仍须增加受验证的服务发现/peer/版本/工作区绑定、借用服务生命周期以及现有持久回执衔接，才能把能力开放到 AgentKib 桌面/Web。保留既有 Desktop follower，不能在连接失败时静默另启执行者，也不能因同 UUID 就推定执行归属相同。[官方协议](https://learn.chatgpt.com/docs/app-server)、[官方 CLI 参考](https://learn.chatgpt.com/docs/cli/reference)。
