# 离线验收不稳定项复核 — 2026-10-01

继续使用 `main-acceptance-20260930/agentkib`，HEAD `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，保留前轮 dirty 改动。本次只调整测试及仅在 `cfg(test)` 下编译的观察点，未改发布构建的期限、能力门限或生产重试行为。

## Antigravity 截止时间测试

上一轮默认并行测试失败于 `replay_shares_one_deadline_across_session_list_and_load`：总期限1500ms、模拟list固定sleep 1s，剩余500ms还需容纳两次进程启动及协议交互；load尚未到达便超时。串行当时通过，但不能由此声称并行稳定。

现在拆开验证两个责任：

- 原跨阶段测试用真实shell ACP立即完成list和load，线程局部观察器精确断言 `connect → list → connect → replay` 的入口截止时间都等于调用方同一个 `Instant`，并核对会话及工作区。观察器只有本测试启用，RAII在失败时也会清理，其他线程不会混入记录；发布构建不包含它。
- 新增 `replay_wait_honors_deadline_after_load_has_started`。真实ACP发送 `load-ready` 事件后保持连接且不回答load，测试收到该事件后才开始100ms等待期限，并要求实际collector报超时且耗时小于2s。计时不包含进程启动、握手或shutdown，没有固定sleep；仍保留实际超时断言。

已有过期调用者拒绝及 bridge 的无响应等待/过期命令拒绝测试均保留。新的组合覆盖跨阶段传递和load实际执行期限；不把结构观察单独称为端到端墙钟测试，也不宣称操作系统任意长时间挂起时测试绝不会失败。

## 预览指纹失败

独立调查未复现上一轮 `Target import settings changed after preview`，未找到确定的fixture文件创建竞态或指纹随机性。发现诊断缺口：安装能力探测失败可正常返回 `handoff-file` 预览，原测试只检查RPC无error，随后硬编码原生计划，导致初始 `native_capability.reason` 被后续错误掩盖。

`Fixture::prepare` 现在要求预览mode为native-session、native_capability.supported为true、target_fingerprint非空，否则打印完整draft并立即失败。没有重试、增加探测期限或放宽指纹比较。**这改善诊断，不等于已修复或确定了历史探测失败根因。** 旧失败日志保持不变。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `cargo test --offline -p agentkib-conversations --lib`（最终默认并行） | 180通过，0失败，8 ignored |
| `cargo test --offline -p agentkib-runtime --test native_import -- --test-threads=1` | 7通过，0失败 |
| `cargo test --offline -p agentkib-antigravity-bridge scoped_deadline_caps_an_unresponsive_acp_wait` | 1通过，0失败 |
| `cargo clippy --offline -p agentkib-conversations -p agentkib-runtime --all-targets -- -D warnings` | 通过 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |

最初一次以短函数名搭配 `--exact` 的调用匹配0项，未计作验证；随后使用完整lib测试执行上述用例。追加load等待测试之前的并行运行是179通过，最终180通过的日志另存，未覆盖早期结果。

追加测试首次Clippy指出 `.err().expect()` 写法，已改为 `let Err(error) = ... else { panic!() }`，未添加lint豁免；最终Clippy及该load用例再次验证。180项运行发生在该等价断言写法调整前，最后单项日志为 `load-deadline-final.log`。

跨日任务继续保留同一私有档案根：`~/Documents/AgentKib-archives/2026-09-30/full-interop/offline-stability-1/`。最终证据为 `conversations-final.log`、`runtime-gates.log`、`bridge-deadline.log`、`clippy-final.log`；源码及日志SHA另见 `completion.json`。

独立子代理分别审查截止时间测试和预览诊断改动，均未发现确定问题。未运行真实Agent模型、登录或供应商请求；未修改用户安装/凭据，未提交、推送、部署或发布。这不增加原生互通方向计数，真实回复失败与未验收边界不变。
