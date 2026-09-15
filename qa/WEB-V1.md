# Web v1 分层验收记录

日期：2026-09-08。设计基准：`designs/agentkib-codex-flow-redesign-v14.pen`，保留原稿。

## 验收清单（执行中）

| 范围 | 要验证的行为 | 证据/状态 |
| --- | --- | --- |
| 桌面管理 | 默认关闭、端口/HTTPS设置、错误、八位码、确认/拒绝、独立权限、撤销 | 待集成测试 |
| 配对 | 未授权不可读、等待数字一致、过期/错误/拒绝、重试入口 | HTTP 单测；浏览器待验 |
| 阅读 | 目录、空/未选中、长正文与代码、工具详情、分页位置、索引禁用清空 | Web 测试待验 |
| 控制 | idle才发送、审批精确信息、请求回执不等于完成、无停止按钮 | 隔离测试；真实待验 |
| 安全 | Host/Origin/CSRF、路径、输入、撤销竞态、断线/重启、重复/并发 | HTTP/Rust 专项测试 |
| 外观 | 390×844、768×1024、1360×860、1440×920；深浅主题、键盘焦点 | 待浏览器截图 |
| 自部署 | 打包静态资源、本机启动、配对/阅读/撤销，不使用开发服务器 | 待打包验收 |
| 真机 | 手机软键盘、Safari/Android 浏览器、外部 HTTPS | 未验证；桌面缩放不能替代 |

探索性异常场景：授权后正在读取时撤销；请求尚未完成时 runtime 重启；两个浏览器提交同一/不同请求（仅模拟 owner）。不向真实 Codex 并发发送。

本文件不把测试计划记作通过。最终结果随执行追加。

## 已执行结果

- `cargo test --workspace`：592 项通过（含 bridge 37、runtime 48）；`cargo clippy --workspace --all-targets -- -D warnings`、`cargo fmt --all --check` 通过。
- `pnpm test`：桌面 79 文件 / 529 项通过，Web 当时 17 项通过；Web 后续补 cwd / build-info 后专项 18 项通过。桌面设置局部修改后再次执行对应测试与组件约束测试通过。
- `pnpm typecheck`：桌面与 Web 通过。协议生成输出与 `electron/generated/runtime-protocol.ts` 的 `cmp` 一致，协议版本 14。
- `pnpm build`：正式 Rust runtime、Web 静态资源、桌面 renderer、Electron main/preload 均成功。
- `electron-builder --dir --publish never`：成功生成 macOS arm64 未签名 `.app`，不发布。不是 Windows/Linux 或签名/公证安装验收。
- 打包应用使用独立 `/tmp/agentkib-web-package-S9NcOH` 用户数据启动；可见 `app://bundle/index.html`，设置里默认服务关闭，启用后显示 `http://127.0.0.1:1421`，浏览器从该端口加载完整配对页。关闭服务后端口拒绝连接，退出测试 `.app` 后进程退出；没有退出 Codex。
- 此次桌面管理视觉检查发现保存按钮过宽、待授权列表缺少间距，已调整并重新构建。
- 最终 `.app` 再次启动实看：上述布局修正可见，实验开关 disabled，显示“本构建尚未通过 Web 实验控制真实验收”。Web 资源目录与 `apps/web/dist` 逐文件一致；MIT 文件与根 LICENSE 一致。`build-info.json` 标注 version 0.8.0、源码 revision 与 dirty:true，未冒充正式发布。复核后关闭隔离应用及测试浏览器。
- HTTP 测试 16 项包含在桌面总数中：配对/权限、Host/Origin/CSRF、静态路径和符号链接、过期/失败限额、HTTPS/local cookie 隔离、SSE 撤销、超时锁保留、重启/撤销竞态、发布验收开关默认禁用。
- 全 workspace 回归暴露跨进程锁释放缺陷：fork 继承描述符可能延迟仅靠 close 的解锁。修为显式 LOCK_UN 后关闭文件，并补确定性回归，不通过放宽断言处理。
- 审批安全复核加严：命令要求完整 command/cwd，文件逐项要求绝对路径、已知 kind、完整 diff；额外权限、未知字段或截断信息保持不支持。

## 浏览器（合成数据，非真实 owner）

