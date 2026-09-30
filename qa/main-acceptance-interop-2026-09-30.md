# 合并后主线互通验收 — 2026-09-30

## 结论与源码身份

本轮 Claude 合成来源 → OpenCode、Hermes、OpenClaw 三条代表方向均通过公开 Runtime 的来源发现、预览、确认、原生导入、重复请求及 Runtime 重启回执恢复。独立原生回读逐条符合预览投影，来源哈希不变，每个操作只创建一个目标会话。OpenCode、OpenClaw 的原生 TUI 实际显示导入历史中的随机标记；Hermes 在未配置 provider 时停留于 setup 提示，历史展示未验收。

**没有发送真实模型请求，没有新增方向被标记为完整原生互通通过。** 本轮结果不能外推其余来源 × 目标，也不能用 Terminal 启动回执代替原生界面可见性。

- 源码：`ce16c00`，工作树 `main-acceptance-20260930/agentkib`；本轮新增 QA/probe，未改变生产源码或依赖。
- 实际 debug Runtime SHA256：`18f225c179dfc891553a182fd1e922b363ff0a5b4414d809738106236489de16`。每个 case 在启动前读取并记录二进制哈希。
- 平台：macOS arm64。固定 OpenCode `1.18.32`、Hermes `0.21.5`（官方 release `v2026.9.24`）、OpenClaw `2026.9.6`（`eb377ac`）。
- 工具、合成状态与日志：`~/Documents/AgentKib-archives/2026-09-30/native-interop/`，目录权限 `0700`。隔离 HOME/XDG/HERMES_HOME/OPENCLAW_STATE_DIR；Runtime 子进程使用明确环境，不继承用户 provider 密钥；未修改用户 Agent 安装或全局配置。

## 本次实际结果

| 方向 | 公开 Runtime 导入与恢复 | 独立原生回读 | 原生界面 | 真实回复 |
| --- | --- | --- | --- | --- |
| Claude → OpenCode | `opencode-rpc-v2`；同一 operation/target ID，三次 continue 均 launched | 两次新 export 进程；全文角色/顺序相等；只存在 1 个会话 | PTY 中 marker 可见；没有输入提示 | 未验收：固定 CLI 的会话重试无法可靠关闭 |
| Claude → Hermes | `hermes-rpc`；同一 operation/target ID，三次 continue 均 launched | 官方导入后的 SQLite 独立只读；全部角色/正文相等；1 个会话 | 未配置 provider，提示运行 setup，未展示历史 | 未验收：未取得允许用于该客户端的免费授权 |
| Claude → OpenClaw | `openclaw-rpc-v2`；同一 operation/target ID，三次 continue 均 launched | 官方独立 readonly 模块回读全部 events，与预览 payload 逐对象相等；初始 5 个 fixture + 1 个目标，目标匹配 1 条 | 首次观察被本轮先前打开的 TUI 锁拒绝；停止该自有进程后重开，marker 可见 | 未验收：未取得允许用于该客户端的免费授权 |

每个合成来源含独立随机 marker 和项目决定 `append-only SQLite WAL with namespace cobalt-lake`。实际预览与 `plan.json`、完整 RPC 请求/响应、独立回读、TUI ANSI 输出、前后来源 SHA256 位于对应 case 目录。接收方包含可见的“不可信历史/不可重放工具”说明，正文比较以冻结投影为准。本轮合成来源为两条纯文本，未引入历史工具或附件；工具摘要化、附件省略及长历史边界由既有回归覆盖，不将本轮纯文本实验算作这些场景的新增实际验收。

操作记录与导入对象均保留；没有通过删除后重导入获得通过。重启指真正停止并启动 Runtime；OpenCode export 与 TUI、OpenClaw TUI、Hermes独立数据库读取分别是新进程，不是沿用内存结果。

## 已执行命令与失败保留

安装全部位于上述私有目录的 `tools/`：

```text
npm install --prefix <tools>/opencode --no-audit --no-fund opencode-ai@1.18.32
git clone --depth 1 --branch v2026.9.24 https://github.com/NousResearch/hermes-agent.git <tools>/hermes-src
uv venv <tools>/hermes-env
uv pip install --python <tools>/hermes-env/bin/python PyYAML python-dotenv rich httpx requests pydantic psutil packaging prompt-toolkit openai==2.24.0
npm install --prefix <tools>/openclaw --omit=dev --no-audit --no-fund openclaw@2026.9.6
```

OpenClaw 在 Node `22.23.2` 下安装被官方 engines/preinstall 拒绝，日志 `openclaw-install.log` 保留。改用机器已有 `/opt/homebrew/bin/node v26.9.0` 后安装成功（`openclaw-install-node26.log`），没有替换项目 Node 22。Hermes 使用隔离 Python `3.13.12`，入口等价于官方 `python -m hermes_cli.main`，未全局安装。

已执行的原生回归：

