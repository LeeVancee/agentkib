# Codex 核心对话能力验收（2026-09-27）

## 结论

本轮代码、本机安装包、真实公网设备通道和 hosted Web 生产部署已完成验收。AgentKib 托管会话已通过真实模型轮次验证下一轮模型、思考强度、服务档位、执行策略、上下文用量、目标和受控资源引用。`remote.agentkib.com` 已发布本轮构建并通过公网 revision 与安全响应头核对。

不能把本轮标记为“全部终端验收通过”：iPhone Safari 和 Android Chrome 的新界面真机验收尚未完成；官方客户端已有会话的空闲设置 mutation 也仍需专门安全会话验证。

## 实现口径

- 托管会话没有使用不存在的 `thread/settings/update` RPC。设置保存为持久化的“下一轮设置”，在 `turn/start` 时原子带入模型、思考强度、服务档位和执行策略，原生事件回读后才显示为实际生效。
- `approvalsReviewer` 的自动审核值改为 app-server 实际接受的 `auto_review`；`default` 服务档位归一化为未显式指定。
- 托管会话计划模式保持不可用并返回 `native-setting-unavailable`。当前公开 app-server 协议没有可靠的会话级计划模式修改入口。
- attach/resume 不再发送无效设置 RPC，也不再伪装恢复旧 `mode`。旧账本缺少设置证据时保留结果不明状态，不自动重发或强制清除。
- `/api/web/v1/codex/session-settings` 返回当前值、主机默认、逐字段写能力、模型、effort、service tier、策略和上下文用量。
- 设置、目标和发送继续使用 request ID、runtime boot ID、revision、持久命令账本和原生状态核对；运行中禁用设置修改，未知结果不自动重发。
- 新托管任务默认受限策略；完整授权浏览器只能选择主机映射的策略，不能提交任意 sandbox、cwd、审核器或额外可写目录。
- `/api/web/v1/codex/goals` 与 `goal-set/pause/resume/clear` 映射原生 goal；AgentKib 不新增自动续跑器。
- 文件、目录和技能引用使用不透明资源 ID，发送前重新核验授权范围、资源版本、删除状态、类型和符号链接；目录不会被递归打包上传。
- 输入区已提供模型、思考强度、计划模式状态、服务档位、执行策略、恢复默认、上下文进度、目标与资源选择，并更新简体中文、繁体中文、英文和日文。

## 原生协议验证

### 托管会话

对本机 `/opt/homebrew/bin/codex 0.155.1` 做直接 app-server 探测：

- `thread/resume` 不接受 `approvalsReviewer: "agent"`，接受值为 `"auto_review"`。
- 新 thread 在产生 rollout 前不能通过 `thread/resume` 修改设置。
- 产生真实轮次后，`thread/resume` 虽接受模型、effort、tier 和 policy 字段，但返回的仍是原设置；因此不能把它当作设置写接口。
- `turn/start` 能可靠应用模型、effort、tier 和 policy，当前实现以此作为托管会话的设置边界。

### 官方客户端已有会话

当前宿主为 `ChatGPT.app 26.924.22138`，内置 CLI 为 `0.158.0-alpha.2.1`。已验证选中的官方会话可通过 follower 接收增量 SSE，页面状态会自动更新；follower 仍只控制官方客户端当前加载的会话。未加载的“处理测试对话”正确显示只读／控制未连接。

本轮没有在真实官方会话空闲状态下执行设置 mutation。官方会话的模型、effort、目标和资源能力仍必须按 follower 的逐项能力返回，不用托管会话结果替代证明。

## 真实公网验收

在已登记的香港单节点中继、真实控制域名和安装后的 macOS 应用上完成：

- 公网控制 origin 返回可信 HTTPS 200；应用重启后控制与预览两个 frpc 进程恢复。
- `/managed/options` 返回 7 个模型、主机默认 `gpt-6-astra / medium`、3 个主机策略和 42 个工作区。
- 新建隔离 `/tmp` 工作区托管会话，初始为 `gpt-6-luna / low`；计划模式显示明确不可用原因。
- 将下一轮切换为 `gpt-6-sol / high / priority / workspace-write-auto-review`，执行真实安全轮次并得到预期 `AGENTKIB_OK`。原生事件回读确认设置实际生效。
- 上下文用量由原生事件更新为 25,798 / 258,400（约 9.98%），没有用累计账单 token 代替。
- 目标设置、预算限制、暂停、恢复和清除均通过；1000 token 预算的测试目标由原生引擎进入 `budgetLimited`，记录 tokensUsed 1454。
- 文件、目录和技能引用随消息到达原生输入并返回 `REFS_OK`；删除临时文件后重用旧资源 ID 被拒绝为 `artifact_not_found`，请求未派发。
- “恢复主机默认”恢复为 `gpt-6-astra / medium / 未显式指定 tier`，执行策略保持用户选择，不被恢复默认动作改写。
- 测试会话已正常 release；目标在 release 前已清除。旧版本留下的一个结果不明托管会话继续作为证据保留，没有强制清除。
- 两个临时完整授权浏览器凭证已撤销，临时 cookie、配对材料和请求体已清理；原有 `test` 凭证保留。
- Cloudflare Pages 生产部署已完成，控制台显示 41/41 个文件上传成功。`remote.agentkib.com` 与 `agentkib-remote.pages.dev` 均返回 revision `057da8b81a3f3c9536a568287175af8e50c12176`；首页返回 HTTPS 200。
- 上传期间仅把现有 TUN 的代理选择从日本节点临时切换到新加坡节点，部署后已恢复为原节点；没有关闭 TUN 或改用物理网卡绕过。

## 自动验证与安装包

通过：

- `cargo test -p agentkib-runtime codex_managed`：27/27。
- `cargo test -p agentkib-runtime`：160/160；stdio shutdown：1/1。
- `cargo test -p agentkib-codex-bridge`：57/57。
- Web：18 个文件，161/161。
- Desktop 相关专项：4 个文件，108/108。
- Desktop 与 Web TypeScript typecheck。
- `cargo fmt --all -- --check`。
- hosted Web 构建和 Electron 构建。
- Cloudflare Pages 生产发布及公网构建信息核对；`remote.agentkib.com/build-info.json` 为本轮 revision，首页和构建信息响应包含预期 CSP、`no-store`、`nosniff`、`DENY` 与 `noindex` 头。
- 无签名 macOS 安装包冒烟：内置 frpc 0.68.0、许可证、Web、Rust CSR RPC、隔离 profile 启动及 `home-data-ready`。机器可读结果见 `qa/codex-core-controls-package-2026-09-27.json`。

安装并运行的产物：

- `apps/desktop/release-electron/AgentKib_0.11.0_macos-arm64.dmg`
- SHA-256：`1b5bc560c9dc3371616f678e84144afdf3288f35e14fa93cb4a637e8bda11ecb`
- ZIP SHA-256：`1f317ac50a65135288749e92ae99009ca00d221665dc5d7206c3299f16cf06f6`
- 安装包未签名、未公证；不能记为正式分发包通过。

## 未通过与待验收

- iPhone Safari、Android Chrome 的新设置面板、键盘、网络切换和真实发送待真机验证。
- 官方客户端已有会话的空闲设置 mutation、原生回读和双端同步待专门安全会话验证。
- 托管会话计划模式、官方会话目标／资源引用在主机没有可靠原生路径时继续显示不可用。
- 签名与公证待有效 Apple 签名服务完成。

本轮没有提交或推送 Git。
