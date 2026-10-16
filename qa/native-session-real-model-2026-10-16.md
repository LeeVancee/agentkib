# 原会话连接：真实模型补验 — 2026-10-16

## 源码与执行边界

- 源码提交：`91eb554c6c073da04bb14a76d09ffb82705dfb5c`，分支 `codex/native-session-connection`；本轮开始时工作树干净。主目录已有改动未动。
- 真实验收发现并修复了取消回执缺陷，验收时的最终候选为上述提交加本轮未提交修复。B1 的生产文件前后哈希记录见下文；后续提交不改变这些验收身份，也不把它写成原提交的验收结果。
- macOS arm64，Node `22.23.3`、pnpm `12.10.1`。本轮使用用户授权的 `claude-haiku-5-5` 与 `gpt-6-luna`，每例单轮，不自动重试或切换模型。
- 每例使用新的隔离数据、会话和操作身份。原生客户端沿用现有官方授权；没有把凭据复制到其他 Agent 配置，没有修改全局模型或安装。
- 本机转发器在转发前核对精确模型和本轮提示，并消费最多一次上游 POST 的额度；连接、配对和只读恢复不得消费模型请求。请求头只在内存转发，不写入证据。非预期标题或后台推理请求本地拒绝。
- 本记录补充真实模型结果，不改写此前合成协议测试、失败证据或能力门限。验收期间没有提交、推送、发布或替换安装应用；验收后按用户明确授权提交修复与本记录。

## Claude：首个在线批次（保留失败）

固定 Claude Code `2.1.301`，二进制 SHA256 `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`。使用未经修改的生产插件 `agentkib-bridge 0.1.0`，对应构建产物哈希 `35d6d1d6d5896d2f2bfa0013085cc982a400e59b7dd2251aef3abf35229701ad`。

真实原生 TUI 恢复本批新 UUID 的合成历史，主动运行插件连接命令。另一端为真实 `TypeScriptBackend`、`BackendStore`、`ConversationHub` 与配对后的 `WebAccessService`；不是假 plugin HTTP 端，也没有 mock 控制实现。生产 `send=false` 门限保持，提示从原终端输入。

| 检查                     | 结果                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不调用模型的连接         | 通过。原生 resume、生产插件配对、owner 及 Web SSE 订阅可用，来源 UUID 一致，真实请求为 0。                                                                                                                                                                       |
| A 真实模型与上下文       | 上游通过。唯一一次官方 POST 返回 HTTP 200，实际模型为 `claude-haiku-5-5`；离线解压原始响应后，随机标记和完整项目决策均正确，`end_turn`、`message_stop` 完整，无工具调用。                                                                                        |
| A CLI → Backend/Web 正文 | **未通过**。验收转发器遗漏 `Content-Encoding: gzip`，将压缩字节按普通 SSE 交给原生 CLI，触发 `Stream ended without receiving any events`；owner/Web 没有收到正文。属于本次私有验收工具错误，不是已证明的模型或生产插件回归。不能以上游回复正确替代产品链路通过。 |
| B Web 取消               | 未执行。A 的在线链路失败后停止，没有自动重试、改模型或执行后续取消用例。                                                                                                                                                                                         |

A 官方用量分别为：`input_tokens=2`、`cache_creation_input_tokens=833`（1 小时）、`cache_read_input_tokens=0`、`output_tokens=80`、`thinking_tokens=0`。输入含缓存创建部分，不能写成“总输入只有 2 tokens”。

证据在 `$HOME/.codex/tmp/agentkib-claude-real-chain-20261016/`：

- `prepare-1792135383912-cda0295a/`：最后零模型准备检查通过，完整全局文件哈希一致、CLI/插件哈希一致、原生及 Python 进程均退出。
- `A-1792135434582-a77106ab/`：输入确认断言未适配 ANSI 排版，未按 Enter，0 POST；作为未派发的失败记录保留。
- `A-1792135509961-8b772b5c/`：唯一真实 A。原始失败结果保留，另增 `offline-provider-response-audit.json`，不把旧失败改成通过。原始 gzip 响应 955 字节，SHA256 `487385d4216ceedb563c8fdbf21f74491010d8db184fb54a9222b1603c1ba043`；解压后 SSE SHA256 `cb5d317af84c7875352416260667178e3d21e60f05aa4fc769669a458a70a91f`。

