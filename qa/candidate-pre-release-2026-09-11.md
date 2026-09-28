# 本地候选包发布前验收

## 范围与清单

使用本地独立候选 `.app`，不覆盖已安装版本，不公开发布。远程网页仍为正式域名当前构建；因此不能用本轮结果验收尚未部署的 Web 文案修改。

检查：Finder 正常启动与 runtime PATH、CLI 可用状态、配对和授权、项目/历史读取、串行发送回传、结构化问题、允许/拒绝审批、重连与撤销。异常探索至少包含应用重启后重新连接，以及撤销后清空内容。视觉检查关注状态、输入框和待处理交互框是否可见；不将桌面测试当作真实手机验收。

## 构建及自动测试

- `pnpm --filter @agentkib/desktop build:electron` 通过，包含 release runtime、协议生成、Web 与桌面资源。
- `electron-builder --mac --arm64 --dir --publish never` 生成独立未签名候选包，输出 `/tmp/agentkib-candidate-0911.REDACTED/mac-arm64/AgentKib.app`。未执行签名、公证或发布。
- 桌面 Web 服务与刷新协调测试：88 通过、1 真实模型测试按默认规则跳过。

## 现场进度

- 通过终端 open 启动仍会继承 shell PATH，不计入桌面启动验收。
- 随后退出并通过 Finder 打开：runtime PATH 确认为 `/usr/bin:/bin:/usr/sbin:/sbin`。
- Chrome 正式域名连接候选包，临时浏览器 Chrome Candidate 0911，两端校验数字相同后确认授权。
- 应用重启后网页提示无法确认连接；点击重新连接恢复目录和历史。
- 指定 test 工作区 Claude 会话由先前不可用变为权威空闲。
- 串行无工具消息 `AK-CANDIDATE-0911-001` 准确收到回复，权威状态回到空闲，接收提示移除。
- `AK-CANDIDATE-0911-002` 原生问题自动弹出，关闭后待处理入口仍在；再次展开后 Tab 聚焦、空格选择 Blue，提交一次，收到 `AK-CANDIDATE-0911-002 — Blue.`，回到空闲。
- `AK-CANDIDATE-0911-003` 真实 Bash 审批自动弹出，命令仅 `/usr/bin/true`；拒绝后返回未执行、无退出码，回到空闲，无重试。
- `AK-CANDIDATE-0911-004` 新轮次同一低风险命令再次触发审批，Tab 可达“允许一次”，按回车提交；收到退出码 0 的回复，工具摘要显示已完成，状态恢复空闲。
- 本轮完成的 Bash 工具详情仅呈现名称、完成状态、时间和历史只读标记，未见输入/结果；需核对接口与历史能力后决定修复，不能单凭 Agent 回复补造工具输出。
- 原生截图检查：问题对话框完整可见；审批框因较长上下文需要向下滚动才可看到决定按钮，且提示和 JSON 并列挤压宽度。功能入口键盘可达，但视觉验收不通过，需后续修复。
- Codex `处理测试对话` 同步后显示需要在官方客户端打开，控制禁用。未向 Codex 发送消息，不计为其发送/问题/审批通过。

## 清理与结论

- 撤销 Chrome Candidate 0911 后，正在查看的 Codex 会话被清空，显示访问已结束。
- 本机 Web、局域网直连与两处实验控制均为关闭；授权浏览器列表为空。
- 正常退出候选包后恢复 `/Applications/AgentKib.app`，未覆盖安装版。候选包留在上述临时路径供后续复验。
- 本轮通过的是 macOS 本机 Chrome → 正式域名 → 本地候选包的 Claude 核心闭环。未完成真实跨设备、手机、Windows、Codex 控制，以及修复后 Web 文案的部署验收。
- 未改业务代码、官方权限配置，未 commit、push 或部署；本轮新增 QA 记录，保留此前 CLI/UI 修复和所有无关改动。

## 独立问题线索

只读代码检查发现 Claude provider 的索引命中路径仅更新文件路径后继续，可能忽略 transcript 更新的 mtime；Web catalog 则只读数据库缓存。两者都可能导致目录时间早于实际历史，需要独立复现修复，不能据此认定现场唯一根因。

## 后续修复与独立候选包复验（同日）

### 代码修复

- 审批框固定标题和底部决定区，仅正文滚动；上下文说明和完整 JSON 纵向排列。正文可以获得键盘焦点，决定按钮保留原有权限、时效和提交中禁用条件；关闭仍只收起。
- Claude 索引命中时仅通过文件 metadata 合并 transcript mtime，与索引/history 取最新有效时间。metadata 失败保留原时间，不重写标题、创建时间、身份或来源关系，也不增加扫描。
- 四语言工具详情改称“工具摘要”；空白正文显示“历史记录未提供工具输入与输出。”，非空内容与截断提示保留。不提供新输入/输出接口，不推断结果。
- 保留此前 CLI 定位和 unavailable reason 修复；未变更 API、协议、权限、官方会话文件或持久审批规则。

