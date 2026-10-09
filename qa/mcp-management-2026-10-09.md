# MCP 管理、批量接入与工具分配 QA — 2026-10-09

## 源码与环境

- 起点：重新 fetch 后的 `origin/main`，`fb9c39469e4600f9a94e175adc1f06e75df4921d`。
- 分支：`codex/mcp-management`；工作树：`<CODEX_HOME>/worktrees/mcp-management/agentkib`。
- 新工作树起始 clean，本轮验收包含未提交修改。没有 commit、push、发布或修改安装中的应用；原工作树及其未跟踪内容保留。
- macOS arm64，Node **22.23.3**，pnpm **12.10.1**，Electron **44.0.0**。Shell 默认 Node 不是测试使用的 Node，所有项目命令显式设置以下 PATH。
- `pnpm-lock.yaml` SHA256：`41170b2077ad76aee991ca210aa208c09949d4c67d7118fee13371bd90f87378`；未修改依赖或锁文件。

```sh
export PATH="<TOOLS_BIN>:<NODE22_BIN>:$PATH"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm format:check
pnpm lint
pnpm test
pnpm build
pnpm build:web:hosted
node .github/scripts/smoke-test-backend-native.mjs
pnpm test:backend:stability
```

以上是实际命令的脱敏副本：用户目录替换为 `<CODEX_HOME>`，pnpm 包装器和 Node 22 目录分别替换为 `<TOOLS_BIN>`、`<NODE22_BIN>`；临时日志和隔离验收目录分别记为 `<QA_LOG_DIR>`、`<QA_ROOT>`。pnpm 使用本机已存在的 12.10.1 安装，包装器显式调用 Node 22。为启动未打包 Electron，运行了锁定 Electron 包现有的 `install.js`，没有添加依赖。

## 初次实施验收（独立 review loop 前）

| 检查 | 实际结果 |
| --- | --- |
| 冻结安装 | 通过，未升级依赖 |
| typecheck（Backend、Electron/桌面、Web） | 通过 |
| format:check | 通过 |
| lint | 退出 0；仓库现有警告仍存在，新 MCP 模块定向检查无警告 |
| pnpm test：桌面 | **184 文件，2,432 通过，1 跳过**；跳过的是 Windows 专用原生 TLS 用例 |
| pnpm test：Web | **35 文件，657 通过** |
| 桌面构建 | 通过，包含 Backend 与 Worker 产物 |
| hosted Web 构建 | 通过；没有增加 Web 管理入口 |
| Node Worker、FTS5 SQLite、已暂存 Koffi | `smoke-test-backend-native.mjs` 通过（darwin/arm64） |
| 跨平台 CI 使用的 `test:backend:stability` | 本机执行 **23 文件、444 通过、1 Windows 专用用例跳过**；新增 4 个 MCP 后端测试已纳入此入口 |

最终全量日志位于 `<QA_LOG_DIR>/agentkib-mcp-final-{typecheck,format-check,lint,test,build,build-web-hosted}.log`。这些是本机临时原始证据，不保证系统清理临时目录后仍然存在。

### 行为覆盖

- `mcp-management.test.ts`：支持的 JSON/TOML 形式、SSE/未知字段/冲突传输声明/错误类型拒绝；原生来源秘密不复制、粘贴秘密仅私密保存、默认停用与零启动；同名冲突、显式替换、继承覆盖和恢复全局；上层版本变化、秘密操作、第二文件失败补偿及外部修改保留；Home/profile 选择、来源变化、循环 YAML、迁移先决条件及脱敏预览。
- `mcp-connection-batch.test.ts`：单个/多个/全部、安装状态、缺失/正确/旧别名/旧端口/其他工作区/歧义/损坏、保留停用、Home 确认、共享 manifest 合并、重复回执、过期预览、失败及恢复报告；真实 Hub 握手和工具目录不启动上游。
- `mcp-policy.test.ts`：规则继承/空列表、版本化保存、长历史工具依赖、LAN 交集、原始目录与作用域缓存；已有长连接、启动等待与排队实际派发前撤权；工作区移除、同名服务重启隔离、公开工具名碰撞与直接调用拒绝。
- `mcp-management-runtime.test.ts`：真实 Backend 握手/初始化与 RPC 接线、严格参数、批量接入、实际 Hub 端点；Web 不能调用新增管理入口。
- IPC 校验测试：未知字段、任意来源路径、秘密操作、批量选择及规则参数。
- `McpHubPage.test.tsx` / `McpManagementRaces.test.tsx`：真实组件与客户端边界，共 **17 项**；作用域切换、草稿、JSON/Form、重复点击、部分成功、刷新失败后保留回执、失败项按原操作重试、探测不覆盖未保存策略、旧迁移确认失效、恢复不完整证据、配置变更清理旧验证结果及丢弃迟到响应。
- 原有连接、OAuth、Agent Home、会话交接及其余桌面/Web 回归继续运行，没有降低既有断言。

## 隔离 Electron 与真实 Hub

临时目录：`<QA_ROOT>/`。`home/`、`data/`、`electron/`、`project/` 均为本轮合成数据；没有修改个人 Agent 配置或调用模型。工作区通过已校验本机 IPC 准备，下面管理操作通过实际桌面按钮、复选框和输入框完成。

验收清单及结果：

| 操作 | 观察结果 |
| --- | --- |
| 添加服务，JSON 中主动填写 `enabled:true` | 保存后仍停用，合成进程启动日志不存在 |
| 显式启用服务 | 已启用，仍未启动进程 |
| 主动探测合成 stdio MCP | 实际启动服务；列出 `read_marker` 和 `hidden_tool` |
| Codex 选择仅 `read_marker` | 全局策略文件保存指定列表；不会更改服务目标或总开关 |
| 全局页面打开“补齐到 Agent” | 工作区为空，“检查并预览”不可用，未默选第一项 |
| 选择隔离工作区，预览 Codex/Claude | Codex 缺失待补齐；隔离环境中未安装的 Claude 明确跳过 |
| 确认补齐 | 仅创建隔离项目 `.codex/config.toml` 的 `agentkib` 连接，回执显示已写入与备份；自动只读握手列出 Hub 内置工具 |
| 再次检查同一连接 | “已正确绑定，无需修改”；没有差异、不能再次应用 |
| 工作区主动探测，实际 SDK 连接 Hub | `tools/list` 仅暴露 `qa-fixture__read_marker`；直接调用隐藏工具返回 `isError:true`；允许的合成只读调用返回 `synthetic-only` |
| 保持同一 Hub 会话，工作区改成指定空列表 | 下一次 list 隐藏上游工具，直接调用原允许名称也立即拒绝；恢复继承后重新遵循全局规则 |
| 粘贴 SSE 与带合成凭据的 stdio 两项 | SSE 被阻止；stdio 收录后停用；上游启动日志未增加，公开文件不含合成凭据原值 |
| 最终构建重新启动 | 原服务、全局指定列表与工作区继承仍存在；真实 Hub 仍拒绝隐藏工具；重复接入仍为无需修改 |
| 1360×860 布局与点击 | 首屏作用域、搜索、添加、收录、接入、服务表格可见；无页面横向溢出；相邻开关点击不会互相拦截。展开详情采用页面纵向滚动 |

