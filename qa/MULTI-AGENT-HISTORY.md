# 多 Agent 发现与只读历史验收

## 范围（2026-09-08）

- 发现来源诊断、支持层级与刷新状态。
- OpenClaw、Hermes、Grok Build 只读目录、正文和有界分页；OpenCode 发现兼容。
- 不新增发送、审批、恢复、导出或控制能力，不运行真实 Agent 请求。
- 保留现有设计与无关改动；本轮不提交、不发布。

## 证据层级

测试结果分别记录为代码检查、隔离数据、合成 UI 和真实记录，不能相互替代。

### 本机来源检查

- Claude 测试目录 `/Users/kouzen/Documents/data/test/CLAUDE.md` 已存在；此前已确认原生历史登记及 AgentKib 工作区记录。
- OpenCode 本机数据库存在，按只读查询包含 3 条会话；后续只读验收不得启动会话。
- OpenClaw 配置目录存在，但本次检查未发现 `agents/*/sessions` 历史文件。
- 本机未发现默认 Hermes、Grok 配置目录；它们不能宣称真实记录验收通过。

## 最终自动化结果

实现与自动化验证完成，完整图形／真实新来源验收未完成。未创建 commit、PR 或发布。

- `cargo test --workspace --quiet`：最终全工作区通过；其中 conversations 91 项、discovery 30 项、store 41 项。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `pnpm test`：桌面 81 个文件、557 项通过；Web 22 项通过。
- `pnpm typecheck`：桌面、Web 通过。
- `pnpm build`：release runtime、资源 staging、Web、桌面 renderer、Electron main/preload 全链通过；未制作或发布新安装包。
- 协议生成一致性：通过，版本 15。
- 本次修改的 21 个前端源文件 `oxfmt --check`：通过。
- `pnpm format:check`：仍有 4 个**未修改、与 HEAD 一致**的既有文件不符合格式：`activity-presentation.ts`、`RemoteErrorDetails.tsx`、`RemoteErrorDetails.test.tsx`、`styles.css`。没有为此扩大格式化范围。
- `git diff --check`：通过。

### 隔离 runtime 的真实发现验证

使用 `/tmp/agentkib-discovery-qa.0SrLXP` 独立数据目录及仅本机端口 47659，通过正常 runtime RPC 握手、刷新、读取报告与能力信息，不修改用户的 AgentKib 数据库、不发送 Agent 请求。

- 协议版本 15；发现 38 个工作区，包含 `/Users/kouzen/Documents/data/test`。
- Codex、Claude、OpenCode 的本机来源成功；OpenCode SQLite 与旧 JSON 分别报告。
- OpenClaw 配置有结果、JSONL 来源缺失；Hermes 与 Grok 默认历史来源缺失，未误报为已读到历史。
- 三个新增历史来源声明 `history_read=true`、`continuation=false`、`control=none`。
- 来源纳入数／跳过数不能准确归因时为未知，不把候选数当成最终纳入数。
- 测试 runtime 已退出，47659 无残留监听。临时数据保留用于复核。

### 已修复的验收发现

- 统一折叠组件；新增只读来源的续接／导出入口；发现刷新与未扫描状态；原因码四语言翻译。
- 部分历史失败保留旧索引；嵌套目录统一归属并持久化原始 cwd；旧版本缺来源表的迁移兼容。
- Hermes DB／JSONL 去重与回填、严格游标／高水位锚点、未知角色跨页、超长字段边界；reasoning 带 assistant role 时仍不渲染。

### 未签收项

