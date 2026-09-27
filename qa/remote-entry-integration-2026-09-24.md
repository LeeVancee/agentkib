# 远程访问入口整合验收 — 2026-09-24

本轮在已有未提交实现上增量修改，保留其他工作。未部署、发布、提交或推送 Git，也未变更线上 DNS。

> 后续地址调整：管理 API 默认值已统一为 `https://api.agentkib.com`，保留 `/v1/...`。下文 `api.remote.agentkib.com` 是入口整合时的历史验收地址，现仅用于旧配置迁移兼容。

## 交付行为

- 桌面以“允许手机访问这台电脑”为主流程；原生“连接其他电脑”独立分区。局域网设置收进高级入口，开启后仍显示运行摘要。
- 本机管理接口新增 `remote-enable`，在串行队列内保存意图、启动本机服务和桥接；不自动开启执行或文件权限。重复开通不重启正在连接的桥接。
- ready 后首次生成配对码并保存一次性标记；轮询、重连、过期和重启不会自动旋转。暂停或掉线期间迟到的 ready 不发码；手动刷新入口保留。
- 本机/手动反代的高级配对保留，但明确未验证公网可达，不显示桥接已就绪或公网二维码。
- 新默认 API 为 `https://api.remote.agentkib.com`；`remote.agentkib.com` 保留托管页面及 LAN 可信 Origin。已有自定义地址不改，旧官方地址由用户明确迁移、新登记、新配对，不复制凭证；旧注册文件保留。
- 托管首页只做连接引导，`/#/connect` 保留局域网。旧 `#connect=...` 在首次打开和已加载 SPA 中都能处理；仅接受原有私有 IPv4 HTTP 范围。非法地址不发请求、不预填并返回首页。
- WebClient 显式区分 `same-origin` / `lan-http`，兼容原 origin 字符串构造；Cookie、Bearer、SSE 和持久回执仍隔离，不扩大跨域权限。
- 四语言覆盖入口、迁移、安全范围和连接状态；公开文档不指向私有服务端仓库。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir apps/desktop exec vitest run electron/main/web/remote-enable.test.ts electron/main/web/service.test.ts electron/main/web/lan-service.test.ts electron/main/web/relay/manager.test.ts` | 4 文件、100 项通过；新增开通测试 10 项 |
| `electron/main/web/remote-capabilities.test.ts` | 与服务/LAN/relay 首轮回归一起通过；该轮合计 99 项 |
| `pnpm --dir apps/desktop exec vitest run src/features/remote` | 8 文件、125 项通过；最后 ready 状态微调后 `WebAccessSettings.test.tsx` 15 项定向回归通过 |
| `pnpm --dir apps/web test` | 13 文件、126 项通过 |
| 后端默认测试 | 18 通过、2 个需显式环境的集成测试跳过；本轮未重复部署集成 |
| 后端 Compose 配置 | 解析通过，API host 与未变的隧道 host 校验通过 |
| `pnpm typecheck` | Desktop / Web 通过 |
| `pnpm --dir apps/desktop build:web`、`electron:build` | 通过 |
| Web `build`、`build:hosted` | 两种构建通过 |
| 定向格式、lint、`git diff --check` | 通过；保留原有 React effect/purity 与路由生成工具警告 |

新增服务行为测试包含保存失败后重试、端口占用、并发开通、证书失败期间无配对码、首次码持久标记、暂停/旧 provider 回调失效、迁移不复制登记、HTTP/LAN 不可调用管理操作。另覆盖 HTTP logout 与延迟配置保存交错，避免旧配置覆盖新 provider，以及 ready 保存期间掉线不消费首次发码标记。

## 浏览器检查

使用真实 Chromium 和 Playwright CLI，在本机预览生产 Web 构建：

- 390×844 首页：只显示连接步骤与次级局域网链接，无地址/配对码输入；无横向溢出。
- 首页进入局域网页，旧二维码在已打开 SPA 中正确跳转并预填；仍要求明文确认。
- 非法公网 HTTPS 地址提交被阻止；非法旧二维码回首页。
- 英文/深色切换与 Tab → Enter 打开局域网页正常；Web 浏览器控制台无错误。

桌面 UI 使用真实组件和 CSS、模拟本机 IPC 的临时 fixture 检查（不连接中继、不执行 Codex），与真实 Electron / VPS 验收分开记录：

- 390×844 下，旧服务先点“准备迁移”、输入测试占位邀请码，再确认开通；只产生一次发往新 API 地址的 `remote-enable` 本机请求。
- 模拟 ready 后显示配对二维码/码；模拟 offline 隐藏二维码/码并显示连接中断，不自动切换 LAN。
- LAN 设置收起时仍有运行摘要，点击管理展开并将键盘焦点放到摘要标题；内容宽度为 390，无横向溢出。
- 原生“连接其他电脑”保留独立区域。临时 fixture 启动时的 React refresh preamble 缺失已修复，仅为测试入口问题。
- ready 且高级配置未改变时隐藏首次邀请码，开通按钮显示禁用的“远程访问已开启”；复验通过。

历史截图留在本机，公开记录保留文字结果。

## 部署阶段待验收

生产 API DNS 与证书、VPS 中继、真实 iPhone Safari / Android Chrome、跨网络切换和完整 Electron 设备间配对仍需部署后验证。本轮的真实浏览器检查不替代这些验收；模拟 IPC 的 ready 不代表公网就绪。
