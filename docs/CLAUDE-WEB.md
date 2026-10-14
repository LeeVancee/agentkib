# Claude Code 桌面与 Web 托管执行

桌面与 Web 的 Claude 控制共用一个 Runtime 执行服务，使用本机 Claude CLI 的原生 `stream-json` 协议，而不是 Codex bridge。
历史目录仍由现有 Claude provider 发现。可以准备新会话，也可以在确认原终端停止后续接有可验证 UUID、原工作目录及主会话记录的会话。创建只预留会话身份，不提交模型消息；模型与设置发现可初始化原生 CLI，但不发送用户轮次。

桌面跨 Agent 会话导入是另一条经过预览、确认和目标回读的流程，详见[互通兼容矩阵](SESSION-INTEROPERABILITY.md)。新增来源或原生导入适配不自动获得 Web 发送、审批或托管权限；本轮不扩展其他 Agent 的 Web 控制。

## 使用与边界

- 阅读原终端的历史不会自动交接执行权。会话输入区显示“尚未交接给 AgentKib”时，可通过“确认续接”打开现有执行归属面板；先停止原终端中的同一会话，再勾选确认并交给 AgentKib。打开或关闭面板不会发送消息，已有草稿保持不变；断线、权限不足或结果待核对时不能接管。
- 未接管且没有原生用量报告时，上下文用量显示“暂无数据”。这不代表额度耗尽；执行后的用量以 CLI 实际报告为准，AgentKib 不估算比例。
- Claude 目录标题优先级：匹配会话身份的 `custom-title`（用户改名）→ `ai-title`（CLI 自动生成）→ 有效索引标题 → 首条有效用户文本；工具结果、内部消息和附件不会成为标题。同类记录取最新一条。读取范围固定为日志头部最多 2 MiB／256 行，加上文件尾部最后 256 KiB（尾部的记录晚于头部，会覆盖头部）；每个文件的读取量有上限，并按修改时间与大小缓存，文件未变化时刷新目录不会重读。两段范围之外的原生改名或自动标题不保证同步，此时回退到下一级标题。刷新目录即可更新，无需修改原生日志。

