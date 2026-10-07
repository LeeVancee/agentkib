# TypeScript 后端稳定性与 MCP 归属修复 — 2026-10-07

## 记录状态与源码

本文件是本轮验收的独立记录。自动化与打包结果按固定提交记录；原生或窗口流程未执行的部分单列，不计入通过。后续结果追加在此文件，不覆盖旧 QA 的失败或版本边界。

本文用环境占位符表示本机目录：`$AGENTKIB_CHECKOUT` 为本轮 AgentKib 工作树根目录，`$NODE22_BIN` 为独立 Node 22.23.3 darwin-arm64 的可执行文件目录，`$EVIDENCE_DIR` 为本轮权限受限的证据根目录，`$TEMP_DIR` 为原始运行日志所在的系统临时目录。相对文件名、版本、哈希与证据归属均保留。

- 源码基线：`bdd05c9def7b6cad325d166e33f4014e723bd724`。首轮生产实现固定于 `5a7a5ba8d4b3368b79b618b5a28b9189f4710d4b`；测试修复 `6147e87d4`，Windows 诊断 `1bcd04467` / `c83684b67` 不改生产实现。后续提交与验证见收尾记录。
- 分支：`codex/typescript-stability-20261007`。
- 工作树：`$AGENTKIB_CHECKOUT`。
- 本轮开始时新工作树干净；本机整合检查在提交前 dirty 源码上运行，随后固定为 `5a7a5ba8d`。原始 dirty patch、status、构建哈希已封存到本轮证据目录；不能把该次检查误记为基线通过。
- 本地命令使用独立 Node `22.23.3`、pnpm `10.8.1`。Node 路径为 `$NODE22_BIN`，通过命令前置 `PATH` 选择；未替换用户的 Agent 安装或凭据。
- AgentKib 已创建 [PR #100](https://github.com/starroyhq/agentkib/pull/100)。独立 backend 已提交、推送并创建 PR，见下文。没有合并、部署、发布、覆盖已安装的 AgentKib、新增生产依赖或数据库结构。

## 证据分层

| 证据层级                            | 本轮状态                 | 能证明的范围                                                                             |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| 历史 Rust / 原生 Agent QA           | 保留原结论，不重新计通过 | 仅适用于各记录注明的源码、二进制、Agent 版本与方向                                       |
| 当前 TypeScript 定向自动化          | 以下已运行项目通过       | 本轮生产实现的可观察行为、真实 Store/Hub、后台进程与 Worker 隔离                         |
| Node 22 构建产物原生绑定            | 通过                     | 当前 `dist-electron` 三个后端入口存在，Worker 能直接加载 staged Koffi 并调用本机原生 API |
| Electron utilityProcess 与 Worker   | 主代理本机烟测通过       | Electron `44.0.0` / 内置 Node `24.18.1` 下的两个 Worker 通道；不等同安装包验收           |
| 新 TypeScript 候选安装目录 / 安装包 | 分层结果见收尾记录       | 七平台打包通过；候选内部后端/Worker另列，完整GUI、升级及原生续接未通过                   |
| Windows / Linux 当前变更的 CI       | 远端已执行，见收尾记录   | macOS 结果不外推 Windows/Linux；原生界面与手机仍分别验收                                 |

例如 [9 月 30 日主线验收](main-acceptance-2026-09-30.md)、[历史互通方向矩阵](interop-matrix-2026-09-28.md)、[Codex 真实回复](codex-deepseek-completion-2026-10-01.md) 均保留原始意义。旧记录中的 Rust Runtime 检查、历史工具数量或真实回复不能替代本轮 TypeScript 执行器、恢复流程及候选包的新验收。

## 本轮实现与定向验收

### MCP 工作区与归档归属

- 新连接仍使用唯一注册 ID；唯一 legacy manifest URL 可兼容同一物理工作区。`SessionDocument`、归档及操作文件格式不迁移。
- 旧归档 namespace 被多个注册工作区共享，或与另一工作区注册 ID 冲突时，拒绝归档读取、长历史写入与歧义操作恢复。普通 registered MCP 工具目录和工具仍可使用。
- Hub 在每次归档调用重新核对归属，不能因初始化连接早于另一 clone 的登记而继续读取。
- 注册路径及连接建立时的规范路径使用词法快照比较；目录被移动并替换为链接、登记被改到其他路径时，旧连接不能重绑定到新目录。
- 长历史走真实 connection plan/apply → prepare → handoff plan/apply → Hub `session_search` / `session_read_chunk`，保留原来源指纹与归档哈希校验。
- 不宣称旧归档格式能证明已经删除登记记录的历史 clone 归属，也不提供跨进程原子身份锁。

### Agent Home 与 profile

- Hermes MCP 与原生导入共用 `HERMES_HOME` / `active_profile` 解析；直接选择 profile Home 也保留同一语义。
- OpenClaw MCP 使用有效 `OPENCLAW_HOME`、`OPENCLAW_PROFILE`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 选择目标，不固定写默认 Home。
- 规划与 apply 共用解析，并在写前重新检查当前目标。项目内的自定义 Home，以及与其他 Agent 固定配置白名单重叠的目标，均不能绕过 profile 漂移检查。
- 无关 Agent 的损坏 profile 不阻断当前 Agent 的有效配置。显式相对路径、未解析变量、无效 profile、目录链接和过大的 profile 文件拒绝写入。

### 后台执行与恢复

- TypeScript Skills 顺序 Worker、8 个等待请求、总期限、网络取消、退出等待本地写入、回执唯一性与普通请求响应时间，已由下列本机自动化覆盖。
- 会话交接执行器专门回归 **5/5 通过**：真实 1.8 秒哈希及慢 CLI 期间普通 Runtime、工作区与会话请求均在测试要求的 1 秒内响应；验证 FIFO 8+1、Worker 崩溃不重放、退出单回执，以及无限 CPU 只读 Worker 在 300 毫秒期限被取消后新请求重建。原生导入恢复 **3/3 通过**：丢响应/回执后的多次恢复只导入一次、外部修改拒绝并保留现场、归属碰撞拒绝。Cursor 原生恢复 fixture **6/6 通过**。这些自动化不替代原生客户端或模型回复验收。
- Electron `utilityProcess → Backend → Skills Worker` 烟测覆盖隔离 Skill 的 inventory、preview、导入、实际文件校验及 shutdown；`utilityProcess → Handoff read Worker` 覆盖 `node:sqlite` 与真实交接文件路径校验。未启动真实 Agent CLI 或调用模型。

## 已实际执行的命令

以下命令均在本轮工作树使用 Node 22.23.3 运行；Electron 烟测由脚本启动锁文件固定的 Electron，其内置 Node 版本单独记录。最终原始命令日志与本地 bundle SHA256 已封存于 `$EVIDENCE_DIR`（目录权限 0700）；候选安装包和远端 CI 身份见后文固定提交记录。

| 命令                                                                                                                                                                    | 结果与边界                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git rev-parse HEAD` / `git status --porcelain=v1`                                                                                                                      | 本机整合测试时基线为 `bdd05c9de…` 且 dirty；生产实现后固定为 `5a7a5ba8d`                                                                                                                                                                            |
| `node --version` / `pnpm --version`                                                                                                                                     | `v22.23.3` / `10.8.1`                                                                                                                                                                                                                               |
| `pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts` | **4 文件、166 项通过**；其中新增 21 项，原有 145 项继续通过                                                                                                                                                                                         |
| `pnpm test:backend:stability`                                                                                                                                           | 初版 **4 文件、35 项通过**；纳入 handoff、原生导入和 Cursor 恢复后，最终 **7 文件、52 项通过**，staged Koffi smoke 同时通过。原始运行日志 `$TEMP_DIR/agentkib-stability-ci-local.log` 已纳入上述证据目录；与其他测试命令有重叠，不能相加作为独立覆盖数量 |
| `pnpm --filter @agentkib/desktop exec vitest run test/handoff-executor.test.ts`                                                                                         | 主代理实测 **5/5 通过**                                                                                                                                                                                                                             |
| `pnpm --filter @agentkib/desktop exec vitest run test/native-import-recovery.test.ts`                                                                                   | 主代理实测 **3/3 通过**                                                                                                                                                                                                                             |
| `pnpm --filter @agentkib/desktop exec vitest run test/cursor-native-recovery.test.ts`                                                                                   | Runtime 子代理实测 **6/6 通过**                                                                                                                                                                                                                     |
| `pnpm test`                                                                                                                                                             | 最终整合轮 **通过**：桌面 **164 文件、1995 项**，Web **34 文件、610 项**                                                                                                                                                                            |
| `pnpm build`                                                                                                                                                            | 最终整合轮 **通过**；不等于候选安装目录验收                                                                                                                                                                                                         |
| `pnpm typecheck`                                                                                                                                                        | 最终整合轮 **通过**                                                                                                                                                                                                                                 |
| `pnpm format:check`                                                                                                                                                     | 最终整合轮 **638 文件通过**；后续本 QA / 文档补充另做局部核对                                                                                                                                                                                       |
| `node .github/scripts/smoke-test-backend-native.mjs`                                                                                                                    | **通过**，macOS arm64；读取构建目录中的 Koffi，Worker 原生 `getpid` 返回当前进程 ID，无 `node_modules` 回退                                                                                                                                         |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs`                                                                                                                | **主代理实测通过**，Electron `44.0.0` / Node `24.18.1`；两个 utilityProcess/Worker 通道均完成退出                                                                                                                                                   |
| `pnpm --filter @agentkib/backend typecheck`                                                                                                                             | **通过**；最终全仓 typecheck 亦通过                                                                                                                                                                                                                 |
| `pnpm build:web:hosted`                                                                                                                                                 | **通过**，生成 `apps/web/dist-hosted`；保留路由生成器的循环依赖 warning，未发布产物                                                                                                                                                                 |
| `pnpm exec oxlint packages/backend/src`                                                                                                                                 | 退出码 0；初次纳入时有 14 条 warning，包含本轮新增 unused 与既有告警，不能记录为零告警                                                                                                                                                              |
| `pnpm lint`                                                                                                                                                             | 最终退出码 **0**，**78 warnings**；同一目录集与同一 oxlint 对 `git archive bdd05c9de` 基线得到 **80 warnings**，本轮未新增告警，不声称零告警                                                                                                        |
| 三份 CI YAML 解析检查                                                                                                                                                   | `ci.yml`、`linux.yml`、`windows-x64.yml` 解析通过，仍为 `contents: read`                                                                                                                                                                            |

初次单独检查 backend 得到 14 条 warning。收尾清理旧 import 等无行为影响项后，全量 lint 按相同目录集与工具和基线比较为 80 → 78；`cursor-ide-sessions.ts` 的旧 `readBase64` 在基线已存在，不归为本轮新增。既有告警涉及 Skills / MCP 的正则、`skill-manager.ts` 与 `web-read.ts` 的 unused、Antigravity 的 unused/finally、`agent-tools.ts` 的转义及桌面旧告警。本轮不通过吞异常、削弱断言或禁用 lint 规则获得通过。

并行实施时曾在尚未完整落盘的 `skills-worker.ts` / `handoff-work.ts` 遇到语法检查失败；文件写完后定向检查通过。新测试曾因权限错误文案匹配和版本探测 spy 的预期不符失败，已修正测试边界：明确阻止真实命令解析，保留实际业务断言；最终 166 项结果覆盖这些用例。

## 独立审查与 CI

MCP 独立审查发现并修复：无关 profile 阻断、项目内 Home 白名单绕过、目录链接导致旧路径快照被重新解析。目录链接的独立最小复现修复前失败、修复后 **1/1 通过**；上述正式回归同时覆盖。Runtime 独立审查的三项问题亦已修复并复核，当前未发现剩余确定缺陷；原生候选包及 Windows/Linux 验收仍须单列。

根 lint 已加入 `packages/backend/src`；主 CI 新增 hosted Web 构建。Ubuntu ARM64、Fedora x64、Windows x64 / ARM64 的现有 job 名保持不变，新增后端构建、staged Koffi Worker 烟测与精确回归列表。handoff-executor、native-import-recovery 和 cursor-native-recovery 三份新回归已在文件落盘后纳入精确列表。首轮远端 Linux 两任务通过；Windows x64 经路径 fixture 与 DLL 清理修正后通过，ARM64 暴露既有私有身份 ACL 的 FFI 参数问题，诊断与后续修复单列。

现有 `release-desktop.yml` 的空 `release_tag` artifact-only 构建、Linux 包检查与 Windows 安装器 smoke 保持原样；本轮没有放宽签名、发布或安装包验收门槛。

## 独立 backend 交付与剩余门槛

私有 [agentkib-backend PR #1](https://github.com/starroyhq/agentkib-backend/pull/1) 的固定提交为 `699b864a6f3f805098803a95b0841d3ac94fa164`，16 个文件，包含无邀请码注册、回归与脱敏部署说明；独立审查无剩余确定缺陷。该交付不计作本仓库 TypeScript 执行器或原生桌面/Web 验收。

注册只需用户名和密码，新账号固定默认 3 台设备；已有账号配额、密码策略、限速、恢复码、TOTP、桌面 PKCE、设备邀请和八位远控授权继续保留。没有新增生产依赖、数据库迁移或远控协议。旧 `signupCode` 及客户端伪造 `deviceLimit` 不授予额外配额。

独立 backend 的本轮命令使用 **Node 22.23.2 / pnpm 10.8.1**，不与本仓库的 Node 22.23.3 混记：

| 实际命令                                                                                                  | 结果与边界                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                          | 通过；锁文件最终无差异，未升级依赖                                                                |
| `pnpm test`                                                                                               | 59 项：47 通过，12 opt-in 跳过，0 失败                                                            |
| `AGENTKIB_DESKTOP_SOURCE="$AGENTKIB_CHECKOUT/apps/desktop/electron/main/account/service.ts" pnpm test:db` | 59 项：57 通过，2 隧道 opt-in 跳过，0 失败；实际 `DesktopAccountService` 来自主仓基线 `bdd05c9de` |
| `pnpm test:account-web`                                                                                   | 14/14 通过；真实 `app.mjs` 的四语言注册、恢复码、密码重置与未知结果不重试                         |
| `pnpm build:account-web`                                                                                  | 通过；八个产物与先前已部署 ZIP 字节一致                                                           |
| `node --check services/relay/src/accounts.mjs` / `git diff --check`                                       | 通过                                                                                              |

DB 回归使用 loopback 临时 PostgreSQL 17 容器（结束已删除），覆盖无邀请码注册、用户名并发唯一性、配额、账号持久化、实际桌面 HTTP/PKCE 回环、旧设备认领、登记、凭据隔离及退出。安全存储使用隔离加密实现，不是系统钥匙串验收；FRP 和完整 Compose 隧道 opt-in 项未重跑。

**部署与本轮复核分开记录：**2026-10-03 的历史回执包含已验证镜像切换、无迁移、API 健康及账号页面部署；2026-10-07 没有再次部署或提交生产注册请求。本轮以 `curl --fail --silent --show-error --max-time 20` 读取账号站点 `/`、`/app.mjs`、`/config.mjs`、`/core.mjs`、`/icon.svg`、`/locales.mjs`、`/styles.css`，七项与部署 ZIP 和本轮构建逐字节相等。另以严格 TLS 的 25 秒 GET 取得 `https://api.agentkib.com/healthz` 的 `{"ok":true,"protocolVersion":2}`。没有登录生产宿主重新取得镜像，也没有创建生产测试账号。

因此可说明注册页面为已部署的开放注册版本、公开 API 可达；不称账号生产全验收。成功生产注册、安装版 Electron/系统浏览器/钥匙串闭环、真实手机公网配对及控制、生产故障与备份恢复仍未验收。完整 backend 命令与证据见该提交的 `docs/acceptance/2026-10-07-open-registration.md`。

剩余原生门槛与证据边界见下文；固定提交、原始 dirty 指纹、候选包身份和当前 Windows/Linux CI 已分别保留。不将真实手机、真实 Agent 新单轮回复、完整 GUI 或真实模型驱动的 Skill/MCP 流程计作通过；后文原生离线检查使用本机模型模拟边界，分开报告。本轮不签名、公证、发布或部署。

## 固定提交打包与原生边界补充

- artifact-only [运行 37571379230](https://github.com/starroyhq/agentkib/actions/runs/37571379230) 固定 `5a7a5ba8d`，`release_tag` 为空：校验、macOS arm64/x64、Windows x64/arm64-preview、Ubuntu x64/arm64-preview、Fedora RPM 全部成功；Publish GitHub Release 跳过。未创建发布。
- `6147e87d4` 修正 Windows fixture 的路径快照（native realpath）及子进程结束后再删除加载中的 Koffi DLL；生产路径身份检查保持不变。`c83684b67` 的 Linux ARM64/Fedora 已通过，Windows 诊断不代替测试。
- Windows ARM64 的原 `SetFileSecurityW` 通过 Koffi 调用返回错误 5；相同机器、SDDL、管理员 token、原 Home/隔离 Home 的独立 C# P/Invoke 全部成功。即时错误与 LocalFree 后错误均为 5。x64 两种实现均成功。原日志保留在 `agentkib-windows-acl-{x64,arm64}-1bcd044.*`，不能归因为测试 Home 或跳过 ACL。
- 当前 Claude `2.1.286` 的原生 `mcp list` / `mcp get agentkib`，在隔离 HOME/配置及本轮 Backend 实际 plan/apply 生成的项目配置上均返回 **Connected**。网络 sandbox 只允许该临时 Hub 的 loopback 端口，真实模型请求为 0。命令、CLI SHA256、输出和隔离规则保存于证据目录 `native-claude-mcp/evidence-manifest.json`。此项证明原生发现和握手，不证明真实模型执行了工具。
- **真实模型驱动**的 MCP/Skills 用例未执行：当前代理链重试配置不满足单次要求，已有 live 验收器也拒绝 tools 且 safe-mode 禁 MCP/Skills。后者是验收器合同缺口，不是环境缺少功能。后续已独立完成真实 CLI/Hub、Skills 加载的本机 mock 边界检查，详见下文；这些检查不接真实 provider，不能替代完整代理链或真实模型结论。
- 源码 Electron 完整窗口首次启动在 45 秒内未到 `home-data-ready`；栈为 `SecItemAdd_osx → KeychainCore::ItemImpl::doAdd → StorageManager::makeLoginAuthUI → AuthorizationCopyRights`。栈显示停在系统钥匙串授权路径，推断正在等待授权；未验证完成授权后的启动，也未绕过钥匙串或报告首页通过。无模型调用；系统中原安装版进程保持运行。
- 隔离 schema-15 合成数据库经当前后端两次启动，工作区与 memory 保留、源快照不变；只证明合成旧结构兼容，不冒充真实个人数据副本或 GUI 验收。证据 `source-backend-legacy.json`。

### Windows ARM64 定位与修复

`c83684b67` 的同机对照确认：负数 `-2147483644` 经 Koffi 的 8 次调用全部失败（错误 5），正整数 `2147483652` 的 8 次调用全部成功；独立 P/Invoke 也全部成功。原 Home 与隔离 Home 一致，目录/打开中的文件/已关闭文件一致。成功后的独立 .NET ACL 读取确认仅 OWNER_RIGHTS 的 FullControl，DACL protected，未增加用户或组。

生产修复固定在 `80f6a2209f2f1146c6bb08957122a69d4844424c`：保留同一 `0x80000004` 位模式，以正整数传入 SECURITY_INFORMATION；失败错误在 LocalFree 前读取。SDDL、路径限制、权限范围及失败拒绝不变。新增实际 identity 创建/回读/重载、目录/文件权限、缺失路径拒绝与错误码污染回归，已纳入永久后端 CI；临时诊断 step 已移除，复现 probe 保留。

- 独立子代理审查通过；本机定向 8 文件 **54 通过、1 项 Windows 专属跳过**，backend build、全仓 typecheck、局部 format/diff 检查通过。
- 此提交新的 [artifact-only 运行 37573042394](https://github.com/starroyhq/agentkib/actions/runs/37573042394) 未填写发布 tag；产品修复后的 Windows 原生 CI 已通过，详见下文；artifact-only 最终结果另列，诊断 probe 的成功不代替产品 CI。

### 首轮候选与原生配置发现

`5a7a5ba8d` 的 macOS arm64 artifact ID `11461016472`，名称 `agentkib-desktop-macos-arm64`。保留仓库已有版本 `0.15.1`，本轮未调整版本。下载后全部四份 SHA256 文件核对成功：

- ZIP `44e543a29d7aac77ac58323473f650dd3c474e1e4939fc934105719452488ce5`，139,316,671 bytes。
- DMG `6f06eb208fbd8564ac5a5ff6a2d1d2063e4dd22b9c0753b5e83cd107068418e9`，144,827,383 bytes。
- 隔离解压位置：`$EVIDENCE_DIR/candidate-5a7a5ba8d/AgentKib.app`；与系统应用目录隔离。
- `codesign --verify --deep --strict` 返回 `code has no resources but signature indicates they must be present`；display 为 Electron linker-signed adhoc、无 TeamIdentifier/Sealed Resources。artifact-only 未注入正式签名和公证配置；本轮未重签或将其计作签名通过。

Codex `0.155.1` 在隔离 CODEX_HOME/项目中执行 `mcp list --json` 与 `mcp get agentkib --json`：原生未信任项目时忽略项目配置；只在临时 Home 信任该 fixture 后，精确发现本轮 Backend 生成的 streamable_http URL 且 enabled=true。sandbox 拒绝全部网络，模型请求 0；因此仅证明原生配置发现，**不是 MCP 连接或工具调用通过**。证据 `native-codex-mcp/audit-result.json`；不能由此提升当前交接门限。

### 修复后 CI、候选和旧库验证

生产提交 `80f6a2209` 的 [主 CI](https://github.com/starroyhq/agentkib/actions/runs/37573037730)、[Linux](https://github.com/starroyhq/agentkib/actions/runs/37573037635)、[Windows](https://github.com/starroyhq/agentkib/actions/runs/37573037622) 共五项检查通过：

- 主 CI：桌面 **165 文件、1987 通过、11 平台跳过**（总 1998，不能把总数写为全部通过）；Web **34 文件、610 通过**；format/typecheck/build/hosted build 通过，lint **78 warnings / 0 errors**。
- Windows x64 与 ARM64 各实际执行 staged Koffi Worker smoke、private identity 原生 ACL **3/3**、八文件后端稳定性 **49 通过、6 平台跳过**。独立 .NET 读取核对 protected OWNER_RIGHTS ACL；并非 mock 绕过修复。
- Ubuntu ARM64、Fedora x64 均通过后端构建、native smoke 与相关回归。对应原始 CI 日志保存到本轮证据目录，以 `80f6a2209` 命名。

**实际已安装旧库的只读副本：**通过 SQLite read-only + query_only online backup 取得独立快照，原快照为 0400；当前 `BackendStore` 只在单独工作副本运行，没有启动扫描、MCP、Electron 或 Agent CLI。子进程使用隔离 HOME，macOS sandbox 禁网、拒绝副本工作目录外写入，并先以真实越界写负例验证拒绝。

旧库 **34 张原表、44 个工作区**经当前 Store 两次读取通过，原快照哈希不变。原表的所有字段和行均按规范化内容哈希核对；仅在旧 `codex_session_classification_revision != 3` 时，允许既有迁移明确执行的逐行 `agent=codex` 的 `last_success_at→NULL`。metadata 不是按前缀放行，而是根据原生 Codex 行精确推导 pending/stale 的 key/value，以及 revision=3；1337 个变化均符合预期。新增的两张 collection 缓存表行数均为 0。已迁移副本另一次重开亦通过（36 表、44 工作区），不会强制再次置空缓存。

结果与 Store 源码/构建 hash、revision/dirty 记录保存在 `installed-database-read-final/report.json`；真实数据库备份仅留权限受限的本地证据目录，不提交仓库。本项只验收 Store 的读取和迁移，不代替完整窗口或真实路径扫描。

**首轮实际 CI 候选 `5a7a5ba8d`：**通过 `qa/probes/smoke-typescript-source.mjs --app ... --mode backend` 两次恢复合成 schema-15 的工作区和 memory，原快照未变，证据 `candidate-5a-backend.json`。完整 GUI 第一次在 45 秒启动期限内超时，保留原结果；另一次专门诊断在启动后 10 秒对该候选精确 PID 采样，确认 `SecItemAdd → StorageManager::makeLoginAuthUI → AuthorizationCopyRights`，证据 `candidate-5a-gui-diagnostic.stack.txt`。候选没有因上述未签名状态立即退出，而是停在系统钥匙串授权路径，推断正在等待授权；尚未验证授权完成后的行为。未绕过安全存储，完整首页、GUI 控制和重启流程仍不计通过。

验收脚本也经过独立审查：修复超时后未等子进程退出就删除临时目录的问题，以及非法 JSON/null frame 绕过清理、独立进程组子孙残留。忽略 TERM 的父/同组子两例，加非法 JSON、独立进程组子孙、null frame 三例均独立复验通过；失败有记录，确认所有自有进程退出后清理。原安装版及其他任务进程不动。

`80f6a2209` 的新版 [artifact-only 运行 37573042394](https://github.com/starroyhq/agentkib/actions/runs/37573042394) 最终也全部成功：前置校验、七个平台构建及现有安装包 smoke 完成，Publish GitHub Release 明确跳过。macOS arm64 artifact ID `11461503650`、大小 281,707,793 bytes，GitHub artifact archive digest 为 `sha256:3e194dbe917768609e3ac07dd5a86df20bf449d0f1cefabf1c065091d91ad994`。此 archive digest 不与内部 ZIP/DMG 的 SHA256 混淆。

### 原生 CLI 的离线 MCP 与 Skills 检查

这些用例使用真正的 Claude `2.1.286` 和本轮 TypeScript Backend，模型网络边界由本机 HTTP 服务模拟。隔离 HOME/CLAUDE_CONFIG_DIR、dummy key、系统网络 sandbox 只允许明确的 loopback 端口；没有读取、复制或更改真实 provider 凭据/配置。**真实 provider/模型请求均为 0**。

1. MCP：实际 Backend RPC 注册工作区、生成并应用 `.mcp.json`、propose/review 一条 approved 合成记忆。Claude 原生加载唯一允许的 `mcp__agentkib__memory_search`；本机 SSE 模拟端指示一次只读工具调用，后续原生请求必须包含真实 Hub 返回的随机标记与记忆 ID。观察到 **1 条 CLI tool_use 及匹配 tool_result、2 次本地模拟 messages 请求**，CLI exit 0（报告 num_turns=2，为工具往返），源 manifest、MCP 配置、approved memory 均不变，CLI/Backend 退出确认。证据 `claude-mcp-offline-01/result.json`，复现入口 `qa/probes/claude-mcp-offline.py`。CLI 输出的 usage/cost 来自 stub，不记真实用量。工具次数按 CLI 原生记录核对，未独立抓包统计 Hub 传输层重试；此用例只覆盖 memory_search，不外推归档工具。
2. Skills：实际 Backend inventory/import/deploy 后，目标 `SKILL.md` 与来源字节相等。Claude 第一次本地请求的原生 system-reminder 包含唯一 Skill 名与随机描述；Backend undeploy 后目标消失，重新启动 CLI 的新请求中二者消失。部署后/撤销后 **各 1 次本地 messages 请求**，均返回约定的合成 500 并 exit 1（预期终点，不是模型成功），无工具执行或额外 HTTP 请求。来源和本地导入库字节不变，两个 CLI 与 Backend 均退出。证据 `native-claude-skills-offline-user-source/evidence-manifest.json`。
3. Skills 首个验收器配置曾使用 `--setting-sources ''`，主动禁用了 user Skill loader，导致名称未出现；该失败原样保留在 `native-claude-skills-offline/`。静态核对当前 CLI 后，使用只读取隔离 user settings 的独立新 case 验证通过，不覆盖失败，也没有重试任何真实模型请求。

可据此说明当前原生 CLI 已完成 MCP 工具的离线管道和 Skills 部署发现/撤销重载；**Skill 实际执行、真实模型回复、完整桌面/Web 控制及原生互通仍不计通过**。

### 最终 macOS 候选内部验收

最终固定 `80f6a2209` 的完整 DMG 条目已校验外层 entry CRC/长度及 CI 内附 SHA256：`64e216fc4f8f011cff4637d7895420b62381abd37ef9dae80aa70e7bda3934ab`，144,827,466 bytes。以只读方式挂载且所有磁盘 CRC 通过，复制到独立目录后卸载；候选路径为 `$EVIDENCE_DIR/candidate-80f6a2209/AgentKib.app`。未替换安装版、重签或改 fuse。

- 可执行文件 SHA256：`7c975b5464a642611b2ca8ca2891e8e44308e5de83370fd623d2b555d14a25ad`。
- `app.asar` SHA256：`62dd96562010a5ccc4eab06d65811ba26c6333949cc0300beb1166720f7a7e71`。
- `python3 qa/probes/smoke-candidate-workers.py <candidate.app> <candidate-80f-workers.json>` **通过**：使用候选自身的 Electron `44.0.0` / Node `24.18.1`，直接加载 asar 内生产 backend，实际 inventory/preview/import 经持久 Skills Worker 完成；Handoff Worker 真实文件校验、node:sqlite、包内 Koffi Worker 原生 `getpid` 均通过，退出清理确认。
- Node 22 执行 `qa/probes/smoke-typescript-source.mjs --app <candidate.app> --mode backend --output <candidate-80f-backend.json>` **通过**：合成 schema-15 工作区与 memory 两次隔离重开后保留，源快照不变。
- 上述内部检查没有启动完整 UI、发模型请求或绕过钥匙串；`ELECTRON_RUN_AS_NODE` 仅用于明确的内部后端检查，不算 GUI 通过。完整 GUI 保留首轮实际候选的授权路径超时记录，新候选未反复尝试 GUI。

最终原生/设备剩余项：系统钥匙串授权完成后的完整首页、桌面/Web Claude/Codex 控制与原生双向交接、Cursor 隔离 profile 原生导入/恢复、真实模型回复和真实手机仍未验收。当前本机 Codex `0.155.1` 不满足 TS 目标导入的精确 `0.159.2` 门限，未改门限或升级用户安装。当前 TS 控制链的六文件 119 项自动化通过，不替代这些原生结果。CLI/Hub 和 Skills 的上述离线检查是独立事实，不提升其他方向。

离线 MCP 新验收脚本亦经独立复核。首例只直接确认 CLI/Backend 父进程退出；后续 review 发现原 stop_owned 未覆盖 setsid 后代，已改为持续记录自有 PID 与启动身份、确认整个已记录进程树退出，无法确认则失败并保留证据。三项纯合成回归及独立原始负例复测通过，无关 sentinel 进程保持运行。未重发 Claude 或模型请求，也不将新清理逻辑回填为首个原生例已执行的证据。

交付为两份开放 PR：AgentKib #100、私有 backend #1；生产实现固定在上述提交，收尾提交仅新增 QA helper 和记录。两仓库均未合并、部署或发布，PR #97/#99 与原安装版保留不动。

## 审查修复 — 2026-10-08

本节记录上一轮审查之后的本机修复，不回填历史候选或 CI。源码为 `4bf9aa63449dfcb061ed8d069a9b32bc236a3d43` 加本轮 **dirty** 改动；没有新提交、推送、合并、部署或发布。代码与测试补丁（不含本 QA）SHA256 为 `8cb3c25c05422b6065ed3dad74c5e7ff2f773875797506d4ab983cd403390f19`，保存在 `$EVIDENCE_DIR/review-fixes/code-and-tests.patch`；构建身份见同目录 `source-build-identity.json`。

- 原生 CLI 与 Cursor 导入、恢复在首次异步读取前绑定注册身份，并在读取、写入、派发及返回边界复核注册 ID、规范路径和归档 namespace。同路径、同唯一别名改绑也拒绝执行。已经派发的导入保留 attempt 和待核对结果；改绑前已合法落盘的回执保留原字节，不回滚或重新导入。没有增加跨进程排他保证或修改持久回执格式。
- 新增 **19 条归属行为回归**（CLI 9、Cursor 10），在各自修复前均已验证失败，修复后 CLI **12/12**、Cursor **16/16** 通过。覆盖首次读取期间来源重新索引、探测、回读、attempt 提交后派发和最终 launched 回执提交后的改绑。使用真实 Store、实际读任务、TaskContext 与读 Worker；CLI/扩展边界为合成 fixture，不计原生客户端或真实模型通过。
- Worker 烟测和真实 Backend 子进程 fixture 改为系统环境白名单，所有 Agent、应用与临时目录指向隔离根；注册的测试工作区设置 Git 搜索边界。真实 Worker 的外部 Home/config/env 插值 sentinel 与父级 Skill 正反控制通过：有工作区边界时不能读取父级，移除边界后必须检出合成 sentinel，且仍止于合成父目录。新增环境回归已纳入 Windows/Linux 共用的 `test:backend:stability` 入口。
- 本 QA 的个人目录、Node、证据及候选路径均改为环境占位符；原有版本、哈希、历史失败和未验收结论保留。

本轮最终命令均使用 Node `22.23.3` / pnpm `10.8.1`，原始输出位于 `$EVIDENCE_DIR/review-fixes/`：

| 实际命令 | 最终结果 | 日志 |
| --- | --- | --- |
| `pnpm test:backend:stability` | 9 文件，**76 通过、1 Windows 平台项跳过**；原生绑定 smoke 通过 | `final-stability.log` |
| `pnpm test` | 桌面 166 文件，**2019 通过、1 平台项跳过**；Web 34 文件，**610 通过** | `final-test.log` |
| `pnpm format:check`；新增及修改脚本/测试的 `oxfmt --check` | 通过 | `final-format.log` |
| `pnpm lint` | 退出 0；保留既有 78 条 warning，本轮修改的生产文件无新增 warning | `final-lint.log` |
| `pnpm typecheck` | Backend、桌面、Web 均通过 | `final-typecheck.log` |
| `pnpm build`；`pnpm build:web:hosted` | 桌面 Renderer/Electron/Backend 及普通、hosted Web 构建通过 | `final-build.log`、`final-build-hosted.log` |
| `pnpm --filter @agentkib/desktop exec node scripts/run-backend-worker-smoke.mjs` | 实际 Electron `44.0.0` / Node `24.18.1` 的 utilityProcess、Skills 导入及退出、Handoff Worker/SQLite/Koffi 路径通过 | `final-electron-smoke.log` |
| `git diff --check`；QA 真实本机路径与用户名检查 | 通过 | 本机只读检查 |

Standards 与 Spec 由两个独立上下文子代理复核；复核发现的首次读取、attempt 提交、父级搜索及 Cursor 最终提交边界均补修并独立复验，未发现剩余确定缺陷。测试 fixture 的少量重复结构属于非阻塞维护建议。

本节验证平台为 macOS arm64。Windows 环境变量大小写保留已做自动化，Windows/Linux 远端 CI、本轮修复的新候选包与原生 Agent 窗口/模型/手机验收未执行；前述 `80f6a2209` 候选和 CI 仅保留为历史证据，不宣称覆盖本节 dirty 修复。

### OpenClaw 归属写入边界补修 — 2026-10-08

随后新的独立 Spec 审查复现了一项遗漏：OpenClaw 原生回读期间把同路径、唯一 manifest 别名改绑给另一注册工作区后，调用方虽返回待核对、未生成成功回执，验证函数仍先写入 `openclaw-generation`。因此，上节“未发现剩余确定缺陷”仅记录当时复核结果，不能作为本次补修前已覆盖此边界的结论。

本次将捕获的原工作区身份校验传入全部原生验证调用，包括初导入、pending/verified 恢复和启动前核对；OpenClaw 在回读返回后复核，将 generation 落盘纳入既有 `handoffCommit`，在提交回调内及提交返回后再次复核。改绑前合法写入的 marker/receipt 保留原字节；已派发的未知结果保留 attempt，不重复导入、不启动目标。没有改变 RPC、数据库或持久记录格式，也没有新增依赖或跨进程原子排他保证。

新增独立 `openclaw-native-recovery.test.ts`：修复前 12 例中 4 个预期负例失败，证明初回读、pending 恢复、提交入口和提交返回边界的 marker/receipt 写入问题；修复后连同启动前核对正反例 **14/14 通过**。使用真实 Store、临时合成 SQLite、实际 HandoffWork/TaskContext，仅替代外部 CLI，不计真实 OpenClaw 客户端或模型验收。原审查的独立合成负例亦由主代理复测，修复前失败、修复后通过。新增测试已加入 Windows/Linux 共用的后端稳定性入口。

源码仍为 `4bf9aa63449dfcb061ed8d069a9b32bc236a3d43` 加 **dirty** 改动；本次没有提交、推送、合并、部署、发布或替换已安装应用。合并当前代码及测试的补丁（不含本 QA）SHA256 为 `19a72a0d355bc61567d3bf4c810a9cd322e7552186adf7a006f93d1e1864d18f`，保存在 `$EVIDENCE_DIR/openclaw-owner-fix/code-and-tests.patch`；源码、三个 Backend 构建入口的 SHA256 见同目录 `source-build-identity.json`，上节补丁与日志保持原样。

以下命令实际使用 Node `22.23.3` / pnpm `10.8.1`，原始输出位于 `$EVIDENCE_DIR/openclaw-owner-fix/`：

| 实际命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm --filter @agentkib/desktop exec vitest run test/openclaw-native-recovery.test.ts` | **14/14 通过** | `openclaw-regression.log` |
| `pnpm --filter @agentkib/desktop exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module ESNext --moduleResolution Bundler --target ES2022 --types node test/openclaw-native-recovery.test.ts` | 新测试及关联源码严格类型检查通过 | `regression-typecheck.log` |
| `pnpm test:backend:stability` | 10 文件，**90 通过、1 Windows 平台项跳过**；原生绑定 smoke 通过 | `stability.log` |
| `pnpm test` | 桌面 167 文件，**2033 通过、1 平台项跳过**；Web 34 文件，**610 通过** | `test.log` |
| `pnpm format:check`；本次源码/测试/入口的 `oxfmt --check` | 通过 | `format.log` 及本机局部检查 |
| `pnpm lint` | 退出 0，保留既有 **78 条 warning**，本次生产文件无新增 warning | `lint.log` |
| `pnpm typecheck` | Backend、桌面、Web 均通过；首次检查发现遗漏的启动核对调用方，补齐后重新通过 | `typecheck.log`、`typecheck-final.log` |
| `pnpm --filter @agentkib/desktop backend:build`；`pnpm build`；`pnpm build:web:hosted` | Backend、桌面及普通、hosted Web 构建通过 | `backend-build.log`、`build.log`、`build-hosted.log` |
| `pnpm --filter @agentkib/desktop exec node scripts/run-backend-worker-smoke.mjs` | 实际 Electron `44.0.0` / Node `24.18.1` 的 utilityProcess、Skills、Handoff/SQLite/Koffi smoke 通过 | `electron-smoke.log` |

本次由两个新的独立上下文子代理分别复核 Standards 与 Spec；两者独立执行新增 14 例均通过，未发现剩余确定缺陷。`git diff --check` 和 QA 本机路径检查通过。所有结果仅覆盖 macOS arm64 本机；本次 Windows/Linux 远端 CI、原生 OpenClaw/其他 Agent、真实模型、新候选包及手机验收未执行，原有未验收状态保留。
