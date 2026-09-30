# Cursor 官方原生导入与恢复探测

日期：2026-09-28（Asia/Shanghai）。源码 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，工作树含此前互通改动及用户原有改动，未提交。本子任务只新增本 QA 记录，没有启用 Cursor 生产目标或修改用户 Cursor 历史、扩展配置、凭据。

## 结论

**Cursor 确有可接受外来规范化正文的官方原生导入器，已经用合成历史完成实际导入、精确存储回读、跨进程恢复及正常 IDE 界面读取。** 此证据比“CLI 没有 import 命令”更具体，但还不足以启用 AgentKib 默认目标：运行中的普通窗口与开发宿主存在工作区路由限制，尚未建立普通窗口按目标 ID 精确续接的外部调用契约，且没有真实模型回复验收。

| 检查                                       | 实际结果                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| 冻结合成历史 → Cursor export v1 → 官方导入 | 通过，`imported: 1, failed: 0`                                                    |
| 独立目标身份及完整正文回读                 | 通过，1 个匹配 composer；根 protobuf、全部 3 个 blob 字节及 SHA-256、工作区均相等 |
| 新进程按 ID 打开                           | 开发宿主内 `composer.openComposer(id)` 通过，界面显示两条准确正文                 |
| 完全退出后正常 IDE 重启                    | 通过；无开发扩展参数，窗口标题 `workspace`，显示同一导入历史                      |
| 重复恢复不额外创建会话                     | 通过上述恢复操作后仍仅 1 个匹配目标；没有再次执行导入器                           |
| 普通窗口已打开同工作区时调用桥接           | 未通过：开发窗口没有工作区，命令返回 `imported: 0, failed: 0`                     |
| 正常窗口可独立按 ID 精确打开               | 未建立；已通过的正常窗口重启依赖官方保存的选中状态                                |
| 损坏载荷拒绝                               | 通过，缺失 blob 返回 `imported: 0, failed: 1`，具体错误见下文                     |
| 真实模型回复 / 用量                        | 未验收；界面显示 `Log in`，未登录、未调用模型，用量 0                             |
| Windows / Linux                            | 本次未运行实机实验                                                                |

## 冻结版本及实验边界

本轮读取时 `/Applications/Cursor.app` 已是 **3.22.7**，不是前轮记录的 3.19.19；本次没有安装或升级 Cursor。

- `Contents/Resources/app/package.json`: `version: 3.22.7`。
- `product.json`: commit `37076c6c3f9e253c0fa2305197e45befd13a2260`，build date `2026-09-24T05:01:24.589Z`。
- `out/vs/workbench/workbench.glass.main.js`: 45,389,668 bytes，SHA-256 `721501d167e1ea82e51f33346c924448a34360e857b1e6d3972dc677589aa5a0`。
- 实验根目录：`/tmp/agentkib-cursor-2026-09-28`。`home`、`userdata`、`extensions`、`cursorconfig`、`workspace`、载荷、开发扩展均在该目录。
- 所有 SQLite 检查只连接该实验目录内数据库，使用 `mode=ro`；未打开用户真实 `state.vscdb`。
- 没有把用户历史、环境中的 API key、系统 keychain 或 Cursor 登录状态复制到实验目录。
- Cursor 本身尝试了未授权的后台配置/元数据同步，日志返回 `No authorization header found`；本实验没有发出模型请求。

## 官方入口与身份契约

### 截图中的 Claude Code Sync

固定版本 `workbench.glass.main.js` 中的实际行为是：

1. Sync 写入 `importClaudeCodeAgents` 开关；来源服务从当前本地工作区对应的 `~/.claude/projects/<cwd slug>/*.jsonl` 读取历史。
2. 来源身份为 `claude-code:` 加 `JSON.stringify({cwd, sessionId})`，此时并没有独立 Cursor composer。
3. `beginMigration()` 读取并解析全文、建立 `ConversationState` 与 blob store。`materializeFollowUp()` 才调用本地仓库 `createAgentFromMigration()` 创建目标，然后发送本次新消息。
4. `glass.claudeCodeSessionRegistry.v1` 记录来源身份对应的 `localComposerId`、时间、来源路径及 mtime。关联写入失败只记录警告；不能把注册表存在与否作为可靠事务回执。
5. 来源扫描默认最多 50 个、30 天内的 JSONL；头部读取从 64 KiB 逐步增至 4 MiB。列表不是完整历史接口。

