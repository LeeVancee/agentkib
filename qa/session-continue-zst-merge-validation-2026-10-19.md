# Codex 压缩记录合并与无感续接回归

日期：2026-10-19。用户授权将 `/Users/kouzen/Documents/data/agentkib-codex-zst` 合并至当前分支，并检查是否回退到旧续接实现；不推送。

## 合并与保留范围

- 当前分支 `codex/ui-ux-recheck-2026-10-17`，合并前提交 `07bd4510bdb4cd098d583395e44055101d6cf1db`。
- 来源分支 `fix/codex-compressed-rollouts`，提交 `33fb8d1d36adb890e2ba4f24cedf95449544676c`。
- 共同祖先 `683b0a427f2c1e5c03cda573c33bdafe14da25a6`，即 Claude 界面第 3 阶段。采用三方合并，无冲突，不以旧分支整份文件覆盖当前工作区。
- 来源只涉及压缩读取的 5 个文件，与共同祖先之后第 4 阶段和独立审查修复的 42 个文件没有交集。合并后逐文件比较，这 42 个文件中仅 `codex-auto-continue.test.ts` 因本轮新增 4 条集成回归而变化，其余逐字节保留。
- D11 继续从 `managedControl` 自动进入 CLI 续接，保留 lease、账本、版本、会话身份与派发边界检查；原生占用及未知回执继续阻断发送，不接回 follower，不要求手工确认接管。
- Claude 每次 runner 重启的占用检查、fork 身份识别、关闭期间资源回收、分支附件迁移、桌面与 Web 四语及术语保持现有实现。跨 Agent 继续及 `handoff.*` 不改；Codex follower 保留。
- 本机 `.agents/`、`prototypes/`、两份未跟踪实施/技术文档和设计文件不纳入合并提交；来源 worktree 保留。

## 合并时补修的问题

来源实现经复核发现以下压缩读取边界，均先补回归复现，再修复：

1. 每次缓存命中更新解压副本的 mtime，导致下一页的指纹游标失效。改用私有 `.used` 标记记录近期使用，副本的纳秒 mtime 保持不变；跨缓存实例也能看到近期使用情况。
2. 不同后端进程/实例首次同时解压同一记录时，`rename` 替换已发布副本的 inode，使先返回读者的游标失效。改为硬链接原子首次发布；`EEXIST` 时只复用大小符合本次完整输出、同用户且权限私有的安全常规文件，不覆盖赢家 inode。
3. 合法短头后的正文高度可压缩时，少量压缩输入可解出超过 32 MiB，导致头部读取误拒绝会话。仅对输出超限错误缩小输入寻找有限前缀；不放宽 32 MiB 单次输出、256 KiB 索引身份头或 64 KiB 控制身份头限制。
4. 已发布缓存副本被替换成软链接时原先仍会复用。命中及并发复用均验证普通文件、非链接/reparse、所有者及私有权限，拒绝异常副本，不修改外部文件。

压缩专项由原 9 条增至 15 条，补充高压缩短头、超长头拒绝、逐页重新解析缓存、跨实例近期使用、并发首次发布及缓存软链接回归。原有分页、事件 ID、字节上限及文件安全断言保留。

提交前补充平台核对发现测试可移植性问题：Windows 不提供 POSIX owner/group/other 权限位，创建文件软链接也可能需要 Developer Mode 或提权。沿用仓库 `remote-tls-native`、`mcp-management`、`codex-session-classification` 的惯例，仅在 POSIX 检查 `0600/0700`，两条主动创建文件软链接的用例在 Windows 跳过；所有通用读取、分页、身份、大小及并发回归仍执行，生产平台和安全检查不变。当前 macOS 的测试断言和执行数量均保持不变。

另新增 4 条自动续接集成回归，实际使用 SQLite 线程表 → `CodexSessions` → `SessionStore` → `SessionReaders`，仅模拟 CLI app-server 和版本探测：压缩历史可读且自动发送、原生占用阻断、未知回执阻断重发、缓存身份变化拒绝续接。原 34 条自动续接测试保留。

本次相对第一父提交的文件清单：

- `packages/backend/src/codex-rollout-files.ts`：压缩文件解析、安全前缀、流式解压及私有缓存。
- `packages/backend/src/codex-sessions.ts`：原记录路径缺失时查找压缩同名文件，按文件身份验证及缓存会话头。
- `packages/backend/src/session-readers.ts`：分页与文档读取复用解压副本。
- `packages/backend/src/history-search-source-jsonl.ts`：全文索引流式读取压缩记录，按解压后字节执行上限。
- `apps/desktop/test/codex-compressed-rollouts.test.ts`：15 条压缩读取与缓存边界回归。
- `apps/desktop/test/codex-auto-continue.test.ts`：保留原 34 条并新增 4 条真实压缩历史与 D11 集成回归。
- 本 QA 记录：合并保留依据、修复、独立复审及验证证据。

## 独立复审

