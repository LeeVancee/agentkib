# Codex follower 增量同步验收（2026-09-26）

本轮只改客户端本地桥接与 runtime 的 live 读取；没有部署、发布、替换现有安装版或改动用户数据。

| 场景 | 结果 |
| --- | --- |
| 首次选择会话取得完整快照，之后消费连续 revision patches | 桥接模拟 owner 测试通过；三条连续 patch 在一次 live 观察中应用 |
| 普通 live 轮询不重复请求完整快照 | 桥接模拟 owner 测试通过；只有首次选择与强制 60 秒校验各请求一次完整快照 |
| 补丁大小限制 | 子树差量与完整 JSON 大小一致性测试通过；仍保持 48 MiB 快照上限 |
| owner 变化、revision 缺口 | 桥接模拟 owner 测试通过；失效缓存并拒绝继续报告旧状态 |
| 写入前完整刷新与防重复执行 | 现有桥接写入专项测试及 runtime 测试通过；未改变写入前预检与账本行为 |
| 真实长会话 | 本机已打开的官方 Codex 会话选择成功、实验控制可开启；连续两次 `observe_live` 成功，第二次约 12 ms |
| 安装包 | macOS arm64 临时 `.app` 构建、签名验证及隔离数据目录启动冒烟通过；内置 frpc、CSR、Web 资源通过检查。未公证、未安装 |

验证命令：`cargo test -p agentkib-codex-bridge -p agentkib-runtime`（桥接 52 项、runtime 143 项单元测试和 1 项集成测试通过）、`cargo build --release -p agentkib-runtime`、`node apps/desktop/scripts/smoke-remote-package.mjs ...`、`codesign --verify --deep --strict`。最终临时包与冒烟 JSON 位于 `/tmp/agentkib-incremental-final-20260926/`。

仍待真实手机页面回归：持续生成时的视觉延迟、iPhone Safari 与 Android Chrome 的断网重连、审批及问答、页面刷新后的命令回执。没有用本机 IPC 测试替代这些验收。