- 基础托管执行保留 macOS Claude Code `2.1.263` 起的兼容检查；2026-10-09 新增高级控制要求 `2.1.286` 或更新版本。版本需完整匹配原生版本输出格式。版本门槛只决定是否尝试，实际帧、会话身份、模型选项及权限契约仍逐次校验，不代表所有后续 CLI 版本均完成真实验收：托管会话对 CLI 帧的处理验证到 `2.1.285`（QA 录制所用版本），更新的版本通过门槛不代表已验证，失败原因里会注明 CLI 版本。用户需自行安装并完成 Claude 登录或供应商配置；托管执行不读取、复制或下发登录凭据。额度采集是另一条路径，由第三方 sidecar 完成，可能读取凭据，见下文“额度采集与凭据”。
- 桌面启动时按项目统一的 CLI 发现规则查找 Claude（包括 macOS 的 `~/.local/bin`、Homebrew 等安装目录），并用同一解析路径完成版本验证和启动，不要求从终端启动 AgentKib，也不修改全局 PATH。找不到 CLI 或版本未经验证时仍禁用控制；不会跳过版本检查或自动安装 CLI。
- 在桌面开启 Web 与实验控制，再按需授予浏览器发送、审批、管理、组织、设置及高级控制权限。默认关闭，读取授权不包含工具审批；高级设置/目标/资源读取仍受 full access 和高级控制权限约束。
- 新建先保存工作区、请求身份和原生 UUID，新 CLI 使用 `--session-id=<UUID>`；接管已有会话使用 `--resume=<UUID>`。接管确认绑定 UUID、工作区及日志指纹；确认后新增历史会要求重新核对。不会通过“最新会话”猜测身份。
- 这是 **AgentKib 托管的续接执行**，不是控制已有终端。使用前应关闭同一会话的其他 Claude 终端；私有操作锁只约束 AgentKib 实例，无法约束官方 CLI。
- CLI 会加载其正常配置、CLAUDE.md、MCP 与 hooks；只对可信项目启用托管执行。AgentKib 启动 CLI 时唯一覆盖的环境变量是 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（理由与后果见下文“对 CLI 行为漂移的容错”）。保留 CLI 的权限配置，不启用跳过权限；CLI 自动允许的操作可能不会弹出审批，只有 CLI 实际请求的审批才展示。
- 未选择权限模式时，AgentKib 不传 `--permission-mode`，会话沿用 CLI 自己的配置；用户设置、供应商和组织策略都可能让实际模式是 `auto`、`dontAsk` 或 `bypassPermissions`。AgentKib 只读取 CLI 在 `system/init` 与 `system/status` 帧里报告的 `permissionMode`（`manual` 视为 `default`）并如实显示：这三种模式下不会再逐项审批，桌面端和 Web 的会话输入区会显示带图标的文字提示（`bypassPermissions` 样式更醒目），只提示、不阻止发送。它们不是可选项，不进入权限选择控件，也不出现在“当前值”里。CLI 没有报告模式时保持未知，不推断；若检测到的 Claude Code 为 2.1.285 或更新、该会话在本次 Backend 运行中从未观察到模式、用户也没有选过权限，则补一句“可能以 auto 模式启动”的警示。依据是官方说明：拿不到功能开关的 `-p`/SDK 会话（例如第三方 provider 或关闭遥测）从 2.1.285 起默认 `auto`；组织策略也可能改变起始模式，所以这是提示，不是判定。Worker 空闲退休后继续显示上次观察到的模式并标注“上次观察”，会话释放或 Backend 重启后清除，不持久化。该字段目前只经合成帧验证，未用真实 CLI 确认 `system/init` 是否总带 `permissionMode` 及其出现时机。
- 浏览器断线不等于终止模型执行；重连只同步快照，不重发请求。macOS 取消或退出会按父子关系捕获自有 Claude 进程树，核对 PID 与启动时间后清理，覆盖使用独立进程组的前台 Bash。无法确认完整清理时保留“结果待核对”，不报告安全释放；已脱离父子关系成为独立外部服务的进程不在清理保证内。

## 额度采集与凭据

托管执行和额度采集是两条独立路径，对凭据的处理不同。

- **托管执行不读取凭据。** AgentKib 只启动本机 `claude` CLI（`--print`，输入输出为 `stream-json`），沿用 CLI 自己的登录状态和供应商配置。AgentKib 不读取、复制或下发 Claude 的登录凭据，也不访问 Claude Code 的凭据文件或 Keychain 项。
- **额度采集由第三方 sidecar 完成，sidecar 可能读取凭据。** 额度由随应用打包的 CodexBar 采集（macOS 与 Linux 为 CodexBarCLI 0.49.5，Windows x64 为 Win-CodexBar 0.60.3）。它以你的用户环境运行 `dashboard` 命令，只在你手动刷新额度，或开启“自动获取额度”（默认关闭）后启动。AgentKib 自身不读取下列来源：它解析 sidecar 输出的 JSON，保留标准化后的额度窗口、余额、重置时间以及 sidecar 报告的账号邮箱和套餐，并对错误信息脱敏。

据 CodexBar 文档（v0.49.5 的 `docs/claude.md` 与 `docs/refactor/claude-current-baseline.md`），Claude 的数据源有：

- **网页 API：** claude.ai 的 `sessionKey` Cookie，从浏览器配置文件导入（文档列出的位置是 macOS 的 Safari、Chrome 系浏览器和 Firefox），或使用手动提供的 Cookie 头；请求发往 `claude.ai`。
- **CLI PTY：** 在伪终端里启动 `claude`，发送 `/usage`（可选 `/status`）并解析输出。工作目录是 CodexBar 自己的探测目录，探测留下的会话日志由它清理。
- **OAuth API：** 凭据来自 CodexBar 自己的 OAuth 缓存、文件 `~/.claude/.credentials.json`，以及作为后备的 Keychain 项 `Claude Code-credentials`；请求发往 `api.anthropic.com`。
- **本地日志统计：** 扫描 Claude Code 的 `projects/**/*.jsonl`（`$CLAUDE_CONFIG_DIR`、`~/.config/claude`、`~/.claude` 等位置下），读取助手消息里按模型记录的 Token 用量，用于计算费用。`dashboard` 命令在取得用量之后，会为已启用的 Claude 另做一次这样的统计。

