# Codex Plan / Goal 原生协议验收（2026-09-27）

## 验证边界

使用真实 Codex app-server 可执行文件，隔离 HOME、CODEX_HOME、TMPDIR 和工作区；清空继承环境，仅连接本机 loopback Responses fixture。没有读取用户 auth、没有调用真实付费模型、没有修改真实项目。模型回复和问答由确定性 fixture 产生：以下通过证明协议、状态及引擎生命周期，不证明真实模型规划质量、Plan 模式不写文件的模型行为或官方 Desktop owner/follower 通道。

命令：

```sh
python3 crates/agentkib-runtime/tests/fixtures/codex_native_plan_goals.py /opt/homebrew/bin/codex
python3 crates/agentkib-runtime/tests/fixtures/codex_native_plan_goals.py /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

结构化结果见 `codex-native-plan-goals-2026-09-27.json`。

## 两版共同通过项目

- `collaborationMode/list` 原生返回 Plan（plan）和 Default（default）。未在 AgentKib 定义第三种模式。
- Plan → Default → Plan 通过 `turn/start.collaborationMode` 提交，每次原生 `thread/settings/updated` 返回实际模式；内层模型/强度与外层参数及模型请求一致。
- `developer_instructions:null` 由 Codex 解析为原生内置指令。fixture 没有注入自定义模式提示词；记录仅保存布尔结果，不复制原生指令正文。
- 合成 `<proposed_plan>` 模型输出由 Codex 自己解析为 `type:plan`、`item/plan/delta`；计划正文去除标签后在 item/completed 和 thread/read 历史中一致。不是 AgentKib 正则造出的计划类型。
- Plan `request_user_input` 经 `item/tool/requestUserInput` 回答，匹配 `serverRequest/resolved` 后完成轮次。
- Goal 更新省略 `status` 保持 paused / blocked；省略预算保留旧预算，显式 `tokenBudget:null` 清空。更新不自动激活。
- 原生 active 目标在预算 1、已消耗 2 时自动进入 budgetLimited；更新目标、增加或清空预算保留非零消耗和受限状态，不重置账本。
- 预算受限时，请求 active 可能合法返回 budgetLimited。budgetLimited 在增预算后仍保持该状态，paused / blocked 请求也不会解除；足额预算下只有显式激活才继续执行。
- 原生 active 目标在一轮模型请求中暂停后，不会继续下一轮。暂停目标重启后不自动执行；显式激活后由 Codex 自身继续并消耗预算。受限目标重启后保持状态和非零消耗。
- 清除目标后 `thread/goal/get` 返回 null。

## 重启模式确认：版本差异

- **0.155.1**：`thread/resume` 响应不含模式。未经显式指定的下一轮出现空的原生 collaboration_mode 指令，不能把本地记忆视为原生确认；显式传 Plan 后重新收到原生模式事件。
- **当前内置 0.158.0-alpha.2.1**：`thread/resume.collaborationMode` 原生回读已恢复的 Plan。再提交同值 Plan 不一定产生 `thread/settings/updated`，应接受真实原生回读，不能等待不存在的同值事件。
- 初次探测把 0.155.1 的事件约定直接套给 0.158，出现超时。确认当前版本已返回原生模式字段后修正验证契约，**重新完整执行两版，各 13 次 loopback 模型请求，均通过**。
- 当前内置路径为 `ChatGPT.app/Contents/Resources/codex-cli/bin/codex`，旧 `Contents/Resources/codex` 已不存在，因此没有复测旧内置 0.155.0-alpha.16.3。本 fixture 不修改兼容白名单。

## 未覆盖

- 真实官方 Desktop owner/follower 设置、双端同步与竞争。
- 真实模型 Plan 行为、账户 usageLimited、真实模型工具行为。
- 公网中继、真实手机浏览器和网络切换。
- 本记录不修改运行时白名单，不部署、不改 VPS/TUN。
