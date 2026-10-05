# Claude 2.1.285 前台 Bash task_started 契约调查

源码 revision `057da8b81a3f3c9536a568287175af8e50c12176`，dirty；本次先只读调查，后按确认方案修改 runner，未修改权限或模型配置。

确定结论：旧实现拒绝所有 `system/task_started` 过宽。安装的 2.1.285 二进制内嵌 SDK schema 写明 `is_backgrounded=false` 表示前台、发起工具调用仍阻塞；适用于 `local_bash` 和 `local_agent`。前台 Bash 注册器 N1n 构造 `type=local_bash,isBackgrounded=false`，共用注册器 Jt 发 `task_started` 并携带工具 ID、任务类型和前后台位。长时间前台 Bash 进度路径调用 N1n，与首次失败用例只请求 `sleep 30` 的历史相符。

前台结束契约：U1n 只处理未后台化的本地 Bash，删除注册项后调用 Ei，带 toolUseId 发 task_notification；LIt 将正常/失败/中断分别映射 completed/failed/stopped。task_updated 的 patch 包含后续 is_backgrounded，不能只检查起始帧。后台集合由 Pm 过滤掉 isBackgrounded=false，`background_tasks_changed.tasks=[]` 是有效空快照。

具体二进制 SHA、byte offset 和只读摘录在 `task-started-local-contract.json`。失败用例没有完整 stdout，以上不能反向冒称已捕获其 task_started 字段。修复后新独立用例记录合成任务 stdout。

官方 SDK changelog 0.3.238 记录 is_backgrounded 增量字段，0.3.203 记录后台全量集合的语义；此为佐证，精确 2.1.285 行为依据安装二进制。[Anthropic SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

修复范围：仅精确 2.1.285 启用；只承认当前轮次已见 Bash tool_use_id、local_bash、is_backgrounded=false、非子代理所属。保存 task→tool 关联。未知关联、缺字段、后台升级及非空后台集合仍拒绝，不能以任务结束通知代替本轮 result。新 send/stop 清空关联，263 原契约不放宽。

异常重启验收审查修正：旧 crash 记录缺少强杀前状态，虽证明重启时存在 unknown 和发送保护，但不足以证明 unknown 由强杀触发。新增测试要求并记录强杀前 running/waiting-approval/waiting-input，核对回执 found/requestId/sessionId/operation 后再断言 completionObserved=false；旧结果不回填未经采集的字段。
