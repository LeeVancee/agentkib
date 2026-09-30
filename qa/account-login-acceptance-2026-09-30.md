# 账号登录与远控设备管理：客户端交付

2026-09-30。本轮代码未提交、推送或部署；没有替换已安装应用、修改生产数据库、DNS 或 TUN。

## 行为

- 本地会话、文件和 Codex 继续免登录。设置中的“远控账号”仅用于公网设备管理。
- 主进程通过系统浏览器、PKCE S256、随机 state 和一次性回环回调登录。renderer 只接收账号状态，不接收密码、令牌或设备凭据。
- 短期访问令牌在内存，刷新令牌经系统安全存储加密；不可用时拒绝保存，轮换结果未知时要求重新登录。
- 登录后新设备按账号配额登记；旧设备必须显式认领，保留原设备身份和浏览器授权。未知认领绑定目标账号，切换账号不能自动改绑。
- 退出先持久暂停公网，再撤销登录并清除本地凭据。远端撤销失败会提示，本地仍保持退出和暂停；重新登录原账号后需要显式恢复。
- 账号网页列出设备后打开校验过的 control 域名。新浏览器仍需八位远控授权码；登录不代替远控授权或 Codex 审批。
- 桌面和托管首页新增文案覆盖简体中文、繁体中文、英文和日文。

## 验证

| 范围 | 结果 |
| --- | --- |
| `pnpm test:web` | 226 通过 |
| 桌面账号、远控服务和账号／远控设置 UI | 基线 247 通过、1 个真实 Claude 入口跳过 |
| 最后认领目标账号修复后的账号、relay 和 enable 回归 | 50 通过 |
| 桌面类型检查与相关 lint | 通过 |
| 同源 Web、托管 Web、桌面 renderer、Electron 构建 | 通过 |
| 后端临时 PostgreSQL 与真实 DesktopAccountService | 57 项中 55 通过，2 个独立 frp/Compose 入口跳过；Compose 另行 1/1 通过 |
| 账号网页 Node 测试及构建 | 9/9 通过，构建通过 |
| Chromium 账号网页 → 真实账号 HTTP → 真实桌面 PKCE 服务 | 9 项通过，详见 backend 账号网页 ACCEPTANCE.md |
| macOS arm64 应用包冒烟 | 通过；隔离启动到 home-data-ready，frpc／Rust CSR／Web 资源通过 |
| `remote-runtime.integration.test.ts`（显式启用） | 1/1 通过；真实账号服务、八位码配对、打包 Rust runtime 读取隔离固定会话、退出暂停及浏览器撤销 |

运行入口：

```sh
pnpm --filter @agentkib/desktop exec vitest run electron/main/account electron/main/web src/features/remote/RemoteAccountSettings.test.tsx src/features/remote/WebAccessSettings.test.tsx
pnpm --filter @agentkib/desktop typecheck
pnpm test:web
pnpm build:web
pnpm build:web:hosted
pnpm --filter @agentkib/desktop build:web
pnpm --filter @agentkib/desktop electron:build
# 独立真实服务闭环，路径指向本地 backend 与已构建的 runtime：
AGENTKIB_ACCOUNT_TEST_BACKEND=/absolute/path/agentkib-backend AGENTKIB_ACCOUNT_TEST_RUNTIME=/absolute/path/agentkib-runtime pnpm --filter @agentkib/desktop exec vitest run electron/main/account/remote-runtime.integration.test.ts
```

本地 unsigned 应用包位于忽略目录 `output/account-login/package/mac-arm64/AgentKib.app`；冒烟报告为 `output/account-login/package-smoke.json`。没有生成发布版签名／公证 DMG。

## 当前限制

本地服务闭环已串通账号注册、桌面登录、设备认领／选择、八位码配对、真实 runtime 读取固定安全会话、退出暂停和浏览器撤销。配对前读取被拒绝，账号令牌不能替代远控授权，退出保留本地工作区与设备归属。

账号浏览器与服务闭环均使用隔离事务内存存储和注入安全存储；PostgreSQL 单独联调真实桌面服务，系统钥匙串未做真实授权验收。服务测试将设备地址显式映射 loopback，不验证公网 TLS／FRP，不执行真实模型。真实浏览器 UI、设备域名及中继尚未串成同一次完整公网流程。

生产账号站点、生产 API／数据库迁移、公网端到端、iPhone Safari／Android Chrome、软键盘和网络切换均待测。后端交付与迁移说明位于相邻 `agentkib-backend` 仓库：

- `docs/ACCOUNT-OPERATIONS.md`
- `docs/ACCOUNT-API.md`
- `docs/ACCOUNT-DESIGN.md`
- `docs/acceptance/2026-09-30-accounts-local.md`
- `services/account-web/ACCEPTANCE.md`

部署准备包括独立 TOTP 数据加密密钥、schema 002 迁移备份、账号 API 显式启用及 `account.agentkib.com` 静态站点。旧数据库版本程序拒绝 schema 002，回滚需迁移前数据库备份。
