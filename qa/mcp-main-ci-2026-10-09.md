# MCP 性能测试调度修复 QA

## 源码与失败证据

- 基准：合并 PR #111 后的 `origin/main @ 876ab76f7f146be2ebd1d1b60ab5f884b5552113`。
- 在已有隔离工作树创建 `codex/mcp-main-ci-fix`；开始时工作区干净，保留原分支和其他工作树。
- [主 CI run 37946186430](https://github.com/starroyhq/agentkib/actions/runs/37946186430) 只有 `mcp-native-import-snapshot.test.ts` 的 128 服务迁移预览用例失败：实际 `1510.467575 ms`，要求小于 `1500 ms`。同一提交的 Windows x64、Windows ARM64、Ubuntu ARM64 和 Fedora x64 检查通过。
- 此前通过 CI 的 PR 测试合并提交 `1e3d95d343cb94dcaacfd777f6f4876931e543e8` 与实际 main 提交的 Git tree 均为 `21f8d5503144c1fc06c4aa07180669ed0ad02526`。合并没有产生源码差异。
- 失败日志保存为本机 `<QA_LOG_DIR>/main-failed.log`，不以重跑替代修复。

## 分析与改动

原桌面 Vitest 配置允许这些墙钟性能用例与完整套件中的其他文件并行执行，结果包含其他测试的 CPU 竞争。独立子代理临时插桩测得同一预览为 `579.4 / 557.9 ms`，原生来源读取均为 9 次；应用为 `136.1 / 122.0 ms`，读取均为 5 次。预览主要耗时来自固定阶段的 JSON5 解析，未发现按 128 个服务重复解析整个原生文件。该结果与相同源码先通过、全套运行时略超阈值的证据一致，不将此现象归为新的生产行为回归。

只修改 `apps/desktop/vite.config.ts`：普通测试项目保留默认并发；两个原生快照测试文件归入后续的 `mcp-latency` 项目，以 `groupOrder` 等待普通组完成，再逐文件执行。保留所有原有 1000/1500 ms 阈值、读取次数、来源不变和写入行为断言，未修改测试正文或生产逻辑。

独立检查本机 Vitest 4.1.11 的收集与调度行为：原 209 文件分为 207＋2，集合相同、没有遗漏或重复；两个项目继承原 setupFiles；按文件过滤和全局 `--maxWorkers=1` 仍生效。单 worker 只作用于性能组，普通组不因本次改动整体串行。独立只读复核实际配置无新增发现。

## 本机验证

环境：macOS arm64、Node 22.23.3、pnpm 12.10.1；使用锁文件安装，没有依赖变更。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm build:web:hosted
pnpm test:backend:stability --maxWorkers=1 --testTimeout=15000
git diff --check
```

完整 `pnpm test` 通过：桌面 209 文件、3109 项通过、2 项既有跳过；Web 36 文件、683 项通过。后端 stability 在单 worker 参数下 31 文件、876 项通过、1 项既有跳过；format、lint、typecheck、桌面与 hosted Web 构建均通过，保留已有 lint warning。命令日志分别为本机 `<QA_LOG_DIR>/install.log`、`tests.log`、`format.log`、`lint.log`、`typecheck.log`、`build.log`、`hosted.log` 和 `stability.log`。

本轮仅调整测试调度，没有用户界面或生产行为变化；不需要模型调用或个人 Agent 配置验收。共享 runner 仍可能受到宿主外部负载影响，本修复隔离的是同一测试命令内部的竞争，不承诺任何负载下的绝对耗时。跨平台最终结果以修复 PR 的对应提交检查为准。