真实 Chromium 桌面浏览器加载构建后的静态资源；四种 viewport、每种深浅主题均截图检查。截图位于 `output/playwright/web-v1/`。主代理复核了移动配对、移动阅读和 1440 宽屏阅读截图。

- 390×844、768×1024、1360×860、1440×920：阅读列、目录、输入区无页面横向溢出；长代码在自身区域滚动。
- 配对 → 等待授权 → 阅读；工具详情点击展开、Escape 关闭且焦点回触发按钮。
- 执行过程支持 Enter 折叠；分页锚点 top 从 253 变为 253.09375（偏差小于 0.1px）。
- 语言、主题、审批回执均在合成 API 场景验证；模拟结果不能代替真实 owner 验收。
- 前端详细交互证据见 `apps/web/QA.md`；合成审批使用数字 ID 42，验证 cwd 可见、拒绝回执与空闲状态，不执行任何命令。

## 未通过 / 待验证的门槛

1. 打包应用中的本机真实历史配对、读取、撤销闭环已通过，详见下方追加记录；外部 HTTPS / 手机端不在此结论内。
2. Web → runtime → 官方 owner 的串行发送已在下方隔离验收通过；Web 审批决定尚未通过。`verifiedExperimental` 默认 false，正式配置不能开启实验控制；既有 host/device grant 也无法绕过。本轮没有真实并发测试、没有停止测试。
3. 实际 iOS/Android 手机、软键盘、Safari/Firefox、外部 HTTPS 反向代理或隧道、Windows/Linux 安装包未验证。
4. 没有完整 HTTP → 实际 Rust runtime → mock owner 的单一端到端测试；当前 HTTP/mock-runtime 与 Rust/mock-owner 是分层测试。
5. 全仓 `pnpm format:check` 仍报告 4 个既有无关文件：`activity-presentation.ts`、`RemoteErrorDetails.tsx`、`RemoteErrorDetails.test.tsx`、`styles.css`。本轮相关文件与新增 Web/packages 的格式检查通过；未为清除历史问题改写无关文件。

结论：首版代码与分层自动化验证已落地，未达到计划的全量真实验收门槛。实验控制保持禁用。未 commit、PR、发布；保留原设计稿与已有改动。

## 追加：指定测试会话的打包版真实只读验收

用户确认直接使用既有“处理测试对话”。临时浏览器名为“本机验收-测试对话”，只授予历史读取；未授予发送、审批权限。没有新增对话、提交消息、执行历史中的命令或重复并发/停止实验。

- 打包 `.app` 内置 1421 服务完成八位码配对，两端校验数字一致，桌面确认后目录可见。未配对的目录请求返回 401。
- 实测发现并修复两处集成缺陷：runtime 原先连只读请求也全局拒绝并发，页面同时加载历史/live/SSE 会失败；现在最多 32 个只读请求串行处理，控制仍需空闲且不排队。另一个问题是把 Codex 原生 UUID 当成文件路径，现由 provider 解析实际记录，预算内核验 UUID 与索引一致，无法核验则降级只读。
- 新增队列上限/控制拒绝回归，以及 provider UUID 映射、缺失、身份不一致、预算超限、非元数据记录回归。runtime 49 项、相关 provider 测试、Clippy 通过；修复后再次 `cargo test --workspace`、格式与 diff 检查通过。
- 复测期间发现快捷键退出没有真正结束旧包进程，因此不以快捷键调用作为重启证据。通过精确 PID 终止隔离验收包并确认退出，再启动最终未签名包；新进程加载后配对授权保留，无需重新配对。没有退出 Codex。
- 最终包中打开同一测试会话：真实历史成功，实时状态为空闲、浏览器仅可读取；展开执行过程和工具详情正常，Escape 关闭详情；加载更早记录后可见 `AK-BRIDGE-001 收到`，读取错误消失。历史内旧审批/停止结果仅作为阅读内容，不算本轮控制验收。
- 在真实会话已打开且 SSE 已订阅时，桌面撤销临时浏览器，Web 立即显示“远程访问已结束”，目录、会话、审批内容不可见；刷新仍保持访问结束，桌面授权列表为空。
- 关闭本机 Web 服务后端口不再响应。无协调服务器或开发服务器参与此闭环。