早期零模型 prepare 被首次 auto-mode 推介遮挡，均未消费真实请求。固定二进制确认该推介的已读状态为 `hasSeenAutoDefaultNudge`；仅在隔离配置中记录已读，保持手动权限与空工具集，没有修改个人权限设置。未以 `skipAutoPermissionPrompt` 代替这项状态。

原生登录通过 CLI 自己的默认 securestorage 服务使用现有 OAuth；普通配置和历史指向隔离 `CLAUDE_CONFIG_DIR`。实际 CLI 受 OS 文件写保护，个人 HOME 的本批目录之外写入被拒绝；离线对照已确认受保护目录不可写、本批目录可写。没有读取或复制 Keychain 凭据值，故也不宣称已逐字节核对 Keychain。真实 A 的个人 settings、文件凭据及全局状态哈希均未变化，原生/Python 进程和 Backend/Web 清理通过。

早期 prepare 期间一次全局状态哈希不同。与匹配原始哈希的原生备份只读比较，仅 `cachedUsageUtilization`、`promptQueueUseCount` 变化；同时存在其他活跃 Claude 进程，无法独断归因测试。没有回写或停止这些进程。验收曾产生的完整个人状态临时副本已删除，改为 key 路径、类型及值哈希摘要，不把个人配置放入提交或共享证据。

原会话远程发送、审批、问答和附件没有因此开放；真实浏览器界面、真机手机、Windows/Linux 均未验收。这里的 Web 结果指实际本机服务和授权/SSE 边界，不能表述为完整浏览器界面已通过。

### 修正验收工具与离线验证

私有转发器已透传 `Content-Encoding`，审计分支单独解压并用 UTF-8 流解码器、CRLF/LF 帧边界读取 SSE，继续保留收到的原始字节。没有修改生产 Backend 或插件来迎合测试。

最终离线批次 `synthetic-gzip-1792136010598-4135b9cb/` 通过：合成 gzip 按 1/2/7/13/31 字节碎片发送，包含 CRLF、中文、emoji 和组合字符；原生 CLI、生产插件、owner/Web 同一 turn 的累计正文与 provider 文本哈希一致，新助手 UUID 的原生全文及两端回读也一致。原终端观察到撤销后，同 UUID 重新配对通过。上游请求和真实模型调用均为 0，身份、配置和清理通过。

立即重配对的早期离线失败保留：Backend 撤销后插件需通过后续 poll 观察撤销，本地尚显示 connected 时立即粘贴新连接指令会被拒绝。最终用例等待原生 `/agentkib-status` 报告已断开再连接，不靠固定睡眠，也不绕过 connected 门禁。

修正后的在线 runner SHA256 为 `2f7ebcc6172343e68cd1e2b4354326f1a8676e92a5019ab7a464993cc2db385b`。用户随后明确授权新的完整回复与取消用例各一轮；原始 A 失败不改写为通过。

### 新授权的 A2：真实流式与同一轮次只读恢复

新批次 `A2-1792136047570-3f665ca0/` 仅发送一次真实 POST，HTTP 200、实际模型 `claude-haiku-5-5`、正常 `end_turn`。随机标记和完整项目决策正确。owner、Web 和上游回复属于同一个原生 turn，完整正文 SHA256 均为 `f4560d4a41bea86fe6107a7838513b1d1e215e7e971b249cf17ea96ecc890d64`，两端最终状态均为 idle。

原 A2 runner 随后在 idle 后立即同步读取原生日志，只读到 seed，触发断言并退出；该失败结果保持不变。原生文件在异步写入完成后出现了新助手记录。没有为此重新发送提示，而是增加同批数据的零模型补证 `A2-readonly-recovery-1792136218481/`：

