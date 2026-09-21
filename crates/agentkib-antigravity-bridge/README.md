# Antigravity ACP bridge

使用 Google 单独分发的 `agy_acp_server.par` / `agy_acp_server.exe`，通过 ACP v1 JSON-RPC stdio 接入。与 `agy -p --output-format stream-json` 是不同协议。

- `StdioClient::spawn` 接受调用方核验过的绝对可执行路径、参数和绝对工作目录；不会安装、登录、读取凭据或寻找 IDE 私有接口。
- 异步 `Client` 和同步 `BlockingClient` 提供 `initialize`、`list_sessions`、`new_session`、`load_session`、`resume_session`、`prompt`、`cancel`、`respond_permission`、`next_event`、`shutdown`。
- 请求返回 `RpcId`，完成结果通过 `Event::Response` 按 ID 匹配。初始化成功前禁止会话操作；可选方法必须经过能力协商。初始化错误中的认证要求原样交付调用方，不自动登录。
- `load_session` 的原生历史通过 `SessionUpdate` 在完成响应之前回放；`resume_session` 不回放。字段保留为 JSON，避免静默丢弃工具调用或未知更新类型。调用方负责按会话 ID 保存历史、修订号和 UI 状态。
- `BlockingClient` 在专用线程运行 I/O，可克隆用于发送与审批，必须有一个消费者持续调用 `next_event`，等待 prompt 完成时也不能停止读事件。无事件超时返回 `None`；连接关闭返回错误。128 条事件队列满时关闭连接，调用方须把断连标记为历史未完整读取，不能认定成功。
- 命令分发超时返回 `Error::Timeout`，执行结果可能未知，工作线程关闭；不得自动重试非幂等请求。单次帧上限 1 MiB，提示词上限 64 KiB，命令队列 32 条、在途请求/审批各 128 条。
- 审批只能响应真实待处理请求提供的 `optionId`，不根据选项名称自动批准。取消时返回所有待审批的 `cancelled`，等待原 prompt 响应才能认定停止。客户端不提供文件/终端工具，未知服务器请求返回 `-32601`。
- 此桥不宣称 ACP 历史与 CLI/桌面/IDE 存储互通，不支持将其他 Agent 历史写成 Antigravity 原生历史。需要用实际官方版本分别验证。

同步调用顺序：`spawn` → `initialize` → 持续读事件至对应初始化响应 → `list_sessions` / `load_session` → 持续读取回放至请求完成 → `prompt`。运行中将 `Permission` 交给用户选择并调用 `respond_permission`；停止调用 `cancel`。无需等 prompt 响应才能审批。

官方依据：

- https://antigravity.google/docs/ide/extensions/zed/
- https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/session-list
- https://agentclientprotocol.com/protocol/v1/prompt-turn
- https://agentclientprotocol.com/protocol/v1/tool-calls
