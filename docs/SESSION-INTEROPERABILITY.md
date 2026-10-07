# 会话互通：方向、版本与验收边界

本页描述工作树中的实现，不代表已发布版本。统一中间格式仍是 `SessionDocument`；来源解析、目标转换、原生导入与 Web 托管控制分别判断能力。新目标目前为实验适配，不能将离线导入成功理解为真实模型续接已验收。

原生验收记录绑定各自的源码 revision、Agent 版本和产品界面。当前后端已迁移到 TypeScript；本轮执行器、恢复及 MCP 归属的自动化与候选包检查见[2026-10-07 稳定性 QA](../qa/typescript-stability-2026-10-07.md)。历史 Rust Runtime、原生界面和真实回复记录仍保留原结论，不作为迁移后同方向已重新验收的证明。

## 来源

| 来源             | 已实现范围                                                                                                 | 拒绝或未验收范围                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | 现有原生 JSONL、分支、工具、附件及脱敏                                                                     | 保持既有版本/正文校验                                                                                                        |
| Codex            | 现有原生 rollout、工具、附件及脱敏                                                                         | 保持既有版本/正文校验                                                                                                        |
| OpenCode         | 现有官方导出解析                                                                                           | 无法取得完整导出时拒绝                                                                                                       |
| Hermes           | 原始 SQLite/JSONL 用户与助手正文、工具关联                                                                 | 不以展示摘要代替完整历史；压缩代际、父会话缺失时拒绝                                                                         |
| Grok Build       | 官方 ConversationItem JSONL 正文、工具记录                                                                 | 损坏正文拒绝；来源解析不代表可生成其权威 updates 日志                                                                        |
| Cursor CLI       | 官方 `2026.09.26-dd393fe` blob 图格式、SQLite user_version=1；普通会话                                     | 缺工作区归属、压缩/归档、未知 wire/schema 拒绝；CLI 与 IDE 能力分别判断                                                    |
| Cursor IDE       | macOS 本地 bridge，支持 Cursor 3.22.12 与 3.23.12；显式连接 profile/window 后读取与原生导入                | 仅支持已连接的本地窗口；不代表 Cursor CLI 或 Agents Window 能力；Windows/Linux 原生桥接关闭                              |
| Antigravity      | 现有官方 ACP 回放                                                                                          | ACP 来源不等于完整 Desktop 或 CLI 原生存储                                                                                   |
| OpenClaw         | `2026.9.6` / SQLite schema 23：原始事件正文、官方有效分支投影和 reset 窗口；兼容无 SQLite 的 Pi JSONL v1–3 | 未知 schema、陈旧投影、压缩事件、冷归档及缺失的外部历史拒绝；仅供显示的消息可浏览、不可交接；SQLite/WAL 存在时不回退旧 JSONL |
| DeepSeek Harness | 保持只读 Beta                                                                                              | 不参与新增续接或原生写入                                                                                                     |

会话页面向 Runtime 查询具体会话能否完整解析；不再仅以 Agent 名称决定。来源缺必要正文时拒绝。推理排除、工具摘要化、附件省略等已知损失在预览展示，需确认的损失未经确认不能继续。

## 目标与逐方向状态

表中每个目标列适用于上表**实际通过解析的来源**。同一 Agent 的不同产品表面不能互相代替验收。