### 代码验证

- `cargo test -p agentkib-conversations`：109 单测、4 集成测试通过；覆盖旧索引、新 transcript、history/index 更晚、无效/缺失时间、metadata 失败、原生字段保持。
- `cargo test -p agentkib-runtime`：88 通过。
- `cargo clippy -p agentkib-runtime -p agentkib-conversations --all-targets -- -D warnings`：通过。
- `pnpm test`：桌面 673 通过、1 默认跳过；Web 161 通过。补充关闭恢复断言后再次 Web 161 通过。
- `pnpm typecheck`、`pnpm format:check`、`cargo fmt --all -- --check`、`git diff --check`：通过。
- `pnpm --filter @agentkib/desktop build:electron`：通过，含协议生成、release runtime、桌面和 Web 构建；生成绑定无新增差异。
- 独立只读子代理复核上述修改，未发现确定可操作的新缺陷。代码复核不代替真实验收。

### 包内网页与本机真实验收

- 新候选包：`/tmp/agentkib-layout-candidate-0911.REDACTED/mac-arm64/AgentKib.app`。使用 `electron-builder --mac --arm64 --dir --publish never` 独立输出；未签名、公证或覆盖安装版。
- 通过 Finder 启动，runtime PID 76863 的 PATH 确认为 `/usr/bin:/bin:/usr/sbin:/sbin`。Claude 会话仍可进入权威空闲并接受以下串行测试。
- 仅开启候选包本机 `http://127.0.0.1:1421`。两端校验数字一致后，临时授权 `Chrome Builtin Layout QA`；不使用正式域名的新旧部署结果冒充本次通过。
- 包内网页实际加载 `index-C6-QMSof.js`、`index-BQq9mhwB.css`。既有 Bash 失败记录详情显示“工具摘要”、真实状态和时间，以及无输入/输出说明，不再以“历史只读”填充正文。
- 在既有 test 工作区 Claude 会话串行发送一次 `AK-LAYOUT-0911-005`，仅请求 `/usr/bin/true` 的正常审批。真实审批自动出现，完整输入/上下文纵向显示，底部决定不随长正文消失。
- 关闭审批后仍显示待处理入口；恢复后 Tab 依次可达正文、“允许一次”、“拒绝此次操作”。只提交一次拒绝，回复明确为用户拒绝、未执行、无退出码，随后权威空闲，接收提示清除。无重试、替代命令或并发发送。本轮未重新进行允许测试；允许链路的真实证据仍是前述上一候选包 004 测试。
- 工作区“刷新发现”并不等于会话索引刷新。进入桌面会话目录，等待其现有索引刷新完成，再刷新 Web 目录：同一会话 `REDACTED_SESSION_INDEX_ID` 的更新时间从旧值 `2026/9/8 13:44:07` 更新为 `2026/9/11 11:25:58`，与 transcript mtime、桌面会话目录的 11:25 一致。创建时间仍为 `2026/9/8 13:39:25`，标题仍为真实缺失的“未命名会话”，身份未变。Web 读取没有触发管理扫描。

### 合成布局矩阵

- Playwright CLI 独立浏览器先用开发页检查，再转到候选包内置 `1421` 静态网页重复。仅拦截独立浏览器的业务响应为合成审批，不向实际 runtime 提交，不模拟真实模型通过。
- 合成 80 行长 JSON 上下文，覆盖 390×844、768×1024、1440×920，各浅色/深色共六组。标题和关闭入口可见、正文独立滚动、完整末尾标记存在、底部两个决定按钮在 viewport 内。390 宽度按钮最小高度 44px；Tab 可达正文、横向滚动代码区和决定按钮。
- 包内资源截图：`output/playwright/candidate-approval-{390,768,1440}-{light,dark}.png`。窄屏与平板是 Chromium viewport 模拟，不是实际手机或跨设备验收。未测试 Safari、Windows 和其他 Agent 安装版本。

### 清理与剩余边界

- 撤销 `Chrome Builtin Layout QA` 后，真实网页显示访问结束并清空会话/审批内容。关闭本机 Web、实验控制；局域网直连及其控制始终保持关闭，授权浏览器列表为空。
- 退出候选包并恢复 `/Applications/AgentKib.app`；独立测试浏览器和临时开发服务关闭。候选包与非敏感布局截图保留供审阅。
- Codex 无 owner 的控制仍保持禁用；本轮未向 Codex 发送消息，不计其控制验收通过。真实跨设备、手机、Windows 和正式域名部署未验证。
- 本轮未 commit、push、部署或发布，保留所有已有无关改动。结论仅为上述代码检查、macOS 本机候选包及标注的合成布局通过。