- OpenClaw、Hermes、Grok 的真实历史正文：本机没有可用记录，现为隔离 fixture 验证，不能替代真实来源验收。
- 新 runtime 的完整图形、多尺寸和深浅主题验收未完成。现有 Electron 仅完成 1215×768 浅色及旧运行时诊断降级的目视检查。
- `playwright-interactive` 所需 `js_repl` 不在本会话工具中；未改 Codex 配置。隔离 Electron 尝试遇到启动入口路径和测试端口残留问题，电脑工具仍定位原开发实例，未据此声明新界面通过；本次创建的隔离 Electron／runtime 已清理，原开发实例未退出。
- 当前用户打开的旧 runtime 不会因前端热更新自动获得新协议与诊断字段；需重启 AgentKib 后加载新 runtime。此轮没有替用户重启该实例。

## 过程记录

### 2026-09-08 无末尾换行的 JSONL 记录 goal

- 对应评论 `3958355700`，基于 `f6ea166`。共享反向分页器不再无条件丢弃尾部第一条记录，仅跳过空尾片段；完整无换行 JSON 正常解析，不完整 JSON 按损坏记录警告处理。扫描预算、快照校验及游标机制不变。
- 单记录回归修复前返回 0 条，已复现。覆盖 Codex／Claude／OpenClaw／Hermes／Grok Build 的无换行、LF、CRLF；另验证跨页重试、尾部换行前后事件 ID 与顺序一致，以及损坏尾部不吞前面完整记录。
- 会话模块 104 项单测及集成测试、Rust 全工作区测试、全目标 Clippy、Rust 格式、生产构建和 diff 检查通过，生成绑定无差异。无前端实现改动，未重复前端单测。独立 review-agent 完整复核分页器、provider 调用、预算与快照边界，最终 No findings，goal 完成。
- 未操作真实 Agent 或用户历史文件，保留无关设计改动；未 commit／push，远端评论待推送后标记 resolved。

### 2026-09-08 元数据会话入口与退出翻译依赖 goal

- 对应评论 `3958169053`、`3958169071`，基于 `cc5eaf6`。Web 非 readable 会话按钮禁用并提供四语原因说明，choose 入口另行校验，避免创建无意义的 history/live/SSE 请求。新增回归修复前失败、修复后通过；可读会话行为保持。
- 桌面退出事件 effect 增加 tr 依赖。真实语言切换验证应用中提示与未存草稿确认、活动订阅始终一个、卸载清理且不调用 quitApp。当前 i18next 旧翻译函数仍可随全局语言更新，未直接复现旧语言显示；本次消除依赖遗漏，不把该风险描述成已实测复现。
- Web 57 项、桌面 596 项（退出定向 7 项）、类型检查、生产构建、格式与 diff 检查通过，生成绑定无差异。无 Rust 改动，未重复 Rust 全量测试／Clippy。独立 review-agent 完整复核五个源码／测试文件及相邻调用链，最终 No findings，goal 完成。
- 无真实退出或 Agent 控制测试；保留无关设计改动，未 commit／push，评论待推送后标记 resolved。

### 2026-09-08 Bridge 派发边界与负回执 goal

- 对应评论 `3957044855`，基于 `f428957`。HTTP 预检之后，runtime 与 bridge 仍会刷新并核验版本或审批；原来在这些检查前安装 fence，明确未发送也会永久禁用控制。
- Bridge 增加写前回调：完成连接、序列化和帧大小校验后，在首个 IPC 写入尝试前安装 runtime fence，仍持有跨进程操作锁。未写入的本地帧拒绝恢复原快照状态；写入尝试后的断线、错误或不明回执保留 fence。
- runtime 对 claim 之后的未派发预检失败返回关联负回执；旧 fence 和重复请求检查不进入此分类。HTTP 严格匹配请求 ID、runtime 启动 ID 及负回执字段后才清除本层 fence，返回 409 / not-dispatched。超时后迟到回执不清 fence，不自动重发，也不复用请求 ID。
- 使用隔离模拟 owner 覆盖发送／审批版本变化、审批消失、帧超限、成功回调及派发后失败；HTTP 原行为先复现 2 项失败，再验证发送／审批负回执、身份不匹配及迟到负回执。没有操作真实 Agent 或配对设备，不声称真实桥接验收通过。
- 验证通过：Rust 全工作区测试、全目标 Clippy、Rust 格式检查；桌面 593 项、Web 56 项、HTTP 36 项及随后新增的迟到回执定向 2 项；类型检查、生产构建、前端格式及 diff 检查。生成绑定无差异。独立 review-agent 完整复核六个实现／测试文件及调用链，最终 No findings。goal 完成；未 commit／push，评论待推送后标记 resolved，保留无关设计改动。

