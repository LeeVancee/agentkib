# 额度采集诊断与部分成功修复 · 2026-10-09

## 源码与环境

- 基线：`v0.16.0` / `fb9c39469e4600f9a94e175adc1f06e75df4921d`，开始时工作树干净。
- 验证时分支：`codex/quota-diagnostics-20261009`；验证针对该基线上的工作区修复，本报告随修复一并提交。
- macOS arm64，Node `22.23.3`、仓库要求的 pnpm `12.10.1`。
- 本机安装的 AgentKib：`0.16.0`。未替换已安装应用，未修改自动刷新设置或 Agent 配置。
- 安装包内采集器 SHA256：`cd691cb61e6d2b39eda977a14a4695fefd85c994893fe5cb5214e160f4390fc7`。
- 打包脚本固定 CodexBarCLI `v0.49.5`。包内 `--version` 返回 `CodexBar 0.16.0`，该输出不作为上游版本身份的独立证明。
- `git fetch origin` 遇到 GitHub TLS 连接失败；本轮使用已发布 tag 的固定源码，不声称包含之后的远端变更。

## 实际诊断

只读数据库记录：最后成功采集为 `2026-09-09T14:15:32Z`，最近尝试为 `2026-10-08T05:57:52Z`，调度失败计数 `391`，错误仅为 `quota collector returned no usable quota for enabled providers`。自动刷新当前关闭。截图中的 13% 是旧缓存。

使用当前安装的采集器和既有 CodexBar 配置，执行一次：

```text
agentkib-quota-sidecar dashboard --identity redacted --timeout 25
```

外层进程期限 35 秒，实际 25.97 秒完成、退出码 0、stderr 为空。响应生成于 `2026-10-09T02:24:44Z`（台北 10:24:44）。命令只执行一次、未调用模型；未统计采集器内部 HTTP 请求次数。仅保存去除账号信息后的诊断摘要到本机私有临时文件，未保存原始凭据或完整响应。

| Provider | 实际返回 | 附带错误 |
| --- | --- | --- |
| Codex / oauth | Weekly 剩余 57%，重置 `2026-10-14T03:31:52Z` | `codex cost refresh timed out` |
| Claude / web | Session 剩余 81%，Weekly 剩余 61% | `claude cost refresh timed out` |
| Gemini | 无窗口 | 尚未登录 |
| Antigravity | 无窗口 | 未检测到语言服务器 |
| Kiro | 无窗口 | CLI 子进程无法启动 |

这些是该次响应的结果，不代表后续实时额度；不能将 Claude 网页账户额度外推为任意第三方 Claude CLI provider 的额度。Codex 只返回 Weekly，不补造五小时额度。后三个 Provider 原本不在产品已验证展示范围内，本轮没有扩大支持范围。

## 根因与修复边界