真实发送/审批尚未通过 Web 验收，发布验收开关仍为 false；不能将本轮只读通过等同于实验控制通过。

## 追加：2026-09-08 本地隔离控制验收

- 增加仅由进程环境显式开启的验收入口：必须使用系统临时目录下 `agentkib-web-acceptance-*` 的独立 electron/runtime 数据目录、指定 64 位索引 ID，且不允许外部 HTTPS origin。不是浏览器可开启的设置，不改变正式 `verifiedExperimental=false`。桌面明确显示隔离验收及会话 ID；HTTP 拒绝其他会话的控制，仍核验配对、独立发送/审批授权、CSRF、owner 和 revision。
- 使用同一个官方 UUID `01a07b7a-68a8-7113-832f-36d1ddd5594f`（处理测试对话）。隔离用户数据会产生不同的盐化索引 ID，因此从实际目录核对映射，不复用原用户数据的索引 ID。
- 首次发送 `AK-WEB-SEND-023` 返回 HTTP 409；立即暂停控制，未重发。只读历史未出现该标记；三次 idle 查询却依次为 revision 181/182/183。根因是 refresh 使用 select 反复取消/建立订阅，官方 owner 首次添加 follower 会发布递增版本快照。
- 核对本机已安装官方 ASAR 的 `handleThreadStreamFollowingChanged`：重复确认已有 follower 会发送当前 revision 的快照。因此修为保留原 stream，在 discovery 回调接收通知并校验 owner 不变，再确认已有订阅、等待完整快照。仅接受同版本且完整 JSON 相等的重复快照；相同版本的变更/patch、回退、baseRevision 缺口仍失效。同版本快照不能清除 OutcomeUnknown。协议无因果 nonce，不声称该刷新消除官方客户端竞争。
- 修复后重建正式 release runtime 并装入未签名 macOS arm64 `.app`；没有使用开发服务器。三次真实只读查询均为 idle/revision 417。
- UI 串行发送 `AK-WEB-SEND-024`：HTTP 200、accepted:true、completed:false；随后真实历史恰好出现一条 user-message 和一条 final_answer `AK-WEB-SEND-024 收到。`，共享同一 turn_id。页面回复可见一次，live 回到 idle/revision 439，无工具调用、无重复提交。
- UI 串行提交 `AK-WEB-APPROVAL-025`，正常申请 `/tmp` 下 `/usr/bin/true` 的审批；发送回执 HTTP 200。live 到 awaiting-approval，命令/cwd 可见，但 safe_approval 投影为 supported:false / availableDecisions:[]。未通过 Web 提交决定、未放宽白名单、未执行替代命令。具体不支持字段仍需诊断，不能仅凭命令可见推断可安全批准。
- 用户在官方客户端拒绝后，只读确认 pending=0、idle；最终回复为“AK-WEB-APPROVAL-025：审批被用户拒绝，命令未执行，未重试。”这证明状态/结果同步，不代表 Web 审批决定通过。
- 自动化：bridge 41 项（新增稳定刷新、同版本冲突、owner 切换、discovery 期间 patch 等回归）；`cargo test --workspace` 598 项通过；相关 bridge/runtime Clippy、cargo fmt、git diff 检查通过；Web HTTP/验收配置/桌面设置 3 文件 21 项通过。新增模拟用例初版错误构造 active 但无 active turn，触发预期的 OutcomeUnknown；修正 fixture 后全部通过，未放宽状态判定。
- 收尾：撤销“本机串行控制验收”浏览器，关闭实验控制及本机 Web 服务。正式控制仍关闭，无 commit/PR/发布。

剩余门槛：Web 审批请求元数据兼容及真实决定验收；mutation 超时后 bridge 重建是否会清除未知结果保护仍需独立回归；HTTPS/真实手机及其他平台仍未验收。不可将本次串行发送通过写成 Web 全量通过。

## 追加：提交后继续加固（2026-09-08）

