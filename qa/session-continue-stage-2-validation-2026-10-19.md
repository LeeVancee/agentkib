# 会话无感续接：第 2 阶段验证记录

日期：2026-10-19。范围：D10 Claude 后端。第 1 阶段按用户授权提交为 `f762c7772`（`feat(sessions): 实现 Codex 会话无感续接`），没有推送。用户审阅后已确认提交第 2 阶段，本记录与本阶段代码、测试一并纳入提交；不推送。

结论：本阶段实现及关键安全回归已完成；默认预算下的全量自动化仍未通过，不能视为全套验证完成。具体失败、隔离结果与诊断预算分别列在“检查”，不以诊断通过覆盖默认预算失败。

本阶段不实施 Claude 界面或四语文案，不删除 Codex Desktop follower，不修改跨 Agent 继续。保留 `.agents/`、`prototypes/`、两份未跟踪的实施／技术前提文档及本机设计文件。

## 改动与文件

| 文件 | 原因与行为 |
| --- | --- |
| `packages/backend/src/claude-session-owner.ts` | 统一读取 `claude agents --json`、配置目录的 PID 注册与 `ps`，校验 PID、UTC `procStart`、路径／文件边界；无法证明空闲时拒绝启动。每次启动重新检查，不缓存启动许可。 |
| `packages/backend/src/claude-managed-runner.ts` | 在实际 spawn 前提供 `beforeStart` 防线，覆盖首次启动、原对象回收后 send、prepare／队列／设置重新启动。 |
| `packages/backend/src/claude-managed-read.ts` | 首次发送自动建立托管记录；空闲时刷新经过身份校验的历史指纹；默认 10 分钟和最后订阅者离开后的安全回收；运行中外部占用巡检与停机；启动状态与原因码；占用来源只读分支。 |
| `packages/backend/src/claude-bridge.ts`、`packages/backend/src/index.ts` | 接入两端共用的订阅观察；插件与后台启动互斥，包括原生会话的不同索引别名；保留损坏注册表和未知回执防线。干净的离线插件绑定不再要求手动断开，已连接但首 snapshot 未到、未决回执仍阻止另起后台进程。 |
| `apps/desktop/electron/main/web/local-claude.ts`、`service.ts`、`continuation-reason.ts` | 桌面本地与 Web 宿主取消人工确认门，保留设备权限、实验开关、boot、revision、附件、未知结果校验，透传明确安全的占用原因。 |
| `packages/web-client/src/index.ts` | 增加可选的后台结束／冲突通知字段，供下一阶段界面使用。 |
| 新增 `claude-session-owner.test.ts`、`claude-auto-continue.test.ts`、`claude-bridge-auto-continue.test.ts` | 占用来源、每次重启、回收、竞态、插件互斥及未知回执回归。 |
| 既有 `claude-managed-parity`、`claude-web-backend-integration`、`claude-permission-mode`、`claude-retirement-usage`、`claude-config-writes`、`claude-frame-drift-process`、`claude-acp-live-state`、`claude-bridge-runtime` 测试；`local-claude`、`claude-host` 宿主测试 | 改为验证无确认续接，同时保留旧设置、权限、资源、usage、作者及持久回执约束；补充占用分支和原发送请求 ND 回执。只读探测 fixture 明确允许版本／agents／ps，不放行 resume／print 等执行命令。 |

内部 metadata lease 与 CLI worker lease 继续保留。自动回收不把“有 runner 对象”当成“已有进程”，实际重新启动必须经过最终占用检查。已有未确认的外部副作用不能通过自动续接清掉。

## 先补测试的证据

