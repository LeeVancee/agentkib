# 会话打开与无变化观察性能修复（2026-10-20）

## 范围与原因

- 基线：`7f1ad3352`。本轮修复留在工作区，不提交或推送；原有 `.agents/`、`prototypes/` 及两份未跟踪背景 QA 保留。
- 桌面/Web 的打开及刷新原先等待 `Promise.all(history, live)` 才发布正文；慢占用检查使已读历史继续显示加载状态。
- 未接入 AgentKib 的 Claude 旧会话原先为状态/历史反复构造完整文档、全文计算控制指纹及全局列举会话。订阅初始快照又重复读取，250ms 观察周期持续放大无变化读取。
- 本轮没有新增产品文案；双端继续使用现有四语文案，不修改 `handoff.*`。不修改跨 Agent 继续、Codex follower、设计、依赖、锁文件或持久化格式。

## 实现与安全边界

1. 桌面/Web：历史独立接收并显示；状态失败后仍可显示已读正文并保留错误与控制禁用。会话代次、访问身份、历史 cache epoch、较新分页正文/游标/警告保护继续有效。
2. Claude 观察：通过单次发现和逐次记录头部核验解析原生身份，不再为 live/历史构造完整文档或计算全文控制指纹。控制原有 `#resolveNative` / `#findNative` / `#targetFingerprint`、锁、未知结果、平台、版本、权限及 runner 每次启动前外部占用检查不变。
3. 元数据：标题扫描和 history 时间索引按 dev/ino/size/mtimeNs/ctimeNs 失效；history 缓存同时核对已知 native refs 集合，失败不回退到旧结果，数量有界。它们只用于发现/展示。
4. Stream：仅合并相同 session/source/historyRevision 的进行中读取，结果不作为 live 缓存；完成或失败即清除。独立订阅 ID/游标、更新后新读取、最后退订、关闭及原 128 订阅上限均保留。
5. Runtime：只复用 Claude stream 的历史 items/completeItems，live 每次照常查询。复用前重新验证身份/文件版本/索引代次；读取前后不一致或显式失效不进入缓存。关闭/清空索引和运行实例变化使缓存失效；主动创建的 managed 会话保留原有“不依赖索引开关”的观察能力，纯索引会话仍必须启用索引。没有缓存对外分页 cursor，不改变分页 15 分钟有效期及原 32 状态容量；历史投影另限 32 条、8 MiB 序列化内容。
6. 独立复核发现 version 检查 await 期间索引可能关闭/清空，已在 await 前后复核 owner/index/enabled/generation，并补两条 gated runtime 回归；缓存不能在这类竞态中返回旧历史。

## 回归与性能验证

- 双端 `history-independent-display.test.tsx` 各 10 条：慢 live、live 先失败、刷新控制围栏、切换、history cache epoch、stream/refresh 与迟到基线。可控时钟下历史 20ms、live 2s，20ms 已显示正文，发送保持禁用，状态检查仍持续到 2s。该结果验证调度与状态，不代表真实 CLI 或实际绘制帧耗时。
- `claude-read-performance.test.ts` 8 条：一次发现、无完整文档/控制指纹读取；history 无变化零重读及追加/替换/新会话失效；头部 UUID/工作区/sidechain 拒绝；观察后控制仍计算新鲜指纹且拒绝外部占用；32 MiB 合成性能基准。
- `session-stream-read-coalescing.test.ts` 10 条：128 个重叠订阅的底层读取从 128 次降为 1 次，订阅与游标保持独立；失败重试、publish 后新读、退订/关闭、限额、轮询和 replay。
- `session-snapshot-history.test.ts` 8 条：20 次不变观察只加载历史一次，但每次核对版本；追加/替换、身份失败、读取期间变更/显式失效、引用隔离、失败重试及缓存容量。
- `session-snapshot-runtime.test.ts` 6 条：实际 Runtime 分流，live 持续新鲜、历史无变化复用、变化重读、直接分页独立、身份失效/关闭索引拒绝、version await 中关闭/清空索引，以及主动创建的 managed 会话在关闭索引后仍可观察。
- 三个旧 Claude fixture 增加新的只读 SessionReaders 接口，原安全断言和超时预算未降低。

### 合成 I/O 基准