| 目标                      | 执行与固定范围                                                                                                                      | 已记录的原生验收与限制                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                | 保留 ChangeSet 原生文件写入与按 ID 恢复，版本门限沿用 2.1 系列                                                                      | OpenClaw SQLite 来源的生产转换载荷已获单轮真实回复，准确复述历史随机标记与决策；目标 TUI 和 AgentKib Runtime 重启可读。完整预览→Changes 操作及全部来源真实回复尚未逐方向验收 |
| Codex                      | 保留 ChangeSet rollout 寫入與按 ID 恢復；本機放行版本精確限定為 0.159.2                                                           | 已確認本機 CLI 為 0.159.2；經使用者授權，4 檔 ChangeSet 已套用至私有封存與本機 rollout，未另送提示。直接 resume 成功顯示匯入歷史，Codex state DB 建立首則訊息與預覽索引；這只證明本機 0.159.2 的讀回，不涵蓋其他版本或來源方向 |
| OpenCode                  | `1.18.32` 官方 import/export；必须显式配置 provider/model；独立会话 ID                                                              | 历史生产载荷导入、两次原生 TUI 与回读通过；Claude/Codex 两个文本方向各有单轮 CPA/Opus 回复证据。免费模型 403 保留，其他方向与迁移后的后端未因此通过                                                                            |
| Hermes                    | `0.21.5` / release `v2026.9.24`；官方 Claude 文件导入、origin_json 查回、按真实 ID 恢复                                             | 历史导入、两次原生 TUI 与回读通过；Codex→Hermes 单轮 DeepSeek 回复与禁网导出有独立审计。官方免费模型 403 保留，不代表全部来源或迁移后的后端通过                                                                                |
| Grok Build                 | `1.0.41` 实际二进制无文档所述 import 子命令；手工候选记录未被原生列表识别                                                           | 原生目标禁用；权威 updates 日志与索引写入契约未建立                                                                                                                          |
| Cursor IDE                 | macOS 本地 bridge；Cursor 3.22.12 与 3.23.12；须显式连接目标 profile/window，按 binding 恢复                                     | 实验性原生导入；连接、导入与恢复按选定 binding 进行。Cursor CLI 与 Agents Window 不继承此能力                           |
| Cursor Agents Window       | 独立产品表面                                                                                                                      | 未接入；不能以 Cursor IDE 或 CLI 验收替代                                                                                 |
| Cursor CLI                 | `2026.09.26-dd393fe` 有 create/resume，独立 blob 存储                                                                               | 外来原生写入、重启恢复和回复未验收；不能以 IDE 实验替代 CLI，原生目标禁用                                                                                                    |
| Antigravity Desktop / CLI  | Desktop `2.12.2`、CLI `1.2.12`；官方自身 Desktop→CLI 迁移不等于外来历史导入                                                         | 外来原生目标禁用；保留 ACP 来源                                                                                                                                              |
| OpenClaw                  | `2026.9.6` npm 安装 / SQLite schema 23；官方状态锁及事务写入；仅现有且工作区唯一匹配的本地 Agent；通过 `tui --local --session` 恢复 | 历史隔离写入、Gateway/TUI 恢复及 Grok→OpenClaw 单轮回复有逐项记录；后者原严格 false 与完整整句独立审计分别保留。免费 403、旧遗漏决策回复仍失败，不外推其他方向或迁移后的后端                                                   |

Cursor IDE 本机连接需要在会话页选择“连接 Cursor 窗口”，检查随应用打包的 VSIX 并手动安装到选定 profile，再在目标单文件夹窗口运行 `AgentKib: Connect This Workspace` 并输入限时挑战。AgentKib 不自动安装扩展，也不猜测默认 profile；多个窗口须显式选择。连接恢复沿用原 binding，CLI 与 Agents Window 保持独立能力边界。

因此，来源与目标表面必须分别验收；代表性解析、离线导入、原生 UI、Runtime 重启及真实回复不能互相替代。缺少已配置模型、授权或运行环境时保留未验收状态，不自动登录或迁移凭据。Windows/Linux 自动化不代替实机验收。

## 审查、失败与恢复

文件写入目标仍沿用既有 ChangeSet。命令导入目标在 Changes 中展示应用数据目录内的 `plan.json`，其中包括冻结并脱敏的来源文档、目标投影、载荷、版本/存储身份及操作指纹。它是**准备文件**；批准后才会调用目标 CLI，目标内部数据写入不伪装成 JSONL 文件 diff。