- 回收后原 runner 再次启动：旧实现明确错误接受外部占用时的发送；新增生命周期版本曾为 13 项中 11 失败、2 通过。原始真实 `ps` 复现保留在 `/tmp/agentkib-claude-auto-continue-red.log`，后续红证据在 `-red-lifecycle.log`、`-red-final.log`。
- runner `send`／`prepare` 的最终启动检查：两项先红，日志 `/tmp/agentkib-stage2-runner-start-red.log`。
- 统一占用探测：初版 stub 19 项中 16 失败；实现后补至 25 项，包含 agents 与 ps 时序竞态先红再绿，日志 `/tmp/agentkib-claude-owner-observation-red.log`。
- 本地／Web 确认门：63 项中 25 项先红，修改后相关 5 文件 106 项通过；日志 `/tmp/agentkib-stage2-host-red.log`、`-green.log`。
- 只读分支：未托管、已释放、外部正在写入下一轮三场景先红，修复后 3 项通过；日志 `/tmp/agentkib-stage2-busy-fork-red.log`、`-green.log`。验证原历史字节不变，子会话新 UUID 与完成轮次 cutoff。
- 发送前突然被占用：真实 Web 宿主 → Backend 先返回 HTTP 500／unknown；修复后 HTTP 409／明确占用，并按原 requestId 保存 `not-dispatched`，解除占用后安全新发；日志 `/tmp/agentkib-stage2-owner-race-red.log`、`-green.log`。
- 插件接入：自动回收后接入的 2 项先红；别名 active／unknown／已连接插件的三项互斥也先红。日志 `/tmp/agentkib-claude-bridge-auto-red.log`、`/tmp/agentkib-claude-bridge-alias-red.log`。
- 启动中状态、关闭与挂起探测竞态、回执重放、并发名额去重均有回归。名额测试先在第 5 个初始化进程错误触发上限，修复后允许 8 个、拒绝第 9 个；日志 `/tmp/agentkib-claude-auto-continue-reservations-red.log`。
- 已经明确检测到外部占用时，运行中追加也必须立即停止并拒绝，不能再等下一次巡检；新增 steer 回归先红再绿，日志 `/tmp/agentkib-claude-auto-continue-steer-red.log`。相同防线覆盖审批与回答，停止仍可用。
- 离线插件绑定的自动恢复先红再绿，保持新鲜连接和未知回执互斥；日志 `/tmp/agentkib-claude-bridge-offline-red.log`。
- 既有真实 Backend／Web 插件回归发现自己的 dispatched 回执会阻断完成上报（HTTP 410）。已只允许经过认证且 bindingId、nativeId、workspaceId 全部匹配的原插件回报自己的命令；新配对、错误绑定和 managed 未决命令仍拒绝。先红日志 `/tmp/agentkib-claude-bridge-runtime-post-adapt.log`，最终 85 项组合日志 `/tmp/agentkib-claude-bridge-binding-final.log`。

自动化只启动临时 Node fake CLI 与真实本地进程／socket，不调用模型、不读取用户对话。非占用专项的既有 fixture 使用受控进程表，避免无关设置测试反复扫描全机；解析／降级／PID 复用由占用模块测试覆盖。没有删除旧测试或放宽既有超时。

后续对 Web 多步骤集成用例做了临时副本采样：所有业务断言通过，body 7696.6ms；14 次 owner probe 共 3967.6ms，其中启动 `agents` 的 14 个 Node 进程耗时 3935.6ms，版本查询另耗 724.4ms。19 次历史身份验证仅 11.2ms。证据为 `/tmp/agentkib-stage2-refs-performance-profile.log`、`/tmp/agentkib-stage2-refs-performance-metrics.jsonl`。

该套测试的目标是 Web 宿主 → 后端 → worker 收发／设置／分支行为，故仅把 fixture 中精确的空闲 `agents --json` 响应改为受控 `[]`，如同原有的进程表替身；真实 worker 启动、stdin、退出、版本、全部业务断言与原 5000ms deadline 均保留。占用来源、启动前检查、真实 Web 中途占用由独立专项覆盖。临时性能副本已删除，没有混入仓库。

## 检查

沿用第 1 阶段的既有 pnpm 10.8.1 和临时 userconfig，绕过本机 pnpm 12.10.1 自动切换的 `ENOEXEC`；没有安装或升级依赖。

- `pnpm typecheck`：通过，backend／desktop／Web 全部通过；Web 路由生成有既有循环依赖提示。
- `pnpm lint`：通过，0 错误、266 条警告。
- `pnpm format:check`：通过，953 个匹配文件；新增 backend 测试另做局部 `oxfmt --check`。
- 新生命周期回归：19／19，通过。日志 `/tmp/agentkib-claude-auto-continue-final19-green.log`。
- 占用探测、自动插件续接、既有 bridge 和真实 Backend 插件四文件：85／85，通过（25＋16＋41＋3）。日志 `/tmp/agentkib-claude-bridge-binding-final.log`。
- 既有 Claude／ACP 状态测试：55／55，通过。仅适配新增只读占用探测，原 compaction、revision、ND、unknown fence 断言保留；日志 `/tmp/agentkib-claude-acp-isolated-green.log`。
- 两端宿主相关五文件：106／106，通过。日志 `/tmp/agentkib-stage2-host-green.log`。
- 既有后端六文件最终组合：187 通过、2 项触发既有 5000ms 超时、1 项跨仓库跳过（总 190 项）。两项 goal／MCP 超时单 worker 隔离复跑均通过，没有修改既有超时。日志 `/tmp/agentkib-stage2-existing-backend-final.log`、`/tmp/agentkib-stage2-existing-timeouts-final-isolated.log`。不据此把最后组合写成全绿。
- fixture 优化后的 Web 集成文件：27 通过、2 项原 5000ms 超时、1 项跨仓库跳过（总 30 项），仍未全绿；失败为重启后队列消费、文件引用／重命名／分支／归档。日志 `/tmp/agentkib-stage2-claude-integration-frozen-final.log`。
- 仅对上述两项另做 `--testTimeout=15000` 诊断运行，全部业务断言通过（2／2，测试合计 4.34s）；没有修改测试文件的 deadline。日志 `/tmp/agentkib-stage2-integration-diagnostic-budget.log`。这不能替代默认预算未通过的结果。
- 完整 `pnpm test:web`：59 文件、1194 项全部通过。
- 最新完整 `VITEST_MAX_WORKERS=1 pnpm test` **未通过**：桌面 356 文件通过、3 文件失败、1 文件跳过；6775 项通过、5 项失败、3 项跳过，耗时 1359.34 秒。桌面失败后该命令未继续运行 Web，已用独立完整 Web 测试补齐。日志 `/tmp/agentkib-stage2-final-test.log`。
- 上述 5 项失败：Claude 集成的文件引用／分支与终端丢失后停队列两项 5000ms 超时；未修改的 `skill-native-directory-names.test.ts` 两项与 `skill-sync-manager.test.ts` 一项 5000ms 超时。终端丢失用例超时后，还伴随 `afterEach` 对 `backend.close()` 应拒绝的断言未满足；该用例在隔离原预算运行中通过，不能据超时后的清理结果单独判断业务缺陷，也不能把它隐去写成全绿。
- 生产源码在上述完整运行中保持冻结；Web 集成 fixture 的探测 IO 优化发生于该文件已执行之后，因此全量不覆盖优化后的 fixture。优化后的整文件默认预算与诊断验证结果已在上文分别列出。此前两次全量运行与补丁交错，已中断，不作为最终通过证据；日志保留为 `/tmp/agentkib-stage2-interrupted-pre-final-test.log`、`/tmp/agentkib-stage2-interrupted-routing-test.log`。
- 较早并行全量还出现两项未修改 UI 用例失败；单 worker 隔离 2／2 通过，未改 UI 或测试。它们完全 mock WebClient／claudeRequest／会话流，没有后端运行调用；只能确认隔离不复现，不能仅依据负载认定唯一原因。日志 `/tmp/agentkib-stage2-ui-isolated.log`。

