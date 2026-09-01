# Runtime 后端对照实验

## 裁决

**当前不接受 `typescript-backend-spike` 替换 Rust Runtime。**

TS 分支已经是有实质实现的工程 spike：当前 Renderer 使用的 107 个 Runtime 方法都能在 TS registry 中找到处理器，TypeScript-only Electron 构建也能产出 main、preload 和 worker。但它同时未通过功能、恢复和跨平台硬门槛，且相对优化 Rust 没有达到预先约定的性能替换标准。

这不是“Rust 永远胜出”的结论。TS 分支在握手、会话事件解析和小型 SQLite 查询上有优势，值得保留为实现参考；但现在合并它会把一个已优化、可独立重启的 Runtime 换成仍需补齐兼容性和恢复能力的旧基线 Worker。

## 比较对象

| 方案 | commit / 状态 | 说明 |
| --- | --- | --- |
| `origin/main` 原始 Rust | `f77a080`，已采样 | 原始串行启动基线 |
| 优化 Rust | `codex/optimize-rust-runtime-startup`，已采样 | 窗口先创建，请求等待 readiness；握手先于 MCP Hub |
| TS Worker | `a48f449`，已采样 | `typescript-backend-spike`；相对当前 main 落后 19 个提交，版本仍为 0.5.0 |

TS 分支的迁移文档自身仍把“Parity and acceptance gates passed”和“Rust and Cargo removed”标为未完成，并注明 Windows/Linux 安装包 smoke test 尚未执行。

## 可复现实验

在待测分支完成 Release 构建后运行：

```bash
pnpm build
pnpm benchmark:runtime -- --backend rust --label rust-optimized --clean-runs 5 --reuse-runs 10
node apps/desktop/scripts/benchmark-runtime.mjs \
  --backend typescript \
  --desktop /path/to/typescript-backend-spike/apps/desktop \
  --label typescript-backend-spike \
  --clean-runs 5 \
  --reuse-runs 10
```

每次启动使用隔离的 Electron profile、Runtime 数据目录、Codex 目录和 Claude 目录，不读取真实用户数据。复用 profile 组在同组运行之间保留缓存；干净 profile 组每次重新创建目录。

启动时间线包含 Electron main、app ready、后端 spawn/handshake、BrowserWindow 创建/显示、Renderer 首次提交、`runtimeInfo` 和首页查询完成。核心负载使用确定性临时夹具：401 个工作区文件、5,000 行 Claude 会话、101 个 SQLite 工作区；会话事件读取统一限制为 500 条，以满足两组共同的公开参数约束。

## 性能结果

采样环境为同一台 Apple M2 Max、Release 构建。每组包含 5 次干净 profile 和 10 次复用 profile；内存在启动条件满足后额外等待 1 秒再采集。“首次可交互”以主窗口完成 Renderer 首次提交并实际显示为准。

### 启动与内存

| 指标 | 优化 Rust | TS Worker | TS 相对 Rust |
| --- | ---: | ---: | ---: |
| 干净 profile 首次可交互 p50 | 251.87 ms | 467.44 ms | 慢 85.6% |
| 干净 profile 首次可交互 p95 | 323.35 ms | 475.24 ms | 慢 47.0% |
| 复用 profile 首次可交互 p50 | 247.01 ms | 480.81 ms | 慢 94.7% |
| 复用 profile 首次可交互 p95 | 293.42 ms | 484.10 ms | 慢 65.0% |
| 干净 profile 合计 RSS p50 | 570,368 KiB | 604,688 KiB | 多 6.0% |
| 复用 profile 合计 RSS p50 | 567,536 KiB | 597,424 KiB | 多 5.3% |
| 后端握手 p50（干净） | 181.06 ms | 107.10 ms | 快 40.8% |
| 首页数据完成 p50（干净） | 430.62 ms | 363.03 ms | 快 15.7% |

TS Worker 的握手确实更快，但该分支仍执行 `await runtimeHost.start()` 和 `runtimeInfo` 后才创建窗口；因此后端优势没有转化为首屏优势。即便忽略窗口 `ready-to-show` 延迟，只比较 Renderer 首次提交，TS 的 320.52 ms 仍慢于优化 Rust 的 251.87 ms。

TS 分支比当前 main 落后 19 个提交，Renderer 和页面重量不完全相同，所以启动数值只作为方向性证据；但 TS 在较旧 UI 上仍明显更慢，结论不会因此反转。

### 确定性负载

| 指标 p50 | 优化 Rust | TS Worker | TS 相对 Rust |
| --- | ---: | ---: | ---: |
| 工作区扫描 | 0.14 ms | 1.55 ms | 慢约 10.1 倍 |
| 会话索引 | 1.50 ms | 2.23 ms | 慢 48.7% |
| 500 条会话事件解析 | 12.72 ms | 10.61 ms | 快 16.6% |
| SQLite 工作区列表 | 1.82 ms | 1.34 ms | 快 26.4% |
| SQLite 活动列表 | 0.62 ms | 0.22 ms | 快 64.5% |

