# Claude Remote Relay 两仓库同步验收 — 2026-10-09

## 实现范围

本轮在 PR #108 的 `2cadfb148d072b66f4ad3e9037f971a5786714bc` 上补齐桌面 Relay TLS 的受限 WebSocket 转发，配套 `agentkib-backend` 基线为 `b07ec13cb6f45edc945358d6c33ee08db914b58d`。VPS 继续转发设备 TLS 密文，不增加 Claude API、数据库字段或生产依赖。

只允许 control 通道的 `GET /api/web/v1/socket`。代理检查租约、运行代次、Host/SNI，转发保留 Origin、Cookie 和握手字段，由真实宿主继续执行配对、CSRF、能力及每帧授权。preview 通道、其他路径和方法拒绝；不重试请求。待连接与升级后连接都受停止、撤销和租约失效清理约束。

## 离线证据

环境为 macOS arm64、Node `26.9.0`；桌面使用 pnpm `12.10.1`，独立后端使用 `10.8.1`。frp `0.68.0` darwin_arm64 官方归档通过已固定 SHA256 `9f344774971dfb9ae90ee1f633de68d1755c98510227a67289ec78081fc5c8fa` 校验。本地 Docker `29.6.1` / Compose `5.2.0` 仅运行隔离测试项目。

跨仓测试在 `apps/desktop` 中显式启用，未设开关时该测试会跳过；设开关但缺少后端路径或二进制时明确失败：

```sh
AGENTKIB_TEST_CLAUDE_RELAY=1 \
AGENTKIB_TEST_BACKEND_ROOT=/absolute/path/agentkib-backend \
AGENTKIB_TEST_FRPC=/absolute/path/frpc \
AGENTKIB_TEST_FRPS=/absolute/path/frps \
./node_modules/.bin/vitest run test/claude-web-backend-integration.test.ts --maxWorkers=1
```

跨仓用例覆盖实际 broker 注册与租约、HTTP 新建和发送、配对设备回执隔离、WS 设置、Origin/Cookie/CSRF 拒绝、重连只查询不重发、同请求重试幂等、冲突输入拒绝和配对撤销。生产 DNS/ACME 初始化由临时证书与随机端口替代，链路上的生产执行和代理方法未 mock。

独立复核补出拒绝升级时的连接清理边界：客户端提前发送大量数据后，即使 403 响应已结束，暂停读取的 TLS 连接仍可能残留。修复在响应交付后确定关闭 socket，永久回归同时验证提前输入不会泄漏连接、大拒绝正文不会被截断。首次整合回归为 767 通过、1 失败，新增 2 MiB 拒绝正文用例因背压卡住而超时；随后改为显式 HTTP 响应分帧和流式转发，保留 chunked trailers 与多 Cookie，不依赖 Upgrade 后已解除的 HTTP 响应内部绑定。最终复验另列。

最终整合命令（在 `apps/desktop`，使用上文四个跨仓环境变量）：

```sh
./node_modules/.bin/vitest run electron/main/web electron/main/ipc/conversation.test.ts electron/main/conversation-hub.test.ts test/claude-*.test.ts test/codex-*.test.ts test/managed-*.test.ts --maxWorkers=4
```

| 检查 | 最终结果 |
| --- | --- |
| 上述宿主/Backend/Codex 回归，显式启用跨仓 Relay | **38 文件、768 项通过**，71.35 秒，无跳过。包含 **29 项**真实服务到合成 CLI 测试（其中 1 项经过真实跨仓 Relay），以及 **56 项** Relay manager 测试（新增 25 项）。 |
| `pnpm typecheck` | Backend、Desktop、Web 全部通过。路由生成器保留既有循环依赖 warning，退出码为 0。 |
| `pnpm --filter @agentkib/desktop electron:build` | Electron main/preload、Backend 构建及原生依赖 staging 通过。未发布安装器。 |
| `pnpm format:check`；两个新增/修改的 Desktop 集成测试文件 `oxfmt --check` | 688 个既有覆盖文件与两个集成测试文件均通过。 |
| 四个变更 TypeScript 文件的定向 `oxlint`；`git diff --check` | 通过。 |
| 独立最终复核 | 无剩余 finding；仓库外 **3/3** 探针通过，覆盖原泄漏、成功升级后的 2 MiB 末帧及有背压的 2 MiB chunked 拒绝响应与 trailers。 |

后端使用已校验 frpc/frps 运行 `pnpm test`：**58 项中 47 通过、11 跳过、0 失败**。被跳过的 Compose 另行启用并 **1/1 通过**，最终轮 61.90 秒；其他跳过为 9 项独立 PostgreSQL 专项和既有账号跨仓测试。本轮没有数据库或账号界面改动，不将这些跳过计为通过。后端完整证据保存在其 `docs/acceptance/2026-10-09-claude-relay.md`。

测试计数有包含关系，不重复累计。隔离 Compose 项目和测试连接均已清理；两个原工作区内容保持不变。

## 后续审查修复：WebAccessService 拒绝升级的连接清理

相对 `origin/main` 的后续审查发现，直接访问 WebAccessService 时，错误路径与缺失 Origin 的升级请求在登记连接、设置超时之前返回。客户端提前发送 512 KiB 数据并保留写入端，会在拒绝后留下连接，阻塞 `server.close()`。新回归的四种拒绝条件（错误路径、缺失 Origin、授权拒绝、授权抛错）在原实现上均复现连接未释放。

修复将所有升级连接先纳入关闭管理及现有 10 秒握手期限。拒绝后发送完整 403／404 并丢弃提前输入；正常对端关闭时释放连接，保持半开的对端由期限收尾，服务停止时立即回收。独立探针曾发现响应 `finish` 后立即销毁连接会间歇丢失拒绝响应，因此最终实现保留有界排空，不采用立即销毁方案。

永久回归新增 5 项，验证四种拒绝响应与停止清理，以及不停止服务时半开连接在 10 秒期限释放。最终复验在 `apps/desktop` 中使用上文四个跨仓环境变量：

```sh
./node_modules/.bin/vitest run electron/main/web/managed-websocket.test.ts electron/main/web/relay/manager.test.ts electron/main/web/service.test.ts test/claude-web-backend-integration.test.ts --maxWorkers=4
```

- **4 文件、229 项通过**，70.62 秒，无跳过；包含 WebSocket **53 项**及真实 frp 跨仓链路。
- `pnpm --filter @agentkib/desktop typecheck`、`pnpm --filter @agentkib/desktop electron:build` 通过。
- 两个变更 TypeScript 文件的 `oxfmt --check`、`oxlint` 及 `git diff --check` 通过。
- 独立复核 **2 文件、4 项探针通过**：原两例等待 10.5 秒后连接为零且服务完成关闭；两类拒绝各连续 20 次，共 **40/40** 收到完整响应并在停止后释放连接。该 finding 无残留问题。

本次修复只修改桌面代码、测试及本记录；未重跑独立后端与 Compose 回归，不将上轮结果当作本轮执行结果。

## 验证边界

跨仓测试使用真实 broker、frpc/frps、桌面 Relay TLS、WebAccessService、TypeScript Backend 与合成 Claude CLI。临时证书和随机 loopback 端口替代生产 DNS/ACME；测试不是实际 Claude 模型验收。后端单独的 HTTPS/WS fixture 只证明透明传输。

未访问生产 VPS、真实凭据或用户数据，未进行真实模型、实体手机、生产中继及运营商网络验收。没有提交、推送、合并或部署。工作区路径只在会话交付中提供，不写入公开 QA。