使用隔离临时 HOME、合成 32 MiB 历史和 100 条近期消息；版本、agents、ps 返回离线合成值，未运行真实 Claude CLI，不读取用户会话或凭据。I/O 为实际 `readSync` / `readFileSync` 字节计数；不包含内核缓存命中或每项 stat 的耗时分解。

| 路径 | 读取所选 transcript | 首轮本机耗时 |
| --- | ---: | ---: |
| 旧 `#findNative` 等价参考：完整文档 + 指纹（一次身份解析） | 67,715,350 B | 115.80 ms |
| 新 live + 最新 50 条历史 | 614,400 B | 7.04 ms |
| 后续 10 次 live + 11 次 historyVersion | 5,505,024 B | 45.10 ms |

旧参考保留旧路径的语义步骤，使用当前公共读取器重现，未声称是完整旧版应用首屏。新首屏读取量较该参考降低约 99.1%；计时受本机负载影响，仅作观察，不设脆弱的毫秒阈值。后续无变化读取中全局 `history.jsonl` 重读为 0 B；头部身份与 live 安全检查继续执行。

## 检查结果

- 相关 Claude 组合（7 文件）170/170 通过；双端首屏新回归各 10/10，通过；桌面相关前端组合 4 文件 87/87，通过；Web 核心组合在新增最后一项性能回归前为 4 文件 360/360，通过，最终 Web 全量包括该性能回归。
- 第一次桌面全量发现 2 条已有 Claude Web 集成用例失败：新缓存版本检查无条件要求索引启用，误拦截索引关闭后用户主动创建的 managed 会话。修复原实现并增加正例，没有修改这两条原断言。已停止过时的失败运行及其进程树，随后以冻结源码重新执行桌面全量；不将该次中止记为全量通过。
- 修复后定向执行 `session-snapshot-runtime.test.ts` + `claude-web-backend-integration.test.ts`：2 文件、42 项通过、1 项既有原生 relay 条件跳过（38.72s）。独立复核确认纯索引会话的关闭/清空保护仍然有效。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 退出 0；lint 为 0 错误、277 条既有 warning，最终格式检查 977 文件通过。修改/新增的 7 个 `apps/desktop/test` 文件另行 `oxfmt --check` 通过；`git diff --check` 通过。验证采用临时 userconfig 设置 `manage-package-manager-versions=false`，未修改依赖、包管理器声明或超时预算。
- `pnpm test:web --maxWorkers=1`：64 文件、1399 项全部通过，128.96s。
- `pnpm --filter @agentkib/desktop test --maxWorkers=1`：退出 1，379 文件中 377 通过、1 失败、1 跳过；7357 项中 7340 通过、14 失败、3 跳过，903.97s。本轮新增 42 条桌面回归均通过，其他失败文件为 0。唯一失败文件是未修改的 `test/skill-sync-manager.test.ts`，14 条均为原 5000ms 超时，其中 activated 恢复用例伴随超时后的 `ENOTEMPTY` 清理失败；没有修改 Skills 的实现、超时或安全断言。
- 全量结束后，使用同一 userconfig、原预算执行 `pnpm --filter @agentkib/desktop exec vitest run test/skill-sync-manager.test.ts --maxWorkers=1`：退出 0，17/17 全部通过，18.23s。隔离可通过与完整组合超时分别记录，不把全量改写成一次通过；本轮没有测得组合超时的精确资源原因。
- 完整测试结束后再次核对 17 个源码/测试文件的冻结哈希，全部一致；文档和 QA 后续补记不改变功能代码。`pnpm build` 退出 0，包含 Web、桌面 Renderer、Electron 及 Backend 构建；随后 `pnpm --filter @agentkib/desktop claude:stage` 退出 0，重建插件目录，产物不纳入补丁。
- 过时失败运行的测试进程树已按本轮记录 PID 清理；最终完整测试和隔离复跑均已退出，确认原两个测试 launcher 不再存在。仅清理了完整日志中明确记录且属于本轮的失败 Skills 临时 fixture；没有删除来源不明目录或终止用户进程。没有启动 tmux 或真实用户 CLI，无需恢复系统技能。
- HEAD 保持 `7f1ad3352`，暂存区为空；只保留本轮源码、测试、会话文档和 QA 修改，原四项无关未跟踪内容保留。没有提交或推送。

## 独立复核