上游 [DashboardSnapshotBuilder.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/DashboardSnapshotBuilder.swift#L122) 将独立的 cost 错误合并到 Provider error；窗口仍来自 usage。[CLIServeCommand.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIServeCommand.swift#L623) 明确定义该费用超时文字。一次性 [dashboard](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIDashboardCommand.swift#L73) 先取 usage 再取 cost；真正的 usage 失败返回空 usage，参见 [CLIErrorReporting.swift](https://github.com/steipete/CodexBar/blob/v0.49.5/Sources/CodexBarCLI/CLIErrorReporting.swift#L49)。

AgentKib 原先只要 Provider 带 error 就拒绝其直接额度，因此该次有效数据会被整份拒收。现在仅对已核实的 Codex/Claude 精确费用超时、存在额度数据且时间合理的情况保留结果和警告。授权、usage、未知错误仍不被此例外放行。`updatedAt` 可能包含 cost/status 时间，只作为额外约束，不单独证明 usage 新鲜。

全失败继续保留旧快照，现有错误字段补充各启用 Provider 的具体原因，不增加数据库表或 RPC 类型。诊断屏蔽密码、私钥、常见密钥、JWT、邮箱及 URL；账号标签不参与失败汇总。错误详情有长度上限。

界面补最近尝试和自动刷新状态；失败事件/轮询/回执更新诊断。过期快照及已到期窗口不再显示“1 分钟后重置”，静置时也会更新提示。原有自动刷新设置保持不变。

## 验证

实际命令使用 Node 22 PATH 和 pnpm 12.10.1 的 `bin/pnpm.mjs` 入口；本机旧 pnpm 启动器自动切版本时发生 ENOEXEC，使用临时目录内的启动包装解决，未修改仓库包管理器或全局安装。

```sh
pnpm --filter @agentkib/desktop exec vitest run test/quota-owner.test.ts src/features/quota electron/main/refresh-coordinator.test.ts src/core/i18n.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm build:web:hosted
git diff --check
```

结果：相关 10 个文件、65 项测试通过；format、typecheck、桌面构建、hosted Web 构建、`git diff --check` 均通过。lint 退出码 0、无错误，仓库有 75 条警告；变更中的 quota 页面三条 set-state-in-effect 警告位于既有代码，没有为本轮削弱规则。

测试使用真实 QuotaOwner、BackendStore SQLite 和真实页面/查询组件，仅在采集进程与客户端边界提供合成响应。覆盖部分成功、全失败保留旧值、错误分类、未来/缺失/过期时间、敏感诊断、失败通知、静置到期和自动刷新关闭。

独立子代理核验了上游合约并审查实现；复核发现的 JSON 密码和标准 PRIVATE KEY 脱敏缺口已修复并补回归，复核未发现剩余确定问题。

本轮原生证据限于 macOS 上一次采集器查询。修改后的安装包尚未发布或替换；Windows/Linux 原生采集器未实测。没有重新执行费用统计以探测其具体性能瓶颈，不能把超时进一步归因为网络或某个历史文件。

## 后续审查修复：结构化诊断脱敏

基于本地提交 `2789b7a78fcb1af6b5b90e0ff0957f5b04ab3a90` 的独立审查发现：带引号的 camelCase `accessToken`、`refreshToken` 等字段会绕过文本脱敏，进入失败异常和 SQLite 诊断。这是后续发现，不沿用前次“无剩余问题”的结论。

本次复用现有敏感键分类，在逐行处理或限长之前检查结构化字段；识别后保留普通错误前缀，屏蔽从敏感字段起的后续载荷，避免跨行、嵌套或不完整结构漏值。键名支持转义及嵌套诊断字符串；扫描遇到引号即停止候选，避免长串转义引号导致反复扫描。普通错误、精确费用超时分类及共享会话脱敏行为保持不变。

回归通过真实 `QuotaOwner` 和临时 `BackendStore`，仅模拟采集进程响应。覆盖 provider、账户列表、单账户和进程 stderr 错误；分别检查失败异常、持久化诊断与部分成功快照，并保留旧缓存和正常错误原因断言。首批新增用例在修复前有 11 项失败；最终包含 15 项新增用例，包括嵌套转义和 20 万字符转义引号输入。

本次实际检查（Node `22.23.3`、pnpm `12.10.1`，Vitest 命令在 `apps/desktop` 执行）：

```sh
pnpm install --frozen-lockfile --offline
pnpm --filter @agentkib/desktop backend:build
node node_modules/vitest/vitest.mjs run test/quota-owner.test.ts src/features/quota electron/main/refresh-coordinator.test.ts src/core/i18n.test.ts test/handoff-executor.test.ts
# 在 packages/backend 执行
node_modules/.bin/tsc --noEmit
# 在仓库根目录执行
node_modules/.bin/oxlint packages/backend/src/quota.ts packages/backend/src/session-handoff.ts
node_modules/.bin/oxfmt --check packages/backend/src/quota.ts packages/backend/src/session-handoff.ts apps/desktop/test/quota-owner.test.ts
git diff --check
```

结果：11 个测试文件、85 项测试通过，后端构建、后端类型检查、定向 lint/format 与 diff 检查通过。首次扩展检查遇到旧本地依赖（MCP SDK `1.30.0`，锁文件要求 `1.31.0`）及缺少 `backend-handoff-read.cjs`；按锁文件离线恢复依赖并构建后消失，未修改锁文件或依赖声明。没有重新执行真实额度采集、读取凭据、替换应用或发布。

独立子代理复核并运行 10 组合成探针，确认嵌套转义、普通错误保留及大型转义文本边界，无剩余确定发现。

## 再次审查修复：裸键、多行 passphrase 与诊断耗时

后续以 `origin/main`（`fb9c39469e4600f9a94e175adc1f06e75df4921d`）为基准的审查发现两个遗漏：普通前缀后的裸键（如 `Upstream: {accessToken: ...}`）未被识别，且 `passphrase` 不在共享敏感键集合中，跨行值可能保留。本轮在 `main` 提交 `2789b7a78fcb1af6b5b90e0ff0957f5b04ab3a90` 及已有未提交修复上继续；前节复核结论仅代表当时覆盖范围。

字段扫描现只匹配键与分隔符，不消费值，因此普通前缀不会吞掉后续敏感字段。支持带引号和裸键、常见大小写及分隔形式、CLI 参数和嵌套诊断；识别后保守屏蔽后续载荷。`passphrase` 加入共享分类，交接 JSON 和 Markdown 导出也按此规则保护，已补相应回归。包含 `token(s)` 等敏感键词组的普通诊断可能被保守屏蔽。

独立复核还定位了两类耗时退化：深层转义逐次解码，以及长连字符文本中的候选重试。解码现限制为八次，仍未展开的候选保守屏蔽；裸键与邮箱匹配增加完整标识符边界。保留 10 万字符深层转义、21 万字符连字符诊断和 20 万字符转义引号的真实 `QuotaOwner` 回归，不以放宽测试超时处理。

测试同时检查失败异常、SQLite `error_detail`、部分成功快照及采集进程 stderr；合成 passphrase 值不含敏感关键字，避免值自身被其他规则遮蔽造成假通过。初次运行新增回归复现 13 项失败；最终本轮新增 24 项用例，额度测试共 59 项。

实际验证环境仍为 Node `22.23.3`、pnpm `12.10.1`，执行以下命令：

```sh
pnpm --filter @agentkib/desktop backend:build
# 在 apps/desktop 执行
node node_modules/vitest/vitest.mjs run test/quota-owner.test.ts src/features/quota electron/main/refresh-coordinator.test.ts src/core/i18n.test.ts test/handoff-executor.test.ts
# 在 packages/backend 执行
node_modules/.bin/tsc --noEmit
# 在仓库根目录执行
node_modules/.bin/oxlint packages/backend/src/quota.ts packages/backend/src/session-handoff.ts
node_modules/.bin/oxfmt --check packages/backend/src/quota.ts packages/backend/src/session-handoff.ts apps/desktop/test/quota-owner.test.ts
git diff --check
```

结果：11 个文件、109 项测试通过；后端构建、类型检查、定向 lint/format 与 diff 检查通过。独立子代理复核原触发条件，另运行 9 个敏感输入和 5 个普通诊断探针，未发现剩余阻塞问题；其本机合成性能探针约 2–5 ms 完成上述大型输入，不作为跨平台性能保证。

本轮未重新执行真实额度采集或模型调用，未读取凭据、修改配置、替换应用、提交或发布。既有 `prototypes/`、`target/` 未触碰。

## CLI 空格参数脱敏补充修复

再次独立审查发现：`--refresh-token 值`、`--id-token 值` 未被仅接受 `:`／`=` 的字段扫描识别。新增失败汇总会将这些值带入异常和 SQLite `error_detail`；先前的复核未覆盖该输入，旧结论不作为此次通过依据。

额度诊断现单独识别完整 CLI 参数名，并复用现有敏感键分类，不依赖值的引号或分隔方式；识别后沿用保守屏蔽后续载荷的策略。CLI 候选先于裸多词字段检查，避免值中的冒号被误作键分隔符。普通参数及错误原因保留，共享会话脱敏、费用超时放行条件及配置均未因本次修复改动。

新增 16 项回归，通过真实 `QuotaOwner` 与临时 SQLite `BackendStore` 检查全失败异常及落库详情、部分成功快照的 Provider／账户错误、进程 stderr、空格／制表符／换行、带引号值、argv 数组及值中冒号，同时确认普通 CLI 参数保留。首批 15 个新增用例在修改前有 13 项失败；修复后额度测试共 75 项通过。

实际执行上一节列出的后端构建、后端 `tsc --noEmit`、定向 `oxlint`／`oxfmt --check`、11 文件 Vitest 命令及 `git diff --check`，全部通过；相关测试总计 **125 项**。Node、pnpm、源码 HEAD 与 dirty 基线同上一节。本轮未修改真实配置、调用采集器或模型、提交或发布。

独立子代理复核当前源码，额度测试 75 项通过；另执行 745 组合成输入及 61 组参数边界探针，未发现本次 P2 范围内的剩余问题。210–260KB 长参数合成诊断约 6–26ms 完成，作为本机边界证据，不外推跨平台性能。

## 完整错误分类与 JSON 转义 URL 修复

后续审查又确认两项原测试未覆盖的问题：费用超时后附加 12 个换行及认证失败，会因展示文本截断而被误判为费用超时成功；JSON 转义斜杠 URL 的参数可能保留在失败异常及 SQLite 诊断中。前节复核结果不代表这两个输入已通过。

当前采集流程分别生成脱敏快照及内部可用性判断。后者读取完整原始 dashboard 的 Provider、账户列表和单账户错误，不再依赖展示文本；费用超时例外只接受原 Provider 的精确已知错误，且不能同时存在账户列表错误。持久化及返回数据仍只使用原有脱敏快照结构，原始错误不新增到数据库或公共接口。原始 `credits: null` 仍不能被视为可用额度。

URL 脱敏同时识别普通斜杠、JSON 转义斜杠及嵌套 JSON 的多层转义，不通过解码整段错误来改变普通诊断。新增 15 项测试，覆盖 Codex／Claude 混合错误、对象形式错误、被限行丢弃的账户错误、精确匹配及旧缓存保留；URL 用例逐一检查全失败、部分成功和进程 stderr，包括普通、混合、大小写及嵌套转义。均使用真实 `QuotaOwner` 和临时 SQLite，仅模拟采集进程。

修改前新增用例复现 13 项失败；修复后额度测试 **90 项**通过，相关 11 文件测试总计 **140 项**通过。实际执行的命令为前节列明的 `backend:build`、后端 `tsc --noEmit`、定向 `oxlint`／`oxfmt --check`、11 文件 Vitest 及 `git diff --check`，均通过。Node `22.23.3`、pnpm `12.10.1`，仍基于 `2789b7a78fcb1af6b5b90e0ff0957f5b04ab3a90` 的已有 dirty 工作区。

独立子代理复核通过：仓库外 87 个合成探针及额度测试 90 项通过，直接检查 SQLite 行中的诊断和快照，并验证空错误、超长空白、时间门限和 20 万反斜杠输入；未发现本轮两项 P2 范围内的剩余问题。纯空白错误及带额外空白的费用超时按完整原文保守拒绝，空字符串继续表示无错误。

本轮未读取真实凭据、调用真实采集器或模型、修改配置、替换应用、提交或发布；未触碰 `prototypes/`、`target/`。