- 沿用原 Backend 数据、host、Claude 配置和原生 UUID，重启 Backend 与原生 CLI；没有生成新用户轮次。
- 新助手 UUID `62a53205-cc12-4590-9325-adab438f8171` 的原生日志正文与原上游 SHA256 完全相等，owner/Web 按该记录身份精确回读通过。
- 原生 status 确认断开后，同 UUID 重配对通过，原终端在断桥期间存活；本次补证的上游请求及模型调用均为 0。
- 两批个人配置哈希、CLI/生产插件身份和进程清理均通过。

因此 A2 的真实流式、完整上下文及恢复由在线证据与同一轮次的只读补证共同成立；不能声称原 A2 runner 一次完整通过。生产历史订阅会继续轮询原生文件，不能把 turn 结束当作日志同步落盘保证。

A2 官方用量：`input_tokens=2`、`cache_creation_input_tokens=827`（1 小时）、`cache_read_input_tokens=0`、`output_tokens=68`、`thinking_tokens=0`。截止此批，Claude 合计 2 次真实 POST（原 A 与新 A2），没有重试任何已消费请求。

### 取消回执修复与 B1 真实验收

独立核验确认：stop ACK 先到时，原实现先把请求持久化为 accepted、completed=false；随后 aborted 事件只补未确认请求，因此该回执永远缺少完成证据。另一个顺序中，普通完成也可能被当作取消完成。

本轮最小修复只涉及 `claude-bridge.ts` 与 `managed-ledger.ts`：按 binding、原生会话、工作区及 turn 精确关联真实 aborted 事件，原子补记同一请求完成；保留原始 ACK、设备、指纹及其他身份，不重复派发。区分正常完成与 aborted；正常结束不能证明取消成功。没有增加数据库表、公共协议或生产依赖，生产插件、revision 门限和发送能力保持不变。

新增 6 个 broker 回归覆盖两种事件顺序、重复、重启、错误 turn/native/binding、正常完成反例及原身份不变；另有生产插件持续正文流后取消、重复 command 不重复 abort 的反证回归。未证实原生可达性的手工重复 `session.start` 场景只保留私有调查记录，没有据此修改生产代码或宣称确定缺陷。

修复后的 held/continuous 合成 gzip 取消先分别通过：`synthetic-cancel-1792136735616-53492a21/`、`synthetic-cancel-1792136817821-cf090e08/`。均为真实原生 CLI、生产插件、Backend/Web，真实上游为 0；持续流为 13 个 chunk。实际取消证据使用上游 message ID 对应的原生助手记录 `isAbortedMidStream=true`，不假设固定终端提示文字，也不只凭 idle 判断。

最终 B1 从冻结目录 `frozen-B1-1792137238225/` 执行，runner SHA256 `8c9ce4bd95bbc31bd871495e4875a80727530b664e6ae9ea2ccbb22f9a68415b`；结果在其 `B1-1792137275631-10e64acb/`。**通过**：

- 唯一一次真实 POST 返回 HTTP 200，实际模型 `claude-haiku-5-5`，没有额外本地请求或重试。
- owner/Web 观察同一 turn。首个真实增量后由 Web 取消，45 字符的上游前缀、两端累计正文及原生助手正文精确相等；原生 message ID 一致，`isAbortedMidStream=true`，无工具执行。
- 上下游在响应完成前关闭；重复同一 request ID 返回相同完成回执。直接只读 SQLite 核验恰好 1 行 resolved、accepted/completed=true，`completionObserved=true`，绑定原生及 turn 身份正确。
- 原 TUI 存活；全局配置哈希、生产文件前后哈希一致，最后仅清理自有进程，无残留。

B1 没有最终 usage；初始 usage 的 input=2、cache_creation=840、output=1 仅为流开始信息，**不当作最终用量**。主动取消后的 gzip/SSE 未正常结束及 observer 断流错误属于预期现象，不能写成供应商失败或触发重试。

B1 运行时及最终候选源码 SHA256：

| 文件                                     | SHA256                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `packages/backend/src/claude-bridge.ts`  | `27f392269ab124bf0826e2c358f1fee769d52f9ac8d0c6b40fd3f8de7d03c994` |
| `packages/backend/src/managed-ledger.ts` | `eee96513bd27e6c4eb4bce3abeff1aa2e71f313ef93c227f61bd6b06503a9d6e` |
| 未改的生产插件 `hooks/register.js`       | `9bf333aa79058502e9522b73b495407afa28cd9bc52204397513d7b6a04d8a26` |

