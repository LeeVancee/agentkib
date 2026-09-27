# 一次性授权码直接授权验收

日期：2026-09-26 至 2026-09-27（Asia/Shanghai）。

## 本轮行为

- 同源 Web 使用有效八位一次性授权码后直接进入，无需桌面再次确认。获得全部已登记及以后新增的 AgentKib 工作区的远控权限，包含当前支持的任务控制、审批、文件与产物、附件及会话管理。
- 授权码仍为五分钟有效、一次使用；配对串行处理并先持久化后发布授权。保存失败可显式重试，响应丢失可通过原浏览器恢复已保存授权。
- 原生执行兼容性、审批内容与版本、未知写入结果限制和文件路径保护仍有效。授权不等于自动同意 Codex 审批。
- 旧浏览器保留旧权限；撤销后以新码重新连接才获得完整权限。局域网 HTTP 保留原确认方式及能力边界。
- 桌面及 Web 的简体中文、繁体中文、英文、日文已同步。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 桌面 WebAccessSettings、WebPairingPrompt，服务端 code-pairing、service、lan-service、codex-actions、remote-capabilities、remote-enable、artifacts、attachments | 10 文件，183/183 通过 |
| Web pairing-page、hosted-home、session-stability | 3 文件，34/34 通过 |
| 桌面、Web 类型检查 | 通过 |
| 同源 Web、托管 Web 构建 | 通过 |
| 桌面渲染层、Electron main/preload 构建 | 通过 |
| git diff --check | 通过 |

关键覆盖：同码并发仅一次成功、写入失败不消费授权码、写入完成前不可见、响应丢失及重启恢复、旧新权限不串用、未来工作区可用、任意或已移除工作区拒绝、原生宿主校验和审批 revision 保留、撤销授权。

复现命令（分别在 apps/desktop、apps/web 中运行）：

```sh
pnpm exec vitest run src/features/remote/WebAccessSettings.test.tsx src/features/remote/WebPairingPrompt.test.tsx electron/main/web/code-pairing.test.ts electron/main/web/service.test.ts electron/main/web/lan-service.test.ts electron/main/web/codex-actions.test.ts electron/main/web/remote-capabilities.test.ts electron/main/web/remote-enable.test.ts electron/main/web/artifacts.test.ts electron/main/web/attachments.test.ts
pnpm typecheck
pnpm build:web
pnpm electron:build
```

```sh
pnpm exec vitest run src/features/connection/pairing-page.test.tsx src/features/connection/hosted-home.test.tsx src/features/sessions/session-stability.test.tsx
pnpm build
pnpm build:hosted
```

## 浏览器验收

先使用实际 WebAccessService 和编译后的 Web 页面，通过仅监听 loopback 的隔离服务验收。会话、工作区及文件均为合成测试数据，runtime 为测试实现。

1. 页面明确显示一次性码直接授予全部工作区权限，无待桌面确认步骤。
2. 输入测试授权码后直接进入会话列表；未设置旧工作区勾选、未打开旧 experimental 开关。
3. 会话可输入消息，发送按钮可用；未发送真实模型请求。
4. 打开文件与产物 → 项目文件 → hello.txt，实际文件接口返回测试内容。
5. 使用最终服务端构建重启相同隔离数据目录并刷新页面，浏览器仍保持授权，无需重复配对。
6. 服务端撤销该浏览器，持续连接页面显示“远程访问已结束”，会话与审批内容清空。
7. 关闭测试标签页并停止隔离服务。

真实/历史截图留在本机，公开记录保留文字结果。

## 安装包与公网闭环

- 执行完整 `pnpm build`，成功生成 release runtime、内置 frpc 0.68.0、Web 和 Electron 构建。
- 生成 macOS arm64 目录包，完成 ad-hoc 签名；`codesign --verify --deep --strict` 通过。安装包冒烟结果保存在 [code-access-package-2026-09-27.json](code-access-package-2026-09-27.json)：内置 Web、frpc 许可证、Rust CSR 实现均存在，隔离配置启动至首页数据就绪约 386 ms。
- 已将候选应用安装到 `/Applications/AgentKib.app`，版本 0.11.0。原应用完整备份在 `/tmp/AgentKib.app.pre-code-access-20260927`；正常用户 Web 配置的迁移前备份在 `~/Library/Application Support/ai.agentkib/electron/web.pre-code-access-20260927`。
- 使用腾讯云香港中继完成真实登记和双通道连接。Broker `https://api.agentkib.com/healthz` 返回 `ok: true`、协议版本 2；公网控制 origin 返回 200，预览 origin 根路径按设计返回 404，二者证书校验均通过。
- 使用公网 origin 和真实 AgentKib/Codex 索引临时授权浏览器。输入一次性码后直接进入，共识别 86 条会话和全部已登记工作区，没有桌面确认步骤。
- 只打开隔离测试工作区的 `AK Completion Public QA 0926` 会话，并读取安全测试文件 `notes.md`；未读取真实项目文件、未发送模型消息、未创建或交接任务。
- 使用同一隔离配置重启已安装应用后，浏览器授权仍有效且会话视图可恢复。随后从桌面撤销临时完整权限，公网页面立即显示访问已结束并清空会话内容。
- 将已验证的中继身份迁移到正常用户配置后重新启动 `/Applications/AgentKib.app`。应用重新生成了正常目录下的两个 frpc 配置和动态本地端口；桌面显示“可供手机连接”，控制通道和预览通道均为 ✓。
- 使用新的无 Cookie 浏览器访问公网控制 origin，确认只能进入 `/#/pair`，发送按钮不可用；没有生成或使用新的授权码。正常配置仅保留迁移前已有的 `test` 浏览器授权，临时公网验收授权已撤销。

真实/历史截图留在本机，公开记录保留文字结果。

## 交付边界

代码、自动测试、release 构建、安装包冒烟、已安装应用、真实香港中继、正常用户配置恢复以及公网浏览器授权/重启/撤销闭环均已通过。保持现有 TUN 路由，没有加入绕过规则；本轮没有改动 VPS 部署、提交或推送 Git。

候选应用仅为本机 ad-hoc 签名，尚未使用 Developer ID 签名或公证，不能作为面向其他用户分发的正式安装包。iPhone Safari 与 Android Chrome 的扫码、媒体拖动和网络切换仍需真机验收；当前桌面浏览器公网结果不能替代这两项。