对 macOS 与 Linux 上打包的 CodexBarCLI，文档记载的自动顺序是先用网页 API、再用 CLI PTY；OAuth API 在 CodexBar 配置里显式选择时才生效。文档同时说明个别内部代码路径仍使用不同的自动顺序，所以这是上游文档记载的行为，不是 AgentKib 的保证，具体采用哪个来源由 CodexBar 的自动选择和你的 CodexBar 设置决定。没有 CodexBar 配置时，AgentKib 生成的配置（应用数据目录下的 `quota/codexbar-config.json`，仅当前用户可读写）只启用已安装的 Provider，检测到 Claude Code 时启用 `claude`，不选择数据源，也不写入密钥或 Cookie。已有的 CodexBar 配置（`$XDG_CONFIG_HOME/codexbar/config.json`、`~/.config/codexbar/config.json` 或 `~/.codexbar/config.json`）或环境变量 `CODEXBAR_CONFIG` 优先，额度页的采集器诊断会显示实际使用的配置来源。

Windows x64 使用的 Win-CodexBar 是独立的 Windows 移植版，有自己的 Claude provider。AgentKib 在 Windows 上不生成配置，由它使用自己的设置（`%APPDATA%\CodexBar\settings.json`）。其文档和源码（v0.60.3）同样涉及浏览器 Cookie（Chrome、Edge、Brave、Firefox）、`claude` CLI 和 OAuth，自动顺序为网页 Cookie、OAuth、`claude` CLI（已配置 Admin API 密钥时先用它）；读取 Claude Code 自己的凭据文件或凭据管理器条目，要先启用一项默认关闭的设置。

不希望 sidecar 触碰这些来源时，保持“自动获取额度”关闭，也不要手动刷新额度。

## 审批行为

按 Claude 的 `can_use_tool` 请求展示工具名称、完整输入及权限上下文。支持本次 `allow` / `deny`；允许时回传原始 `updatedInput`，不发送 `updatedPermissions`，不持久保存建议规则。
拒绝不冒充取消整轮：Claude 会接收到拒绝并决定如何回应。已取消、过期、重复或 revision/轮次不匹配的审批不能提交。