### 2026-09-08 远程目录发送端数据最小化 goal

- 对应评论 `3956816447`，基于 `f3ac7fc`。先用真实 Store 发现来源夹具复现：本地含 session_cwds 和 repository_group_id 时，原始远程 catalog 响应把 sources、发现路径、repository／manifest 字段一并发送。接收端剥离不足以形成安全边界。
- 在 RemoteSessionSource::catalog 发送前显式投影 8 个既有公开工作区字段：id、path、name、status、asset_count、warning_count、last_active_at、last_scanned_at。不修改本地发现诊断、授权、登记检查、会话摘要或持久化结构。
- 回归先确认夹具真实存有内部来源，再精确比较原始响应字段及私有标记缺失；修复前断言失败，修复后通过。独立 review-agent 只读复核原生远程服务及 Web 调用方、会话摘要和接收端兼容，结论 No findings。
- 验证通过：runtime 55 项、Rust 全工作区测试、全目标 Clippy、远程解析前端 29 项、类型检查、生产构建、Rust／前端格式检查及 diff 检查；生成协议绑定无差异。前端实现未改，未重复桌面／Web 全量测试。本地 goal 完成。
- 本轮不操作真实配对设备，不将源响应回归当作真实设备网络验收。保留无关设计修改，未 commit／push，不提前标记远端 resolved。

### 2026-09-08 完整草稿、工作区筛选与远程时间校验 goal

- 对应最新评论 `3956600378`、`3956600387`、`3956600391`，基于 `9d44e54`。该提交远端五项 CI 已通过，但这不涵盖本轮未提交修复。
- 核对字节评论：现有发送路径实际使用 `message.trim()`，所以“服务端收到完整草稿”的复现描述不成立；字符与字节校验对象不统一仍值得修复。本轮均按完整草稿限制，保留原有 trim 提交行为；回归直接解析请求正文，并覆盖首尾 ASCII／多字节空白、emoji 及纯空白草稿。
- 工作区历史的 Agent 菜单使用未过滤历史中实际出现的来源，复用名称映射，同时保留当前筛选入口；不以续接目标能力决定历史筛选。补 OpenCode、OpenClaw、Hermes、Grok Build 混合历史筛选及恢复全部的回归。
- 远程边界对会话 created_at／updated_at、工作区 last_active_at／last_scanned_at、事件 timestamp 统一进行 ISO 时间（含时区）及 JavaScript 有限日期校验；错误数据返回既有 REMOTE_INVALID_RESPONSE，不进入日期渲染。保留 null／缺失值、时区偏移和纳秒时间精度字符串。补全部字段的非法日历、时间、类型及合法时间回归。
- review-agent 独立只读复审覆盖三条相关调用链，结论 No findings；未操作真实 Agent 或远程主机。新增筛选测试首次运行有英文按钮名称及 ByRoleOptions 参数错误，修正测试后定向 43 项通过，未削弱生产校验或断言。
- 最终验证：`pnpm test` 通过（桌面 81 文件／587 项，Web 56 项），`pnpm typecheck`、`pnpm build`、`pnpm format:check`、`git diff --check` 通过；构建生成绑定无差异。独立只读复审 No findings，相关本地 goal 完成。
- 本轮不修改 Rust、公共 runtime 协议或持久化结构，未重复运行 Rust 单元测试和 Clippy；开发版及 release runtime 随标准测试／构建脚本编译通过。未验证真实远程设备或异常主机，不以模拟回归代替真实验收。保留无关设计修改；尚未 commit／push，不提前标记远端 resolved。

