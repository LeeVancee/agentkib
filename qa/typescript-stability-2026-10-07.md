# TypeScript 后端稳定性与 MCP 归属修复 — 2026-10-07

## 记录状态与源码

本文件是本轮验收的独立记录。最终整合检查仍在进行，标记为 **待完成** 的项目不能计入通过；后续结果追加在此文件，不覆盖旧 QA 的失败或版本边界。

- 源码基线及当前 HEAD：`bdd05c9def7b6cad325d166e33f4014e723bd724`。
- 分支：`codex/typescript-stability-20261007`。
- 工作树：`/Users/kouzen/.codex/worktrees/typescript-stability-20261007/agentkib`。
- 本轮开始时新工作树干净；当前为 **dirty**，包含后端执行器、MCP/交接身份校验、测试与 CI 的未提交变更。最终文件清单、diff 指纹及候选包身份：**待完成**。
- 本地命令使用独立 Node `22.23.3`、pnpm `10.8.1`。Node 路径为 `/Users/kouzen/.codex/tmp/node-v22.23.3-darwin-arm64/bin`，通过命令前置 `PATH` 选择；未替换用户的 Agent 安装或凭据。
- AgentKib 正在整理固定提交与 PR；最终提交身份和后续 CI 结果另行追加。独立 backend 已提交、推送并创建 PR，见下文。没有覆盖已安装的 AgentKib、新增生产依赖或数据库结构。

## 证据分层

| 证据层级                            | 本轮状态                 | 能证明的范围                                                                             |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| 历史 Rust / 原生 Agent QA           | 保留原结论，不重新计通过 | 仅适用于各记录注明的源码、二进制、Agent 版本与方向                                       |
| 当前 TypeScript 定向自动化          | 以下已运行项目通过       | 当前 dirty 源码的可观察行为、真实 Store/Hub、后台进程与 Worker 隔离                      |
| Node 22 构建产物原生绑定            | 通过                     | 当前 `dist-electron` 三个后端入口存在，Worker 能直接加载 staged Koffi 并调用本机原生 API |
| Electron utilityProcess 与 Worker   | 主代理本机烟测通过       | Electron `44.0.0` / 内置 Node `24.18.1` 下的两个 Worker 通道；不等同安装包验收           |
| 新 TypeScript 候选安装目录 / 安装包 | 待完成                   | 尚不能据此声称打包、重启、升级或原生 Agent 续接已通过                                    |
| Windows / Linux 当前变更的 CI       | 已增加检查，尚未远端执行 | macOS 结果不外推 Windows/Linux；原生界面与手机仍分别验收                                 |

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

以下命令均在本轮工作树使用 Node 22.23.3 运行；Electron 烟测由脚本启动锁文件固定的 Electron，其内置 Node 版本单独记录。最终原始命令日志与本地 bundle SHA256 已封存于 `/Users/kouzen/.codex/tmp/typescript-stability-20261007-evidence`（目录权限 0700）；候选安装包和远端 CI 身份仍待追加。

| 命令                                                                                                                                                                    | 结果与边界                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git rev-parse HEAD` / `git status --porcelain=v1`                                                                                                                      | HEAD 为上述 `bdd05c9de…`；dirty，不描述为已提交 revision                                                                                                                                                                                            |
| `node --version` / `pnpm --version`                                                                                                                                     | `v22.23.3` / `10.8.1`                                                                                                                                                                                                                               |
| `pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts` | **4 文件、166 项通过**；其中新增 21 项，原有 145 项继续通过                                                                                                                                                                                         |
| `pnpm test:backend:stability`                                                                                                                                           | 初版 **4 文件、35 项通过**；纳入 handoff、原生导入和 Cursor 恢复后，最终 **7 文件、52 项通过**，staged Koffi smoke 同时通过。原始运行日志 `/tmp/agentkib-stability-ci-local.log` 已纳入上述证据目录；与其他测试命令有重叠，不能相加作为独立覆盖数量 |
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

根 lint 已加入 `packages/backend/src`；主 CI 新增 hosted Web 构建。Ubuntu ARM64、Fedora x64、Windows x64 / ARM64 的现有 job 名保持不变，新增后端构建、staged Koffi Worker 烟测与精确回归列表。handoff-executor、native-import-recovery 和 cursor-native-recovery 三份新回归已在文件落盘后纳入精确列表。CI 代码已落地，但本记录尚无本轮远端运行成功证据。

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

仍待逐项落证：

- 最终固定提交及 dirty 指纹、候选包哈希；本地 bundle SHA256 和完整命令日志已封存。
- 收尾后 hosted 构建的完整结果；七文件稳定性脚本、桌面/Web 全量、typecheck、format、lint 与 build 已有本轮通过证据。
- 当前源码的候选安装目录、隔离启动与恢复，以及实际目标 Agent 加载 MCP/Skills 的原生验收。
- 本轮 Windows/Linux CI 和 artifact-only 包 smoke；真实 Windows/Linux 客户端行为不能由 macOS 测试推断。
- 真实手机、真实 Agent 新单轮回复、签名/发布及新生产部署未在本轮定向测试中执行，不计通过。