已接入适配版本的选择式 `AskUserQuestion`：问题独立展示，通过 `/answer` 回传原生答案，要求浏览器发送权限而不是审批权限。支持单选、多选和自定义回答；关闭问题框只是收起，不会拒绝或取消请求。新式 text/number/preview 等未验证契约仍保持控制禁用并报告限制；不能用“允许工具”代替回答问题。权限请求里本版本不认识的字段不再终止会话，而是有界地展示给用户（最多 32 个字段，每个最多 4 KiB），回应仍只含这一次的决定与原始输入。需要自带界面才能完成的其他工具（`requires_user_interaction`）会被拒绝并附说明，不会被放行；未知的控制请求会得到错误响应（CLI 视为被拒绝），绝不默认放行。
从 2.1.285 起，前台 Bash task 通知仅在与当前轮次的原生 Bash 工具身份匹配时接受；后台升级、与当前 Bash 工具身份不匹配的前台任务，以及类型缺失或不属于 `local_bash`、`local_agent` 的任务启动继续拒绝，不因该兼容适配开放后台执行。从未在本轮开始过的任务的更新或完成通知（例如恢复会话时关闭更早进程的任务），以及轮次外到达的这两类通知，只观察、不终止会话。缺失的 `parent_tool_use_id` 按主线程处理，与 `null` 相同；既不是 `null`、也不是有界非空字符串的值既不当作主线程也不当作子代理，帧被忽略并计数。
子代理里运行的前台 Bash（帧带非空 `parent_tool_use_id`，其任务帧带 `owned_by_subagent` 或对应的 Bash 调用已在子代理帧里出现过）只做观察：不计入当前轮次的前台任务，不会因此终止会话，也不改变停止、本轮结束核对和进程树清理的行为；子代理里的 Bash 任务一旦转入后台，仍按上面的规则停止会话。子代理自身的任务帧（`task_type` 为 `local_agent`，以及只含 `local_agent` 的 `background_tasks_changed`）现在只观察、不终止会话，也不阻塞本轮结束；后台 Bash、`local_agent` 以外的任务类型，以及 CLI 在 AgentKib 发起的轮次结束后自行继续的轮次（例如后台子代理完成后继续工作）仍会停止会话并给出原因。子代理的 `stream_event`、`assistant`、`user` 帧不改变主线程的流式文字、用量与对话项：子代理的提示词不会显示成用户消息，子代理的文字不进入对话，它的工具调用仍以扁平条目显示。这不是对子代理的完整支持（没有嵌套展示）。该行为目前只经合成帧验证，未用真实 CLI 确认它会发出这样的帧。
“请求已接收”与“本轮已完成”分开记录；同一会话执行时仍拒绝第二次普通发送。用户可显式选择 `next` 插入或加入 AgentKib 队列；普通发送失败不会被改成排队。只有关联本轮身份的原生终态可以确认完成。

上下文占用采用最近主会话 API 的 `input_tokens`、缓存读取和缓存写入输入之和，不包含输出，也不使用 `result.usage` 的轮次统计或 `modelUsage` 的累计计数。窗口上限必须来自同一原生模型的 `modelUsage.contextWindow`；模型未匹配或尚未报告窗口时保留已报告输入，百分比保持未知。新一轮和压缩后等待新的普通 API 报告；压缩期间的主会话报告作为候选保留，压缩结束或补齐窗口不会恢复其百分比。断线或闲置 worker 回收后，旧报告标记为过期；显式发送恢复 worker 并收到新的普通报告后恢复比例。`autocompact_state` 是配置而不是正在压缩；只有 `system/status` 的压缩阶段锁定新发送和归属释放，停止及有效原生审批仍可操作。压缩结束或 `compact_boundary` 不表示本轮完成。

用量报告代次绑定当前 Backend 内的 runner 状态实例；新实例即使从报告编号 1 开始，也能取代旧实例的过期用量。闲置 worker 退休和重启复用同一状态实例，保留代次及报告编号。仅从持久快照恢复的旧用量不继承上一个 Backend 进程的报告代次。

## 对 CLI 行为漂移的容错

托管会话只认识验证过的帧。CLI 升级后出现不认识的内容时，不再一律终止会话，而是按下表处理：

| 情况 | 处理 |
| --- | --- |
| 不认识的、非控制类的顶层帧 | 忽略并计数，不改变会话状态；每种类型在后端日志里只记一行 |
| 不认识的 `control_request` | 回错误响应，CLI 视为请求被拒绝，会话继续；绝不默认放行；同一轮超过 1024 次视为输出已损坏并停止 |
| 权限请求里不认识的字段 | 有界地展示给用户，仍由用户决定允许或拒绝 |
| 需要自带界面的其他工具（`requires_user_interaction`） | 拒绝并附说明，让模型转告用户在 Claude Code 终端里完成这一步 |
| 子代理（`local_agent`）的任务帧，以及只含子代理的后台任务集 | 只观察，不终止会话 |
| 子代理的 `stream_event`、`assistant`、`user` 帧 | 不影响主线程的流式文字、用量与对话项 |
| 后台 Bash、`local_agent` 以外的任务类型 | 停止会话（原因码 `claude-background-task`） |
| AgentKib 发起的轮次结束后 CLI 自行继续（轮次外的 `result`、空闲时的主线程内容帧、轮次外的审批请求） | 停止会话（`claude-unrequested-turn`） |
| 其余无法解析或前后矛盾的输出 | 停止会话（`claude-protocol-violation`） |

