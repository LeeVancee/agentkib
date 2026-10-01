# 安装版 Claude CLI 定位与 Web 错误提示

## 现场证据

- macOS 已安装 AgentKib 0.10.0，通过 Chrome 正式域名连接同机私有 IPv4 后端。
- 配对、目录搜索、Claude test 会话历史读取成功；发送按钮禁用。
- 运行中的安装版 runtime PATH 为 `/usr/bin:/bin:/usr/sbin:/sbin`，该搜索范围找不到 Claude。
- 用户 CLI 位于 `~/.local/bin/claude`，版本为适配的 `2.1.263`。
- 原代码在版本检测与发送启动处均使用 `Command::new("claude")`，未使用项目已有的跨平台 CLI 发现规则。
- Web 将带 reason 的不可用状态统一显示为“请在官方客户端打开此会话”。本次未采集授权 SSE 原始 reason，不能把该提示当作 owner 缺失证据。
- 撤销临时 Chrome 浏览器后，网页进入访问结束状态，历史与详情消失。临时局域网服务和实验控制已关闭。本轮未发送新消息或提交审批。

## 修复

- runtime 复用 `agentkib_platform::command::resolve`，版本验证成功后返回解析路径，实际启动使用该路径；不修改全局 PATH，不跳过版本限制，不启动外部代理。
- Web 仅对明确 `open-in-original-client` 原因提示打开官方客户端；安装验证、平台/Agent 不支持分别提示，未知原因不渲染原始错误。四语言同步，不改变发送、审批或回答门槛。
- 回归测试使用临时可执行文件，覆盖系统搜索路径不可见、用户目录解析后验证和启动、未知版本及缺失文件；不调用真实模型。

## 代码验证

- `cargo test -p agentkib-runtime claude_runner::tests`：25 通过。
- `cargo test -p agentkib-runtime`：88 通过。
- `cargo clippy -p agentkib-runtime --all-targets -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `pnpm --filter @agentkib/web test`：157 通过。
- Web 和桌面 typecheck、Web 内置/托管构建：通过。
- 修改的 Web 文件 oxfmt 检查及 `git diff --check`：通过。

## 尚未完成

- 修复后的安装包从 Finder 正常启动的真实验收，及正式域名的新提示验收。
- 修复后的真实发送、结构化问答、审批回传。本次代码测试不替代这些验收。
- 未覆盖其他设备、Windows 或其他 Claude 版本；未改变其控制能力声明。
- 未替换用户安装的应用、未部署 remote、未提交或发布。