实际工具调用仅针对合成服务，没有调用真实模型或生产工具。配置写入、Hub 可达与工具过滤通过，**没有据此宣称官方 Agent 客户端已经重新加载**。

最后一次 Electron 重启遇到 macOS 钥匙串等待：采样显示 `SecItemAdd → AuthorizationCopyRights`。终止自有验收进程后，最终隔离副本使用 Chromium 的 `--use-mock-keychain` 测试参数启动，通过 CDP 操作实际 Renderer；没有调整产品代码、读取或复制个人凭据。MCP 配置/协议验收通过不等同于真实钥匙串或账号登录验收。

截图和协议响应位于临时 `evidence/`：`management-final.png`、`policy-restored.png`、`repeat-connection-final.png`、`final-hub.json`。Playwright 初次启动/重连失败没有当作通过；最终构建使用已确认的独立进程完成重启检查。

验收结束后已停止本轮 Electron 和合成 MCP 进程，并确认临时调试端口不再监听；保留隔离数据和截图用于复核。

## 初次实施验收产物身份（review loop 前）

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `8aa1b6642a20fa39c30905cdf32349f138a290146d32c45e9551101d65dd7101` |
| `apps/desktop/dist-electron/main.cjs` | `ce81c1e1c2107d0c29f691793b79cfd26b1f05152ca2f3d51cdc6dc9c58044cf` |
| `apps/desktop/dist/index.html` | `040795d85f8b23cd26901823f2e82e19e8386277d0e660e0e2a9aac89d614afd` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

这些是本轮 dirty 源码构建，不是 release、签名安装包或 CI 产物。

图形验收时 Renderer 的 `index.html` 哈希为 `d1d7ae2df1a7a3a8d329f775a65be32e4b9a96ebdbf3f8d2e437bbe7829be5f2`。之后仅把收录结果的显示标签改为优先显示服务 ID，并补齐对应 DTO；类型检查、17 项界面测试与桌面构建再次通过。最终 Main/Backend 产物身份没有变化。跨平台夹具最后补充了 Windows 环境变量大小写隔离，完整 `test:backend:stability` 再次通过相同计数。

## 独立复核与边界

配置保存/收录、批量接入、工具策略分工实现并交叉只读复核，界面竞态由独立子代理复核。确定问题已修复并补回归：OAuth 地址变更、内联秘密、隐式覆盖、签名参数脱敏、混合传输与错误类型、循环 YAML、无关运行计数使预览过期、同名运行实例/工具名串扰、迟到响应、草稿与部分失败回执。Electron 实测另修复复选框点击区重叠和缺失翻译键。

- Windows/Linux 实机与远端 CI 本轮未执行；不把 macOS 通过外推其他平台。
- Windows 目录边界夹具使用 junction，避免要求文件符号链接权限；macOS/Linux 继续验证文件 symlink 拒绝。平台分支已只读检查，仍须在相应 CI runner 上执行。
- 未验证官方 Agent 重新加载、生产 OAuth、真实模型、LAN 或 Web 管理；本轮不增加这些能力。
- 未新增生产依赖、数据库表或远程鉴权模式；`mcp-policy.json` 是本轮明确要求的版本化配置文件。
- 文件保存继续依赖写前哈希和失败补偿，不承诺跨进程原子 CAS 或断电下多文件事务。

## origin/main 独立审查循环

审查开始重新 fetch，固定 `origin/main` 为 `23677dacd01c117c4059cf1b037c3ca7fd281d0f`；merge-base 仍为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。HEAD 没有新增提交，审查同时包含全部未提交及未跟踪源码，不以空提交差异代替 WIP 审查。没有合并远端新提交或变更原工作树。

第 1 轮两个独立子代理分别按 Standards 与 Spec 检查冻结 diff。Standards 2 项，Spec 4 项，其中旧私密配置兼容问题跨轴重复，共 5 个不同问题：

- 旧完整 `mcp.local.json` 在秘密/OAuth 更新后被误标为仅秘密覆盖，导致服务消失或退回全局定义；保留现有完整定义语义，并修正显式清除 OAuth 后的继承。新增 14 项旧 RPC 回归并纳入跨平台稳定性入口。
- 原生显式空工具白名单会变成 Hub 全部工具；现拒绝无法等价转换的列表，缺省列表与有限列表仍保持各自语义。
- 连接 URL 相同但缺少 Agent 必需字段时误报无需修复；按解析后的完整 Hub 条目判断，保留停用、扩展字段及格式差异，19 项新增回归。
- stdio 参数和 shell 片段内 URL 的用户信息未脱敏；公有视图与迁移预览共用脱敏，带内联凭据的收录明确阻止，来源保持不变。
- QA 含真实用户目录；已将用户目录和工具路径替换为占位符，原始临时日志未进入仓库。

第 1 轮修复的针对性命令：

```sh
pnpm --filter @agentkib/desktop exec vitest run test/mcp-management.test.ts test/mcp-legacy-local.test.ts
pnpm --filter @agentkib/desktop exec vitest run test/mcp-connection-batch.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts
pnpm --filter @agentkib/backend typecheck
git diff --check
```

实际结果分别为 52 项通过、200 项通过、类型检查通过、diff 检查通过。以上初次 Electron 实测与其产物哈希保留原记录，不能视为 review 修复后的新二进制实测。后续完整审查和最终自动化结果另行追加。

第 2 轮仍按完整冻结 WIP 审查，Standards 1 项、Spec 1 项，已分别定位并修复：

- 旧 `saveLocal` 在重新填写凭据时保留对应删除标记，导致保存成功但实际没有凭据。修复只解除显式提供键的标记；无关删除标记继续保留。全局与工作区独立复现修复前各失败，修复后均通过。新增 6 项回归，覆盖恢复、空值、无关撤销与非法输入零写入；legacy/policy/OAuth 43 项通过。
- OpenCode 配置替换被静默当作字面值。按原生来源和粘贴格式识别未支持的替换语义并拒绝收录；同类核对覆盖 Claude、Hermes、OpenClaw、Cursor，不自动求值或读取来源秘密。明确的 AgentKib 配置保留原字面值语义。