为了让正常路径不出现后台任务与自发轮次，AgentKib 启动托管会话的 CLI 时设置 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，并覆盖用户环境里的同名值。后果：模型不能再用 `run_in_background` 把命令或子代理放到后台，也没有自动转入后台；长命令按 `BASH_DEFAULT_TIMEOUT_MS`（默认 2 分钟）超时。用户在 Claude Code 的 settings `env` 里设置同名变量可能反过来覆盖它，所以上表的帧级处理独立成立，不依赖这个变量。

停止之后，会话进入“结果待核对”，在 AgentKib 中保持只读，没有应用内恢复入口。Claude Code 自己保存着此前的对话（最后几条消息可能缺失），要继续请在 Claude Code 终端里继续同一会话。原因显示在会话状态里，后端重启后仍保留（同时有未决命令时显示通用的“结果待核对”）。

托管会话对帧的处理验证到 `2.1.285`；更新版本只作说明，不作门控，失败原因会注明 CLI 版本。以上全部只经合成帧验证，未经真实 CLI 验证。尚待在真实 CLI 上确认的帧形态包括：设置该变量后子代理是否前台运行、子代理帧里 `parent_tool_use_id` 的形态、CLI 对 `error` 类型控制响应的反应、`can_use_tool` 新字段（例如 `mcp_server`）的真实形状、`requires_user_interaction` 的工具被拒绝之后的表现，以及 stdin 保持打开时后台任务完成后的自发轮次，和 AgentKib 不处理的顶层帧类型是否真的出现。

## 高级操作与产品语义

下列功能复用桌面/Web 会话面板。控件以主机返回的 capabilities 为准；不满足版本、平台、传输、归属、设备权限或会话状态时禁用，不因界面出现入口而承诺可执行。

| 操作 | Claude / AgentKib 的行为 |
| --- | --- |
| 模型、effort、工具权限 | 模型和 effort 来自原生初始化发现，不写死供应商列表。会话级设置分别调用 `set_model`、`apply_flag_settings`、`set_permission_mode`；权限只开放 `default`、`plan`、`acceptEdits`，与 Codex `policyId` 分开。仅提交用户修改的字段；未选择权限时不传 `--permission-mode`，继承 CLI 配置，不假定为 `default`。实际模式取自 CLI 的报告并如实显示，CLI 没有报告时保持未知；观察到不可选择的 `auto`、`dontAsk`、`bypassPermissions` 时，“当前值”里的权限项置空并给出界面提示（见“使用与边界”）。保留已选值、已确认当前值及 pending/unknown 状态，不把“已提交”当成生效。模型能力匹配同时识别原生别名及实际模型 ID。单独选择 effort 默认值会清除该项覆盖并重新继承 CLI 配置，保留模型和权限；切换模型时也会清除不兼容的旧 effort。完整恢复默认清除全部会话覆盖，不写用户全局配置。 |
| 执行中插入 | 用原生 `priority: "next"` 用户帧绑定当前轮次及 revision；它不等于 Codex 的原生 steering 契约，也不等于 AgentKib 的持久队列。 |
| 重命名 | 更新 AgentKib 标题，并向已验证的原生主会话日志追加 `custom-title`。新建空会话在产生原生日志后再同步标题。 |
| 分叉 | 从已验证的原生主会话及已结束的 assistant 截止点，使用 `--resume`、`--fork-session`、`--resume-session-at` 准备新 UUID。准备后释放、重新接管或重启仍保留来源及截止点；接管指纹绑定这些信息。未产生历史的空会话、无法验证的截止点不开放分叉。 |
| 归档与取消归档 | 归档属于 AgentKib 的持久状态，不删除 Claude 原生历史。归档暂停后续调度；取消归档后仍需显式恢复队列或目标。 |
| 队列 | AgentKib 持久保存待办，支持添加、编辑、删除、重排、暂停和恢复。只编辑尚未派发的纯文本条目，附件引用保持固定；已领取、已派发及结果未知的条目不能编辑、删除或参与重排。编辑保留原设备归属；进入空闲后由宿主串行调度，优先处理用户队列，再继续目标。 |
| 目标 | AgentKib 持久保存目标、预算、步骤、执行身份、报告及用量；不是 Claude 的原生 goal API。可创建、更新、暂停、恢复、清除。 |
| 资源与历史 | 复用工作区文件/产物、只读 Git diff 和历史引用服务，每次读取和发送继续校验工作区及设备授权。浏览器提交主机签发的引用 ID，不提交任意本机路径；已验证会话上下文与工作区文件浏览是两种作用域。 |

