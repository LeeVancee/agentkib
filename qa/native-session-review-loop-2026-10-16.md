# 原会话连接审查与修复 — 2026-10-16

## 源码与审查范围

- 固定基线及工作树 HEAD：`74912da90fe2edea090efe1d673cea9f2a439663`，分支 `codex/native-session-connection`。本次审核包括全部未提交改动与未跟踪文件；三点比较及提交列表为空，实际读取 `git diff 74912da90fe2edea090efe1d673cea9f2a439663 -- .` 和未跟踪文件。
- 使用 `code-review` 技能，两位独立子代理分别审查 Standards、Spec。项目没有 issue tracker，以对话中的原会话连接计划为规格。首轮冻结完整文件哈希，修复后再次冻结并使用新的代理复审。
- Node `22.23.3`、pnpm `12.10.1`；未新增依赖、数据库表、真实模型调用或个人配置变更。主目录已有工作不变；没有提交、推送或发布。

## 首轮发现与修复

| 轴 / 来源 | 确认问题 | 修复与回归 |
| --- | --- | --- |
| Standards | QA 和原生测试包含个人绝对路径 | 公开文档改用 `$HOME` / `$WORKTREE`，测试通过当前用户 Home 或显式可执行文件参数定位 |
| Spec | 缓冲溢出静默丢事件，接收方未见缺口 | 新增显式 gap 事件，暂停控制，保留终止证据；快照 ACK 与溢出代际一致后才恢复，旧 ACK 不能清除新缺口 |
| Spec | 执行中重载缺少 start，误报空闲 | 独立跟踪原生工作状态，轮次未核实保持 running、禁用取消；只有真实主轮 step 恢复其 ID，迟到 completion 不清除新轮 |
| Spec | 审批通过后仍显示等待整个工具执行 | 按工具归属保存审批和问题状态；未核实审批不伪称批准或继续等待，匹配的原生执行证据才能解除该工具的未知状态 |
| 补充故障检查 | 证据保存失败会跳过原生 fixture 资源清理 | finally 独立释放终端、桥接、HTTP 及隔离目录；实际 EEXIST 和关闭失败组合回归保留原错误及旧证据 |
| 修复过程中的真实组件测试 | running 状态隐藏了新安全提示 | 桌面和 Web 展示轮次未核实、审批未核实、事件缺口原因；四语言验证，不改变控制权限 |
| 第二轮 Spec | 达到流预览上限后，每片段重复扫描前缀、逐字符创建编码器 | 增量 UTF-8 字节计数、超限后固定预览、未连接时跳过桥接正文处理；真实 hook 的工作量上界、Unicode、跨片段 surrogate 与全部原值透传回归 |
| 第三轮 Standards | Codex 原生探测的报告和命令记录保存个人绝对路径 | 新诊断的报告、命令、RPC/HTTP、终端和错误输出统一副本脱敏，保留哈希和语义；实际执行数据及已有原始证据不变。覆盖转义 JSON、Windows/UNC/文件 URI、fragment/ANSI 边界；Codex 专项 15/15 |
| 第四轮 Standards | Claude 原生 fixture 保存的 CLI 日志仍有真实安装路径 | Claude 与 Codex 共用脱敏；实际落盘回归覆盖路径、ticket/secret、异常和拒绝覆盖。元数据 SHA 与 raw-types 的 BOM/CRLF/字节保持原样；保留主验收、保存和清理的全部失败原因。专项 26 通过、1 原生 opt-in 跳过 |

插件 hook 与真实 Unix socket broker 的集成测试实际产生 300 个流片段，验证 gap、全部 HTTP 200、最终快照文本恢复及控制门限；没有将协议两端分别 mock 成一致。

## 当前自动化与构建

当前已执行：

- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`：通过；保留既有 React Compiler / hooks、路由循环依赖等 warning。
- 桥接、Runtime、插件、fixture 清理、Codex 探测、owner IPC、真实 Panel 和 EmbeddedConversation 专项 **119/119**；Web 原会话专项 **39/39**。
- `pnpm test:web`：**37 文件、774/774**。
- 桌面 `vitest run --maxWorkers=4`：**5551 通过、2 超时、3 跳过**。两项均来自未修改的 `skill-sync-boundaries.test.ts` 的 policy / ownership 文件系统用例，触发现有 5000 ms 期限。保留 `/tmp/agentkib-native-loop-desktop-all.log`；该文件独立重跑 **11/11** 通过，未改测试代码或期限。本轮未将原全量失败改记为通过。
- `pnpm build`、`pnpm build:web:hosted`、Node 原生依赖 smoke、Electron utilityProcess Worker smoke：通过。
- 第二轮 staged 插件 SHA256 `3c49d177ff04c28ea51d48cc73fe4f14239499d4aa06846b31a01ae8a0de5931` 是性能修复前的历史冻结身份。

性能修复补充：插件专项 **38/38**。第二轮真实 hook 合成复现为累计 96 KiB 后 64 个四字符片段耗时 2112 ms；主代理用冻结旧模块独立复现 2116 ms，最终源码相同输入不足 1 ms，65 个原始片段及最终返回对象保持一致。耗时只作辅助证据，回归断言实际 UTF-8 工作量，未以放宽计时阈值获得通过。纯 JS 有界计数不依赖固定 Mods 未声明的 `TextEncoder.encodeInto`。

最终性能修复后的验证：

- format、lint、typecheck 全部通过；桌面专项 **123 通过、1 个 opt-in 原生用例跳过**；Web 全量再次 **774/774**。
- 桌面全量 `vitest run --maxWorkers=2`：**5556 通过、1 超时、3 跳过**。此次超时为未修改的 `skill-sync-recovery-regressions.test.ts` 中 `detaches invalid-frontmatter while retaining every native byte`，仍是原有 5000 ms 期限；独立运行该文件 **15/15** 通过。该测试、两个失败批次涉及的 Skills 实现均与基线无 diff。保留 `/tmp/agentkib-native-loop-final-desktop-all.log` 与独立日志，不宣称全量已通过。
- 两端构建、Node 原生依赖 smoke 与 Electron utilityProcess Worker smoke 再次通过。当前 staged `agentkib-bridge 0.1.0` 与源码逐文件一致，重算 SHA256 为 `35d6d1d6d5896d2f2bfa0013085cc982a400e59b7dd2251aef3abf35229701ad`，生产发送开关仍关闭。
- 随后的 Codex 诊断修复只改验收脚本及其测试；另跑 **15/15**。没有为诊断变更重跑原生 CLI 或模型，也没有把其新增用例计入此前全量统计。
- 随后的共用诊断及 Claude 证据保存修复：Codex **16/16**、实际落盘 **5/5**、资源清理及多失败聚合 **5/5**，原生 opt-in **1 跳过**。共用模块同时处理安装目录及异常 code/cause；Codex runner 会将该模块源码一并复制到证据目录，由现有 SHA 清单记录。没有重跑原生 CLI，旧证据及实际执行参数、原生数据库/配置未改。
- 最终完整相关专项：**9 文件通过、1 文件跳过，136 通过、1 个原生 opt-in 跳过**。根代理重跑 format、lint、typecheck 全部通过；新增诊断模块和验收文件另行显式执行 8 文件 oxfmt / oxlint、两个 MJS 语法检查，全部通过。该次新增用例同样未混计入先前的全量统计。

命令日志 `/tmp/agentkib-native-loop-final-{format,lint,typecheck,focused,build,build-hosted,node-smoke,electron-smoke,desktop-all,web-all}.log`；后续诊断专项日志为 `/tmp/agentkib-native-loop-r4-*.log`，最终专项、静态检查及诊断显式检查为 `/tmp/agentkib-native-loop-r5-*.log`。冻结文件与构建身份存于 `$HOME/.codex/tmp/native-session-review-loop-20261016/round-3-{manifest,build-identity}.json`；最终完整源码审查冻结为同目录 `round-5-manifest.json`，QA 追加完成结果后的最终清单为 `final-manifest.json`。这些证据仅用于所记录的源码批次，不是正式安装包或实机手机验收。

## 原生实验与限制

- 固定 Claude CLI `2.1.301`，SHA256 `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`；实际类型声明主文件 SHA256 `7af2348e2aa84883bed70e532ebffbf066496101877e3ebd8ad49d7ff220a754`。
- 本轮官方插件 validate 通过，plugin test **4/4**。测试使用隔离插件副本及空 HOME，没有安装到个人插件目录。
- 性能修复后再次在固定 CLI 官方引擎执行 validate 和插件测试：**5/5**。新增用例实际执行 register 长流路径；证据 `/private/tmp/ak-native-preview-performance-20261016-nax6bndi/`，空 HOME、`env -i`，deny-network 探针返回 EPERM。源码副本及哈希匹配，未调用模型或重跑上述 TUI 失败用例。
- 运行中热加载严格实验失败证据保存在 `/private/tmp/ak-native-running-reload-s4sc7mpu/native/`：修改隔离副本后 20 秒没有出现新 lease，原连接仍为同一 generation、同一 turn、running。不能宣称新模块接管已有流迭代器、同轮取消或本批完整历史验收通过。
- 此批合成 Messages 请求为 title 2 / seed 1 / cancel 1 / followup 0 / other 0，真实模型 **0**；失败后清理自有资源，未自动重跑。原先已通过的取消和空闲重载证据仍属于[接入 QA](native-session-connection-2026-10-16.md)中的历史批次。
- 自动化故障注入覆盖实际重载后缺失 start 的安全状态；该结果不替代固定 CLI 的运行中热加载验收。原生审批、问答、附件与生产原会话发送仍保持未开放，不扩大能力。
- Codex 生产入口未改，本轮仅回归隔离共享 app-server 探测测试；原生证据及其限制见[Codex QA](codex-shared-server-2026-10-16.md)。

## 独立复审

- 第一轮：Standards **1**，Spec **3**；确认问题已修复，补充异常清理及真实组件回归。
- 第二轮：新代理独立读取全部 **63** 文件并重算冻结哈希。Standards **no finding**；Spec **1 个 P2**（长流预览开销），针对性回归 **99/99**。继续修复后重新审查，不能将单轴通过当作闭环结束。
- 第三轮：新代理核对 **63** 文件和 tracked diff 哈希；Spec **no finding**，补充 1,000 个 UTF-8 边界与流对象透传检查通过；Standards **1 个 P2**（Codex 诊断路径脱敏）。继续修复后复审。
- 第四轮：新代理核对 **63** 文件和 tracked diff 哈希；Spec **no finding**；Standards **1 个 P2**（Claude 原生 fixture 日志路径），依据保存前源码和已有原生日志实证。没有为复现重跑 CLI 或模型。诊断修复后的相关检查 **128 通过、1 opt-in 跳过**，仍继续补齐 Claude 同类边界。
- 第五轮：两位全新代理分别完整审查 **66** 个冻结文件，重算文件及 tracked diff 哈希一致；**Standards no finding（0），Spec no finding（0）**。两轴独立，没有以一个轴的通过覆盖另一轴。主代理复核冻结源码未变、当前 staged 插件字节及哈希一致。

本次 goal 的审查—修复闭环已达到两轴 no finding。最后只追加本 QA 的真实结果；未提交、推送或发布。此结论是当前变更的独立代码审查结论，不是全部测试或原生验收已通过的声明；上文的全量超时和原生未验收边界保持有效。