- 首版及前述验证提交为 `d683407`，未 push；设计稿、设计 QA 和无关产物未纳入。
- runtime 增加独立于 bridge 缓存的会话级未知结果保护。桥接控制调用报错后，本次 runtime 启动期间禁止该会话再次发送/审批；live 返回 outcome-unknown，历史读取保留。缓存重建、不同请求 ID、权限重开不能清除；明确回执成功才解除调用期标记。为安全起见，桥接内的发送前错误也会保守锁定，不将错误猜为“可重试”。旧 boot 请求在重启后仍拒绝，不自动恢复执行。
- Web 四语提示说明运行期控制禁用，不再误导用户仅“打开官方会话”即可恢复。
- 025 历史没有保存原始审批 params，无法证明具体阻断字段。已安装官方代码存在策略修改提案，与一次允许不同；未直接扩大白名单。API 补充 unsupportedReason 和有界的未知字段名称/类型，不返回字段值，不写原始审批日志；模拟测试确认策略提案仍不可批准。
- 新增 runtime 保护记录跨缓存清理/新请求 ID 的回归、未知审批诊断不泄露字段值的回归，以及 Web 禁用提示/发送按钮回归。本轮没有新增真实消息或审批，未重启官方 Codex。
- 限制：尚未完成 HTTP→真实 runtime→模拟 owner 的超时整链测试，运行期保护不声称跨主机重启持久化。审批实际参数的下一次串行验收和外部 HTTPS/手机仍待验证。
- 本次增量验证：runtime 51 项、Web 19 项通过；`cargo test --workspace` 通过；runtime Clippy、全 Rust 格式、相关前端格式、桌面/Web 类型检查、Web 构建和 `git diff --check` 通过。此批加固保留为未提交修改，尚未重新打包进行真实控制验收。

## 追加：026 审批字段诊断与请求不确定性加固（2026-09-08）

- 重建 release runtime、Web、Electron 和未签名 macOS arm64 安装目录，在独立验收数据目录运行；未退出或重启官方 Codex。正式实验能力仍默认关闭。
- Electron HTTP 层新增独立会话 fence：控制超时、RPC 错误、已观察到的浏览器断线后，即使 runtime 晚到成功或 runtime 重启，新请求 ID 也不能再次控制同一会话；live/SSE 投影为 outcome-unknown。其他会话不受影响。只有当前 boot 的明确 accepted 回执成功写出才解除；HTTP finish 不证明浏览器收到，不能据此自动重发。此保护不跨整个桌面进程重启持久化。
- Web 审批弹窗核验完整当前审批投影，而不只是 requestId/turnId。弹窗打开后命令等内容变化时隐藏决定按钮，提交前再次核验，避免用新 revision 批准未审阅内容。
- 同一指定测试会话串行发送一次 AK-WEB-APPROVAL-026，HTTP 200 accepted:true。真实待审批显示 `/bin/zsh -c /usr/bin/true`、cwd `/tmp`；未通过 Web 提交任何审批决定。安全投影阻断四个非空字段：environmentId:string、kind:string、proposedExecpolicyAmendment:array、startedAtMs:number。诊断未输出未知字段值。
- 用户确认在官方客户端拒绝后，只读 live 返回 HTTP 200、idle、pending=0。撤销“本机审批诊断验收”浏览器后，页面显示“远程访问已结束”；随后关闭实验控制和 Web 服务。
- 使用本机安装版本 codex 的 `app-server generate-json-schema --experimental` 离线生成协议定义（没有启动 owner 探针）：kind 枚举为 command/writeStdin，缺失默认 command；environmentId 是命令执行环境；startedAtMs 是 Unix 毫秒时间；execpolicy proposal 是未来相似命令免审批提案。accept 与 acceptWithExecpolicyAmendment 明确不同。当前 bridge 尚无执行环境绑定校验，因此未直接放宽白名单，Web 真实审批仍未通过。
- 自动化：HTTP 20 项、Web 19 项、桌面/Web 类型检查、Web 构建、git diff --check 通过。断线测试首次全量执行暴露测试同步竞态：本地 close 不等于服务端收到断线；改为观察服务端 close 后模拟晚到回执，全量 20 项通过，安全断言未放宽。
- 最新审批弹窗防护已通过测试和 Web 构建，尚未重新纳入打包应用实测。真实手机、外部 HTTPS、其他平台和整链 mock owner 验收仍待完成；本轮不声明全量通过。增量未提交、未发布。