### 2026-09-08 新增 PR 评论的第二个本地 goal

- 对应 PR #63 评论 `3956105132`、`3956105139`、`3956105147`。上一轮只读 review 漏掉了 SSE 到 UI 的联动及 Grok 归档身份问题；本轮扩大到相关调用链，不把已有测试通过当成无缺陷保证。
- Web 错误响应增加可选 `controlOutcome`，由实际派发边界及既有未知请求保护决定，而不是从错误码猜测。只读预检超时明确为未派发；派发后异常、重复请求及既有未确认结果仍保守处理。旧响应缺失字段继续降级为未知，不自动重发。
- SSE 的控制准入占用不再变成 `unavailable`；每次轮询仍检查授权，撤销仍立即终止流。客户端保留历史，并在读取暂缓后重新取得访问权限及实时状态才恢复控制。新增跨两次轮询的真实 loopback HTTP 测试，不连接真实 owner。
- Grok 身份仅使用 profile home 与非空原生 ID；先在有界候选中选择唯一 locator，再按工作区过滤，防止同 ID 跨 cwd 副本导致列表与正文错配。活动副本优先，候选路径确定次序；不对整个目录预排序，不改变扫描预算。
- 兼容限制：此前路径参与哈希的 Grok ID 会一次性切换，未实现旧 ID 映射；后续归档、反归档及目录重命名保持 ID。不声称旧选择 URL 已迁移。
- 独立 review 第一轮发现预检超时分类、跨工作区副本和全目录排序问题，均已补修；第二轮发现手动刷新被后台 access 查询取代导致持续禁用，第三轮发现控制待定期间的旧手动刷新意图跨未知结果解锁。均补修并增加 deferred 回归，最终独立复审为 No findings。review-agent 技能用于各轮只读复审，实施修改由主代理及实现代理负责。
- 初次全量验证遇到 MCP 临时端口占用和桌面菜单查找失败；未削弱断言。Rust 全量重跑及桌面 568 项重跑通过，菜单单独 10 项也通过。后补 HTTP 预检超时测试后定向 30 项通过。最终状态见本节后续补记，不将中间快照视为完成。
- 保留无关设计修改；本轮未向真实 Agent 发送控制请求。真实设备、HTTPS、安装包运行及新提交跨平台 CI 尚未验证。
- 最终验证：桌面全量 81 文件／569 项、Web 49 项通过；Rust 全工作区重跑通过，最后 Grok 修正后 conversations 全量及 workspace Clippy 再次通过。`pnpm typecheck`、`pnpm build`、`pnpm format:check`、`cargo fmt --all --check`、`git diff --check` 通过；构建生成的协议绑定与 HEAD 无差异。首次测试失败及重跑事实保留如上。
- 本地 goal 完成时未 commit／push，也未提前将远端评论标记 resolved。随后按用户要求提交、推送，并逐条回复修复依据、标记已解决及申请新一轮 Codex review；远端结果另行确认。本轮 No findings 仅针对上述修复及相关链路，不代表整条 PR 或真实设备全量无缺陷。

### 2026-09-08 剩余 PR 评论本地 goal／review 闭环