OpenCode/Hermes/OpenClaw 的历史工具调用转换为标注的历史文本，工具参数/原始输出与附件可能省略；预览明确显示损失。转换器不保留可再次执行的历史工具调用。必要用户/助手正文发生未知变化时拒绝导入。新目标不支持尚未经验证的 AgentKib 长历史检索；超出完整窗口时不静默截断。

MCP 连接可以使用唯一注册 ID，旧 manifest URL 仅兼容唯一归属。归档与操作文件仍保留原 manifest namespace；多个已注册 clone/worktree 共享该 namespace，或它与其他注册 ID 冲突时，拒绝归档读取、长历史写入及歧义操作恢复，拒绝发生在 write/import 前。普通 registered MCP 访问不受该归档限制；Hub 每次归档读取都重新核对归属。重新写连接 URL 不迁移或重新分配旧归档。

每次明确分叉有独立操作 ID；开始外部导入前先写入持久化尝试标记。重复 RPC 复用记录；导入后必须核验归属、正文、角色及已知结构，失败不得启动模型。Hermes 出现父/子会话关联可能被官方恢复流程重定向，目前保守拒绝自动恢复；OpenCode 已撤销的历史同样拒绝。CLI 非事务导入发生超时、断流、退出或部分写入时，保留现场并显示待核对；不会因响应丢失再次导入，也不会自动降级为文件交接。会话页可查看持久化记录并核对/恢复已有目标。无法确认安全删除时不自动清理目标对象。

OpenClaw 使用固定版本自带的写入函数维护原生索引与投影，写入期间持有官方状态锁。已有 Gateway 或本地 TUI 占用时拒绝导入及自动恢复，不停止用户进程。目标数据库必须已是已验证版本，AgentKib 不自动迁移旧存储。启动仅打开已核对的本地会话，不发送初始提示；正文、身份、工作区或代际改变时拒绝恢复。

当前 TypeScript 后台执行器串行处理，允许 1 个执行中请求和 8 个等待请求；总期限从入队起计算，默认 180 秒，排队满时立即拒绝。耗时历史读取、哈希和序列化在只读 Worker 中处理，普通 Runtime 请求继续响应。退出时拒绝待执行请求并取消外部等待，已启动的本地写入执行至结束或自身回滚。已开始且结果不明的导入保留尝试记录，只允许核对，不自动重放；Cursor 导入失败后还会重新从原绑定的存储核对。任务失败不自动创建替代目标。不承诺目标 CLI 的跨进程事务、强杀或断电恢复。

上下文文件交接仍可由用户明确选择，它创建引用文件，不计入原生互通验收。这些互通适配不授予 Web 控制权限，也不自动迁移 Agent 配置或凭据。

## 证据

- [当前 TypeScript 自动化与候选包验收](../qa/typescript-stability-2026-10-07.md)（与下列历史原生记录分开）
- [10 月 1 日 provider 逐例复验](../qa/full-interop-provider-retest-2026-10-01.md)
- [10 月 1 日 Codex/OpenClaw/Cursor 收尾](../qa/interop-closeout-2026-10-01.md)

- [9 月 28 日增量 QA 与真实回复](../qa/all-agent-continuation-2026-09-28.md)
- [40 组合与原生 TUI 验收](../qa/interop-matrix-2026-09-28.md)
- [Cursor 官方导入深入实验](../qa/cursor-interop-2026-09-28.md)
- [Codex 登录与存储隔离边界](../qa/codex-native-isolation-2026-09-28.md)
- [9 月 27 日历史总 QA](../qa/all-agent-continuation-2026-09-27.md)
- [OpenCode/Hermes/Grok 实验与命令](../qa/interop-targets-2026-09-27.md)
- [Cursor/Antigravity/OpenClaw 平台与版本探测](../qa/interop-platform-probes-2026-09-27.md)

- [新版 OpenClaw SQLite 专项验证](../qa/openclaw-sqlite-2026-09-27.md)
