# Claude 审查四项修复与回归 — 2026-10-15

## 源码与验证范围

- 审查基线：`origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`。
- 本地 HEAD：`bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`，开始时已有 39 个跟踪文件修改，以及此前的未跟踪测试、QA、`.agents/` 和 `prototypes/`；均保留。
- 本轮修改 16 个源码、测试及说明文件，另新增本 QA。未新增依赖、公共协议或业务数据库结构；未提交、推送或部署。
- Node `22.23.3`、pnpm `12.10.1`，macOS arm64。未调用真实模型或读取个人 Agent 配置，未替换已安装应用。
- 全量检查期间共享目录出现并发的 Skills 改动。最终验证使用审查前源码快照叠加本轮 16 个文件的固定副本，通过 `pnpm install --frozen-lockfile --offline` 安装锁定依赖（865 个包复用，零下载），没有回滚或覆盖主目录。验证后逐个 SHA256 核对，本轮文件与主目录一致。结果不代表并发 Skills 改动已验收。

## 修复与测试

1. **通用 PKCS#8 私钥脱敏。** 共享脱敏器识别没有 RSA 等前缀的 `BEGIN PRIVATE KEY`，保留其他私钥格式和未闭合块保护。新增测试覆盖 LF/CRLF、公钥保留、连续私钥、截断块，以及实际 Context 的外部导入、用户指令、自动记忆。使用临时生成的 Ed25519 私钥验证，但断言仅输出是否包含秘密的布尔值；MCP 和 Doctor 对照不返回外部正文。修复前 10 项中 6 项失败，修复后全部通过。
2. **压缩摘要版本与分支。** 段内选中的摘要优先；回退限定在所选边界实例之后、下一关联压缩之前，按 UUID 最新版本选择并过滤 sidechain。拒绝无效 UUID、旧边界摘要和未来重写；新版本不再是摘要或已改父节点时，不复活旧摘要。新增 18 项真实文档读取回归，覆盖默认及完整历史交接、多次压缩与关联边界。二分定位和互不重叠的窗口避免反复扫描全文件，原历史遍历预算不变。
3. **MCP 导入诊断路径隔离。** 外部导入及其失败诊断只汇总数量、可取得的大小及跳过状态，不新增解析后的 HOME 或外部路径。工作区原文保持原样，owner 仍能查看完整诊断。覆盖缺失、敏感、拒读、realpath 失败、网络、循环、深度和数量上限；外部 alias 指回工作区时，截断警告也不会带出 alias 的外部路径。Doctor 的导入探测在越界 IO 前停止，并保持内部绝对链接、链接到工作区根和 Windows 路径行为。
4. **组织策略覆盖状态。** 保留 64 个 managed drop-in 的读取上限，超限、目录拒读及已发现文件读取失败/消失均标为不完整。MCP 保留候选与原 `supported`，但不给出确定的加载、覆盖或插件替代结论。完整 Context 和 MCP metadata 都显示不可确定状态；仅有一个失败文件时也不会隐藏提示，纯缺省文件保持静默。测试覆盖第 64/65 份 deny/allowlist、目录及文件失败、插件替代与无路径/值披露。这是原生状态诊断修复，不改变 Hub 执行授权。

独立复核发现了“唯一失败文件使 `anyFile=false`、诊断消失”的相邻遗漏；新增两条真实 Context 展示测试及两条读取器断言，先复现 4 项失败后修复。网络路径原有测试同步检查新增的不完整诊断，并保留“不读取网络目标”及 AGENTS.md 回退断言。未新增跳过或降低安全断言。

## 最终验证

以下命令在固定副本中执行，退出码均为 0。主目录第一轮检查发生在并发改动和测试完善期间，不作为最终通过证据。

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check` | 818 个文件通过 |
| `pnpm lint` | 通过，无错误；保留任务外既有 React 等警告 |
| `pnpm typecheck` | Backend、桌面、Web 通过 |
| `pnpm test` | 桌面 261 文件、4964 项通过、2 项既有跳过；Web 37 文件、765 项通过 |
| `pnpm build` | 桌面 Renderer、Electron 主进程、Preload、Backend 和随附 Web 构建通过 |
| `pnpm build:web:hosted` | 通过 |
| `env -u ELECTRON_RUN_AS_NODE <已有 Electron 44 可执行文件> apps/desktop/scripts/verify-backend-workers.cjs` | Electron 44.0.0 / Node 24.18.1 下内容索引/查询、Skills、交接读取 Worker 均通过 |
| `git diff --check`（主目录） | 通过 |
| 本轮文件 SHA256 对照 | 主目录与固定验证副本一致 |

构建复用了本机已有的锁定 frpc 归档，由项目 staging 脚本重新验证 SHA256。Worker 验证直接使用本机已有、与锁文件一致的 Electron 二进制，加载固定副本的脚本和构建结果，使用隔离数据；没有启动个人应用数据或钥匙串流程。

## 独立复核

- **私钥与摘要：** 无剩余 findings。独立运行 108 项测试；另有 400 组摘要参考结果比较通过，53,002 条合成记录/1,000 次压缩读取约 97 ms（本机单次结果，不是性能承诺）。
- **MCP 路径与 Doctor：** 无 findings。独立运行 99 项测试及 10 项 Linux/Windows 虚拟 IO 探针，覆盖内部 root alias、越界再回入、大小写和混合分隔符。
- **策略覆盖：** 首轮指出唯一失败文件诊断遗漏；补修后复核无剩余 findings，独立探针确认完整视图及 MCP metadata 可见且不披露路径或值。

以上复核仅针对本轮修复增量，不是对 `origin/main` 之后全部功能的再次全量审查。Windows/Linux 的路径检查使用自动化和虚拟 IO，未替代实机验收；没有真实模型、手机或发布验收。

## 本机证据

临时目录可能被系统清理，本文是结果摘要，不替代原始日志。

- 系统临时目录 `agentkib-review-round-20261015-jfw6ek3p/`：修复前完整源码快照、Git 身份、差异及文件哈希。
- `/tmp/agentkib-review-four-fixes-20261015/identity.json`：固定源码身份、本轮 16 个文件哈希及验证副本位置。
- 同目录 `source/`：固定验证源码和本机构建产物；`build-artifacts.json` 保存构建文件 SHA256。
- 构建哈希清单 SHA256：`836a7551c44b8d9d617498267ae53d0967dc5dba7a9826ef52acb56912e19115`；`fixes.patch` 为本轮增量，便于与并发工作区修改区分。
- `isolated-{format,lint,typecheck,test,build,hosted,worker}.log`：最终完整验证日志；`install.log`：离线安装结果。
- `coverage-before.log`、`coverage-after.log`：唯一失败策略文件的红灯及补修后 163 项定向回归。
- `/tmp/agentkib-redaction-summary-probe.NrAOo9/`、`/tmp/agentkib-managed-settings-review/`：独立复核探针。