- 未参与前端实现的审查者检查双端历史/状态解耦、late baseline、访问身份和控制围栏，以及 stream 读取合并；未参与 Claude 实现的审查者检查轻量身份、缓存失效和控制边界；另一位检查 runtime 历史缓存及索引竞态。两处已确认的集成问题修复后分别复核关闭，目前没有未关闭的确定 finding。
- 五组约定镜像文件核对一致；`managed-control-copy.ts` 仅略去原 Locale 类型 import 后比较，四语正文完全一致。没有新增产品文案，未改 locale 文件。

## 覆盖限制

本轮性能验证使用合成 CLI 返回、合成记录和可控前端时钟，未在真实 Claude/Codex CLI、安装包、Android、Windows 或 Linux 原生系统上重新验收；不把此前真实验收算成本轮通过。没有启动用户 CLI、修改系统技能或下载发布安装包。原安全校验没有因性能优化延长占用缓存或放宽未知结果保护。

## Code Review 目标循环独立复审（2026-10-20）

- 用户明确要求创建目标，执行 review / 修复循环，结束条件为 no finding。本轮固定 `7f1ad33520156147008aa9567108406329a796fa` 为基线，审查其后 20 个未提交文件（含 8 个新增文件）；无新增提交。原有四项无关未跟踪内容不纳入。审查开始时保存完整 diff 和逐文件 SHA256 清单，三位审查者均使用新上下文，不复用上一轮实现者的结论。
- 当前 Code Review 插件可调用入口用于 PR CI 诊断；本轮未提交补丁按本机 `code-review` 技能执行规范（Standards）与需求（Spec）两轴独立并行审查，另加一位异步/缓存深查。规范依据为 AGENTS、CONTRIBUTING、DEVELOPMENT 和 UI-TERMINOLOGY；需求以本次用户指令及会话/Claude 安全文档为准。本仓库不使用 issue tracker，不为本轮新增 issue 或 PR。
- **Standards：no finding。** 覆盖 20 文件与相邻调用方，未发现确定规范违背或需要单独报告的可选 smell。独立运行 `session-snapshot-history`、`session-stream-read-coalescing`、`session-snapshot-runtime`：3 文件、24/24 通过。
- **Spec：no finding。** 核对双端历史独立展示、控制围栏、迟到响应与历史 epoch、轻量身份、控制指纹、发送/重启前占用检查、缓存失效、范围及性能表述。独立运行 Web 新历史回归 10/10，桌面历史 + Claude 读取性能回归 18/18。无 live 的 invalidate 曾列为候选；追到实际发布方和目录消费者后，确认当前会话历史失效均带 live、目录基线仍触发独立目录读取，不构成确定产品缺陷，未据此扩大修改范围。
- **异步/缓存补充审查：no finding。** 核对缓存命中前身份、索引 generation、文件版本、资源预算、subscribe/poll/publish/close/最后退订，以及访问撤销后的历史回调。独立运行桌面上述三个流/缓存文件及新历史回归：4 文件、34/34 通过。此结果与规范轴测试重叠，不相加为独立用例数。
- 第一轮完整独立复审即满足 no finding，没有为了产生修复而改动代码。本轮只追加本节 QA；17 个源码/测试文件与上轮验证冻结哈希、20 文件与本轮审查初始清单在 QA 追加前均一致。`git diff --check` 通过，HEAD 不变，暂存区为空，没有提交或推送。
- 本轮没有重新运行完整套件、构建或真实 CLI；沿用前节已实际执行的结果并保留其边界：桌面全量的 Skills 超时与隔离 17/17 通过分别记录，组合超时的精确原因仍未定位。独立审查和合成性能证据不替代真实 CLI、安装包、跨平台或系统级文件写入压力验收。

## 后续提交与 PR 授权

用户在目标完成后明确要求提交并创建 PR。以上“不提交或推送”、HEAD 和暂存区描述保留为实现及审查冻结时的快照；本次交付按新授权进行。从最新 `origin/main`（`0a4f2428b`）创建 `codex/session-open-performance`，仅纳入本轮 20 个文件，目标分支为 `main`，不合并 PR。新基线相对原审查基线的文件差异只有桌面版本号（0.18.0 → 0.20.0），沿用 main 的版本，本轮修复源码和测试保持已验证内容；本节只补充交付记录。原四项无关未跟踪内容不纳入提交，不添加 AI 署名。
