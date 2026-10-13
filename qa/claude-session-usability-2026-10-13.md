# Claude 会话状态与标题修复 QA — 2026-10-13

## 源码与范围

- 基线：重新 fetch 的 `origin/main`，`609146cf9b0c59455e5dc70c6954717c1afc3e1b`。
- 实施分支：`codex/claude-session-usability`，独立工作树。开始时工作树干净；验收时为基线上的未提交修改，本记录不代表已发布产物。
- 工具链：Node `22.23.3`、pnpm `12.10.1`，`pnpm install --frozen-lockfile`；没有升级锁文件或新增依赖。
- 验收期间不修改个人 Claude 日志、配置、授权或已安装应用；无真实模型调用、commit、push 或发布。

## 行为证据

- `handoff-required` 使用专门的四语言提示，不再回退成主机安装未验证；输入区入口打开原有执行归属面板。
- 桌面通过真实 EmbeddedConversation／WebClient／桌面桥接适配器测试；Web 通过真实 Provider／controller／WebClient 测试。仅模拟 IPC 或 HTTP／事件边界。
- 打开、关闭面板及未勾选确认时不派发变更请求；保留输入草稿。确认后只派发一次 `managed/adopt`，保留会话身份与已检查的历史指纹，不派发 `send`。
- 已打开面板在断线、发送权限撤销、接管能力失效、能力属于其他会话或结果未知时不能接管；切换会话后的迟到检查不能恢复旧确认或旧指纹。
- 未接管 Claude 缺少上下文报告时显示“暂无数据”；权限、离线、具体错误、pending／stale、有效零用量及其他 Agent 的显示保持原行为。
- 17 项标题测试覆盖无索引、空索引、保留有效索引、字符串／文本块、内部和工具／附件过滤、自定义标题身份、Unicode、损坏记录以及 2 MiB／256 行预算。重复扫描不改变原生文件字节或新增原生索引。
- `adopt` 仅补入前端既有能力字段的类型声明，后端协议、鉴权、版本门限及数据库结构未改变。

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check` | 通过，732 个匹配文件 |
| `pnpm lint` | 通过；90 条既有警告，全部来自未修改文件 |
| `pnpm typecheck` | Backend、桌面、Web 全部通过 |
| `pnpm --filter @agentkib/desktop exec vitest run test/claude-session-titles.test.ts test/history-search-source.test.ts test/claude-managed-parity.test.ts` | 3 文件、99 项通过 |
| `pnpm --filter @agentkib/web exec vitest run --maxWorkers=2` | 最终 36 文件、704 项通过 |
| `pnpm --filter @agentkib/desktop exec vitest run --maxWorkers=2` | 209 文件通过、2 文件失败；3127 项通过、2 失败、2 既有跳过，详见下文 |
| `pnpm --filter @agentkib/desktop exec vitest run test/claude-web-backend-integration.test.ts test/claude-managed-parity.test.ts --maxWorkers=1` | 两个失败文件独立复核：56 项通过、1 项既有跳过，无未处理错误 |
| `pnpm build` | 桌面构建通过，包含 Web、Renderer 和 Electron／Backend 产物 |
| `pnpm build:web:hosted` | hosted Web 构建通过 |
| `git diff --check` | 通过 |

首轮 `pnpm test`：桌面 3108 通过、20 失败、2 跳过；20 个失败均为原有 5000 ms 超时，未出现断言内容差异。运行期间系统 load average 超过 140。保留原断言及期限，随后改用 `vitest run --maxWorkers=2` 降低并发检查。

首轮 Web 全集发现旧接管夹具缺少生产实际返回的 `handoff-required` 和 `adopt.available`。夹具已补齐，原指纹、派发次数和载荷断言没有降低要求。

桌面双 Worker 复测剩余两个时序失败：一项集成用例超过原有 5000 ms；另一项撤权握手用例未在原有轮询期限内观察到初始化帧，清理随后产生一次预期错误不匹配的未处理 rejection。保留这些失败结果；仅独立运行原文件后 56 项通过、1 项跳过，没有未处理错误。没有延长期限、修改相关测试或改动执行协议。

因此，所有已出现的失败均已复核通过，但不将全量单次运行记录改写为全绿。桌面新增真实桥接用例包含在双 Worker 全集中并通过。构建过程保留现有依赖警告，不影响退出状态。

## 独立审查与边界

- 使用 `code-review` 技能，以固定基线分别进行 Standards 和 Spec 独立子代理审查：两轴均为 no findings；最后的桌面回归与夹具补齐亦完成 Spec 复核。
- 自动化使用合成记录与隔离数据，不能替代真实模型回复、实体手机或 Windows/Linux 实机验收。
- 只保证头部预算内的标题发现；预算之外的原生重命名同步不属于此次修复。
- 本次构建用于验证源码，不生成或安装更新包；当前已安装版本不会自动获得这些修改。