```text
AGENTKIB_TEST_OPENCODE=<tools>/opencode/node_modules/.bin/opencode AGENTKIB_TEST_HERMES_SOURCE=<tools>/hermes-src AGENTKIB_TEST_PYTHON=<tools>/hermes-env/bin/python cargo test -p agentkib-conversations official_ -- --ignored --nocapture
AGENTKIB_TEST_OPENCLAW_PACKAGE=<tools>/openclaw/node_modules/openclaw AGENTKIB_BENCHMARK_DATA_DIR=<root>/official-openclaw-data OPENCLAW_STATE_DIR=<root>/official-openclaw-state OPENCLAW_CONFIG_PATH=<root>/official-openclaw-state/openclaw.json cargo test -p agentkib-runtime --bin agentkib-runtime official_openclaw_import_reopen_and_conflicts -- --ignored --nocapture
node qa/probes/openclaw-sqlite-fixtures.mjs <tools>/openclaw/node_modules/openclaw <root>/source-fixtures
AGENTKIB_TEST_OPENCLAW_STATE=<root>/source-fixtures AGENTKIB_TEST_OPENCLAW_FIXTURES=<root>/source-fixtures AGENTKIB_TEST_OPENCLAW_EXPECTED=<root>/source-fixtures/ordinary-expected.json cargo test -p agentkib-conversations openclaw::sqlite::tests::reads_official -- --ignored --nocapture
```

首个 `official_` 过滤过宽：OpenCode/Hermes 两项通过，另两项 OpenClaw 来源测试因未设置 fixture 变量失败，不能称该命令整体通过。随后一个误写为 `native_targets::tests::official_` 的过滤命令选择 **0** 个测试，不算证据。最后正确提供官方 fixture 运行 OpenClaw 两项通过；生产 OpenClaw import/reopen/conflicts 单项通过。有效原生回归总计 **5 项通过**，原失败日志均保留。

公开链路与后续独立校验：

```text
python3 qa/probes/main-interop-rpc.py target/debug/agentkib-runtime <tools> <new-case> opencode
python3 qa/probes/main-interop-rpc.py target/debug/agentkib-runtime <tools> <new-case> hermes
python3 qa/probes/main-interop-rpc.py target/debug/agentkib-runtime <tools> <new-case> openclaw
python3 qa/probes/interop_native_readback.py
python3 qa/probes/interop_native_readback.py <root>/opencode-rpc-v2
python3 qa/probes/interop_native_readback.py <root>/hermes-rpc
python3 qa/probes/interop_native_readback.py <root>/openclaw-rpc-v2
```

准备阶段脚本曾使用不支持的 16000 token 预算，以及 `openclaw` 而非 wire enum `open-claw`；生产校验均正确拒绝，尚未导入或调用模型。脚本已修正，旧目录和日志保留。

独立审查指出初版脚本仅检查 JSON-RPC 无 error，不足以排除正常 result 中的 `import-outcome-unknown`。现明确验证三个业务状态、操作及目标身份；新 helper 独立比较原生记录并绑定 plan 哈希。三个现有成功 case 均在断言补齐后重新**只读校验**通过，没有重做导入。负例自检确认 `import-outcome-unknown`、目标 ID 漂移、正文改变全部导致失败。OpenClaw readonly API 返回 `{found,value}`，初版观察器遗漏 `.value` 报错，修正后再次只读验证通过；没有修改数据库或放宽正文比较。

## 免费模型与能力门限

[OpenCode Zen 官方定价](https://opencode.ai/docs/zen/) 当日仍列 `big-pickle` 为免费。本轮使用原生 `opencode/big-pickle` 配置，没有转发器或伪造客户端标识。但固定 `v1.18.32` [LLM 层](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/llm.ts) 的 SDK retries 默认为 0，外层 [processor](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/processor.ts) 仍无条件使用 [SessionRetry.policy](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/retry.ts)，最多重试 5 次；未找到经过验证的关闭开关。监听 retry 事件后杀进程不能作为严格一次派发保证。因此本轮没有发出提示，不将此描述为模型失败、服务不可用或免费资格被拒绝。源码核查快照保存在日志根目录。

[Hermes Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal) 要求正常登录接入；本轮隔离环境没有该授权，未创建账户或迁移凭据。[OpenClaw 官方模型文档](https://docs.openclaw.ai/cli/models) 明确 OpenRouter `:free` 推理仍需要 key；公开目录可读不等于获得推理授权。本轮没有使用旧受限 OpenCode Zen 外部客户端转发方案，也没有使用 moka、DeepSeek 或用户其他付费凭据。

## 可复现性与清理

main 原先引用但未包含 `qa/probes/openclaw-sqlite-fixtures.mjs`，使 ignored 官方验收不可重跑。本轮从旧树原样恢复这份合成 fixture，经独立审查后实际运行通过；它只写全新的指定目录并检查固定版本，不包含凭据。其余旧 `/tmp` 安装和部分日志已丢失，本轮重新安装、重新运行，未把历史 QA 摘要充当本次原始日志。

三个 Runtime 均正常 shutdown；所有本轮自有原生 CLI/TUI 已退出。PTY 子进程按确切 PID/进程组停止；先前 Terminal 打开的 OpenClaw PID `38478` 在核对 cwd 为本轮隔离 workspace 后停止。清理后进程列表未发现本轮 CLI/TUI。Terminal launcher 的空 shell 窗口可能仍保留，未广泛关闭 Terminal 或用户窗口。`cleanup.json` 与 `evidence-sha256.json` 保存本地清理记录及原始证据文件校验值。

未验收：三目标真实模型回复、Hermes 本轮历史界面、全部来源方向、Windows/Linux 实机。真实手机及账号生产上线由主 QA 单列。