TS 在文本解析和 Node `node:sqlite` 小查询上有优势；Rust 在文件扫描和会话索引上明显更快。按照“任一关键负载不得恶化超过 10%”的预设规则，TS 不能通过性能门槛。

工作负载中的 TS RSS 为独立 Node bridge + Worker 合计 159,056 KiB，Rust 子进程为 23,648 KiB。由于 TS 实际部署会复用 Electron main 的 Node 进程，这两个隔离后端数字不直接作为裁决依据；上表采用完整 Electron 进程树 RSS，TS 在该指标上多 5%–6%，仍在 10% 限制内。

原始结果：

- `qa/runtime-benchmark-rust-origin-main.json`
- `qa/runtime-benchmark-rust-optimized.json`
- `qa/runtime-benchmark-rust-optimized-parity.json`
- `qa/runtime-benchmark-typescript-backend-spike.json`

## 功能与工程门槛

| 门槛 | 优化 Rust | TS Worker | 结论 |
| --- | --- | --- | --- |
| 当前 Runtime 方法覆盖 | 107/107 | 107/107，另有 4 个旧/内部方法 | 通过静态覆盖 |
| 崩溃恢复 | 明确状态机、请求排队、有限重启、手动重试 | Worker `error` 后直接发出 `crash-loop` 并停止 | TS 未通过 |
| 当前 main 功能基线 | 当前 `f77a080` | 落后 19 个提交，缺少 0.6.0、诊断闭环、v8 UI/导航等 | TS 未通过 |
| 数据兼容 | 现有 Rust schema | 声称保持 schema 10，但 Rust↔TS 差分和回读门槛未签字 | 待验证 |
| 路径兼容 | canonical path 测试通过 | `/var` 与 `/private/var` 同一工作区无法匹配 Claude 会话 | TS 未通过 |
| TypeScript-only 构建 | 不适用 | main/preload/worker 构建通过 | 通过 |
| 默认测试去 Rust | 不适用 | desktop `test` 仍先执行 `runtime:build:dev` | TS 未完成 |
| Windows/Linux 安装运行 | 现有 CI 基线 | 分支文档明确尚待 release host smoke | TS 未通过 |

路径问题由相同基准夹具直接复现：存储层把 macOS `/var/...` canonicalize 为 `/private/var/...`，会话索引只用 `path.resolve` 比较来源路径，最终同一工作区返回零会话。修正夹具为 canonical path 后才能继续测纯性能，这一调整没有掩盖兼容缺口，缺口本身仍计为硬门槛失败。

构建还对 `@iarna/toml` 的 direct `eval` 发出两次安全/压缩警告。它不是已证实漏洞，但在替换前应更换解析路径或给出明确的打包安全评估。

## 架构差异

| 维度 | 优化 Rust | 当前 TS spike |
| --- | --- | --- |
| 进程模型 | Electron main + 独立 Rust Runtime | Electron main + Worker thread |
| 通讯 | stdin/stdout JSON-RPC | `MessageChannel` |
| 启动策略 | 主窗口与 Runtime 并行 | Worker handshake、`runtimeInfo` 后创建窗口 |
| 崩溃隔离 | 子进程可独立重启 | Worker 失败后主机停止，无重建路径 |
| 打包 | Rust 可执行文件 + Electron | 约 1.18 MB worker bundle + 新增 Node 生产依赖 |
| 服务器/容器方向 | Runtime 已是 headless 进程边界，可替换 transport | 当前 registry 只接 Worker transport，部署服务端仍需新建 transport/生命周期层 |

如果 AgentKib 后续真的转向云端 Agent 管理，独立 Runtime 边界不是包袱，反而更接近可部署 daemon。TS 也能做服务器，但当前 spike 的主要优势是 Electron 内部开发一致性，不是已完成的服务端复用能力。

## TS 再次参赛的最小条件

1. 基于当前 `main` 重放实现，不直接合并落后 19 个提交的分支。
2. 复用同样的非阻塞窗口启动顺序，而不是用串行启动抵消 Worker 优势。
3. 补齐 `starting/ready/restarting/failed/stopping` 状态机、有限重启、请求等待和手动重试。
4. 修复 canonical path 会话匹配，并加入 `/var`、symlink、大小写和网络盘夹具。
5. 完成 Rust↔TS 数据库回读、方法输出、错误语义和高价值 fixture 差分测试。
6. 让默认测试、CI 和安装包真正不依赖 Cargo，并完成 Windows/Linux release-host smoke。
7. 处理 TOML direct `eval` 构建警告后，用同一基准重新采样。

在这些条件完成前，建议保留 Rust Runtime，把 TS 分支中更快的会话解析和 SQLite 查询实现作为定向优化线索，而不是整体替换后端。