因此不能仅把转换文件放进 Claude 目录并打开 Sync，就宣称已经创建了可恢复的 Cursor 原生会话。

### 更直接的 Cursor export v1 导入

已安装产品的 IDE 和 Agents Window 均有官方 `Import Chat` 实现。IDE 注册命令 **`developer.bulkImportChats`** 接受一个目录字符串，可通过正式扩展 API `vscode.commands.executeCommand` 调用，不需要改 Cursor 的 JS 或数据库。

载荷结构：

```ts
{
  version: 1,
  conversationState: string, // 原生 protobuf 的 base64
  blobs: Record<string, string>, // SHA-256 hex 地址 → 原始 blob base64
  name: string,
  exportedAt: number
}
```

官方实现读取目录中的 `.json`，校验 version，解码根状态，清除 `goalState`，遍历引用 blob，创建随机 composer ID，调用原生正文 hydration，保存 composer 并 flush。当前返回值只有 `{imported, failed}` 计数，没有导入身份。

源码中的 `importAgent()` / `yDv()` 使用新 UUID；原生导入器没有以外部操作 ID 去重。不能在超时、回执丢失或重启后自动重跑。后续若接入，必须由 AgentKib 的持久化操作记录先核对唯一目标身份和完整正文。

Agents Window 的 `importChat` 使用文件选择与工作区选择界面；这也不是可以假设存在的无交互 CLI API。

## 实际实验

### 合成文档和载荷

`session-document.json` 只含两条合成正文，再转换为文本型 Cursor protobuf，不含工具、附件、推理、用户隐私或真实项目内容。它是本实验的简化输入，不是新建的产品中间格式，也没有声称已经接入 AgentKib `SessionDocument` 的生产转换函数。

用户正文：

```text
Remember marker AKIB-CURSOR-8915e16cd0d1. Project decision: use SQLite WAL.
```

助手正文：

```text
Recorded AKIB-CURSOR-8915e16cd0d1; the project uses SQLite WAL.
```

- 来源文件 SHA-256：`352be56959ca13b390e9ac60fcebd0847eff07465490e7a0639b3fdf98975527`。
- 导入载荷 `payloads/import.json` SHA-256：`6f083aa302743bf39b6cb5221f8eeee5a51339993a8d92e88f387b02c5ec3f61`。
- 目标 ID：`1bb4708e-2413-429c-a898-bb0ed5f85573`。
- 目标名称：`(1) AgentKib AKIB-CURSOR-8915e16cd0d1`。
- 目标 workspace ID：`c67ae0339139309fde10f6bb121c9de8`。

### 官方命令执行

临时开发扩展的关键调用是：

```js
const result = await vscode.commands.executeCommand(
  "developer.bulkImportChats",
  "/tmp/agentkib-cursor-2026-09-28/payloads",
);
// 实测 { imported: 1, failed: 0 }
```

扩展 `engines.vscode` 必须为具体范围，本实验使用 `^1.96.0`；初次使用 `*` 被官方扩展加载器拒绝，没有发生导入，随后修正实验 manifest。

程序通过 Python `subprocess.Popen(args, env=isolatedEnv, start_new_session=True)` 启动，参数如下；`HOME`、`CURSOR_CONFIG_DIR` 和 `XDG_CONFIG_HOME` 均指向实验根目录：

```sh
/Applications/Cursor.app/Contents/MacOS/Cursor \
  --new-window --classic \
  --user-data-dir /tmp/agentkib-cursor-2026-09-28/userdata \
  --extensions-dir /tmp/agentkib-cursor-2026-09-28/extensions \
  --extensionDevelopmentPath=/tmp/agentkib-cursor-2026-09-28/extension \
  --disable-workspace-trust --skip-welcome --skip-release-notes \
  --use-inmemory-secretstorage \
  /tmp/agentkib-cursor-2026-09-28/workspace
```

`--disable-workspace-trust` 仅用于空的合成实验工作区，不能成为生产桥接的默认参数。隔离配置关闭更新与遥测；没有改用户配置。

最初使用 `--password-store=basic` 的恢复进程在 macOS 系统钥匙串创建路径等待。`sample <isolated-pid> 1` 的调用栈停于 `SecItemAdd → defaultKeychainUI → AuthorizationCopyRights`，不是正文解析错误。没有操作该系统授权；只对无凭据实验使用官方支持的 `--use-inmemory-secretstorage` 后继续。生产路径不能使用此标志并宣称继承了用户登录状态。

