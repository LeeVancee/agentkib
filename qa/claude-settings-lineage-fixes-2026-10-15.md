# Claude 设置、历史与 MCP 审查问题修复 — 2026-10-15

## 源码与边界

- 审查基线：`origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`。
- 修复起点：本地 `main @ bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`，包含此前 25 个跟踪文件的未提交修改。本轮在其基础上修改，另保留 `.agents/`、`prototypes/` 和已有未跟踪测试、QA。
- 本轮增量为 18 个源码、测试和说明文件，加本 QA；开始时的补丁、文件副本和 SHA256 已保存在本机临时备份中。源码没有提交、推送或部署。
- 工具链：macOS arm64，Node `22.23.3`、pnpm `12.10.1`；Worker smoke 使用锁文件中的 Electron `44.0.0` / Node `24.18.1`。
- 未新增依赖、公共 RPC 或数据库结构；Claude 正文索引的内部解析身份升为 `claudeLineage:2`，使旧缓存重建，其他 Agent 的身份不变。不改原生历史或个人 Agent 配置，不调用真实模型。

## 修复与回归

1. **包装命令脱敏。** 原实现只识别命令边界上的裸 curl，`env`、`command`、前置赋值和 shell `-c` 中的组合选项凭据会进入 Context 或项目 command 的 MCP 元数据。现在按字面命令词识别包装及凭据参数，嵌套有上限；无法可靠解析的敏感片段保守隐藏。独立复核另发现简单 `$VAR`、位置参数和特殊参数未被识别为动态，已补修并通过真实表面验证。单引号、转义美元符、普通 `python -u` 和描述性文本仍按原行为展示。
2. **完整策略合并。** 移除有效列表合并和消费时的 256 项展示截断；在既有文件大小边界内保留完整的 managed 拒绝、禁用和排除规则，展示数量另行限制。255、256、300 条低优先规则与 managed drop-in 合并均有回归，实际 MCP 扫描保留拒绝标记，Context 不读被排除正文。
3. **有界 MCP 通配匹配。** URL 中仅 `*` 是通配符，字面片段使用顺序 KMP 匹配，时间复杂度为 O(pattern + text)，避免正则指数回溯。覆盖首尾锚点、重叠片段、连续星号、Unicode 和正则元字符。真实 Backend 子进程同时处理病态规则扫描及工作区查询，须在 1 秒内完成；独立看门狗确保回归不会卡死测试进程。该用例使用始终跨层合并的项目拒绝规则，不依赖主机的 managed-only 允许列表。
4. **压缩记录版本选择。** 压缩谱系保存构建该段时采用的原始行号，交接与搜索只读取相同行号，不再把同 UUID 重写副本都当作轮次。不同 UUID 的相同正文保持，工具调用及结果关联保持；损失数量按实际选中记录计算。
5. **缺链不再伪装完整。** 回溯中缺少非空父记录时保留可读部分并标记 `compaction-link-unavailable`，搜索显示部分覆盖。选择完整压缩前历史时，预览禁用原生导入，规划对所有目标再次拒绝，确认损失不能绕过。默认摘要模式及明确选择、确认后的文件交接仍可用；预览后断链会使来源指纹失效。

## 实际验证

所有新增回归使用合成历史、临时工作区及配置，没有执行模型请求。定向测试集合有重叠，不能相加作为唯一用例数。

| 检查 | 结果 |
| --- | --- |
| settings、assets、MCP 与新增边界测试 | 4 文件、268 项通过；新增边界文件 84 项 |
| compaction document、handoff、history search source | 3 文件、126 项通过 |
| MCP 策略语义与真实 Runtime 响应测试 | 2 文件、40 项通过 |
| 最终 `pnpm format:check` | 通过 |
| 最终 `pnpm lint` | 通过；仍有任务外文件的既有警告，无错误 |
| 最终 `pnpm typecheck` | backend、桌面、Web 全部通过 |
| 最终 `pnpm test` | 桌面 259 文件：4821 通过、2 个既有条件跳过；Web 37 文件：765 通过 |
| 最终 `pnpm build` | 通过 |
| 最终 `pnpm build:web:hosted` | 通过 |
| `node apps/desktop/scripts/run-backend-worker-smoke.mjs` | Electron utilityProcess 中索引/查询、Skills、交接读取 Worker 全部通过 |
| `git diff --check` | 通过 |

最终完整验证在 `$VAR` 补修冻结后重新执行，整条命令退出码为 0。本轮未削弱断言或新增跳过。

## 独立复核

- MCP 通配实现：no finding；独立做 41,261 组穷举及 100,000 组 Unicode/换行差分，另以 200 万字符的重复前缀检查线性行为。
- 压缩谱系、原生规划和恢复入口：no finding；覆盖行号选择、工具关联、断链损失、目标门限、重新读源指纹和缓存失效。
- 设置脱敏与合并：首轮发现 `$VAR` 遗漏，补修后复核 no finding。独立真实 Context 与 MCP 输出均不包含合成凭据，并单独重跑 84 项新增边界测试。

上述结论限于本轮修复及相邻路径，不代表整个分支没有其他问题。

## 本机证据与限制

临时文件可能被系统清理；本记录为结果摘要，不替代完整原始日志。

- `agentkib-fix-five-20261015-846kee4b/`：系统临时目录下的修复起点补丁、文件副本及身份清单。
- `/tmp/agentkib-five-fixes-source-20261015.json`：最终增量文件 SHA256。
- `/tmp/agentkib-settings-before-after-probe.log`：旧快照与修复版本的包装命令、策略截断对照。
- `/tmp/agentkib-settings-boundary-tests.log`、`/tmp/agentkib-settings-final-review-test.log`：实现及独立复核测试。
- `/tmp/agentkib-fix-lineage-tests-20261015.log`：历史定向回归。
- `/tmp/agentkib-five-fixes-mcp-tests-20261015.log`：MCP 定向回归。
- `/tmp/agentkib-five-fixes-final-validation-20261015.log`：第一轮完整验证。
- `/tmp/agentkib-five-fixes-final-variable-validation-20261015.log`：包含 `$VAR` 最终补修的完整验证。

本轮未启动安装版应用或处理个人钥匙串，未做真实模型、手机、Windows/Linux 实机、签名安装包或自动更新验收。Windows/Linux 相关路径保留在跨平台自动化中，本机通过不等同于这些平台实机通过。