- 范围：评论 `3955837839`（UTF-8 超长）与 `3955837857`（Web worker 读请求抢占），以及本轮修改的 HTTP → RuntimeHost → Worker → Bridge 调用链；不是对整条 PR 的无缺陷保证。
- 保留 16,000 字符限制，Web 使用 TextEncoder、HTTP 使用 Buffer.byteLength，额外执行 bridge 的 16,384 UTF-8 字节上限。Rust 共用验证函数在 runtime 读取来源、占用请求 ID 和建立 fence 前执行；bridge 保留独立调用时的同一校验。
- HTTP 对整个 worker 的控制准入进行预留：从 preflight 至底层 mutation 完成，新的目录／历史／实时读和其他控制不入队；已有读取按 FIFO 排空。预检错误释放预留，mutation 超时不提前释放，真实不确定结果的 session fence 保留。无需扩大 runtime 接口或放宽 worker 的 idle-only 校验。
- 补 ASCII／中文／emoji 边界、超长不调用 runtime 且可重用请求 ID、发送／审批期间读取竞争、预检错误释放、已有读取排空回归。所有测试使用隔离 fixture，不操作真实 Agent。
- 独立 reviewer 按 review-agent 只读检查两轮：均为 No findings；第二轮重新核对最终 diff 和补充的已排队读取测试。覆盖限制：没有新增真实浏览器／真实 owner 验收，preflight 超时未单设回归（预检错误释放及 mutation 超时已覆盖）。
- 本地验证：Rust 全工作区测试和 Clippy 通过；桌面全量 565 项、Web 27 项通过；最后补充读取排空测试后 HTTP 定向 27 项通过。类型检查、生产构建、Rust／前端格式检查、diff 检查通过；构建生成协议无差异。Linux bridge 交叉目标 Clippy 通过，不等于其他平台的实际执行验收。
- 本地闭环完成后，按用户要求提交并推送至 PR #63，申请新一轮 Codex review；远端 CI／review 结果单独确认，不将本地通过等同于远端通过。保留 `design-qa.md` 和其他无关工作。

### 2026-09-08 PR #63 评论与跨平台 CI 修复

- 更正上轮验证范围：本机 macOS 测试通过不能代表跨平台通过。提交 `b8bcfba` 的 CI 暴露了 Linux bridge dead-code lint、SQLite 新库并发 WAL 转换，以及 Windows 历史 fixture／游标问题。
- PR 评论 `3955647048`：仅明确 `access_ended` 才清空内容并结束访问；错误配对码及其他 403 保留页面，可纠正后重试，控制错误仍保守禁用在线操作。
- PR 评论 `3955647062`：Web 输入与发送前校验统一为 16,000 字符，与服务端一致。
- bridge 内部流处理按 macOS／单元测试编译，保留其他平台公开只读类型；不放宽 Clippy。
- Store 仅在迁移前的 WAL 转换遇到 BUSY／LOCKED 时有界重试，恢复原 busy timeout，迁移继续使用 IMMEDIATE 事务串行化。补 reader 锁超时及释放后成功测试。
- Windows JSONL fixture 使用 JSON 序列化处理路径反斜线，不改生产路径语义。
- Hermes Windows 游标改用系统卷号和文件 ID（复用仓库已有 `windows-sys 0.61`）；身份读取失败直接报错，不以时间戳或 `(0, 0)` 降级。补追加稳定、相同正文文件替换失效及 Windows 身份读取失败测试。
- 本机验证：全工作区 Rust 测试／Clippy、桌面 559 项及 Web 25 项、类型检查和生产构建通过；Linux bridge 交叉目标 Clippy 通过。最终文件身份修改另行重跑 conversations 测试及全工作区 Clippy。
- Windows conversations 交叉检查被本机缺少 Windows C 标准库头文件阻塞（`libsqlite3-sys` 编译报 `stdlib.h` 不存在），不记为通过；实际 Windows 测试交由 PR CI 验证。
- 本轮不向真实 Agent 发送控制请求；无关设计稿、截图和 `design-qa.md` 保留。跨平台最终结果以本轮推送后的 CI 为准，不能以交叉编译代替 Windows 实际执行测试。
- `8de04f6` 推送后的 CI：Fedora x64、Ubuntu ARM64、Windows ARM64 编译通过。Windows x64 历史测试通过后，在 runtime 的四项审批投影测试发现写死 Unix `/tmp` 的夹具错误；补改为主机绝对临时路径，保留相对路径负例和全部生产校验，继续由新提交 CI 复验。
- `a488daf` 的 Ubuntu ARM64 出现远程撤销断流测试失败。检查发现固定 200ms 睡眠并未同步撤销落盘完成；测试补完成信号，再保留 200ms 背压／可用性轮询等待及原 2 秒断流断言。增加人为延迟撤销完成的隔离回归，失败日志区分完整返回和等待超时。生产撤销逻辑不改；这次测试同步修正仍须远端复验，不能由上一轮 Linux 成功推断。