## 追加：审批元数据的版本化兼容（2026-09-08）

- 上一批保护提交为 `10bdc66`，未 push。提交后全前端回归：桌面 534 项、Web 19 项；Rust workspace 测试通过，协议生成无差异。
- 先前仅凭安装包 schema 无法证明执行环境的本地含义。本次进一步核对安装 CLI 版本 `0.153.4` 对应的[官方版本源码](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/environment.rs)：`LOCAL_ENVIRONMENT_ID` 为 `local`，`from_snapshot` 与 `validate_environment_id` 拒绝远程环境占用该 ID；`Environment::local` 使用 LocalProcess。此证据取代字符串猜测；未知版本仍受原有安装版本门禁限制。
- 命令审批只兼容明确 `kind=command`（缺失遵循旧协议默认），拒绝 writeStdin/未知/错误类型；startedAtMs 必须为非负安全整数；非空 environmentId 只接受保留的 local，其他环境继续禁用。已有缺失/null 环境字段兼容行为保留，不据此显示“本机”。
- 候选 execpolicy 规则按有界字符串数组验证并完整展示，四语明确标注“未授权、允许一次不保存”。仅提供 owner 已支持的一次性 accept/decline/cancel，不提供 acceptForSession、持久 execpolicy 或网络规则操作。额外权限和未知字段继续禁用。
- 增加错误类型、未知环境、终端输入、超大时间戳、持久决定过滤等 runtime 回归，以及 Web 候选规则/环境显示测试。最新真实审批结果将在完成后追加，不将模拟测试写成实际审批通过。

### 027：打包版真实一次性命令审批通过

- 隔离 macOS arm64 包重新配对“本机审批兼容验收”，两端校验数字相同，分别授予发送/审批，仅指定原测试会话可控制。
- 提交前 live 为 idle、pending=0。只发送一次 AK-WEB-APPROVAL-027（正常申请 `/tmp` 下执行一次 `/usr/bin/true`），发送回执 HTTP 200 accepted:true。
- owner 待审批投影显示 command `/bin/zsh -c /usr/bin/true`、cwd `/tmp`、environmentId local、候选规则 `["/usr/bin/true"]`；supported:true，实际可选决定只有 accept/cancel，未显示不存在的 decline。
- 从 Web 弹窗点击一次“允许一次”：审批 HTTP 200、accepted:true、completed:false；未发送持久规则决定。随后 live idle、pending=0；同一 turn_id 下恰好一条用户请求和一条 final_answer“AK-WEB-APPROVAL-027：审批通过，已执行一次，退出码为 0。”，exec/wait 工具摘要均 completed。
- 此结论仅证明当前安装版本、本机一次性命令批准链路。取消轮次、文件变更审批、外部 HTTPS、实际手机和其他平台不能据此标为通过；正式实验验收开关仍为 false。
- 撤销临时浏览器后页面显示访问结束，关闭实验控制与 Web 服务。没有重启 Codex，没有并发真实请求、没有停止实验。

### 界面收尾与验证

- 真实截图发现候选规则复用了横向 `.info` 布局而被挤压；改为纵向排布。修复 awaiting-approval 被写成“状态未确认”，以及仅有审批权限却显示“仅可读取”的文案。
- 最新打包静态资源用独立 Chromium 合成 API 检查；全部 API 被本地 fixture 拦截，控制返回拒绝，不接真实 owner。390×844、768×1024、1360×860、1440×920 的深浅主题均无 dialog/候选规则横向溢出。Escape 关闭后焦点回审批入口。主代理查看 1440 浅色与 390 深色截图；截图见 `output/playwright/web-v1/approval-final-*.png`。桌面 viewport 不是实际手机验收。
- 最新增量 runtime 52 项、Web 19 项通过；runtime Clippy、Rust 格式、相关前端格式、桌面/Web 类型检查、完整 build 与未签名安装目录打包通过。最后权限文案经 Web 测试和构建后重新打包，未额外重发真实审批。保留未提交增量，不发布。
- 最终增量再次运行 `cargo test --workspace --quiet`、全 workspace/all-targets Clippy（`-D warnings`）通过；验收服务关闭后 1421 不再响应，隔离应用与两个验收浏览器均结束，官方 Codex 保持运行。