转换边界依据官方契约：[OpenCode variables](https://opencode.ai/docs/config/#variables)、[Claude MCP expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)、[Hermes MCP reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)、[OpenClaw config environment](https://docs.openclaw.ai/gateway/config-secrets-env)、[Cursor MCP interpolation](https://cursor.com/docs/context/mcp)。这些文档只用于核对配置语义，不把文档替代实际第三方 Agent 重载验收。

第 2 轮修复后，`pnpm --filter @agentkib/desktop exec vitest run test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts` 实际 **5 文件、162 项通过**；Backend/desktop typecheck、改动文件格式检查及 importer lint 均通过。第 3 轮按修复后的完整 WIP 再次独立审查。

第 3 轮完整审查：Standards 1 项、Spec 2 项，均已修复：

- 原生配置仅改格式，或迁移同文件另一服务后，来源指纹变化使相同定义无法重新确认。增加显式“重新确认来源”，只更新同一来源身份在所属作用域的指纹，保留开关、秘密、策略和探测状态；继承项必须在全局确认，实际定义变化仍拒绝。
- 正常 SDK OAuth 刷新改变完整凭据指纹，导致首个工具调用被拒绝且成功探测立即过期。连接保留稳定队列身份，只允许该连接在写前核对完整快照后更新当前凭据指纹；外部改动与迟到刷新继续拒绝。授权失效或授予范围变化清理旧目录并停止旧连接，重新探测后才能使用。新增 21 项合成 HTTP 回归。
- 运行实例列表跨作用域展示，但重启使用页面作用域，可能重启错误服务。Runtime 返回规范作用域，列表只展示当前作用域，重启使用行自身归属；保留旧 stop 的全部作用域语义并明确按钮文案。真实 stdio 进程回归验证同名实例隔离。

第 3 轮修复后实际验证：

```sh
pnpm --filter @agentkib/desktop exec vitest run test/mcp
pnpm --filter @agentkib/desktop exec vitest run src/features/mcp/McpHubPage.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpManagementRaces.test.tsx
pnpm --filter @agentkib/backend typecheck
pnpm format:check
git diff --check
```

结果：MCP 后端 12 文件、368 项通过；真实组件 3 文件、21 项通过；类型、格式及 diff 检查通过。旧独立 OAuth 复现从 2 项失败变为 2 项通过；来源重新确认独立复现通过。OAuth、runtime scope 新测试已纳入 `test:backend:stability` 跨平台检查入口。随后冻结完整 WIP 进行第 4 轮双轴审查；审查结果及最终完整检查另列，不提前声明无问题。

第 4 轮审查前完整验证：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:web:hosted`、`pnpm test:backend:stability` 全部 exit 0。桌面 188 文件、2,549 项通过、1 项既有跳过；Web 35 文件、657 项通过；稳定性 26 文件、557 项通过、1 项既有跳过，包含 Node Worker/SQLite/Koffi smoke。lint 保留仓库已有 warning，没有降低规则。

第 4 轮冻结补丁 SHA256：`82ad02454ca2518b2854778e0b235b51633eec7f525154512bc4302b4e98b0b1`（54 个文件，含全部未跟踪源码）。独立审查仍发现 Standards 1 项、Spec 1 项：

- stdio Header 参数的冒号形式未被识别为秘密；合成 `X-API-Key:…` 可从原生扫描进入预览和公开配置。需要统一脱敏与内联秘密拒绝，来源保持不变。
- OAuth 刷新等待期间撤销策略，SDK 401/403 后的内部重发绕过调用入口检查；需要在实际工具请求发送前再次检查身份与授权，并隔离并发调用。

这两项在当时已有全量测试通过的情况下被独立复现，故没有结束循环。交互式 OAuth pending 的来源快照缺口另经基线核对为既有风险，未计入本轮新增 finding；同模块的迟到秘密写入保护也将最小补齐。以上检查对应第 4 轮冻结源码，不能替代后续修复的再次验证。

第 4 轮修复已完成：Header 共用脱敏覆盖单独／内嵌参数、任意认证 scheme、Cookie、引号与 shell 转义，保留无秘密的普通及空 Header；原生和粘贴内联秘密拒绝收录，公开展示与迁移预览不含合成秘密。新增 15 项管理回归。HTTP 工具调用通过 SDK 支持的 fetch 边界逐次校验当前配置、工作区、Agent 和策略，调用上下文按连接与请求 ID 隔离；本地拒绝不关闭其他 Agent 正在使用的共享连接。交互 OAuth 增加按规范作用域绑定的 pending 快照，旧回调与取消后迟到写入拒绝；相关 OAuth 回归新增 24 项，共 58 项通过。

统一复验 `pnpm --filter @agentkib/desktop exec vitest run test/mcp`：**12 文件、407 项全部通过**。Backend/desktop typecheck、`pnpm format:check`、`git diff --check` 均通过。使用临时目录、合成 stdio/HTTP 与真实 SDK，不修改个人配置、不调用真实模型。随后以全部修复后的 WIP 启动第 5 轮完整双轴审查。

第 5 轮冻结补丁 SHA256：`916c6208dfe871a120343a73f793a528622ba21562880c627f5389d1831dab10`（55 文件）。完整 format、lint、typecheck、桌面/Web 测试与构建、后台稳定性均 exit 0；桌面 2,588 通过、1 既有跳过；Web 657 通过；后台稳定性 609 通过、1 既有跳过。该轮独立审查仍报告 Standards 1 项、Spec 1 项：

- 收录从“另存为”切回“替换”时，隐藏的自定义 ID 残留在请求中，后端可覆盖未预览的其他服务。已修复为 UI 离开新增动作清除改名，后端替换只认预览原 ID；7 个新增回归修复前 4 失败、3 通过，修复后相关 4 文件 117 项通过。
- 旧内嵌凭据只按原参数索引恢复，移动参数后未恢复的 `[redacted]` 被当真实内容保存。独立隔离复现确认发生写入，继续修复未还原占位符的拒绝与零写入边界。

本轮结果未满足结束条件，修复完成后仍需下一轮完整双轴审查。此前原始复现文件保持原样，最终正式回归按正确行为断言。

第 5 轮两项修复均已完成。未还原占位符按原字段／参数索引判断，精确识别 `[redacted]` 与 URL 编码标记；变动后无法原位恢复时拒绝保存，要求迁入私密字段，不按值猜测新位置。拒绝场景断言公开／私密文件字节、有效配置和 revision 均不变；保留原位开关及目标编辑、字面标记和正常无秘密参数重排。新增 17 项回归，修复前 10 失败、7 通过；修复后管理模块 **115 项通过**。Backend typecheck、针对性格式和 diff 检查通过。随后冻结第 6 轮完整 WIP，继续独立双轴审查。

第 6 轮冻结补丁 SHA256：`960d0655529345ea0cdd8f4e57a82d267e2dd1a305246b19e263bcf7eebc1370`。完整 format、lint、typecheck、两端测试和构建、后台稳定性通过：桌面 2,612 项通过、1 既有跳过；Web 657 通过；稳定性 631 通过、1 既有跳过。独立审查 Standards 1 项、Spec 1 项，继续修复：

- 迁移将存在但非对象的 `agentkib` 条目当作缺失并覆盖。现在先核对属性存在，再拒绝损坏类型，沿用显式连接修复错误。JSON/TOML 的 null、数组、字符串、布尔和数字等 9 项回归，修复前均失败；修复后均阻止迁移，原生与公开／私密配置、revision 保持不变，无进程启动。
- 同一来源重新确认遗漏新增凭据键名。明确确认时将所需 env/header 键名随来源指纹更新；不复制原值，保留本地凭据、启用和探测状态。新增键和移除键均反映到提示；默认跳过不更新；缺少新值时迁移继续拒绝。正式回归修复前失败，修复后通过。

第 6 轮修复后 `pnpm --filter @agentkib/desktop exec vitest run test/mcp` **12 文件、439 项通过**；Backend typecheck、定向格式和 diff 检查通过。继续第 7 轮完整独立双轴审查。

第 7 轮冻结补丁 SHA256：`2a9e7d3b582433564ec31c3323b7d92e7f78d506ec86d893d8583974f8ebfa2e`。完整 format、lint、typecheck、桌面/Web 测试与构建、后台稳定性均通过：桌面 2,622 通过、1 既有跳过；Web 657 通过；稳定性 641 通过、1 既有跳过。

本轮 Standards 1 项、Spec 1 项，为同一 P1：工作区替换收录丢失旧私密覆盖的 env/header 删除标记和 OAuth 撤销标记，导致同名全局凭据重新继承。隔离复现不仅观察到有效配置恢复旧值，还通过真实 SDK 的拦截 fetch 证明旧 Authorization 会发往替换地址；没有真实网络请求。继续修复撤销记录与显式新值的继承边界，未将全量测试通过作为结束条件。

第 7 轮 P1 已修复：实际替换保留 env/header 既有删除标记，并将本次省略的有效键继续标记删除，避免移除工作区值后回退到全局旧秘密；本次显式提供的同键新值才解除对应删除标记。替换未授权导入 OAuth，明确阻止继承旧 OAuth；skip、identical、来源重新确认的提前返回保持原行为。

新增 15 项回归覆盖全局／工作区、旧完整 local／仅值覆盖、相同／变化 URL、显式新值、原生值剥离、OAuth 回退及真实 SDK 的拦截 HTTP 出站。修复前 14 项失败、1 项通过；修复后管理模块 **140/140 通过**，原隔离复现从 1 项失败变为 1 项通过，证据文件未改。Backend typecheck、定向格式及 diff 检查均通过。继续第 8 轮完整独立审查。

第 8 轮冻结补丁 SHA256：`dd7b16e24c77dd023a4cd07f559dd113f17f27f2d88dfaffcf90845c15dd1403`（55 文件）。完整 format、lint、typecheck、桌面/Web 测试与构建、后台稳定性均通过：桌面 188 文件、2,637 通过、1 既有跳过；Web 35 文件、657 通过；稳定性 27 文件、656 通过、1 既有跳过。审查结束前再次核对全部 55 个文件哈希，与冻结版本一致。

独立审查 Standards **no findings**，Spec **1 项 P2**：普通环境变量值被用作连接文本的任意子串掩码，再由展示差异判定为内嵌凭据。`DEBUG=1` 与命令参数 `server@1.0.0` 即可触发，导致合法的粘贴收录和手动新增都被拒绝。两项隔离复现均失败，继续修复判定与展示脱敏的边界；本轮未达到双轴 no findings，不结束循环。

第 8 轮修复已完成：专用内嵌凭据判断与保守公开脱敏分开。显式连接凭据语法、敏感键的短值及未知名称的完整重复值继续拒绝；普通设置的偶然子串重合不再阻断保存，已知 DEBUG、PORT、NODE_ENV、Content-Type 的普通取值保留可重复语义。Renderer 仍使用全部私密值脱敏，旧占位符原位恢复和移动后拒绝保持不变。

新增 12 项回归，修复前普通配置经粘贴／原生／手动三个入口失败、9 项秘密保护通过；修复后 12 项全部通过。管理、管理 Runtime、legacy local、runtime scope 共 **4 文件、177 项通过**；原独立复现保持原文件，**2 项通过**。Backend typecheck、定向 format/lint 和 diff 检查通过。继续第 9 轮完整双轴审查。

第 9 轮冻结补丁 SHA256：`a41383a597fe9c2dcd05a6ba3ca1e9b383b7f74635cef0eea1161fb09f98cf5a`（55 文件）。完整 format、lint、typecheck、桌面/Web 测试与构建、后台稳定性均 exit 0：桌面 188 文件、2,649 通过、1 既有跳过；Web 35 文件、657 通过；稳定性 27 文件、668 通过、1 既有跳过。

Standards **no findings**，Spec **2 项 P2**，均由隔离合成服务复现：

- 项目级原生 stdio 配置缺少 `cwd` 时，收录后使用了后台进程目录，未保留项目运行上下文；迁移还允许移除原定义。继续修复来源运行目录的明确绑定及无法确定时的拒绝。
- OpenCode 的显式 `oauth: false` 被丢弃，启用后收到合成 401 时仍发起 OAuth 发现和动态注册。现改为拒绝无法保留的显式 OAuth 配置，不新增其他认证行为。新增粘贴／原生两个真实 Backend RPC 拒绝用例，修复前均把条目标为 new，正式回归断言 blocked、零配置写入、来源不变和零网络／进程启动。

第 9 轮两项已修复。原生读取以显式内部参数携带已验证项目上下文，新旧迁移共用目录核验：Claude/OpenCode 的项目缺省目录固定为规范工作区；有依据的绝对 cwd 保留；未知缺省、相对目录和原客户端忽略的字段拒绝。首批目录回归修复前 14 失败、1 通过，随后补齐至 22 项；包含 4 个真实 stdio 进程、相对文件读取、收录零启动和新旧迁移目录验证。旧夹具只将依赖未知目录的配置改成明确绝对 cwd 或 HTTP，保留来源变更、凭据、继承和循环 YAML 拒绝等原断言。

目录依据：OpenCode [官方 MCP 源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/index.ts) 使用实例工作目录；Codex [MCP 文档](https://developers.openai.com/codex/mcp/)声明 cwd，[官方源码](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/server.rs)的缺省依赖运行上下文。Antigravity [配置说明](https://antigravity.google/docs/mcp?tab=ide)及 OpenClaw [连接说明](https://docs.openclaw.ai/tools/mcp)明确支持 stdio cwd。本机 Claude Code 2.1.286 的两个 stdio 启动分支未传入原配置 cwd，因此不将这个字段激活为新行为。本机 Cursor 应用包版本 3.23.23 的 `extensions/cursor-mcp/dist/main.js` 明确使用配置 cwd 启动 stdio，文件 SHA256 为 `423b903dff1c7fb1dfbf397480ed3318a41bc1f1f11829e1678348ed074a2ca7`；目录变量表达式继续拒绝，不代替原客户端展开。这些读取证据不是第三方 Agent 重载实测。

OAuth 修复后真实 Backend RPC 文件 **5 项通过**；目录修复后全 MCP **12 文件、491 项通过**，Backend typecheck、定向 lint/format 与 diff 检查通过。主代理另补 2 项 Cursor cwd 表达式拒绝回归，随最终 MCP 检查验证，然后冻结第 10 轮完整审查。

## 审查循环完成：第 10 轮

Cursor cwd 相邻回归补齐后，全 MCP **12 文件、493 项通过**。第 10 轮冻结完整 WIP 共 55 文件、625,055 字节，补丁 SHA256：`0e286419adf8c7aaf2a90f18ce661b4092379c8b7c8b7b8655b3ae03e15af6b0`。基准仍为审查开始时固定的 `origin/main @ 23677dacd01c117c4059cf1b037c3ca7fd281d0f`，merge-base/HEAD 为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`；包含所有未提交和未跟踪改动。

两个新的独立上下文子代理审查全部冻结改动，最终分别报告：

- **Standards：no findings（0 项）**。按项目约定及 Fowler baseline 检查，未确认可操作违规或实质性代码异味。
- **Spec：no findings（0 项）**。核对权威实施计划，未确认需求缺失、扩围或错误实现。

两轴均覆盖配置保存／秘密继承、收录来源与迁移、批量接入身份及补偿、作用域缓存与实际派发、OAuth、IPC、UI 竞态和测试。主代理与审查代理各自核对 55 个文件 SHA，均与冻结清单一致；在审查结束后只追加本段 QA 结果，没有再次修改实现。循环到此满足用户指定停止条件，不将 no findings 解释为已完成未执行的平台或真实客户端验收。

最终实际执行环境为 Node **22.23.3**、pnpm **12.10.1**。以下命令全部 exit 0：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:web:hosted
pnpm test:backend:stability
git diff --check
```

- 桌面：**188 文件、2,676 通过、1 既有跳过**。
- Web：**35 文件、657 通过**。
- 后台稳定性：**27 文件、695 通过、1 既有跳过**，包含 Node Worker/SQLite/Koffi smoke。其测试与桌面集有重叠，计数不相加为独立用例总数。
- lint 保留既有 warning；未调整规则或降低断言。
- 完整原始命令日志保存在本机临时验证目录的 `r10-format.log`、`r10-lint.log`、`r10-typecheck.log`、`r10-test.log`、`r10-build.log`、`r10-hosted.log`、`r10-stability.log`；没有把含本机绝对路径的原始日志复制进仓库。

最终构建产物：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `206d64ec9322b31df7473d64095ee7947f7874986c42565fe824b30a8adfc9fd` |
| `apps/desktop/dist-electron/main.cjs` | `27b326abd4fd7bf733bb1169b60881222a9ec91b24dd21702112f51f3146f899` |
| `apps/desktop/dist/index.html` | `d6e90fa5268c415442d2b70adfd245a1cae570e89af17faba865ead9e41a4880` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本轮 review 修复后没有重新进行官方 Agent 重载、真实 OAuth／模型、LAN、Windows/Linux 实机或远端 CI 验收；初次实施的 Electron 图形验收仍仅对应本文前述旧产物。最终产物为本机 dirty 源码构建，没有覆盖安装、提交、推送或发布。新增生产依赖、锁文件及数据库表均无变化。原工作树和用户已有内容保持不动。

## 后续独立审查的两项 P3 修复

用户在上述循环完成后再次要求以 `origin/main` 审查。重新固定远端 `23677dacd01c117c4059cf1b037c3ca7fd281d0f`，HEAD/merge-base 仍为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`；55 个 WIP 文件的审查补丁 SHA256 为 `7421ecae76b7d6327cfe5643bcdaffb9681edcb6e8c35b343e5219467edb844d`。两个独立子代理发现 Standards 1 项 P3（原生解析分支重复维护）和 Spec 1 项 P3（新增阻断原因与回执未覆盖现有语言）。本段记录用户随后授权的修复，不改写前一轮审查的历史结论。

- 抽出 `mcp-native-document.ts`，统一 Agent 格式选择与服务容器定位，供扫描、收录、迁移检查、旧迁移转换及来源重写使用。保留文件安全读取、大小限制、来源身份及指纹检查；YAML 各入口使用扫描原有的严格解析，拒绝损坏及重复键。
- 在原有字符串之外增量提供结构化诊断，两个管理面板通过现有 i18n 渲染。58 个诊断键覆盖四种语言，涵盖批量检查、写入／补偿回执、原生扫描及逐项收录警告；缺少元数据的旧响应继续显示原字符串。参数只含受控字段名、Agent 名称或 errno，不传入解析器的私有内容。
- 既有顶层 RPC 异常通道未改变；本次没有将所有底层异常翻译，也没有扩展 RPC 错误协议。

实际环境为 Node 22.23.3、pnpm 12.10.1。修复后执行以下检查，均 exit 0：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/core/i18n.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

相关回归 **18 文件、552 项通过**，包括新增的 20 项共享解析测试及真实 i18n 组件的繁中、日语和旧英文响应兼容测试。lint 仅保留既有 warning。原始日志保存在本机临时验证目录，文件名为 `followup-fix-{format,lint,typecheck,mcp,build,hosted}.log`。

两个未参与实现的子代理分别复核解析抽取和本地化改动，均报告 **no findings**；前者独立运行 20 项解析测试，后者独立运行 3 项组件测试和 4 项后端诊断测试，均通过。这是本次两项修复的定向复核，不等同于重新执行完整 WIP 的双轴审查或全量测试。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `d5fa2b43fab013c94813824321d0833911ca48d6445c138a260f853e2a9653fe` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `4ef587a9f92a7211f8be7b2288cb244840e549800c03c43bdbf6e94c8b6acff4` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本次未重做 Electron 图形验收、真实 Agent 重载、模型／OAuth／LAN 或跨平台实机验收；未覆盖安装、提交、推送或发布，保留所有既有改动。

## 后续目标选择规则与 Hermes YAML 别名修复

再次独立审查固定 `origin/main @ 23677dacd01c117c4059cf1b037c3ca7fd281d0f`，HEAD/merge-base 仍为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。修复前包含 59 个 dirty 文件的审查补丁 SHA256 为 `4071d8b11a81ca08bae06a8a092cae2002c0a23222162be06c289b758f86b42f`。Standards 提出 1 项 P3：表格与编辑器重复维护目标 Agent 选择规则；Spec 未发现新增问题，但另行复现了基线已有的 Hermes YAML 别名迁移问题。本段记录用户随后授权的两项修复，不将既有缺陷记为本轮新增回归。

- 新增 `mcp-targets.ts`，统一 MCP 管理支持列表及选择规则，供管理表格、编辑器、批量接入和工具分配使用。保留空 `targets` 表示全部、显式追加去重、禁止移除最后一项、排除 DeepSeek Harness 的原语义；表格仍即时保存，编辑器仍只修改草稿。新增两种界面共 4 项真实组件回归。
- 原生迁移先复制 MCP 服务容器，再通过共享路径表替换对应路径；不再对 YAML 别名共享的对象原地删除或插入。Hermes 的无关字段与未迁移服务保持原值，其他格式继续使用同一容器路径规则。未改变来源身份、路径、哈希、大小或 YAML 解析限制。
- 新增 9 项隔离回归，使用真实 `McpManager`、本地合成 HTTP MCP、预览及实际 ChangeSet 应用，覆盖旧迁移／先收录后迁移、MCP map 为 anchor／alias、预览后来源变化，以及损坏、循环服务和别名膨胀拒绝。修复前 4 项别名保留用例失败、5 项保护用例通过；修复后全部通过。测试只握手及列举工具，不调用工具或真实模型。

实际环境仍为 Node **22.23.3**、pnpm **12.10.1**。以下命令均 exit 0：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts test/mcp-migration-alias.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/core/i18n.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

相关回归 **19 文件、565 项通过**，包含本次新增 13 项；lint 保留既有 warning。原始命令日志保存在本机临时验证目录，文件名为 `targets-alias-{format,lint,typecheck,tests,build,hosted}.log`，Hermes 修复前后证据为 `agentkib-mcp-yaml-alias-{before,after}.log`。

两个未参与相应实现的独立子代理分别复核目标选择提取和 YAML 别名修复，均报告 **no findings**。前者对照修复前冻结补丁，核对四个界面的列表、选择及草稿／保存行为；后者独立运行 29 项解析与迁移测试及 9 组全部 Agent 格式的内存夹具，全部通过。此结果仅对应这两项修复的定向复核，并非重新执行完整 WIP 双轴审查或全量测试。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `57cb17d354d0c515fa8b6d6746a64e171e8da921b27f9ccb8afd0716e94a9225` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `646682a521869050a9a2802c855c454f7344610bf3874de91bac93429ee90947` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本次只运行隔离自动化与构建，未重做 Electron 图形、第三方 Agent 重载、真实模型／OAuth／LAN 或跨平台实机验收；未改个人配置，未安装替换、提交、推送或发布。修复前已有修改均保留。

## 后续迁移预览脱敏与 Git 私密文件保护修复

本次独立审查仍以 `origin/main @ 23677dacd01c117c4059cf1b037c3ca7fd281d0f` 为基准，HEAD/merge-base 为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。修复前完整 WIP 为 61 个文件，审查补丁 SHA256 为 `58434574321a7ba260f513107e5f137afd9beb6ed7b5590c37fc1cbdb8fae8a5`。Standards 报告迁移预览重复凭据泄漏（P1）及忽略规则被后续否定时失效（P2）；Spec 为 0 项。本段记录随后授权的修复，保留前述历史结论。

- 迁移预览抽出 `mcp-migration-preview.ts`：先解析并汇总所有文件的 before/after 已知私密值，再生成脱敏预览。即使凭据所在字段被迁移删除、同一值出现在未迁移或不支持的服务、普通参数、嵌套字段、对象键或另一文件，也不能直接返回 Renderer。原始 ChangeSet 留在宿主，实际写入不使用脱敏副本。
- 复用 `mcp-import.ts` 的 URL、header、敏感赋值及 token 识别规则记录私密值，补充引号、静态拼接和转义后的重复值；不执行 shell 或变量展开。独立复核发现并修复了内联凭据、引号后缀及普通 argv 中分号被误当 shell 边界的中间版本问题。最终保持原有无空白遮盖范围：原生 argv 无法证明是 shell 时，敏感赋值紧邻的歧义文本一起遮盖。新增测试中曾要求 `;printf` 必须可见的假设据此纠正，所有凭据遮盖断言保持严格，独立普通参数仍必须保留。
- 私密配置写入只在 `.gitignore` 最后一条有效规则已明确保护文件时复用，否则保留原字节并追加 `.agentkib/mcp.local.json`。不再将较早的目录规则视为充分保护；保留写前哈希检查、串行 ChangeSet 与失败补偿，重复保存不重复追加。未扩展到移除已跟踪文件或改写嵌套 `.gitignore`。
- 新增 27 项迁移隐私测试和 16 项 Git 保护测试。隐私初始 10 项中修复前 9 失败、1 通过；Git 初始 16 项中修复前 10 失败、6 通过。最终新增 43 项全部通过，包括 JSON/TOML/YAML/JSON5、跨快照／文件重复值、YAML alias/cycle、引用／转义／未闭合引号、真实应用原文保留，以及真实隔离 Git 的否定规则、CRLF、重复保存、外部编辑与补偿。

执行环境为 Node **22.23.3**、pnpm **12.10.1**。以下命令均 exit 0：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts test/mcp-migration-alias.test.ts test/mcp-migration-privacy.test.ts test/mcp-management-gitignore.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/core/i18n.test.ts electron/main/ipc/mcp-management-validation.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

最终相关回归 **22 文件、613 项通过**；不是全仓库测试。lint 保留既有 warning，未改规则。原始日志保存在本机临时验证目录，文件名为 `privacy-gitignore-final-{format,lint,typecheck,tests,build,hosted}.log`。原审查与复核的合成复现保持不变，独立运行再次通过；只读预览断言零进程／网络执行，实际应用测试只显式探测本地合成 MCP，不调用工具或模型。

两个未参与相应生产实现的子代理分别定向复核，均报告 **no findings**。Git 复核独立运行 16 项回归及 8 组真实 Git 边界；隐私复核独立运行 7 项原始／相邻复现及 30 项既有分类与脱敏测试。这是两项修复的定向复核，未重做全部 WIP 的双轴审查。完成实现与测试后的 64 文件冻结补丁（追加本段 QA 前）SHA256 为 `00a6a62b62d5e8f99aa10a2862c9c221cfe815a9b0e2e1ab7169480360d1c3d8`。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `384a3248dd63ee007b9c221480c6bde6dcc39f7c4d74021bfafe20c739933a25` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `646682a521869050a9a2802c855c454f7344610bf3874de91bac93429ee90947` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本次没有重做图形、真实 Agent 重载、模型／OAuth／LAN 或 Windows/Linux 实机验收。未修改个人 Agent 配置、生产依赖或数据库表；未覆盖安装、提交、推送或发布。用户与其他工作树的已有内容均保留。

## 后续迁移预览处理预算修复

本次审查更新并固定 `origin/main @ 8866701b5d7f90ebae369fd4549dac74cb9c9add`，HEAD/merge-base 仍为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。修复前 64 文件的完整 dirty 审查补丁 SHA256 为 `21bdb32652fccc4440936b07b992475d4668ecd36536050037a3cf309bee1f73`。Standards 确认 1 项新增 P2：凭据派生队列反复扫描 `token=` 后缀，导致平方级处理；Spec 为 0 项。本段只修复该 P2 与相邻的预算、隐私边界。

- 每次迁移预览共用内部 `McpRedactionBudget`，覆盖全部文件和 before/after；派生候选最多 1,024 个，已知私密值集合最多 1,024 个，累计扫描限 8 × 1,024 × 1,024 个 UTF-16 code units，逐次字面替换的输入与匹配值长度之和限 32 × 1,024 × 1,024 个 code units。重复扫描与替换后膨胀的文本均计入，不将输入文件大小误当作总处理量。
- 派生、扫描、替换都在执行前检查。超限沿现有错误通道返回不含原文的固定错误，整次拒绝；不截断待处理列表、不返回部分脱敏内容、不保存待用迁移 token。URL 解析及解码的两层 catch 重新抛出预算异常，避免被当作解析失败吞掉。原有脱敏规则与私有 ChangeSet 不变。
- 更新使用说明，明确复杂配置可能在文件大小合法时仍超出预览处理预算；需简化后重新预览，原生配置不会因此被修改。未增加 RPC、存储结构或生产依赖。

修复前仅运行一次新增重型回归：约 60 KB 的嵌套输入耗时 **6,096 ms**，没有按预期拒绝，测试失败。主代理使用同一份 **60,201 字节**隔离配置的完整流程复现：修复前预览与无关 10 ms 计时器均延迟约 **6,043 ms**；修复后明确拒绝约 **59 ms**，计时器约 **59 ms** 响应。该计时是当前本机合成用例测量，不是跨机器性能保证。

新增 7 项真实收录→启用→预览回归，原 27 项保留，隐私测试最终 **34/34 通过**。覆盖嵌套输入安全拒绝且无关计时器 1 秒内响应、正常小规模派生值、连续 33 次拒绝后正常预览、多个来源累计限制、替换处理量、URL 预算异常传播及私密值集合上限。各用例检查来源和管理配置不变、错误无秘密、预览零网络及零进程启动；只沿用探测状态的隔离 stub。

使用 Node **22.23.3**、pnpm **12.10.1**，以下命令均 exit 0：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts test/mcp-migration-alias.test.ts test/mcp-migration-privacy.test.ts test/mcp-management-gitignore.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/core/i18n.test.ts electron/main/ipc/mcp-management-validation.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

最终相关测试 **22 文件、620 项通过**，不是全仓库测试；lint 保留既有 warning。完整日志保存在本机临时验证目录，文件名为 `privacy-budget-{format,lint,typecheck,tests,build,hosted}.log`，同输入计时证据为 `full-preview-timer.json` 和 `full-preview-timer-after.json`。

未参与实现的子代理只读定向复核报告 **no findings**；独立运行 6 项预算／异常／替换膨胀边界，并在当时运行隐私回归 32/32 通过。之后仅再补 2 项测试并由主代理运行上述完整相关回归，生产实现未变。本次不是整个 64 文件 WIP 的重新双轴审查。追加本段 QA 前的 64 文件冻结补丁 SHA256 为 `18d9b28f6acd8adf08fd603022b521745d2fa65c11b16db95be5688e62df055d`。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `ed31dd52a5800e9d216fe2b854908241c095cca30bf09657fc855aa45df90436` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `646682a521869050a9a2802c855c454f7344610bf3874de91bac93429ee90947` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

没有重做图形或跨平台实机验收，没有访问个人 Agent 配置或调用真实模型；未覆盖安装、提交、推送或发布。所有既有工作树改动均保留。

## 后续原生配置扫描快照复用修复

本次独立审查基准为 `origin/main @ 8866701b5d7f90ebae369fd4549dac74cb9c9add`，HEAD/merge-base 为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。修复前 64 文件的完整 dirty 审查补丁 SHA256 为 `7461838b1c14d37672207737266cbf51c43a2dccd94a93aed69d42667424fc89`。Standards 确认 1 项新增 P2：扫描对每个服务重新读取、解析和哈希同一完整文件，导致服务数量放大同步阻塞；Spec 为 0 项。本段只记录该问题的修复与定向复核。

- `mcp-native-scan.ts` 每次扫描一个配置文件时，复用同一次安全读取产生的服务映射与 SHA256，逐项归一化不再调用完整文件读取。快照不跨扫描持久缓存，原生秘密识别、工作目录判断及公开配置脱敏保持不变。
- 独立的 `readNativeMcpImport` 仍重新检查路径、读取、解析和哈希；预览、收录应用及迁移前的实时来源验证没有改成复用扫描快照。保留文件上限、损坏配置拒绝和不可等价转换的拒绝行为。
- 新增 `mcp-native-scan-snapshot.test.ts` 的 17 项回归，并加入 `test:backend:stability`，由既有 Windows/Linux CI 入口运行。覆盖 TOML、JSON、OpenCode JSONC、OpenClaw JSON5、YAML，候选完整性、共享指纹、凭据脱敏、YAML alias 不污染原文、相同大小和 mtime 下的外部修改、删除、格式损坏、1 MiB 边界、非普通文件、符号链接祖先及注册工作区限制。

原审查使用的同一份 **710,168 字节、128 个服务**隔离 OpenClaw 配置：修复前扫描 **6,600 ms**、无关计时器 **6,600 ms**；修复后扫描 **60 ms**、计时器 **69 ms**，128 个候选全部保留。1/16/128 服务的修复后扫描分别为 63/63/60 ms。计时是本机合成用例的实际测量，不代表跨机器性能保证。原始测量保留，修复后单独写入 `scan-measurements-after.json`；没有覆盖旧失败证据。新回归使用 **710,278 字节、128 个服务**，原实现扫描 **7,020 ms**，1 秒预算断言失败；修复后 17/17 通过。

使用 Node **22.23.3**、pnpm **12.10.1**，以下命令均 exit 0：

```sh
pnpm format:check
pnpm exec oxfmt --check package.json apps/desktop/test/mcp-native-scan-snapshot.test.ts
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts test/mcp-migration-alias.test.ts test/mcp-migration-privacy.test.ts test/mcp-management-gitignore.test.ts test/mcp-native-scan-snapshot.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/core/i18n.test.ts electron/main/ipc/mcp-management-validation.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

最终相关测试 **23 文件、637 项通过**，不是全仓库测试；lint 保留既有 warning。日志保存在本机临时验证目录 `scan-snapshot-fix`，文件名为 `format.log`、`lint.log`、`typecheck.log`、`tests.log`、`build.log`、`hosted.log` 和 `benchmark-after.log`。本次实现和测试完成、追加本段 QA 前的 65 文件冻结补丁 SHA256 为 `090f583af089962fd9df89907649e9364c1dbfd2f53c8af5044ee2d9d7e06ffa`。

未参与实现的子代理定向复核报告 **no findings**。除独立重跑新增 17 项外，还以隔离夹具检查 8 Agent 的 17 个候选与修复前逐字段相等、跨扫描更新、公开读取及符号链接拒绝（3 项），并运行现有 profile 刷新、无效来源隔离和应用拒绝来源变化回归（3 项）。复核记录为 `scan-snapshot-independent/review-results.md`，其中摘录工具回执，并非原始 shell 日志。此结论仅对应本次扫描修复，未重做整个 WIP 的双轴审查。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `668cbb5c8ab7a2be604927bd38e60ae1377314e77f043b5d8a06f7cdebf4e1e5` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `646682a521869050a9a2802c855c454f7344610bf3874de91bac93429ee90947` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本轮没有实际执行 Windows/Linux CI 或实机、Electron 图形与第三方 Agent 重载验收；没有访问个人配置、调用模型、覆盖安装、提交、推送或发布。此前已有改动保留。


## 后续公开脱敏、批量收录与正确连接验证修复

本轮沿用独立工作树 `codex/mcp-management`。审查固定基准为 `origin/main @ 11db45587ea136d464a908b17268a3a4599d11eb`，HEAD/merge-base 为 `fb9c39469e4600f9a94e175adc1f06e75df4921d`。修复前三项 P2 的 65 文件 dirty 补丁 SHA256 为 `78c6de6db2664009ff678a1006d16dae71920b9f8785d024f3f7c97a6006f8ae`，全部已有改动保留。本段只记录三项问题及新增写前预检的修复，不将定向复核描述为整个 WIP 的重新双轴审查。

- **公开配置脱敏膨胀：** 已知私密值先去重，只匹配原始文本，合并重复、相邻及重叠的匹配区间，再生成遮罩。使用线性字面匹配处理重复前缀，不把生成的 `[redacted]` 再次当作待替换内容。每份公开配置的命令、参数、目录或 URL 共用扫描、替换及输出预算；URL 分支不吞预算异常。保存前使用与读取相同的有效配置合并函数，连同继承的私密值一起预检，拒绝时不更改公开文件、私密文件或工作区忽略规则。
- **批量收录重复解析：** 预览、应用和迁移阶段按文件与 Agent 复用本次读取的解析树、正文和指纹，不为每个选中服务重新读取完整配置。快照只活在当次调用内；下一次预览／应用及异步探测之后重新扫描、读取并比较来源、profile、工作区及配置身份。保留逐项错误、凭据键名识别、cwd 判断和原始字节检查。
- **已正确连接缺少验证入口：** 正确绑定的计划行直接提供只读 Hub 握手及工具目录验证，不要求执行空 ChangeSet。尚待补齐的目标不会提前获得该入口。复用写入后的验证组件及请求互斥、revision 和作用域失效保护；Hub 验证成功仍不代表目标 Agent 已重新加载。

新增三份测试：`mcp-public-redaction.test.ts` 13 项、`mcp-native-import-snapshot.test.ts` 13 项、`McpBatchConnectionVerification.test.tsx` 9 项。两个后端文件已加入现有 `test:backend:stability`，供既有 Windows/Linux CI 入口执行，本轮未声称它们已在远端运行。

红绿证据与计时：

- 12 个环境字段重复值 `e` 时，旧公开投影将 `node` 扩成 36,859 字符；新增用例修复前失败，修复后预览／收录／状态均为 `nod[redacted]`，实际保存命令保持 `node`，无服务启动。
- 补充的写前预检用例先复现“配置已经写入，随后状态读取因预算拒绝”的缺陷；独立复核也复现相同问题。修复后单作用域 1,025 个私密值、全局 1,024 个值加工作区 1 个值均在落盘前拒绝，文件与有效状态不变。
- 同一份 710,168 字节、128 服务的 OpenClaw 合成配置，修复前预览／无关计时器约 7,534 ms，修复后约 324 ms。另一轮独立复现的 1／16／128 项预览分别约 142／105／109 ms；这是当前本机测量，不是跨机器性能保证。回归断言每阶段最多两次读取完整来源，预览、收录及无关计时器在 1 秒内完成，并核对来源字节不变、无网络或进程启动。
- 正确连接验证测试修复前缺少入口，修复后覆盖正确／缺少连接混合、失败重试、重复点击、过期成功／失败、工作区及组件作用域切换，以及写入后验证。

原始复现脚本再次运行时覆盖了临时目录中的 `post-scan-root/import-latency.json` 和 `post-scan-standards/preview-measures.json`。本轮输出另存为 `three-findings-fix/import-latency-after.json` 与 `preview-measures-after.json`，覆盖情况记入 `benchmark-provenance.md`；修复前数字保留在先前审查工具输出中，未将被覆盖文件冒充旧原始证据。公开脱敏的旧复现及本轮红灯日志保留。

使用 Node **22.23.3**、pnpm **12.10.1**，实际执行以下命令，均 exit 0：

```sh
pnpm format:check
pnpm exec oxfmt --check package.json apps/desktop/test/mcp-public-redaction.test.ts apps/desktop/test/mcp-native-import-snapshot.test.ts
pnpm lint
pnpm typecheck
pnpm --filter @agentkib/desktop exec vitest run test/mcp-agent-home.test.ts test/mcp-continuation.test.ts test/mcp-management.test.ts test/mcp-management-runtime.test.ts test/mcp-legacy-local.test.ts test/mcp-runtime-scope.test.ts test/mcp-policy-oauth.test.ts test/mcp-oauth.test.ts test/mcp-connection-batch.test.ts test/mcp-policy.test.ts test/mcp-connection.test.ts test/mcp-connection-hub.test.ts test/mcp-native-document.test.ts test/mcp-migration-alias.test.ts test/mcp-migration-privacy.test.ts test/mcp-management-gitignore.test.ts test/mcp-native-scan-snapshot.test.ts test/mcp-native-import-snapshot.test.ts test/mcp-public-redaction.test.ts src/features/mcp/McpManagementLocalization.test.tsx src/features/mcp/McpManagementRaces.test.tsx src/features/mcp/McpImportProvenance.test.tsx src/features/mcp/McpHubPage.test.tsx src/features/mcp/McpBatchConnectionVerification.test.tsx src/core/i18n.test.ts electron/main/ipc/mcp-management-validation.test.ts
pnpm build
pnpm build:web:hosted
git diff --check
```

相关回归 **26 文件、672 项通过**，不是全仓库测试；lint 保留既有 warning，未修改规则。日志位于本机 `/tmp/agentkib-mcp-review/three-findings-fix/`，分别为 `format.log`、`new-test-format.log`、`lint.log`、`typecheck.log`、`tests.log`、`build.log` 与 `hosted.log`。

未参与实现的子代理定向复核报告 **no findings**，独立运行 7 文件 282 项项目测试以及 2 项隔离复现；其中包含 2,000 组随机重叠匹配与独立区间并集算法的对照。该结论包含写前预检修复，未覆盖整个分支、真实 Agent 重载或真实网络。实现和构建完成、追加本段 QA 前的 68 文件完整 dirty 补丁 SHA256 为 `c9af0169b4bec0ce239d2c2c1c0d7da3c66f20df81594f32591e7b6bbed5418f`。

本次构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/desktop/dist-electron/backend.cjs` | `03dc57b82548a0e82873b162f05347451eb68ab927babac4a5e40df86cbc9784` |
| `apps/desktop/dist-electron/main.cjs` | `21966549c04997469ed2ac9d68c633e0c9a1c9fced87882f6435ada2b27e1a0b` |
| `apps/desktop/dist/index.html` | `cee866ec550387e10a2398fc22f38e8ff6e4779d6bcb96cab4995df2692b046e` |
| `apps/web/dist-hosted/index.html` | `32af8b13872b1cd89c4c663267fc49a20c78d0bc1f675cf27869d6785be933a2` |

本轮未重做图形、真实 Agent 重载、模型、OAuth、LAN 或 Windows/Linux 实机验收；没有访问个人 Agent 配置、增加生产依赖或修改数据库表。未覆盖安装、提交、推送或发布。
