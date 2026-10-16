# Claude 边界修复与回归 — 2026-10-15

## 源码身份与范围

- 审查基线：`origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`。
- 修复起点：本地 `main @ bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`，已有 37 个跟踪文件未提交修改，另有此前测试与 QA。保留这些修改以及 `.agents/`、`prototypes/`。
- 修复前保存了跟踪文件、相关未跟踪测试与 QA 的副本、SHA256 和补丁。本轮增量为 21 个源码、测试、配置及文档文件（包含本 QA）。本记录仅描述本轮六项问题及复核发现的相邻性能问题，不替代旧 QA 或改写旧失败结论。
- 工具链：macOS arm64，Node `22.23.3`、pnpm `12.10.1`；锁文件中的 Electron `44.0.0`。
- 未新增生产依赖、公共协议或业务数据库结构，未调用真实模型、修改个人 Agent 配置、处理钥匙串或覆盖安装版应用。未提交、推送或部署。

## 修复及可观察结果

1. **包装命令中的凭据。** `timeout`、`sudo` 等无法可靠拆解的执行包装含敏感 curl 参数时，保守隐藏片段。引用、拼接、续行及单独或组合账号参数均先按完整 shell 字面参数脱敏；动态命令不执行。command 元数据改为先脱敏、再合并显示空白，避免提前把 shell 续行变为空格而丢失敏感边界。真实 Context 设置与 MCP command 元数据不再暴露合成凭据。普通 `python -u`、字面描述、转义美元符仍保留。
2. **同步脱敏的重复扫描。** 秘密参数名、赋值名、URL 和 query 名称改为顺序分段扫描；占位符固定长度并转义输入，避免扩大占位符后再次回溯。非敏感 URL 参数中的嵌套敏感 query 也会继续检查；展示截断仍在完整脱敏后进行。独立 Backend 子进程测试覆盖十种约 50 KB 输入，在 Context RPC 与 HTTP MCP 两种入口分别并发查询工作区，并使用独立 1 秒看门狗；超时会终止子进程，避免测试自身一起卡住。
3. **保留 UUID 的历史版本。** 当前链保持最新版本；每个压缩边界按其之前最近的 occurrence 接回父链。已输出 UUID 的旧版本仍参与追溯，正文不重复输出。覆盖同一保留链多次重写、中间版本、重复正文、工具关联、默认摘要与完整交接。
4. **未来记录不能补足旧历史。** `logicalParentUuid` 候选及其祖先必须在当前边界之前；否则尝试保留段头部，均失败时保留断链状态，不把边界后的无关根分支拼入历史。Claude 正文缓存标记升至 `claudeLineage:3`，旧索引重建，旧定位失效；其他 Agent 的缓存身份不变。
5. **异常帧不改变工具投影。** `unattributed` 帧在投影入口跳过，不能新建、覆盖或伪完成主线程工具。真实 runner 与模拟 CLI 覆盖七类异常 parent、审批/问题 revision、事件数量、正确主线程恢复及成功终态；合法子代理工具仍平铺，覆盖 256 UTF-8 字节身份边界。
6. **完整停用列表。** 保留现有配置读取预算内所有有效 disabled 名称，不因超过 1024 项或名称超过 256 字符而丢失停用标记。真实 BackendStore/MCP 扫描覆盖 1023、1024、1025、4097 项、其他工作区隔离及源配置字节不变。这是展示修复，不改变原生权限决定。

独立复核另发现：大量边界复用同一条长保留链时，历史回溯会反复访问未变节点。补充所有历史候选共享的 250,000 次节点查找预算，包含失败候选、缺链、环和 fallback；耗尽时保留已接受部分并标为 `compaction-link-unavailable`。正文搜索显示部分覆盖，包含压缩前完整历史的原生导入仍拒绝，用户明确确认后的文件交接保持可用。最新活动链不受这个历史回溯预算截断。

## 验证

以下最终检查在脱敏续行、元数据顺序及历史预算补修全部冻结后执行，全部退出码为 0。定向集合存在重叠，不将次数相加为唯一测试数。