### 回读与恢复

只读事务从实验 `userdata/User/globalStorage/state.vscdb` 读取：

- `cursorDiskKV` 的 `composerData:<id>`，`conversationState` 为 `~` 加预览根 protobuf 的 base64，完整字节相等。
- `agentKv:blob:<sha256>` 全部 3 个引用对象，每个原始字节与载荷相等，重新计算 SHA-256 相等。
- `composerHeaders` 存在同一 ID 的独立索引记录；`workspaceIdentifier.uri.path` 是实验工作区。
- 原生 `fullConversationHeadersOnly` 角色为 `[1, 2]`，正文与上述输入相等。正文核验同时有完整 blob 证据，不以 UI 摘要替代正文。

新进程执行 `composer.openComposer(id)` 后，Computer Use 实际观察到开发宿主界面显示两条完整正文。`composer.getComposerHandleById` 的扩展 RPC 返回空对象/无可用 data，不能把此内部对象接口当作可用历史回读 API。

完全退出该隔离进程后，去掉 `--extensionDevelopmentPath`，启动同一 userdata 的普通 IDE；Computer Use 观察到窗口标题为 `workspace`，无 `Extension Development Host` 标记，同一聊天、正文及随机标记仍显示。未生成 `User/profiles` 子配置；记录保存在共同的默认 `User/globalStorage`。

**这一正常窗口恢复利用了 Cursor 自己保存的选中状态。** 尚不能推导用户已有其它活动会话或多个窗口时也能按 ID 精确打开。

恢复结束再次核对，同一操作名称只有 1 个目标，输入及载荷未被改写。摘要保存在实验 `verified-result.json`，不含 Cursor 生成的内部加密字段或凭据。

### 失败与运行中窗口边界

1. 正常 IDE 已打开同一工作区时，再启动同工作区开发宿主，实际获得空工作区；官方 `developer.bulkImportChats` 返回 `{imported: 0, failed: 0}`。该窗口日志为 `Updated git workspace caches (0 entries)`，原窗口为 1。零 failed 和正常进程退出不能被视为导入成功。
2. 换到独立的合成 `failure-workspace`，载荷故意缺少用户 blob，返回 `{imported: 0, failed: 1}`，日志为 `Missing blob in import payload: f6f68b35a9d50b162384e387b912097f5ed72f4eb465371559f13e86f688aeed`。该错误发生在官方引用遍历阶段；没有建立该失败载荷的命名目标。
3. 官方 `workbench.action.closeWindow` 在实验中出现 `Close this window?` 对话框，不能保证后台桥接完成后无交互关闭。通过 Computer Use 关闭该合成探针窗口后，原普通窗口及成功导入聊天保留。
4. 上述失败没有自动调用模型、没有重跑成功载荷，也没有自动删除或清理用户对象。

## 生产接入仍需解决的条件

- 建立运行中普通窗口的受测工作区路由与执行契约；不能偷偷关闭用户工作区来给开发宿主腾位置。
- 建立按 ID 精确打开普通窗口的契约。当前源码的复制 deep link 功能只对 `source === 'cloud'` 开放，当前 main CLI 参数未发现本地 `composer-id` / `chat-id` / `agent-id` 入口；开发宿主调用成功不等于已有普通窗口接管成功。
- 若后续使用开发扩展桥接，必须在预览中明示产品表面、确认真实 profile 路径，不能复制凭据，也不能默认削弱工作区信任或换成无授权测试 profile。
- 使用操作 UUID、精确目标身份/根状态/blob/工作区核对及未知结果恢复，不能仅凭名称或导入计数确认成功；官方原生 importer 本身不幂等。
- 补全生产 `SessionDocument` 文本投影、转换损失、长历史、错误恢复和独立审查后，再谈默认开放。
- 最后仍须真实授权下单轮回复引用导入历史中的随机标记和项目决策。本次登录界面与后台未授权错误是未验收证据，不能通过推测补齐。

因此本轮更新应保留为 **Cursor IDE 3.22.7 官方原生离线实验通过；生产目标与真实续接未验收**。不应继续描述为“没有导入入口”，也不应宣称全 Agent 原生互通已完成。