最终源码另做 A2 的零模型恢复补验 `A2-readonly-recovery-1792137240393/`：相同 native/assistant 身份、owner/Web 精确回读、Backend/CLI 重启及断桥后重配对通过，0 POST、0 新用户轮次；生产文件前后哈希与最终候选一致。该结果补足修复后源码的只读恢复，不重跑 A2 模型。

累计真实请求为 **5 次**：Claude 原 A、A2、B1 各一次，Codex 完整回复、取消各一次。Claude 原 A 的转发器失败仍保留；A2/B1 是用户重新明确授权的新用例。没有自动重试或切换模型。

Claude 最终私有证据清单 `evidence-manifest-final-20261016.json` 共 65 项，主代理与独立子代理逐文件核对无差异，清单 SHA256 `6e7746ca58b2fce54fbd65528fb7dfac9c142be16df9360c32375f81b1246b8a`。清单排除运行凭据、数据库及完整个人状态。旧 pre-B 清单中的两个工作 runner 后续改过，不能宣称该旧清单仍全部匹配；实际执行的冻结副本另行保留，旧清单和旧失败不改写。

## Codex：共享 app-server

使用固定 CLI `0.155.1`，二进制 SHA256 `8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e`。一个隔离 app-server、两个 RPC 客户端及原生 `codex resume --remote unix://… UUID` 连接同一执行者；推理由原生 TUI 发起，两个 RPC 客户端没有发送 `turn/start`。

| 用例       | 结果                                                                                                                                                                                                                                                                                          | 真实请求 / 模型 / 用量                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A 完整回复 | 通过。随机标记与项目决策仅放在原线程的初始指令中；真实回复准确引用两者。双 RPC 的完整增量正文相等，TUI 可见同一正文，原生历史只有一个 turn。停止自有服务后以相同隔离数据重启，原 UUID 和完整 turns 精确恢复，未重发。                                                                         | 1 POST；响应模型 `gpt-6-luna`；输入 7459、输出 21、合计 7480 tokens。                   |
| B 跨端取消 | 通过。新线程中原生 TUI 发起另一单轮，两 RPC 收到首个真实增量后，由第二 RPC interrupt 同一 turn；双方终态为 `interrupted`，TUI 显示 `Conversation interrupted`。下游关闭时转发器关闭自有上游连接；重启只读恢复同一轮次，不重发。未完成的助手片段没有进入原生持久历史，不能宣称其正文也已恢复。 | 1 POST；原始 `response.created.model` 为 `gpt-6-luna`。取消前没有最终 usage，保持未知。 |

两例均没有历史或新工具执行。连接、命名空 thread 和附加客户端不调用模型：本次先用原生 `thread/name/set` 持久化空 thread，第二客户端随后可恢复；此前未命名空 thread 的失败证据仍保持原结论，不外推所有空会话都可附加。

正常配置不提供可靠的全链路单次限制，因此在隔离进程里使用 retry=0 的私有 provider 指向本机转发器，保留原生 OAuth 请求头和 Responses 正文。转发器固定连接官方 Codex Responses 入口，不跟随重定向、不重试。原生进程的 OS 网络限制只允许本机精确端口及本批 Unix socket。个人 auth 使用只读符号引用，原生进程不能写个人目录；引用在验收结束后移除。个人 auth、config 和二进制前后哈希一致。

证据目录（私有本机，原始合成正文和诊断分开保存）：

- `$HOME/.codex/tmp/codex-real-luna6-20261016-complete-01/`
- `$HOME/.codex/tmp/codex-real-luna6-20261016-cancel-01/`

两例原始清单各 11 个文件，主代理和独立子代理逐文件核验均无差异。清单 SHA256 分别为 `70e502aff87539ba2a0aba8a7c07727d1df7e5c54dd16d8235c6620e51064f8f`、`85b4b7bdee80e3b4ac8b683ea97681721d5a7c507bc46b99c9954fa67989821f`。新增审计记录不改写原始清单或结果。