队列与目标的每次自动派发都由宿主重新检查原设备身份、当前授权、工作区、控制开关和会话状态，复用现有请求回执与并发栅栏。撤销设备或权限不能由持久任务绕过。主机/Backend 重启后，待办和活动目标暂停，已派发但没有终态的步骤保留 unknown；不会自动续跑或重放未知请求。用户在面板中选择恢复后仍须通过当前权限和待核对状态检查。

目标步骤通过只绑定当前步骤的 loopback MCP 工具 `report_goal_step` 提交 `continue`、`complete` 或 `blocked` 及证据/剩余工作。报告先保存为待确认，只有对应步骤的原生成功终态才能推进目标；回复中的“完成”字样、HTTP 已接收回执或单独一条 MCP 报告均不能完成目标。缺少报告、失败、取消、结果未知或连续没有新增进展时暂停/阻塞，不自动宣告完成。

目标预算按对应原生结果的 `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens` 累计，与上方上下文占用百分比不同；不按输出文本长度估算。它限制是否启动下一步，不是正在运行一轮的硬 token 截断。预算已耗尽时停止下一步，有预算而缺少合法用量时暂停；用量缺口跨重启和目标更新保留，不能通过恢复或提高预算绕过。后续取得原步骤的实际用量可去重补账；否则只有明确移除预算才能恢复自动推进。仅更新目标文字不移除原预算，调整预算仍保留已累计用量。

## HTTP、SSE 与 WebSocket

浏览器现有 HTTP 操作和 SSE 实时订阅保持兼容。新增 `/api/web/v1/socket` 是可选的有界 JSON 请求适配层，不替代 SSE，也不转发任意 Backend RPC。它仅用于同源 Web 服务及其桌面 TLS/反向代理入口；托管网页到 LAN HTTP 的连接继续保留原有基础能力，不开放此 socket 或新增高级控制。原生桌面连接另一台主机的配对和能力范围见 [REMOTE.md](REMOTE.md)，不因本次 Web 改动自动扩展。

- 升级请求必须带 Origin 并通过现有主机、来源和配对鉴权。每帧沿用握手身份，并重新执行 HTTP handler 的 cookie、CSRF、boot/revision、授权、capabilities 和回执校验。
- 帧结构为 `{ id, path, body?, csrfToken, protocolVersion: 2 }`；`body` 存在时为 POST，否则为 GET。不能提供 headers 或 deviceId。响应为 `{ id, status, body }`。
- 只允许受限的 managed/Codex 操作、设置/队列/目标/资源读取及回执查询。历史长读、SSE/实时流、附件字节上传、文件正文及任意路径继续走各自的 HTTP 服务。
- 单连接同一时刻最多一项请求；输入最大 64 KiB，响应最大 1 MiB。忙碌帧被拒绝而不进入队列；服务关闭时终止连接。断线、超时或未知结果不会触发自动重发。
- 公网 Relay 仅在 control 通道转发 `GET /api/web/v1/socket`，preview 通道与其他升级路径拒绝。桌面 TLS 代理在握手前后核对代次、租约、Host 和 SNI；Origin、Cookie 和帧权限继续由同一 WebAccessService 校验。握手上限 10 秒，撤销、租约过期或停止会关闭待连接和已升级的上下游。
- VPS 保持 TLS 密文透传，外层 frp WSS 与内层应用 WebSocket 各自独立。通用 managed 接口、队列、目标与回执仍属于桌面，不增加 broker API 或 VPS 存储；旧桌面必须包含对应转发实现才能使用公网 socket。

