# 工具与附件降级的离线官方导入补验

用户选择保留真实回复失败、继续离线验收后追加。源码起点为 `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，在既有 dirty 验收工作树继续；本次只修改测试和 QA，不增加生产逻辑或依赖。

## 实际覆盖

新增 `native_targets::installed_cli_tests::official_{opencode,hermes}_rich_import_*`，复用已有官方导入测试。合成 Grok 原生记录经过生产 parser 与脱敏，包含中文、多行正文、一个工具调用和结果、一项图片引用、推理及合成 secret。测试验证：

- 来源 call/result 关联与脱敏存在；目标保留全部预览正文、历史工具摘要及附件省略说明。
- 来源推理排除损失为 1，目标工具摘要损失为 2，附件省略损失为 1。
- 工具参数、原始输出、图片 base64、推理及未脱敏 secret 不出现在目标载荷中。
- OpenCode `1.18.32` 执行官方 import，两个新 export 进程逐条核对完整预览；所有原生 part 都是 text。
- Hermes `0.21.5` / `2026.9.24` 执行官方 CLI import，退出后重新打开官方 SessionDB，逐条比较角色和全文，包括相邻助手/工具摘要合并的结果；数据库只有一个会话，tool_calls、tool_call_id、tool_name 均为空，origin 指向本次导入。
- 导入后的准备文件与原始载荷字节相同。

仅使用此前固定版本的独立测试安装。每个用例有新 HOME/状态目录，子进程 `env_clear`；Hermes 仅在临时配置关闭更新检查。整个测试程序通过 macOS `sandbox-exec` 禁止全部网络，没有模型调用、登录、用户凭据或 TUI 操作。

这些用例证明**合成富历史的生产解析/目标投影与官方导入回读**，不等于新增两条完整公开 Runtime 方向，也不证明模型不会在未来主动选择类似工具。它们验证导入历史不含可重放工具记录，不宣称所有来源、错误工具输出、长历史或附件本体得到原生保留。

## 命令与结果

```text
cargo test -p agentkib-conversations --lib --no-run
# 使用上述构建返回的测试二进制；环境变量指向隔离固定安装：
sandbox-exec -p '(version 1)(allow default)(deny network*)' <test-binary> native_targets::installed_cli_tests:: --ignored --nocapture --test-threads=1
cargo test -p agentkib-conversations --lib
cargo test -p agentkib-conversations --lib -- --test-threads=1
cargo clippy -p agentkib-conversations --all-targets -- -D warnings
```

- 官方固定 CLI 的两个新增富历史用例及两个原有纯文本对照：4 通过，0 失败。
- 默认并行 conversations：178 通过、1 失败、8 ignored。既有 `antigravity::tests::replay_shares_one_deadline_across_session_list_and_load` 在进入 load 前超时；测试给 1500ms 总期限且 list 模拟固定等待 1s。未修改该测试、生产超时或断言，不能把并行命令记为通过。
- 按此前整体验收相同的串行方式复核：179 通过、0 失败、8 ignored。不能据此保证默认并行稳定；本次新增官方测试默认 ignored，并未在失败的普通测试运行中启动 CLI。
- Conversations Clippy：通过。

原始命令、隔离环境、测试可执行文件 SHA256、固定版本与源码 SHA256、完整输出及退出码位于私有档案 `full-interop/rich-offline-import-1/`。该补验不覆盖前一轮全 workspace 和前端结果；之前的结果保持原有源码/命令边界。没有自动重发真实模型请求。

## 公开 RPC 边界补测

独立子代理在 `crates/agentkib-runtime/tests/native_import.rs` 新增三个测试，仅运行本地 Runtime 和模拟 OpenCode 命令：

1. 预览明确产生工具摘要及附件省略两项损失；`acceptLosses:false` 精确拒绝，确认后同一来源才可生成计划。未执行导入，来源字节保持不变。
2. 18条合成历史超过64k估算预算，预览存在实际延后轮次、归档及 `windowed` 策略；计划在 `windowed_context:unsupported` 的公共门限拒绝，没有目标导入。该路径会先报需要连接 MCP，不宣称覆盖了后面的 `Full` 防御分支，也不宣称此目标可检索完整长历史。测试通过正式握手在独立回环端口初始化 Hub，无外部请求。
3. 对同一预览明确创建两份新计划，operation UUID、目标 ID、路径和计划 hash 不同，冻结文档及目标投影相同；仅创建计划，不冒充两个原生会话已经落盘。重复执行同一操作的回执复用由现有测试另行覆盖。

命令 `cargo test --offline -p agentkib-runtime --test native_import -- --test-threads=1` 最后运行7项通过、0失败。首轮因新fixture未初始化MCP而失败，修正fixture后保留 `runtime-gates-first-failed.log`；第二轮既有来源漂移用例在执行预定变更前报 `Target import settings changed after preview`，未改代码复核通过，原因未确证，保留 `runtime-gates-second-failed.log`。最终日志为 `runtime-gates.log`。没有放松断言或更改生产能力门限。