清理限制：A 的 PTY 辅助程序退出时先发生 3 秒等待超时，再发生 `killpg` 的 `PermissionError`；原 runner 只等待 close，没有检查非零退出码，所以不能把其 overall passed 解释为清理全程通过。原日志保留。事后按两个隔离 root/socket/线程身份检查，没有对应自有 TUI 或 app-server 进程残留，Unix 打开句柄为 0，个人 daemon 未被操作。B 仅保留无监听的 socket 节点。该异常不否定已保存的回复、同轮流式和重启回读证据。

新增清理审计在 `$HOME/.codex/tmp/codex-real-luna6-20261016-cleanup-audit/`，清单 SHA256 `9d5437b8edd6ecfdc0a5906e6003f742c245cec1a4f0d2e0d9e3915c948b5ec1`。普通及同 sandbox 的无推理进程组清理对照都正常，尚未证明原 EPERM 的底层原因；A 未保存具体子 PID/退出码，不能倒推当时清理全程成功。没有为此重跑真实请求。

实际在线命令：

```sh
node "$HOME/.codex/tmp/codex-real-luna6-20261016-runner/run.mjs" \
  --execute-real \
  --evidence="$HOME/.codex/tmp/codex-real-luna6-20261016-complete-01"
node "$HOME/.codex/tmp/codex-real-luna6-20261016-runner/run.mjs" \
  --execute-real --case=cancel \
  --evidence="$HOME/.codex/tmp/codex-real-luna6-20261016-cancel-01"
```

runner 和配置分别冻结在两例证据内；上述开关仅用于这次已获授权的手动验收，不是日常测试或自动重跑入口。

这两例证明固定版本的共享 app-server 原生协议/TUI 链路，**不表示已接入 AgentKib 的生产 Codex 控制入口**。审批、问答及 goal 行为仍参考[此前合成协议验收](codex-shared-server-2026-10-16.md)，本轮没有用真实模型重复这些用例。

## 自动化回归

在上述源码和工具链执行：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  test/claude-bridge.test.ts \
  test/claude-bridge-runtime.test.ts \
  test/claude-bridge-plugin.test.ts \
  test/codex-shared-server.test.ts
```

以上首轮 4 文件、**85 项通过**。修复后的实际验证另列如下，不相加成独立测试总数：

| 检查                                                                | 结果                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| broker、Runtime/Web、managed parity、Claude Web backend integration | 93 通过，1 个既有真实 relay opt-in 用例按开关跳过                                 |
| 最终插件、broker、Runtime/Web                                       | 76 / 76 通过，包含新增持续文本取消回归                                            |
| 独立子代理复核 broker                                               | 34 / 34 通过；修复静态复核未发现新的确认问题                                      |
| `pnpm format:check`、`pnpm lint`                                    | 通过；保留既有 warning，没有关规则                                                |
| `pnpm typecheck`                                                    | Backend、桌面和 Web 通过；路由生成器仍有既有 circular-dependency warning          |
| `pnpm build`、`pnpm build:web:hosted`                               | 通过；没有生成或安装发布包                                                        |
| `node .github/scripts/smoke-test-backend-native.mjs`                | Node Backend、staged Koffi Worker 通过                                            |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs`            | Electron 44.0.0 / Node 24.18.1 utilityProcess 的 SQLite、Skills、交接 Worker 通过 |

构建日志在私有目录 `$HOME/.codex/tmp/native-real-verification-20261016/`。新增 QA 单独执行 `oxfmt --check` 通过；两份现有说明文档仅增加链接，其 HEAD 原文件也不通过显式 Markdown 格式检查，没有为此扩大重排。代码默认格式检查通过。

本轮没有重跑全量测试，不沿用旧全量结果为本轮新通过。此前完整验证和已知超时见[审查修复 QA](native-session-review-loop-2026-10-16.md)。自动化、真实模型、只读补证和构建分别记录；不把任一项外推为真机手机、图形浏览器、Windows/Linux 或未开放能力已验收。