## 桌面、附件与恢复

- 工作区会话页提供 Claude 新建与交互面板；Web 使用现有新建、会话和弹窗入口。桌面 IPC 由宿主赋予本机 owner 身份，浏览器继续使用配对设备身份，不能提交本机文件路径。
- 图片支持 PNG、JPEG、WebP、GIF，校验实际编码头和尺寸；Claude 单图原始数据不超过 4 MiB，单条图片合计不超过 12 MiB，边长不超过 8000。普通文件最多 10 个、单文件 25 MiB、消息总量 100 MiB。文件作为受管理副本交给 CLI，由其工具权限决定能否读取；上传成功不保证模型能理解格式。
- 图片格式校验和 CLI 原生图片块传输不代表所选上游模型具备视觉能力。自定义渠道需选择支持图片输入的模型；例如 DeepSeek 官方能力表将 `deepseek-v4-pro` 列为仅文本输入、`deepseek-flash` 列为文本及图片输入。AgentKib 不因识图失败自动切换模型，实际验收按所选模型单独记录。见 [DeepSeek 模型能力](https://api-docs.deepseek.com/api/list-models/)。
- 活动或未知请求引用的附件不能删除；跨重启保留。明确完成或未派发才结算引用。重复请求校验原始输入指纹；即使附件已按保留规则删除，也不会重新派发旧请求。
- 桌面文件浏览复用注册工作区内的文件与产物服务；HTML/媒体在隔离浏览器预览，不把 HTML 作为 Electron 页面执行。Web 继续按文件权限校验，LAN 上传仍禁用。
- 操作回执复用现有 ledger；Claude 元数据保存到应用数据目录 `claude-managed/` 的版本化文件。相同请求身份但不同内容会被拒绝。超时、断流及异常重启保留待核对状态；“核对”是只读检查，不能凭空补写成功或自动重发。设置原生 ACK 丢失、或改名/分叉已产生副作用而回执尚未提交时也保持 unknown；当前没有将此类状态自动重置为可执行的恢复入口。
- 正常释放仅在本轮已结束且自有进程停止后完成；运行中先取消并等待确认。旧审批/问题不能跨轮次或重启继续使用。最多 8 个执行进程；私有锁不能约束官方客户端，也不承诺跨客户端原子排他。
- Windows/Linux 尚不开放 Claude 托管控制；保留只读历史及现有独立续接能力。Claude Desktop Chat/Cowork 不在本功能范围。

## 开发验收

- 自动化测试默认不调用真实模型。旧 `claude-real.test.ts` 是历史验收脚本，不能作为本期通过证据；本期用隔离数据和合成历史重新验收。
- 本次通用协议、前端、宿主调度和 WebSocket 的验收见 [2026-10-09 QA](../qa/claude-remote-parity-2026-10-09.md)；早期原生执行证据保留在 [2026-09-30 QA](../qa/claude-managed-2026-09-30.md)，不外推到新增能力。代码测试通过不等于真实模型、桌面/Web 全工作流、生产中继或实体手机已验收。
- 公网 Relay 转发的两仓库同步另见 [Relay 离线验收](../qa/claude-relay-sync-2026-10-09.md)，包括真实 frp、桌面 TLS、WebAccessService、Backend 与合成 CLI。跨仓测试显式启用，默认测试中的跳过不计为真实隧道通过。
- 真实测试每例单轮，保留 attempt 记录；超时或结果未知后不自动重试、切换模型或复制凭据。
- 公开分发前仍需另行确认第三方接入边界。本机 CLI 验证不表示已获得订阅额度接入许可。

参考：[Claude 官方 SDK 控制协议](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。未引入 SDK 或新生产依赖。