- 未参与本轮实现的代理独立核对 D11/Claude 续接链路、后续修复保留、缓存补丁和真实压缩集成测试：**no finding**。
- 另一只读代理独立核对压缩头、分页/文档/索引入口、原子缓存发布、文件安全和异步 FD 生命周期：**no finding**。
- 两次结论来自代码及测试设计审查；平台补充发现的测试问题修正后再次独立复审，最终 **no finding**。没有将未执行的 Windows 或真实 CLI 验收计为通过。

## 验证

工具链沿用前四阶段：本机 pnpm 10.8.1，通过 `/tmp/agentkib-pnpm-session-continue.npmrc` 关闭自动包管理器切换；未安装或升级依赖，不改仓库包管理器设置。命令均在仓库根目录执行，带以下环境变量：

```sh
export npm_config_userconfig=/tmp/agentkib-pnpm-session-continue.npmrc
export NPM_CONFIG_USERCONFIG=/tmp/agentkib-pnpm-session-continue.npmrc
export npm_config_manage_package_manager_versions=false
export VITEST_MAX_WORKERS=1
```

- `pnpm --filter @agentkib/desktop backend:build`：通过，重建实际 worker bundle 后再执行组合验证。
- 自动续接单文件：38/38 通过。
- 压缩专项：15/15 通过。
- `pnpm typecheck`：后端、桌面和 Web 通过。
- `pnpm lint`：通过，0 错误、275 条现有警告；额外对两个本轮测试文件运行 `oxlint` 通过。
- `pnpm format:check`：963 个匹配文件通过；额外对两个后端测试文件运行 `oxfmt --check` 通过。
- 完整相关桌面组合：76 个文件，1636 条通过、1 条按原配置跳过，196.97 秒。原 75 文件组合完整保留，并加入压缩专项；未调整任何 test/hook 超时预算或削弱安全断言。原跳过项为未启用 Relay fixture 的跨仓库 broker/frp WSS 集成。
- 历史读取补充组合：7 个文件、245 条全部通过，32.70 秒，覆盖分页、分类缓存、全文索引 source/worker/runtime/lifecycle。
- `pnpm test:web`：61 个文件、1244 条全部通过，95.06 秒。
- 组合完成后仅补上述测试平台条件，当前 macOS 执行语义不变；压缩专项再次 15/15 通过（620ms），两个测试文件的 `oxlint` 和 `oxfmt --check` 通过。生产代码在完整组合之后没有变化。
- `git diff --check` 和暂存差异检查通过，提交前再核对清单。

未进行真实 Codex CLI 压缩/续接、Windows 真机或不支持硬链接的非标准临时文件系统验收；本轮自动化使用真实文件、zstd 和 SQLite，不代表这些人工验收已完成。未执行全仓库 `pnpm test`。


复现命令：

```sh
pnpm --filter @agentkib/desktop backend:build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec oxlint apps/desktop/test/codex-auto-continue.test.ts apps/desktop/test/codex-compressed-rollouts.test.ts
pnpm exec oxfmt --check apps/desktop/test/codex-auto-continue.test.ts apps/desktop/test/codex-compressed-rollouts.test.ts
pnpm --filter @agentkib/desktop exec vitest run \
  src/features/sessions \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  src/features/workspace/SessionHandoffDialog.test.tsx \
  test/codex-auto-continue.test.ts \
  test/codex-runtime-preflight.test.ts \
  test/codex-app-server-dispatch.test.ts \
  test/codex-resume-command.test.ts \
  test/compaction-control.test.ts \
  test/history-search-native-send.test.ts \
  test/session-observation.test.ts \
  test/claude-session-owner.test.ts \
  test/claude-auto-continue.test.ts \
  test/claude-bridge-auto-continue.test.ts \
  test/claude-managed-parity.test.ts \
  test/claude-retirement-usage.test.ts \
  test/claude-runner-status.test.ts \
  test/claude-resume-command.test.ts \
  test/claude-bridge.test.ts \
  test/claude-bridge-runtime.test.ts \
  test/claude-web-backend-integration.test.ts \
  test/claude-permission-mode.test.ts \
  test/claude-acp-live-state.test.ts \
  test/claude-config-writes.test.ts \
  test/claude-frame-drift-process.test.ts \
  electron/main/runtime-router.test.ts \
  electron/main/web/codex-resume-command.test.ts \
  electron/main/web/codex-actions.test.ts \
  electron/main/web/remote-capabilities.test.ts \
  electron/main/web/local-claude.test.ts \
  electron/main/web/claude-host.test.ts \
  electron/main/web/history-search-lan.test.ts \
  test/codex-live-state.test.ts \
  test/codex-shared-server.test.ts \
  test/managed-session-lock.test.ts \
  electron/main/web/service.test.ts \
  test/codex-compressed-rollouts.test.ts
pnpm --filter @agentkib/desktop exec vitest run src/core/session-history.test.ts test/codex-session-classification.test.ts test/session-classification-cache.test.ts test/history-search-source.test.ts test/history-search-worker.test.ts test/history-search-runtime.test.ts test/history-search-lifecycle.test.ts
pnpm test:web
git diff --check
git diff --cached --check
```

日志位于 `/tmp/agentkib-zst-merge-{build,auto,desktop,supplement,web,typecheck,lint,format,testlint,compressed-final}.log`；工具输出还记录了早期专项压缩测试与额外测试文件格式检查。
