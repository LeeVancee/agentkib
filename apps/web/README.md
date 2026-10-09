AgentKib Web 使用 React、shadcn/ui、Tailwind CSS 和 TanStack Router 文件路由。开发与构建从仓库根目录运行：

- `pnpm dev:web`：开发服务器。
- `pnpm build:web`：供桌面端静态服务使用的构建。
- `pnpm build:web:hosted`：独立托管构建，保留连接确认与部署 headers。
- `pnpm --filter @agentkib/web typecheck`：生成路由树并检查类型。
- `pnpm test:web`：运行已有回归用例。

`src/routes` 只负责路由、页面装配和导航。`routeTree.gen.ts` 由插件或 `pnpm --filter @agentkib/web routes:generate` 生成，不手动编辑。生产构建按路由分包。

`src/index.tsx` 是唯一入口文件，应用路由和兼容导出位于 `src/router.tsx`。`src/router.tsx` 管理路由，`src/environment.tsx` 管理连接环境，公共会话布局位于 `src/features/sessions/session-layout.tsx`。`src/features` 按业务组织：

- `connection`：连接地址、风险确认、配对及等待页面。
- `catalog`：工作区分组、筛选与会话详情。
- `sessions`：会话状态、实时订阅、阅读区和消息操作。
- `interactions`：原生 Agent 问题的选择、校验和回答。
- `preferences`：语言、外观、主题色与系统主题监听。

`components/ui` 为可继续通过 shadcn CLI 扩展的基础控件，配置在 `components.json`。审批与问题弹窗保留原生 `dialog.showModal()` 的模态行为、同步关闭和焦点恢复，样式使用相同的 Tailwind 主题。`style.css` 仅维护主题、共享提示和 `@agentkib/session-ui` 输出的正文样式。根目录中的旧组件入口保留为兼容导出；新代码直接引用功能模块。

路由使用 hash history，例如 `#/sessions/<sessionId>`。文件路由与 history 类型相互独立；hash 避免要求桌面静态服务为任意路径回退到 index.html。刷新、前进和后退都通过路由恢复选择，未配对时先进入授权流程。原有 `#connect=...` 地址仍需用户主动确认后才连接。连接地址和授权凭据不持久化到浏览器存储，hosted 刷新后需重新连接。

会话状态放在会话布局的 Provider 中，切换子路由不会重新创建客户端。实时监听集中在 `use-session-live.ts`；控制请求及权限同步位于 `use-session-controller.ts`。保留访问身份变更后的清空、旧异步响应隔离、完整审批快照校验以及结果不确定时禁止自动重发的约束。修改这些流程时运行已有回归用例。

Codex 与 Claude 共用 `packages/conversation-ui` 的会话控件，`packages/web-client` 的通用方法按 agent 选择路由；既有 Codex 方法保留兼容。Claude 高级操作使用 `POST managed/action`，设置、队列、目标和资源读取使用对应 `GET managed/*`；inspect 继续走只读 `managed/inspect`。设置中的 `permissionMode` 与 Codex `policyId` 独立，实际模型/effort 来自主机发现；无 capability 时不挂载相关读取。运行中插入、队列与目标有不同语义，见 [Claude 控制说明](../../docs/CLAUDE-WEB.md)。

浏览器默认仍使用 HTTP 和 SSE。主机额外提供 `/api/web/v1/socket` 有界 JSON 适配器，复用 HTTP 鉴权和回执，不向浏览器暴露原始 Backend RPC；它不承载附件字节、历史长读或 SSE。新增能力及未执行的真实设备/模型验证记录在 [2026-10-09 QA](../../qa/claude-remote-parity-2026-10-09.md)。

可视验收可使用 `QA_PORT=1433 node apps/web/scripts/qa-server.mjs`，它读取本地构建并提供合成数据，不连接真实 runtime 或 Agent。