| 实际命令或检查 | 结果 |
| --- | --- |
| `pnpm --filter @agentkib/desktop exec vitest run test/claude-project-config.test.ts test/mcp-claude-settings.test.ts test/mcp-claude-scopes.test.ts` | 3 文件、93 项通过 |
| `pnpm --filter @agentkib/desktop exec vitest run test/claude-compaction-document.test.ts test/claude-compaction-handoff.test.ts test/history-search-source.test.ts` | 最终 3 文件、154 项通过；独立复核另跑同组通过 |
| 脱敏、Context/MCP 资产与独立 Runtime 定向回归 | 最终 6 文件、352 项通过；原始日志见下 |
| `pnpm format:check` | 通过，818 文件 |
| `pnpm lint` | 通过，无错误；任务外 React hooks 等文件仍有既有警告 |
| `pnpm typecheck` | Backend、桌面、Web 全部通过 |
| `pnpm test` | 桌面 260 文件、4913 项通过、2 项既有条件跳过；Web 37 文件、765 项通过 |
| `pnpm build` | 桌面 Renderer、Electron 主进程、Preload、Backend 与随附 Web 构建通过 |
| `pnpm build:web:hosted` | 通过 |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs` | Electron 44.0.0 / Node 24.18.1 下内容索引/查询、Skills、交接读取 Worker 均通过 |
| `git diff --check` | 通过 |
| 修复起点与最终文件 SHA256 对照 | 本轮 21 文件以外的已有跟踪文件及已备份未跟踪测试/QA 均无变化 |

未削弱断言或新增跳过。十类长输入用例在独立的串行 latency 测试组中执行，避免与普通测试 Worker 争抢 CPU；看门狗在独立父进程内运行，不能被被测 Backend 的同步阻塞一并拖住。

## 独立复核与边界

- 异常帧投影及停用列表：独立复核 no findings；另跑 5 文件、201 测试通过。
- 历史谱系：首轮功能检查和 148 项测试通过，独立性能 probe 找到重复扫描问题；补修后独立复核 no findings，154 项回归及 9 个精确预算边界断言通过。原最大探针从 6349 ms 降至 63 ms，并正确返回不完整状态。
- 脱敏与 Runtime 性能：首轮独立复核发现未知包装内嵌套脚本引号拼接、非敏感 URL 参数内嵌敏感 query 两个遗漏；续行复验又发现元数据提前折叠空白的根因。补修后独立复核 no remaining findings，真实 Context/MCP 表面和安全文本、marker 恢复均通过。最终定向 352 项通过，包含十类长输入的独立 Runtime 看门狗。

本轮使用合成历史、配置和模拟 CLI，不将自动化结果视为真实 Claude、新版本 CLI、手机或 Windows/Linux 实机验收。

## 本机证据

临时目录可能被系统清理；仓库内本记录是摘要，不冒充完整原始日志。

- `agentkib-fix-six-20261015-z7uv66dd/`：系统临时目录下的修复前源码副本、`identity.json` 和 `before.patch`，以及异常帧测试日志。
- `/tmp/agentkib-six-fixes-disabled-tests.log`：停用列表定向测试，3 文件、93 项通过。
- `/tmp/agentkib-fix-six-redaction-20261015/`：脱敏前后 probe、补丁及定向测试日志；`tests-followup.log` 记录最终 352 项通过，`build-followup.log` 记录对应 Backend 构建。
- `/tmp/agentkib-six-fixes-performance-probe.log`：原 50 KB 复现修复后，Context 14.37 ms、McpBuiltins 15.60 ms（单次本机结果，不代表性能保证）。
- `/tmp/agentkib-lineage-review-probe-gnfBJ4/probe.mjs`：直接加载实际谱系函数的独立性能 probe；补修前 53,002 行 / 2.91 MB 历史约 6.35 秒。

- `/tmp/agentkib-six-fixes-final-{format,lint,typecheck,test,build,hosted,worker}.log`：最终完整检查日志。
- `/tmp/agentkib-six-fixes-source-20261015.json`：最终本轮增量文件 SHA256。