### 2026-09-08 审查／修复闭环复核

- 比较基点：`origin/main` 的合并基点 `34c65fe6d270b58e0ab5091a63472aa91b30b705`；包含当前未提交修复。未提交、未发布，未向真实 Agent 发送控制请求。
- 累计修复：Codex 空分叉字段回退；大 JSONL 有界头部发现；零候选时保留来源诊断；Hermes 浮点时间（发现及历史）、双来源归属、UTF-8 分页边界。
- 本轮新增发现并修复：远程目录校验遗漏 `open-claw`、`hermes`、`grok-build`，导致混合目录整体报 `REMOTE_INVALID_RESPONSE`。先复现失败，再补齐明确白名单及 Web 客户端类型；未知 Agent 仍拒绝，不扩大控制权限。
- 复审重点：上述修复及调用方、来源身份／工作区归属、索引到远程目录／正文读取、会话／搜索异步状态、只读能力边界。最终复审未发现新的明确可操作问题；这是代码审查结论，不是绝对无缺陷或真实设备全量验收声明。
- `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `pnpm test`：桌面 81 个文件／559 项、Web 22 项通过。首次全量运行遇到新增回归测试的预期失败，修复后已全量重跑通过。
- `pnpm typecheck`、`pnpm build`（release runtime、Web、桌面 renderer、Electron main/preload）：通过。类型检查曾拦截修复中 OpenClaw 的拼写错误，已按实际 `open-claw` 协议值修正后重跑。
- `pnpm format:check`、`cargo fmt --all --check`、`git diff --check`：通过。此前报告的四个格式文件本轮仅做机械排版，已核对无语义改动。
- 正常构建执行协议生成后，`electron/generated/runtime-protocol.ts` 与 HEAD 无差异，协议仍为 15。
- 保留上文真实来源、真实设备、多尺寸、HTTPS 和安装包运行验收限制；本轮生产构建成功不等于安装包或真实跨设备验收通过。`design-qa.md` 等无关用户改动未覆盖。

实施中；以下为已执行检查，并非最终全量验收。

- `cargo test -p agentkib-platform --quiet`：31 项通过，包括新增父／嵌套项目与无标记 cwd 归属测试。
- `pnpm test:web`：22 项通过，包括三个新增只读 Agent 在浏览器有发送权限时仍不展示发送框。
- `pnpm --filter @agentkib/desktop exec vitest run electron/main/runtime-host.test.ts`：6 项通过。
- `pnpm typecheck`：桌面及 Web 通过（集成期间检查，最终需复跑）。
- 当前 Electron（旧 runtime、新前端热更新）手动检查：工作区列表显示 `test`；“查看发现详情”可进入发现设置，旧报告显示“当前运行时不提供详细来源诊断”。1215×768 浅色布局已目视检查。
- 新 runtime、其他尺寸、深色与新来源正文尚待最终验收。
- 集成中直接运行桌面 `vitest run`：537 项通过、1 项失败；新增诊断使用原生 `details` 违反项目交互组件约束，已交回 UI 补修，未削弱约束测试。
- `pnpm build:web`：通过。
- 对比 `cargo run --quiet -p agentkib-protocol --bin generate-typescript` 标准输出与已生成文件：完全一致，协议版本 15。
- `cargo check -p agentkib-runtime`：通过。
- `cargo test --workspace --quiet`：全量通过（集成中快照；并行后续补测完成后复跑受影响 crate）。
- `cargo clippy --workspace --all-targets -- -D warnings`：当前发现两项新代码 lint（嵌套 `format!`、相同分支），待修复后复跑。