```sh
export npm_config_userconfig=/tmp/agentkib-pnpm-session-continue.npmrc
export NPM_CONFIG_USERCONFIG=/tmp/agentkib-pnpm-session-continue.npmrc
export npm_config_manage_package_manager_versions=false
export VITEST_MAX_WORKERS=1
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:web
```

静态检查日志：`/tmp/agentkib-stage2-final-{typecheck,lint,format}.log`。完整测试日志：`/tmp/agentkib-stage2-final-test.log`；Web：`/tmp/agentkib-stage2-final-web.log`。

本轮环境中观察到 load average 从约 495 上升至 669，系统 `/bin/ps` 的全量及按 PID 查询都曾阻塞约两分钟，连测试清理的进程树扫描也受影响。区分业务断言失败、旧 fixture 与环境超时，不将这些现象直接视作唯一根因，也不宣称全量通过。

## 实际 CLI 与待验收项

动手前的第 7 节实测已经完成，详见第 1 阶段记录。Claude Code 2.1.302 无参数普通交互会话确实出现在 `agents --json`，PID 注册的 `procStart` 可与 UTC 进程时间核对；本阶段沿用此实测前提，没有发现需要更换方案的差异。

| 技术前提文档验收项 | 当前覆盖与限制 |
| --- | --- |
| 1：关闭终端后自动续接、10 分钟回收、回终端续接 | 后端 fake CLI 已覆盖首次发送、默认时间、配置时间、重新启动及历史刷新；尚未使用真实模型完成整条产品流程。 |
| 2：普通终端占用、只读分支 | 真实普通 CLI 注册探测已实测；后端占用、完成 cutoff、源字节不变和子会话执行有自动化；真实 CLI 分支与选择条留待第 3 阶段验收。 |
| 3：运行中打开终端 | fake CLI 覆盖即时停止及通知原因；尚未用真实 CLI／模型验证历史无交错。 |
| 4–6：Codex 空闲、外部写锁与释放 | 见第 1 阶段记录；本阶段没有扩大手动覆盖。 |
| 7：Windows Claude／低版 Codex 只读 | 后端平台与版本检查保留；没有 Windows 真机验收，Claude 界面在第 3 阶段。 |
| 8：手机／Web 与桌面 | 共用后端和两端宿主有回归；Claude 手机界面／四语视觉验收尚未开始。 |

## 文档解释与阶段边界

- 最后订阅者离开时，沿用用户已确认的“等当前轮次完成后释放”，不打断回复、审批或压缩；从未有订阅者的后台任务不立即误回收。
- `AGENTKIB_CLAUDE_IDLE_TIMEOUT_MS` 可配置闲置超时，默认 `600000`；周期检查默认 `3000` 毫秒。测试注入短周期或受控时钟，不真实等待十分钟。
- 暂不调整 Claude 界面、四语文案及术语表；这些属于第 3／4 阶段。没有删除 follower；删除仍需单独询问用户。
- 自动巡检只能缩小 Claude 外部客户端不认 AgentKib lease 的并发窗口，不能提供跨进程原子锁保证；最终启动前再次探测和运行中停止均保留。上线前政策确认仍由产品负责。
